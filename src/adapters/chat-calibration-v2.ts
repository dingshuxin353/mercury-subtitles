import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import type {
  AdapterExecutionResult,
  AdapterFailureRecord,
  CalibrationResultV3,
  CorrectedUnitV3,
  ErrorRecord,
  ModelSnapshotEntryV2,
  TranscriptRaw,
} from '../contracts/index.js';
import { validateV3CalibrationResult } from '../contracts/index.js';
import type { ReferenceSrtInput } from '../contracts/adapters/types.js';
import {
  mappedAsrRefs,
  parseReferenceSrt,
  type AlignmentArtifact,
} from '../subtitle-core/index.js';

export const CHAT_INLINE_AUDIO_LIMIT_BYTES = 15_000_000;
export const CALIBRATION_PROMPT_VERSION =
  'mercury-alpha3-full-calibration-v2' as const;
export const CALIBRATION_RESPONSE_CONTRACT_VERSION =
  'corrected-units-v1' as const;

export type NonStrongReason =
  | 'audio_not_supported'
  | 'audio_check_missing_or_stale'
  | 'audio_data_confirmation_missing'
  | 'audio_inline_unsupported'
  | 'audio_input_limit_exceeded';

export interface ChatCalibrationV2Input {
  taskId: string;
  modelSnapshotRef: string;
  model: ModelSnapshotEntryV2;
  transcript: TranscriptRaw;
  alignment: AlignmentArtifact;
  referenceSrt: ReferenceSrtInput | null;
  mode: 'text-only' | 'text-and-segmentation' | null;
  evidenceMode: 'text' | 'audio_multimodal';
  nonStrongReason: NonStrongReason | null;
  audio: null | {
    sourcePath: string;
    pathRef: string;
    sha256: string;
    bytes: number;
    durationMs: number;
    mimeType: 'audio/mpeg';
  };
  beforeProviderDispatch?: (
    operation:
      | 'volcengine_asr_recognize'
      | 'volcengine_subtitle_submit'
      | 'volcengine_subtitle_query'
      | 'openai_chat_calibration'
      | 'gemini_chat_calibration',
  ) => Promise<void>;
}

export interface ChatCalibrationRuntimeV2 {
  readonly capability: 'calibration';
  run(
    input: ChatCalibrationV2Input,
  ): Promise<AdapterExecutionResult<CalibrationResultV3>>;
}

type FetchLike = typeof globalThis.fetch;
interface GeminiResponse {
  id?: string;
  output_text?: string;
  text?: string;
  responseId?: string;
  finishReason?: string;
  finish_reason?: string;
  candidates?: Array<{ finishReason?: string; finish_reason?: string }>;
}
export interface GeminiChatClient {
  interactions: {
    create(request: Record<string, unknown>): Promise<GeminiResponse>;
  };
  models: {
    generateContent(request: Record<string, unknown>): Promise<GeminiResponse>;
  };
}
export interface ChatCalibrationV2Dependencies {
  fetch?: FetchLike;
  beforeProviderDispatch?: (
    operation: 'openai_chat_calibration' | 'gemini_chat_calibration',
  ) => Promise<void>;
  readCredential?: (reference: string) => Promise<string>;
  createDeveloperClient?: (apiKey: string) => GeminiChatClient;
  createVertexClient?: (input: {
    project: string;
    location: string;
    credentials?: Record<string, unknown>;
  }) => GeminiChatClient;
  captureRequest?: (
    request: Record<string, unknown>,
  ) => unknown | Promise<unknown>;
  captureProviderResponseBody?: (body: string) => Promise<void>;
  captureStreamMetrics?: (metrics: {
    event_count: number;
    first_content_ms_from_headers: number | null;
    last_content_ms_from_headers: number | null;
    end_marker_ms_from_headers: number | null;
    ended_by: 'finish_reason' | 'done_marker' | 'connection_close';
  }) => unknown | Promise<unknown>;
  now?: () => Date;
  createId?: () => string;
}

interface CalibrationUnit {
  unit_id: string;
  original_text: string;
  start_ms: number;
  end_ms: number;
  asr_segment_refs: string[];
  reference_segment_refs: string[];
}

interface ProviderCorrectedUnit {
  unit_id: string;
  corrected_text: string;
  rationale: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().normalize('NFC')
    : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requestOf(
  input: ChatCalibrationV2Input,
): CalibrationResultV3['request'] {
  return {
    transcript_ref: 'work/transcript.raw.json',
    alignment_ref: 'work/alignment.json',
    reference_srt_ref: input.referenceSrt?.pathRef ?? null,
    mode: input.mode,
    evidence_mode: input.evidenceMode,
    non_strong_reason: input.nonStrongReason,
    input_modalities:
      input.evidenceMode === 'audio_multimodal' ? ['text', 'audio'] : ['text'],
    audio: input.audio
      ? {
          path_ref: input.audio.pathRef,
          mime_type: 'audio/mpeg',
          bytes: input.audio.bytes,
          sha256: input.audio.sha256,
        }
      : null,
  } as CalibrationResultV3['request'];
}

function calibrationUnits(input: ChatCalibrationV2Input): CalibrationUnit[] {
  if (input.alignment.task_id !== input.taskId) {
    throw new Error('校准单元的对齐产物与任务不匹配。');
  }
  if (input.referenceSrt === null) {
    return input.transcript.segments.map((segment) => ({
      unit_id: segment.segment_id,
      original_text: segment.text,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      asr_segment_refs: [segment.segment_id],
      reference_segment_refs: [],
    }));
  }
  const parsed = parseReferenceSrt(input.referenceSrt.text);
  if (!parsed.ok) throw new Error('参考 SRT 无法形成完整校验单元。');
  const segmentById = new Map(
    input.transcript.segments.map((segment) => [segment.segment_id, segment]),
  );
  return parsed.segments.map((segment) => {
    const relations = input.alignment.relations.filter((relation) =>
      relation.reference_segment_refs.includes(segment.reference_segment_id),
    );
    const mapped = mappedAsrRefs(input.alignment, [segment.reference_segment_id]);
    const overlapping = input.transcript.segments
      .filter(
        (candidate) =>
          candidate.end_ms > segment.start_ms &&
          candidate.start_ms < segment.end_ms,
      )
      .map((candidate) => candidate.segment_id);
    const asrRefs = unique(mapped.length > 0 ? mapped : overlapping);
    const evidence = asrRefs
      .map((id) => segmentById.get(id))
      .filter(
        (candidate): candidate is TranscriptRaw['segments'][number] =>
          candidate !== undefined,
      );
    const useReferenceTimeline = input.mode === 'text-only' || (relations.length === 0 && evidence.length === 0);
    return {
      unit_id: segment.reference_segment_id,
      original_text: segment.text,
      start_ms: useReferenceTimeline
        ? segment.start_ms
        : relations.length > 0
          ? Math.min(...relations.map((relation) => relation.start_ms))
          : Math.min(...evidence.map((candidate) => candidate.start_ms)),
      end_ms: useReferenceTimeline
        ? segment.end_ms
        : relations.length > 0
          ? Math.max(...relations.map((relation) => relation.end_ms))
          : Math.max(...evidence.map((candidate) => candidate.end_ms)),
      asr_segment_refs: asrRefs,
      reference_segment_refs: [segment.reference_segment_id],
    };
  });
}

function outputBudget(unitCount: number): number {
  return Math.min(32_768, Math.max(4_096, unitCount * 160));
}

function providerRequestCompatibility(endpoint: URL): Record<string, unknown> {
  // Ark reasoning models may enable deep thinking by default. Its documented
  // OpenAI-compatible extension can be sent only to an Ark endpoint; generic
  // compatible services must not receive provider-specific request fields.
  return /^ark\.[a-z0-9-]+\.volces\.com$/u.test(endpoint.hostname)
    ? { thinking: { type: 'disabled' } }
    : {};
}

function strategy(
  units: readonly CalibrationUnit[],
  returnedUnitCount: number,
  coverageComplete: boolean,
  finishReason: string | null,
): CalibrationResultV3['strategy'] {
  return {
    prompt_version: CALIBRATION_PROMPT_VERSION,
    response_contract_version: CALIBRATION_RESPONSE_CONTRACT_VERSION,
    output_budget_tokens: outputBudget(units.length),
    provider_finish_reason: finishReason,
    input_unit_count: units.length,
    returned_unit_count: returnedUnitCount,
    coverage_complete: coverageComplete,
  };
}

function json(raw: string): unknown {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(raw.trim());
  return JSON.parse(match?.[1] ?? raw);
}

function safeCorrectedText(value: unknown, unitId: string): string {
  const normalized = text(value);
  if (!normalized) throw new Error(`校验单元 ${unitId} 的 corrected_text 为空。`);
  if (
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized) ||
    /```|<\/?[A-Za-z][^>]*>|\{\\[^}]+\}|\\[NnHh]/u.test(normalized) ||
    /^(?:修正后|校正后|修改说明|说明|答案)\s*[：:]/u.test(normalized) ||
    ((normalized.startsWith('{') && normalized.endsWith('}')) ||
      (normalized.startsWith('[') && normalized.endsWith(']')))
  ) {
    throw new Error(`校验单元 ${unitId} 的 corrected_text 包含非法结构或控制字符。`);
  }
  return normalized;
}

function responseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['corrected_units'],
    properties: {
      corrected_units: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['unit_id', 'corrected_text', 'rationale'],
          properties: {
            unit_id: { type: 'string', minLength: 1 },
            corrected_text: { type: 'string', minLength: 1 },
            rationale: {
              anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
            },
          },
        },
      },
    },
  };
}

function prompt(input: ChatCalibrationV2Input, units: CalibrationUnit[]): string {
  return [
    `Mercury 校验策略版本：${CALIBRATION_PROMPT_VERSION}。`,
    '你是中文完整字幕校对模型。必须只返回符合 corrected-units-v1 的 JSON。',
    '证据只来自本请求中的音频、完整转录、参考字幕和它们的时间顺序；不得用训练知识、现实世界常识或熟悉的产品版本替换请求内文字。',
    '先在内部静默通读全部单元，把反复出现的产品名、品牌名、人名、专业术语、英文缩写、数字和单位归为全文术语簇；不要输出归纳过程。',
    input.evidenceMode === 'audio_multimodal'
      ? '本请求同时包含完整 MP3；以音频实际说话内容为最高文字判断依据。'
      : '本请求不含音频；结合完整转录、参考字幕、时间顺序和全文上下文校对。',
    '按输入顺序逐个审查每个校验单元，重点检查同音/近音词、ASR 音译、专名、英文大小写、数字、漏字、多字和跨片段上下文；同一术语的多种 ASR 音近写法必须依据全文内部证据统一。',
    '数字和版本号只有在音频声学证据或全文重复证据充分时才可修改；证据不足时保留请求内原写法，禁止因常识改成另一个更熟悉的版本。',
    '每个输入 unit_id 必须恰好返回一次，顺序、数量和 ID 必须完全一致；未修改单元也必须原样返回 corrected_text。',
    '返回前复检是否遗漏、重复或新增任何 ID，并确认 corrected_text 仍对应该单元原时间范围内的说话内容。',
    '返回前再做一次全文术语一致性和无依据改写复检：同一术语应全局一致，任何无法由请求内部证据支持的产品名、版本号或数字改写都必须撤销。',
    '只校对字幕文字；不得翻译、总结、扩写背景知识、创作或写入“听不清”等说明性占位符。',
    '模型不得返回或修改时间戳。rationale 无修改时可为 null，有修改时用一句简短中文说明。',
    JSON.stringify({
      mode: input.mode,
      evidence_mode: input.evidenceMode,
      calibration_units: units,
      transcript_context: input.transcript.segments.map((segment) => ({
        segment_id: segment.segment_id,
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        text: segment.text,
      })),
    }),
  ].join('\n');
}

function parseProviderUnits(raw: string): ProviderCorrectedUnit[] {
  const parsed = json(raw);
  if (
    !record(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Array.isArray(parsed.corrected_units)
  ) {
    throw new Error('结构化响应必须且只能包含 corrected_units 数组。');
  }
  return parsed.corrected_units.map((candidate, index) => {
    if (
      !record(candidate) ||
      Object.keys(candidate).some(
        (key) => !['unit_id', 'corrected_text', 'rationale'].includes(key),
      ) ||
      !Object.hasOwn(candidate, 'unit_id') ||
      !Object.hasOwn(candidate, 'corrected_text') ||
      !Object.hasOwn(candidate, 'rationale')
    ) {
      throw new Error(`返回的第 ${index + 1} 个校验单元结构不合法。`);
    }
    const id = text(candidate.unit_id);
    if (!id) throw new Error(`返回的第 ${index + 1} 个校验单元缺少 ID。`);
    const rationale = candidate.rationale === null ? null : text(candidate.rationale);
    if (candidate.rationale !== null && rationale === null) {
      throw new Error(`校验单元 ${id} 的 rationale 不合法。`);
    }
    return {
      unit_id: id,
      corrected_text: safeCorrectedText(candidate.corrected_text, id),
      rationale,
    };
  });
}

function completeUnits(
  input: ChatCalibrationV2Input,
  inputUnits: CalibrationUnit[],
  returned: ProviderCorrectedUnit[],
): { corrected: CorrectedUnitV3[]; suggestions: CalibrationResultV3['suggestions'] } {
  const expectedIds = inputUnits.map((unit) => unit.unit_id);
  const returnedIds = returned.map((unit) => unit.unit_id);
  if (returned.length !== inputUnits.length) {
    throw new Error(`完整覆盖失败：输入 ${inputUnits.length} 个单元，返回 ${returned.length} 个。`);
  }
  if (new Set(returnedIds).size !== returnedIds.length) {
    throw new Error('完整覆盖失败：响应包含重复的校验单元 ID。');
  }
  for (const [index, expected] of expectedIds.entries()) {
    if (returnedIds[index] !== expected) {
      const actual = returnedIds[index];
      const kind = actual && expectedIds.includes(actual) ? '顺序不一致' : '包含未知或缺失 ID';
      throw new Error(`完整覆盖失败：第 ${index + 1} 个单元${kind}。`);
    }
  }
  const corrected = inputUnits.map((unit, index): CorrectedUnitV3 => {
    const result = returned[index]!;
    return {
      ...unit,
      corrected_text: result.corrected_text,
      rationale: result.rationale,
      changed: unit.original_text !== result.corrected_text,
    };
  });
  const segmentById = new Map(
    input.transcript.segments.map((segment) => [segment.segment_id, segment]),
  );
  const suggestions = corrected
    .filter((unit) => unit.changed)
    .map((unit, index) => {
      const evidence = unit.asr_segment_refs
        .map((id) => segmentById.get(id))
        .filter(
          (candidate): candidate is TranscriptRaw['segments'][number] =>
            candidate !== undefined,
        );
      if (evidence.length !== unit.asr_segment_refs.length || evidence.length === 0) {
        throw new Error(`校验单元 ${unit.unit_id} 发生文字变化，但缺少合法 ASR 时间来源。`);
      }
      const evidenceStart = Math.min(...evidence.map((segment) => segment.start_ms));
      const evidenceEnd = Math.max(...evidence.map((segment) => segment.end_ms));
      if (unit.start_ms < evidenceStart || unit.end_ms > evidenceEnd) {
        throw new Error(`校验单元 ${unit.unit_id} 的对齐时间超出 ASR 来源范围。`);
      }
      return {
        suggestion_id: `suggestion-${String(index + 1).padStart(4, '0')}`,
        kind: 'text_correction' as const,
        source_segment_refs: unit.asr_segment_refs as [string, ...string[]],
        start_ms: unit.start_ms,
        end_ms: unit.end_ms,
        original_text: unit.original_text,
        suggested_text: unit.corrected_text,
        rationale:
          unit.rationale ?? '模型返回完整校验正文；文字差异由 Mercury 本地生成。',
        confidence: 'high' as const,
        disposition: 'not_applied' as const,
        disposition_reason: 'insufficient_evidence' as const,
        modification_refs: [],
      };
    });
  return { corrected, suggestions };
}

function truncatedFinishReason(value: string | null): boolean {
  return value !== null && !['STOP', 'stop', 'completed', 'COMPLETE'].includes(value);
}

function finishReasonFromGemini(response: GeminiResponse): string | null {
  return text(
    response.finishReason ??
      response.finish_reason ??
      response.candidates?.[0]?.finishReason ??
      response.candidates?.[0]?.finish_reason,
  );
}

function openAiJsonResponse(
  body: string,
  headerRequestId: string | null,
): { content: string | null; finishReason: string | null; providerRequestId: string | null } {
  const envelope = JSON.parse(body) as unknown;
  const choice =
    record(envelope) && Array.isArray(envelope.choices) && record(envelope.choices[0])
      ? envelope.choices[0]
      : null;
  const message = choice && record(choice.message) ? choice.message : null;
  return {
    content: message ? text(message.content) : null,
    finishReason: choice ? text(choice.finish_reason) : null,
    providerRequestId: record(envelope)
      ? text(envelope.id) ?? headerRequestId
      : headerRequestId,
  };
}

async function openAiStreamResponse(
  response: Response,
  headerRequestId: string | null,
  dependencies: ChatCalibrationV2Dependencies,
): Promise<{ content: string | null; finishReason: string | null; providerRequestId: string | null }> {
  if (!response.body) throw new Error('流式响应缺少可读取的 body。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const receivedAt = Date.now();
  let buffer = '';
  let raw = '';
  let content = '';
  let finishReason: string | null = null;
  let providerRequestId = headerRequestId;
  let eventCount = 0;
  let firstContentAt: number | null = null;
  let lastContentAt: number | null = null;
  let endMarkerAt: number | null = null;
  let endedBy: 'finish_reason' | 'done_marker' | 'connection_close' = 'connection_close';
  let ended = false;
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      endMarkerAt = Date.now();
      endedBy = 'done_marker';
      ended = true;
      return;
    }
    const event = JSON.parse(data) as unknown;
    if (!record(event)) throw new Error('流式响应事件不是 JSON 对象。');
    eventCount += 1;
    providerRequestId = text(event.id) ?? providerRequestId;
    if (record(event.error)) {
      throw new Error(text(event.error.message) ?? '流式响应包含 Provider 错误。');
    }
    const choice = Array.isArray(event.choices) && record(event.choices[0])
      ? event.choices[0]
      : null;
    if (!choice) return;
    const delta = record(choice.delta) ? choice.delta : null;
    const message = record(choice.message) ? choice.message : null;
    const chunk =
      (typeof delta?.content === 'string' ? delta.content : null) ??
      (typeof message?.content === 'string' ? message.content : null) ??
      '';
    if (chunk) {
      const now = Date.now();
      firstContentAt ??= now;
      lastContentAt = now;
      content += chunk;
    }
    const reason = text(choice.finish_reason);
    if (reason) {
      finishReason = reason;
      endMarkerAt = Date.now();
      endedBy = 'finish_reason';
      ended = true;
    }
  };
  try {
    while (!ended) {
      const part = await reader.read();
      if (part.done) break;
      const decoded = decoder.decode(part.value, { stream: true });
      raw += decoded;
      buffer += decoded.replaceAll('\r\n', '\n');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        consume(line);
        if (ended) break;
      }
    }
    if (!ended) {
      buffer += decoder.decode();
      if (buffer) consume(buffer);
    }
  } finally {
    if (ended) await reader.cancel().catch(() => undefined);
  }
  if (eventCount === 0) throw new Error('流式响应没有可解析的数据事件。');
  if (!ended) finishReason = 'stream_incomplete';
  await dependencies.captureProviderResponseBody?.(raw);
  await dependencies.captureStreamMetrics?.({
    event_count: eventCount,
    first_content_ms_from_headers:
      firstContentAt === null ? null : firstContentAt - receivedAt,
    last_content_ms_from_headers:
      lastContentAt === null ? null : lastContentAt - receivedAt,
    end_marker_ms_from_headers:
      endMarkerAt === null ? null : endMarkerAt - receivedAt,
    ended_by: endedBy,
  });
  return { content: text(content), finishReason, providerRequestId };
}

function providerFailure(cause: unknown): {
  code: string;
  message: string;
  certainty: 'known_terminal' | 'outcome_unknown';
  retryable: boolean;
} {
  const value = record(cause) ? cause : {};
  const status = text(value.status) ?? text(value.code)
    ?? (typeof value.status === 'number' ? String(value.status) : null)
    ?? (typeof value.code === 'number' ? String(value.code) : null);
  const primary =
    cause instanceof Error
      ? cause.message
      : text(value.message) ?? 'Provider 未返回可识别的错误详情';
  const nested =
    cause instanceof Error && cause.cause instanceof Error
      ? cause.cause.message
      : record(value.cause)
        ? text(value.cause.message) ?? text(value.cause.code)
        : null;
  const raw = nested ? `${primary}; cause=${nested}` : primary;
  const detail = raw
    .replaceAll(/[A-Za-z0-9_+/=-]{32,}/gu, '[redacted]')
    .replaceAll(/\s+/gu, ' ')
    .slice(0, 360);
  const searchable = `${status ?? ''} ${detail}`.toUpperCase();
  if (/401|UNAUTHENTICATED|COULD NOT LOAD THE DEFAULT CREDENTIALS/u.test(searchable)) {
    return {
      code: 'GEMINI_VERTEX_UNAUTHENTICATED',
      message: `Vertex AI 身份验证失败。请重新登录 ADC 后再检查模型。Provider detail=${detail}`,
      certainty: 'known_terminal',
      retryable: false,
    };
  }
  if (/403|PERMISSION_DENIED/u.test(searchable)) {
    return {
      code: 'GEMINI_VERTEX_PERMISSION_DENIED',
      message: `当前 ADC 身份没有调用该 Vertex AI Gemini 模型的权限。请检查项目权限和 Vertex AI API。Provider detail=${detail}`,
      certainty: 'known_terminal',
      retryable: false,
    };
  }
  if (/404|NOT_FOUND/u.test(searchable)) {
    return {
      code: 'GEMINI_VERTEX_MODEL_NOT_FOUND',
      message: `Vertex AI 在当前项目或区域找不到该 Gemini 模型。请检查模型名称与区域。Provider detail=${detail}`,
      certainty: 'known_terminal',
      retryable: false,
    };
  }
  if (/429|RESOURCE_EXHAUSTED/u.test(searchable)) {
    return {
      code: 'GEMINI_VERTEX_QUOTA_EXHAUSTED',
      message: `Vertex AI 当前配额不足或请求受限。请检查项目配额后再试。Provider detail=${detail}`,
      certainty: 'known_terminal',
      retryable: true,
    };
  }
  if (/400|INVALID_ARGUMENT/u.test(searchable)) {
    return {
      code: 'GEMINI_VERTEX_REQUEST_INVALID',
      message: `Vertex AI 拒绝了本次音频与转写联合请求。请检查模型是否支持音频与结构化输出。Provider detail=${detail}`,
      certainty: 'known_terminal',
      retryable: false,
    };
  }
  return {
    code: 'GEMINI_MODEL_CALL_FAILED',
    message: `Gemini 单次校准请求失败。Provider detail=${detail}`,
    certainty: 'outcome_unknown',
    retryable: false,
  };
}

abstract class CompleteCalibrationRuntimeBase {
  readonly capability = 'calibration' as const;
  constructor(
    protected readonly dependencies: ChatCalibrationV2Dependencies = {},
  ) {}

  protected now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }

  protected id(): string {
    return (this.dependencies.createId ?? randomUUID)();
  }

  protected beforeCallFailure(
    input: ChatCalibrationV2Input,
    code: string,
    message: string,
    stage: ErrorRecord['stage'],
  ): AdapterExecutionResult<CalibrationResultV3> {
    const error: ErrorRecord = {
      error_id: `error-${this.id()}`,
      code,
      message,
      stage,
      retryable: false,
    };
    const failure: AdapterFailureRecord = {
      failure_id: `failure-${this.id()}`,
      task_id: input.taskId,
      role: 'calibration',
      model_snapshot_ref: input.modelSnapshotRef,
      occurred_at: this.now().toISOString(),
      provider_outcome_certainty: 'not_dispatched',
      errors: [error],
      warnings: [],
      call: null,
      staging: [],
    };
    return { kind: 'failure', failure };
  }

  protected failedArtifact(
    input: ChatCalibrationV2Input,
    units: CalibrationUnit[],
    callId: string,
    startedAt: string,
    code: string,
    message: string,
    stage: ErrorRecord['stage'],
    returnedUnitCount = 0,
    finishReason: string | null = null,
    providerRequestId: string | null = null,
    providerOutcomeCertainty: 'known_terminal' | 'outcome_unknown' = 'known_terminal',
    retryableOverride?: boolean,
  ): AdapterExecutionResult<CalibrationResultV3> {
    const endedAt = this.now().toISOString();
    const error: ErrorRecord = {
      error_id: `error-${this.id()}`,
      code,
      message,
      stage,
      retryable: providerOutcomeCertainty === 'outcome_unknown'
        ? false
        : retryableOverride ?? stage === 'model_call',
    };
    const candidate = {
      schema_version: '3.0.0',
      task_id: input.taskId,
      created_at: endedAt,
      status: 'failed',
      request: requestOf(input),
      model_snapshot_ref: input.modelSnapshotRef,
      provider_outcome_certainty: providerOutcomeCertainty,
      call: {
        call_id: callId,
        model_snapshot_entry_ref: input.model.snapshot_entry_id,
        started_at: startedAt,
        ended_at: endedAt,
        ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
        outcome: 'failed',
        error_ref: error.error_id,
      },
      strategy: strategy(units, returnedUnitCount, false, finishReason),
      corrected_units: [],
      suggestions: [],
      warnings: [],
      errors: [error],
    };
    const checked = validateV3CalibrationResult(candidate);
    if (!checked.valid) {
      return this.beforeCallFailure(
        input,
        'CALIBRATION_FAILURE_ARTIFACT_INVALID',
        `校准失败证据无法形成合法产物：${checked.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
        'artifact_write',
      );
    }
    return { kind: 'artifact', artifact: checked.value };
  }

  protected completedArtifact(
    input: ChatCalibrationV2Input,
    units: CalibrationUnit[],
    returned: ProviderCorrectedUnit[],
    callId: string,
    startedAt: string,
    finishReason: string | null,
    providerRequestId: string | null,
  ): AdapterExecutionResult<CalibrationResultV3> {
    const normalized = completeUnits(input, units, returned);
    const endedAt = this.now().toISOString();
    const candidate = {
      schema_version: '3.0.0',
      task_id: input.taskId,
      created_at: endedAt,
      status: 'completed',
      request: requestOf(input),
      model_snapshot_ref: input.modelSnapshotRef,
      provider_outcome_certainty: 'known_terminal',
      call: {
        call_id: callId,
        model_snapshot_entry_ref: input.model.snapshot_entry_id,
        started_at: startedAt,
        ended_at: endedAt,
        ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
        outcome: 'completed',
        error_ref: null,
      },
      strategy: strategy(units, returned.length, true, finishReason),
      corrected_units: normalized.corrected,
      suggestions: normalized.suggestions,
      warnings: [],
      errors: [],
    };
    const checked = validateV3CalibrationResult(candidate);
    if (!checked.valid) {
      return this.failedArtifact(
        input,
        units,
        callId,
        startedAt,
        'CALIBRATION_RESULT_INVALID',
        checked.issues.map((issue) => `${issue.path} ${issue.message}`).join('; '),
        'response_validation',
        returned.length,
        finishReason,
        providerRequestId,
      );
    }
    return { kind: 'artifact', artifact: checked.value };
  }
}

export class OpenAiChatCalibrationRuntimeV2
  extends CompleteCalibrationRuntimeBase
  implements ChatCalibrationRuntimeV2
{
  async run(
    input: ChatCalibrationV2Input,
  ): Promise<AdapterExecutionResult<CalibrationResultV3>> {
    if (
      input.evidenceMode !== 'text' ||
      input.audio !== null ||
      input.model.plugin_id !== 'openai_chat_completions' ||
      !input.model.endpoint
    ) {
      return this.beforeCallFailure(
        input,
        'CALIBRATION_INPUT_INVALID',
        'OpenAI 兼容校准只接受已配置端点的文本证据。',
        'input_validation',
      );
    }
    let credential: string | null = null;
    if (input.model.credential_ref) {
      if (!this.dependencies.readCredential) {
        return this.beforeCallFailure(
          input,
          'CREDENTIAL_RESOLVER_MISSING',
          '无法读取所选 Chat 的凭证。',
          'configuration',
        );
      }
      try {
        credential = await this.dependencies.readCredential(
          input.model.credential_ref,
        );
        if (!credential.trim()) throw new Error('empty credential');
      } catch {
        return this.beforeCallFailure(
          input,
          'CREDENTIAL_RESOLUTION_FAILED',
          '所选 Chat 的凭证无法读取。',
          'configuration',
        );
      }
    }
    let units: CalibrationUnit[];
    try {
      units = calibrationUnits(input);
    } catch (cause) {
      return this.beforeCallFailure(
        input,
        'CALIBRATION_UNITS_INVALID',
        cause instanceof Error ? cause.message : String(cause),
        'input_validation',
      );
    }
    const callId = `call-${this.id()}`;
    const startedAt = this.now().toISOString();
    const endpoint = new URL(input.model.endpoint);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/chat/completions`;
    endpoint.search = '';
    endpoint.hash = '';
    const body = {
      model: input.model.provider_model,
      messages: [
        {
          role: 'system',
          content:
            '你是 Mercury 的完整字幕校对模型。严格执行用户提供的校验策略并只返回 JSON。',
        },
        { role: 'user', content: prompt(input, units) },
      ],
      response_format: { type: 'json_object' },
      max_tokens: outputBudget(units.length),
      temperature: 0,
      stream: true,
      ...providerRequestCompatibility(endpoint),
    };
    await this.dependencies.captureRequest?.(body);
    try {
      await input.beforeProviderDispatch?.('openai_chat_calibration');
      await this.dependencies.beforeProviderDispatch?.('openai_chat_calibration');
    } catch {
      return this.beforeCallFailure(
        input,
        'PROVIDER_DISPATCH_CHECKPOINT_FAILED',
        '无法在发送 Chat 请求前保存 Provider 调用检查点。',
        'artifact_write',
      );
    }
    let response: Response;
    try {
      response = await (this.dependencies.fetch ?? globalThis.fetch)(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      return this.failedArtifact(
        input,
        units,
        callId,
        startedAt,
        'MODEL_CALL_FAILED',
        'OpenAI 兼容 Chat 请求未获得 HTTP 响应。',
        'model_call',
        0,
        null,
        null,
        'outcome_unknown',
      );
    }
    const headerRequestId = text(response.headers.get('x-request-id'));
    if (!response.ok) {
      return this.failedArtifact(
        input,
        units,
        callId,
        startedAt,
        'MODEL_HTTP_ERROR',
        `OpenAI 兼容 Chat 返回 HTTP ${response.status}。`,
        'model_call',
        0,
        null,
        headerRequestId,
      );
    }
    let parsedResponse: Awaited<ReturnType<typeof openAiStreamResponse>>;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/event-stream')) {
      try {
        parsedResponse = await openAiStreamResponse(
          response,
          headerRequestId,
          this.dependencies,
        );
      } catch {
        return this.failedArtifact(
          input,
          units,
          callId,
          startedAt,
          'PROVIDER_STREAM_INTERRUPTED',
          'OpenAI 兼容 Chat 流在完整结束标记前中断，结果无法确认。',
          'connectivity',
          0,
          'stream_incomplete',
          headerRequestId,
          'outcome_unknown',
        );
      }
    } else {
      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        return this.failedArtifact(
          input,
          units,
          callId,
          startedAt,
          'PROVIDER_RESPONSE_BODY_INTERRUPTED',
          'OpenAI 兼容 Chat 响应正文未完整读取，结果无法确认。',
          'connectivity',
          0,
          null,
          headerRequestId,
          'outcome_unknown',
        );
      }
      await this.dependencies.captureProviderResponseBody?.(responseBody);
      try {
        parsedResponse = openAiJsonResponse(responseBody, headerRequestId);
      } catch {
        return this.failedArtifact(
          input,
          units,
          callId,
          startedAt,
          'PROVIDER_RESPONSE_INVALID_JSON',
          'OpenAI 兼容 Chat 返回了完整但无法解析的 JSON。',
          'response_parse',
          0,
          null,
          headerRequestId,
        );
      }
    }
    const { content, finishReason, providerRequestId } = parsedResponse;
    if (truncatedFinishReason(finishReason)) {
      return this.failedArtifact(
        input,
        units,
        callId,
        startedAt,
        'CALIBRATION_RESPONSE_TRUNCATED',
        `OpenAI 兼容 Chat 未完整结束（finish_reason=${finishReason}）。`,
        'response_validation',
        0,
        finishReason,
        providerRequestId,
        finishReason === 'stream_incomplete' ? 'outcome_unknown' : 'known_terminal',
      );
    }
    if (!content) {
      return this.failedArtifact(
        input,
        units,
        callId,
        startedAt,
        'PROVIDER_RESPONSE_EMPTY_CONTENT',
        'OpenAI 兼容 Chat 未返回完整校验正文。',
        'response_validation',
        0,
        finishReason,
        providerRequestId,
      );
    }
    try {
      const returned = parseProviderUnits(content);
      return this.completedArtifact(
        input,
        units,
        returned,
        callId,
        startedAt,
        finishReason,
        providerRequestId,
      );
    } catch (cause) {
      let returnedCount = 0;
      try {
        returnedCount = parseProviderUnits(content).length;
      } catch {
        // The response is intentionally discarded; only a non-sensitive count is retained.
      }
      return this.failedArtifact(
        input,
        units,
        callId,
        startedAt,
        'CALIBRATION_COVERAGE_INVALID',
        cause instanceof Error ? cause.message : String(cause),
        'response_validation',
        returnedCount,
        finishReason,
        providerRequestId,
      );
    }
  }
}

export class GeminiChatCalibrationRuntimeV2
  extends CompleteCalibrationRuntimeBase
  implements ChatCalibrationRuntimeV2
{
  async run(
    input: ChatCalibrationV2Input,
  ): Promise<AdapterExecutionResult<CalibrationResultV3>> {
    if (input.model.plugin_id !== 'gemini') {
      return this.beforeCallFailure(
        input,
        'CALIBRATION_INPUT_INVALID',
        'Gemini 校准需要 gemini 插件。',
        'input_validation',
      );
    }
    if (input.evidenceMode === 'audio_multimodal' && !input.audio) {
      return this.beforeCallFailure(
        input,
        'CALIBRATION_INPUT_INVALID',
        '强校准缺少任务音频。',
        'input_validation',
      );
    }
    let units: CalibrationUnit[];
    try {
      units = calibrationUnits(input);
    } catch (cause) {
      return this.beforeCallFailure(
        input,
        'CALIBRATION_UNITS_INVALID',
        cause instanceof Error ? cause.message : String(cause),
        'input_validation',
      );
    }
    const callId = `call-${this.id()}`;
    const startedAt = this.now().toISOString();
    let client: GeminiChatClient;
    try {
      if (input.model.connection_type === 'developer_api') {
        if (!input.model.credential_ref || !this.dependencies.readCredential) {
          throw new Error('credential resolver missing');
        }
        const key = await this.dependencies.readCredential(input.model.credential_ref);
        client = (
          this.dependencies.createDeveloperClient ??
          ((apiKey) => new GoogleGenAI({ apiKey }) as unknown as GeminiChatClient)
        )(key);
      } else {
        const config = input.model.provider_config as Record<string, unknown>;
        const project = text(config.project);
        const location = text(config.location);
        if (!project || !location) throw new Error('Vertex configuration missing');
        let credentials: Record<string, unknown> | undefined;
        if (
          input.model.credential_ref &&
          !input.model.credential_ref.startsWith('adc:')
        ) {
          if (!this.dependencies.readCredential) throw new Error('credential resolver missing');
          const parsed = JSON.parse(
            await this.dependencies.readCredential(input.model.credential_ref),
          );
          if (!record(parsed)) throw new Error('credential invalid');
          credentials = parsed;
        }
        client = (
          this.dependencies.createVertexClient ??
          ((value) =>
            new GoogleGenAI({
              vertexai: true,
              project: value.project,
              location: value.location,
              apiVersion: 'v1',
              ...(value.credentials
                ? { googleAuthOptions: { credentials: value.credentials } }
                : {}),
            }) as unknown as GeminiChatClient)
        )({ project, location, ...(credentials ? { credentials } : {}) });
      }
    } catch {
      return this.beforeCallFailure(
        input,
        'GEMINI_CONNECTION_FAILED',
        'Gemini 连接无法从凭证引用初始化。',
        'connectivity',
      );
    }
    let request: Record<string, unknown>;
    try {
      const p = prompt(input, units);
      const schema = responseSchema();
      if (input.model.connection_type === 'developer_api') {
        const parts: Record<string, unknown>[] = [{ type: 'text', text: p }];
        if (input.audio) {
          parts.push({
            type: 'audio',
            data: (await readFile(input.audio.sourcePath)).toString('base64'),
            mime_type: 'audio/mpeg',
          });
        }
        request = {
          model: input.model.provider_model,
          store: false,
          input: parts,
          max_output_tokens: outputBudget(units.length),
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema,
          },
        };
      } else {
        const parts: Record<string, unknown>[] = [{ text: p }];
        if (input.audio) {
          parts.push({
            inlineData: {
              data: (await readFile(input.audio.sourcePath)).toString('base64'),
              mimeType: 'audio/mpeg',
            },
          });
        }
        request = {
          model: input.model.provider_model,
          contents: [{ role: 'user', parts }],
          config: {
            maxOutputTokens: outputBudget(units.length),
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
          },
        };
      }
      await this.dependencies.captureRequest?.(request);
    } catch (cause) {
      return this.beforeCallFailure(
        input,
        'GEMINI_REQUEST_PREPARATION_FAILED',
        cause instanceof Error ? cause.message : 'Gemini 请求输入无法在本地准备。',
        'input_validation',
      );
    }
    try {
      await input.beforeProviderDispatch?.('gemini_chat_calibration');
      await this.dependencies.beforeProviderDispatch?.('gemini_chat_calibration');
    } catch {
      return this.beforeCallFailure(
        input,
        'PROVIDER_DISPATCH_CHECKPOINT_FAILED',
        '无法在发送 Gemini 请求前保存 Provider 调用检查点。',
        'artifact_write',
      );
    }
    try {
      const response = input.model.connection_type === 'developer_api'
        ? await client.interactions.create(request)
        : await client.models.generateContent(request);
      const body = response.output_text ?? response.text;
      const finishReason = finishReasonFromGemini(response);
      const providerRequestId = text(response.id ?? response.responseId);
      if (truncatedFinishReason(finishReason)) {
        return this.failedArtifact(
          input,
          units,
          callId,
          startedAt,
          'CALIBRATION_RESPONSE_TRUNCATED',
          `Gemini 未完整结束（finish_reason=${finishReason}）。`,
          'response_validation',
          0,
          finishReason,
          providerRequestId,
        );
      }
      if (!body) {
        return this.failedArtifact(
          input,
          units,
          callId,
          startedAt,
          'GEMINI_RESPONSE_INVALID',
          'Gemini 未返回完整结构化校准结果。',
          'response_validation',
          0,
          finishReason,
          providerRequestId,
        );
      }
      await this.dependencies.captureProviderResponseBody?.(body);
      try {
        const returned = parseProviderUnits(body);
        return this.completedArtifact(
          input,
          units,
          returned,
          callId,
          startedAt,
          finishReason,
          providerRequestId,
        );
      } catch (cause) {
        let returnedCount = 0;
        try {
          returnedCount = parseProviderUnits(body).length;
        } catch {
          // The response is intentionally discarded; only a non-sensitive count is retained.
        }
        return this.failedArtifact(
          input,
          units,
          callId,
          startedAt,
          'CALIBRATION_COVERAGE_INVALID',
          cause instanceof Error ? cause.message : String(cause),
          'response_validation',
          returnedCount,
          finishReason,
          providerRequestId,
        );
      }
    } catch (cause) {
      const provider = providerFailure(cause);
      return this.failedArtifact(
        input,
        units,
        callId,
        startedAt,
        provider.code,
        provider.message,
        'model_call',
        0,
        null,
        null,
        provider.certainty,
        provider.retryable,
      );
    }
  }
}

export function createChatCalibrationRuntimeV2(
  model: ModelSnapshotEntryV2,
  dependencies: ChatCalibrationV2Dependencies = {},
): ChatCalibrationRuntimeV2 {
  return model.plugin_id === 'gemini'
    ? new GeminiChatCalibrationRuntimeV2(dependencies)
    : new OpenAiChatCalibrationRuntimeV2(dependencies);
}
