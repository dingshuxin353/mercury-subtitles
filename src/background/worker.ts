import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { executeCalibrationTaskV2, type CoreIntegrationV2Dependencies } from '../core-integration-v2.js';
import { MercuryError } from '../errors.js';
import { persistTaskRecordV2, readTaskRecordV2, updateTaskRecordV2, type TaskRecordV2 } from '../tasks-v2.js';
import { writeJsonAtomic } from '../tasks.js';
import { finalizeReview, initializeReview } from '../review.js';
import {
  appendTaskEvent,
  ensureRuntimeLayout,
  listJobs,
  listJobsIsolated,
  readJob,
  readTaskEvents,
  withTaskTransitionLock,
  writeJob,
} from './storage.js';
import { acquireOwnedLock, type OwnedLock } from './owned-lock.js';
import {
  auditV5Job,
  appendV5Event,
  claimV5Job,
  containV5Failure,
  executeV5Task,
  finishV5Job,
  heartbeatV5Task,
  isV5TaskDirectory,
  readV5Task,
} from '../exchange/runtime.js';
import type { TaskRecordV5 } from '../contracts/generated/task-record-v5.js';
import { finalizeV5Review, initializeV5Review } from '../review-v5.js';

const HEARTBEAT_INTERVAL_MS = 2_000;
export const WORKER_STALE_AFTER_MS = 15_000;

export interface WorkerRecord {
  contract_version: 'mercury-worker-experimental-v1';
  worker_id: string;
  pid: number;
  started_at: string;
  heartbeat_at: string;
  state: 'starting' | 'idle' | 'running' | 'stopping';
  task_id: string | null;
  diagnostic_count?: number;
}

function workerPaths(workspaceRoot: string) {
  const runtime = path.join(path.resolve(workspaceRoot), 'runtime');
  return { runtime, lock: path.join(runtime, 'worker.lock'), record: path.join(runtime, 'worker.json') };
}

function taskDirectoryForJob(workspaceRoot: string, job: { task_id: string; task_directory: string }): string {
  const tasksRoot = path.resolve(workspaceRoot, 'tasks');
  const directory = path.resolve(tasksRoot, job.task_directory);
  if (!directory.startsWith(`${tasksRoot}${path.sep}`) || !job.task_directory.startsWith(`${job.task_id}-`)) {
    throw new MercuryError('JOB_RECORD_INVALID', '后台 job 与任务目录 identity 不一致。');
  }
  return directory;
}

function taskArtifactPath(taskDirectory: string, relative: string): string {
  const root = path.resolve(taskDirectory);
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '任务产物路径越界。');
  return target;
}

async function readBackgroundTaskForJob(workspaceRoot: string, job: { task_id: string; task_directory: string }): Promise<TaskRecordV2> {
  const task = await readTaskRecordV2(taskDirectoryForJob(workspaceRoot, job));
  if (task.schema_version !== '4.0.0' || task.task_id !== job.task_id || task.task_directory !== job.task_directory) {
    throw new MercuryError('JOB_RECORD_INVALID', '后台 job 与完整 v4 task identity 不一致。');
  }
  return task;
}

async function readWorkerRecord(workspaceRoot: string): Promise<WorkerRecord | null> {
  const target = workerPaths(workspaceRoot).record;
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not regular');
    return JSON.parse(await readFile(target, 'utf8')) as WorkerRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function workerStatus(workspaceRoot: string, now = Date.now()): Promise<{
  running: boolean;
  stale: boolean;
  worker: WorkerRecord | null;
}> {
  await ensureRuntimeLayout(workspaceRoot);
  const worker = await readWorkerRecord(workspaceRoot);
  if (!worker) return { running: false, stale: false, worker: null };
  const stale = worker.state === 'stopping' || now - new Date(worker.heartbeat_at).getTime() > WORKER_STALE_AFTER_MS || !processAlive(worker.pid);
  return { running: !stale, stale, worker };
}

export async function auditInterruptedTasks(workspaceRoot: string): Promise<Set<string>> {
  const scan = await listJobsIsolated(workspaceRoot);
  const diagnostics = [...scan.invalid];
  const quarantined = new Set<string>();
  for (const listedJob of scan.jobs) {
    try {
      const directory = taskDirectoryForJob(workspaceRoot, listedJob);
      if (await isV5TaskDirectory(directory)) {
        await auditV5Job(workspaceRoot, listedJob);
        const audited = await readV5Task(directory);
        if (audited.status === 'completed') {
          const review = await initializeV5Review(directory);
          if (review.status === 'not_required') await finalizeV5Review(directory);
        }
        continue;
      }
      await withTaskTransitionLock(directory, async () => {
      const job = await readJob(workspaceRoot, listedJob.task_id);
      const task = await readBackgroundTaskForJob(workspaceRoot, job);
      const terminal = ['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(task.execution.status);
      if (terminal) {
        if (job.state !== 'terminal') {
          job.state = 'terminal';
          job.updated_at = new Date().toISOString();
          await writeJob(workspaceRoot, job);
        }
        const events = await readTaskEvents(directory);
        if (!events.some((event) => ['task_completed', 'task_failed', 'task_cancelled', 'task_interrupted'].includes(event.type))) {
          const type = task.execution.status === 'completed' ? 'task_completed' : task.execution.status === 'cancelled' ? 'task_cancelled' : task.execution.status === 'interrupted' ? 'task_interrupted' : 'task_failed';
          await nextEvent(directory, task, type, '后台任务已在安全审计中确认终态。');
        }
        return;
      }
      if (job.state === 'terminal') {
        throw new MercuryError('JOB_TASK_STATE_CONFLICT', '非终态任务对应 terminal job；已停止以避免重复执行。');
      }
      const asr = task.execution.provider_call!.asr;
      const chat = task.execution.provider_call!.chat;
      const unknown = asr.state === 'in_flight' || chat.state === 'in_flight';
      const safelyQueued = asr.state === 'not_started' && chat.state === 'not_started';
      const responsePersisted = asr.state === 'response_persisted' || chat.state === 'response_persisted';
      if (task.execution.cancellation_requested_at && !unknown) {
        const at = new Date().toISOString();
        const keep = task.artifacts.subtitles?.transcribed?.path;
        for (const artifact of [task.artifacts.subtitles?.calibrated, task.artifacts.subtitles?.approved].filter(Boolean)) {
          await rm(taskArtifactPath(directory, artifact!.path), { force: true });
        }
        task.artifacts.outputs = keep ? task.artifacts.outputs.filter((item) => item === keep) : [];
        if (task.artifacts.subtitles) {
          task.artifacts.subtitles.calibrated = null;
          task.artifacts.subtitles.approved = null;
        }
        task.artifacts.report = null;
        delete task.artifacts.review;
        task.execution.status = 'cancelled';
        task.execution.stage = null;
        task.execution.ended_at = at;
        task.execution.execution_interrupted = false;
        task.updated_at = at;
        job.state = 'terminal';
        job.updated_at = at;
        await persistTaskRecordV2(directory, task);
        await writeJob(workspaceRoot, job);
        await nextEvent(directory, task, 'task_cancelled', '取消请求已在 Provider 安全边界生效。');
        return;
      }
      const mismatchedClaim = (job.state === 'claimed' && task.execution.status === 'queued')
        || (job.state === 'queued' && task.execution.status === 'running');
      if (task.execution.status === 'queued' && job.state === 'queued') return;
      if ((mismatchedClaim && safelyQueued) || (task.execution.status === 'running' && safelyQueued)) {
        task.execution.status = 'queued';
        task.execution.stage = null;
        task.execution.started_at = null;
        task.execution.worker_id = null;
        task.execution.claimed_at = null;
        task.execution.heartbeat_at = null;
        task.execution.safe_checkpoint = 'queued';
        job.state = 'queued';
        job.claim_token = null;
        job.worker_id = null;
      } else if (responsePersisted && !unknown) {
        task.execution.status = 'queued';
        task.execution.stage = null;
        task.execution.worker_id = null;
        task.execution.claimed_at = null;
        task.execution.heartbeat_at = null;
        task.execution.started_at = null;
        job.state = 'queued';
        job.claim_token = null;
        job.worker_id = null;
      } else {
        task.execution.status = 'interrupted';
        task.execution.execution_interrupted = true;
        task.execution.stage = null;
        task.execution.ended_at = new Date().toISOString();
        task.error = {
          error_id: `${task.task_id}-provider-unknown`,
          code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN',
          message: 'Worker 中断时 Provider 结果无法确认；为避免重复扣费，Mercury 不会自动重放。',
          stage: 'model_call',
          retryable: false,
        };
        task.failure_stage = 'model_call';
        job.state = 'terminal';
      }
      task.updated_at = new Date().toISOString();
      job.updated_at = task.updated_at;
      await persistTaskRecordV2(directory, task);
      await writeJob(workspaceRoot, job);
      if (task.execution.status === 'interrupted') {
        await nextEvent(directory, task, 'task_interrupted', task.error!.message, { code: task.error!.code });
      }
      });
    } catch (error) {
      quarantined.add(listedJob.task_id);
      diagnostics.push({
        file: `${listedJob.task_id}.json`,
        code: error instanceof MercuryError ? error.code : 'WORKER_AUDIT_RECORD_INVALID',
        message: error instanceof MercuryError ? error.message : '任务启动审计失败，已隔离此记录。',
      });
    }
  }
  await persistWorkerDiagnostics(workspaceRoot, diagnostics);
  return quarantined;
}

async function acquireWorkerLock(workspaceRoot: string): Promise<OwnedLock | null> {
  await ensureRuntimeLayout(workspaceRoot);
  try {
    const existing = await readWorkerRecord(workspaceRoot);
    return await acquireOwnedLock(workerPaths(workspaceRoot).lock, {
      waitMs: existing?.state === 'stopping' ? 3_000 : 0,
      pollMs: 5,
      errorCode: 'WORKER_ALREADY_RUNNING',
      errorMessage: '另一个 Mercury Worker 已持有运行锁。',
    });
  } catch (error) {
    if (error instanceof MercuryError && error.code === 'WORKER_ALREADY_RUNNING') return null;
    throw error;
  }
}

async function persistWorker(workspaceRoot: string, record: WorkerRecord): Promise<void> {
  const target = workerPaths(workspaceRoot).record;
  await writeJsonAtomic(target, record);
  await chmod(target, 0o600);
}

async function persistWorkerDiagnostics(
  workspaceRoot: string,
  diagnostics: Array<{ file: string; code: string; message: string }>,
): Promise<void> {
  const target = path.join(workerPaths(workspaceRoot).runtime, 'worker-diagnostics.json');
  await writeJsonAtomic(target, {
    contract_version: 'mercury-worker-diagnostics-v1',
    updated_at: new Date().toISOString(),
    issues: diagnostics.map((item) => ({
      file: path.basename(item.file),
      code: item.code,
      message: item.message.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 300),
    })),
  });
  await chmod(target, 0o600);
}

function sanitizedWorkerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/iu.test(key)),
  );
}

export async function startDetachedWorker(
  workspaceRoot: string,
  binPath = process.argv[1],
  options: { readyTimeoutMs?: number } = {},
): Promise<{ pid: number; ready: true }> {
  if (!binPath) throw new MercuryError('WORKER_START_FAILED', '无法确定 Mercury Worker 入口。');
  const child = spawn(process.execPath, [path.resolve(binPath), '__worker', '--workspace', path.resolve(workspaceRoot)], {
    detached: true,
    stdio: 'ignore',
    env: sanitizedWorkerEnvironment(),
    cwd: '/',
  });
  if (!child.pid) throw new MercuryError('WORKER_START_FAILED', '后台 Worker 启动失败。');
  child.unref();
  const pid = child.pid;
  const childState: {
    exited: { code: number | null; signal: NodeJS.Signals | null } | null;
    error: Error | null;
  } = { exited: null, error: null };
  child.once('error', (error) => { childState.error = error; });
  child.once('exit', (code, signal) => { childState.exited = { code, signal }; });
  const deadline = Date.now() + (options.readyTimeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    if (childState.error) throw new MercuryError('WORKER_START_FAILED', `后台 Worker 启动失败：${childState.error.message}`);
    if (childState.exited) throw new MercuryError('WORKER_START_FAILED', `后台 Worker 在 ready 前退出（code=${childState.exited.code ?? '-'}）。`);
    const status = await workerStatus(workspaceRoot);
    if (status.running && status.worker?.pid === pid && status.worker.state !== 'starting') {
      return { pid, ready: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new MercuryError('WORKER_START_FAILED', '后台任务已入队，但 Worker 未在启动时限内进入 ready；没有回退为同步执行。');
}

async function nextEvent(taskDirectory: string, task: TaskRecordV2, type: Parameters<typeof appendTaskEvent>[1]['type'], message: string, data: Record<string, unknown> = {}) {
  const sequence = (task.execution.last_event_sequence ?? 0) + 1;
  const event = await appendTaskEvent(taskDirectory, { taskId: task.task_id, sequence, type, message, data });
  task.execution.last_event_sequence = event.sequence;
  task.updated_at = new Date().toISOString();
  await persistTaskRecordV2(taskDirectory, task);
}

type WorkerFaultPoint =
  | 'after_task_claim_persisted'
  | 'after_job_claim_persisted'
  | 'after_claim'
  | 'after_execute'
  | 'after_review'
  | 'before_finish';

class SimulatedClaimCrash extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SimulatedClaimCrash';
  }
}

async function claimCrashFault(
  fault: ((point: WorkerFaultPoint, task: TaskRecordV2) => Promise<void> | void) | undefined,
  point: 'after_task_claim_persisted' | 'after_job_claim_persisted',
  task: TaskRecordV2,
): Promise<void> {
  try {
    await fault?.(point, task);
  } catch (error) {
    // These two hooks model abrupt process death for deterministic recovery tests.
    // Ordinary storage exceptions remain contained by the per-job boundary below.
    throw new SimulatedClaimCrash(error);
  }
}

async function claimJob(
  workspaceRoot: string,
  workerId: string,
  listedJob: Awaited<ReturnType<typeof listJobs>>[number],
  fault?: (point: WorkerFaultPoint, task: TaskRecordV2) => Promise<void> | void,
): Promise<TaskRecordV2 | null> {
  const directory = taskDirectoryForJob(workspaceRoot, listedJob);
  return withTaskTransitionLock(directory, async () => {
    const job = await readJob(workspaceRoot, listedJob.task_id);
    const task = await readBackgroundTaskForJob(workspaceRoot, job);
    if (task.execution.status !== 'queued' || task.execution.cancellation_requested_at || job.state !== 'queued') return null;
    const now = new Date().toISOString();
    task.execution.status = 'running';
    task.execution.stage = 'preparing';
    task.execution.claimed_at = now;
    task.execution.heartbeat_at = now;
    task.execution.worker_id = workerId;
    task.execution.attempt = (task.execution.attempt ?? 0) + 1;
    task.execution.safe_checkpoint = 'claimed';
    task.execution.started_at = now;
    task.updated_at = now;
    await persistTaskRecordV2(directory, task);
    await claimCrashFault(fault, 'after_task_claim_persisted', task);
    job.state = 'claimed';
    job.claim_token = randomBytes(16).toString('hex');
    job.worker_id = workerId;
    job.updated_at = now;
    await writeJob(workspaceRoot, job);
    await claimCrashFault(fault, 'after_job_claim_persisted', task);
    await nextEvent(directory, task, 'worker_claimed', '后台 Worker 已开始处理任务。', { attempt: task.execution.attempt });
    await nextEvent(directory, task, 'stage_started', '任务进入准备阶段。', { stage: 'preparing' });
    return task;
  });
}

async function finishJob(workspaceRoot: string, task: TaskRecordV2): Promise<void> {
  const directory = path.join(workspaceRoot, 'tasks', task.task_directory);
  await withTaskTransitionLock(directory, async () => {
    const current = await readTaskRecordV2(directory);
    if (!['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(current.execution.status)) {
      throw new MercuryError('JOB_TASK_STATE_CONFLICT', '任务尚未进入终态，不能终结后台 job。');
    }
    const job = await readJob(workspaceRoot, task.task_id);
    job.state = 'terminal';
    job.updated_at = new Date().toISOString();
    await writeJob(workspaceRoot, job);
  });
}

async function containJobFailure(
  workspaceRoot: string,
  listedJob: Awaited<ReturnType<typeof listJobs>>[number],
  error: unknown,
  allowLocalRequeue = true,
): Promise<'terminal' | 'requeued'> {
  const directory = taskDirectoryForJob(workspaceRoot, listedJob);
  return withTaskTransitionLock(directory, async () => {
    const task = await readTaskRecordV2(directory);
    const job = await readJob(workspaceRoot, listedJob.task_id);
    const at = new Date().toISOString();
    if (['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(task.execution.status)) {
      job.state = 'terminal';
      job.updated_at = at;
      await writeJob(workspaceRoot, job);
      return 'terminal';
    }
    const asr = task.execution.provider_call!.asr;
    const chat = task.execution.provider_call!.chat;
    const unknown = asr.state === 'in_flight' || chat.state === 'in_flight';
    const persisted = asr.state === 'response_persisted' || chat.state === 'response_persisted';
    if (unknown) {
      task.execution.status = 'interrupted';
      task.execution.execution_interrupted = true;
      task.execution.stage = null;
      task.execution.ended_at = at;
      task.error = {
        error_id: `${task.task_id}-provider-unknown`,
        code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN',
        message: '后台执行异常时 Provider 结果无法确认；Mercury 不会自动重放或建议直接重试。',
        stage: 'model_call',
        retryable: false,
      };
      task.failure_stage = 'model_call';
      job.state = 'terminal';
    } else if (persisted && allowLocalRequeue) {
      task.execution.status = 'queued';
      task.execution.stage = null;
      task.execution.started_at = null;
      task.execution.claimed_at = null;
      task.execution.heartbeat_at = null;
      task.execution.worker_id = null;
      task.execution.ended_at = null;
      task.execution.execution_interrupted = false;
      task.error = null;
      task.failure_stage = null;
      job.state = 'queued';
      job.claim_token = null;
      job.worker_id = null;
    } else if (persisted) {
      task.execution.status = 'failed';
      task.execution.stage = null;
      task.execution.ended_at = at;
      task.execution.execution_interrupted = false;
      task.error = {
        error_id: `${task.task_id}-local-recovery`,
        code: 'WORKER_LOCAL_RECOVERY_FAILED',
        message: 'Provider 响应已安全保存，但本地恢复再次失败；没有重新调用 Provider。',
        stage: 'execution',
        retryable: false,
      };
      task.failure_stage = 'execution';
      job.state = 'terminal';
    } else {
      task.execution.status = 'failed';
      task.execution.stage = null;
      task.execution.ended_at = at;
      task.error = {
        error_id: `${task.task_id}-worker-internal`,
        code: 'WORKER_JOB_FAILED_BEFORE_PROVIDER',
        message: `后台任务在 Provider 调用前遇到内部错误；未自动重试。${error instanceof MercuryError ? ` ${error.code}` : ''}`,
        stage: 'execution',
        retryable: false,
      };
      task.failure_stage = 'execution';
      job.state = 'terminal';
    }
    task.updated_at = at;
    job.updated_at = at;
    await persistTaskRecordV2(directory, task);
    await writeJob(workspaceRoot, job);
    const requeued = task.execution.status === 'queued';
    try {
      await nextEvent(
        directory,
        task,
        requeued ? 'task_requeued' : task.execution.status === 'interrupted' ? 'task_interrupted' : 'task_failed',
        requeued ? 'Provider 响应已持久化；本次 Worker 已停止该任务，后续只允许本地恢复。' : task.error!.message,
        requeued ? { safe_checkpoint: task.execution.safe_checkpoint } : { code: task.error!.code },
      );
    } catch {
      // The state/job pair is already durable. A damaged event log remains explicit to readers.
    }
    return requeued ? 'requeued' : 'terminal';
  });
}

async function heartbeatWorkerAndTask(
  workspaceRoot: string,
  worker: WorkerRecord,
  fault?: () => Promise<void> | void,
): Promise<void> {
  await fault?.();
  const at = new Date().toISOString();
  worker.heartbeat_at = at;
  await persistWorker(workspaceRoot, worker);
  if (!worker.task_id) return;
  const job = await readJob(workspaceRoot, worker.task_id);
  const directory = taskDirectoryForJob(workspaceRoot, job);
  if (await isV5TaskDirectory(directory)) {
    await heartbeatV5Task(workspaceRoot, worker.task_id, worker.worker_id, at);
    return;
  }
  await updateTaskRecordV2(directory, (task) => {
    if (task.execution.status === 'running' && task.execution.worker_id === worker.worker_id) {
      task.execution.heartbeat_at = at;
      task.updated_at = at;
    }
  });
}

export async function runWorker(
  workspaceRoot: string,
  dependencies: CoreIntegrationV2Dependencies = {},
  options: {
    idleExitMs?: number;
    now?: () => Date;
    heartbeatIntervalMs?: number;
    fault?: (point: WorkerFaultPoint, task: TaskRecordV2) => Promise<void> | void;
    lifecycleFault?: (point: 'after_empty_scan' | 'after_stopping_persisted') => Promise<void> | void;
    heartbeatFault?: () => Promise<void> | void;
  } = {},
): Promise<'acquired' | 'already_running'> {
  await ensureRuntimeLayout(workspaceRoot);
  const now = options.now ?? (() => new Date());
  const worker: WorkerRecord = {
    contract_version: 'mercury-worker-experimental-v1',
    worker_id: `wrk-${randomBytes(8).toString('hex')}`,
    pid: process.pid,
    started_at: now().toISOString(),
    heartbeat_at: now().toISOString(),
    state: 'starting',
    task_id: null,
  };
  const workerLock = await acquireWorkerLock(workspaceRoot);
  if (!workerLock) return 'already_running';
  const targets = workerPaths(workspaceRoot);
  let heartbeat: NodeJS.Timeout | null = null;
  let heartbeatChain: Promise<void> = Promise.resolve();
  let heartbeatError: unknown = null;
  const queueWorkerWrite = (includeTaskHeartbeat = false): Promise<void> => {
    const snapshot = structuredClone(worker);
    const operation = heartbeatChain.then(() => includeTaskHeartbeat
      ? heartbeatWorkerAndTask(workspaceRoot, snapshot, options.heartbeatFault)
      : persistWorker(workspaceRoot, snapshot));
    heartbeatChain = operation.catch((error) => { heartbeatError ??= error; });
    return operation;
  };
  try {
    await persistWorker(workspaceRoot, worker);
    const quarantined = await auditInterruptedTasks(workspaceRoot);
    worker.diagnostic_count = quarantined.size;
    worker.state = 'idle';
    await persistWorker(workspaceRoot, worker);
    heartbeat = setInterval(() => {
      worker.heartbeat_at = new Date().toISOString();
      void queueWorkerWrite(true).catch(() => undefined);
    }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    const localRecoveryAttempted = new Set<string>();
    for (;;) {
      await heartbeatChain;
      if (heartbeatError) throw heartbeatError;
      const scan = await listJobsIsolated(workspaceRoot);
      if (scan.invalid.length > 0) {
        worker.diagnostic_count = Math.max(worker.diagnostic_count ?? 0, quarantined.size + scan.invalid.length);
        await persistWorkerDiagnostics(workspaceRoot, scan.invalid);
      }
      const jobs = scan.jobs
        .filter((job) => job.state === 'queued' && !quarantined.has(job.task_id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const job = jobs[0];
      if (!job) {
        await options.lifecycleFault?.('after_empty_scan');
        worker.state = 'stopping';
        worker.task_id = null;
        await queueWorkerWrite();
        await options.lifecycleFault?.('after_stopping_persisted');
        const recheck = await listJobsIsolated(workspaceRoot);
        if (recheck.jobs.some((candidate) => candidate.state === 'queued' && !quarantined.has(candidate.task_id))) {
          worker.state = 'idle';
          await queueWorkerWrite();
          continue;
        }
        break;
      }
      let task: TaskRecordV2 | TaskRecordV5 | null;
      const directory = taskDirectoryForJob(workspaceRoot, job);
      const v5 = await isV5TaskDirectory(directory);
      try {
        task = v5
          ? await claimV5Job(workspaceRoot, job, worker.worker_id)
          : await claimJob(workspaceRoot, worker.worker_id, job, options.fault);
      } catch (error) {
        if (error instanceof SimulatedClaimCrash) throw error.cause;
        try {
          if (v5) await containV5Failure(workspaceRoot, job, error);
          else await containJobFailure(workspaceRoot, job, error);
        } catch (containError) {
          quarantined.add(job.task_id);
          worker.diagnostic_count = quarantined.size;
          await persistWorkerDiagnostics(workspaceRoot, [{
            file: `${job.task_id}.json`,
            code: containError instanceof MercuryError ? containError.code : 'WORKER_JOB_QUARANTINED',
            message: containError instanceof MercuryError ? containError.message : '损坏任务已隔离，其他任务继续。',
          }]);
        }
        worker.state = 'idle';
        worker.task_id = null;
        await queueWorkerWrite();
        continue;
      }
      if (!task) continue;
      worker.state = 'running';
      worker.task_id = 'identity' in task ? task.identity.task_id : task.task_id;
      await queueWorkerWrite();
      try {
        if (v5) {
          let finalTask = await executeV5Task(directory, dependencies);
          await heartbeatChain;
          if (heartbeatError) throw heartbeatError;
          if (finalTask.status === 'completed') {
            const review = await initializeV5Review(directory);
            if (review.status === 'not_required') await finalizeV5Review(directory);
            finalTask = await readV5Task(directory);
          }
          await appendV5Event(directory, finalTask, finalTask.status === 'completed' ? 'task_completed' : finalTask.status === 'cancelled' ? 'task_cancelled' : finalTask.status === 'interrupted' ? 'task_interrupted' : 'task_failed', finalTask.status === 'completed' ? '后台任务处理完成。' : '后台任务已结束，请查看状态和下一步。');
          if (finalTask.status === 'completed') await appendV5Event(directory, finalTask, 'review_ready', finalTask.review.status === 'finalized' ? '校验结果无需逐项决定，人工批准稿已生成。' : 'AI 校验已完成，可以开始人工审阅。');
          finalTask = await readV5Task(directory);
          await finishV5Job(workspaceRoot, finalTask);
          worker.state = 'idle';
          worker.task_id = null;
          await queueWorkerWrite();
          continue;
        }
        const v4Task = task as TaskRecordV2;
        await options.fault?.('after_claim', v4Task);
        let finalTask = await executeCalibrationTaskV2(directory, dependencies);
        await options.fault?.('after_execute', finalTask);
        await heartbeatChain;
        if (heartbeatError) throw heartbeatError;
        if (finalTask.execution.status === 'completed') {
          const review = await initializeReview(directory);
          if (review.status === 'not_required') await finalizeReview(directory);
          finalTask = await readTaskRecordV2(directory);
        }
        await options.fault?.('after_review', finalTask);
        await nextEvent(
          directory,
          finalTask,
          finalTask.execution.status === 'completed' ? 'task_completed' : finalTask.execution.status === 'cancelled' ? 'task_cancelled' : finalTask.execution.status === 'interrupted' ? 'task_interrupted' : 'task_failed',
          finalTask.execution.status === 'completed' ? '后台任务处理完成。' : '后台任务已结束，请查看状态和下一步。',
        );
        if (finalTask.execution.status === 'completed') {
          await nextEvent(directory, finalTask, 'review_ready', 'AI 校验已完成，可以开始人工审阅。');
          for (const artifact of [
            finalTask.artifacts.subtitles?.transcribed,
            finalTask.artifacts.subtitles?.calibrated,
            finalTask.artifacts.subtitles?.approved,
          ].filter(Boolean)) {
            await nextEvent(directory, finalTask, 'artifact_ready', `字幕产物已验证：${artifact!.purpose}。`, { purpose: artifact!.purpose, path: artifact!.path });
          }
        }
        await options.fault?.('before_finish', finalTask);
        await finishJob(workspaceRoot, finalTask);
      } catch (error) {
        try {
          const outcome = v5
            ? await containV5Failure(workspaceRoot, job, error)
            : await containJobFailure(workspaceRoot, job, error, !localRecoveryAttempted.has(job.task_id));
          if (outcome === 'requeued') localRecoveryAttempted.add(job.task_id);
        } catch (containError) {
          quarantined.add(job.task_id);
          worker.diagnostic_count = quarantined.size;
          await persistWorkerDiagnostics(workspaceRoot, [{
            file: `${job.task_id}.json`,
            code: containError instanceof MercuryError ? containError.code : 'WORKER_JOB_QUARANTINED',
            message: containError instanceof MercuryError ? containError.message : '损坏任务已隔离，其他任务继续。',
          }]);
        }
      }
      worker.state = 'idle';
      worker.task_id = null;
      await queueWorkerWrite();
    }
    if ((options.idleExitMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, options.idleExitMs));
    return 'acquired';
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await heartbeatChain;
    worker.state = 'stopping';
    worker.heartbeat_at = new Date().toISOString();
    await persistWorker(workspaceRoot, worker).catch(() => undefined);
    await workerLock.release();
  }
}
