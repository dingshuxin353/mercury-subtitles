import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MercuryError } from './errors.js';

export const WORKSPACE_DIRECTORY_NAME = 'mercury-workspace';
export const WORKSPACE_SUBDIRECTORIES = ['config', 'models', 'tasks', 'logs'] as const;

export function defaultWorkspaceRoot(homeDirectory = homedir()): string {
  return path.join(homeDirectory, WORKSPACE_DIRECTORY_NAME);
}

async function assertDirectoryOrMissing(target: string): Promise<void> {
  try {
    const entry = await lstat(target);
    if (!entry.isDirectory()) {
      throw new MercuryError('WORKSPACE_PATH_NOT_DIRECTORY', `工作区路径被非目录占用：${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function ensureWorkspace(workspaceRoot = defaultWorkspaceRoot()): Promise<string> {
  try {
    await assertDirectoryOrMissing(workspaceRoot);
    await mkdir(workspaceRoot, { recursive: true });
    for (const directory of WORKSPACE_SUBDIRECTORIES) {
      const target = path.join(workspaceRoot, directory);
      await assertDirectoryOrMissing(target);
      await mkdir(target, { recursive: true });
    }
    return workspaceRoot;
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new MercuryError('WORKSPACE_INITIALIZATION_FAILED', `无法初始化工作区 ${workspaceRoot}：${reason}`);
  }
}
