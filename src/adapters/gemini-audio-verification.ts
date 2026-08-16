import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import type {
  AdapterExecutionResult,
  AudioChunkRecord,
  AudioVerification,
  AudioVerificationCapabilities,
  CallRecord,
  ErrorRecord,
  VerificationFinding
} from '../contracts/index.js';
import { validateContract } from '../contracts/index.js';
import type { AudioVerificationInput, PluginModelSnapshotEntry } from '../model-center/types.js';
import type { InlineAudioPart, InlineAudioParts } from './mp3-inline-chunks.js';

export const GEMINI_INLINE_REQUEST_LIMIT_BYTES = 15_000_000;
export const GEMINI_LOCAL_CHUNK_TARGET_BYTES = 5_000_000;
const INCOMPLETE_SUGGESTION_RATIONALE = '模型建议不完整';

function findingsSchema(durationMs: number) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'kind', 'start_ms', 'end_ms', 'current_text', 'suggested_text',
            'rationale', 'confidence'
          ],
          properties: {
            kind: {
              type: 'string',
              enum: ['text_correction', 'segmentation', 'timing', 'translation', 'uncertain']
            },
            start_ms: { type: 'integer', minimum: 0, maximum: Math.max(0, durationMs - 1) },
            end_ms: { type: 'integer', minimum: 1, maximum: durationMs },
            current_text: { type: 'string', minLength: 1 },
            suggested_text: {
              anyOf: [
                { type: 'string', minLength: 1 },
                { type: 'null' }
              ]
            },
            rationale: { type: 'string', minLength: 1 },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
          },
          anyOf: [
            {
              properties: {
                kind: { type: 'string', enum: ['uncertain'] },
                suggested_text: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] }
              }
            },
            {
              properties: {
                kind: { type: 'string', enum: ['text_correction', 'segmentation', 'timing', 'translation'] },
                suggested_text: { type: 'string', minLength: 1 }
              }
            }
          ]
        }
      }
    }
  } as const;
}

interface InteractionResponse {
  id: string;
  status?: string;
  model?: string;
  output_text?: string;
}

interface GenerateContentResponseLike {
  text?: string;
  modelVersion?: string;
  responseId?: string;
}

export interface GeminiClientLike {
  interactions: {
    create(request: Record<string, unknown>): Promise<InteractionResponse>;
  };
  files: {
    upload(request: { file: string; config: { mimeType: string; displayName: string } }): Promise<{
      name?: string;
      uri?: string;
      mimeType?: string;
    }>;
    delete(request: { name: string }): Promise<unknown>;
  };
  models: {
    generateContent(request: Record<string, unknown>): Promise<GenerateContentResponseLike>;
  };
}

/** Retained only so older dependency injectors still type-check; V0.1 never calls it. */
export interface GcsStagingStore {
  upload(input: { bucket: string; objectName: string; sourcePath: string; mimeType: string }): Promise<{ objectUri: string }>;
  delete(objectUri: string): Promise<void>;
}

export interface GeminiChunkEvidence {
  sourceBytes: number;
  parts: Array<{ bytes: number; startMs: number; endMs: number }>;
}

export interface GeminiAdapterDependencies {
  readCredential?: (reference: string) => Promise<string>;
  createDeveloperClient?: (apiKey: string) => GeminiClientLike;
  createVertexClient?: (input: {
    project: string;
    location: string;
    credentials?: Record<string, unknown>;
  }) => GeminiClientLike;
  /** Compatibility-only injection point; active D009 execution never stages remotely. */
  createGcsStore?: (input: { project: string; credentials?: Record<string, unknown> }) => GcsStagingStore;
  now?: () => Date;
  createId?: () => string;
  captureActualModel?: (model: string) => void;
  captureChunkEvidence?: (evidence: GeminiChunkEvidence) => void;
}

interface WindowEvidence {
  part: InlineAudioPart;
  asrRefs: string[];
  referenceRefs: string[];
  candidateText: string;
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function providerConfig(model: PluginModelSnapshotEntry): Record<string, unknown> {
  return model.provider_config;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().normalize('NFC') : undefined;
}

function credentialObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Vertex credential reference did not resolve to a service-account object.');
  }
  return parsed as Record<string, unknown>;
}

function audioCapabilities(model: PluginModelSnapshotEntry): AudioVerificationCapabilities {
  const capabilities = model.check_snapshot.capabilities;
  if (!capabilities || capabilities.role !== 'audio_verification') {
    throw new Error('The frozen model check does not contain audio-verification capabilities.');
  }
  return capabilities;
}

function verificationInput(input: AudioVerificationInput) {
  return {
    audio_ref: input.audio.pathRef,
    audio_sha256: input.audio.sha256,
    transcript_ref: 'work/transcript.raw.json' as const,
    calibration_ref: 'work/calibration-result.json' as const,
    reference_srt_ref: input.referenceSrt?.pathRef ?? null
  };
}

function baseArtifact(input: AudioVerificationInput, createdAt: string): Omit<AudioVerification, 'status'> {
  return {
    schema_version: '1.0.0',
    task_id: input.taskId,
    created_at: createdAt,
    model_snapshot_ref: input.modelSnapshotRef,
    input: verificationInput(input),
    calls: [],
    staging: [],
    local_chunking: null,
    findings: [],
    application_results: [],
    skip_reason: null,
    warnings: [],
    errors: []
  } as Omit<AudioVerification, 'status'>;
}

function validatedArtifact(value: unknown): AudioVerification {
  const validation = validateContract('audio-verification', value);
  if (!validation.valid) {
    const summary = validation.issues.map((entry) => `${entry.path} ${entry.message}`).join('; ');
    throw new Error(`Gemini audio-verification artifact is invalid: ${summary}`);
  }
  return validation.value;
}

function skippedArtifact(input: AudioVerificationInput, createdAt: string): AudioVerification {
  return validatedArtifact({
    ...baseArtifact(input, createdAt),
    status: 'skipped',
    skip_reason: 'input_limit_exceeded'
  });
}

function diagnostic(
  id: string,
  code: string,
  message: string,
  stage: ErrorRecord['stage'],
  retryable: boolean
): ErrorRecord {
  return { error_id: id, code, message, stage, retryable };
}

function callRecord(
  input: AudioVerificationInput,
  id: string,
  startedAt: string,
  endedAt: string,
  providerRequestId: string | undefined,
  errorRef: string | null
): CallRecord {
  return {
    call_id: id,
    model_snapshot_entry_ref: input.model.snapshot_entry_id,
    started_at: startedAt,
    ended_at: endedAt,
    ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
    outcome: errorRef === null ? 'completed' : 'failed',
    error_ref: errorRef
  } as CallRecord;
}

function overlaps(startMs: number, endMs: number, part: InlineAudioPart): boolean {
  return startMs < part.endMs && endMs > part.startMs;
}

function localRange(startMs: number, endMs: number, part: InlineAudioPart) {
  return {
    start_ms: Math.max(0, startMs - part.startMs),
    end_ms: Math.min(part.endMs, endMs) - part.startMs
  };
}

function windowEvidence(input: AudioVerificationInput, part: InlineAudioPart): WindowEvidence {
  const asrSegments = input.transcript.segments.filter((segment) => overlaps(segment.start_ms, segment.end_ms, part));
  const subtitleSegments = input.calibratedTranscript.segments.filter((segment) => overlaps(segment.start_ms, segment.end_ms, part));
  return {
    part,
    asrRefs: [...new Set(asrSegments.map((segment) => segment.segment_id))],
    referenceRefs: [...new Set(subtitleSegments.flatMap((segment) => segment.reference_segment_refs))],
    candidateText: [
      subtitleSegments.map((segment) => segment.text).join(''),
      asrSegments.map((segment) => segment.text).join('')
    ].join('\n')
  };
}

function providerPrompt(input: AudioVerificationInput, evidence: WindowEvidence): string {
  const part = evidence.part;
  const asrSegments = input.transcript.segments
    .filter((segment) => evidence.asrRefs.includes(segment.segment_id))
    .map((segment) => ({
      segment_id: segment.segment_id,
      ...localRange(segment.start_ms, segment.end_ms, part),
      text: segment.text
    }));
  const calibratedSegments = input.calibratedTranscript.segments
    .filter((segment) => overlaps(segment.start_ms, segment.end_ms, part))
    .map((segment) => ({
      asr_segment_refs: segment.asr_segment_refs,
      reference_segment_refs: segment.reference_segment_refs,
      ...localRange(segment.start_ms, segment.end_ms, part),
      text: segment.text
    }));
  const calibrationSuggestions = input.calibrationResult.suggestions
    .filter((suggestion) => overlaps(suggestion.start_ms, suggestion.end_ms, part))
    .map((suggestion) => ({
      ...suggestion,
      ...localRange(suggestion.start_ms, suggestion.end_ms, part)
    }));
  return [
    '核验本音频片段与当前中文字幕候选。只报告可由该片音频时间直接支持的差异。',
    '返回的 start_ms/end_ms 必须是相对本音频片段起点的毫秒数，且落在 0 到 chunk_duration_ms 内。',
    '不得翻译、润色、扩写或输出说明性占位符。current_text 必须逐字来自当前字幕候选。',
    '没有可靠差异时只返回 {"findings":[]}。',
    JSON.stringify({
      chunk_global_start_ms: part.startMs,
      chunk_global_end_ms: part.endMs,
      chunk_duration_ms: part.endMs - part.startMs,
      mode: input.calibrationResult.request.mode,
      transcript_segments: asrSegments,
      calibration_suggestions: calibrationSuggestions,
      calibrated_segments: calibratedSegments
    })
  ].join('\n');
}

function parseStructuredJson(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

function sourceRefs(evidence: WindowEvidence, startMs: number, endMs: number, input: AudioVerificationInput): string[] {
  const asr = input.transcript.segments
    .filter((segment) => evidence.asrRefs.includes(segment.segment_id) && segment.start_ms < endMs && segment.end_ms > startMs)
    .map((segment) => segment.segment_id);
  const reference = input.calibratedTranscript.segments
    .filter((segment) => segment.start_ms < endMs && segment.end_ms > startMs)
    .flatMap((segment) => segment.reference_segment_refs)
    .filter((referenceRef) => evidence.referenceRefs.includes(referenceRef));
  return [...new Set([...asr, ...reference])];
}

function normalizeFindings(
  rawText: string,
  input: AudioVerificationInput,
  evidence: WindowEvidence,
  createId: () => string
): VerificationFinding[] {
  const parsed = parseStructuredJson(rawText);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Gemini structured response must be an object.');
  }
  const rawFindings = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(rawFindings)) throw new Error('Gemini structured response is missing findings.');
  const partDurationMs = evidence.part.endMs - evidence.part.startMs;
  return rawFindings.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Gemini finding ${index} must be an object.`);
    }
    const value = candidate as Record<string, unknown>;
    const kind = value.kind;
    const confidence = value.confidence;
    const currentText = text(value.current_text);
    const hasSuggestedText = Object.hasOwn(value, 'suggested_text');
    const rawSuggestedText = value.suggested_text;
    const suggestedText = rawSuggestedText === null ? null : text(rawSuggestedText);
    const rationale = text(value.rationale);
    const incompleteSuggestion = kind !== 'uncertain'
      && hasSuggestedText
      && (rawSuggestedText === null || (typeof rawSuggestedText === 'string' && rawSuggestedText.trim() === ''));
    if (!['text_correction', 'segmentation', 'timing', 'translation', 'uncertain'].includes(String(kind))
      || !['low', 'medium', 'high'].includes(String(confidence))
      || !Number.isSafeInteger(value.start_ms)
      || !Number.isSafeInteger(value.end_ms)
      || Number(value.start_ms) < 0
      || Number(value.end_ms) <= Number(value.start_ms)
      || Number(value.end_ms) > partDurationMs
      || !currentText
      || !evidence.candidateText.includes(currentText)
      || !rationale
      || !hasSuggestedText
      || (kind !== 'uncertain' && !suggestedText && !incompleteSuggestion)) {
      throw new Error(`Gemini finding ${index} violates the frozen structured-result boundary.`);
    }
    const startMs = evidence.part.startMs + Number(value.start_ms);
    const endMs = evidence.part.startMs + Number(value.end_ms);
    const refs = sourceRefs(evidence, startMs, endMs, input);
    if (refs.length === 0) throw new Error(`Gemini finding ${index} has no original segment evidence.`);
    return {
      finding_id: `finding-${createId()}`,
      kind: incompleteSuggestion ? 'uncertain' : (kind as VerificationFinding['kind']),
      start_ms: startMs,
      end_ms: endMs,
      current_text: currentText,
      suggested_text: suggestedText ?? null,
      rationale: incompleteSuggestion ? `${INCOMPLETE_SUGGESTION_RATIONALE}；${rationale}` : rationale,
      confidence: confidence as VerificationFinding['confidence'],
      source_segment_refs: refs as [string, ...string[]]
    } as VerificationFinding;
  });
}

function mergeFindings(findings: VerificationFinding[]): VerificationFinding[] {
  const merged = new Map<string, VerificationFinding>();
  const choices = new Map<string, string | null>();
  const confidenceRank = { low: 0, medium: 1, high: 2 } as const;
  for (const finding of findings) {
    const identity = JSON.stringify([finding.kind, finding.start_ms, finding.end_ms, finding.current_text]);
    const priorChoice = choices.get(identity);
    if (priorChoice !== undefined && priorChoice !== finding.suggested_text) {
      throw new Error('Overlapping chunks returned conflicting findings.');
    }
    choices.set(identity, finding.suggested_text);
    const key = JSON.stringify([finding.kind, finding.start_ms, finding.end_ms, finding.current_text, finding.suggested_text]);
    const prior = merged.get(key);
    if (prior) {
      prior.source_segment_refs = [...new Set([
        ...(prior.source_segment_refs ?? []), ...(finding.source_segment_refs ?? [])
      ])].sort() as [string, ...string[]];
      const findingPreferred = confidenceRank[finding.confidence] > confidenceRank[prior.confidence] ||
        (finding.confidence === prior.confidence && finding.rationale.localeCompare(prior.rationale) < 0);
      if (findingPreferred) {
        prior.confidence = finding.confidence;
        prior.rationale = finding.rationale;
      }
    } else {
      merged.set(key, finding);
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.start_ms - right.start_ms || left.end_ms - right.end_ms || left.finding_id.localeCompare(right.finding_id)
  );
}

function defaultDeveloperClient(apiKey: string): GeminiClientLike {
  return new GoogleGenAI({ apiKey }) as unknown as GeminiClientLike;
}

function defaultVertexClient(input: {
  project: string;
  location: string;
  credentials?: Record<string, unknown>;
}): GeminiClientLike {
  return new GoogleGenAI({
    vertexai: true,
    project: input.project,
    location: input.location,
    apiVersion: 'v1',
    ...(input.credentials ? { googleAuthOptions: { credentials: input.credentials } } : {})
  }) as unknown as GeminiClientLike;
}

async function vertexCredentials(
  model: PluginModelSnapshotEntry,
  readCredential: ((reference: string) => Promise<string>) | undefined
): Promise<Record<string, unknown> | undefined> {
  const reference = model.credential_ref;
  if (!reference || reference.startsWith('adc:')) return undefined;
  if (!readCredential) throw new Error('Vertex credential resolver is unavailable.');
  return credentialObject(await readCredential(reference));
}

export class GeminiAudioVerificationAdapter {
  readonly adapterId = 'gemini' as const;

  constructor(private readonly dependencies: GeminiAdapterDependencies = {}) {}

  async run(input: AudioVerificationInput): Promise<AdapterExecutionResult<AudioVerification>> {
    const now = this.dependencies.now ?? (() => new Date());
    const createId = this.dependencies.createId ?? randomUUID;
    audioCapabilities(input.model);

    let prepared: InlineAudioParts;
    try {
      // V0.1 keeps the legacy splitter as compatibility code but never enters it from active execution.
      const source = await stat(input.audio.sourcePath);
      if (!source.isFile() || source.size > GEMINI_INLINE_REQUEST_LIMIT_BYTES) {
        return { kind: 'artifact', artifact: skippedArtifact(input, timestamp(now)) };
      }
      prepared = {
        sourceBytes: source.size,
        parts: [{
          sourcePath: input.audio.sourcePath,
          bytes: source.size,
          startMs: 0,
          endMs: input.audio.durationMs
        }],
        cleanup: async () => undefined
      };
    } catch {
      return { kind: 'artifact', artifact: skippedArtifact(input, timestamp(now)) };
    }
    this.dependencies.captureChunkEvidence?.({
      sourceBytes: prepared.sourceBytes,
      parts: prepared.parts.map((part) => ({ bytes: part.bytes, startMs: part.startMs, endMs: part.endMs }))
    });
    const chunks: AudioChunkRecord[] = prepared.parts.map((part) => ({
      chunk_id: `chunk-${createId()}`,
      bytes: part.bytes,
      start_ms: part.startMs,
      end_ms: part.endMs,
      call_ref: null,
      outcome: 'not_called',
      error_ref: null
    }));
    const localChunking = {
      threshold_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES as 15000000,
      source_bytes: prepared.sourceBytes,
      parts: chunks as [AudioChunkRecord, ...AudioChunkRecord[]]
    };
    const evidenceByPart = prepared.parts.map((part) => windowEvidence(input, part));
    if (evidenceByPart.some((evidence) => evidence.asrRefs.length === 0 || evidence.candidateText.length === 0)) {
      await prepared.cleanup();
      return { kind: 'artifact', artifact: skippedArtifact(input, timestamp(now)) };
    }

    let client: GeminiClientLike;
    try {
      if (input.model.connection_type === 'developer_api') {
        if (!input.model.credential_ref || !this.dependencies.readCredential) {
          throw new Error('Gemini Developer API credential resolver is unavailable.');
        }
        client = (this.dependencies.createDeveloperClient ?? defaultDeveloperClient)(
          await this.dependencies.readCredential(input.model.credential_ref)
        );
      } else if (input.model.connection_type === 'vertex_ai') {
        const config = providerConfig(input.model);
        const project = text(config.project);
        const location = text(config.location);
        if (!project || !location) throw new Error('Vertex project or location is missing.');
        const credentials = await vertexCredentials(input.model, this.dependencies.readCredential);
        client = (this.dependencies.createVertexClient ?? defaultVertexClient)({
          project, location, ...(credentials ? { credentials } : {})
        });
      } else {
        throw new Error(`Unsupported Gemini connection type: ${input.model.connection_type}`);
      }
    } catch {
      await prepared.cleanup();
      const failure = diagnostic(
        `error-${createId()}`,
        'GEMINI_CONNECTION_FAILED',
        'Gemini connection could not be initialized from the configured credential reference.',
        'connectivity',
        false
      );
      const startedAt = timestamp(now);
      const connectionCall = callRecord(
        input,
        `call-${createId()}`,
        startedAt,
        timestamp(now),
        undefined,
        failure.error_id
      );
      const firstChunk = chunks[0]!;
      firstChunk.call_ref = connectionCall.call_id;
      firstChunk.outcome = 'failed';
      firstChunk.error_ref = failure.error_id;
      return {
        kind: 'artifact',
        artifact: validatedArtifact({
          ...baseArtifact(input, timestamp(now)),
          status: 'failed',
          calls: [connectionCall],
          local_chunking: localChunking,
          errors: [failure]
        })
      };
    }

    const calls: CallRecord[] = [];
    const rawFindings: VerificationFinding[] = [];
    const errors: ErrorRecord[] = [];
    try {
      for (const [partIndex, evidence] of evidenceByPart.entries()) {
        const part = evidence.part;
        const chunk = chunks[partIndex]!;
        const responseSchema = findingsSchema(part.endMs - part.startMs);
        const audioData = (await readFile(part.sourcePath)).toString('base64');
        const prompt = providerPrompt(input, evidence);
        const callId = `call-${createId()}`;
        const startedAt = timestamp(now);
        let providerRequestId: string | undefined;
        try {
          let body: string | undefined;
          if (input.model.connection_type === 'developer_api') {
            const response = await client.interactions.create({
              model: input.model.model,
              store: false,
              input: [
                { type: 'text', text: prompt },
                { type: 'audio', data: audioData, mime_type: input.audio.mimeType }
              ],
              response_format: {
                type: 'text',
                mime_type: 'application/json',
                schema: responseSchema
              }
            });
            providerRequestId = text(response.id);
            this.dependencies.captureActualModel?.(text(response.model) ?? input.model.model);
            body = response.output_text;
          } else {
            const response = await client.models.generateContent({
              model: input.model.model,
              contents: [{
                role: 'user',
                parts: [
                  { text: prompt },
                  { inlineData: { data: audioData, mimeType: input.audio.mimeType } }
                ]
              }],
              config: {
                responseMimeType: 'application/json',
                responseJsonSchema: responseSchema
              }
            });
            providerRequestId = text(response.responseId);
            this.dependencies.captureActualModel?.(text(response.modelVersion) ?? input.model.model);
            body = response.text;
          }
          if (!body) throw new Error('Gemini returned no structured response body.');
          rawFindings.push(...normalizeFindings(body, input, evidence, createId));
          const call = callRecord(input, callId, startedAt, timestamp(now), providerRequestId, null);
          calls.push(call);
          chunk.call_ref = call.call_id;
          chunk.outcome = 'completed';
        } catch (error) {
          const responseInvalid = providerRequestId !== undefined;
          const failure = diagnostic(
            `error-${createId()}`,
            responseInvalid ? 'GEMINI_RESPONSE_INVALID' : 'GEMINI_MODEL_CALL_FAILED',
            responseInvalid
              ? 'Gemini returned an invalid structured verification result.'
              : 'Gemini model request failed.',
            responseInvalid ? 'response_validation' : 'model_call',
            true
          );
          errors.push(failure);
          const call = callRecord(input, callId, startedAt, timestamp(now), providerRequestId, failure.error_id);
          calls.push(call);
          chunk.call_ref = call.call_id;
          chunk.outcome = 'failed';
          chunk.error_ref = failure.error_id;
          break;
        }
      }
    } finally {
      await prepared.cleanup();
    }

    let findings: VerificationFinding[] = [];
    if (errors.length === 0) {
      try {
        findings = mergeFindings(rawFindings);
      } catch {
        const failure = diagnostic(
          `error-${createId()}`,
          'GEMINI_CHUNK_MERGE_FAILED',
          'Gemini chunk results could not be merged without ambiguity.',
          'response_validation',
          false
        );
        errors.push(failure);
        const last = calls.at(-1);
        if (last) {
          last.outcome = 'failed';
          last.error_ref = failure.error_id;
          const chunk = chunks.find((candidate) => candidate.call_ref === last.call_id);
          if (chunk) {
            chunk.outcome = 'failed';
            chunk.error_ref = failure.error_id;
          }
        }
      }
    }

    const status = errors.length === 0 ? 'completed' : 'failed';
    const applications = findings.map((finding) => ({
      application_id: `application-${createId()}`,
      finding_ref: finding.finding_id,
      disposition: 'not_applied' as const,
      reason: finding.kind === 'translation' ? 'translation_out_of_scope' as const : 'insufficient_evidence' as const,
      modification_ref: null
    }));
    return {
      kind: 'artifact',
      artifact: validatedArtifact({
        ...baseArtifact(input, timestamp(now)),
        status,
        calls,
        staging: [],
        local_chunking: localChunking,
        findings: status === 'completed' ? findings : [],
        application_results: status === 'completed' ? applications : [],
        errors
      })
    };
  }
}
