import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewRecordV1 } from './contracts/index.js';
import type { ExchangeErrorV1 } from './contracts/generated/exchange-error-v1.js';
import type { ExchangeTaskV1 } from './contracts/generated/exchange-task-v1.js';
import type { TaskRecordV5 } from './contracts/generated/task-record-v5.js';
import { MercuryError } from './errors.js';
import { withOwnedLock } from './background/owned-lock.js';
import { canonicalJson, readStableJson } from './exchange/storage.js';
import { appendV5Event, persistV5Task, readV5Events, readV5Task, writeV5Result } from './exchange/runtime.js';

export type DeliveryFaultPoint = 'after_ready_persisted' | 'after_temp_synced' | 'after_final_committed' | 'after_task_committed' | 'after_event_committed';

export class SimulatedDeliveryCrash extends Error {
  constructor(readonly point: DeliveryFaultPoint, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SimulatedDeliveryCrash';
  }
}

interface DirectoryIdentity { real: string; dev: number; ino: number; mode: number }

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function modeOf(mode: number): number { return mode & 0o777; }

async function fireFault(fault: ((point: DeliveryFaultPoint) => Promise<void> | void) | undefined, point: DeliveryFaultPoint): Promise<void> {
  try { await fault?.(point); } catch (error) { throw new SimulatedDeliveryCrash(point, error); }
}

function deliveryError(
  code: string,
  message: string,
  category: ExchangeErrorV1['category'],
  detail: string | null = null,
  remediation = '工作区内的批准稿仍然安全；修复业务目录后执行 mercury task deliver <task-id> --json。本动作不会再次调用 Provider。',
): ExchangeErrorV1 {
  return {
    contract: 'mercury.error/v1', code, category, message,
    retryability: 'after_user_action', provider_outcome: 'not_applicable',
    remediation: [remediation],
    technical: detail ? { provider_code: null, log_id: null, detail: detail.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 1000) } : null,
    extensions: {},
  };
}

function asMercuryError(error: ExchangeErrorV1): MercuryError {
  return new MercuryError(error.code, error.message, { exitCode: error.category === 'security' ? 4 : error.category === 'conflict' ? 3 : 2, remediation: error.remediation[0] });
}

function reviewRevision(review: ReviewRecordV1): string {
  const material = {
    task_id: review.task_id,
    updated_at: review.updated_at,
    approved_sha256: review.approved_artifact?.sha256 ?? null,
    decisions: review.changes.map((change) => ({ change_id: change.change_id, decision: change.decision, final_text: change.final_text, decided_at: change.decided_at })),
  };
  return `rev-${digest(canonicalJson(material)).slice(0, 20)}`;
}

function safeStem(review: ReviewRecordV1): string {
  const source = path.basename(review.approved_artifact?.path ?? 'subtitle.approved.srt').replace(/\.approved\.srt$/u, '');
  const normalized = source.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '-').replace(/[. ]+$/gu, '').replace(/-+/gu, '-').slice(0, 60);
  return normalized || 'subtitle';
}

function finalPath(directory: string, task: TaskRecordV5, review: ReviewRecordV1): string {
  const hash = review.approved_artifact!.sha256;
  return path.join(directory, `${safeStem(review)}.${task.identity.task_id}.approved.${hash.slice(0, 12)}.srt`);
}

async function verifyDirectory(target: string, expected?: DirectoryIdentity): Promise<DirectoryIdentity> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target) throw asMercuryError(deliveryError('DELIVERY_DIRECTORY_INVALID', '业务输出目录必须是规范化绝对路径。', 'input'));
  const parsed = path.parse(target);
  let cursor = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const entry = await lstat(cursor).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) throw asMercuryError(deliveryError('DELIVERY_DIRECTORY_INVALID', '业务输出目录不存在，且 Mercury 只会创建最后一级叶目录。', 'input'));
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw asMercuryError(deliveryError('DELIVERY_PATH_UNSAFE', '业务输出目录或其祖先包含符号链接/非目录节点，已停止交付。', 'security'));
  }
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw asMercuryError(deliveryError('DELIVERY_PATH_UNSAFE', '业务输出目标不是安全的真实目录。', 'security'));
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) throw asMercuryError(deliveryError('DELIVERY_DIRECTORY_NOT_WRITABLE', '业务输出目录不属于当前用户，Mercury 不会写入。', 'input'));
  await access(target, constants.W_OK).catch(() => { throw asMercuryError(deliveryError('DELIVERY_DIRECTORY_NOT_WRITABLE', '业务输出目录不可写；请修复权限后执行本地交付。', 'input')); });
  const identity = { real: await realpath(target), dev: entry.dev, ino: entry.ino, mode: modeOf(entry.mode) };
  if (expected && (identity.real !== expected.real || identity.dev !== expected.dev || identity.ino !== expected.ino || identity.mode !== expected.mode)) {
    throw asMercuryError(deliveryError('DELIVERY_PATH_UNSAFE', '业务输出目录在交付期间发生替换或权限变化，已停止交付。', 'security'));
  }
  return identity;
}

async function ensureDirectory(target: string): Promise<DirectoryIdentity> {
  try { return await verifyDirectory(target); } catch (error) {
    if (!(error instanceof MercuryError) || error.code !== 'DELIVERY_DIRECTORY_INVALID') throw error;
  }
  const parent = path.dirname(target);
  if (parent === target) throw asMercuryError(deliveryError('DELIVERY_DIRECTORY_INVALID', '业务输出目录无效。', 'input'));
  await verifyDirectory(parent);
  try { await mkdir(target, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const identity = await verifyDirectory(target);
  if (identity.mode !== 0o700) throw asMercuryError(deliveryError('DELIVERY_PATH_UNSAFE', '新建业务输出目录权限不是 0700，已停止交付。', 'security'));
  return identity;
}

async function verifiedFile(target: string, sha256: string, requireMode = true): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || (requireMode && modeOf(before.mode) !== 0o600)) return false;
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || (requireMode && modeOf(opened.mode) !== 0o600)) return false;
    const bytes = await handle.readFile();
    const after = await lstat(target);
    return after.isFile() && !after.isSymbolicLink() && after.dev === opened.dev && after.ino === opened.ino && digest(bytes) === sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if (['ELOOP', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  } finally { await handle?.close().catch(() => undefined); }
}

async function verifyApproved(root: string, task: TaskRecordV5, review: ReviewRecordV1): Promise<{ bytes: Buffer; sha256: string }> {
  const approved = review.approved_artifact;
  if (!approved || !task.artifacts.approved || task.artifacts.approved.path !== approved.path || task.artifacts.approved.sha256 !== approved.sha256 || task.review.status === 'pending' || task.review.status === 'in_progress') {
    throw asMercuryError(deliveryError('DELIVERY_NOT_READY', '最终批准字幕尚未形成；请先完成审阅并 finalize。', 'conflict'));
  }
  const target = path.resolve(root, approved.path);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw asMercuryError(deliveryError('DELIVERY_PATH_UNSAFE', '批准稿路径越出任务工作区。', 'security'));
  const entry = await lstat(target).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink() || modeOf(entry.mode) !== 0o600) throw asMercuryError(deliveryError('DELIVERY_NOT_READY', '工作区批准稿缺失、类型不安全或权限不是 0600。', 'conflict'));
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw asMercuryError(deliveryError('DELIVERY_NOT_READY', '工作区批准稿不能以安全句柄读取。', 'conflict'));
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || modeOf(opened.mode) !== 0o600) throw asMercuryError(deliveryError('DELIVERY_NOT_READY', '工作区批准稿在读取前发生变化。', 'conflict'));
    bytes = await handle.readFile();
    const after = await lstat(target);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw asMercuryError(deliveryError('DELIVERY_NOT_READY', '工作区批准稿在读取期间发生变化。', 'conflict'));
  } finally { await handle.close(); }
  const sha256 = digest(bytes);
  if (sha256 !== approved.sha256) throw asMercuryError(deliveryError('DELIVERY_NOT_READY', '工作区批准稿 hash 与审阅事实不一致。', 'conflict'));
  return { bytes, sha256 };
}

function resetCurrent(task: TaskRecordV5, status: 'pending_review' | 'failed', error: ExchangeErrorV1 | null): void {
  if (!task.delivery) return;
  task.delivery.status = status; task.delivery.final_path = null; task.delivery.sha256 = null;
  task.delivery.validation = 'unavailable'; task.delivery.delivered_at = null; task.delivery.review_revision = null; task.delivery.error = error;
}

export function markDeliveryPendingReview(task: TaskRecordV5): void {
  if (task.delivery?.requested_directory) resetCurrent(task, 'pending_review', null);
}

async function ensureResultCurrent(root: string, task: TaskRecordV5): Promise<void> {
  const current = await readStableJson(path.join(root, 'result.json'), 'RESULT_RECORD_INVALID').catch(() => null) as null | { status?: unknown; produced_at?: unknown; delivery?: { status?: unknown; final_path?: unknown; sha256?: unknown; review_revision?: unknown } };
  if (current?.status === task.status
    && current.produced_at === task.updated_at
    && current.delivery?.status === task.delivery?.status
    && current.delivery?.final_path === task.delivery?.final_path
    && current.delivery?.sha256 === task.delivery?.sha256
    && current.delivery?.review_revision === task.delivery?.review_revision) return;
  await writeV5Result(root, task);
}

export async function deliverApprovedSrt(
  rootInput: string,
  review: ReviewRecordV1,
  options: { now?: () => Date; fault?: (point: DeliveryFaultPoint) => Promise<void> | void; throwOnFailure?: boolean } = {},
): Promise<TaskRecordV5> {
  const root = path.resolve(rootInput);
  return withOwnedLock(path.join(root, 'delivery.lock'), async () => {
    let task = await readV5Task(root);
    if (!task.delivery?.requested_directory) throw asMercuryError(deliveryError('DELIVERY_NOT_REQUESTED', '此任务没有请求业务目录交付。', 'input'));
    if (task.status !== 'completed') throw asMercuryError(deliveryError('DELIVERY_NOT_READY', '只有 completed 且批准稿已形成的任务才能交付。', 'conflict'));
    const approved = await verifyApproved(root, task, review);
    const revision = reviewRevision(review);
    const target = finalPath(task.delivery.requested_directory, task, review);
    try {
      if (task.delivery.status === 'delivered'
        && task.delivery.review_revision === revision
        && task.delivery.final_path === target
        && task.delivery.sha256 === approved.sha256
        && await verifiedFile(target, approved.sha256)) {
        const events = await readV5Events(root);
        if (!events.some((event) => event.type === 'approved_srt_delivered' && event.data.review_revision === revision)) {
          await appendV5Event(root, task, 'approved_srt_delivered', '最终批准字幕已交付到业务目录。', { review_revision: revision, sha256: approved.sha256, path: target });
        }
        await ensureResultCurrent(root, task);
        return task;
      }
      task.delivery = { ...task.delivery, status: 'ready', final_path: target, sha256: approved.sha256, validation: 'unavailable', delivered_at: null, review_revision: revision, error: null };
      await persistV5Task(root, task); await fireFault(options.fault, 'after_ready_persisted');

      const directoryIdentity = await ensureDirectory(task.delivery.requested_directory!);
      const temporary = path.join(task.delivery.requested_directory!, `.${path.basename(target)}.tmp-${revision}`);
      const targetEntry = await lstat(target).catch((error) => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error));
      if (targetEntry) {
        if (!await verifiedFile(target, approved.sha256)) throw asMercuryError(deliveryError('DELIVERY_CONFLICT', '确定性业务文件已存在，但类型、权限或内容与当前批准稿不同；Mercury 不会覆盖。', 'conflict'));
        await verifyDirectory(task.delivery.requested_directory!, directoryIdentity);
        if (await verifiedFile(temporary, approved.sha256)) await rm(temporary);
      } else {
        const tempEntry = await lstat(temporary).catch((error) => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error));
        if (!tempEntry) {
          const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
          try { await handle.writeFile(approved.bytes); await handle.sync(); } finally { await handle.close(); }
          await chmod(temporary, 0o600);
        } else if (!await verifiedFile(temporary, approved.sha256)) {
          throw asMercuryError(deliveryError('DELIVERY_CONFLICT', '交付临时路径存在不属于当前批准稿的内容；Mercury 不会覆盖或删除。', 'conflict'));
        }
        if (!await verifiedFile(temporary, approved.sha256)) throw new MercuryError('DELIVERY_FAILED', '交付临时文件回读校验失败。');
        await fireFault(options.fault, 'after_temp_synced');
        await verifyDirectory(task.delivery.requested_directory!, directoryIdentity);
        try { await link(temporary, target); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await verifiedFile(target, approved.sha256)) throw error;
        }
        const directoryHandle = await open(task.delivery.requested_directory!, constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        await fireFault(options.fault, 'after_final_committed');
        if (!await verifiedFile(target, approved.sha256)) throw asMercuryError(deliveryError('DELIVERY_CONFLICT', '业务文件提交后回读类型、权限或 hash 不一致。', 'conflict'));
        await verifyDirectory(task.delivery.requested_directory!, directoryIdentity);
        if (await verifiedFile(temporary, approved.sha256)) await rm(temporary);
      }

      const existing = task.delivery.history.find((entry) => entry.review_revision === revision);
      const deliveredAt = existing?.delivered_at ?? (options.now ?? (() => new Date()))().toISOString();
      const fact = { path: target, sha256: approved.sha256, review_revision: revision, delivered_at: deliveredAt };
      if (existing && canonicalJson(existing) !== canonicalJson(fact)) throw asMercuryError(deliveryError('DELIVERY_CONFLICT', '同一审阅 revision 的交付历史发生冲突。', 'conflict'));
      if (!existing) task.delivery.history.push(fact);
      task.delivery = { ...task.delivery, status: 'delivered', final_path: target, sha256: approved.sha256, validation: 'passed', delivered_at: deliveredAt, review_revision: revision, error: null };
      await persistV5Task(root, task); await fireFault(options.fault, 'after_task_committed');
      const events = await readV5Events(root);
      if (!events.some((event) => event.type === 'approved_srt_delivered' && event.data.review_revision === revision)) {
        await appendV5Event(root, task, 'approved_srt_delivered', '最终批准字幕已交付到业务目录。', { review_revision: revision, sha256: approved.sha256, path: target });
      }
      await fireFault(options.fault, 'after_event_committed');
      await ensureResultCurrent(root, task);
      return task;
    } catch (error) {
      if (error instanceof SimulatedDeliveryCrash) throw error;
      task = await readV5Task(root);
      const record = error instanceof MercuryError && error.code.startsWith('DELIVERY_')
        ? deliveryError(error.code, error.message, error.code === 'DELIVERY_PATH_UNSAFE' ? 'security' : error.code === 'DELIVERY_CONFLICT' ? 'conflict' : error.code === 'DELIVERY_FAILED' ? 'runtime' : 'input', error.message)
        : deliveryError('DELIVERY_FAILED', '业务目录交付失败；工作区批准稿仍然安全。', 'runtime', error instanceof Error ? error.message : String(error));
      if (task.delivery) {
        task.delivery.status = 'failed'; task.delivery.validation = 'unavailable'; task.delivery.delivered_at = null; task.delivery.error = record;
        await persistV5Task(root, task); await writeV5Result(root, task);
      }
      if (options.throwOnFailure !== false) throw asMercuryError(record);
      return task;
    }
  }, { waitMs: 15_000, errorCode: 'DELIVERY_CONFLICT', errorMessage: '另一项业务交付正在提交；请稍后读取任务状态。' });
}

export async function projectDeliveryReadOnly(task: TaskRecordV5): Promise<NonNullable<ExchangeTaskV1['delivery']>> {
  const delivery = task.delivery;
  if (!delivery) return { requested_directory: null, status: 'not_requested', final_path: null, sha256: null, validation: 'unavailable', delivered_at: null, review_revision: null, history: [], error: null, next_action: '此任务未请求业务目录交付。' };
  if (delivery.requested_directory && ['failed', 'cancelled', 'interrupted', 'needs_input'].includes(task.status)) {
    const error = deliveryError(
      'DELIVERY_NOT_READY',
      '任务未成功完成并形成当前批准稿；Mercury 不会向业务目录发布 transcribed 或 calibrated 字幕。',
      'conflict',
      null,
      '当前任务没有可交付的最终批准字幕。请按任务主错误处理；不要执行 task deliver，也不要重放当前任务。',
    );
    return { ...delivery, status: 'failed', final_path: null, sha256: null, validation: 'unavailable', delivered_at: null, review_revision: null, error, next_action: '当前任务不能发布最终字幕；业务目录没有新文件。请保留任务证据并按任务错误处理，不能用 task deliver 重放 Provider。' };
  }
  let status: NonNullable<ExchangeTaskV1['delivery']>['status'] = delivery.status;
  let error = delivery.error;
  let validation = delivery.validation;
  if (delivery.status === 'delivered' && (!delivery.final_path || !delivery.sha256 || !await verifiedFile(delivery.final_path, delivery.sha256))) {
    status = 'failed'; validation = 'unavailable'; error = deliveryError('DELIVERY_HISTORY_INVALID', '最新业务交付文件缺失、被替换、权限不安全或 hash 不一致。', 'security');
  }
  const nextAction = status === 'pending_review' ? '请完成当前人工审阅并 finalize；历史业务文件仍保持不变。'
    : status === 'ready' ? `批准稿已就绪；执行 mercury task deliver ${task.identity.task_id} --json 完成本地交付。`
      : status === 'delivered' ? `最新批准稿已交付：${delivery.final_path}`
        : status === 'failed' ? `工作区批准稿仍然安全；修复业务目录后执行 mercury task deliver ${task.identity.task_id} --json。本动作不会再次调用 Provider。`
          : '此任务未请求业务目录交付。';
  return { ...delivery, status, validation, error, next_action: nextAction };
}
