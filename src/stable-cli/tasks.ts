import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExchangeEventV1, ExchangeResultV1, ExchangeTaskV1 } from '../contracts/index.js';
import { assertExchangeContract } from '../contracts/index.js';
import { MercuryError } from '../errors.js';
import { readTaskRecord, type TaskRecord } from '../tasks.js';
import { readTaskRecordV2, type TaskRecordV2 } from '../tasks-v2.js';
import { cancelBackgroundTask, taskMachineView } from '../background/runtime.js';
import { readTaskEvents } from '../background/storage.js';
import { projectMachineTaskToExchangeResult, projectMachineTaskToExchangeTask } from '../exchange/projection.js';
import type { TaskRecordV5 } from '../contracts/generated/task-record-v5.js';
import { cancelV5Task, executeV5Retry, pauseV5Task, planV5Retry, projectV5Result, projectV5Task, readV5Events, readV5Task, resumeV5Task } from '../exchange/runtime.js';
import type { ExchangeRetryPlanV1 } from '../contracts/index.js';
import { readStableJson } from '../exchange/storage.js';
import { deliverCurrentV5Review } from '../review-v5.js';

const TASK_ID = /^tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$/u;

async function tasksRootIfPresent(workspaceRoot: string): Promise<string | null> {
  const target = path.join(workspaceRoot, 'tasks');
  try {
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new MercuryError('TASK_PATH_UNSAFE', 'tasks 必须是普通目录。');
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

type CompatibleTask = TaskRecord | TaskRecordV2 | TaskRecordV5;

function taskIdOf(task: CompatibleTask): string { return 'identity' in task ? task.identity.task_id : task.task_id; }
function taskDirectoryOf(task: CompatibleTask): string { return 'identity' in task ? task.identity.task_directory : task.task_directory; }
function createdAtOf(task: CompatibleTask): string { return task.created_at; }
function updatedAtOf(task: CompatibleTask): string { return task.updated_at; }

async function readCompatibleTask(directory: string): Promise<CompatibleTask> {
  try {
    const target = path.join(directory, 'task.json');
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8 * 1024 * 1024) throw new MercuryError('TASK_RECORD_INVALID', '任务记录不是安全的普通文件或超过大小限制。');
    const raw = JSON.parse(await readFile(target, 'utf8')) as { schema_version?: string };
    if (raw.schema_version === '5.0.0') return readV5Task(directory);
  } catch (error) {
    if (error instanceof MercuryError) throw error;
  }
  const basic = await readTaskRecord(directory);
  const version = (basic as unknown as { schema_version?: string }).schema_version;
  return ['2.0.0', '3.0.0', '4.0.0'].includes(version ?? '') ? readTaskRecordV2(directory) : basic;
}

export async function listTasksReadOnly(workspaceRoot: string): Promise<CompatibleTask[]> {
  const root = await tasksRootIfPresent(workspaceRoot);
  if (!root) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const tasks: CompatibleTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}-.+$/u.test(entry.name)) continue;
    tasks.push(await readCompatibleTask(path.join(root, entry.name)));
  }
  return tasks.sort((left, right) => createdAtOf(right).localeCompare(createdAtOf(left)) || taskIdOf(right).localeCompare(taskIdOf(left)));
}

export async function findTaskReadOnly(workspaceRoot: string, taskId: string): Promise<CompatibleTask> {
  if (!TASK_ID.test(taskId)) throw new MercuryError('TASK_ID_INVALID', `任务 ID 格式无效：${taskId}`, { exitCode: 2 });
  const tasks = (await listTasksReadOnly(workspaceRoot)).filter((task) => taskIdOf(task) === taskId);
  if (tasks.length === 0) throw new MercuryError('TASK_NOT_FOUND', `未找到任务：${taskId}`);
  if (tasks.length > 1) throw new MercuryError('TASK_ID_CONFLICT', `检测到重复任务 ID：${taskId}`, { exitCode: 3 });
  return tasks[0]!;
}

export async function stableTaskView(workspaceRoot: string, record: CompatibleTask): Promise<ExchangeTaskV1> {
  if ('identity' in record) return projectV5Task(path.join(workspaceRoot, 'tasks', record.identity.task_directory), record);
  const machine = await taskMachineView(workspaceRoot, record as unknown as TaskRecordV2);
  let requestId: string | null = null;
  try {
    const request = assertExchangeContract('request', await readStableJson(path.join(workspaceRoot, 'tasks', record.task_directory, 'request.json'), 'REQUEST_RECORD_INVALID'));
    requestId = request.request_id;
  } catch {}
  return assertExchangeContract('task', projectMachineTaskToExchangeTask(machine, {
    requestId,
    sourceSchemaVersion: String((record as unknown as { schema_version?: string }).schema_version ?? '1.0.0'),
    updatedAt: record.updated_at,
  }));
}

export async function stableTaskResult(workspaceRoot: string, record: CompatibleTask): Promise<ExchangeResultV1> {
  if ('identity' in record) return projectV5Result(path.join(workspaceRoot, 'tasks', record.identity.task_directory), record);
  const machine = await taskMachineView(workspaceRoot, record as unknown as TaskRecordV2);
  return assertExchangeContract('result', projectMachineTaskToExchangeResult(machine, { producedAt: record.updated_at }));
}

export async function stableCancelTask(workspaceRoot: string, record: CompatibleTask): Promise<{ pending: boolean; task: ExchangeTaskV1 }> {
  if ('identity' in record) {
    const cancelled = await cancelV5Task(workspaceRoot, record);
    return { pending: cancelled.pending, task: await stableTaskView(workspaceRoot, cancelled.task) };
  }
  if ((record as unknown as { schema_version?: string }).schema_version !== '4.0.0') {
    throw new MercuryError('CONTRACT_UNSUPPORTED', '此历史任务不支持稳定取消。', { exitCode: 5 });
  }
  const cancelled = await cancelBackgroundTask(workspaceRoot, record as TaskRecordV2);
  return { pending: cancelled.pending, task: await stableTaskView(workspaceRoot, cancelled.task) };
}

export async function stablePauseTask(workspaceRoot: string, record: CompatibleTask): Promise<{ pending: boolean; task: ExchangeTaskV1 }> {
  if (!('identity' in record)) throw new MercuryError('CONTRACT_UNSUPPORTED', '此历史任务不支持安全暂停；查询未做任何写入。', { exitCode: 5 });
  const paused = await pauseV5Task(workspaceRoot, record);
  return { pending: paused.pending, task: await stableTaskView(workspaceRoot, paused.task) };
}

export async function stableResumeTask(workspaceRoot: string, record: CompatibleTask): Promise<{ task: ExchangeTaskV1 }> {
  if (!('identity' in record)) throw new MercuryError('CONTRACT_UNSUPPORTED', '此历史任务不支持安全恢复；查询未做任何写入。', { exitCode: 5 });
  const resumed = await resumeV5Task(workspaceRoot, record);
  return { task: await stableTaskView(workspaceRoot, resumed) };
}

export async function stableRetryPlan(workspaceRoot: string, record: CompatibleTask): Promise<ExchangeRetryPlanV1> {
  if (!('identity' in record)) throw new MercuryError('CONTRACT_UNSUPPORTED', '此历史任务不支持安全 retry plan；查询未做任何写入。', { exitCode: 5 });
  return planV5Retry(path.join(workspaceRoot, 'tasks', record.identity.task_directory), record);
}

export async function stableRetryTask(workspaceRoot: string, record: CompatibleTask, planId: string): Promise<{ task: ExchangeTaskV1 }> {
  if (!('identity' in record)) throw new MercuryError('CONTRACT_UNSUPPORTED', '此历史任务不支持安全 retry；查询未做任何写入。', { exitCode: 5 });
  const retried = await executeV5Retry(workspaceRoot, record, planId);
  return { task: await stableTaskView(workspaceRoot, retried) };
}

export async function stableDeliverTask(workspaceRoot: string, record: CompatibleTask): Promise<{ task: ExchangeTaskV1; result: ExchangeResultV1 }> {
  if (!('identity' in record)) throw new MercuryError('CONTRACT_UNSUPPORTED', '此历史任务不支持业务目录交付；查询未做任何写入。', { exitCode: 5 });
  if (record.status !== 'completed' || !record.artifacts.approved) {
    throw new MercuryError('DELIVERY_NOT_READY', '当前任务没有可交付的最终批准字幕；业务目录不会产生新文件。', {
      exitCode: 3,
      remediation: '请按任务主错误处理，或在 completed 任务中先完成审阅并 finalize；不要执行 task deliver，也不要重放当前任务。',
    });
  }
  const directory = path.join(workspaceRoot, 'tasks', record.identity.task_directory);
  const delivered = await deliverCurrentV5Review(directory);
  return { task: await projectV5Task(directory, delivered), result: await projectV5Result(directory, delivered) };
}

export async function stableEventsAfter(workspaceRoot: string, record: CompatibleTask, after: number): Promise<ExchangeEventV1[]> {
  if ('identity' in record) return readV5Events(path.join(workspaceRoot, 'tasks', record.identity.task_directory), after);
  if ((record as unknown as { schema_version?: string }).schema_version !== '4.0.0') return [];
  const taskDirectory = path.join(workspaceRoot, 'tasks', record.task_directory);
  return (await readTaskEvents(taskDirectory, after)).map((event) => assertExchangeContract('event', {
    contract: 'mercury.event/v1', event_id: event.event_id, task_id: event.task_id, sequence: event.sequence,
    occurred_at: event.occurred_at, type: event.type,
    severity: event.type === 'task_failed' || event.type === 'task_interrupted' ? 'error' : event.type === 'cancellation_requested' ? 'warning' : 'info',
    task_revision: event.sequence, attempt_id: null,
    stage: event.type.startsWith('stage_') && typeof (event.data as Record<string, unknown>).stage === 'string'
      ? String((event.data as Record<string, unknown>).stage)
      : null,
    progress: null, message: event.message, data: event.data, extensions: {},
  }));
}

export function taskCursor(task: CompatibleTask): string {
  return Buffer.from(`${createdAtOf(task)}\n${taskIdOf(task)}`, 'utf8').toString('base64url');
}

export { taskIdOf, taskDirectoryOf, createdAtOf, updatedAtOf };

export function decodeTaskCursor(cursor: string): { createdAt: string; taskId: string } {
  try {
    const [createdAt, taskId, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('\n');
    if (!createdAt || !taskId || extra !== undefined || !TASK_ID.test(taskId) || Number.isNaN(Date.parse(createdAt))) throw new Error('invalid');
    return { createdAt, taskId };
  } catch {
    throw new MercuryError('CLI_ARGUMENT_INVALID', '任务列表 cursor 无效。', { exitCode: 2 });
  }
}
