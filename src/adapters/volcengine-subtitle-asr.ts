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
  WordTiming,
} from '../contracts/index.js';
import { validateContract } from '../contracts/index.js';

export const VOLCENGINE_SUBTITLE_SUBMIT_ENDPOINT =
  'https://openspeech.bytedance.com/api/v1/vc/submit';
export const VOLCENGINE_SUBTITLE_QUERY_ENDPOINT =
  'https://openspeech.bytedance.com/api/v1/vc/query';

export interface VolcengineSubtitleAsrDependencies {
  readCredential(reference: string): Promise<string>;
  fetch?: typeof globalThis.fetch;
  beforeProviderDispatch?: (
    operation:
      | 'volcengine_asr_recognize'
      | 'volcengine_subtitle_submit'
      | 'volcengine_subtitle_query'
      | 'openai_chat_calibration'
      | 'gemini_chat_calibration',
  ) => Promise<void>;
  now?: () => Date;
  createId?: () => string;
}

type JsonRecord = Record<string, unknown>;
type SubtitleCredential = { mode: 'access_token'; token: string };

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().normalize('NFC')
    : null;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function providerCode(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : nonBlank(value);
}

function safeId(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
}

function displayId(value: string): string {
  const safe = safeId(value);
  return safe.length <= 16 ? safe : `${safe.slice(0, 8)}…${safe.slice(-4)}`;
}

function parseCredential(value: string): SubtitleCredential {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      record(parsed) &&
      parsed.mode === 'legacy' &&
      nonBlank(parsed.token)
    )
      return { mode: 'access_token', token: nonBlank(parsed.token)! };
    if (record(parsed) && parsed.mode === 'api_key')
      throw new Error('unsupported APP Key credential');
  } catch {
    // A JSON credential must match the documented Access Token shape.
    if (value.trim().startsWith('{')) throw new Error('invalid credential');
  }
  const raw = nonBlank(value);
  if (!raw) throw new Error('empty credential');
  return { mode: 'access_token', token: raw };
}

function userMessage(code: string, detail: string | null): {
  message: string;
  remediation: string;
  retryable: boolean;
} {
  if (
    code === '1022' &&
    /vc\.async\.default|requested resource not granted|requested grant not found/iu.test(
      detail ?? '',
    )
  ) {
    return {
      message:
        '请求使用的火山应用未获“音视频字幕”资源 vc.async.default（Provider code=1022）。',
      remediation: '请核对 APP ID、Access Token 与控制台项目是否对应同一项音视频字幕服务，确认后再检查此模型。',
      retryable: false,
    };
  }
  const known: Record<string, [string, string, boolean]> = {
    '1001': ['服务拒绝了配置或请求参数。', '检查 APP ID 是否属于音视频字幕服务。', false],
    '1002': ['服务没有授予本次访问权限。', '核对 APP ID、Access Token 与控制台项目是否对应同一项音视频字幕服务。', false],
    '1003': ['请求过于频繁。', '稍后重试模型检查。', true],
    '1004': ['服务额度已用完。', '到火山引擎控制台检查额度后重试。', false],
    '1005': ['服务当前繁忙。', '稍后重试。', true],
    '1010': ['音频时长超过服务限制。', '换用更短的 MP3。', false],
    '1011': ['音频文件超过服务限制。', '换用更小的 MP3。', false],
    '1012': ['服务无法解码该音频。', '确认文件是可正常播放的 MP3。', false],
    '1013': ['服务没有识别出可转写的人声。', '检查音频内容或换一段清晰人声。', false],
    '1020': ['识别等待超时。', '稍后重试；若持续失败，请保留任务 ID 联系服务商。', true],
    '1021': ['识别处理超时。', '稍后重试；若持续失败，请保留任务 ID 联系服务商。', true],
    '1022': ['服务处理音频时发生错误。', '稍后重试；若持续失败，请保留任务 ID 联系服务商。', true],
    '1099': ['服务返回未分类错误。', '保留任务 ID 和错误码后联系服务商。', false],
    '2000': ['服务仍在处理音频，等待已超时。', '稍后重新检查，或换用更短的检查片段。', true],
  };
  const item = known[code] ?? [
    '服务拒绝了本次字幕识别请求。',
    '检查服务配置；若持续失败，请把错误码和任务 ID 提供给服务商。',
    false,
  ];
  return {
    message: `${item[0]} Provider code=${code}${detail ? `，信息=${detail}` : ''}`,
    remediation: item[1],
    retryable: item[2],
  };
}

function normalizeWords(
  value: unknown,
  segmentIndex: number,
  segmentStart: number,
  segmentEnd: number,
): { words: WordTiming[]; dropped: number } {
  if (value === undefined) return { words: [], dropped: 0 };
  if (!Array.isArray(value)) return { words: [], dropped: 1 };
  let previous = segmentStart;
  const output: WordTiming[] = [];
  let dropped = 0;
  for (const item of value) {
    if (!record(item)) {
      dropped += 1;
      continue;
    }
    const text = nonBlank(item.text);
    if (
      !text ||
      !integer(item.start_time) ||
      !integer(item.end_time) ||
      item.start_time < previous ||
      item.start_time < segmentStart ||
      item.end_time <= item.start_time ||
      item.end_time > segmentEnd
    ) {
      dropped += 1;
      continue;
    }
    output.push({
      word_id: `subtitle-word-${String(segmentIndex + 1).padStart(4, '0')}-${String(output.length + 1).padStart(4, '0')}`,
      index: output.length,
      start_ms: item.start_time,
      end_ms: item.end_time,
      text,
      confidence: null,
    });
    previous = item.end_time;
  }
  return { words: output, dropped };
}

function normalizeSegments(
  response: JsonRecord,
  audioDurationMs: number,
): {
  segments: [TranscriptSegment, ...TranscriptSegment[]];
  droppedWordTimings: number;
} {
  if (!Array.isArray(response.utterances) || response.utterances.length === 0)
    throw new Error('没有返回时间化字幕片段');
  let previous = 0;
  let droppedWordTimings = 0;
  const segments = response.utterances.map((item, index): TranscriptSegment => {
    if (!record(item)) throw new Error('字幕片段不是对象');
    const text = nonBlank(item.text);
    if (
      !text ||
      !integer(item.start_time) ||
      !integer(item.end_time) ||
      item.start_time < previous ||
      item.start_time < 0 ||
      item.end_time <= item.start_time ||
      item.end_time > audioDurationMs
    )
      throw new Error('字幕片段时间或文字无效');
    const normalizedWords = normalizeWords(
      item.words,
      index,
      item.start_time,
      item.end_time,
    );
    droppedWordTimings += normalizedWords.dropped;
    const segment: TranscriptSegment = {
      segment_id: `subtitle-segment-${String(index + 1).padStart(4, '0')}`,
      index,
      start_ms: item.start_time,
      end_ms: item.end_time,
      text,
      confidence: null,
      words: normalizedWords.words,
    };
    previous = segment.end_ms;
    return segment;
  });
  return {
    segments: segments as [TranscriptSegment, ...TranscriptSegment[]],
    droppedWordTimings,
  };
}

export class VolcengineSubtitleAsrAdapter implements AsrAdapter {
  readonly adapterId = 'volcengine_subtitle_asr' as const;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly dependencies: VolcengineSubtitleAsrDependencies) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.createId = dependencies.createId ?? randomUUID;
  }

  async run(input: AsrAdapterInput): Promise<AdapterExecutionResult<TranscriptRaw>> {
    const startedAt = this.now().toISOString();
    const callId = safeId(`call-${this.createId()}`);
    const configuredAppId = nonBlank((input.model.provider_config as unknown as JsonRecord).app_id);
    if (
      input.model.check_snapshot.outcome !== 'passed' ||
      !input.model.cloud_data_confirmation.confirmed ||
      !configuredAppId ||
      extname(input.audio.sourcePath).toLowerCase() !== '.mp3'
    )
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_CONFIGURATION_INVALID', '火山音视频字幕需要有效的 APP ID、Access Token 和 MP3 输入。', 'configuration', false, null, '在模型中心重新输入 APP ID 与 Access Token，再执行检查。');

    try {
      const source = await stat(input.audio.sourcePath);
      if (!source.isFile() || source.size === 0)
        throw new Error('任务音频不可用');
    } catch {
      return this.failure(input, callId, startedAt, 'ASR_INPUT_FILE_UNAVAILABLE', '任务中的 MP3 副本不可用。', 'media_decode', false, null, '重新创建任务。');
    }

    let credential: SubtitleCredential;
    try {
      credential = parseCredential(await this.dependencies.readCredential(input.model.credential_ref));
    } catch {
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_CREDENTIAL_INVALID', '无法读取火山音视频字幕 Access Token。', 'configuration', false, null, '在模型中心重新输入 APP ID 与 Access Token。');
    }

    const appId = configuredAppId;
    const authHeaders = { Authorization: `Bearer; ${credential.token}` };
    let audioBody: Buffer;
    try {
      audioBody = await readFile(input.audio.sourcePath);
    } catch {
      return this.failure(input, callId, startedAt, 'ASR_INPUT_FILE_UNAVAILABLE', '任务中的 MP3 副本不可用。', 'media_decode', false, null, '重新创建任务。');
    }
    try {
      await input.beforeProviderDispatch?.('volcengine_subtitle_submit');
      await this.dependencies.beforeProviderDispatch?.('volcengine_subtitle_submit');
    } catch {
      return this.failure(input, callId, startedAt, 'PROVIDER_DISPATCH_CHECKPOINT_FAILED', '无法在上传前保存 Provider 调用检查点。', 'artifact_write', false, null, '检查任务目录权限后显式恢复 Worker。', 'not_dispatched');
    }
    let submit: Response;
    try {
      const query = new URLSearchParams({
        appid: appId,
        language: 'zh-CN',
        caption_type: 'speech',
        use_itn: 'True',
        use_punc: 'True',
        max_lines: '1',
        words_per_line: '15',
      });
      submit = await this.fetch(`${VOLCENGINE_SUBTITLE_SUBMIT_ENDPOINT}?${query}`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'audio/mpeg', Accept: 'application/json' },
        body: audioBody as unknown as BodyInit,
      });
    } catch {
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_NETWORK_ERROR', '火山音视频字幕请求未获得 HTTP 响应，结果无法确认。', 'connectivity', false, null, '不要直接重试提交；先确认 Provider 侧是否已收到请求。', 'outcome_unknown');
    }
    const logId = nonBlank(submit.headers.get('X-Tt-Logid'));
    let submitted: unknown;
    try {
      submitted = await submit.json();
    } catch {
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_RESPONSE_PARSE_FAILED', `字幕提交响应不是合法 JSON${logId ? `（log id=${logId}）` : ''}。`, 'response_parse', false, logId, '保留 log id 并先确认提交状态，不要重新上传。', 'outcome_unknown');
    }
    if (!record(submitted))
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_RESPONSE_INVALID', '字幕提交响应格式无效，是否已创建 Provider 任务无法确认。', 'response_validation', false, logId, '先联系服务商确认提交状态，不要重新上传。', 'outcome_unknown');
    const submitCode = providerCode(submitted.code);
    const jobId = nonBlank(submitted.id);
    if (!submit.ok || submitCode !== '0' || !jobId) {
      const detail = userMessage(submitCode ?? `HTTP_${submit.status}`, nonBlank(submitted.message));
      const message = `${detail.message}${logId ? `（log id=${displayId(logId)}）` : ''}`;
      return this.failure(input, callId, startedAt, `VOLCENGINE_SUBTITLE_STATUS_${safeId(submitCode ?? String(submit.status))}`, message, 'model_call', detail.retryable, logId, detail.remediation);
    }

    try {
      await input.beforeProviderDispatch?.('volcengine_subtitle_query');
      await this.dependencies.beforeProviderDispatch?.('volcengine_subtitle_query');
    } catch {
      return this.failure(input, callId, startedAt, 'PROVIDER_QUERY_CHECKPOINT_FAILED', `任务已提交，但无法在查询前保存调用检查点（task id=${jobId}）。`, 'artifact_write', false, jobId, '保留 task id；修复本地任务目录后只读续查，绝不能重新提交音频。', 'outcome_unknown');
    }
    let queried: Response;
    try {
      const query = new URLSearchParams({ appid: appId, id: jobId, blocking: '1' });
      queried = await this.fetch(`${VOLCENGINE_SUBTITLE_QUERY_ENDPOINT}?${query}`, {
        method: 'GET',
        headers: { ...authHeaders, Accept: 'application/json' },
      });
    } catch {
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_QUERY_NETWORK_ERROR', `任务已提交，但查询未获得 HTTP 响应（task id=${jobId}）。`, 'connectivity', false, jobId, '保留 task id；只允许后续只读查询，绝不能重新提交音频。', 'outcome_unknown');
    }
    let result: unknown;
    try {
      result = await queried.json();
    } catch {
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_QUERY_PARSE_FAILED', `字幕查询响应不是合法 JSON（task id=${jobId}）。`, 'response_parse', false, jobId, '保留 task id；不要重新提交音频。', 'outcome_unknown');
    }
    if (!record(result))
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_QUERY_INVALID', `字幕查询响应格式无效（task id=${jobId}）。`, 'response_validation', false, jobId, '保留 task id；不要重新提交音频。', 'outcome_unknown');
    const code = providerCode(result.code);
    if (!queried.ok || code !== '0') {
      const detail = userMessage(code ?? `HTTP_${queried.status}`, nonBlank(result.message));
      return this.failure(input, callId, startedAt, `VOLCENGINE_SUBTITLE_STATUS_${safeId(code ?? String(queried.status))}`, `${detail.message}，task id=${jobId}`, 'model_call', detail.retryable, jobId, detail.remediation);
    }

    const rawResponseRef = 'work/provider-response.asr.redacted.json';
    try {
      const taskRoot = resolve(dirname(input.audio.sourcePath), '..');
      const target = resolve(taskRoot, rawResponseRef);
      const redacted = `${JSON.stringify(result, null, 2)}`
        .replaceAll(credential.token, '<redacted-access-token>')
        .replaceAll(appId, '<redacted-app-id>');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${redacted}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      return this.failure(input, callId, startedAt, 'ASR_RAW_RESPONSE_WRITE_FAILED', '无法保存脱敏的字幕服务响应。', 'artifact_write', false, jobId, '检查工作区权限后重试。');
    }

    let normalized: ReturnType<typeof normalizeSegments>;
    try {
      normalized = normalizeSegments(result, input.audio.durationMs);
    } catch (error) {
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_TIMING_INVALID', `字幕结果无法转换为合法时间轴：${error instanceof Error ? error.message : String(error)}（task id=${jobId}）。`, 'response_validation', false, jobId, '换用清晰的中文 MP3；持续失败时把 task id 提供给服务商。');
    }
    const { segments, droppedWordTimings } = normalized;
    const endedAt = this.now().toISOString();
    const call: CallRecord = {
      call_id: callId,
      model_snapshot_entry_ref: input.model.snapshot_entry_id,
      started_at: startedAt,
      ended_at: endedAt,
      provider_request_id: safeId(jobId),
      outcome: 'completed',
      error_ref: null,
    };
    const transcript: TranscriptRaw = {
      schema_version: '1.0.0',
      task_id: input.taskId,
      created_at: endedAt,
      audio: {
        path_ref: input.audio.pathRef,
        sha256: input.audio.sha256,
        duration_ms: input.audio.durationMs,
        language: 'zh-CN',
        mime_type: 'audio/mpeg',
      },
      full_text: segments.map((segment) => segment.text).join('\n'),
      segments,
      model_snapshot_ref: input.modelSnapshotRef,
      call,
      raw_response_ref: rawResponseRef,
      warnings: droppedWordTimings > 0
        ? [{
            warning_id: safeId(`warning-${this.createId()}`),
            code: 'VOLCENGINE_SUBTITLE_WORD_TIMING_DROPPED',
            message: `服务返回的 ${droppedWordTimings} 个词级时间项不符合 Mercury 时间约束，已忽略；分句文字和时间轴仍保留。`,
            stage: 'response_validation',
            severity: 'low',
          }]
        : [],
      errors: [],
    };
    if (!validateContract('transcript.raw', transcript).valid)
      return this.failure(input, callId, startedAt, 'VOLCENGINE_SUBTITLE_TRANSCRIPT_INVALID', '归一化字幕不符合 Mercury 时间化转录协议。', 'response_validation', false, jobId, '保留 task id 后联系 Mercury。');
    return { kind: 'artifact', artifact: transcript };
  }

  private failure(
    input: AsrAdapterInput,
    callId: string,
    startedAt: string,
    code: string,
    message: string,
    stage: ErrorRecord['stage'],
    retryable: boolean,
    providerRequestId: string | null,
    remediation: string,
    providerOutcomeCertainty: 'not_dispatched' | 'known_terminal' | 'outcome_unknown' = ['configuration', 'input_validation', 'media_decode', 'confirmation', 'capability'].includes(stage) ? 'not_dispatched' : 'known_terminal',
  ): AdapterExecutionResult<TranscriptRaw> {
    const errorId = safeId(`error-${this.createId()}`);
    const error: ErrorRecord = { error_id: errorId, code, message, stage, retryable, remediation };
    const call: CallRecord | null = providerOutcomeCertainty === 'not_dispatched' ? null : {
      call_id: callId,
      model_snapshot_entry_ref: input.model.snapshot_entry_id,
      started_at: startedAt,
      ended_at: this.now().toISOString(),
      ...(providerRequestId ? { provider_request_id: safeId(providerRequestId) } : {}),
      outcome: 'failed',
      error_ref: errorId,
    };
    const failure: AdapterFailureRecord = {
      failure_id: safeId(`failure-${this.createId()}`),
      task_id: input.taskId,
      role: 'asr',
      model_snapshot_ref: input.modelSnapshotRef,
      occurred_at: this.now().toISOString(),
      provider_outcome_certainty: providerOutcomeCertainty,
      errors: [error],
      warnings: [],
      call,
      staging: [],
    };
    return { kind: 'failure', failure };
  }
}
