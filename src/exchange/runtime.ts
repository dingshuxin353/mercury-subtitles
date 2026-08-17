import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AsrAdapter, AsrHintsCapableAdapter, AsrHintsDispatchEvidence, CalibrationResult, CalibrationResultV3, ExchangeEventV1, ExchangeRequestV1, ExchangeResultV1, ExchangeTaskV1, ExchangeTranscriptV1, ModelSnapshotEntryV2, TranscriptRaw } from '../contracts/index.js';
import type { TaskRecordV5 } from '../contracts/generated/task-record-v5.js';
import { assertExchangeContract, validateContract, validateV3CalibrationResult } from '../contracts/index.js';
import { assertV5TaskRecord } from '../contracts/v5.js';
import { MercuryError } from '../errors.js';
import { inspectTranscriptInput, serializeTranscriptSrt } from '../external-input.js';
import { loadModelRegistryV2, snapshotModelV2 } from '../models-v2.js';
import { readCredentialReference, readMp3DurationMs, readMp3DurationMsFromBytes, resolveVolcengineCredentialReference } from '../models.js';
import { CHAT_INLINE_AUDIO_LIMIT_BYTES, createChatCalibrationRuntimeV2, type ChatCalibrationRuntimeV2, type ChatCalibrationV2Dependencies } from '../adapters/chat-calibration-v2.js';
import { VolcengineAsrAdapter, type ResolvedVolcengineCredential } from '../adapters/volcengine-asr.js';
import { VolcengineSubtitleAsrAdapter } from '../adapters/volcengine-subtitle-asr.js';
import { legacyAsrEntry } from '../core-integration-v2.js';
import { normalizeReferenceSrtForCalibration, parseReferenceSrt, runSubtitleCore, type CalibratedTranscript } from '../subtitle-core/index.js';
import { serializeCalibratedSrt, validateSrtFile } from '../output-report/srt.js';
import { createTaskId, safeAudioStem, sha256File } from '../tasks.js';
import { appendStableJsonLine, canonicalJson, readStableJson, writeStableJsonAtomic } from './storage.js';
import { ensureWorkspace } from '../workspace.js';
import { ensureRuntimeLayout, jsonFingerprint, readJob, readRequest, requestIdHash, reserveRequest, withRequestLease, withTaskTransitionLock, writeJob, writeRequest } from '../background/storage.js';
import { JOB_CONTRACT_VERSION, REQUEST_CONTRACT_VERSION, type BackgroundJobV1, type BackgroundRequestV1 } from '../background/types.js';
import { resolveDictionarySnapshot, type ResolvedDictionarySnapshot } from '../dictionary.js';
import { withOwnedLock } from '../background/owned-lock.js';
import { sensitiveTextIssues } from '../contracts/validation/security.js';

type ProviderCall = TaskRecordV5['execution']['provider_calls']['chat'];
export type V5FaultPoint =
  | 'after_dispatch_persisted'
  | 'after_response_persisted'
  | 'after_hints_snapshot_written'
  | 'after_dictionary_matches_snapshot_written'
  | 'after_terminal_report_written'
  | 'after_terminal_report_committed'
  | 'terminal_task_before_result';
export class SimulatedV5Crash extends Error {
  constructor(readonly point: V5FaultPoint | 'after_claim' | 'after_execute' | 'after_review' | 'before_finish', readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SimulatedV5Crash';
  }
}

async function crashFault(fault: ((point: V5FaultPoint, task: TaskRecordV5) => Promise<void> | void) | undefined, point: V5FaultPoint, task: TaskRecordV5): Promise<void> {
  try { await fault?.(point, structuredClone(task)); } catch (error) { throw new SimulatedV5Crash(point, error); }
}
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

async function readVerifiedMediaBytes(directory: string, media: NonNullable<TaskRecordV5['inputs']['media']>): Promise<Buffer> {
  if (media.mime_type !== 'audio/mpeg') throw new MercuryError('MEDIA_MIME_UNSUPPORTED', '0.3.0-alpha.1 只支持 MP3（audio/mpeg）媒体；未调用 Provider。', { exitCode: 2 });
  const target = managed(directory, media.workspace_path);
  const entry = await regular(target, 'MEDIA_INPUT_INVALID');
  const handle = await open(target, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== entry.size || opened.size !== media.bytes) throw new MercuryError('MEDIA_INPUT_INVALID', '任务媒体副本大小与固定记录不一致；未调用 Provider。');
    const bytes = await handle.readFile();
    if (bytes.length !== media.bytes || digest(bytes) !== media.sha256) throw new MercuryError('INPUT_COPY_HASH_MISMATCH', '任务媒体副本与固定 hash 不一致；未调用 Provider。');
    return bytes;
  } finally {
    await handle.close();
  }
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
  await withOwnedLock(path.join(directory, 'task-record.lock'), async () => {
    let checked = assertV5TaskRecord(task);
    if (checked.identity.task_directory !== path.basename(path.resolve(directory))) throw new MercuryError('TASK_RECORD_INVALID', 'v5 task identity 与目录不一致。');
    const taskFileExists = await lstat(path.join(directory, 'task.json')).then(() => true).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    const current = taskFileExists ? await readV5Task(directory) : null;
    if (current) {
      if (current.identity.task_id !== checked.identity.task_id || current.identity.request_fingerprint !== checked.identity.request_fingerprint) {
        throw new MercuryError('TASK_RECORD_INVALID', 'v5 task 写入 identity 冲突。');
      }
      // revision is a compare-and-swap token. A writer that read an older task may
      // refresh heartbeat-like data, but it may never replace business state.
      if (checked.identity.revision < current.identity.revision) {
        Object.assign(task, structuredClone(current));
        return;
      }
      if (TERMINAL.has(current.status) && checked.status !== current.status) {
        throw new MercuryError('TASK_STATE_TRANSITION_INVALID', `任务终态不可从 ${current.status} 改写为 ${checked.status}。`);
      }
      const allowed: Record<string, Set<string>> = {
        queued: new Set(['queued', 'running', 'cancelled', 'failed']),
        running: new Set(['running', 'queued', 'completed', 'failed', 'cancelled', 'interrupted', 'needs_input']),
        pausing: new Set(['pausing', 'paused', 'cancelled', 'interrupted']),
        paused: new Set(['paused', 'queued', 'cancelled']),
        needs_input: new Set(['needs_input']), completed: new Set(['completed']), failed: new Set(['failed']),
        cancelled: new Set(['cancelled']), interrupted: new Set(['interrupted']),
      };
      if (!allowed[current.status]?.has(checked.status)) {
        throw new MercuryError('TASK_STATE_TRANSITION_INVALID', `任务状态不可从 ${current.status} 转换为 ${checked.status}。`);
      }
      const callRank = { not_started: 0, in_flight: 1, response_persisted: 2, terminal: 3 } as const;
      for (const role of ['asr', 'chat'] as const) {
        const before = current.execution.provider_calls[role];
        const after = checked.execution.provider_calls[role];
        if (callRank[after.state] < callRank[before.state] || after.count < before.count) {
          throw new MercuryError('PROVIDER_CHECKPOINT_REGRESSION', `${role} Provider 检查点不可回退。`);
        }
        if (before.evidence_sha256 && (after.evidence_sha256 !== before.evidence_sha256 || after.evidence_ref !== before.evidence_ref)) {
          throw new MercuryError('PROVIDER_EVIDENCE_IMMUTABLE', `${role} 已固定的 Provider 响应证据不可替换。`);
        }
      }
      for (const source of ['transcript', 'reference'] as const) {
        const before = current.calibration_sources[source];
        const after = checked.calibration_sources[source];
        if (before && (!after || before.path !== after.path || before.sha256 !== after.sha256 || before.validation !== after.validation)) {
          throw new MercuryError('CALIBRATION_SOURCE_IMMUTABLE', `已固定的校准 ${source} 来源不可替换或清空。`);
        }
      }
      checked.identity.revision = Math.max(checked.identity.revision, current.identity.revision + 1);
      checked.execution.cancel_requested_at ??= current.execution.cancel_requested_at;
      if (current.status === 'running' && checked.status === 'running' && current.execution.worker_id === checked.execution.worker_id
        && (current.execution.heartbeat_at ?? '') > (checked.execution.heartbeat_at ?? '')) checked.execution.heartbeat_at = current.execution.heartbeat_at;
      if (current.updated_at > checked.updated_at) checked.updated_at = current.updated_at;
    }
    await writeStableJsonAtomic(path.join(directory, 'task.json'), assertV5TaskRecord(checked));
    Object.assign(task, structuredClone(checked));
  }, { errorCode: 'TASK_RECORD_LOCKED', errorMessage: '任务记录正在由另一个 Mercury 进程更新。' });
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
  return withOwnedLock(path.join(directory, 'events.lock'), async () => {
    const current = await readV5Task(directory);
    if (current.identity.task_id !== task.identity.task_id) throw new MercuryError('TASK_RECORD_INVALID', '事件 task identity 与目录不一致。');
    const events = await stableEvents(directory);
    const sequence = (events.at(-1)?.sequence ?? 0) + 1;
    const revision = Math.max(current.identity.revision, events.at(-1)?.task_revision ?? 0) + 1;
    const next = structuredClone(current);
    const event = assertExchangeContract('event', {
      contract: 'mercury.event/v1', event_id: `evt-${randomBytes(8).toString('hex')}`, task_id: task.identity.task_id,
      sequence, occurred_at: new Date().toISOString(), type, severity: type.includes('failed') || type.includes('interrupted') ? 'error' : 'info',
      task_revision: revision, attempt_id: current.execution.attempt_id, stage: current.stage, progress: null,
      message: message.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 500), data, extensions: {},
    });
    await appendStableJsonLine(path.join(directory, 'events.jsonl'), event);
    next.identity.revision = revision;
    next.updated_at = event.occurred_at;
    await persistV5Task(directory, next);
    Object.assign(task, structuredClone(next));
    return event;
  }, { waitMs: 15_000, errorCode: 'EVENT_LOG_LOCKED', errorMessage: '任务事件正在由另一个 Mercury 进程追加。' });
}

function srtFromSegments(segments: Array<{ start_ms: number; end_ms: number; text: string }>): string {
  const stamp = (ms: number) => {
    const hours = Math.floor(ms / 3_600_000); const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000); const milli = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
  };
  return `${segments.map((segment, index) => `${index + 1}\n${stamp(segment.start_ms)} --> ${stamp(segment.end_ms)}\n${segment.text}\n`).join('\n')}\n`;
}

function srtFromTranscript(transcript: ExchangeTranscriptV1): string {
  return srtFromSegments(transcript.segments);
}

interface ModelSnapshotV3 {
  contract: 'mercury.model-snapshot/v3'; snapshot_id: string; task_id: string; captured_at: string;
  models: { asr: ModelSnapshotEntryV2 | null; chat: ModelSnapshotEntryV2 }; evidence_mode: 'text' | 'audio_multimodal'; non_strong_reason: string | null;
}

export async function readVerifiedV5ModelSnapshot(directory: string, taskInput?: TaskRecordV5): Promise<ModelSnapshotV3> {
  const task = taskInput ?? await readV5Task(directory);
  const target = managed(directory, task.models.snapshot_path);
  await regular(target, 'MODEL_SNAPSHOT_INVALID');
  if (await sha256File(target) !== task.models.snapshot_sha256) {
    throw new MercuryError('MODEL_SNAPSHOT_INVALID', '模型快照 hash 与任务记录不一致。');
  }
  const snapshot = await readStableJson(target, 'MODEL_SNAPSHOT_INVALID') as ModelSnapshotV3;
  const expectedChatEntry = `${task.identity.task_id}-chat`;
  const expectedAsrEntry = task.models.asr ? `${task.identity.task_id}-asr` : null;
  if (snapshot.contract !== 'mercury.model-snapshot/v3'
    || snapshot.snapshot_id !== `${task.identity.task_id}-models`
    || snapshot.task_id !== task.identity.task_id
    || snapshot.models.chat.model_id !== task.models.chat
    || snapshot.models.chat.category !== 'chat'
    || snapshot.models.chat.snapshot_entry_id !== expectedChatEntry
    || (snapshot.models.asr?.model_id ?? null) !== task.models.asr
    || (snapshot.models.asr?.category ?? null) !== (task.models.asr ? 'asr' : null)
    || (snapshot.models.asr?.snapshot_entry_id ?? null) !== expectedAsrEntry) {
    throw new MercuryError('MODEL_SNAPSHOT_INVALID', '模型快照与 task/model/entry identity 不一致。');
  }
  return snapshot;
}

export interface ExchangeRuntimeDependencies extends ChatCalibrationV2Dependencies {
  asrAdapter?: AsrAdapter | AsrHintsCapableAdapter;
  chatRuntime?: ChatCalibrationRuntimeV2;
  resolveAsrCredential?: (reference: string) => Promise<ResolvedVolcengineCredential>;
}

function selectChat(registry: Awaited<ReturnType<typeof loadModelRegistryV2>>, taskId: string, explicit: string): ModelSnapshotEntryV2 {
  const model = registry.models.find((entry) => entry.model_id === explicit && entry.category === 'chat');
  if (!model) throw new MercuryError('MODEL_SELECTION_INVALID', `Chat 模型 ${explicit} 不存在或类别不匹配。`, { exitCode: 4 });
  if (!model.cloud_data_confirmation.confirmed || !['transcript', 'context'].every((kind) => model.cloud_data_confirmation.data_categories.includes(kind as any))) {
    throw new MercuryError('CLOUD_DATA_NOT_CONFIRMED', '所选 Chat 尚未确认本次转录与上下文发送。', { exitCode: 4 });
  }
  return snapshotModelV2(model, taskId);
}

function selectAsr(registry: Awaited<ReturnType<typeof loadModelRegistryV2>>, taskId: string, explicit: string): ModelSnapshotEntryV2 {
  const model = registry.models.find((entry) => entry.model_id === explicit && entry.category === 'asr');
  if (!model) throw new MercuryError('MODEL_SELECTION_INVALID', `ASR 模型 ${explicit} 不存在或类别不匹配。`, { exitCode: 4 });
  if (!model.cloud_data_confirmation.confirmed || !model.cloud_data_confirmation.data_categories.includes('audio')) {
    throw new MercuryError('CLOUD_DATA_NOT_CONFIRMED', '所选 ASR 尚未确认音频发送。', { exitCode: 4 });
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
  return { state: 'not_started', count: 0, outcome, evidence_ref: null, evidence_sha256: null };
}

async function writeDictionarySnapshotVersion(directory: string, snapshot: ResolvedDictionarySnapshot): Promise<{ path: string; sha256: string }> {
  const content = canonicalJson(snapshot);
  const sha256 = digest(content);
  const relative = `work/dictionary-snapshots/${sha256}.json`;
  const target = managed(directory, relative);
  const exists = await lstat(target).then((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new MercuryError('DICTIONARY_RECORD_INVALID', '词典快照版本路径不是安全普通文件。');
    return true;
  }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (exists) {
    if (await sha256File(target) !== sha256) throw new MercuryError('DICTIONARY_RECORD_INVALID', '不可变词典快照版本已损坏。');
  } else {
    await writeStableJsonAtomic(target, snapshot);
    if (await sha256File(target) !== sha256) throw new MercuryError('DICTIONARY_RECORD_INVALID', '词典快照版本写入后 hash 不一致。');
  }
  return { path: relative, sha256 };
}

async function createTaskDirectory(workspace: string, request: ExchangeRequestV1, taskId: string, directoryName: string): Promise<TaskRecordV5> {
  const provided = request.transcription_mode === 'provided';
  if (provided && request.inputs.transcript?.role !== 'transcript_source') throw new MercuryError('TRANSCRIPT_ROLE_REQUIRED', 'provided 模式必须提供 transcript_source。', { exitCode: 2 });
  if (!provided && request.inputs.transcript && request.inputs.transcript.role !== 'reference') throw new MercuryError('TRANSCRIPT_ROLE_REQUIRED', 'provider 模式的外部字幕只能声明 reference。', { exitCode: 2 });
  if (!provided && !request.inputs.media) throw new MercuryError('REQUEST_INVALID', 'provider 模式必须提供媒体输入。', { exitCode: 2 });
  if (request.inputs.media && request.inputs.media.mime_type !== 'audio/mpeg') throw new MercuryError('MEDIA_MIME_UNSUPPORTED', '0.3.0-alpha.1 只支持 MP3（audio/mpeg）媒体；任务未提交。', { exitCode: 2 });
  const inspected = request.inputs.transcript
    ? await inspectTranscriptInput({ filePath: request.inputs.transcript.path, format: request.inputs.transcript.format, role: request.inputs.transcript.role })
    : null;
  if (inspected && inspected.sha256 !== request.inputs.transcript!.sha256) throw new MercuryError('INPUT_HASH_MISMATCH', `${provided ? '转录' : '参考字幕'}输入 hash 与 request 不一致。`, { exitCode: 2 });
  let mediaBytes: number | null = null;
  let mediaDuration: number | null = null;
  if (request.inputs.media) {
    if (await sha256File(request.inputs.media.path) !== request.inputs.media.sha256) throw new MercuryError('INPUT_HASH_MISMATCH', '媒体输入 hash 与 request 不一致。', { exitCode: 2 });
    mediaBytes = (await regular(request.inputs.media.path)).size;
    mediaDuration = await readMp3DurationMs(request.inputs.media.path);
    if (provided && (inspected!.transcript.segments.at(-1)?.end_ms ?? 0) > mediaDuration + 1500) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '转录末尾超过媒体时长 1500ms 容忍范围。', { exitCode: 2 });
  }
  const registry = await loadModelRegistryV2(workspace);
  const chat = selectChat(registry, taskId, request.models.chat);
  const asr = provided ? null : selectAsr(registry, taskId, request.models.asr!);
  const decision = evidence(chat, mediaBytes);
  const createdAt = request.created_at;
  const staging = path.join(workspace, 'tasks', `.${directoryName}.staging-${process.pid}-${randomBytes(4).toString('hex')}`);
  const final = taskRoot(workspace, directoryName);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const child of ['input', 'work', 'output']) await mkdir(path.join(staging, child), { mode: 0o700 });
    await writeStableJsonAtomic(path.join(staging, 'request.json'), request);
    const sourceExtension = request.inputs.transcript ? (request.inputs.transcript.format === 'transcript_json' ? 'json' : request.inputs.transcript.format) : null;
    const transcriptRelative = request.inputs.transcript ? `input/${provided ? 'transcript-source' : 'reference-source'}.${sourceExtension}` : null;
    if (request.inputs.transcript && transcriptRelative) await copyVerified(request.inputs.transcript.path, path.join(staging, transcriptRelative), request.inputs.transcript.sha256);
    let media: TaskRecordV5['inputs']['media'] = null;
    if (request.inputs.media) {
      const relative = `input/media${path.extname(request.inputs.media.path).toLocaleLowerCase('en-US') || '.mp3'}`;
      const bytes = await copyVerified(request.inputs.media.path, path.join(staging, relative), request.inputs.media.sha256);
      media = { original_path: request.inputs.media.path, workspace_path: relative, sha256: request.inputs.media.sha256, bytes, mime_type: request.inputs.media.mime_type };
    }
    if (provided) await writeStableJsonAtomic(path.join(staging, 'work/transcript.normalized.json'), inspected!.transcript);
    let normalizedReference: TaskRecordV5['inputs']['reference_normalized'] = null;
    if (!provided && inspected) {
      const relative = 'input/reference.srt';
      await writeFile0600(path.join(staging, relative), serializeTranscriptSrt(inspected.transcript));
      normalizedReference = { path: relative, sha256: await sha256File(path.join(staging, relative)), validation: 'passed' };
    }
    const snapshot: ModelSnapshotV3 = { contract: 'mercury.model-snapshot/v3', snapshot_id: `${taskId}-models`, task_id: taskId, captured_at: createdAt, models: { asr, chat }, evidence_mode: decision.mode, non_strong_reason: decision.reason };
    await writeStableJsonAtomic(path.join(staging, 'work/model-snapshot.json'), snapshot);
    const dictionarySnapshot = await resolveDictionarySnapshot(workspace, request, taskId, provided ? inspected!.transcript.text : '');
    const dictionaryPointer = await writeDictionarySnapshotVersion(staging, dictionarySnapshot);
    const stem = safeAudioStem(path.basename(request.inputs.media?.path ?? request.inputs.transcript!.path).replace(/\.(?:srt|vtt|json)$/iu, '')) || 'subtitle';
    const transcribedRelative = `output/${stem}.transcribed.srt`;
    if (provided) {
      const handle = await open(path.join(staging, transcribedRelative), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(srtFromTranscript(inspected!.transcript), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    }
    const fingerprint = jsonFingerprint(JSON.parse(canonicalJson(request)));
    const taskCandidate = {
      schema_version: '5.0.0', identity: { task_id: taskId, request_id: request.request_id, request_fingerprint: fingerprint, task_directory: directoryName, revision: 0 },
      created_at: createdAt, updated_at: createdAt, status: 'queued', stage: null,
      input_config: { transcription_mode: request.transcription_mode, calibration_mode: request.calibration.mode, source_language: request.calibration.source_language, evidence_mode: decision.mode },
      inputs: {
        media,
        transcript_source: provided ? { original_path: request.inputs.transcript!.path, workspace_path: transcriptRelative!, sha256: request.inputs.transcript!.sha256, bytes: inspected!.bytes, mime_type: request.inputs.transcript!.format === 'srt' ? 'application/x-subrip' : request.inputs.transcript!.format === 'vtt' ? 'text/vtt' : 'application/json', format: request.inputs.transcript!.format, role: 'transcript_source' as const } : null,
        reference: !provided && request.inputs.transcript ? { original_path: request.inputs.transcript.path, workspace_path: transcriptRelative!, sha256: request.inputs.transcript.sha256, bytes: inspected!.bytes, mime_type: request.inputs.transcript.format === 'srt' ? 'application/x-subrip' : request.inputs.transcript.format === 'vtt' ? 'text/vtt' : 'application/json', format: request.inputs.transcript.format, role: 'reference' as const } : null,
        reference_normalized: normalizedReference,
      },
      calibration_sources: { transcript: null, reference: normalizedReference },
      models: { asr: request.models.asr, chat: request.models.chat, snapshot_path: 'work/model-snapshot.json', snapshot_sha256: await sha256File(path.join(staging, 'work/model-snapshot.json')) },
      dictionary_snapshot: { ...dictionaryPointer, resolved: dictionarySnapshot.resolved },
      execution: { queued_at: createdAt, started_at: null, ended_at: null, worker_id: null, heartbeat_at: null, attempt_id: null, attempt_count: 0, safe_checkpoint: 'queued', provider_calls: { asr: initialCall(), chat: initialCall() }, cancel_requested_at: null },
      artifacts: {
        transcript: provided ? { path: 'work/transcript.normalized.json', sha256: await sha256File(path.join(staging, 'work/transcript.normalized.json')), validation: 'passed' as const } : null,
        transcribed: provided ? { path: transcribedRelative, sha256: await sha256File(path.join(staging, transcribedRelative)), validation: 'passed' as const } : null, calibrated: null, approved: null, report: null,
      }, review: { status: 'not_ready', pending_count: null }, warnings: [...(inspected?.warnings ?? []), ...(decision.reason ? [`Chat 使用 text-only：${decision.reason}`] : [])], error: null,
    } as TaskRecordV5;
    if (provided) {
      const bridge = legacyTranscript(taskCandidate, inspected!.transcript, snapshot);
      const bridgeContract = validateContract('transcript.raw', bridge);
      if (!bridgeContract.valid) {
        throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '外部转录无法安全转换为内部校准输入；任务未提交。', { exitCode: 2 });
      }
      await writeStableJsonAtomic(path.join(staging, 'work/transcript.raw.json'), bridgeContract.value);
      taskCandidate.calibration_sources = {
        transcript: { path: 'work/transcript.raw.json', sha256: await sha256File(path.join(staging, 'work/transcript.raw.json')), validation: 'passed' },
        reference: null,
      };
    }
    const task = assertV5TaskRecord(taskCandidate);
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
      const directory = taskRoot(workspace, reserved.record.task_directory!);
      const stored = assertExchangeContract('request', await readStableJson(path.join(directory, 'request.json'), 'REQUEST_RECORD_INVALID'));
      if (stored.request_id !== request.request_id || jsonFingerprint(JSON.parse(canonicalJson(stored))) !== fingerprint) throw new MercuryError('REQUEST_RECORD_INVALID', '历史稳定 request 损坏或与预留记录不一致；Mercury 不会覆盖。');
      const task = await readV5Task(directory);
      if (task.identity.request_fingerprint !== fingerprint) throw new MercuryError('TASK_RECORD_INVALID', '历史 v5 task fingerprint 与稳定 request 不一致。');
      return { task, replayed: true };
    }
    await writeRequest(workspace, { ...reserved.record, owner: reservation.owner, updated_at: new Date().toISOString() });
    const expectedDirectory = taskRoot(workspace, directoryName);
    const existingDirectory = await lstat(expectedDirectory).then(() => true).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    const task = existingDirectory
      ? await readV5Task(expectedDirectory)
      : await createTaskDirectory(workspace, request, taskId, directoryName);
    const directory = taskRoot(workspace, directoryName);
    if ((await stableEvents(directory)).length === 0) await appendV5Event(directory, task, 'task_queued', '任务已持久化并加入本地后台队列。', { transcription_mode: request.transcription_mode, asr_call_count: 0 });
    const job: BackgroundJobV1 = { contract_version: JOB_CONTRACT_VERSION, task_id: taskId, task_directory: directoryName, state: 'queued', created_at: request.created_at, updated_at: new Date().toISOString(), claim_token: null, worker_id: null };
    const jobPath = path.join(workspace, 'runtime', 'jobs', `${taskId}.json`);
    const existingJob = await lstat(jobPath).then(() => true).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    if (existingJob) {
      const current = await readJob(workspace, taskId);
      if (current.task_directory !== directoryName) throw new MercuryError('JOB_RECORD_INVALID', '后台 job 与 v5 task identity 不一致。');
    } else await writeJob(workspace, job);
    await writeRequest(workspace, { ...reservation, state: 'committed', owner: null, updated_at: new Date().toISOString() });
    return { task: await readV5Task(directory), replayed: false };
  });
}

function legacyInlineText(value: string, label: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(/[\t\r\n]+/gu, ' ')
    .replace(/ {2,}/gu, ' ')
    .trim();
  if (!normalized || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `${label}在兼容合同规范化后没有可用正文。`, { exitCode: 2 });
  }
  return normalized;
}

function legacyTranscript(task: TaskRecordV5, transcript: ExchangeTranscriptV1, snapshot: ModelSnapshotV3): TranscriptRaw {
  const media = task.inputs.media;
  const duration = transcript.duration_ms ?? transcript.segments.at(-1)!.end_ms;
  const segments = transcript.segments.map((segment, index) => ({
    segment_id: segment.segment_id,
    index,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    text: legacyInlineText(segment.text, `第 ${index + 1} 个转录片段`),
    confidence: null,
    words: segment.words.map((word, wordIndex) => ({
      word_id: `${segment.segment_id}-word-${wordIndex + 1}`,
      index: wordIndex,
      text: legacyInlineText(word.text, `第 ${index + 1} 个转录片段的第 ${wordIndex + 1} 个词`),
      start_ms: word.start_ms,
      end_ms: word.end_ms,
      confidence: word.confidence,
    })),
  }));
  return {
    schema_version: '1.0.0', task_id: task.identity.task_id, created_at: transcript.created_at,
    audio: { path_ref: media?.workspace_path ?? task.inputs.transcript_source!.workspace_path, sha256: media?.sha256 ?? task.inputs.transcript_source!.sha256, duration_ms: duration, mime_type: 'audio/mpeg', language: 'zh-CN' },
    full_text: segments.map((segment) => segment.text).join('\n'),
    segments,
    model_snapshot_ref: snapshot.snapshot_id,
    call: { call_id: `${task.identity.task_id}-provided`, model_snapshot_entry_ref: 'provided-transcript', started_at: transcript.created_at, ended_at: transcript.created_at, outcome: 'completed', error_ref: null },
    raw_response_ref: null, warnings: [], errors: [],
  } as unknown as TranscriptRaw;
}

function preflight(task: TaskRecordV5, transcript: TranscriptRaw, snapshot: ModelSnapshotV3, referenceSrt: string | null) {
  const at = new Date().toISOString();
  const calibration = { schema_version: '1.0.0', task_id: task.identity.task_id, created_at: at, status: 'completed', request: { transcript_ref: 'work/transcript.raw.json', reference_srt_ref: referenceSrt ? 'input/reference.srt' : null, mode: referenceSrt ? task.input_config.calibration_mode : null }, model_snapshot_ref: snapshot.snapshot_id, call: { call_id: 'preflight', model_snapshot_entry_ref: snapshot.models.chat.snapshot_entry_id, started_at: at, ended_at: at, outcome: 'completed', error_ref: null }, suggestions: [], warnings: [], errors: [] } as unknown as CalibrationResult;
  const checked = validateContract('calibration-result', calibration);
  if (!checked.valid) throw new MercuryError('UPSTREAM_CALIBRATION_INVALID', checked.issues.map((issue) => `${issue.path} ${issue.message}`).join('; '));
  return runSubtitleCore({
    transcript,
    calibrationResult: checked.value,
    referenceSrtText: referenceSrt, requestedMode: referenceSrt ? task.input_config.calibration_mode : null,
    transcriptSourceMode: task.input_config.transcription_mode === 'provided' ? task.input_config.calibration_mode : null,
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

function exchangeError(code: string, message: string, providerOutcome: 'not_dispatched' | 'known_terminal' | 'response_persisted' | 'outcome_unknown' | 'not_applicable', detail: string | null = null, category: 'input' | 'config' | 'provider' | 'runtime' | 'compatibility' | 'security' | 'conflict' = 'provider'): NonNullable<TaskRecordV5['error']> {
  const publicMessage = message.replace(/\s*(?:Provider detail|provider detail)=.*$/iu, '').trim();
  const safeMessage = sensitiveTextIssues(publicMessage).length > 0 ? 'Provider 或本地处理返回了包含敏感信息的错误；详情已脱敏。' : publicMessage;
  const normalizedDetail = detail?.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2000) ?? null;
  const safeDetail = normalizedDetail && sensitiveTextIssues(normalizedDetail).length === 0 ? normalizedDetail : normalizedDetail ? '<redacted sensitive detail>' : null;
  return { contract: 'mercury.error/v1', code, category, message: safeMessage, retryability: providerOutcome === 'outcome_unknown' ? 'unsafe' : category === 'runtime' ? 'not_applicable' : 'after_user_action', provider_outcome: providerOutcome, remediation: [providerOutcome === 'outcome_unknown' ? '不要自动重试；请查看技术证据后由用户决定。' : category === 'runtime' ? '保留当前任务证据并检查本地文件；不要重复调用 Provider。' : '检查模型配置后使用新的 request ID 创建任务。'], technical: safeDetail ? { provider_code: null, log_id: null, detail: safeDetail } : null, extensions: {} };
}

const REFERENCE_AUDIO_MISMATCH_ACTION = '参考字幕与音频正文不完整对齐；请换用覆盖同一音频范围的完整参考字幕，并使用新的 request ID 创建任务；不要重放当前任务。';
const TEXT_ONLY_HARD_LIMIT_CODES = new Set([
  'CALIBRATED_HARD_LIMIT_INVALID_FOR_TEXT_ONLY',
  'REFERENCE_HARD_LIMIT_INVALID_FOR_TEXT_ONLY',
]);
const TEXT_ONLY_HARD_LIMIT_ACTION = '请依据真实时间边界把该 cue/segment 拆成不超过 24 字且不超过两行的合规片段，并使用新的 request ID 创建任务；不要重放当前任务。';

function referenceAudioMismatchError(
  detail: string,
  providerOutcome: NonNullable<TaskRecordV5['error']>['provider_outcome'],
): NonNullable<TaskRecordV5['error']> {
  const coverage = /ASR coverage ([0-9]+(?:\.[0-9]+)?)% and reference coverage ([0-9]+(?:\.[0-9]+)?)% must both reach ([0-9]+(?:\.[0-9]+)?)%\.?/u.exec(detail);
  const message = coverage
    ? `参考字幕与音频正文不完整对齐：ASR 转录覆盖率 ${coverage[1]}%，参考字幕覆盖率 ${coverage[2]}%，两者都需要达到 ${coverage[3]}%。`
    : '参考字幕与音频正文不完整对齐，两者没有同时达到所需覆盖率。';
  const error = exchangeError('REFERENCE_AUDIO_MISMATCH', message, providerOutcome, detail, 'input');
  error.remediation = [REFERENCE_AUDIO_MISMATCH_ACTION];
  return error;
}

function textOnlyHardLimitError(
  code: string,
  detail: string,
  providerOutcome: NonNullable<TaskRecordV5['error']>['provider_outcome'],
): NonNullable<TaskRecordV5['error']> {
  const calibrated = /Calibrated segment ([A-Za-z0-9._:-]+) exceeds the 24-character or two-line hard limit\.?/u.exec(detail);
  const reference = /Reference SRT block ([0-9]+) exceeds the 24-character or two-line hard limit\.?/u.exec(detail);
  const message = calibrated
    ? `校验后的字幕片段 ${calibrated[1]} 超过 24 字或两行限制，且当前没有可安全拆分的真实时间边界。`
    : reference
      ? `参考字幕第 ${reference[1]} 个 cue 超过 24 字或两行限制，且当前没有可安全拆分的真实时间边界。`
      : '字幕片段超过 24 字或两行限制，且当前没有可安全拆分的真实时间边界。';
  const error = exchangeError(code, message, providerOutcome, detail, 'input');
  error.remediation = [TEXT_ONLY_HARD_LIMIT_ACTION];
  return error;
}

function projectedTaskError(error: TaskRecordV5['error']): TaskRecordV5['error'] {
  if (!error) return error;
  if (error.code === 'REFERENCE_AUDIO_MISMATCH') {
    return referenceAudioMismatchError(error.technical?.detail ?? error.message, error.provider_outcome);
  }
  if (TEXT_ONLY_HARD_LIMIT_CODES.has(error.code)) {
    return textOnlyHardLimitError(error.code, error.technical?.detail ?? error.message, error.provider_outcome);
  }
  return error;
}

async function writeReport(directory: string, task: TaskRecordV5, snapshot: ModelSnapshotV3, calibration: CalibrationResultV3 | null): Promise<void> {
  const dictionaryPath = managed(directory, task.dictionary_snapshot.path);
  await regular(dictionaryPath, 'DICTIONARY_RECORD_INVALID');
  if (await sha256File(dictionaryPath) !== task.dictionary_snapshot.sha256) throw new MercuryError('DICTIONARY_RECORD_INVALID', '词典快照 hash 与任务记录不一致；未生成报告。');
  const dictionary = await readStableJson(dictionaryPath, 'DICTIONARY_RECORD_INVALID') as ResolvedDictionarySnapshot;
  if (dictionary.contract !== 'mercury.dictionary-snapshot/v1' || dictionary.task_id !== task.identity.task_id) throw new MercuryError('DICTIONARY_RECORD_INVALID', '词典快照 identity 与任务不一致；未生成报告。');
  const source = task.input_config.transcription_mode === 'provided' ? '外部提供' : `${snapshot.models.asr?.name ?? 'ASR Provider'}`;
  const text = ['# Mercury 字幕校准工作报告', '', `- 任务 ID：\`${task.identity.task_id}\``, `- 转写来源：${source}（ASR 调用数：${task.execution.provider_calls.asr.count}）`, `- 外部格式：${task.inputs.transcript_source?.format ?? task.inputs.reference?.format ?? '—'}`, `- 原件 SHA-256：${task.inputs.transcript_source?.sha256 ?? task.inputs.media?.sha256 ?? '—'}`, `- 规范化 SHA-256：${task.artifacts.transcript?.sha256 ?? '—'}`, `- Chat：${snapshot.models.chat.name} / ${snapshot.models.chat.provider_model}`, `- 校验证据：${task.input_config.evidence_mode === 'audio_multimodal' ? '完整转录 + 音频' : '完整转录'}`, `- Chat 调用：${task.execution.provider_calls.chat.count}`, `- 完整覆盖：${calibration ? `${calibration.strategy.input_unit_count}/${calibration.strategy.returned_unit_count} ${calibration.strategy.coverage_complete ? '通过' : '失败'}` : '未形成'}`, `- 词典快照：${task.dictionary_snapshot.sha256}`, `- 词典 revision：${dictionary.resolved.map((entry) => `${entry.dictionary_id}@${entry.revision}`).join('，') || '无'}`, `- 相关词典条目：${dictionary.matched_entry_ids.join('，') || '无'}`, `- ASR hints：${dictionary.asr_hints.status}（发送 ${dictionary.asr_hints.input_count}/${dictionary.asr_hints.available_count} 项${dictionary.asr_hints.truncated ? '，已按 Adapter 上限截断' : ''}）`, `- 警告：${task.warnings.join('；') || '无'}`, `- 错误：${task.error ? `${task.error.code}：${task.error.message}` : '无'}`, ''].join('\n');
  await writeFile0600(path.join(directory, 'output/calibration-report.md'), text);
  task.artifacts.report = { path: 'output/calibration-report.md', sha256: await sha256File(path.join(directory, 'output/calibration-report.md')), validation: 'passed' };
}

async function commitTerminalThenDerive(
  directory: string,
  task: TaskRecordV5,
  snapshot: ModelSnapshotV3,
  calibration: CalibrationResultV3 | null,
  fault?: (point: V5FaultPoint, task: TaskRecordV5) => Promise<void> | void,
): Promise<TaskRecordV5> {
  if (!TERMINAL.has(task.status)) throw new MercuryError('TASK_STATE_TRANSITION_INVALID', '只有任务终态可以进入稳定派生产物提交。');
  // Provider certainty and the task terminal state are the primary durable
  // fact. Reports, result projections and events are recoverable derivatives
  // and must never run before this commit.
  await persistV5Task(directory, task);
  await crashFault(fault, 'terminal_task_before_result', task);
  await writeReport(directory, task, snapshot, calibration);
  await crashFault(fault, 'after_terminal_report_written', task);
  await persistV5Task(directory, task);
  await crashFault(fault, 'after_terminal_report_committed', task);
  await writeV5Result(directory, task);
  return task;
}

async function writeFile0600(target: string, content: string): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, target);
  await chmod(target, 0o600);
}

function exchangeTranscriptFromProvider(task: TaskRecordV5, raw: TranscriptRaw, snapshot: ModelSnapshotV3): ExchangeTranscriptV1 {
  const rawHash = digest(canonicalJson(raw));
  const segments = raw.segments.map((segment, index) => ({
    segment_id: `seg-${digest(`${segment.segment_id}\n${segment.start_ms}\n${segment.end_ms}\n${segment.text}`).slice(0, 16)}`,
    index, start_ms: segment.start_ms, end_ms: segment.end_ms, text: segment.text,
    words: segment.words.map((word) => ({ text: word.text, start_ms: word.start_ms, end_ms: word.end_ms, confidence: word.confidence })),
  }));
  const value = {
    contract: 'mercury.transcript/v1' as const,
    transcript_id: `trn-${rawHash.slice(0, 24)}`, created_at: raw.created_at, language: raw.audio.language,
    duration_ms: raw.audio.duration_ms, text: raw.full_text, segments,
    source: {
      kind: 'provider' as const, format: 'provider_json' as const,
      system: snapshot.models.asr?.plugin_id ?? 'asr', external_id: raw.call.provider_request_id ?? null,
      generated_at: raw.call.ended_at, content_sha256: rawHash, original_path: null,
      original_sha256: raw.audio.sha256, normalized_sha256: '0'.repeat(64),
    },
    warnings: raw.warnings.map((warning) => typeof warning === 'string' ? warning : canonicalJson(warning)).slice(0, 1000), extensions: {},
  };
  const hashMaterial = structuredClone(value);
  hashMaterial.source.normalized_sha256 = '0'.repeat(64);
  value.source.normalized_sha256 = digest(canonicalJson(hashMaterial));
  return assertExchangeContract('transcript', value);
}

function canonicalWarningText(value: string): string {
  try {
    return canonicalJson(JSON.parse(value));
  } catch {
    return value;
  }
}

function providerTranscriptProjectionMatches(
  expected: ExchangeTranscriptV1,
  actual: ExchangeTranscriptV1,
): boolean {
  const comparable = (value: ExchangeTranscriptV1): ExchangeTranscriptV1 => {
    const copy = structuredClone(value);
    // normalized_sha256 is derived from the projection itself. Early Alpha.1
    // development tasks serialized structured ASR warnings with insertion-order
    // JSON, while stable storage canonicalized the raw evidence. Compare the
    // pinned semantic warning values and every other source field, but do not
    // make that historical serialization detail invalidate an immutable task.
    copy.source.normalized_sha256 = '0'.repeat(64);
    copy.warnings = copy.warnings.map(canonicalWarningText);
    return copy;
  };
  return canonicalJson(comparable(expected)) === canonicalJson(comparable(actual));
}

function refreshDictionaryMatches(snapshot: ResolvedDictionarySnapshot, text: string): void {
  const matched = snapshot.entries.filter((entry) => {
    const haystack = entry.case_sensitive ? text.normalize('NFC') : text.normalize('NFC').toLocaleLowerCase('en-US');
    return [entry.canonical, ...entry.variants].some((form) => haystack.includes(entry.case_sensitive ? form.normalize('NFC') : form.normalize('NFC').toLocaleLowerCase('en-US')));
  }).map((entry) => entry.entry_id);
  snapshot.matched_entry_ids = matched;
  snapshot.chat_context_entry_ids = matched;
}

async function readPinnedEvidence(directory: string, call: ProviderCall, code: string): Promise<unknown> {
  if (!call.evidence_ref || !call.evidence_sha256) throw new MercuryError(code, '已持久化 Provider 响应缺少路径或内容 hash。');
  const target = managed(directory, call.evidence_ref);
  if (await sha256File(target).catch(() => null) !== call.evidence_sha256) throw new MercuryError(code, '已持久化 Provider 响应 hash 不一致；不会采纳或重放 Provider。');
  return readStableJson(target, code);
}

function assertAsrEvidenceIdentity(candidate: unknown, task: TaskRecordV5, snapshot: ModelSnapshotV3, media: NonNullable<TaskRecordV5['inputs']['media']>, duration: number): TranscriptRaw {
  const checked = validateContract('transcript.raw', candidate);
  if (!checked.valid) throw new MercuryError('ASR_ARTIFACT_INVALID', checked.issues.map((entry) => `${entry.path} ${entry.message}`).join('; '));
  const raw = checked.value;
  if (!snapshot.models.asr
    || raw.task_id !== task.identity.task_id
    || raw.model_snapshot_ref !== snapshot.snapshot_id
    || raw.call.model_snapshot_entry_ref !== snapshot.models.asr.snapshot_entry_id
    || raw.call.outcome !== 'completed'
    || raw.audio.path_ref !== media.workspace_path
    || raw.audio.sha256 !== media.sha256
    || raw.audio.mime_type !== media.mime_type
    || raw.audio.duration_ms !== duration) {
    throw new MercuryError('ASR_ARTIFACT_INVALID', 'ASR 响应与 task/model/call/audio identity 不一致；不会采纳或重放 Provider。');
  }
  return raw;
}

function assertChatEvidenceIdentity(candidate: unknown, task: TaskRecordV5, snapshot: ModelSnapshotV3): CalibrationResultV3 {
  const checked = validateV3CalibrationResult(candidate);
  if (!checked.valid) throw new MercuryError('CALIBRATION_RESULT_INVALID', checked.issues.map((entry) => `${entry.path} ${entry.message}`).join('; '));
  const calibration = checked.value;
  const media = task.inputs.media;
  const expectedReference = task.calibration_sources.reference?.path ?? null;
  const expectedMode = expectedReference ? task.input_config.calibration_mode : null;
  const expectedAudio = task.input_config.evidence_mode === 'audio_multimodal' && media ? media : null;
  if (calibration.task_id !== task.identity.task_id
    || calibration.model_snapshot_ref !== snapshot.snapshot_id
    || calibration.call.model_snapshot_entry_ref !== snapshot.models.chat.snapshot_entry_id
    || calibration.request.transcript_ref !== task.calibration_sources.transcript?.path
    || calibration.request.alignment_ref !== 'work/alignment.json'
    || calibration.request.reference_srt_ref !== expectedReference
    || calibration.request.mode !== expectedMode
    || calibration.request.evidence_mode !== task.input_config.evidence_mode
    || (expectedAudio === null) !== (calibration.request.audio === null)
    || (expectedAudio !== null && (calibration.request.audio?.path_ref !== expectedAudio.workspace_path
      || calibration.request.audio.sha256 !== expectedAudio.sha256
      || calibration.request.audio.bytes !== expectedAudio.bytes
      || calibration.request.audio.mime_type !== expectedAudio.mime_type))) {
    throw new MercuryError('CALIBRATION_RESULT_INVALID', 'Chat 响应与 task/model/call/input identity 不一致；不会采纳或重放 Provider。');
  }
  return calibration;
}

async function hasVerifiedReport(directory: string, task: TaskRecordV5): Promise<boolean> {
  const report = task.artifacts.report;
  if (!report || report.path !== 'output/calibration-report.md' || report.validation !== 'passed') return false;
  const target = managed(directory, report.path);
  const entry = await lstat(target).catch(() => null);
  return Boolean(entry?.isFile()
    && !entry.isSymbolicLink()
    && (entry.mode & 0o777) === 0o600
    && await sha256File(target) === report.sha256);
}

export async function ensureV5TerminalReport(directory: string, taskInput?: TaskRecordV5): Promise<TaskRecordV5> {
  const task = taskInput ?? await readV5Task(directory);
  if (!['completed', 'failed', 'interrupted'].includes(task.status)) return task;
  if (await hasVerifiedReport(directory, task)) return task;
  const snapshot = await readVerifiedV5ModelSnapshot(directory, task);
  let calibration: CalibrationResultV3 | null = null;
  if (task.execution.provider_calls.chat.evidence_ref) {
    calibration = assertChatEvidenceIdentity(
      await readPinnedEvidence(directory, task.execution.provider_calls.chat, 'CALIBRATION_RESULT_INVALID'),
      task,
      snapshot,
    );
  }
  await writeReport(directory, task, snapshot, calibration);
  await persistV5Task(directory, task);
  return task;
}

async function assertCalibrationSourceEvidence(
  directory: string,
  task: TaskRecordV5,
  legacy: TranscriptRaw,
  referenceText: string | null,
): Promise<void> {
  const transcriptSource = task.calibration_sources.transcript;
  if (!transcriptSource || transcriptSource.path !== 'work/transcript.raw.json') {
    throw new MercuryError('CALIBRATION_SOURCE_INVALID', '校准 transcript 来源未固定到真实任务文件；不会调用 Provider。');
  }
  const transcriptPath = managed(directory, transcriptSource.path);
  await regular(transcriptPath, 'CALIBRATION_SOURCE_INVALID');
  if (await sha256File(transcriptPath) !== transcriptSource.sha256) throw new MercuryError('CALIBRATION_SOURCE_INVALID', '校准 transcript 来源 hash 不一致；不会调用 Provider。');
  const pinnedTranscript = await readStableJson(transcriptPath, 'CALIBRATION_SOURCE_INVALID');
  if (canonicalJson(pinnedTranscript) !== canonicalJson(legacy)) throw new MercuryError('CALIBRATION_SOURCE_INVALID', '校准 transcript 来源与当前任务转录不一致；不会调用 Provider。');

  const referenceSource = task.calibration_sources.reference;
  if (referenceText === null) {
    if (referenceSource !== null) throw new MercuryError('CALIBRATION_SOURCE_INVALID', '无 reference 的任务不能声明校准 reference 来源；不会调用 Provider。');
    return;
  }
  if (!referenceSource || referenceSource.path !== 'input/reference.srt') throw new MercuryError('CALIBRATION_SOURCE_INVALID', '校准 reference 来源未固定到真实任务文件；不会调用 Provider。');
  const referencePath = managed(directory, referenceSource.path);
  await regular(referencePath, 'CALIBRATION_SOURCE_INVALID');
  if (await sha256File(referencePath) !== referenceSource.sha256) throw new MercuryError('CALIBRATION_SOURCE_INVALID', '校准 reference 来源 hash 不一致；不会调用 Provider。');
  if (await readFile(referencePath, 'utf8') !== referenceText) throw new MercuryError('CALIBRATION_SOURCE_INVALID', '校准 reference 来源正文与任务输入不一致；不会调用 Provider。');
}

export async function verifyV5CalibrationSources(directory: string, taskInput?: TaskRecordV5): Promise<void> {
  const task = taskInput ?? await readV5Task(directory);
  if (!task.artifacts.transcript) throw new MercuryError('CALIBRATION_SOURCE_INVALID', '任务尚未形成可验证的规范化转录来源。');
  if (await sha256File(managed(directory, task.artifacts.transcript.path)).catch(() => null) !== task.artifacts.transcript.sha256) {
    throw new MercuryError('CALIBRATION_SOURCE_INVALID', '规范化转录来源缺失或 hash 不一致。');
  }
  const transcript = assertExchangeContract('transcript', await readStableJson(managed(directory, task.artifacts.transcript.path), 'CALIBRATION_SOURCE_INVALID'));
  const snapshot = await readVerifiedV5ModelSnapshot(directory, task);
  let legacy: TranscriptRaw;
  if (task.input_config.transcription_mode === 'provided') {
    const source = task.inputs.transcript_source;
    if (!source || await sha256File(managed(directory, source.workspace_path)).catch(() => null) !== source.sha256) throw new MercuryError('CALIBRATION_SOURCE_INVALID', '外部转录原件缺失或 hash 不一致。');
    legacy = legacyTranscript(task, transcript, snapshot);
  } else {
    const media = task.inputs.media;
    if (!media || !task.calibration_sources.transcript) throw new MercuryError('CALIBRATION_SOURCE_INVALID', 'provider 任务缺少固定的 ASR 校准来源。');
    const rawCandidate = await readStableJson(managed(directory, task.calibration_sources.transcript.path), 'CALIBRATION_SOURCE_INVALID');
    const rawValue = validateContract('transcript.raw', rawCandidate);
    if (!rawValue.valid) throw new MercuryError('CALIBRATION_SOURCE_INVALID', rawValue.issues.map((entry) => `${entry.path} ${entry.message}`).join('; '));
    legacy = assertAsrEvidenceIdentity(rawValue.value, task, snapshot, media, rawValue.value.audio.duration_ms);
    if (!providerTranscriptProjectionMatches(exchangeTranscriptFromProvider(task, legacy, snapshot), transcript)) throw new MercuryError('CALIBRATION_SOURCE_INVALID', '规范化转录与固定 ASR 来源不一致。');
  }
  let referenceText: string | null = null;
  if (task.input_config.transcription_mode === 'provided') {
    // Early Alpha.1 development tasks materialized the provided transcript a
    // second time as a synthetic reference. Keep those task-local sources
    // readable, while new stable requests correctly leave reference absent.
    referenceText = task.calibration_sources.reference ? srtFromSegments(legacy.segments) : null;
  } else if (task.inputs.reference) {
    if (!task.inputs.reference_normalized
      || await sha256File(managed(directory, task.inputs.reference.workspace_path)).catch(() => null) !== task.inputs.reference.sha256
      || await sha256File(managed(directory, task.inputs.reference_normalized.path)).catch(() => null) !== task.inputs.reference_normalized.sha256) {
      throw new MercuryError('CALIBRATION_SOURCE_INVALID', '参考字幕原件或规范化来源缺失或 hash 不一致。');
    }
    referenceText = await readFile(managed(directory, task.inputs.reference_normalized.path), 'utf8');
  }
  await assertCalibrationSourceEvidence(directory, task, legacy, referenceText);
  if (task.execution.provider_calls.chat.evidence_ref) {
    assertChatEvidenceIdentity(await readPinnedEvidence(directory, task.execution.provider_calls.chat, 'CALIBRATION_RESULT_INVALID'), task, snapshot);
  }
  if (task.artifacts.calibrated) {
    const calibratedPath = managed(directory, 'work/transcript.calibrated.json');
    const candidate = await readStableJson(calibratedPath, 'CALIBRATION_SOURCE_INVALID') as Partial<CalibratedTranscript>;
    if (candidate.task_id !== task.identity.task_id
      || candidate.source_refs?.transcript_ref !== task.calibration_sources.transcript!.path
      || candidate.source_refs?.reference_srt_ref !== (task.calibration_sources.reference?.path ?? null)
      || candidate.source_refs?.calibration_ref !== 'work/calibration-result.json') {
      throw new MercuryError('CALIBRATION_SOURCE_INVALID', '校验后 transcript 的来源引用与任务固定证据不一致。');
    }
  }
}

async function settleReturnedArtifactInvalid(
  directory: string,
  snapshot: ModelSnapshotV3,
  role: 'asr' | 'chat',
  error: unknown,
  fault?: (point: V5FaultPoint, task: TaskRecordV5) => Promise<void> | void,
): Promise<TaskRecordV5> {
  const task = await readV5Task(directory);
  const code = error instanceof MercuryError ? error.code : role === 'asr' ? 'ASR_ARTIFACT_INVALID' : 'CALIBRATION_RESULT_INVALID';
  const detail = error instanceof Error ? error.message : String(error);
  task.execution.provider_calls[role] = { state: 'terminal', count: Math.max(1, task.execution.provider_calls[role].count), outcome: 'known_terminal', evidence_ref: null, evidence_sha256: null };
  task.status = 'failed'; task.stage = null; task.execution.ended_at = new Date().toISOString();
  task.error = exchangeError(code, `${role === 'asr' ? 'ASR' : 'Chat'} 已返回响应，但响应合同或任务身份无效；不会自动重放。`, 'known_terminal', detail);
  return commitTerminalThenDerive(directory, task, snapshot, null, fault);
}

function hintsDispatchEvidence(planned: Array<{ entryId: string }>, evidence: AsrHintsDispatchEvidence | undefined): AsrHintsDispatchEvidence {
  const plannedIds = planned.map((entry) => entry.entryId);
  const plannedHash = digest(canonicalJson(planned));
  if (!evidence || evidence.status !== 'used' || evidence.inputHash !== plannedHash
    || canonicalJson(evidence.entryIds) !== canonicalJson(plannedIds)) {
    throw new MercuryError('ASR_HINTS_DISPATCH_EVIDENCE_INVALID', 'ASR Adapter 未证明实际请求使用了计划中的词典条目；未调用 Provider。');
  }
  return evidence;
}

async function prepareProviderTranscript(
  directory: string,
  taskInput: TaskRecordV5,
  snapshot: ModelSnapshotV3,
  dictionarySnapshot: ResolvedDictionarySnapshot,
  dependencies: ExchangeRuntimeDependencies,
  fault?: (point: V5FaultPoint, task: TaskRecordV5) => Promise<void> | void,
): Promise<{ task: TaskRecordV5; transcript: ExchangeTranscriptV1; legacy: TranscriptRaw } | null> {
  let task = taskInput;
  if (!snapshot.models.asr || !task.inputs.media) throw new MercuryError('MODEL_SNAPSHOT_INVALID', 'provider v5 任务缺少 ASR 模型或媒体。');
  const media = task.inputs.media;
  const audioPath = managed(directory, media.workspace_path);
  const verifiedAudioBytes = await readVerifiedMediaBytes(directory, media);
  const duration = readMp3DurationMsFromBytes(verifiedAudioBytes);
  task.stage = 'transcribing'; task.execution.safe_checkpoint = 'asr_not_started'; task.updated_at = new Date().toISOString(); await persistV5Task(directory, task);
  task = await readV5Task(directory);
  if (task.execution.cancel_requested_at) { await cancelV5AtBoundary(directory, task); return null; }
  const evidenceRef = task.execution.provider_calls.asr.evidence_ref;
  let raw: TranscriptRaw;
  if (evidenceRef && ['response_persisted', 'terminal'].includes(task.execution.provider_calls.asr.state)) {
    raw = assertAsrEvidenceIdentity(await readPinnedEvidence(directory, task.execution.provider_calls.asr, 'ASR_ARTIFACT_INVALID'), task, snapshot, media, duration);
  } else {
    const asr = dependencies.asrAdapter ?? (snapshot.models.asr.plugin_id === 'volcengine_subtitle_asr'
      ? new VolcengineSubtitleAsrAdapter({ readCredential: dependencies.readCredential ?? readCredentialReference, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) })
      : new VolcengineAsrAdapter({ resolveCredential: dependencies.resolveAsrCredential ?? resolveVolcengineCredentialReference, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) }));
    const hintCapability = (asr as Partial<AsrHintsCapableAdapter>).asrHintsCapability
      ?? { status: 'not_supported' as const, reason: 'Adapter 未声明 asr_hints 能力。' };
    if (hintCapability.status === 'supported' && (!Number.isSafeInteger(hintCapability.maxEntries) || hintCapability.maxEntries < 1 || hintCapability.maxEntries > 1_000)) {
      throw new MercuryError('ASR_HINTS_CAPABILITY_INVALID', 'ASR Adapter 声明的 hints 上限无效；未调用 Provider。');
    }
    const hintEntries = hintCapability.status === 'supported'
      ? dictionarySnapshot.entries.slice(0, hintCapability.maxEntries).map((entry) => ({
        entryId: entry.entry_id, canonical: entry.canonical, variants: [...entry.variants], language: entry.language,
        caseSensitive: entry.case_sensitive, numberSensitive: entry.number_sensitive,
      }))
      : [];
    dictionarySnapshot.asr_hints = hintCapability.status === 'not_supported'
      ? { status: 'not_supported', adapter_id: asr.adapterId, entry_ids: [], available_count: dictionarySnapshot.entries.length, input_count: 0, truncated: false, input_hash: null, reason: hintCapability.reason }
      : hintEntries.length === 0
        ? { status: 'not_applicable', adapter_id: asr.adapterId, entry_ids: [], available_count: 0, input_count: 0, truncated: false, input_hash: null, reason: '任务词典没有可发送的条目。' }
        : { status: 'pending', adapter_id: asr.adapterId, entry_ids: [], available_count: dictionarySnapshot.entries.length, input_count: 0, truncated: hintEntries.length < dictionarySnapshot.entries.length, input_hash: null, reason: '等待 Adapter 在真实请求 dispatch 边界确认 hints 证据。' };
    const preparedSnapshot = await writeDictionarySnapshotVersion(directory, dictionarySnapshot);
    task.dictionary_snapshot.path = preparedSnapshot.path;
    task.dictionary_snapshot.sha256 = preparedSnapshot.sha256;
    task.dictionary_snapshot.resolved = dictionarySnapshot.resolved;
    task.updated_at = new Date().toISOString();
    await persistV5Task(directory, task);
    let result: Awaited<ReturnType<AsrAdapter['run']>>;
    try {
      result = await asr.run({
        taskId: task.identity.task_id, modelSnapshotRef: snapshot.snapshot_id, model: legacyAsrEntry(snapshot.models.asr) as any,
        audio: { sourcePath: audioPath, verifiedBytes: verifiedAudioBytes, pathRef: media.workspace_path, sha256: media.sha256, durationMs: duration, mimeType: 'audio/mpeg', language: 'zh-CN' },
        asrHints: { entries: hintEntries },
        beforeProviderDispatch: async (_operation, dispatchEvidence) => {
          task = await readV5Task(directory);
          if (task.execution.cancel_requested_at) throw new MercuryError('TASK_CANCELLED', '任务已请求取消，未调用 ASR。');
          if (hintEntries.length > 0) {
            const confirmed = hintsDispatchEvidence(hintEntries, dispatchEvidence?.asrHints);
            const currentDictionary = await readStableJson(managed(directory, task.dictionary_snapshot.path), 'DICTIONARY_RECORD_INVALID') as ResolvedDictionarySnapshot;
            currentDictionary.asr_hints = {
              status: 'used', adapter_id: asr.adapterId, entry_ids: [...confirmed.entryIds], available_count: currentDictionary.entries.length,
              input_count: confirmed.entryIds.length, truncated: confirmed.entryIds.length < currentDictionary.entries.length,
            input_hash: confirmed.inputHash, reason: null,
          };
          const usedSnapshot = await writeDictionarySnapshotVersion(directory, currentDictionary);
          await crashFault(fault, 'after_hints_snapshot_written', task);
          task.dictionary_snapshot.path = usedSnapshot.path;
            task.dictionary_snapshot.sha256 = usedSnapshot.sha256;
            task.dictionary_snapshot.resolved = currentDictionary.resolved;
            Object.assign(dictionarySnapshot, currentDictionary);
          }
          task.execution.provider_calls.asr = { state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null, evidence_sha256: null };
          task.updated_at = new Date().toISOString(); await persistV5Task(directory, task);
          await crashFault(fault, 'after_dispatch_persisted', task);
          await appendV5Event(directory, task, 'provider_dispatched', 'ASR 转写请求已发送。', { capability: 'transcription', count: 1 });
        },
      });
    } catch (error) {
      task = await readV5Task(directory);
      if (task.execution.cancel_requested_at && task.execution.provider_calls.asr.state === 'not_started') {
        await cancelV5AtBoundary(directory, task);
        return null;
      }
      throw error;
    }
    if (result.kind === 'failure') {
      task = await readV5Task(directory);
      if (task.execution.cancel_requested_at && task.execution.provider_calls.asr.state === 'not_started') {
        await cancelV5AtBoundary(directory, task);
        return null;
      }
      const certainty = result.failure.provider_outcome_certainty ?? (task.execution.provider_calls.asr.state === 'in_flight' ? 'outcome_unknown' : 'not_dispatched');
      task.execution.provider_calls.asr = { state: certainty === 'outcome_unknown' ? 'in_flight' : 'terminal', count: task.execution.provider_calls.asr.count, outcome: certainty, evidence_ref: null, evidence_sha256: null };
      task.status = certainty === 'outcome_unknown' ? 'interrupted' : 'failed'; task.stage = null; task.execution.ended_at = new Date().toISOString();
      task.error = exchangeError(certainty === 'outcome_unknown' ? 'TASK_INTERRUPTED_PROVIDER_UNKNOWN' : result.failure.errors[0]!.code, result.failure.errors[0]!.message, certainty, result.failure.errors[0]!.message);
      await commitTerminalThenDerive(directory, task, snapshot, null, fault); return null;
    }
    try {
      raw = assertAsrEvidenceIdentity(result.artifact, task, snapshot, media, duration);
    } catch (error) {
      await settleReturnedArtifactInvalid(directory, snapshot, 'asr', error, fault);
      return null;
    }
    await writeStableJsonAtomic(path.join(directory, 'work/transcript.raw.json'), raw);
    const evidenceSha256 = await sha256File(path.join(directory, 'work/transcript.raw.json'));
    task = await readV5Task(directory);
    task.execution.provider_calls.asr = { state: 'response_persisted', count: 1, outcome: 'response_persisted', evidence_ref: 'work/transcript.raw.json', evidence_sha256: evidenceSha256 };
    task.calibration_sources.transcript = { path: 'work/transcript.raw.json', sha256: evidenceSha256, validation: 'passed' };
    task.execution.safe_checkpoint = 'asr_response_persisted'; await persistV5Task(directory, task);
    await crashFault(fault, 'after_response_persisted', task);
  }
  const transcript = exchangeTranscriptFromProvider(task, raw, snapshot);
  await writeStableJsonAtomic(path.join(directory, 'work/transcript.normalized.json'), transcript);
  const transcribedRelative = `output/${safeAudioStem(path.basename(media.original_path))}.transcribed.srt`;
  await writeFile0600(path.join(directory, transcribedRelative), srtFromTranscript(transcript));
  refreshDictionaryMatches(dictionarySnapshot, transcript.text);
  const matchedSnapshot = await writeDictionarySnapshotVersion(directory, dictionarySnapshot);
  await crashFault(fault, 'after_dictionary_matches_snapshot_written', task);
  task = await readV5Task(directory);
  task.dictionary_snapshot.path = matchedSnapshot.path;
  task.dictionary_snapshot.sha256 = matchedSnapshot.sha256;
  task.dictionary_snapshot.resolved = dictionarySnapshot.resolved;
  task.artifacts.transcript = { path: 'work/transcript.normalized.json', sha256: await sha256File(path.join(directory, 'work/transcript.normalized.json')), validation: 'passed' };
  task.artifacts.transcribed = { path: transcribedRelative, sha256: await sha256File(path.join(directory, transcribedRelative)), validation: 'passed' };
  task.execution.provider_calls.asr = { state: 'terminal', count: 1, outcome: 'response_persisted', evidence_ref: 'work/transcript.raw.json', evidence_sha256: task.execution.provider_calls.asr.evidence_sha256 };
  task.updated_at = new Date().toISOString(); await persistV5Task(directory, task);
  return { task, transcript, legacy: raw };
}

export async function executeV5Task(directory: string, dependencies: ExchangeRuntimeDependencies = {}, fault?: (point: V5FaultPoint, task: TaskRecordV5) => Promise<void> | void): Promise<TaskRecordV5> {
  let task = await readV5Task(directory);
  if (task.status !== 'running') throw new MercuryError('TASK_EXECUTION_STATE_INVALID', `v5 任务状态不能执行：${task.status}`);
  if (await sha256File(managed(directory, task.dictionary_snapshot.path)) !== task.dictionary_snapshot.sha256) throw new MercuryError('DICTIONARY_RECORD_INVALID', '词典快照 hash 与任务记录不一致。');
  const snapshot = await readVerifiedV5ModelSnapshot(directory, task);
  const dictionarySnapshot = await readStableJson(managed(directory, task.dictionary_snapshot.path), 'DICTIONARY_RECORD_INVALID') as ResolvedDictionarySnapshot;
  if (dictionarySnapshot.contract !== 'mercury.dictionary-snapshot/v1' || dictionarySnapshot.task_id !== task.identity.task_id) throw new MercuryError('DICTIONARY_RECORD_INVALID', '任务词典快照 identity 无效。');
  let normalizedReferenceText: string | null = null;
  if (task.inputs.reference) {
    if (!task.inputs.reference_normalized
      || await sha256File(managed(directory, task.inputs.reference.workspace_path)).catch(() => null) !== task.inputs.reference.sha256
      || await sha256File(managed(directory, task.inputs.reference_normalized.path)).catch(() => null) !== task.inputs.reference_normalized.sha256) {
      throw new MercuryError('REFERENCE_INPUT_INVALID', '参考字幕原件或规范化证据 hash 不一致；不会调用 Provider。');
    }
    normalizedReferenceText = await readFile(managed(directory, task.inputs.reference_normalized.path), 'utf8');
  }
  let transcript: ExchangeTranscriptV1;
  let legacy: TranscriptRaw;
  if (task.input_config.transcription_mode === 'provider') {
    const prepared = await prepareProviderTranscript(directory, task, snapshot, dictionarySnapshot, dependencies, fault);
    if (!prepared) return readV5Task(directory);
    task = prepared.task; transcript = prepared.transcript; legacy = prepared.legacy;
  } else {
    if (!task.artifacts.transcript || await sha256File(managed(directory, task.artifacts.transcript.path)) !== task.artifacts.transcript.sha256) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '规范化转录缺失或 hash 不一致。');
    transcript = assertExchangeContract('transcript', await readStableJson(managed(directory, task.artifacts.transcript.path), 'TRANSCRIPT_IMPORT_INVALID'));
    legacy = legacyTranscript(task, transcript, snapshot);
  }
  let calibration: CalibrationResultV3 | null = null;
  try {
    const referenceEvidenceText = normalizedReferenceText
      ?? (task.input_config.transcription_mode === 'provided' && task.calibration_sources.reference
        ? srtFromSegments(legacy.segments)
        : null);
    await assertCalibrationSourceEvidence(directory, task, legacy, referenceEvidenceText);
    const referenceText = referenceEvidenceText === null
      ? null
      : normalizeReferenceSrtForCalibration(referenceEvidenceText);
    const initial = preflight(task, legacy, snapshot, referenceText);
    if (initial.status !== 'completed' || initial.alignment === null) throw new MercuryError(initial.issues[0]?.code ?? 'ALIGNMENT_FAILED', initial.issues[0]?.message ?? '外部转录无法形成合法校验单元。');
    await writeStableJsonAtomic(path.join(directory, 'work/alignment.json'), initial.alignment);
    task.stage = 'calibrating'; task.execution.safe_checkpoint = 'chat_not_started'; task.updated_at = new Date().toISOString(); await persistV5Task(directory, task);
    task = await readV5Task(directory);
    if (task.execution.cancel_requested_at) return cancelV5AtBoundary(directory, task);
    if (task.execution.provider_calls.chat.evidence_ref && ['response_persisted', 'terminal'].includes(task.execution.provider_calls.chat.state)) {
      calibration = assertChatEvidenceIdentity(await readPinnedEvidence(directory, task.execution.provider_calls.chat, 'CALIBRATION_RESULT_INVALID'), task, snapshot);
    } else {
      const runtime = dependencies.chatRuntime ?? createChatCalibrationRuntimeV2(snapshot.models.chat, { ...dependencies, readCredential: dependencies.readCredential ?? readCredentialReference });
      const media = task.inputs.media;
      const verifiedAudioBytes = task.input_config.evidence_mode === 'audio_multimodal' && media
        ? await readVerifiedMediaBytes(directory, media)
        : null;
      const result = await runtime.run({
        taskId: task.identity.task_id, modelSnapshotRef: snapshot.snapshot_id, model: snapshot.models.chat, transcript: legacy, alignment: initial.alignment,
        referenceSrt: referenceText ? { pathRef: 'input/reference.srt', text: referenceText } : null, mode: referenceText ? task.input_config.calibration_mode : null, evidenceMode: task.input_config.evidence_mode,
        nonStrongReason: (snapshot.non_strong_reason as any) ?? null,
        dictionaryContext: {
          snapshot_refs: dictionarySnapshot.resolved.map(({ dictionary_id, revision, content_hash }) => ({ dictionary_id, revision, content_hash })),
          entries: dictionarySnapshot.entries.filter((entry) => dictionarySnapshot.chat_context_entry_ids.includes(entry.entry_id)).map((entry) => ({ entry_id: entry.entry_id, kind: entry.kind, canonical: entry.canonical, variants: entry.variants, language: entry.language, case_sensitive: entry.case_sensitive, number_sensitive: entry.number_sensitive, notes: entry.notes })),
        },
        audio: verifiedAudioBytes && media ? { sourcePath: managed(directory, media.workspace_path), verifiedBytes: verifiedAudioBytes, pathRef: media.workspace_path, sha256: media.sha256, bytes: media.bytes, durationMs: legacy.audio.duration_ms, mimeType: 'audio/mpeg' } : null,
        beforeProviderDispatch: async () => {
          task = await readV5Task(directory);
          if (task.execution.cancel_requested_at) throw new MercuryError('TASK_CANCELLED', '任务已请求取消，未调用 Chat。');
          task.execution.provider_calls.chat = { state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null, evidence_sha256: null };
          task.updated_at = new Date().toISOString(); await persistV5Task(directory, task);
          await crashFault(fault, 'after_dispatch_persisted', task);
          await appendV5Event(directory, task, 'provider_dispatched', `Chat 校验请求已发送；ASR 调用数为 ${task.execution.provider_calls.asr.count}。`, { capability: 'calibration', count: 1, asr_call_count: task.execution.provider_calls.asr.count });
        },
      });
      if (result.kind === 'failure') {
        task = await readV5Task(directory);
        if (task.execution.cancel_requested_at && task.execution.provider_calls.chat.state === 'not_started') {
          return cancelV5AtBoundary(directory, task);
        }
        const reportedCertainty = result.failure.provider_outcome_certainty;
        const certainty = reportedCertainty ?? (task.execution.provider_calls.chat.state === 'in_flight' ? 'outcome_unknown' : result.failure.call ? 'known_terminal' : 'not_dispatched');
        task.execution.provider_calls.chat = { state: certainty === 'outcome_unknown' ? 'in_flight' : 'terminal', count: task.execution.provider_calls.chat.count, outcome: certainty, evidence_ref: null, evidence_sha256: null };
        task.status = certainty === 'outcome_unknown' ? 'interrupted' : 'failed'; task.stage = null; task.execution.ended_at = new Date().toISOString();
        task.error = exchangeError(certainty === 'outcome_unknown' ? 'TASK_INTERRUPTED_PROVIDER_UNKNOWN' : result.failure.errors[0]!.code, result.failure.errors[0]!.message, certainty, result.failure.errors[0]!.message);
        return commitTerminalThenDerive(directory, task, snapshot, null, fault);
      }
      try {
        calibration = assertChatEvidenceIdentity(result.artifact, task, snapshot);
      } catch (error) {
        return settleReturnedArtifactInvalid(directory, snapshot, 'chat', error, fault);
      }
      await writeStableJsonAtomic(path.join(directory, 'work/calibration-response.json'), calibration);
      const evidenceSha256 = await sha256File(path.join(directory, 'work/calibration-response.json'));
      task = await readV5Task(directory);
      if (calibration.status === 'failed' && calibration.provider_outcome_certainty === 'outcome_unknown') {
        const issue = calibration.errors[0]! as { message: string };
        // A durable local failure artifact proves what Mercury observed, not
        // what the Provider ultimately did. Preserve both facts: pin the audit
        // evidence while the Provider call remains in_flight/outcome_unknown,
        // and terminate the task as unsafe to replay.
        task.execution.provider_calls.chat = {
          state: 'in_flight',
          count: 1,
          outcome: 'outcome_unknown',
          evidence_ref: 'work/calibration-response.json',
          evidence_sha256: evidenceSha256,
        };
        task.execution.safe_checkpoint = null;
        task.status = 'interrupted';
        task.stage = null;
        task.execution.ended_at = new Date().toISOString();
        task.error = exchangeError(
          'TASK_INTERRUPTED_PROVIDER_UNKNOWN',
          'Chat 请求已发送，但结果无法确认。',
          'outcome_unknown',
          issue.message,
        );
        return commitTerminalThenDerive(directory, task, snapshot, calibration, fault);
      }
      task.execution.provider_calls.chat = { state: 'response_persisted', count: 1, outcome: 'response_persisted', evidence_ref: 'work/calibration-response.json', evidence_sha256: evidenceSha256 };
      task.execution.safe_checkpoint = 'chat_response_persisted'; await persistV5Task(directory, task);
      await crashFault(fault, 'after_response_persisted', task);
      if (calibration.status === 'failed') {
        task.execution.provider_calls.chat = { state: 'terminal', count: 1, outcome: 'response_persisted', evidence_ref: 'work/calibration-response.json', evidence_sha256: evidenceSha256 };
        task.status = 'failed';
        task.stage = null; task.execution.ended_at = new Date().toISOString();
        const issue = calibration.errors[0]! as { code: string; message: string };
        task.error = TEXT_ONLY_HARD_LIMIT_CODES.has(issue.code)
          ? textOnlyHardLimitError(issue.code, issue.message, 'response_persisted')
          : exchangeError(issue.code, issue.message, 'response_persisted', issue.message);
        return commitTerminalThenDerive(directory, task, snapshot, calibration, fault);
      }
    }
    task = await readV5Task(directory);
    if (task.execution.cancel_requested_at) return cancelV5AtBoundary(directory, task);
    if (!calibration || calibration.status !== 'completed') throw new MercuryError('CALIBRATION_RESULT_INVALID', 'Chat 未形成完整可用的校验正文。');
    const subtitle = runSubtitleCore({
      transcript: legacy,
      calibrationResult: toLegacy(calibration),
      referenceSrtText: referenceText,
      requestedMode: referenceText ? task.input_config.calibration_mode : null,
      transcriptSourceMode: task.input_config.transcription_mode === 'provided' ? task.input_config.calibration_mode : null,
    });
    if (subtitle.status !== 'completed') throw new MercuryError(subtitle.issues[0]?.code ?? 'SUBTITLE_CORE_FAILED', subtitle.issues[0]?.message ?? '字幕规则应用失败。');
    for (const modification of subtitle.artifact.modifications.filter((entry) => entry.applied)) {
      const reference = modification.evidence.calibration_suggestion_ref;
      if (!reference) continue;
      const suggestion = calibration.suggestions.find((entry) => entry.suggestion_id === reference);
      if (suggestion) {
        suggestion.disposition = 'applied';
        suggestion.disposition_reason = 'accepted_by_rules';
        suggestion.modification_refs = [modification.modification_id];
      }
    }
    await writeStableJsonAtomic(path.join(directory, 'work/calibration-result.json'), calibration);
    await writeStableJsonAtomic(path.join(directory, 'work/transcript.calibrated.json'), subtitle.artifact);
    const stem = path.basename(task.artifacts.transcribed!.path).replace(/\.transcribed\.srt$/u, '');
    const calibratedRelative = `output/${stem}.calibrated.srt`;
    await writeFile0600(path.join(directory, calibratedRelative), serializeCalibratedSrt(subtitle.artifact));
    const audioDuration = task.inputs.media ? await readMp3DurationMs(managed(directory, task.inputs.media.workspace_path)) : (transcript.duration_ms ?? transcript.segments.at(-1)!.end_ms);
    const parsedBaseline = referenceText ? parseReferenceSrt(referenceText) : null;
    const textOnlyTimeline = parsedBaseline?.ok
      ? parsedBaseline.segments
      : task.input_config.transcription_mode === 'provided' && subtitle.artifact.mode === 'text-only'
        ? legacy.segments.map((segment, index) => ({ reference_segment_id: segment.segment_id, sequence: index + 1, start_ms: segment.start_ms, end_ms: segment.end_ms, text: segment.text }))
        : null;
    const validation = await validateSrtFile(path.join(directory, calibratedRelative), { audioDurationMs: audioDuration, expectedSegments: subtitle.artifact.segments, mode: subtitle.artifact.mode, referenceSegments: textOnlyTimeline });
    if (!validation.valid) throw new MercuryError('OUTPUT_VALIDATION_FAILED', validation.checks.filter((item) => item.status === 'failed').map((item) => item.message).join('; '));
    task = await readV5Task(directory);
    task.artifacts.calibrated = { path: calibratedRelative, sha256: await sha256File(path.join(directory, calibratedRelative)), validation: 'passed' };
    task.status = 'completed'; task.stage = null; task.execution.ended_at = new Date().toISOString(); task.execution.safe_checkpoint = 'outputs_validated';
    task.execution.provider_calls.chat = { state: 'terminal', count: Math.max(1, task.execution.provider_calls.chat.count), outcome: 'response_persisted', evidence_ref: task.execution.provider_calls.chat.evidence_ref, evidence_sha256: task.execution.provider_calls.chat.evidence_sha256 };
    task.error = null; task.review = { status: 'pending', pending_count: calibration.corrected_units.filter((unit) => unit.changed).length };
    return commitTerminalThenDerive(directory, task, snapshot, calibration, fault);
  } catch (error) {
    if (error instanceof SimulatedV5Crash) throw error;
    task = await readV5Task(directory);
    if (TERMINAL.has(task.status)) return task;
    if (task.execution.cancel_requested_at && !Object.values(task.execution.provider_calls).some((entry) => entry.state === 'in_flight')) {
      return cancelV5AtBoundary(directory, task);
    }
    const unknownRole = task.execution.provider_calls.asr.state === 'in_flight' ? 'ASR' : task.execution.provider_calls.chat.state === 'in_flight' ? 'Chat' : null;
    if (unknownRole) {
      task.status = 'interrupted'; task.error = exchangeError('TASK_INTERRUPTED_PROVIDER_UNKNOWN', `${unknownRole} 请求已发送，但结果无法确认。`, 'outcome_unknown', error instanceof Error ? error.message : String(error));
    } else {
      const code = error instanceof MercuryError ? error.code : 'TASK_PIPELINE_FAILED';
      const detail = error instanceof Error ? error.message : '本地处理失败。';
      task.status = 'failed'; task.error = code === 'REFERENCE_AUDIO_MISMATCH'
        ? referenceAudioMismatchError(detail, task.execution.provider_calls.chat.outcome)
        : TEXT_ONLY_HARD_LIMIT_CODES.has(code)
          ? textOnlyHardLimitError(code, detail, task.execution.provider_calls.chat.outcome)
          : exchangeError(code, detail, task.execution.provider_calls.chat.outcome, error instanceof Error ? error.message : null, 'runtime');
    }
    task.stage = null; task.execution.ended_at = new Date().toISOString(); return commitTerminalThenDerive(directory, task, snapshot, calibration, fault);
  }
}

async function cancelV5AtBoundary(directory: string, task: TaskRecordV5): Promise<TaskRecordV5> {
  const calibratedPath = task.artifacts.calibrated?.path;
  task.status = 'cancelled'; task.stage = null; task.execution.ended_at = new Date().toISOString(); task.artifacts.calibrated = null; task.artifacts.approved = null;
  if (calibratedPath) await rm(managed(directory, calibratedPath), { force: true });
  await persistV5Task(directory, task);
  return task;
}

async function artifact(root: string, identity: ExchangeTaskV1['artifacts'][number]['identity'], value: TaskRecordV5['artifacts']['transcript']): Promise<ExchangeTaskV1['artifacts'][number]> {
  if (!value) return { identity, exists: false, path: null, sha256: null, validation: 'unavailable' };
  const target = managed(root, value.path);
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) return { identity, exists: false, path: null, sha256: null, validation: 'unavailable' };
    const actual = await sha256File(target);
    return { identity, exists: true, path: target, sha256: actual, validation: actual === value.sha256 ? value.validation : 'unavailable' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { identity, exists: false, path: null, sha256: null, validation: 'unavailable' };
    throw error;
  }
}

export async function v5CancellationEventFacts(directory: string, task: TaskRecordV5): Promise<{
  message: string;
  data: { asr_call_count: number; chat_call_count: number; transcribed_available: boolean };
}> {
  const transcribed = await artifact(directory, 'transcribed_srt', task.artifacts.transcribed);
  const available = transcribed.exists && transcribed.validation === 'passed';
  return {
    message: available
      ? '任务已取消；纯转写字幕仍可使用。'
      : '任务已在下一个安全边界取消；尚未产生字幕文件。',
    data: {
      asr_call_count: task.execution.provider_calls.asr.count,
      chat_call_count: task.execution.provider_calls.chat.count,
      transcribed_available: available,
    },
  };
}

export async function projectV5Task(directory: string, input?: TaskRecordV5): Promise<ExchangeTaskV1> {
  const task = input ?? await readV5Task(directory);
  await readVerifiedV5ModelSnapshot(directory, task);
  if (task.artifacts.calibrated || task.execution.provider_calls.chat.evidence_ref) await verifyV5CalibrationSources(directory, task);
  let review = task.review;
  let approved = task.artifacts.approved;
  const reviewExists = await lstat(path.join(directory, 'review.json')).then((entry) => entry.isFile() && !entry.isSymbolicLink()).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (reviewExists) {
    const verified = await (await import('../review-v5.js')).readVerifiedV5Review(directory);
    review = { status: verified.status === 'approved' ? 'finalized' : verified.status === 'not_required' ? 'not_required' : verified.counts.pending === verified.counts.total ? 'pending' : 'in_progress', pending_count: verified.counts.pending };
    approved = verified.approved_artifact ? { path: verified.approved_artifact.path, sha256: verified.approved_artifact.sha256, validation: 'passed' } : null;
  }
  const artifacts = await Promise.all([
    artifact(directory, 'transcript', task.artifacts.transcript), artifact(directory, 'transcribed_srt', task.artifacts.transcribed),
    artifact(directory, 'calibrated_srt', task.artifacts.calibrated), artifact(directory, 'approved_srt', approved),
    artifact(directory, 'calibration_report', task.artifacts.report),
  ]);
  const visibleError = projectedTaskError(task.error);
  return assertExchangeContract('task', {
    contract: 'mercury.task/v1', task_id: task.identity.task_id, request_id: task.identity.request_id, revision: task.identity.revision, created_at: task.created_at, updated_at: task.updated_at,
    status: task.status, stage: task.stage, progress: null,
    worker: { status: task.status === 'running' ? 'active' : 'inactive', heartbeat_at: task.execution.heartbeat_at },
    pause: { allowed: false, reason: '0.3.0-alpha.1 尚未提供暂停。' }, cancel: { allowed: ['queued', 'running'].includes(task.status), reason: ['queued', 'running'].includes(task.status) ? null : '当前状态不能取消。' }, retry: { allowed: false, reason: '0.3.0-alpha.1 尚未提供安全重试。' },
    attempt: { attempt_id: task.execution.attempt_id, count: task.execution.attempt_count },
    artifacts,
    review, error: visibleError,
    next_action: task.status === 'queued' ? '任务已入队；查询不会启动 Worker。若 Worker 未运行，请显式执行 worker start。' : task.status === 'running' ? '任务正在后台处理，请稍后查询。' : task.status === 'completed' && ['finalized', 'not_required'].includes(review.status) ? '人工批准稿已生成，可以直接打开批准后字幕。' : task.status === 'completed' ? `校验后字幕已生成，还有 ${review.pending_count ?? 0} 项修改待人工审阅。` : task.status === 'interrupted' ? 'Provider 结果不确定；不要自动重试。' : task.status === 'cancelled' ? (artifacts.find((entry) => entry.identity === 'transcribed_srt')?.exists ? '任务已取消；纯转写字幕仍可使用。' : '任务已取消；尚未产生字幕文件。') : visibleError?.code === 'REFERENCE_AUDIO_MISMATCH' ? REFERENCE_AUDIO_MISMATCH_ACTION : visibleError && TEXT_ONLY_HARD_LIMIT_CODES.has(visibleError.code) ? TEXT_ONLY_HARD_LIMIT_ACTION : '按错误提示检查输入或模型配置。',
    source_schema_version: '5.0.0', capabilities: { pause: { supported: false, reason: 'Alpha.2 capability' }, resume: { supported: false, reason: 'Alpha.2 capability' }, retry: { supported: false, reason: 'Alpha.2 capability' }, review: { supported: true, reason: null }, dictionary_snapshot: { supported: true, reason: null }, provided_transcript: { supported: true, reason: null } }, extensions: {},
  });
}

export async function projectV5Result(directory: string, taskInput?: TaskRecordV5): Promise<ExchangeResultV1> {
  const task = taskInput ?? await readV5Task(directory);
  const view = await projectV5Task(directory, task);
  if (await sha256File(managed(directory, task.dictionary_snapshot.path)) !== task.dictionary_snapshot.sha256) throw new MercuryError('DICTIONARY_RECORD_INVALID', '词典快照 hash 与任务记录不一致。');
  const modelSnapshot = await readVerifiedV5ModelSnapshot(directory, task);
  return assertExchangeContract('result', {
    contract: 'mercury.result/v1', task_id: task.identity.task_id, status: task.status, attempt_id: task.execution.attempt_id, produced_at: task.updated_at,
    inputs: [task.inputs.media ? { kind: 'media', sha256: task.inputs.media.sha256, source: 'provided' } : null, task.inputs.transcript_source ? { kind: 'transcript', sha256: task.inputs.transcript_source.sha256, source: 'provided' } : null, task.inputs.reference ? { kind: 'reference', sha256: task.inputs.reference.sha256, source: 'reference' } : null].filter(Boolean),
    transcription: { mode: task.input_config.transcription_mode, asr_call_count: task.execution.provider_calls.asr.count, transcript_path: task.artifacts.transcript ? managed(directory, task.artifacts.transcript.path) : null, transcript_sha256: task.artifacts.transcript?.sha256 ?? null },
    dictionaries: await (async () => {
      const snapshot = await readStableJson(managed(directory, task.dictionary_snapshot.path), 'DICTIONARY_RECORD_INVALID') as ResolvedDictionarySnapshot;
      return { snapshots: task.dictionary_snapshot.resolved, conflict_count: snapshot.conflicts.length, match_count: snapshot.matched_entry_ids.length };
    })(), artifacts: view.artifacts,
    review: { status: view.review.status, pending_count: view.review.pending_count, approved: ['finalized', 'not_required'].includes(view.review.status) },
    calls: [{ provider: modelSnapshot.models.asr?.plugin_id ?? 'asr', capability: 'transcription', count: task.execution.provider_calls.asr.count, outcome: task.execution.provider_calls.asr.outcome }, { provider: modelSnapshot.models.chat.plugin_id, capability: 'calibration', count: task.execution.provider_calls.chat.count, outcome: task.execution.provider_calls.chat.outcome }],
    warnings: task.warnings, error: view.error, next_action: view.next_action, extensions: {},
  });
}

export async function writeV5Result(directory: string, task: TaskRecordV5): Promise<void> { await writeStableJsonAtomic(path.join(directory, 'result.json'), await projectV5Result(directory, task)); }

async function reconcileMisclassifiedChatOutcomeUnknown(
  directory: string,
  task: TaskRecordV5,
): Promise<TaskRecordV5> {
  const call = task.execution.provider_calls.chat;
  if (task.status !== 'failed'
    || call.state !== 'terminal'
    || call.outcome !== 'response_persisted'
    || !call.evidence_ref
    || !call.evidence_sha256) return task;
  try {
    const snapshot = await readVerifiedV5ModelSnapshot(directory, task);
    const calibration = assertChatEvidenceIdentity(
      await readPinnedEvidence(directory, call, 'CALIBRATION_RESULT_INVALID'),
      task,
      snapshot,
    );
    if (calibration.status !== 'failed'
      || calibration.provider_outcome_certainty !== 'outcome_unknown') return task;
    const repaired = structuredClone(task);
    repaired.status = 'interrupted';
    repaired.stage = null;
    repaired.execution.safe_checkpoint = null;
    repaired.execution.provider_calls.chat = {
      state: 'in_flight',
      count: call.count,
      outcome: 'outcome_unknown',
      evidence_ref: call.evidence_ref,
      evidence_sha256: call.evidence_sha256,
    };
    const issue = calibration.errors[0] as { message?: unknown } | undefined;
    repaired.error = exchangeError(
      'TASK_INTERRUPTED_PROVIDER_UNKNOWN',
      'Chat 请求已发送，但结果无法确认。',
      'outcome_unknown',
      typeof issue?.message === 'string' ? issue.message : null,
    );
    repaired.artifacts.report = null;
    repaired.identity.revision += 1;
    repaired.updated_at = new Date().toISOString();
    // This is an evidence-backed repair of an Alpha.1 development
    // misclassification. Normal task transitions still go through
    // persistV5Task and cannot replace one terminal state with another.
    await writeStableJsonAtomic(path.join(directory, 'task.json'), assertV5TaskRecord(repaired));
    return repaired;
  } catch {
    return task;
  }
}

async function ensureOutcomeUnknownAttemptCorrection(
  directory: string,
  task: TaskRecordV5,
): Promise<void> {
  const call = task.execution.provider_calls.chat;
  const attemptId = task.execution.attempt_id;
  if (task.status !== 'interrupted'
    || !attemptId
    || call.state !== 'in_flight'
    || call.outcome !== 'outcome_unknown'
    || !call.evidence_ref
    || !call.evidence_sha256) return;
  const attemptsPath = path.join(directory, 'attempts.jsonl');
  const records = await readFile(attemptsPath, 'utf8').then((source) => source
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { contract?: string; attempt_id?: string; status?: string }))
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
  const misclassified = records.some((entry) => entry.contract === 'mercury.attempt-result/v1'
    && entry.attempt_id === attemptId
    && entry.status === 'failed');
  const corrected = records.some((entry) => entry.contract === 'mercury.attempt-result-correction/v1'
    && entry.attempt_id === attemptId);
  if (!misclassified || corrected) return;
  await appendStableJsonLine(attemptsPath, {
    contract: 'mercury.attempt-result-correction/v1',
    task_id: task.identity.task_id,
    attempt_id: attemptId,
    corrected_at: task.updated_at,
    supersedes_status: 'failed',
    status: 'interrupted',
    reason_code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN',
    provider_evidence_ref: call.evidence_ref,
    provider_evidence_sha256: call.evidence_sha256,
    asr_call_count: task.execution.provider_calls.asr.count,
    chat_call_count: call.count,
    safe_checkpoint: task.execution.safe_checkpoint,
  });
}

export async function claimV5Job(workspace: string, job: BackgroundJobV1, workerId: string): Promise<TaskRecordV5 | null> {
  const directory = taskRoot(workspace, job.task_directory);
  return withTaskTransitionLock(directory, async () => {
    const currentJob = await readJob(workspace, job.task_id); const task = await readV5Task(directory);
    if (task.status !== 'queued' || currentJob.state !== 'queued' || task.execution.cancel_requested_at) return null;
    const at = new Date().toISOString(); task.status = 'running'; task.stage = 'preparing'; task.execution.started_at = at; task.execution.worker_id = workerId; task.execution.heartbeat_at = at; task.execution.attempt_id = `att-${randomBytes(8).toString('hex')}`; task.execution.attempt_count += 1; task.execution.safe_checkpoint = 'claimed';
    await persistV5Task(directory, task); currentJob.state = 'claimed'; currentJob.worker_id = workerId; currentJob.claim_token = randomBytes(16).toString('hex'); currentJob.updated_at = at; await writeJob(workspace, currentJob);
    await appendStableJsonLine(path.join(directory, 'attempts.jsonl'), { contract: 'mercury.attempt/v1', task_id: task.identity.task_id, attempt_id: task.execution.attempt_id, number: task.execution.attempt_count, started_at: at, transcription_mode: task.input_config.transcription_mode, asr_call_count: task.execution.provider_calls.asr.count });
    await appendV5Event(directory, task, 'worker_claimed', `后台 Worker 已开始处理${task.input_config.transcription_mode === 'provided' ? '外部转录' : 'Provider 转写'}任务。`, { attempt: task.execution.attempt_count, transcription_mode: task.input_config.transcription_mode }); return task;
  });
}

export async function finishV5Job(workspace: string, task: TaskRecordV5): Promise<void> {
  const directory = taskRoot(workspace, task.identity.task_directory);
  await withTaskTransitionLock(directory, async () => {
    const current = await readV5Task(directory);
    if (!TERMINAL.has(current.status)) throw new MercuryError('JOB_TASK_STATE_CONFLICT', 'v5 任务尚未终结。');
    const job = await readJob(workspace, current.identity.task_id);
    const attemptsPath = path.join(directory, 'attempts.jsonl');
    const attemptRecords = await readFile(attemptsPath, 'utf8').then((source) => source.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { contract?: string; attempt_id?: string })).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    if (!attemptRecords.some((entry) => entry.contract === 'mercury.attempt-result/v1' && entry.attempt_id === current.execution.attempt_id)) {
      await appendStableJsonLine(path.join(directory, 'attempts.jsonl'), {
        contract: 'mercury.attempt-result/v1', task_id: current.identity.task_id, attempt_id: current.execution.attempt_id,
        number: current.execution.attempt_count, ended_at: current.execution.ended_at, status: current.status,
        asr_call_count: current.execution.provider_calls.asr.count, chat_call_count: current.execution.provider_calls.chat.count,
        safe_checkpoint: current.execution.safe_checkpoint,
      });
    }
    if (job.state !== 'terminal') {
      job.state = 'terminal'; job.updated_at = new Date().toISOString(); await writeJob(workspace, job);
    }
  });
}

export async function cancelV5Task(workspace: string, task: TaskRecordV5): Promise<{ task: TaskRecordV5; pending: boolean }> {
  const directory = taskRoot(workspace, task.identity.task_directory);
  return withTaskTransitionLock(directory, async () => {
    const current = await readV5Task(directory); if (TERMINAL.has(current.status)) return { task: current, pending: false };
    current.execution.cancel_requested_at ??= new Date().toISOString();
    if (current.status === 'queued') {
      let cancelled = await cancelV5AtBoundary(directory, current);
      const event = await v5CancellationEventFacts(directory, cancelled);
      await appendV5Event(directory, cancelled, 'task_cancelled', event.message, event.data);
      cancelled = await readV5Task(directory);
      await writeV5Result(directory, cancelled);
      const job = await readJob(workspace, current.identity.task_id); job.state = 'terminal'; job.updated_at = new Date().toISOString(); await writeJob(workspace, job);
      return { task: cancelled, pending: false };
    }
    await persistV5Task(directory, current); return { task: current, pending: true };
  });
}

export async function readV5Events(directory: string, after = 0): Promise<ExchangeEventV1[]> { const task = await readV5Task(directory); return (await stableEvents(directory)).filter((event) => event.task_id === task.identity.task_id && event.sequence > after); }

export async function auditV5Job(workspace: string, listed: BackgroundJobV1): Promise<void> {
  const directory = taskRoot(workspace, listed.task_directory);
  await withTaskTransitionLock(directory, async () => {
    let task = await readV5Task(directory); const job = await readJob(workspace, listed.task_id);
    const eventRevision = (await stableEvents(directory)).at(-1)?.task_revision ?? 0;
    if (eventRevision > task.identity.revision) { task.identity.revision = eventRevision; task.updated_at = new Date().toISOString(); await persistV5Task(directory, task); }
    if (TERMINAL.has(task.status)) {
      task = await reconcileMisclassifiedChatOutcomeUnknown(directory, task);
      await ensureOutcomeUnknownAttemptCorrection(directory, task);
      let current = await ensureV5TerminalReport(directory, await readV5Task(directory));
      if (current.status === 'completed') {
        const reviewRuntime = await import('../review-v5.js');
        const review = await reviewRuntime.initializeV5Review(directory);
        if (review.status === 'not_required') await reviewRuntime.finalizeV5Review(directory);
        current = await readV5Task(directory);
      }
      const terminalType = current.status === 'completed' ? 'task_completed' : current.status === 'cancelled' ? 'task_cancelled' : current.status === 'interrupted' ? 'task_interrupted' : 'task_failed';
      const events = await stableEvents(directory);
      if (!events.some((event) => event.type === terminalType)) {
        const cancellation = current.status === 'cancelled' ? await v5CancellationEventFacts(directory, current) : null;
        await appendV5Event(directory, current, terminalType, cancellation?.message ?? '后台任务已在安全审计中确认终态。', cancellation?.data ?? {});
        current = await readV5Task(directory);
      }
      await writeV5Result(directory, current);
      const attemptsPath = path.join(directory, 'attempts.jsonl');
      const attemptRecords = await readFile(attemptsPath, 'utf8').then((source) => source.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { contract?: string; attempt_id?: string })).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      if (!attemptRecords.some((entry) => entry.contract === 'mercury.attempt-result/v1' && entry.attempt_id === current.execution.attempt_id)) {
        await appendStableJsonLine(attemptsPath, {
          contract: 'mercury.attempt-result/v1', task_id: current.identity.task_id, attempt_id: current.execution.attempt_id,
          number: current.execution.attempt_count, ended_at: current.execution.ended_at, status: current.status,
          asr_call_count: current.execution.provider_calls.asr.count, chat_call_count: current.execution.provider_calls.chat.count,
          safe_checkpoint: current.execution.safe_checkpoint,
        });
      }
      if (job.state !== 'terminal') { job.state = 'terminal'; job.updated_at = new Date().toISOString(); await writeJob(workspace, job); }
      return;
    }
    if (task.status === 'queued' && job.state === 'queued') return;
    const calls = Object.values(task.execution.provider_calls);
    const call = task.execution.provider_calls.chat;
    if (calls.some((entry) => entry.state === 'in_flight')) {
      task.status = 'interrupted'; task.stage = null; task.execution.ended_at = new Date().toISOString(); task.error = exchangeError('TASK_INTERRUPTED_PROVIDER_UNKNOWN', 'Worker 中断时 Provider 结果无法确认。', 'outcome_unknown'); job.state = 'terminal';
    } else {
      task.status = 'queued'; task.stage = null; task.execution.started_at = null; task.execution.worker_id = null; task.execution.heartbeat_at = null; task.execution.attempt_id = null;
      task.execution.safe_checkpoint = call.state === 'response_persisted' ? 'chat_response_persisted'
        : task.execution.provider_calls.asr.state === 'response_persisted' ? 'asr_response_persisted' : 'queued';
      job.state = 'queued'; job.worker_id = null; job.claim_token = null;
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
    if (Object.values(task.execution.provider_calls).some((entry) => entry.state === 'in_flight')) { task.status = 'interrupted'; task.error = exchangeError('TASK_INTERRUPTED_PROVIDER_UNKNOWN', '后台执行异常时 Provider 结果无法确认。', 'outcome_unknown'); job.state = 'terminal'; }
    else if (error instanceof MercuryError && ['ASR_ARTIFACT_INVALID', 'CALIBRATION_RESULT_INVALID', 'REFERENCE_INPUT_INVALID', 'DICTIONARY_RECORD_INVALID', 'MODEL_SNAPSHOT_INVALID'].includes(error.code)) {
      task.status = 'failed'; task.error = exchangeError(error.code, '已持久化的本地证据缺失、损坏或 identity 不一致；任务已安全停止，未重放 Provider。', 'response_persisted', error.message, 'security'); job.state = 'terminal';
    }
    else if (call.state === 'response_persisted' || task.execution.provider_calls.asr.state === 'response_persisted') { task.status = 'queued'; task.stage = null; task.execution.started_at = null; task.execution.worker_id = null; task.execution.heartbeat_at = null; task.execution.attempt_id = null; task.execution.safe_checkpoint = call.state === 'response_persisted' ? 'chat_response_persisted' : 'asr_response_persisted'; job.state = 'queued'; job.worker_id = null; job.claim_token = null; }
    else { task.status = 'failed'; task.error = exchangeError(error instanceof MercuryError ? error.code : 'WORKER_JOB_FAILED_BEFORE_PROVIDER', '后台任务在 Provider 调用前遇到内部错误；未自动重试。', 'not_dispatched'); job.state = 'terminal'; }
    task.stage = null; if (task.status !== 'queued') task.execution.ended_at = new Date().toISOString(); task.updated_at = new Date().toISOString(); job.updated_at = task.updated_at; await persistV5Task(directory, task); await writeJob(workspace, job); await writeV5Result(directory, task); return task.status === 'queued' ? 'requeued' : 'terminal';
  });
}
