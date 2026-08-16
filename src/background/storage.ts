import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  truncate,
} from 'node:fs/promises';
import path from 'node:path';
import { MercuryError } from '../errors.js';
import { writeJsonAtomic } from '../tasks.js';
import { assertV4Contract } from '../contracts/v4.js';
import {
  EVENT_CONTRACT_VERSION,
  type BackgroundJobV1,
  type BackgroundRequestV1,
  type TaskEventType,
  type TaskEventV1,
} from './types.js';
import { withOwnedLock, type AcquireOwnedLockOptions, type OwnedLock } from './owned-lock.js';

export const RUNTIME_DIRECTORIES = ['runtime', 'runtime/jobs', 'runtime/requests'] as const;

function inside(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '运行时路径越界。');
  }
  return resolved;
}

async function assertRealDirectory(target: string): Promise<void> {
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new MercuryError('WORKSPACE_PATH_NOT_DIRECTORY', `运行时路径不是普通目录：${target}`);
  }
}

export async function ensureRuntimeLayout(workspaceRoot: string): Promise<string> {
  for (const relative of RUNTIME_DIRECTORIES) {
    const target = inside(workspaceRoot, path.join(workspaceRoot, relative));
    try {
      await assertRealDirectory(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(target, { recursive: true, mode: 0o700 });
      await assertRealDirectory(target);
    }
    await chmod(target, 0o700);
  }
  return path.join(path.resolve(workspaceRoot), 'runtime');
}

export function requestIdHash(requestId: string): string {
  if (!/^[\p{L}\p{N}._:@/-]{1,200}$/u.test(requestId)) {
    throw new MercuryError(
      'REQUEST_ID_INVALID',
      'request ID 必须是 1–200 字符的不透明标识，且不能包含空白或控制字符。',
      { exitCode: 2 },
    );
  }
  return createHash('sha256').update(requestId, 'utf8').digest('hex');
}

export function jsonFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

async function readJson<T>(filePath: string, code: string): Promise<T> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not a regular file');
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError(code, `无法读取运行时记录：${path.basename(filePath)}`);
  }
}

export function requestRecordPath(workspaceRoot: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new MercuryError('REQUEST_ID_INVALID', '请求哈希无效。');
  return inside(workspaceRoot, path.join(workspaceRoot, 'runtime', 'requests', `${hash}.json`));
}

export function jobRecordPath(workspaceRoot: string, taskId: string): string {
  if (!/^tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/.test(taskId)) {
    throw new MercuryError('TASK_ID_INVALID', '任务 ID 无效。');
  }
  return inside(workspaceRoot, path.join(workspaceRoot, 'runtime', 'jobs', `${taskId}.json`));
}

export function requestLeasePath(workspaceRoot: string, hash: string): string {
  return `${requestRecordPath(workspaceRoot, hash)}.lease`;
}

export async function withRequestLease<T>(
  workspaceRoot: string,
  hash: string,
  operation: (lock: OwnedLock) => Promise<T>,
  options: AcquireOwnedLockOptions = {},
): Promise<T> {
  return withOwnedLock(requestLeasePath(workspaceRoot, hash), operation, {
    waitMs: 15_000,
    errorCode: 'REQUEST_RESERVATION_IN_PROGRESS',
    errorMessage: '同一 request ID 正在创建任务；请用相同 request ID 稍后重试。',
    ...options,
  });
}

export async function withTaskTransitionLock<T>(
  taskDirectory: string,
  operation: (lock: OwnedLock) => Promise<T>,
  options: AcquireOwnedLockOptions = {},
): Promise<T> {
  const root = path.resolve(taskDirectory);
  return withOwnedLock(inside(root, path.join(root, 'task.transition.lock')), operation, {
    waitMs: 5_000,
    errorCode: 'TASK_TRANSITION_LOCKED',
    errorMessage: '任务状态正在转换，请稍后重试。',
    ...options,
  });
}

export async function reserveRequest(
  workspaceRoot: string,
  record: BackgroundRequestV1,
): Promise<{ created: boolean; record: BackgroundRequestV1 }> {
  assertV4Contract('background-request', record);
  await ensureRuntimeLayout(workspaceRoot);
  const target = requestRecordPath(workspaceRoot, record.request_id_hash);
  const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).catch(
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      return null;
    },
  );
  if (!handle) return { created: false, record: await readRequest(workspaceRoot, record.request_id_hash) };
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, 0o600);
  return { created: true, record };
}

export async function readRequest(workspaceRoot: string, hash: string): Promise<BackgroundRequestV1> {
  const record = assertV4Contract('background-request', await readJson<BackgroundRequestV1>(requestRecordPath(workspaceRoot, hash), 'REQUEST_RECORD_INVALID'));
  if (record.request_id_hash !== hash) throw new MercuryError('REQUEST_RECORD_INVALID', '请求记录 identity 与文件名不一致。');
  return record;
}

export async function writeRequest(workspaceRoot: string, record: BackgroundRequestV1): Promise<void> {
  assertV4Contract('background-request', record);
  const target = requestRecordPath(workspaceRoot, record.request_id_hash);
  await writeJsonAtomic(target, record);
  await chmod(target, 0o600);
}

export async function readJob(workspaceRoot: string, taskId: string): Promise<BackgroundJobV1> {
  const record = assertV4Contract('background-job', await readJson<BackgroundJobV1>(jobRecordPath(workspaceRoot, taskId), 'JOB_RECORD_INVALID'));
  if (record.task_id !== taskId) throw new MercuryError('JOB_RECORD_INVALID', '后台 job identity 与文件名不一致。');
  return record;
}

export async function writeJob(workspaceRoot: string, record: BackgroundJobV1): Promise<void> {
  assertV4Contract('background-job', record);
  await ensureRuntimeLayout(workspaceRoot);
  const target = jobRecordPath(workspaceRoot, record.task_id);
  await writeJsonAtomic(target, record);
  await chmod(target, 0o600);
}

export async function listJobs(workspaceRoot: string): Promise<BackgroundJobV1[]> {
  const scan = await listJobsIsolated(workspaceRoot);
  if (scan.invalid.length > 0) {
    throw new MercuryError(scan.invalid[0]!.code, scan.invalid[0]!.message);
  }
  return scan.jobs;
}

export async function listJobsIsolated(workspaceRoot: string): Promise<{
  jobs: BackgroundJobV1[];
  invalid: Array<{ file: string; code: string; message: string }>;
}> {
  await ensureRuntimeLayout(workspaceRoot);
  const directory = path.join(workspaceRoot, 'runtime', 'jobs');
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.filter((entry) => entry.name.endsWith('.json'));
  const jobs: BackgroundJobV1[] = [];
  const invalid: Array<{ file: string; code: string; message: string }> = [];
  for (const entry of names) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      invalid.push({ file: entry.name, code: 'JOB_RECORD_INVALID', message: `后台 job 必须是普通文件：${entry.name}` });
      continue;
    }
    const taskId = entry.name.slice(0, -'.json'.length);
    if (!/^tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/.test(taskId)) {
      invalid.push({ file: entry.name, code: 'JOB_RECORD_INVALID', message: `后台 job 文件名无效：${entry.name}` });
      continue;
    }
    try {
      jobs.push(await readJob(workspaceRoot, taskId));
    } catch (error) {
      invalid.push({
        file: entry.name,
        code: error instanceof MercuryError ? error.code : 'JOB_RECORD_INVALID',
        message: error instanceof MercuryError ? error.message : '后台 job 无法安全读取。',
      });
    }
  }
  return { jobs, invalid };
}

export async function appendTaskEvent(
  taskDirectory: string,
  input: {
    taskId: string;
    sequence: number;
    type: TaskEventType;
    message: string;
    data?: Record<string, unknown>;
    occurredAt?: string;
  },
): Promise<TaskEventV1> {
  const root = path.resolve(taskDirectory);
  const expectedTaskId = path.basename(root).match(/^(tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8})-/)?.[1] ?? null;
  if (!expectedTaskId || input.taskId !== expectedTaskId) {
    throw new MercuryError('EVENT_LOG_INVALID', '任务事件 identity 与任务目录不一致。');
  }
  const target = inside(root, path.join(root, 'events.jsonl'));
  const lock = inside(root, path.join(root, 'events.append.lock'));
  return withOwnedLock(lock, async () => {
    await repairTrailingEventFragment(target);
    const previous = await readTaskEvents(root);
    const event: TaskEventV1 = {
      contract_version: EVENT_CONTRACT_VERSION,
      event_id: `evt-${randomBytes(8).toString('hex')}`,
      sequence: (previous.at(-1)?.sequence ?? 0) + 1,
      task_id: input.taskId,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      type: input.type,
      message: input.message.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 500),
      data: input.data ?? {},
    };
    assertV4Contract('task-event', event);
    const eventHandle = await open(target, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    try {
      await eventHandle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await eventHandle.sync();
    } finally {
      await eventHandle.close();
    }
    await chmod(target, 0o600);
    return event;
  }, {
    waitMs: 5_000,
    errorCode: 'EVENT_LOG_LOCKED',
    errorMessage: '任务事件正在写入，请稍后重试。',
  });
}

async function readEventSource(target: string): Promise<string | null> {
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not a regular file');
    return await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new MercuryError('EVENT_LOG_INVALID', '任务事件记录不可读。');
  }
}

function splitRecoverableEventSource(source: string): { complete: string; trailingCompleteWithoutNewline: boolean } {
  if (!source || source.endsWith('\n')) return { complete: source, trailingCompleteWithoutNewline: false };
  const lastNewline = source.lastIndexOf('\n');
  const prefix = lastNewline >= 0 ? source.slice(0, lastNewline + 1) : '';
  const tail = source.slice(lastNewline + 1);
  try {
    const parsed = JSON.parse(tail) as unknown;
    assertV4Contract('task-event', parsed);
    return { complete: source, trailingCompleteWithoutNewline: true };
  } catch {
    return { complete: prefix, trailingCompleteWithoutNewline: false };
  }
}

async function repairTrailingEventFragment(target: string): Promise<void> {
  const source = await readEventSource(target);
  if (source === null || source.endsWith('\n')) return;
  const recovered = splitRecoverableEventSource(source);
  if (recovered.trailingCompleteWithoutNewline) {
    const handle = await open(target, constants.O_APPEND | constants.O_WRONLY);
    try { await handle.writeFile('\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
    return;
  }
  await truncate(target, Buffer.byteLength(recovered.complete, 'utf8'));
  const handle = await open(target, constants.O_WRONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readTaskEvents(taskDirectory: string, afterSequence = 0): Promise<TaskEventV1[]> {
  const target = inside(taskDirectory, path.join(taskDirectory, 'events.jsonl'));
  const raw = await readEventSource(target);
  if (raw === null) return [];
  const source = splitRecoverableEventSource(raw).complete;
  const events: TaskEventV1[] = [];
  const expectedTaskId = path.basename(path.resolve(taskDirectory)).match(/^(tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8})-/)?.[1] ?? null;
  if (!expectedTaskId) throw new MercuryError('EVENT_LOG_INVALID', '任务目录 identity 无效。');
  let expected = 1;
  for (const line of source.split('\n').filter(Boolean)) {
    let event: TaskEventV1;
    try {
      event = JSON.parse(line) as TaskEventV1;
    } catch {
      throw new MercuryError('EVENT_LOG_INVALID', '任务事件记录包含无效 JSON。');
    }
    try {
      event = assertV4Contract('task-event', event);
    } catch {
      throw new MercuryError('EVENT_LOG_INVALID', '任务事件记录不符合合同。');
    }
    if (event.contract_version !== EVENT_CONTRACT_VERSION || event.sequence !== expected || event.task_id !== expectedTaskId) {
      throw new MercuryError('EVENT_LOG_INVALID', '任务事件 identity 或序号不连续。');
    }
    expected += 1;
    if (event.sequence > afterSequence) events.push(event);
  }
  return events;
}

export async function removeRuntimeFile(workspaceRoot: string, target: string): Promise<void> {
  await rm(inside(path.join(workspaceRoot, 'runtime'), target), { force: true });
}
