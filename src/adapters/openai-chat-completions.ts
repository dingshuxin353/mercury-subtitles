import { randomUUID } from 'node:crypto';

import type { CalibrationAdapterInput } from '../contracts/adapters/types.js';
import type { CalibrationAdapter } from '../contracts/adapters/chat-calibration.js';
import type { AdapterExecutionResult } from '../contracts/adapters/result.js';
import type { CalibrationResult } from '../contracts/generated/calibration-result.js';
import type { AdapterFailureRecord, ErrorRecord } from '../contracts/generated/common.js';
import { validateContract } from '../contracts/validation/index.js';
import type { ValidationIssue } from '../contracts/validation/types.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type IdKind = 'call' | 'error' | 'failure';

export type CredentialResolver = (credentialRef: string) => Promise<string>;

export interface OpenAiChatCompletionsAdapterOptions {
  fetch?: FetchLike;
  resolveCredential?: CredentialResolver;
  /** Opt-in diagnostic sink; callers must keep the response body inside the local test task work directory. */
  captureProviderResponseBody?: (body: string) => Promise<void>;
  normalizeSuggestions?: boolean;
  now?: () => Date;
  createId?: (kind: IdKind) => string;
}

interface AdapterError {
  code: string;
  message: string;
  stage: ErrorRecord['stage'];
  retryable: boolean;
}

const SYSTEM_PROMPT = `You are Mercury's fidelity calibration model.
Return only one JSON object with exactly one key, "suggestions".
Each suggestion must contain exactly: suggestion_id, kind, source_segment_refs, start_ms, end_ms, original_text, suggested_text, rationale, confidence.
kind must be text_correction, segmentation, or timing. confidence must be low, medium, or high.
Use only segment IDs and time ranges supplied by the user. Do not translate or invent facts.
When mode is text-only, return only text_correction suggestions. Return {"suggestions":[]} when no correction is supported.`;

const PROVIDER_SUGGESTION_KEYS = [
  'confidence',
  'end_ms',
  'kind',
  'original_text',
  'rationale',
  'source_segment_refs',
  'start_ms',
  'suggested_text',
  'suggestion_id'
] as const;

const PROTOCOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class OpenAiChatCompletionsCalibrationAdapter implements CalibrationAdapter {
  readonly adapterId = 'openai_chat_completions' as const;

  private readonly fetchImpl: FetchLike;
  private readonly resolveCredential: CredentialResolver | undefined;
  private readonly captureProviderResponseBody: ((body: string) => Promise<void>) | undefined;
  private readonly normalizeSuggestions: boolean;
  private readonly now: () => Date;
  private readonly createId: (kind: IdKind) => string;

  constructor(options: OpenAiChatCompletionsAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.resolveCredential = options.resolveCredential;
    this.captureProviderResponseBody = options.captureProviderResponseBody;
    this.normalizeSuggestions = options.normalizeSuggestions ?? false;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  async run(input: CalibrationAdapterInput): Promise<AdapterExecutionResult<CalibrationResult>> {
    const inputError = validateInput(input);
    if (inputError) return this.failureBeforeCall(input, inputError);

    let credential: string | null = null;
    if (input.model.credential_ref !== null) {
      if (!this.resolveCredential) {
        return this.failureBeforeCall(input, {
          code: 'CREDENTIAL_RESOLVER_MISSING',
          message: 'The configured credential reference cannot be resolved by this runtime.',
          stage: 'configuration',
          retryable: false
        });
      }

      try {
        credential = await this.resolveCredential(input.model.credential_ref);
      } catch {
        return this.failureBeforeCall(input, {
          code: 'CREDENTIAL_RESOLUTION_FAILED',
          message: 'The configured credential reference could not be resolved.',
          stage: 'configuration',
          retryable: false
        });
      }

      if (!isNonBlankString(credential)) {
        return this.failureBeforeCall(input, {
          code: 'CREDENTIAL_RESOLUTION_FAILED',
          message: 'The configured credential reference resolved to an empty value.',
          stage: 'configuration',
          retryable: false
        });
      }
    }

    const callId = this.createId('call');
    const startedAt = this.timestamp();
    let response: Response;

    try {
      response = await this.fetchImpl(chatCompletionsUrl(input.model.endpoint), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(credential === null ? {} : { Authorization: `Bearer ${credential}` })
        },
        body: JSON.stringify({
          model: input.model.model,
          messages: calibrationMessages(input)
        })
      });
    } catch {
      return this.failedArtifact(input, callId, startedAt, this.timestamp(), {
        code: 'MODEL_CALL_FAILED',
        message: 'The Chat Completions request failed before an HTTP response was received.',
        stage: 'model_call',
        retryable: true
      });
    }

    const headerRequestId = nonBlankOrNull(response.headers.get('x-request-id'));
    if (!response.ok) {
      return this.failedArtifact(input, callId, startedAt, this.timestamp(), {
        code: 'MODEL_HTTP_ERROR',
        message: `The Chat Completions endpoint returned HTTP ${response.status}.`,
        stage: 'model_call',
        retryable: response.status === 408 || response.status === 429 || response.status >= 500
      }, headerRequestId);
    }

    let providerResponseBody: string;
    try {
      providerResponseBody = await response.text();
    } catch {
      return this.failedArtifact(input, callId, startedAt, this.timestamp(), {
        code: 'PROVIDER_RESPONSE_READ_FAILED',
        message: 'The Chat Completions response body could not be read.',
        stage: 'response_parse',
        retryable: true
      }, headerRequestId);
    }

    if (this.captureProviderResponseBody) {
      try {
        await this.captureProviderResponseBody(providerResponseBody);
      } catch {
        return this.failedArtifact(input, callId, startedAt, this.timestamp(), {
          code: 'PROVIDER_RESPONSE_CAPTURE_FAILED',
          message: 'The provider response body could not be saved to the configured diagnostic destination.',
          stage: 'artifact_write',
          retryable: false
        }, headerRequestId);
      }
    }

    let providerResponse: unknown;
    try {
      providerResponse = JSON.parse(providerResponseBody);
    } catch {
      return this.failedArtifact(input, callId, startedAt, this.timestamp(), {
        code: 'PROVIDER_RESPONSE_INVALID_JSON',
        message: 'The Chat Completions endpoint returned invalid JSON.',
        stage: 'response_parse',
        retryable: false
      }, headerRequestId);
    }

    const providerRequestId = providerResponseId(providerResponse) ?? headerRequestId;
    const content = providerMessageContent(providerResponse);
    if (content === null) {
      return this.failedArtifact(input, callId, startedAt, this.timestamp(), {
        code: 'PROVIDER_RESPONSE_EMPTY_CONTENT',
        message: 'The Chat Completions response did not contain non-empty choices[0].message.content.',
        stage: 'response_validation',
        retryable: false
      }, providerRequestId);
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(content);
    } catch {
      return this.failedArtifact(input, callId, startedAt, this.timestamp(), {
        code: 'CALIBRATION_CONTENT_INVALID_JSON',
        message: 'The calibration message content was not valid JSON.',
        stage: 'response_parse',
        retryable: false
      }, providerRequestId);
    }

    const parsedSuggestions = parseSuggestions(parsedContent, this.normalizeSuggestions);
    if ('error' in parsedSuggestions) {
      return this.failedArtifact(
        input,
        callId,
        startedAt,
        this.timestamp(),
        parsedSuggestions.error,
        providerRequestId
      );
    }

    const endedAt = this.timestamp();
    const candidateArtifact = {
      schema_version: '1.0.0',
      task_id: input.taskId,
      created_at: endedAt,
      status: 'completed',
      request: calibrationRequest(input),
      model_snapshot_ref: input.modelSnapshotRef,
      call: {
        call_id: callId,
        model_snapshot_entry_ref: input.model.snapshot_entry_id,
        started_at: startedAt,
        ended_at: endedAt,
        ...(providerRequestId === null ? {} : { provider_request_id: providerRequestId }),
        outcome: 'completed',
        error_ref: null
      },
      suggestions: parsedSuggestions.suggestions.map((suggestion) => ({
        ...suggestion,
        disposition: 'not_applied',
        disposition_reason: 'insufficient_evidence'
      })),
      warnings: [],
      errors: []
    };

    const validation = validateContract('calibration-result', candidateArtifact);
    if (!validation.valid) {
      return this.failedArtifact(input, callId, startedAt, endedAt, {
        code: 'CALIBRATION_RESULT_INVALID',
        message: validationDiagnostic(validation.issues, candidateArtifact),
        stage: 'response_validation',
        retryable: false
      }, providerRequestId);
    }

    const sourceError = validateSuggestionSources(validation.value, input);
    if (sourceError) {
      return this.failedArtifact(input, callId, startedAt, endedAt, sourceError, providerRequestId);
    }

    return { kind: 'artifact', artifact: validation.value };
  }

  private failureBeforeCall(
    input: CalibrationAdapterInput,
    adapterError: AdapterError
  ): AdapterExecutionResult<CalibrationResult> {
    const occurredAt = this.timestamp();
    const error = this.errorRecord(adapterError);
    const failure: AdapterFailureRecord = {
      failure_id: this.createId('failure'),
      task_id: input.taskId,
      role: 'calibration',
      model_snapshot_ref: input.modelSnapshotRef,
      occurred_at: occurredAt,
      provider_outcome_certainty: 'not_dispatched',
      errors: [error],
      warnings: [],
      call: null,
      staging: []
    };
    return { kind: 'failure', failure };
  }

  private failedArtifact(
    input: CalibrationAdapterInput,
    callId: string,
    startedAt: string,
    endedAt: string,
    adapterError: AdapterError,
    providerRequestId: string | null = null
  ): AdapterExecutionResult<CalibrationResult> {
    const error = this.errorRecord(adapterError);
    const artifact: CalibrationResult = {
      schema_version: '1.0.0',
      task_id: input.taskId,
      created_at: endedAt,
      status: 'failed',
      request: calibrationRequest(input),
      model_snapshot_ref: input.modelSnapshotRef,
      call: {
        call_id: callId,
        model_snapshot_entry_ref: input.model.snapshot_entry_id,
        started_at: startedAt,
        ended_at: endedAt,
        ...(providerRequestId === null ? {} : { provider_request_id: providerRequestId }),
        outcome: 'failed',
        error_ref: error.error_id
      },
      suggestions: [],
      warnings: [],
      errors: [error]
    };

    if (validateContract('calibration-result', artifact).valid) {
      return { kind: 'artifact', artifact };
    }

    const failure: AdapterFailureRecord = {
      failure_id: this.createId('failure'),
      task_id: input.taskId,
      role: 'calibration',
      model_snapshot_ref: input.modelSnapshotRef,
      occurred_at: endedAt,
      provider_outcome_certainty: 'known_terminal',
      errors: [error],
      warnings: [],
      call: artifact.call,
      staging: []
    };
    return { kind: 'failure', failure };
  }

  private errorRecord(adapterError: AdapterError): ErrorRecord {
    return {
      error_id: this.createId('error'),
      ...adapterError
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function validateInput(input: CalibrationAdapterInput): AdapterError | null {
  if (
    !PROTOCOL_ID_PATTERN.test(input.taskId) ||
    !PROTOCOL_ID_PATTERN.test(input.modelSnapshotRef) ||
    !PROTOCOL_ID_PATTERN.test(input.model.snapshot_entry_id)
  ) {
    return inputError('The calibration input contains an invalid D001 identifier.');
  }

  if (
    input.model.role !== 'calibration' ||
    input.model.adapter !== 'openai_chat_completions' ||
    input.model.runtime !== 'cloud' ||
    !isNonBlankString(input.model.model) ||
    !isValidEndpoint(input.model.endpoint)
  ) {
    return inputError('The calibration model snapshot entry is incomplete or incompatible.');
  }

  if (
    input.transcript.task_id !== input.taskId ||
    input.transcript.model_snapshot_ref !== input.modelSnapshotRef
  ) {
    return inputError('The transcript and calibration request do not belong to the same task snapshot.');
  }

  if (
    (input.referenceSrt === null && input.mode !== null) ||
    (input.referenceSrt !== null && input.mode === null) ||
    (input.referenceSrt !== null &&
      (!hasNonBlankContent(input.referenceSrt.text) || input.referenceSrt.pathRef !== 'input/reference.srt'))
  ) {
    return inputError('The reference SRT and calibration mode combination is invalid.');
  }

  if (
    input.model.cloud_data_confirmation.confirmed !== true ||
    !input.model.cloud_data_confirmation.data_categories.includes('transcript') ||
    (input.referenceSrt !== null && !input.model.cloud_data_confirmation.data_categories.includes('reference_srt'))
  ) {
    return {
      code: 'CLOUD_DATA_NOT_CONFIRMED',
      message: 'Cloud data sending is not confirmed for all calibration inputs.',
      stage: 'confirmation',
      retryable: false
    };
  }

  return null;
}

function inputError(message: string): AdapterError {
  return {
    code: 'CALIBRATION_INPUT_INVALID',
    message,
    stage: 'input_validation',
    retryable: false
  };
}

function isValidEndpoint(value: unknown): value is string {
  if (!isNonBlankString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function chatCompletionsUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function calibrationMessages(input: CalibrationAdapterInput): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        mode: input.mode,
        transcript: input.transcript.segments.map((segment) => ({
          segment_id: segment.segment_id,
          start_ms: segment.start_ms,
          end_ms: segment.end_ms,
          text: segment.text
        })),
        reference_srt: input.referenceSrt?.text ?? null
      })
    }
  ];
}

function calibrationRequest(input: CalibrationAdapterInput): CalibrationResult['request'] {
  return {
    transcript_ref: 'work/transcript.raw.json',
    reference_srt_ref: input.referenceSrt?.pathRef ?? null,
    mode: input.mode
  };
}

function providerResponseId(value: unknown): string | null {
  return isRecord(value) ? nonBlankOrNull(value.id) : null;
}

function providerMessageContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) return null;
  const firstChoice = value.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return null;
  return hasNonBlankContent(firstChoice.message.content) ? firstChoice.message.content : null;
}

function parseSuggestions(
  value: unknown,
  normalizeSuggestions: boolean
): { suggestions: Array<Record<string, unknown>> } | { error: AdapterError } {
  if (!isRecord(value) || !hasExactKeys(value, ['suggestions']) || !Array.isArray(value.suggestions)) {
    return invalidContent('The calibration content must be an object containing only a suggestions array.');
  }

  const suggestions: Array<Record<string, unknown>> = [];
  for (const [index, candidate] of value.suggestions.entries()) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, PROVIDER_SUGGESTION_KEYS)) {
      return invalidContent('A calibration suggestion has missing or unsupported fields.');
    }
    suggestions.push(normalizeSuggestions
      ? normalizeProviderSuggestion(candidate, index)
      : candidate);
  }

  return { suggestions };
}

function normalizeProviderSuggestion(
  candidate: Record<string, unknown>,
  index: number
): Record<string, unknown> {
  return {
    ...candidate,
    suggestion_id: `suggestion-${String(index + 1).padStart(4, '0')}`,
    original_text: normalizeProviderText(candidate.original_text, false),
    suggested_text: normalizeProviderText(candidate.suggested_text, false),
    rationale: normalizeProviderText(candidate.rationale, true)
  };
}

function normalizeProviderText(value: unknown, preserveBoundary: boolean): unknown {
  if (typeof value !== 'string') return value;
  const replacement = preserveBoundary ? ' ' : '';
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, replacement).trim();
}

function validateSuggestionSources(
  artifact: CalibrationResult,
  input: CalibrationAdapterInput
): AdapterError | null {
  const segmentById = new Map(input.transcript.segments.map((segment) => [segment.segment_id, segment]));
  for (const suggestion of artifact.suggestions) {
    const sourceSegments = suggestion.source_segment_refs.map((ref) => segmentById.get(ref));
    if (sourceSegments.some((segment) => segment === undefined)) {
      return invalidContentError('A calibration suggestion referenced an unknown transcript segment.');
    }

    const firstStart = Math.min(...sourceSegments.map((segment) => segment!.start_ms));
    const lastEnd = Math.max(...sourceSegments.map((segment) => segment!.end_ms));
    if (suggestion.start_ms < firstStart || suggestion.end_ms > lastEnd) {
      return invalidContentError('A calibration suggestion time range exceeded its source segments.');
    }
  }
  return null;
}

function invalidContent(message: string): { error: AdapterError } {
  return { error: invalidContentError(message) };
}

function invalidContentError(message: string): AdapterError {
  return {
    code: 'CALIBRATION_CONTENT_INVALID',
    message,
    stage: 'response_validation',
    retryable: false
  };
}

function validationDiagnostic(issues: ValidationIssue[], value: unknown): string {
  const displayed = issues.slice(0, 8).map((issue) =>
    `${issue.path} [${issue.invariant_id}] value_type=${jsonValueType(valueAtPointer(value, issue.path))}: ${issue.message}`
  );
  const remaining = issues.length - displayed.length;
  return `D001 calibration validation failed with ${issues.length} issue(s): ${displayed.join('; ')}${
    remaining > 0 ? `; ${remaining} additional issue(s) omitted` : ''
  }`;
}

function valueAtPointer(value: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return value;
  let current = value;
  for (const encodedToken of pointer.split('/').slice(1)) {
    const token = encodedToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = /^(0|[1-9][0-9]*)$/.test(token) ? Number(token) : -1;
      current = index >= 0 ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function jsonValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

function hasNonBlankContent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonBlankOrNull(value: unknown): string | null {
  return isNonBlankString(value) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ? value : null;
}
