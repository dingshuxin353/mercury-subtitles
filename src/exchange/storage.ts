import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, truncate } from 'node:fs/promises';
import path from 'node:path';
import { MercuryError } from '../errors.js';

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (typeof candidate !== 'object' || candidate === null) return candidate;
    if (seen.has(candidate)) throw new MercuryError('CONTRACT_INVALID', '稳定 JSON 不能包含循环引用。', { exitCode: 2 });
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    const normalized = Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])]));
    seen.delete(candidate);
    return normalized;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeStableJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(canonicalJson(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readStableJson(filePath: string, errorCode = 'CONTRACT_INVALID'): Promise<unknown> {
  try {
    const entry = await lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not regular');
    if (entry.size > 8 * 1024 * 1024) throw new Error('stable json too large');
    const source = await readFile(filePath, 'utf8');
    if (!source.endsWith('\n')) throw new Error('missing newline');
    const parsed = JSON.parse(source) as unknown;
    const queue: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
    let nodes = 0;
    while (queue.length > 0) {
      const current = queue.pop()!;
      nodes += 1;
      if (nodes > 20_000 || current.depth > 20) throw new Error('stable json resource limit exceeded');
      if (Array.isArray(current.value)) current.value.forEach((value) => queue.push({ value, depth: current.depth + 1 }));
      else if (typeof current.value === 'object' && current.value !== null) Object.values(current.value).forEach((value) => queue.push({ value, depth: current.depth + 1 }));
    }
    return parsed;
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError(errorCode, `稳定 JSON 无法安全读取：${path.basename(filePath)}`);
  }
}

export async function repairTrailingJsonlFragment(filePath: string): Promise<boolean> {
  let source: Buffer;
  try { source = await readFile(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (source.length === 0 || source.at(-1) === 0x0a) return false;
  const finalNewline = source.lastIndexOf(0x0a);
  const prefix = finalNewline < 0 ? Buffer.alloc(0) : source.subarray(0, finalNewline + 1);
  for (const [index, line] of prefix.toString('utf8').split('\n').filter(Boolean).entries()) {
    try { JSON.parse(line); } catch { throw new MercuryError('EVENT_LOG_INVALID', `事件日志中间第 ${index + 1} 行损坏，不能自动跳过。`); }
  }
  await truncate(filePath, finalNewline + 1);
  const handle = await open(filePath, constants.O_RDWR);
  try { await handle.sync(); } finally { await handle.close(); }
  return true;
}

export async function appendStableJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await repairTrailingJsonlFragment(filePath);
  const handle = await open(filePath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(JSON.parse(canonicalJson(value)))}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await chmod(filePath, 0o600);
}

export async function assertPathInsideRealRoot(root: string, candidate: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(candidate);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '路径超出 Mercury 管理目录。', { exitCode: 2 });
  }
  const rootReal = await realpath(absoluteRoot);
  let cursor = absoluteRoot;
  for (const component of path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) throw new MercuryError('TASK_PATH_UNSAFE', '路径祖先包含符号链接。', { exitCode: 2 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  const existingParent = await realpath(path.dirname(absolute)).catch(() => rootReal);
  if (existingParent !== rootReal && !existingParent.startsWith(`${rootReal}${path.sep}`)) {
    throw new MercuryError('TASK_PATH_UNSAFE', '路径真实父目录超出 Mercury 管理目录。', { exitCode: 2 });
  }
  return absolute;
}
