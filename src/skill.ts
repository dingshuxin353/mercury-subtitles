import { cp, lstat, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MercuryError } from './errors.js';
import { readProductVersion } from './version.js';

export const MERCURY_SKILL_NAME = 'mercury-subtitles';
export const MERCURY_SKILL_CONTRACT = 'mercury-cli-experimental-v1';
export const MERCURY_SKILL_SOURCE = 'dingshuxin353/mercury-subtitles';
export const MERCURY_SKILL_INSTALL_COMMAND =
  `npx skills add ${MERCURY_SKILL_SOURCE}`;

export type SkillInstallationKind =
  | 'project'
  | 'agents_global'
  | 'codex_legacy'
  | 'custom';

export interface SkillInstallationStatus {
  kind: SkillInstallationKind;
  path: string;
  safe: boolean;
  compatible: boolean;
}

function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(path.dirname(here)) === 'dist'
    ? path.resolve(here, '..', '..')
    : path.resolve(here, '..');
}

export function packagedSkillSource(): string {
  return path.join(packageRoot(), 'skills', MERCURY_SKILL_NAME);
}

/** Legacy target retained only for compatibility with `mercury skill install`. */
export function defaultSkillParent(homeDirectory = homedir()): string {
  return path.join(homeDirectory, '.codex', 'skills');
}

export function standardGlobalSkillParent(homeDirectory = homedir()): string {
  return path.join(homeDirectory, '.agents', 'skills');
}

async function pathEntry(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function ordinaryDirectory(target: string): Promise<boolean> {
  const entry = await pathEntry(target);
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

async function compatibleSkillDirectory(target: string): Promise<boolean> {
  const skillFile = path.join(target, 'SKILL.md');
  const references = path.join(target, 'references');
  const commandsFile = path.join(references, 'commands.md');
  const [skillEntry, referencesEntry, commandsEntry] = await Promise.all([
    pathEntry(skillFile),
    pathEntry(references),
    pathEntry(commandsFile),
  ]);
  if (
    !skillEntry?.isFile() || skillEntry.isSymbolicLink() ||
    !referencesEntry?.isDirectory() || referencesEntry.isSymbolicLink() ||
    !commandsEntry?.isFile() || commandsEntry.isSymbolicLink()
  ) return false;
  const [skill, commands] = await Promise.all([
    readFile(skillFile, 'utf8'),
    readFile(commandsFile, 'utf8'),
  ]);
  return (
    /^name:\s*mercury-subtitles\s*$/mu.test(skill) &&
    commands.includes(MERCURY_SKILL_CONTRACT)
  );
}

async function inspectInstallation(
  installPath: string,
  kind: SkillInstallationKind,
): Promise<SkillInstallationStatus | null> {
  const entry = await pathEntry(installPath);
  if (!entry) return null;
  const safe = entry.isDirectory() && !entry.isSymbolicLink();
  return {
    kind,
    path: installPath,
    safe,
    compatible: safe && await compatibleSkillDirectory(installPath),
  };
}

async function projectInstallations(
  currentDirectory: string,
  globalInstallPath: string,
): Promise<SkillInstallationStatus[]> {
  const installations: SkillInstallationStatus[] = [];
  let directory = path.resolve(currentDirectory);
  for (;;) {
    const candidate = path.join(
      directory,
      '.agents',
      'skills',
      MERCURY_SKILL_NAME,
    );
    const installation = candidate === globalInstallPath
      ? null
      : await inspectInstallation(candidate, 'project');
    if (installation) installations.push(installation);
    const parent = path.dirname(directory);
    if (parent === directory) return installations;
    directory = parent;
  }
}

function uniqueInstallations(
  installations: Array<SkillInstallationStatus | null>,
): SkillInstallationStatus[] {
  const seen = new Set<string>();
  return installations.filter((installation): installation is SkillInstallationStatus => {
    if (!installation || seen.has(installation.path)) return false;
    seen.add(installation.path);
    return true;
  });
}

export async function skillStatus(
  homeDirectory = homedir(),
  targetParent?: string,
  currentDirectory = process.cwd(),
) {
  const source = packagedSkillSource();
  if (!(await ordinaryDirectory(source))) {
    throw new MercuryError(
      'SKILL_SOURCE_UNAVAILABLE',
      '安装包中缺少 Mercury 字幕 Skill。',
    );
  }

  const legacyInstallPath = path.join(
    path.resolve(defaultSkillParent(homeDirectory)),
    MERCURY_SKILL_NAME,
  );
  const recommendedInstallPath = path.join(
    path.resolve(currentDirectory),
    '.agents',
    'skills',
    MERCURY_SKILL_NAME,
  );
  let installations: SkillInstallationStatus[];
  if (targetParent) {
    installations = uniqueInstallations([
      await inspectInstallation(
        path.join(path.resolve(targetParent), MERCURY_SKILL_NAME),
        'custom',
      ),
    ]);
  } else {
    const globalInstallPath = path.join(
      path.resolve(standardGlobalSkillParent(homeDirectory)),
      MERCURY_SKILL_NAME,
    );
    installations = uniqueInstallations([
      ...await projectInstallations(currentDirectory, globalInstallPath),
      await inspectInstallation(
        globalInstallPath,
        'agents_global',
      ),
      await inspectInstallation(legacyInstallPath, 'codex_legacy'),
    ]);
  }

  const selected = installations.find((item) => item.compatible)
    ?? installations[0]
    ?? null;
  const installed = installations.length > 0;
  const compatible = Boolean(selected?.compatible);
  const duplicateInstallations = installations.length > 1;
  const attentionRequired = duplicateInstallations || installations.some(
    (item) => !item.safe || !item.compatible,
  );

  return {
    skill_name: MERCURY_SKILL_NAME,
    product_version: await readProductVersion(),
    machine_contract: MERCURY_SKILL_CONTRACT,
    source_path: source,
    install_path: selected?.path ?? (
      targetParent
        ? path.join(path.resolve(targetParent), MERCURY_SKILL_NAME)
        : legacyInstallPath
    ),
    installed,
    compatible,
    update_required: installed && !compatible,
    install_method: selected?.kind ?? 'none',
    installations,
    duplicate_installations: duplicateInstallations,
    attention_required: attentionRequired,
    recommended_install_command: MERCURY_SKILL_INSTALL_COMMAND,
    recommended_install_path: recommendedInstallPath,
    legacy_install_path: legacyInstallPath,
  };
}

export async function installSkill(
  homeDirectory = homedir(),
  targetParent?: string,
  currentDirectory = process.cwd(),
) {
  const status = await skillStatus(
    homeDirectory,
    targetParent,
    currentDirectory,
  );
  if (status.installed) {
    if (status.compatible) {
      return { ...status, install_action: 'already_installed' as const };
    }
    throw new MercuryError(
      'SKILL_INSTALL_CONFLICT',
      `检测到已有但不兼容或不安全的 ${MERCURY_SKILL_NAME}；Mercury 不会覆盖或删除它。`,
      {
        remediation: targetParent
          ? `请先人工检查 ${status.install_path}。`
          : `请先人工检查 ${status.install_path}，再使用 ${MERCURY_SKILL_INSTALL_COMMAND} 管理标准安装。`,
      },
    );
  }

  // The old command remains usable for existing automation. New users should
  // install from the public repository through the standard Skills CLI.
  const installPath = targetParent
    ? status.install_path
    : status.legacy_install_path;
  const parent = path.dirname(installPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentEntry = await lstat(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new MercuryError(
      'SKILL_INSTALL_PATH_INVALID',
      'Skill 安装父目录不是安全的普通目录。',
    );
  }
  await cp(status.source_path, installPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return {
    ...await skillStatus(homeDirectory, targetParent, currentDirectory),
    install_action: 'installed_legacy' as const,
  };
}
