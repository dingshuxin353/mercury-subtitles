import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { MercuryError } from '../errors.js';

const execFileAsync = promisify(execFile);
const SELF_STARTED_AT_MS = Date.now() - Math.floor(process.uptime() * 1_000);

export interface OwnedLockRecord {
  version: 1;
  owner_token: string;
  pid: number;
  process_started_at_ms: number | null;
  acquired_at: string;
}

export interface OwnedLock {
  path: string;
  record: OwnedLockRecord;
  release(): Promise<void>;
}

export interface AcquireOwnedLockOptions {
  waitMs?: number;
  pollMs?: number;
  errorCode?: string;
  errorMessage?: string;
  now?: () => Date;
  processIdentity?: (pid: number) => Promise<number | null>;
}

async function defaultProcessIdentity(pid: number): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return SELF_STARTED_AT_MS;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 1_000,
      encoding: 'utf8',
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // A live process whose identity cannot be proven is treated conservatively as active.
    return Number.NaN;
  }
}

function isLockRecord(value: unknown): value is OwnedLockRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OwnedLockRecord>;
  return candidate.version === 1
    && typeof candidate.owner_token === 'string'
    && /^[a-f0-9]{32}$/.test(candidate.owner_token)
    && Number.isSafeInteger(candidate.pid)
    && candidate.pid! > 0
    && (candidate.process_started_at_ms === null || Number.isFinite(candidate.process_started_at_ms))
    && typeof candidate.acquired_at === 'string';
}

async function lockIsActive(
  record: OwnedLockRecord,
  identity: (pid: number) => Promise<number | null>,
): Promise<boolean> {
  const actual = await identity(record.pid);
  if (actual === null) return false;
  if (Number.isNaN(actual) || record.process_started_at_ms === null) return true;
  return Math.abs(actual - record.process_started_at_ms) <= 2_000;
}

async function recoverInactiveLock(
  target: string,
  identity: (pid: number) => Promise<number | null>,
): Promise<boolean> {
  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new MercuryError('LOCK_PATH_UNSAFE', `锁路径不是普通文件：${target}`);
  }
  let record: OwnedLockRecord | null = null;
  try {
    const parsed = JSON.parse(await readFile(target, 'utf8')) as unknown;
    if (isLockRecord(parsed)) record = parsed;
  } catch {}
  if (record && await lockIsActive(record, identity)) return false;
  // A newly-created empty/partial lock may still be written by its live creator.
  if (!record && Date.now() - entry.mtimeMs < 5_000) return false;
  const stale = `${target}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await rename(target, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  await rm(stale, { force: true });
  return true;
}

export async function acquireOwnedLock(
  target: string,
  options: AcquireOwnedLockOptions = {},
): Promise<OwnedLock> {
  const waitMs = options.waitMs ?? 1_000;
  const pollMs = options.pollMs ?? 10;
  const deadline = Date.now() + waitMs;
  const identity = options.processIdentity ?? defaultProcessIdentity;
  const now = options.now ?? (() => new Date());
  for (;;) {
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return null;
        throw error;
      },
    );
    if (handle) {
      const record: OwnedLockRecord = {
        version: 1,
        owner_token: randomBytes(16).toString('hex'),
        pid: process.pid,
        process_started_at_ms: await identity(process.pid),
        acquired_at: now().toISOString(),
      };
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(target, 0o600);
      return {
        path: target,
        record,
        async release() {
          try {
            const current = JSON.parse(await readFile(target, 'utf8')) as unknown;
            if (isLockRecord(current) && current.owner_token === record.owner_token) {
              await rm(target, { force: true });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        },
      };
    }
    const recovered = await recoverInactiveLock(target, identity);
    if (recovered) continue;
    if (Date.now() >= deadline) {
      throw new MercuryError(
        options.errorCode ?? 'RESOURCE_LOCKED',
        options.errorMessage ?? '资源正在由另一个 Mercury 进程更新，请稍后重试。',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function withOwnedLock<T>(
  target: string,
  operation: (lock: OwnedLock) => Promise<T>,
  options: AcquireOwnedLockOptions = {},
): Promise<T> {
  const lock = await acquireOwnedLock(target, options);
  try {
    return await operation(lock);
  } finally {
    await lock.release();
  }
}
