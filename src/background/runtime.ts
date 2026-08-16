import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { MercuryError } from '../errors.js';
import { loadModelRegistryV2 } from '../models-v2.js';
import { createTaskId, safeAudioStem, sha256File } from '../tasks.js';
import {
  createCalibrationTaskV2,
  isTaskRecordV2,
  persistTaskRecordV2,
  readTaskRecordV2,
  type CreateTaskOptionsV2,
  type TaskRecordV2,
} from '../tasks-v2.js';
import { ensureWorkspace } from '../workspace.js';
import {
  appendTaskEvent,
  ensureRuntimeLayout,
  jsonFingerprint,
  readTaskEvents,
  requestIdHash,
  reserveRequest,
  writeJob,
  writeRequest,
  readJob,
  jobRecordPath,
  withRequestLease,
  withTaskTransitionLock,
} from './storage.js';
import {
  JOB_CONTRACT_VERSION,
  REQUEST_CONTRACT_VERSION,
  type BackgroundJobV1,
  type BackgroundRequestV1,
  type MachineTaskView,
} from './types.js';
import { readVerifiedReview } from '../review.js';

export interface SubmitBackgroundOptions extends CreateTaskOptionsV2 {
  requestId: string;
}

export interface SubmitBackgroundResult {
  task: TaskRecordV2;
  request_id_hash: string;
  replayed: boolean;
}

export interface SubmitBackgroundDependencies {
  createTask?: typeof createCalibrationTaskV2;
  fault?: (
    point: 'task_created' | 'task_promoted' | 'queued_event_written' | 'job_written' | 'request_committed',
    task: TaskRecordV2,
  ) => Promise<void> | void;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function taskDirectoryPath(workspaceRoot: string, taskDirectory: string): string {
  const root = path.resolve(workspaceRoot, 'tasks');
  const target = path.resolve(root, taskDirectory);
  if (!target.startsWith(`${root}${path.sep}`)) throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '任务路径越界。');
  return target;
}

async function readReservedTask(workspaceRoot: string, record: BackgroundRequestV1): Promise<TaskRecordV2 | null> {
  if (!record.task_directory) return null;
  const directory = taskDirectoryPath(workspaceRoot, record.task_directory);
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new MercuryError('TASK_PATH_UNSAFE', '预留任务目录不是普通目录。');
    }
    const value = await readTaskRecordV2(directory);
    if (
      value.task_id !== record.task_id
      || value.task_directory !== record.task_directory
      || !isTaskRecordV2(value)
    ) {
      throw new MercuryError('REQUEST_RECORD_INVALID', '预留请求与任务 identity 不一致。');
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function removeRecoverablePartialTask(workspaceRoot: string, record: BackgroundRequestV1): Promise<void> {
  if (!record.task_directory) throw new MercuryError('REQUEST_RECORD_INVALID', '预留请求缺少任务目录。');
  const partial = taskDirectoryPath(workspaceRoot, record.task_directory);
  try {
    const entry = await lstat(partial);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MercuryError('TASK_RECORD_INVALID', '预留任务路径不安全。');
    await rm(partial, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readJobIfPresent(workspaceRoot: string, taskId: string): Promise<BackgroundJobV1 | null> {
  try {
    const entry = await lstat(jobRecordPath(workspaceRoot, taskId));
    if (!entry.isFile() || entry.isSymbolicLink()) throw new MercuryError('JOB_RECORD_INVALID', '后台 job 路径不安全。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return readJob(workspaceRoot, taskId);
}

async function normalizedFingerprint(options: SubmitBackgroundOptions): Promise<string> {
  const registry = await loadModelRegistryV2(options.workspaceRoot);
  const audio = path.resolve(options.audioPath);
  const srt = options.srtPath ? path.resolve(options.srtPath) : null;
  return jsonFingerprint({
    audio_sha256: await sha256File(audio),
    srt_sha256: srt ? await sha256File(srt) : null,
    mode: options.mode ?? (srt ? 'text-only' : null),
    asr_model: options.asrModelId ?? registry.defaults.asr,
    chat_model: options.chatModelId ?? registry.defaults.chat,
    source_language: 'zh-CN',
  });
}

export async function deriveBackgroundRequestId(
  options: Omit<SubmitBackgroundOptions, 'requestId'>,
  intent: string,
): Promise<{ request_id: string; input_fingerprint: string }> {
  if (!/^[a-zA-Z0-9._:-]{1,100}$/u.test(intent)) {
    throw new MercuryError('REQUEST_INTENT_INVALID', 'request intent 必须是 1–100 字符的非敏感稳定标签。', { exitCode: 2 });
  }
  const workspaceRoot = await ensureWorkspace(options.workspaceRoot);
  const inputFingerprint = await normalizedFingerprint({ ...options, workspaceRoot, requestId: 'derive-only' });
  const digest = createHash('sha256').update(`${intent}:${inputFingerprint}`, 'utf8').digest('hex');
  return { request_id: `req-${digest.slice(0, 40)}`, input_fingerprint: inputFingerprint };
}

function promoteToBackground(task: TaskRecordV2, at: string): TaskRecordV2 {
  task.schema_version = '4.0.0';
  task.updated_at = at;
  task.execution = {
    status: 'queued',
    stage: null,
    last_completed_stage: null,
    started_at: null,
    ended_at: null,
    execution_interrupted: false,
    queued_at: at,
    claimed_at: null,
    heartbeat_at: null,
    worker_id: null,
    attempt: 0,
    cancellation_requested_at: null,
    last_event_sequence: 0,
    safe_checkpoint: 'queued',
    provider_call: {
      asr: { state: 'not_started', evidence_ref: null },
      chat: { state: 'not_started', evidence_ref: null },
    },
  };
  return task;
}

export async function submitBackgroundTask(
  options: SubmitBackgroundOptions,
  dependencies: SubmitBackgroundDependencies = {},
): Promise<SubmitBackgroundResult> {
  const workspaceRoot = await ensureWorkspace(options.workspaceRoot);
  await ensureRuntimeLayout(workspaceRoot);
  const requestHash = requestIdHash(options.requestId);
  const fingerprint = await normalizedFingerprint({ ...options, workspaceRoot });
  const now = options.now ?? (() => new Date());
  const created = now();
  const taskId = createTaskId(created, options.randomHex ?? (() => randomBytes(4).toString('hex')));
  const stem = safeAudioStem(path.basename(options.audioPath));
  const directoryName = `${taskId}-${stem}`;
  const at = created.toISOString();
  return withRequestLease(workspaceRoot, requestHash, async (lease) => {
    const reservation: BackgroundRequestV1 = {
      contract_version: REQUEST_CONTRACT_VERSION,
      request_id_hash: requestHash,
      input_fingerprint: fingerprint,
      task_id: taskId,
      task_directory: directoryName,
      state: 'reserved',
      owner: {
        owner_token: lease.record.owner_token,
        pid: lease.record.pid,
        process_started_at_ms: lease.record.process_started_at_ms,
        lease_acquired_at: lease.record.acquired_at,
      },
      created_at: at,
      updated_at: at,
    };
    const reserved = await reserveRequest(workspaceRoot, reservation);
    if (reserved.record.input_fingerprint !== fingerprint) {
      throw new MercuryError(
        'REQUEST_ID_CONFLICT',
        '这个 request ID 已绑定到不同的输入；原任务未改变。',
        { remediation: '为新的输入生成新的 request ID，或用原 task ID 查询已有任务。' },
      );
    }
    if (reserved.record.state === 'committed') {
      const existing = await readReservedTask(workspaceRoot, reserved.record);
      if (!existing) throw new MercuryError('REQUEST_RECORD_INVALID', '请求记录已提交，但任务记录不存在；已停止以避免重复任务。');
      return { task: existing, request_id_hash: requestHash, replayed: true };
    }
    const ownedReservation: BackgroundRequestV1 = {
      ...reserved.record,
      owner: reservation.owner,
      updated_at: nowIso(now),
    };
    await writeRequest(workspaceRoot, ownedReservation);
    let task = await readReservedTask(workspaceRoot, ownedReservation);
    if (!task) {
      // Holding the owner lease proves that a previous creator is no longer active.
      // Only an incomplete directory with no task.json may be removed and rebuilt.
      await removeRecoverablePartialTask(workspaceRoot, ownedReservation);
      const fixedHex = ownedReservation.task_id.slice(-8);
      task = await (dependencies.createTask ?? createCalibrationTaskV2)({
        ...options,
        workspaceRoot,
        now: () => new Date(ownedReservation.created_at),
        randomHex: () => fixedHex,
      });
      if (task.task_id !== ownedReservation.task_id || task.task_directory !== ownedReservation.task_directory) {
        throw new MercuryError('REQUEST_RECORD_INVALID', '预留任务 identity 与创建结果不一致。');
      }
      await dependencies.fault?.('task_created', task);
    }
    const taskDirectory = taskDirectoryPath(workspaceRoot, task.task_directory);
    if (task.schema_version !== '4.0.0') {
      task = promoteToBackground(task, nowIso(now));
      await persistTaskRecordV2(taskDirectory, task);
      await dependencies.fault?.('task_promoted', task);
    }
    const events = await readTaskEvents(taskDirectory);
    if (events.length === 0) {
      const queuedEvent = await appendTaskEvent(taskDirectory, {
        taskId: task.task_id,
        sequence: 1,
        type: 'task_queued',
        message: '任务已加入本地后台队列。',
        occurredAt: task.execution.queued_at!,
      });
      task.execution.last_event_sequence = queuedEvent.sequence;
      await persistTaskRecordV2(taskDirectory, task);
      await dependencies.fault?.('queued_event_written', task);
    } else {
      task.execution.last_event_sequence = events.at(-1)!.sequence;
      await persistTaskRecordV2(taskDirectory, task);
    }
    const existingJob = await readJobIfPresent(workspaceRoot, task.task_id);
    if (existingJob) {
      if (existingJob.task_directory !== task.task_directory) {
        throw new MercuryError('JOB_RECORD_INVALID', '后台 job 与任务 identity 不一致。');
      }
    } else {
      const job: BackgroundJobV1 = {
        contract_version: JOB_CONTRACT_VERSION,
        task_id: task.task_id,
        task_directory: task.task_directory,
        state: 'queued',
        created_at: task.execution.queued_at!,
        updated_at: task.updated_at,
        claim_token: null,
        worker_id: null,
      };
      await writeJob(workspaceRoot, job);
    }
    await dependencies.fault?.('job_written', task);
    const committed: BackgroundRequestV1 = {
      ...ownedReservation,
      state: 'committed',
      owner: null,
      updated_at: task.updated_at,
    };
    await writeRequest(workspaceRoot, committed);
    await dependencies.fault?.('request_committed', task);
    return { task, request_id_hash: requestHash, replayed: !reserved.created };
  });
}

async function artifact(
  taskDirectory: string,
  relative: string | null,
  purpose: MachineTaskView['artifacts'][keyof MachineTaskView['artifacts']]['purpose'],
  expectedHash: string | null = null,
) {
  if (!relative) return { exists: false, path: null, purpose, validation: 'unavailable' as const };
  const root = path.resolve(taskDirectory);
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '任务产物路径越界。');
  try {
    const entry = await lstat(absolute);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not a regular file');
    const validHash = expectedHash === null || await sha256File(absolute) === expectedHash;
    return { exists: true, path: absolute, purpose, validation: validHash ? 'passed' as const : 'pending' as const };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, path: absolute, purpose, validation: 'pending' as const };
    }
    throw new MercuryError('TASK_ARTIFACT_INVALID', `任务产物不可安全读取：${relative}`);
  }
}

function remediation(task: TaskRecordV2, review?: MachineTaskView['review']): string {
  if (task.execution.status === 'queued') return '查询不会启动 Worker；先查询 worker status，若未运行则显式执行 worker start。不要重新提交任务。';
  if (task.execution.status === 'running') return '稍后再次查询；若 Worker 已停止，先查询 worker status，再显式执行 worker start。不要重新提交任务。';
  if (task.execution.status === 'interrupted') return 'Provider 结果不确定；不要自动重试，请先查看技术证据并由用户决定是否新建任务。';
  if (task.execution.status === 'cancelled') return '任务已取消；如仍需要字幕，请使用新的 request ID 创建任务。';
  if (task.execution.status === 'needs_input') return '检查输入或参考字幕后，使用新的 request ID 创建任务。';
  if (task.execution.status === 'failed') return task.error?.retryable ? '检查服务与模型状态后，由用户决定是否新建任务。' : '按错误提示修复配置或输入后，使用新的 request ID 创建任务。';
  if (review?.status === 'finalized') return '人工批准稿已生成，可以打开批准后字幕。';
  if (review?.status === 'not_required') return '本次没有需要人工决定的修改；批准稿已生成，可以直接打开。';
  if (review?.status === 'pending') return 'AI 校验结果已生成，可以开始人工审阅。';
  if (review?.status === 'in_progress' || review?.status === 'ready') return '人工审阅尚未完成，可以继续处理待决定修改。';
  if (review?.status === 'not_ready') return '处理结果已生成，但人工审阅尚未准备完成；请查看任务详情。';
  if (review?.status === 'invalid') return '审阅记录或批准稿校验失败；请查看技术详情，不要使用陈旧批准稿。';
  if (review?.status === 'unsupported') return '可以打开现有结果；此历史任务不支持当前人工审阅合同。';
  return '可以打开任务结果。';
}

export async function taskMachineView(workspaceRoot: string, candidate: TaskRecordV2): Promise<MachineTaskView> {
  const directory = taskDirectoryPath(workspaceRoot, candidate.task_directory);
  const task = candidate.schema_version === '4.0.0' ? await readTaskRecordV2(directory) : candidate;
  const transcribed = task.artifacts.subtitles?.transcribed?.path ?? task.artifacts.outputs.find((item) => item.endsWith('.transcribed.srt')) ?? null;
  const calibrated = task.artifacts.subtitles?.calibrated?.path ?? task.artifacts.outputs.find((item) => item.endsWith('.calibrated.srt')) ?? null;
  const execution = task.execution as TaskRecordV2['execution'] & { stage?: string | null; last_event_sequence?: number };
  let asr = '历史模型';
  let chat = '历史模型';
  try {
    const snapshot = JSON.parse(await readFile(path.join(directory, 'work', 'model-snapshot.json'), 'utf8')) as { models?: { asr?: { name?: string }; chat?: { name?: string } } };
    asr = snapshot.models?.asr?.name ?? asr;
    chat = snapshot.models?.chat?.name ?? chat;
  } catch {}
  let review: MachineTaskView['review'] = { status: 'unsupported', pending_count: null, problem: null };
  let reviewRecord: Awaited<ReturnType<typeof readVerifiedReview>>['review'] | null = null;
  if (task.schema_version === '4.0.0' && task.execution.status === 'completed') {
    try {
      const { review: record } = await readVerifiedReview(directory);
      reviewRecord = record;
      review = {
        status: record.status === 'approved' ? 'finalized' : record.status === 'not_required' ? 'not_required' : record.status,
        pending_count: record.counts.pending,
        problem: null,
      };
    } catch (error) {
      if (error instanceof MercuryError && error.code === 'REVIEW_NOT_READY') {
        review = { status: 'not_ready', pending_count: null, problem: null };
      } else {
        review = {
          status: 'invalid',
          pending_count: null,
          problem: { code: error instanceof MercuryError ? error.code : 'REVIEW_RECORD_INVALID', message: '审阅记录损坏或与来源不一致。' },
        };
      }
    }
  }
  const transcribedRecord = task.artifacts.subtitles?.transcribed ?? null;
  const calibratedRecord = task.artifacts.subtitles?.calibrated ?? null;
  const approvedFromReview = reviewRecord?.approved_artifact ?? null;
  const eventTail = task.schema_version === '4.0.0' ? (await readTaskEvents(directory)).at(-1)?.sequence ?? 0 : 0;
  const approvedArtifact = await artifact(directory, approvedFromReview?.path ?? null, 'approved_result', approvedFromReview?.sha256 ?? null);
  if (approvedFromReview && approvedArtifact.validation !== 'passed') {
    review = {
      status: 'invalid',
      pending_count: null,
      problem: { code: 'REVIEW_COMMIT_INCOMPLETE', message: '批准稿缺失或哈希不一致；未展示陈旧结果。' },
    };
  }
  return {
    task_id: task.task_id,
    display_name: task.inputs.audio.original_name,
    created_at: task.created_at,
    execution: {
      status: task.execution.status,
      stage: execution.stage ?? (['analyzing_audio', 'aligning', 'calibrating', 'segmenting', 'validating'].includes(task.execution.status) ? task.execution.status : null),
      summary: task.execution.status === 'completed' ? '处理完成' : task.execution.status === 'queued' ? '等待后台处理' : task.execution.status === 'running' ? '后台处理中' : task.execution.status,
    },
    review,
    models: { asr, chat, evidence_mode: task.input_config.evidence_mode ?? null },
    artifacts: {
      transcribed: await artifact(directory, transcribed, 'unverified_transcription', transcribedRecord?.sha256 ?? null),
      calibrated: await artifact(directory, calibrated, 'calibrated_result', calibratedRecord?.sha256 ?? null),
      approved: approvedArtifact,
      report: await artifact(directory, task.artifacts.report, 'calibration_report'),
    },
    error: task.error ? { code: task.error.code, message: task.error.message.replace(/\s*(?:Provider detail|provider detail)=.*$/iu, '').trim(), remediation: remediation(task) } : null,
    next_action: remediation(task, review),
    last_event_sequence: eventTail,
    historical: task.schema_version !== '4.0.0',
  };
}

export async function cancelBackgroundTask(
  workspaceRoot: string,
  task: TaskRecordV2,
  now = () => new Date(),
): Promise<{ task: TaskRecordV2; pending: boolean }> {
  if (task.schema_version !== '4.0.0') {
    throw new MercuryError('MACHINE_CONTRACT_UNAVAILABLE', '此历史任务不支持后台取消。');
  }
  const directory = taskDirectoryPath(workspaceRoot, task.task_directory);
  return withTaskTransitionLock(directory, async () => {
    const current = await readTaskRecordV2(directory);
    const terminal = ['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(current.execution.status);
    if (terminal) return { task: current, pending: false };
    const at = now().toISOString();
    const job = await readJob(workspaceRoot, current.task_id);
    current.execution.cancellation_requested_at ??= at;
    if (current.execution.status === 'queued') {
      current.execution.status = 'cancelled';
      current.execution.stage = null;
      current.execution.ended_at = at;
      current.updated_at = at;
      await persistTaskRecordV2(directory, current);
      job.state = 'terminal';
      job.updated_at = at;
      await writeJob(workspaceRoot, job);
      const requestedEvent = await appendTaskEvent(directory, {
        taskId: current.task_id,
        sequence: 0,
        type: 'cancellation_requested',
        message: '已记录取消请求。',
        occurredAt: at,
      });
      const cancelledEvent = await appendTaskEvent(directory, {
        taskId: current.task_id,
        sequence: 0,
        type: 'task_cancelled',
        message: '排队任务已取消，未调用 Provider。',
        occurredAt: at,
      });
      current.execution.last_event_sequence = Math.max(requestedEvent.sequence, cancelledEvent.sequence);
      await persistTaskRecordV2(directory, current);
      return { task: current, pending: false };
    }
    current.updated_at = at;
    await persistTaskRecordV2(directory, current);
    const requestedEvent = await appendTaskEvent(directory, {
      taskId: current.task_id,
      sequence: 0,
      type: 'cancellation_requested',
      message: '已记录取消请求；当前 Provider 调用返回后会在下一个安全边界停止。',
      occurredAt: at,
    });
    current.execution.last_event_sequence = requestedEvent.sequence;
    await persistTaskRecordV2(directory, current);
    return { task: current, pending: true };
  });
}
