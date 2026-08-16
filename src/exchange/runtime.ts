import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CalibrationResult, CalibrationResultV3, ExchangeEventV1, ExchangeRequestV1, ExchangeResultV1, ExchangeTaskV1, ExchangeTranscriptV1, ModelSnapshotEntryV2, TranscriptRaw } from '../contracts/index.js';
import type { TaskRecordV5 } from '../contracts/generated/task-record-v5.js';
import { assertExchangeContract, validateContract } from '../contracts/index.js';
import { assertV5TaskRecord } from '../contracts/v5.js';
import { MercuryError } from '../errors.js';
import { inspectTranscriptInput } from '../external-input.js';
import { loadModelRegistryV2, snapshotModelV2 } from '../models-v2.js';
import { readCredentialReference, readMp3DurationMs } from '../models.js';
import { CHAT_INLINE_AUDIO_LIMIT_BYTES, createChatCalibrationRuntimeV2, type ChatCalibrationV2Dependencies } from '../adapters/chat-calibration-v2.js';
import { parseReferenceSrt, runSubtitleCore, type CalibratedTranscript } from '../subtitle-core/index.js';
import { serializeCalibratedSrt, validateSrtFile } from '../output-report/srt.js';
import { createTaskId, safeAudioStem, sha256File } from '../tasks.js';
import { appendStableJsonLine, canonicalJson, readStableJson, writeStableJsonAtomic } from './storage.js';
import { ensureWorkspace } from '../workspace.js';
import { ensureRuntimeLayout, jsonFingerprint, readJob, readRequest, requestIdHash, reserveRequest, withRequestLease, withTaskTransitionLock, writeJob, writeRequest } from '../background/storage.js';
import { JOB_CONTRACT_VERSION, REQUEST_CONTRACT_VERSION, type BackgroundJobV1, type BackgroundRequestV1 } from '../background/types.js';

type ProviderCall = TaskRecordV5['execution']['provider_calls']['chat'];
const TASK_ID = /^tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/u;
const TERMINAL = new Set(['needs_input', 'completed', 'failed', 'cancelled', 'interrupted']);

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function taskRoot(workspace: string, directory: string): string {
  const root = path.resolve(workspace, 'tasks');
  const target = path.resolve(root, directory);
  if (!target.startsWith(`${root}${path.sep}`)) throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '任务路径越界。');
  return target;
}
function managed(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '任务内部路径越界。');
  return target;
}
async function regular(pathname: string, code = 'REQUEST_INVALID') {
  try {
    const entry = await lstat(pathname);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe');
    return entry;
  } catch {
    throw new MercuryError(code, `输入必须是可读取的普通文件：${pathname}`, { exitCode: 2 });
  }
}
async function copyVerified(source: string, destination: string, expected: string): Promise<number> {
  await regular(source);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
  if (await sha256File(destination) !== expected || await sha256File(source) !== expected) {
    throw new MercuryError('INPUT_COPY_MISMATCH', '输入在复制期间发生变化；任务未提交。', { exitCode: 2 });
  }
  return (await stat(destination)).size;
}

export async function readV5Task(directory: string): Promise<TaskRecordV5> {
  const root = path.resolve(directory);
  const parent = await lstat(path.dirname(root)).catch(() => null);
  const own = await lstat(root).catch(() => null);
  if (!parent?.isDirectory() || parent.isSymbolicLink() || !own?.isDirectory() || own.isSymbolicLink()) throw new MercuryError('TASK_PATH_UNSAFE', '任务目录不可安全读取。');
  const task = assertV5TaskRecord(await readStableJson(path.join(root, 'task.json'), 'TASK_RECORD_INVALID'));
  if (task.identity.task_directory !== path.basename(root) || !task.identity.task_directory.startsWith(`${task.identity.task_id}-`)) throw new MercuryError('TASK_RECORD_INVALID', 'v5 task identity 与目录不一致。');
  return task;
}

export async function persistV5Task(directory: string, task: TaskRecordV5): Promise<void> {
  const checked = assertV5TaskRecord(task);
  if (checked.identity.task_directory !== path.basename(path.resolve(directory))) throw new MercuryError('TASK_RECORD_INVALID', 'v5 task identity 与目录不一致。');
  await writeStableJsonAtomic(path.join(directory, 'task.json'), checked);
}

export async function isV5TaskDirectory(directory: string): Promise<boolean> {
  try {
    const raw = await readStableJson(path.join(directory, 'task.json'), 'TASK_RECORD_INVALID') as { schema_version?: unknown };
    return raw.schema_version === '5.0.0';
  } catch { return false; }
}

async function stableEvents(directory: string): Promise<ExchangeEventV1[]> {
  let source: string;
  try { source = await readFile(path.join(directory, 'events.jsonl'), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const lines = source.endsWith('\n') ? source.slice(0, -1).split('\n').filter(Boolean) : source.slice(0, source.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
  const events = lines.map((line, index) => {
    try { return assertExchangeContract('event', JSON.parse(line)); } catch { throw new MercuryError('EVENT_LOG_INVALID', `稳定事件日志第 ${index + 1} 行损坏。`); }
  });
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) throw new MercuryError('EVENT_LOG_INVALID', '稳定事件 sequence 不连续。');
  }
  return events;
}

export async function appendV5Event(directory: string, task: TaskRecordV5, type: string, message: string, data: Record<string, unknown> = {}): Promise<ExchangeEventV1> {
  const events = await stableEvents(directory);
  const sequence = (events.at(-1)?.sequence ?? 0) + 1;
  const event = assertExchangeContract('event', {
    contract: 'mercury.event/v1', event_id: `evt-${randomBytes(8).toString('hex')}`, task_id: task.identity.task_id,
    sequence, occurred_at: new Date().toISOString(), type, severity: type.includes('failed') || type.includes('interrupted') ? 'error' : 'info',
    task_revision: task.identity.revision + 1, attempt_id: task.execution.attempt_id, stage: task.stage, progress: null,
    message: message.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 500), data, extensions: {},
  });
  await appendStableJsonLine(path.join(directory, 'events.jsonl'), event);
  task.identity.revision += 1;
  task.updated_at = event.occurred_at;
  await persistV5Task(directory, task);
  return event;
}

function srtFromTranscript(transcript: ExchangeTranscriptV1): string {
  const stamp = (ms: number) => {
    const hours = Math.floor(ms / 3_600_000); const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000); const milli = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
  };
  return `${transcript.segments.map((segment, index) => `${index + 1}\n${stamp(segment.start_ms)} --> ${stamp(segment.end_ms)}\n${segment.text}\n`).join('\n')}\n`;
}

interface ModelSnapshotV3 {
  contract: 'mercury.model-snapshot/v3'; snapshot_id: string; task_id: string; captured_at: string;
  models: { asr: null; chat: ModelSnapshotEntryV2 }; evidence_mode: 'text' | 'audio_multimodal'; non_strong_reason: string | null;
}

function selectChat(registry: Awaited<ReturnType<typeof loadModelRegistryV2>>, taskId: string, explicit: string): ModelSnapshotEntryV2 {
  const model = registry.models.find((entry) => entry.model_id === explicit && entry.category === 'chat');
  if (!model) throw new MercuryError('MODEL_SELECTION_INVALID', `Chat 模型 ${explicit} 不存在或类别不匹配。`, { exitCode: 4 });
  if (!model.cloud_data_confirmation.confirmed || !['transcript', 'context'].every((kind) => model.cloud_data_confirmation.data_categories.includes(kind as any))) {
    throw new MercuryError('CLOUD_DATA_NOT_CONFIRMED', '所选 Chat 尚未确认本次转录与上下文发送。', { exitCode: 4 });
  }
  return snapshotModelV2(model, taskId);
}

function evidence(chat: ModelSnapshotEntryV2, mediaBytes: number | null): { mode: 'text' | 'audio_multimodal'; reason: string | null } {
  if (mediaBytes === null) return { mode: 'text', reason: 'audio_not_supported' };
  if (!chat.declared_capabilities.input_modalities.includes('audio')) return { mode: 'text', reason: 'audio_not_supported' };
  if (!chat.verified_capabilities.input_modalities.includes('audio')) return { mode: 'text', reason: 'audio_check_missing_or_stale' };
  if (!chat.cloud_data_confirmation.data_categories.includes('audio')) return { mode: 'text', reason: 'audio_data_confirmation_missing' };
  if (chat.plugin_id !== 'gemini' || !['vertex_ai', 'developer_api'].includes(chat.connection_type)) return { mode: 'text', reason: 'audio_inline_unsupported' };
  if (mediaBytes > CHAT_INLINE_AUDIO_LIMIT_BYTES) return { mode: 'text', reason: 'audio_input_limit_exceeded' };
  return { mode: 'audio_multimodal', reason: null };
}

function initialCall(outcome: ProviderCall['outcome'] = 'not_dispatched'): ProviderCall {
  return { state: 'not_started', count: 0, outcome, evidence_ref: null };
}

async function createTaskDirectory(workspace: string, request: ExchangeRequestV1, taskId: string, directoryName: string): Promise<TaskRecordV5> {
  if (request.transcription_mode !== 'provided' || request.inputs.transcript?.role !== 'transcript_source') {
    throw new MercuryError('CONTRACT_UNSUPPORTED', '0.3.0-alpha.1 的稳定 submit 先支持 provided transcript；provider/reference 请继续使用兼容 calibrate。', { exitCode: 5 });
  }
  const inspected = await inspectTranscriptInput({ filePath: request.inputs.transcript.path, format: request.inputs.transcript.format, role: 'transcript_source' });
  if (inspected.sha256 !== request.inputs.transcript.sha256) throw new MercuryError('INPUT_HASH_MISMATCH', '转录输入 hash 与 request 不一致。', { exitCode: 2 });
  let mediaBytes: number | null = null;
  let mediaDuration: number | null = null;
  if (request.inputs.media) {
    if (await sha256File(request.inputs.media.path) !== request.inputs.media.sha256) throw new MercuryError('INPUT_HASH_MISMATCH', '媒体输入 hash 与 request 不一致。', { exitCode: 2 });
    mediaBytes = (await regular(request.inputs.media.path)).size;
    mediaDuration = await readMp3DurationMs(request.inputs.media.path);
    if ((inspected.transcript.segments.at(-1)?.end_ms ?? 0) > mediaDuration + 1500) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '转录末尾超过媒体时长 1500ms 容忍范围。', { exitCode: 2 });
  }
  const registry = await loadModelRegistryV2(workspace);
  const chat = selectChat(registry, taskId, request.models.chat);
  const decision = evidence(chat, mediaBytes);
  const createdAt = request.created_at;
  const staging = path.join(workspace, 'tasks', `.${directoryName}.staging-${process.pid}-${randomBytes(4).toString('hex')}`);
  const final = taskRoot(workspace, directoryName);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const child of ['input', 'work', 'output']) await mkdir(path.join(staging, child), { mode: 0o700 });
    await writeStableJsonAtomic(path.join(staging, 'request.json'), request);
    const sourceExtension = request.inputs.transcript.format === 'transcript_json' ? 'json' : request.inputs.transcript.format;
    const transcriptRelative = `input/transcript-source.${sourceExtension}`;
    await copyVerified(request.inputs.transcript.path, path.join(staging, transcriptRelative), request.inputs.transcript.sha256);
    let media: TaskRecordV5['inputs']['media'] = null;
    if (request.inputs.media) {
      const relative = `input/media${path.extname(request.inputs.media.path).toLocaleLowerCase('en-US') || '.mp3'}`;
      const bytes = await copyVerified(request.inputs.media.path, path.join(staging, relative), request.inputs.media.sha256);
      media = { original_path: request.inputs.media.path, workspace_path: relative, sha256: request.inputs.media.sha256, bytes, mime_type: request.inputs.media.mime_type };
    }
    await writeStableJsonAtomic(path.join(staging, 'work/transcript.normalized.json'), inspected.transcript);
    const snapshot: ModelSnapshotV3 = { contract: 'mercury.model-snapshot/v3', snapshot_id: `${taskId}-models`, task_id: taskId, captured_at: createdAt, models: { asr: null, chat }, evidence_mode: decision.mode, non_strong_reason: decision.reason };
    await writeStableJsonAtomic(path.join(staging, 'work/model-snapshot.json'), snapshot);
    const dictionarySnapshot = { contract: 'mercury.dictionary-snapshot/v1', task_id: taskId, created_at: createdAt, resolved: [], entries: [], conflicts: [], extensions: {} };
    await writeStableJsonAtomic(path.join(staging, 'work/dictionary-snapshot.json'), dictionarySnapshot);
    const stem = safeAudioStem(path.basename(request.inputs.media?.path ?? request.inputs.transcript.path).replace(/\.(?:srt|vtt|json)$/iu, '')) || 'subtitle';
    const transcribedRelative = `output/${stem}.transcribed.srt`;
    const handle = await open(path.join(staging, transcribedRelative), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(srtFromTranscript(inspected.transcript), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    const fingerprint = jsonFingerprint(JSON.parse(canonicalJson(request)));
    const task = assertV5TaskRecord({
      schema_version: '5.0.0', identity: { task_id: taskId, request_id: request.request_id, request_fingerprint: fingerprint, task_directory: directoryName, revision: 0 },
      created_at: createdAt, updated_at: createdAt, status: 'queued', stage: null,
      input_config: { transcription_mode: 'provided', calibration_mode: request.calibration.mode, source_language: request.calibration.source_language, evidence_mode: decision.mode },
      inputs: {
        media,
        transcript_source: { original_path: request.inputs.transcript.path, workspace_path: transcriptRelative, sha256: request.inputs.transcript.sha256, bytes: inspected.bytes, mime_type: request.inputs.transcript.format === 'srt' ? 'application/x-subrip' : request.inputs.transcript.format === 'vtt' ? 'text/vtt' : 'application/json', format: request.inputs.transcript.format, role: 'transcript_source' },
        reference: null,
      },
      models: { asr: null, chat: request.models.chat, snapshot_path: 'work/model-snapshot.json', snapshot_sha256: await sha256File(path.join(staging, 'work/model-snapshot.json')) },
      dictionary_snapshot: { path: 'work/dictionary-snapshot.json', sha256: await sha256File(path.join(staging, 'work/dictionary-snapshot.json')), resolved: [] },
      execution: { queued_at: createdAt, started_at: null, ended_at: null, worker_id: null, heartbeat_at: null, attempt_id: null, attempt_count: 0, safe_checkpoint: 'queued', provider_calls: { asr: initialCall(), chat: initialCall() }, cancel_requested_at: null },
      artifacts: {
        transcript: { path: 'work/transcript.normalized.json', sha256: await sha256File(path.join(staging, 'work/transcript.normalized.json')), validation: 'passed' },
        transcribed: { path: transcribedRelative, sha256: await sha256File(path.join(staging, transcribedRelative)), validation: 'passed' }, calibrated: null, approved: null, report: null,
      }, review: { status: 'not_ready', pending_count: null }, warnings: [...inspected.warnings, ...(decision.reason ? [`Chat 使用 text-only：${decision.reason}`] : [])], error: null,
    });
    await writeStableJsonAtomic(path.join(staging, 'task.json'), task);
    await rename(staging, final);
    await chmod(final, 0o700);
    return task;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function submitExchangeRequest(workspaceInput: string, raw: unknown): Promise<{ task: TaskRecordV5; replayed: boolean }> {
  const workspace = await ensureWorkspace(workspaceInput);
  await ensureRuntimeLayout(workspace);
  const request = assertExchangeContract('request', raw);
  const requestHash = requestIdHash(request.request_id);
  const fingerprint = jsonFingerprint(JSON.parse(canonicalJson(request)));
  const taskId = createTaskId(new Date(request.created_at), () => digest(`${request.request_id}\n${fingerprint}`).slice(0, 8));
  const stem = safeAudioStem(path.basename(request.inputs.media?.path ?? request.inputs.transcript?.path ?? 'external'));
  const directoryName = `${taskId}-${stem}`;
  return withRequestLease(workspace, requestHash, async (lease) => {
    const reservation: BackgroundRequestV1 = {
      contract_version: REQUEST_CONTRACT_VERSION, request_id_hash: requestHash, input_fingerprint: fingerprint, task_id: taskId,
      task_directory: directoryName, state: 'reserved', owner: { owner_token: lease.record.owner_token, pid: lease.record.pid, process_started_at_ms: lease.record.process_started_at_ms, lease_acquired_at: lease.record.acquired_at },
      created_at: request.created_at, updated_at: new Date().toISOString(),
    };
    const reserved = await reserveRequest(workspace, reservation);
    if (reserved.record.input_fingerprint !== fingerprint) throw new MercuryError('REQUEST_ID_CONFLICT', '同一 request ID 已绑定到不同请求；原任务未改变。', { exitCode: 3 });
    if (reserved.record.state === 'committed') {
      const task = await readV5Task(taskRoot(workspace, reserved.record.task_directory!));
      return { task, replayed: true };
    }
    await writeRequest(workspace, { ...reserved.record, owner: reservation.owner, updated_at: new Date().toISOString() });
    let task: TaskRecordV5;
    try { task = await readV5Task(taskRoot(workspace, directoryName)); }
    catch (error) {
      if (error instanceof MercuryError && !['TASK_RECORD_INVALID', 'TASK_PATH_UNSAFE'].includes(error.code)) throw error;
      task = await createTaskDirectory(workspace, request, taskId, directoryName);
    }
    const directory = taskRoot(workspace, directoryName);
    if ((await stableEvents(directory)).length === 0) await appendV5Event(directory, task, 'task_queued', '任务已持久化并加入本地后台队列。', { transcription_mode: 'provided', asr_call_count: 0 });
    const job: BackgroundJobV1 = { contract_version: JOB_CONTRACT_VERSION, task_id: taskId, task_directory: directoryName, state: 'queued', created_at: request.created_at, updated_at: new Date().toISOString(), claim_token: null, worker_id: null };
    try {
      const existing = await readJob(workspace, taskId);
      if (existing.task_directory !== directoryName) throw new MercuryError('JOB_RECORD_INVALID', '后台 job 与 v5 task identity 不一致。');
    } catch (error) {
      if (!(error instanceof MercuryError) || error.code !== 'JOB_RECORD_INVALID') throw error;
      await writeJob(workspace, job);
    }
    await writeRequest(workspace, { ...reservation, state: 'committed', owner: null, updated_at: new Date().toISOString() });
    return { task: await readV5Task(directory), replayed: false };
  });
}

function legacyTranscript(task: TaskRecordV5, transcript: ExchangeTranscriptV1, snapshot: ModelSnapshotV3): TranscriptRaw {
  const media = task.inputs.media;
  const duration = transcript.duration_ms ?? transcript.segments.at(-1)!.end_ms;
  return {
    schema_version: '1.0.0', task_id: task.identity.task_id, created_at: transcript.created_at,
    audio: { path_ref: media?.workspace_path ?? task.inputs.transcript_source!.workspace_path, sha256: media?.sha256 ?? task.inputs.transcript_source!.sha256, duration_ms: duration, mime_type: 'audio/mpeg', language: 'zh-CN' },
    full_text: transcript.text,
    segments: transcript.segments.map((segment, index) => ({ segment_id: segment.segment_id, index, start_ms: segment.start_ms, end_ms: segment.end_ms, text: segment.text, confidence: null, words: segment.words.map((word, wordIndex) => ({ word_id: `${segment.segment_id}-word-${wordIndex + 1}`, index: wordIndex, text: word.text, start_ms: word.start_ms, end_ms: word.end_ms, confidence: word.confidence })) })),
    model_snapshot_ref: snapshot.snapshot_id,
    call: { call_id: `${task.identity.task_id}-provided`, model_snapshot_entry_ref: 'provided-transcript', started_at: transcript.created_at, ended_at: transcript.created_at, outcome: 'completed', error_ref: null },
    raw_response_ref: null, warnings: [], errors: [],
  } as unknown as TranscriptRaw;
}

function preflight(task: TaskRecordV5, transcript: TranscriptRaw, snapshot: ModelSnapshotV3, normalizedSrt: string) {
  const at = new Date().toISOString();
  const calibration = { schema_version: '1.0.0', task_id: task.identity.task_id, created_at: at, status: 'completed', request: { transcript_ref: 'work/transcript.raw.json', reference_srt_ref: 'input/reference.srt', mode: task.input_config.calibration_mode }, model_snapshot_ref: snapshot.snapshot_id, call: { call_id: 'preflight', model_snapshot_entry_ref: snapshot.models.chat.snapshot_entry_id, started_at: at, ended_at: at, outcome: 'completed', error_ref: null }, suggestions: [], warnings: [], errors: [] } as unknown as CalibrationResult;
  const checked = validateContract('calibration-result', calibration);
  if (!checked.valid) throw new MercuryError('UPSTREAM_CALIBRATION_INVALID', checked.issues.map((issue) => `${issue.path} ${issue.message}`).join('; '));
  return runSubtitleCore({
    transcript,
    calibrationResult: checked.value,
    referenceSrtText: normalizedSrt, requestedMode: task.input_config.calibration_mode,
  });
}

function toLegacy(value: CalibrationResultV3): CalibrationResult {
  return {
    schema_version: '1.0.0', task_id: value.task_id, created_at: value.created_at, status: value.status,
    request: { transcript_ref: 'work/transcript.raw.json', reference_srt_ref: value.request.reference_srt_ref, mode: value.request.mode },
    model_snapshot_ref: value.model_snapshot_ref, call: value.call,
    suggestions: value.suggestions.filter((item) => item.kind !== 'uncertain' && item.suggested_text !== null).map((item) => ({ suggestion_id: item.suggestion_id, kind: item.kind as 'text_correction' | 'segmentation' | 'timing', source_segment_refs: item.source_segment_refs, start_ms: item.start_ms, end_ms: item.end_ms, original_text: item.original_text, suggested_text: item.suggested_text!, rationale: item.rationale, confidence: item.confidence, disposition: 'not_applied', disposition_reason: 'insufficient_evidence' })),
    warnings: value.warnings, errors: value.errors,
  } as unknown as CalibrationResult;
}

function exchangeError(code: string, message: string, providerOutcome: 'not_dispatched' | 'known_terminal' | 'response_persisted' | 'outcome_unknown' | 'not_applicable', detail: string | null = null): TaskRecordV5['error'] {
  return { contract: 'mercury.error/v1', code, category: providerOutcome === 'not_applicable' ? 'runtime' : 'provider', message: message.replace(/\s*(?:Provider detail|provider detail)=.*$/iu, '').trim(), retryability: providerOutcome === 'outcome_unknown' ? 'unsafe' : 'after_user_action', provider_outcome: providerOutcome, remediation: [providerOutcome === 'outcome_unknown' ? '不要自动重试；请查看技术证据后由用户决定。' : '检查模型配置后使用新的 request ID 创建任务。'], technical: detail ? { provider_code: null, log_id: null, detail: detail.slice(0, 2000) } : null, extensions: {} };
}

async function writeReport(directory: string, task: TaskRecordV5, snapshot: ModelSnapshotV3, calibration: CalibrationResultV3 | null): Promise<void> {
  const text = ['# Mercury 字幕校准工作报告', '', `- 任务 ID：\`${task.identity.task_id}\``, '- 转写来源：外部提供（ASR 调用数：0）', `- 外部格式：${task.inputs.transcript_source?.format ?? '—'}`, `- 原件 SHA-256：${task.inputs.transcript_source?.sha256 ?? '—'}`, `- 规范化 SHA-256：${task.artifacts.transcript?.sha256 ?? '—'}`, `- Chat：${snapshot.models.chat.name} / ${snapshot.models.chat.provider_model}`, `- 校验证据：${task.input_config.evidence_mode === 'audio_multimodal' ? '完整转录 + 音频' : '完整转录'}`, `- Chat 调用：${task.execution.provider_calls.chat.count}`, `- 完整覆盖：${calibration ? `${calibration.strategy.input_unit_count}/${calibration.strategy.returned_unit_count} ${calibration.strategy.coverage_complete ? '通过' : '失败'}` : '未形成'}`, `- 词典快照：${task.dictionary_snapshot.sha256}`, `- 警告：${task.warnings.join('；') || '无'}`, `- 错误：${task.error ? `${task.error.code}：${task.error.message}` : '无'}`, ''].join('\n');
  await writeFile0600(path.join(directory, 'output/calibration-report.md'), text);
  task.artifacts.report = { path: 'output/calibration-report.md', sha256: await sha256File(path.join(directory, 'output/calibration-report.md')), validation: 'passed' };
}

async function writeFile0600(target: string, content: string): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, target);
  await chmod(target, 0o600);
}

export async function executeV5Task(directory: string, dependencies: ChatCalibrationV2Dependencies = {}): Promise<TaskRecordV5> {
  let task = await readV5Task(directory);
  if (task.status !== 'running') throw new MercuryError('TASK_EXECUTION_STATE_INVALID', `v5 任务状态不能执行：${task.status}`);
  const snapshot = await readStableJson(managed(directory, task.models.snapshot_path), 'MODEL_SNAPSHOT_INVALID') as ModelSnapshotV3;
  const transcript = assertExchangeContract('transcript', await readStableJson(managed(directory, task.artifacts.transcript!.path), 'TRANSCRIPT_IMPORT_INVALID'));
  const legacy = legacyTranscript(task, transcript, snapshot);
  let calibration: CalibrationResultV3 | null = null;
  const existing = task.execution.provider_calls.chat.evidence_ref;
  try {
    const normalizedSrt = srtFromTranscript(transcript);
    const initial = preflight(task, legacy, snapshot, normalizedSrt);
    if (initial.status !== 'completed' || initial.alignment === null) throw new MercuryError(initial.issues[0]?.code ?? 'ALIGNMENT_FAILED', initial.issues[0]?.message ?? '外部转录无法形成合法校验单元。');
    await writeStableJsonAtomic(path.join(directory, 'work/alignment.json'), initial.alignment);
    task.stage = 'calibrating'; task.execution.safe_checkpoint = 'chat_not_started'; task.updated_at = new Date().toISOString(); await persistV5Task(directory, task);
    if (task.execution.cancel_requested_at) return cancelV5AtBoundary(directory, task);
    if (existing && ['response_persisted', 'terminal'].includes(task.execution.provider_calls.chat.state)) {
      calibration = JSON.parse(await readFile(managed(directory, existing), 'utf8')) as CalibrationResultV3;
    } else {
      const runtime = createChatCalibrationRuntimeV2(snapshot.models.chat, { ...dependencies, readCredential: dependencies.readCredential ?? readCredentialReference });
      const media = task.inputs.media;
      const result = await runtime.run({
        taskId: task.identity.task_id, modelSnapshotRef: snapshot.snapshot_id, model: snapshot.models.chat, transcript: legacy, alignment: initial.alignment,
        referenceSrt: { pathRef: 'input/reference.srt', text: normalizedSrt }, mode: task.input_config.calibration_mode, evidenceMode: task.input_config.evidence_mode,
        nonStrongReason: (snapshot.non_strong_reason as any) ?? null,
        audio: task.input_config.evidence_mode === 'audio_multimodal' && media ? { sourcePath: managed(directory, media.workspace_path), pathRef: media.workspace_path, sha256: media.sha256, bytes: media.bytes, durationMs: await readMp3DurationMs(managed(directory, media.workspace_path)), mimeType: 'audio/mpeg' } : null,
        beforeProviderDispatch: async () => {
          task = await readV5Task(directory);
          if (task.execution.cancel_requested_at) throw new MercuryError('TASK_CANCELLED', '任务已请求取消，未调用 Chat。');
          task.execution.provider_calls.chat = { state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null };
          task.updated_at = new Date().toISOString(); await persistV5Task(directory, task);
          await appendV5Event(directory, task, 'provider_dispatched', 'Chat 校验请求已发送；ASR 调用数仍为 0。', { capability: 'calibration', count: 1 });
        },
      });
      if (result.kind === 'failure') {
        task = await readV5Task(directory);
        const reportedCertainty = result.failure.provider_outcome_certainty ?? (result.failure.call ? 'known_terminal' : 'not_dispatched');
        const certainty = task.execution.provider_calls.chat.state === 'in_flight' ? 'outcome_unknown' : reportedCertainty;
        task.execution.provider_calls.chat = { state: certainty === 'outcome_unknown' ? 'in_flight' : 'terminal', count: task.execution.provider_calls.chat.count, outcome: certainty, evidence_ref: null };
        task.status = certainty === 'outcome_unknown' ? 'interrupted' : 'failed'; task.stage = null; task.execution.ended_at = new Date().toISOString();
        task.error = exchangeError(certainty === 'outcome_unknown' ? 'TASK_INTERRUPTED_PROVIDER_UNKNOWN' : result.failure.errors[0]!.code, result.failure.errors[0]!.message, certainty, result.failure.errors[0]!.message);
        await writeReport(directory, task, snapshot, null); await persistV5Task(directory, task); return task;
      }
      calibration = result.artifact;
      await writeStableJsonAtomic(path.join(directory, 'work/calibration-result.json'), calibration);
      task = await readV5Task(directory);
      task.execution.provider_calls.chat = { state: 'response_persisted', count: 1, outcome: 'response_persisted', evidence_ref: 'work/calibration-result.json' };
      task.execution.safe_checkpoint = 'chat_response_persisted'; await persistV5Task(directory, task);
    }
    if (task.execution.cancel_requested_at) return cancelV5AtBoundary(directory, task);
    if (!calibration || calibration.status !== 'completed') throw new MercuryError('CALIBRATION_RESULT_INVALID', 'Chat 未形成完整可用的校验正文。');
    const subtitle = runSubtitleCore({ transcript: legacy, calibrationResult: toLegacy(calibration), referenceSrtText: normalizedSrt, requestedMode: task.input_config.calibration_mode });
    if (subtitle.status !== 'completed') throw new MercuryError(subtitle.issues[0]?.code ?? 'SUBTITLE_CORE_FAILED', subtitle.issues[0]?.message ?? '字幕规则应用失败。');
    const stem = path.basename(task.artifacts.transcribed!.path).replace(/\.transcribed\.srt$/u, '');
    const calibratedRelative = `output/${stem}.calibrated.srt`;
    await writeFile0600(path.join(directory, calibratedRelative), serializeCalibratedSrt(subtitle.artifact));
    const audioDuration = task.inputs.media ? await readMp3DurationMs(managed(directory, task.inputs.media.workspace_path)) : (transcript.duration_ms ?? transcript.segments.at(-1)!.end_ms);
    const parsedBaseline = parseReferenceSrt(normalizedSrt);
    const validation = await validateSrtFile(path.join(directory, calibratedRelative), { audioDurationMs: audioDuration, expectedSegments: subtitle.artifact.segments, mode: subtitle.artifact.mode, referenceSegments: parsedBaseline.ok ? parsedBaseline.segments : null });
    if (!validation.valid) throw new MercuryError('OUTPUT_VALIDATION_FAILED', validation.checks.filter((item) => item.status === 'failed').map((item) => item.message).join('; '));
    task = await readV5Task(directory);
    task.artifacts.calibrated = { path: calibratedRelative, sha256: await sha256File(path.join(directory, calibratedRelative)), validation: 'passed' };
    task.status = 'completed'; task.stage = null; task.execution.ended_at = new Date().toISOString(); task.execution.safe_checkpoint = 'outputs_validated';
    task.execution.provider_calls.chat = { state: 'terminal', count: Math.max(1, task.execution.provider_calls.chat.count), outcome: 'response_persisted', evidence_ref: 'work/calibration-result.json' };
    task.error = null; task.review = { status: 'pending', pending_count: calibration.corrected_units.filter((unit) => unit.changed).length };
    await writeReport(directory, task, snapshot, calibration); await persistV5Task(directory, task); await writeV5Result(directory, task); return task;
  } catch (error) {
    task = await readV5Task(directory);
    if (TERMINAL.has(task.status)) return task;
    if (task.execution.provider_calls.chat.state === 'in_flight') {
      task.status = 'interrupted'; task.error = exchangeError('TASK_INTERRUPTED_PROVIDER_UNKNOWN', 'Chat 请求已发送，但结果无法确认。', 'outcome_unknown', error instanceof Error ? error.message : String(error));
    } else {
      task.status = 'failed'; task.error = exchangeError(error instanceof MercuryError ? error.code : 'TASK_PIPELINE_FAILED', error instanceof Error ? error.message : '本地处理失败。', task.execution.provider_calls.chat.outcome);
    }
    task.stage = null; task.execution.ended_at = new Date().toISOString(); await writeReport(directory, task, snapshot, calibration); await persistV5Task(directory, task); await writeV5Result(directory, task); return task;
  }
}

async function cancelV5AtBoundary(directory: string, task: TaskRecordV5): Promise<TaskRecordV5> {
  task.status = 'cancelled'; task.stage = null; task.execution.ended_at = new Date().toISOString(); task.artifacts.calibrated = null; task.artifacts.approved = null;
  await rm(path.join(directory, 'output', path.basename(task.artifacts.transcribed!.path).replace('.transcribed.srt', '.calibrated.srt')), { force: true });
  await persistV5Task(directory, task); await writeV5Result(directory, task); return task;
}

function artifact(root: string, identity: ExchangeTaskV1['artifacts'][number]['identity'], value: TaskRecordV5['artifacts']['transcript']): ExchangeTaskV1['artifacts'][number] {
  return { identity, exists: value !== null, path: value ? managed(root, value.path) : null, sha256: value?.sha256 ?? null, validation: value?.validation ?? 'unavailable' };
}

export async function projectV5Task(directory: string, input?: TaskRecordV5): Promise<ExchangeTaskV1> {
  const task = input ?? await readV5Task(directory);
  return assertExchangeContract('task', {
    contract: 'mercury.task/v1', task_id: task.identity.task_id, request_id: task.identity.request_id, revision: task.identity.revision, created_at: task.created_at, updated_at: task.updated_at,
    status: task.status, stage: task.stage, progress: null,
    worker: { status: task.status === 'running' ? 'active' : 'inactive', heartbeat_at: task.execution.heartbeat_at },
    pause: { allowed: false, reason: '0.3.0-alpha.1 尚未提供暂停。' }, cancel: { allowed: ['queued', 'running'].includes(task.status), reason: ['queued', 'running'].includes(task.status) ? null : '当前状态不能取消。' }, retry: { allowed: false, reason: '0.3.0-alpha.1 尚未提供安全重试。' },
    attempt: { attempt_id: task.execution.attempt_id, count: task.execution.attempt_count },
    artifacts: [artifact(directory, 'transcript', task.artifacts.transcript), artifact(directory, 'transcribed_srt', task.artifacts.transcribed), artifact(directory, 'calibrated_srt', task.artifacts.calibrated), artifact(directory, 'approved_srt', task.artifacts.approved), artifact(directory, 'calibration_report', task.artifacts.report)],
    review: task.review, error: task.error,
    next_action: task.status === 'queued' ? '任务已入队；查询不会启动 Worker。若 Worker 未运行，请显式执行 worker start。' : task.status === 'running' ? '任务正在后台处理，请稍后查询。' : task.status === 'completed' ? '校验后字幕已生成，可以开始人工审阅。' : task.status === 'interrupted' ? 'Provider 结果不确定；不要自动重试。' : task.status === 'cancelled' ? '任务已取消；纯转写字幕仍可使用。' : '按错误提示检查输入或模型配置。',
    source_schema_version: '5.0.0', capabilities: { pause: { supported: false, reason: 'Alpha.2 capability' }, resume: { supported: false, reason: 'Alpha.2 capability' }, retry: { supported: false, reason: 'Alpha.2 capability' }, review: { supported: true, reason: null }, dictionary_snapshot: { supported: true, reason: null }, provided_transcript: { supported: true, reason: null } }, extensions: {},
  });
}

export async function projectV5Result(directory: string, taskInput?: TaskRecordV5): Promise<ExchangeResultV1> {
  const task = taskInput ?? await readV5Task(directory);
  const view = await projectV5Task(directory, task);
  return assertExchangeContract('result', {
    contract: 'mercury.result/v1', task_id: task.identity.task_id, status: task.status, attempt_id: task.execution.attempt_id, produced_at: task.updated_at,
    inputs: [task.inputs.media ? { kind: 'media', sha256: task.inputs.media.sha256, source: 'provided' } : null, { kind: 'transcript', sha256: task.inputs.transcript_source!.sha256, source: 'provided' }].filter(Boolean),
    transcription: { mode: 'provided', asr_call_count: 0, transcript_path: managed(directory, task.artifacts.transcript!.path), transcript_sha256: task.artifacts.transcript!.sha256 },
    dictionaries: { snapshots: task.dictionary_snapshot.resolved, conflict_count: 0, match_count: 0 }, artifacts: view.artifacts,
    review: { status: task.review.status, pending_count: task.review.pending_count, approved: ['finalized', 'not_required'].includes(task.review.status) },
    calls: [{ provider: 'asr', capability: 'transcription', count: 0, outcome: 'not_dispatched' }, { provider: task.models.chat, capability: 'calibration', count: task.execution.provider_calls.chat.count, outcome: task.execution.provider_calls.chat.outcome }],
    warnings: task.warnings, error: task.error, next_action: view.next_action, extensions: {},
  });
}

export async function writeV5Result(directory: string, task: TaskRecordV5): Promise<void> { await writeStableJsonAtomic(path.join(directory, 'result.json'), await projectV5Result(directory, task)); }

export async function claimV5Job(workspace: string, job: BackgroundJobV1, workerId: string): Promise<TaskRecordV5 | null> {
  const directory = taskRoot(workspace, job.task_directory);
  return withTaskTransitionLock(directory, async () => {
    const currentJob = await readJob(workspace, job.task_id); const task = await readV5Task(directory);
    if (task.status !== 'queued' || currentJob.state !== 'queued' || task.execution.cancel_requested_at) return null;
    const at = new Date().toISOString(); task.status = 'running'; task.stage = 'preparing'; task.execution.started_at = at; task.execution.worker_id = workerId; task.execution.heartbeat_at = at; task.execution.attempt_id = `att-${randomBytes(8).toString('hex')}`; task.execution.attempt_count += 1; task.execution.safe_checkpoint = 'claimed';
    await persistV5Task(directory, task); currentJob.state = 'claimed'; currentJob.worker_id = workerId; currentJob.claim_token = randomBytes(16).toString('hex'); currentJob.updated_at = at; await writeJob(workspace, currentJob);
    await appendStableJsonLine(path.join(directory, 'attempts.jsonl'), { contract: 'mercury.attempt/v1', task_id: task.identity.task_id, attempt_id: task.execution.attempt_id, number: task.execution.attempt_count, started_at: at, transcription_mode: 'provided', asr_call_count: 0 });
    await appendV5Event(directory, task, 'worker_claimed', '后台 Worker 已开始处理外部转录任务。', { attempt: task.execution.attempt_count }); return task;
  });
}

export async function finishV5Job(workspace: string, task: TaskRecordV5): Promise<void> {
  const directory = taskRoot(workspace, task.identity.task_directory);
  await withTaskTransitionLock(directory, async () => { const current = await readV5Task(directory); if (!TERMINAL.has(current.status)) throw new MercuryError('JOB_TASK_STATE_CONFLICT', 'v5 任务尚未终结。'); const job = await readJob(workspace, current.identity.task_id); job.state = 'terminal'; job.updated_at = new Date().toISOString(); await writeJob(workspace, job); });
}

export async function cancelV5Task(workspace: string, task: TaskRecordV5): Promise<{ task: TaskRecordV5; pending: boolean }> {
  const directory = taskRoot(workspace, task.identity.task_directory);
  return withTaskTransitionLock(directory, async () => {
    const current = await readV5Task(directory); if (TERMINAL.has(current.status)) return { task: current, pending: false };
    current.execution.cancel_requested_at ??= new Date().toISOString();
    if (current.status === 'queued') { const cancelled = await cancelV5AtBoundary(directory, current); const job = await readJob(workspace, current.identity.task_id); job.state = 'terminal'; job.updated_at = new Date().toISOString(); await writeJob(workspace, job); return { task: cancelled, pending: false }; }
    await persistV5Task(directory, current); return { task: current, pending: true };
  });
}

export async function readV5Events(directory: string, after = 0): Promise<ExchangeEventV1[]> { const task = await readV5Task(directory); return (await stableEvents(directory)).filter((event) => event.task_id === task.identity.task_id && event.sequence > after); }

export async function auditV5Job(workspace: string, listed: BackgroundJobV1): Promise<void> {
  const directory = taskRoot(workspace, listed.task_directory);
  await withTaskTransitionLock(directory, async () => {
    const task = await readV5Task(directory); const job = await readJob(workspace, listed.task_id);
    if (TERMINAL.has(task.status)) { if (job.state !== 'terminal') { job.state = 'terminal'; job.updated_at = new Date().toISOString(); await writeJob(workspace, job); } return; }
    if (task.status === 'queued' && job.state === 'queued') return;
    const call = task.execution.provider_calls.chat;
    if (call.state === 'in_flight') {
      task.status = 'interrupted'; task.stage = null; task.execution.ended_at = new Date().toISOString(); task.error = exchangeError('TASK_INTERRUPTED_PROVIDER_UNKNOWN', 'Worker 中断时 Chat 结果无法确认。', 'outcome_unknown'); job.state = 'terminal';
    } else {
      task.status = 'queued'; task.stage = null; task.execution.started_at = null; task.execution.worker_id = null; task.execution.heartbeat_at = null; task.execution.attempt_id = null; task.execution.safe_checkpoint = call.state === 'response_persisted' ? 'chat_response_persisted' : 'queued'; job.state = 'queued'; job.worker_id = null; job.claim_token = null;
    }
    task.updated_at = new Date().toISOString(); job.updated_at = task.updated_at; await persistV5Task(directory, task); await writeJob(workspace, job);
  });
}

export async function heartbeatV5Task(workspace: string, taskId: string, workerId: string, at: string): Promise<void> {
  const job = await readJob(workspace, taskId); const directory = taskRoot(workspace, job.task_directory);
  await withTaskTransitionLock(directory, async () => { const task = await readV5Task(directory); if (task.status === 'running' && task.execution.worker_id === workerId) { task.execution.heartbeat_at = at; task.updated_at = at; await persistV5Task(directory, task); } });
}

export async function containV5Failure(workspace: string, listed: BackgroundJobV1, error: unknown): Promise<'terminal' | 'requeued'> {
  const directory = taskRoot(workspace, listed.task_directory);
  return withTaskTransitionLock(directory, async () => {
    const task = await readV5Task(directory); const job = await readJob(workspace, listed.task_id);
    if (TERMINAL.has(task.status)) { job.state = 'terminal'; job.updated_at = new Date().toISOString(); await writeJob(workspace, job); return 'terminal'; }
    const call = task.execution.provider_calls.chat;
    if (call.state === 'in_flight') { task.status = 'interrupted'; task.error = exchangeError('TASK_INTERRUPTED_PROVIDER_UNKNOWN', '后台执行异常时 Chat 结果无法确认。', 'outcome_unknown'); job.state = 'terminal'; }
    else if (call.state === 'response_persisted') { task.status = 'queued'; task.stage = null; task.execution.started_at = null; task.execution.worker_id = null; task.execution.heartbeat_at = null; task.execution.attempt_id = null; job.state = 'queued'; job.worker_id = null; job.claim_token = null; }
    else { task.status = 'failed'; task.error = exchangeError(error instanceof MercuryError ? error.code : 'WORKER_JOB_FAILED_BEFORE_PROVIDER', '后台任务在 Provider 调用前遇到内部错误；未自动重试。', 'not_dispatched'); job.state = 'terminal'; }
    task.stage = null; if (task.status !== 'queued') task.execution.ended_at = new Date().toISOString(); task.updated_at = new Date().toISOString(); job.updated_at = task.updated_at; await persistV5Task(directory, task); await writeJob(workspace, job); await writeV5Result(directory, task); return task.status === 'queued' ? 'requeued' : 'terminal';
  });
}
