import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import type {
  AdapterExecutionResult,
  AdapterFailureRecord,
  AsrAdapter,
  AsrAdapterInput,
  CallRecord,
  ErrorRecord,
  TranscriptRaw,
  TranscriptSegment,
  WordTiming
} from '../contracts/index.js';
import { validateContract } from '../contracts/index.js';

export const VOLCENGINE_ASR_ENDPOINT =
  'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
export const VOLCENGINE_ASR_RESOURCE_ID = 'volc.bigasr.auc_turbo';
export const VOLCENGINE_ASR_MODEL_NAME = 'bigmodel';
export const VOLCENGINE_ASR_MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const VOLCENGINE_ASR_MAX_DURATION_MS = 2 * 60 * 60 * 1000;

export type ResolvedVolcengineCredential =
  | {
      mode: 'api_key';
      uid: string;
      value: string;
    }
  | {
      mode: 'legacy';
      uid: string;
      appKey: string;
      accessKey: string;
    };

export interface VolcengineAsrDependencies {
  resolveCredential(
    credentialRef: string
  ): Promise<ResolvedVolcengineCredential> | ResolvedVolcengineCredential;
  fetch?: typeof globalThis.fetch;
  beforeProviderDispatch?: (operation:
    | 'volcengine_asr_recognize'
    | 'volcengine_subtitle_submit'
    | 'volcengine_subtitle_query'
    | 'openai_chat_calibration'
    | 'gemini_chat_calibration') => Promise<void>;
  now?: () => Date;
  createId?: () => string;
}

interface ProviderWord {
  confidence?: unknown;
  end_time?: unknown;
  start_time?: unknown;
  text?: unknown;
}

interface ProviderUtterance {
  confidence?: unknown;
  end_time?: unknown;
  start_time?: unknown;
  text?: unknown;
  words?: unknown;
}

interface ProviderResponse {
  result?: {
    text?: unknown;
    utterances?: unknown;
  };
}

class NormalizationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'NormalizationError';
  }
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function presentHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value ? value : undefined;
}

function confidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function exactNonBlank(value: unknown): value is string {
  return typeof value === 'string' && normalizedText(value) === value;
}

function isWhitespaceTimingPlaceholder(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const word = value as ProviderWord;
  return (
    word.start_time === -1 &&
    word.end_time === -1 &&
    typeof word.text === 'string' &&
    word.text.trim().length === 0
  );
}

function normalizedWord(
  value: unknown,
  segmentIndex: number,
  wordIndex: number,
  segmentStart: number,
  segmentEnd: number,
  previousEnd: number
): WordTiming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NormalizationError('VOLCENGINE_RESPONSE_INVALID', 'The ASR response contains an invalid word.');
  }

  const word = value as ProviderWord;
  const text = normalizedText(word.text);
  if (
    !integer(word.start_time) ||
    !integer(word.end_time) ||
    word.start_time < segmentStart ||
    word.start_time < previousEnd ||
    word.end_time <= word.start_time ||
    word.end_time > segmentEnd ||
    text === null
  ) {
    throw new NormalizationError(
      'VOLCENGINE_TIMING_INVALID',
      'The ASR response contains invalid word timing.'
    );
  }

  return {
    word_id: `asr-word-${String(segmentIndex + 1).padStart(4, '0')}-${String(wordIndex + 1).padStart(4, '0')}`,
    index: wordIndex,
    start_ms: word.start_time,
    end_ms: word.end_time,
    text,
    confidence: confidence(word.confidence)
  };
}

function normalizedSegment(
  value: unknown,
  index: number,
  durationMs: number,
  previousEnd: number
): TranscriptSegment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NormalizationError(
      'VOLCENGINE_RESPONSE_INVALID',
      'The ASR response contains an invalid utterance.'
    );
  }

  const utterance = value as ProviderUtterance;
  const text = normalizedText(utterance.text);
  if (
    !integer(utterance.start_time) ||
    !integer(utterance.end_time) ||
    utterance.start_time < 0 ||
    utterance.start_time < previousEnd ||
    utterance.end_time <= utterance.start_time ||
    utterance.end_time > durationMs ||
    text === null
  ) {
    throw new NormalizationError(
      'VOLCENGINE_TIMING_INVALID',
      'The ASR response contains invalid utterance timing.'
    );
  }

  if (utterance.words !== undefined && !Array.isArray(utterance.words)) {
    throw new NormalizationError(
      'VOLCENGINE_RESPONSE_INVALID',
      'The ASR response contains an invalid words collection.'
    );
  }

  let previousWordEnd = utterance.start_time;
  const words = (utterance.words ?? [])
    .filter((word) => !isWhitespaceTimingPlaceholder(word))
    .map((word, wordIndex) => {
      const normalized = normalizedWord(
        word,
        index,
        wordIndex,
        utterance.start_time as number,
        utterance.end_time as number,
        previousWordEnd
      );
      previousWordEnd = normalized.end_ms;
      return normalized;
    });

  return {
    segment_id: `asr-segment-${String(index + 1).padStart(4, '0')}`,
    index,
    start_ms: utterance.start_time,
    end_ms: utterance.end_time,
    text,
    confidence: confidence(utterance.confidence),
    words
  };
}

function normalizeSegments(
  response: ProviderResponse,
  durationMs: number
): [TranscriptSegment, ...TranscriptSegment[]] {
  const result = response.result;
  if (normalizedText(result?.text) === null) {
    throw new NormalizationError('VOLCENGINE_EMPTY_TRANSCRIPT', 'The ASR response has no transcript text.');
  }
  if (!Array.isArray(result?.utterances) || result.utterances.length === 0) {
    throw new NormalizationError(
      'VOLCENGINE_EMPTY_TRANSCRIPT',
      'The ASR response has no timed utterances.'
    );
  }

  let previousEnd = 0;
  const segments = result.utterances.map((utterance, index) => {
    const segment = normalizedSegment(utterance, index, durationMs, previousEnd);
    previousEnd = segment.end_ms;
    return segment;
  });
  return segments as [TranscriptSegment, ...TranscriptSegment[]];
}

function providerRetryable(statusCode: string, httpStatus?: number): boolean {
  return statusCode.startsWith('55') || httpStatus === 408 || httpStatus === 429 || (httpStatus ?? 0) >= 500;
}

function providerError(statusCode: string, providerMessage?: string, logId?: string): Pick<ErrorRecord, 'code' | 'message' | 'retryable' | 'remediation'> {
  if (statusCode === '20000003') {
    return {
      code: 'VOLCENGINE_NO_SPEECH',
      message: '火山极速版没有识别出可转写的人声。',
      retryable: false,
      remediation: '检查音频内容或换一段清晰的中文人声。'
    };
  }
  if (statusCode === '45000010') {
    return {
      code: 'VOLCENGINE_STATUS_45000010',
      message: `火山极速版拒绝了鉴权身份或资源权限（provider code=45000010${providerMessage ? `，信息=${providerMessage}` : ''}${logId ? `，log id=${logId}` : ''}）。`,
      retryable: false,
      remediation: '确认 APP Key 与 API Key 来自同一新版应用、已开通极速版资源；新版配置中 APP Key 必须用于请求身份。'
    };
  }
  return {
    code: `VOLCENGINE_STATUS_${statusCode.replaceAll(/[^A-Z0-9]/g, '_')}`,
    message: `火山极速版拒绝了请求（provider code=${statusCode}${providerMessage ? `，信息=${providerMessage}` : ''}${logId ? `，log id=${logId}` : ''}）。`,
    retryable: providerRetryable(statusCode),
    remediation: '核对模型凭证和资源开通状态；持续失败时把 provider code 与 log id 提供给服务商。'
  };
}

function validCredential(credential: ResolvedVolcengineCredential): boolean {
  if (!exactNonBlank(credential.uid)) return false;
  return credential.mode === 'api_key'
    ? exactNonBlank(credential.value)
    : exactNonBlank(credential.appKey) && exactNonBlank(credential.accessKey);
}

function redactedProviderResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactedProviderResponse);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      /(?:^|_)(?:api_?keys?|access_?keys?|tokens?|authorizations?|credentials?|secrets?)(?:_|$)/i.test(
        key
      )
        ? '[REDACTED]'
        : redactedProviderResponse(child)
    ])
  );
}

export class VolcengineAsrAdapter implements AsrAdapter {
  readonly adapterId = 'volcengine_asr' as const;

  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly dependencies: VolcengineAsrDependencies) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async run(input: AsrAdapterInput): Promise<AdapterExecutionResult<TranscriptRaw>> {
    const startedAt = timestamp(this.now);
    const callId = this.createId();
    const requestId = this.createId();

    const preflightFailure = await this.preflight(input);
    if (preflightFailure) return preflightFailure;

    let credential: ResolvedVolcengineCredential;
    try {
      credential = await this.dependencies.resolveCredential(input.model.credential_ref);
    } catch {
      return this.failedResult(input, {
        callId,
        startedAt,
        code: 'VOLCENGINE_CREDENTIAL_RESOLUTION_FAILED',
        message: 'The referenced Volcengine credential could not be resolved.',
        stage: 'configuration',
        retryable: false
      });
    }
    if (!validCredential(credential)) {
      return this.failedResult(input, {
        callId,
        startedAt,
        code: 'VOLCENGINE_CREDENTIAL_INVALID',
        message: 'The referenced Volcengine credential is incomplete.',
        stage: 'configuration',
        retryable: false
      });
    }

    let audioData: Buffer;
    try {
      audioData = await readFile(input.audio.sourcePath);
    } catch {
      return this.failedResult(input, {
        call: null,
        code: 'ASR_AUDIO_READ_FAILED',
        message: 'The task audio copy could not be read.',
        stage: 'media_decode',
        retryable: false
      });
    }
    if (audioData.byteLength > VOLCENGINE_ASR_MAX_INPUT_BYTES) {
      return this.failedResult(input, {
        call: null,
        code: 'ASR_INPUT_SIZE_EXCEEDED',
        message: 'The MP3 exceeds the 100 MiB Volcengine turbo limit.',
        stage: 'media_decode',
        retryable: false
      });
    }

    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-Api-Request-Id': requestId,
      'X-Api-Resource-Id': VOLCENGINE_ASR_RESOURCE_ID,
      'X-Api-Sequence': '-1'
    });
    if (credential.mode === 'api_key') {
      headers.set('X-Api-Key', credential.value);
    } else {
      headers.set('X-Api-App-Key', credential.appKey);
      headers.set('X-Api-Access-Key', credential.accessKey);
    }

    try {
      await input.beforeProviderDispatch?.('volcengine_asr_recognize');
      await this.dependencies.beforeProviderDispatch?.('volcengine_asr_recognize');
    } catch {
      return this.failedResult(input, {
        call: null,
        code: 'PROVIDER_DISPATCH_CHECKPOINT_FAILED',
        message: 'The task could not persist the Provider dispatch checkpoint.',
        stage: 'artifact_write',
        retryable: false,
        providerOutcomeCertainty: 'not_dispatched'
      });
    }

    let response: Response;
    try {
      response = await this.fetch(VOLCENGINE_ASR_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user: { uid: credential.uid },
          audio: { data: audioData.toString('base64') },
          request: { model_name: VOLCENGINE_ASR_MODEL_NAME }
        })
      });
    } catch {
      return this.failedResult(input, {
        callId,
        startedAt,
        providerRequestId: requestId,
        code: 'VOLCENGINE_NETWORK_ERROR',
        message: 'The Volcengine ASR request could not reach the provider.',
        stage: 'connectivity',
        retryable: true,
        providerOutcomeCertainty: 'outcome_unknown'
      });
    }

    const providerRequestId = presentHeader(response.headers, 'X-Tt-Logid') ?? requestId;
    const providerStatus = presentHeader(response.headers, 'X-Api-Status-Code');
    const providerMessage = presentHeader(response.headers, 'X-Api-Message');
    if (providerStatus && providerStatus !== '20000000') {
      return this.failedResult(input, {
        callId,
        startedAt,
        providerRequestId,
        stage: 'model_call',
        ...providerError(providerStatus, providerMessage, providerRequestId)
      });
    }
    if (!response.ok) {
      return this.failedResult(input, {
        callId,
        startedAt,
        providerRequestId,
        code: 'VOLCENGINE_HTTP_ERROR',
        message: `The Volcengine ASR request failed with HTTP status ${response.status}.`,
        stage: 'model_call',
        retryable: providerRetryable('', response.status)
      });
    }
    if (!providerStatus) {
      return this.failedResult(input, {
        callId,
        startedAt,
        providerRequestId,
        code: 'VOLCENGINE_STATUS_MISSING',
        message: 'The Volcengine ASR response did not include a provider status.',
        stage: 'response_validation',
        retryable: false
      });
    }

    let providerResponse: ProviderResponse;
    try {
      providerResponse = (await response.json()) as ProviderResponse;
    } catch {
      return this.failedResult(input, {
        callId,
        startedAt,
        providerRequestId,
        code: 'VOLCENGINE_RESPONSE_PARSE_FAILED',
        message: 'The Volcengine ASR response was not valid JSON.',
        stage: 'response_parse',
        retryable: false
      });
    }

    const endedAt = timestamp(this.now);
    let segments: [TranscriptSegment, ...TranscriptSegment[]];
    try {
      segments = normalizeSegments(providerResponse, input.audio.durationMs);
    } catch (error) {
      const normalizationError =
        error instanceof NormalizationError
          ? error
          : new NormalizationError(
              'VOLCENGINE_RESPONSE_INVALID',
              'The Volcengine ASR response could not be normalized.'
            );
      return this.failedResult(input, {
        callId,
        startedAt,
        endedAt,
        providerRequestId,
        code: normalizationError.code,
        message: normalizationError.message,
        stage: 'response_validation',
        retryable: false
      });
    }

    const call: CallRecord = {
      call_id: callId,
      model_snapshot_entry_ref: input.model.snapshot_entry_id,
      started_at: startedAt,
      ended_at: endedAt,
      provider_request_id: providerRequestId,
      outcome: 'completed',
      error_ref: null
    };
    const rawResponseRef = 'work/provider-response.asr.redacted.json';
    const transcript: TranscriptRaw = {
      schema_version: '1.0.0',
      task_id: input.taskId,
      created_at: timestamp(this.now),
      audio: {
        path_ref: input.audio.pathRef,
        sha256: input.audio.sha256,
        duration_ms: input.audio.durationMs,
        language: input.audio.language,
        mime_type: input.audio.mimeType
      },
      full_text: segments.map((segment) => segment.text).join('\n'),
      segments,
      model_snapshot_ref: input.modelSnapshotRef,
      call,
      raw_response_ref: rawResponseRef,
      warnings: [],
      errors: []
    };

    if (!validateContract('transcript.raw', transcript).valid) {
      return this.failedResult(input, {
        callId,
        startedAt,
        endedAt,
        providerRequestId,
        code: 'VOLCENGINE_TRANSCRIPT_CONTRACT_INVALID',
        message: 'The normalized ASR response did not satisfy transcript.raw.',
        stage: 'response_validation',
        retryable: false
      });
    }

    try {
      const taskRoot = resolve(dirname(input.audio.sourcePath), '..');
      const rawResponsePath = resolve(taskRoot, rawResponseRef);
      await mkdir(dirname(rawResponsePath), { recursive: true });
      await writeFile(
        rawResponsePath,
        `${JSON.stringify(redactedProviderResponse(providerResponse), null, 2)}\n`,
        'utf8'
      );
    } catch {
      return this.failedResult(input, {
        completedCall: call,
        code: 'ASR_RAW_RESPONSE_WRITE_FAILED',
        message: 'The redacted provider response could not be written to the task workspace.',
        stage: 'artifact_write',
        retryable: false
      });
    }

    return { kind: 'artifact', artifact: transcript };
  }

  private async preflight(
    input: AsrAdapterInput
  ): Promise<AdapterExecutionResult<TranscriptRaw> | null> {
    if (
      input.model.provider_config.resource_id !== VOLCENGINE_ASR_RESOURCE_ID ||
      input.model.model !== VOLCENGINE_ASR_MODEL_NAME ||
      input.model.check_snapshot.outcome !== 'passed' ||
      !input.model.cloud_data_confirmation.confirmed ||
      !input.model.cloud_data_confirmation.data_categories.includes('audio')
    ) {
      const startedAt = timestamp(this.now);
      return this.failedResult(input, {
        callId: this.createId(),
        startedAt,
        code: 'VOLCENGINE_CONFIGURATION_INVALID',
        message: 'The ASR model snapshot is not valid for the Volcengine turbo adapter.',
        stage: 'configuration',
        retryable: false
      });
    }
    if (extname(input.audio.sourcePath).toLowerCase() !== '.mp3') {
      return this.failedResult(input, {
        call: null,
        code: 'ASR_INPUT_FORMAT_INVALID',
        message: 'The Volcengine turbo adapter requires a local MP3 task copy.',
        stage: 'media_decode',
        retryable: false
      });
    }
    if (input.audio.durationMs > VOLCENGINE_ASR_MAX_DURATION_MS) {
      return this.failedResult(input, {
        call: null,
        code: 'ASR_INPUT_DURATION_EXCEEDED',
        message: 'The MP3 exceeds the two-hour Volcengine turbo limit.',
        stage: 'media_decode',
        retryable: false
      });
    }

    try {
      const source = await stat(input.audio.sourcePath);
      if (!source.isFile() || source.size === 0) {
        return this.failedResult(input, {
          call: null,
          code: 'ASR_INPUT_FILE_INVALID',
          message: 'The task audio copy is not a non-empty file.',
          stage: 'media_decode',
          retryable: false
        });
      }
      if (source.size > VOLCENGINE_ASR_MAX_INPUT_BYTES) {
        return this.failedResult(input, {
          call: null,
          code: 'ASR_INPUT_SIZE_EXCEEDED',
          message: 'The MP3 exceeds the 100 MiB Volcengine turbo limit.',
          stage: 'media_decode',
          retryable: false
        });
      }
    } catch {
      return this.failedResult(input, {
        call: null,
        code: 'ASR_INPUT_FILE_UNAVAILABLE',
        message: 'The task audio copy is unavailable.',
        stage: 'media_decode',
        retryable: false
      });
    }
    return null;
  }

  private failedResult(
    input: AsrAdapterInput,
    details: {
      code: string;
      message: string;
      stage: ErrorRecord['stage'];
      retryable: boolean;
      remediation?: string;
      call?: null;
      callId?: string;
      startedAt?: string;
      endedAt?: string;
      providerRequestId?: string;
      completedCall?: CallRecord;
      providerOutcomeCertainty?: 'not_dispatched' | 'known_terminal' | 'outcome_unknown';
    }
  ): AdapterExecutionResult<TranscriptRaw> {
    const providerOutcomeCertainty = details.providerOutcomeCertainty
      ?? (['configuration', 'input_validation', 'media_decode', 'confirmation', 'capability'].includes(details.stage) ? 'not_dispatched' : 'known_terminal');
    const errorId = this.createId();
    const error: ErrorRecord = {
      error_id: errorId,
      code: details.code,
      message: details.message,
      stage: details.stage,
      retryable: details.retryable,
      ...(details.remediation ? { remediation: details.remediation } : {})
    };
    let call: CallRecord | null = null;
    if (details.completedCall) {
      call = details.completedCall;
    } else if (providerOutcomeCertainty !== 'not_dispatched' && details.call !== null && details.callId && details.startedAt) {
      call = {
        call_id: details.callId,
        model_snapshot_entry_ref: input.model.snapshot_entry_id,
        started_at: details.startedAt,
        ended_at: details.endedAt ?? timestamp(this.now),
        ...(details.providerRequestId
          ? { provider_request_id: details.providerRequestId }
          : {}),
        outcome: 'failed',
        error_ref: errorId
      };
    }

    const failure: AdapterFailureRecord = {
      failure_id: this.createId(),
      task_id: input.taskId,
      role: 'asr',
      model_snapshot_ref: input.modelSnapshotRef,
      occurred_at: timestamp(this.now),
      provider_outcome_certainty: providerOutcomeCertainty,
      errors: [error],
      warnings: [],
      call,
      staging: []
    };
    return { kind: 'failure', failure };
  }
}
