import { cp, lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MercuryError } from './errors.js';

export const MERCURY_SKILL_NAME = 'mercury-subtitles';
export const MERCURY_SKILL_CONTRACT = 'mercury-cli-experimental-v1';

function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(path.dirname(here)) === 'dist'
    ? path.resolve(here, '..', '..')
    : path.resolve(here, '..');
}

export function packagedSkillSource(): string {
  return path.join(packageRoot(), 'skills', MERCURY_SKILL_NAME);
}

export function defaultSkillParent(homeDirectory = homedir()): string {
  return path.join(homeDirectory, '.codex', 'skills');
}

async function ordinaryDirectory(target: string): Promise<boolean> {
  try {
    const entry = await lstat(target);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function skillStatus(homeDirectory = homedir(), targetParent?: string) {
  const source = packagedSkillSource();
  if (!(await ordinaryDirectory(source))) throw new MercuryError('SKILL_SOURCE_UNAVAILABLE', '安装包中缺少 Mercury 字幕 Skill。');
  const parent = path.resolve(targetParent ?? defaultSkillParent(homeDirectory));
  const installedPath = path.join(parent, MERCURY_SKILL_NAME);
  const installed = await ordinaryDirectory(installedPath);
  let compatible = false;
  if (installed) {
    const text = await readFile(path.join(installedPath, 'references', 'commands.md'), 'utf8').catch(() => '');
    compatible = text.includes(MERCURY_SKILL_CONTRACT);
  }
  return {
    skill_name: MERCURY_SKILL_NAME,
    product_version: '0.2.0-alpha.2',
    machine_contract: MERCURY_SKILL_CONTRACT,
    source_path: source,
    install_path: installedPath,
    installed,
    compatible,
    update_required: installed && !compatible,
  };
}

export async function installSkill(homeDirectory = homedir(), targetParent?: string) {
  const status = await skillStatus(homeDirectory, targetParent);
  if (status.installed) throw new MercuryError('SKILL_ALREADY_INSTALLED', `目标位置已有 ${MERCURY_SKILL_NAME}；Mercury 不会覆盖用户 Skill。`, { remediation: `请先检查 ${status.install_path}，确认后自行移走旧目录，再重新安装。` });
  const parent = path.dirname(status.install_path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentEntry = await lstat(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) throw new MercuryError('SKILL_INSTALL_PATH_INVALID', 'Skill 安装父目录不是安全的普通目录。');
  await cp(status.source_path, status.install_path, { recursive: true, errorOnExist: true, force: false });
  return skillStatus(homeDirectory, targetParent);
}
