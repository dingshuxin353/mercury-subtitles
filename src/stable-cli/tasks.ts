import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExchangeEventV1, ExchangeResultV1, ExchangeTaskV1 } from '../contracts/index.js';
import { assertExchangeContract } from '../contracts/index.js';
import { MercuryError } from '../errors.js';
import { readTaskRecord, type TaskRecord } from '../tasks.js';
import { readTaskRecordV2, type TaskRecordV2 } from '../tasks-v2.js';
import { cancelBackgroundTask, taskMachineView } from '../background/runtime.js';
import { readTaskEvents } from '../background/storage.js';
import { projectMachineTaskToExchangeResult, projectMachineTaskToExchangeTask } from '../exchange/projection.js';

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

async function readCompatibleTask(directory: string): Promise<TaskRecord | TaskRecordV2> {
  const basic = await readTaskRecord(directory);
  const version = (basic as unknown as { schema_version?: string }).schema_version;
  return ['2.0.0', '3.0.0', '4.0.0'].includes(version ?? '') ? readTaskRecordV2(directory) : basic;
}

export async function listTasksReadOnly(workspaceRoot: string): Promise<Array<TaskRecord | TaskRecordV2>> {
  const root = await tasksRootIfPresent(workspaceRoot);
  if (!root) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const tasks: Array<TaskRecord | TaskRecordV2> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8}-.+$/u.test(entry.name)) continue;
    tasks.push(await readCompatibleTask(path.join(root, entry.name)));
  }
  return tasks.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.task_id.localeCompare(left.task_id));
}

export async function findTaskReadOnly(workspaceRoot: string, taskId: string): Promise<TaskRecord | TaskRecordV2> {
  if (!TASK_ID.test(taskId)) throw new MercuryError('TASK_ID_INVALID', `任务 ID 格式无效：${taskId}`, { exitCode: 2 });
  const tasks = (await listTasksReadOnly(workspaceRoot)).filter((task) => task.task_id === taskId);
  if (tasks.length === 0) throw new MercuryError('TASK_NOT_FOUND', `未找到任务：${taskId}`);
  if (tasks.length > 1) throw new MercuryError('TASK_ID_CONFLICT', `检测到重复任务 ID：${taskId}`, { exitCode: 3 });
  return tasks[0]!;
}

export async function stableTaskView(workspaceRoot: string, record: TaskRecord | TaskRecordV2): Promise<ExchangeTaskV1> {
  const machine = await taskMachineView(workspaceRoot, record as unknown as TaskRecordV2);
  return assertExchangeContract('task', projectMachineTaskToExchangeTask(machine, {
    sourceSchemaVersion: String((record as unknown as { schema_version?: string }).schema_version ?? '1.0.0'),
    updatedAt: record.updated_at,
  }));
}

export async function stableTaskResult(workspaceRoot: string, record: TaskRecord | TaskRecordV2): Promise<ExchangeResultV1> {
  const machine = await taskMachineView(workspaceRoot, record as unknown as TaskRecordV2);
  return assertExchangeContract('result', projectMachineTaskToExchangeResult(machine, { producedAt: record.updated_at }));
}

export async function stableCancelTask(workspaceRoot: string, record: TaskRecord | TaskRecordV2): Promise<{ pending: boolean; task: ExchangeTaskV1 }> {
  if ((record as unknown as { schema_version?: string }).schema_version !== '4.0.0') {
    throw new MercuryError('CONTRACT_UNSUPPORTED', '此历史任务不支持稳定取消。', { exitCode: 5 });
  }
  const cancelled = await cancelBackgroundTask(workspaceRoot, record as TaskRecordV2);
  return { pending: cancelled.pending, task: await stableTaskView(workspaceRoot, cancelled.task) };
}

export async function stableEventsAfter(workspaceRoot: string, record: TaskRecord | TaskRecordV2, after: number): Promise<ExchangeEventV1[]> {
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

export function taskCursor(task: TaskRecord | TaskRecordV2): string {
  return Buffer.from(`${task.created_at}\n${task.task_id}`, 'utf8').toString('base64url');
}

export function decodeTaskCursor(cursor: string): { createdAt: string; taskId: string } {
  try {
    const [createdAt, taskId, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('\n');
    if (!createdAt || !taskId || extra !== undefined || !TASK_ID.test(taskId) || Number.isNaN(Date.parse(createdAt))) throw new Error('invalid');
    return { createdAt, taskId };
  } catch {
    throw new MercuryError('CLI_ARGUMENT_INVALID', '任务列表 cursor 无效。', { exitCode: 2 });
  }
}
