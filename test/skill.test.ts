import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  installSkill,
  MERCURY_SKILL_INSTALL_COMMAND,
  packagedSkillSource,
  skillStatus,
} from '../src/skill.js';

const roots: string[] = [];
afterEach(async () => Promise.all(
  roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
));

async function isolatedContext(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const currentDirectory = path.join(project, 'nested');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(currentDirectory, { recursive: true }),
  ]);
  return { root, home, project, currentDirectory };
}

async function copyPackagedSkill(parent: string): Promise<string> {
  const destination = path.join(parent, 'mercury-subtitles');
  await mkdir(parent, { recursive: true });
  await cp(packagedSkillSource(), destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return destination;
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

describe('V02-D004 packaged Mercury skill', () => {
  it('reports the standard Skills CLI command without changing a fresh HOME', async () => {
    const { home, currentDirectory } = await isolatedContext('mercury-skill-status-');
    const status = await skillStatus(home, undefined, currentDirectory);
    expect(status).toMatchObject({
      installed: false,
      compatible: false,
      product_version: '0.3.0-rc.1',
      machine_contract: 'mercury.cli/v1',
      recommended_install_command: MERCURY_SKILL_INSTALL_COMMAND,
      install_method: 'none',
      installations: [],
    });
    expect(status.install_path).toBe(
      path.join(home, '.codex', 'skills', 'mercury-subtitles'),
    );
    expect(status.recommended_install_path).toBe(
      path.join(currentDirectory, '.agents', 'skills', 'mercury-subtitles'),
    );
    expect(await exists(path.join(home, '.agents'))).toBe(false);
    expect(await exists(path.join(home, '.codex'))).toBe(false);
  });

  it('recognizes a standard global install and legacy install becomes a no-op', async () => {
    const { home } = await isolatedContext('mercury-skill-global-');
    const currentDirectory = path.join(home, 'projects', 'demo');
    await mkdir(currentDirectory, { recursive: true });
    const standardPath = await copyPackagedSkill(
      path.join(home, '.agents', 'skills'),
    );
    const status = await skillStatus(home, undefined, currentDirectory);
    expect(status).toMatchObject({
      installed: true,
      compatible: true,
      install_method: 'agents_global',
      install_path: standardPath,
      duplicate_installations: false,
    });
    const installed = await installSkill(home, undefined, currentDirectory);
    expect(installed).toMatchObject({
      install_action: 'already_installed',
      install_method: 'agents_global',
      install_path: standardPath,
    });
    expect(await exists(path.join(home, '.codex', 'skills', 'mercury-subtitles'))).toBe(false);
  });

  it('discovers the nearest project install from a nested working directory', async () => {
    const { home, project, currentDirectory } = await isolatedContext('mercury-skill-project-');
    const projectPath = await copyPackagedSkill(
      path.join(project, '.agents', 'skills'),
    );
    expect(await skillStatus(home, undefined, currentDirectory)).toMatchObject({
      installed: true,
      compatible: true,
      install_method: 'project',
      install_path: projectPath,
    });
  });

  it('reports duplicate standard and legacy installs without overwriting either', async () => {
    const { home, currentDirectory } = await isolatedContext('mercury-skill-duplicate-');
    const standardPath = await copyPackagedSkill(path.join(home, '.agents', 'skills'));
    const legacyPath = await copyPackagedSkill(path.join(home, '.codex', 'skills'));
    const before = await Promise.all([
      readFile(path.join(standardPath, 'SKILL.md'), 'utf8'),
      readFile(path.join(legacyPath, 'SKILL.md'), 'utf8'),
    ]);
    const status = await skillStatus(home, undefined, currentDirectory);
    expect(status).toMatchObject({
      installed: true,
      compatible: true,
      duplicate_installations: true,
      attention_required: true,
    });
    expect(status.installations.map((item) => item.kind)).toEqual([
      'agents_global',
      'codex_legacy',
    ]);
    expect((await installSkill(home, undefined, currentDirectory)).install_action).toBe('already_installed');
    expect(await Promise.all([
      readFile(path.join(standardPath, 'SKILL.md'), 'utf8'),
      readFile(path.join(legacyPath, 'SKILL.md'), 'utf8'),
    ])).toEqual(before);
  });

  it('keeps the old install command idempotent when no standard install exists', async () => {
    const { home, currentDirectory } = await isolatedContext('mercury-skill-legacy-');
    const installed = await installSkill(home, undefined, currentDirectory);
    expect(installed).toMatchObject({
      installed: true,
      compatible: true,
      install_method: 'codex_legacy',
      install_action: 'installed_legacy',
    });
    expect((await lstat(installed.install_path)).isDirectory()).toBe(true);
    expect(await readFile(path.join(installed.install_path, 'SKILL.md'), 'utf8')).toContain('name: mercury-subtitles');
    expect((await installSkill(home, undefined, currentDirectory)).install_action).toBe('already_installed');
  });

  it('refuses to follow or overwrite an unsafe standard install', async () => {
    const { home, currentDirectory } = await isolatedContext('mercury-skill-unsafe-');
    const standardParent = path.join(home, '.agents', 'skills');
    await mkdir(standardParent, { recursive: true });
    await symlink(
      packagedSkillSource(),
      path.join(standardParent, 'mercury-subtitles'),
    );
    const status = await skillStatus(home, undefined, currentDirectory);
    expect(status).toMatchObject({
      installed: true,
      compatible: false,
      update_required: true,
      attention_required: true,
    });
    await expect(installSkill(home, undefined, currentDirectory)).rejects.toMatchObject({
      code: 'SKILL_INSTALL_CONFLICT',
    });
    expect((await lstat(status.install_path)).isSymbolicLink()).toBe(true);
  });

  it('keeps Skill state machine-readable and does not expose credential concepts', async () => {
    const { home, currentDirectory } = await isolatedContext('mercury-skill-cli-');
    await copyPackagedSkill(path.join(home, '.agents', 'skills'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await runCli(
      ['skill', 'install', '--json'],
      {
        homeDirectory: home,
        currentDirectory,
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
    )).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      contract_version: 'mercury-cli-experimental-v1',
      ok: true,
      command: 'skill.install',
      data: {
        installed: true,
        compatible: true,
        install_method: 'agents_global',
        install_action: 'already_installed',
        recommended_install_command: MERCURY_SKILL_INSTALL_COMMAND,
      },
    });
    expect(stdout.join('')).not.toMatch(/API[_ -]?Key|Access Token|credential_ref|\.env/iu);
  });

  it('contains concise routing references and explicit no-Provider/no-secret boundaries', async () => {
    const source = path.resolve('skills/mercury-subtitles');
    const skill = await readFile(path.join(source, 'SKILL.md'), 'utf8');
    expect(skill).toContain('references/commands.md');
    expect(skill).toContain('Never call a Provider directly');
    expect(skill).toContain('Never ask the user to paste a key');
    expect(skill).toContain('`resume.allowed`');
    expect(skill).not.toContain('TODO');
    for (const reference of ['commands.md', 'task-states.md', 'review.md', 'troubleshooting.md']) {
      expect((await readFile(path.join(source, 'references', reference), 'utf8')).length).toBeGreaterThan(200);
    }
    const commands = await readFile(path.join(source, 'references', 'commands.md'), 'utf8');
    expect(commands).toContain('config status.data.defaults');
    expect(commands).toContain('config status.data.models[].model_id');
    expect(commands).toContain('Never use `provider`, `name`, or `category` as a model ID');
    expect(commands).toContain('derive a new stable request ID');
    expect(commands).toContain('`resume.allowed`');
    expect(commands).toContain('`dictionaries.selected` is an array of `dictionary_id` strings');
    expect(commands).toContain('"selected": ["dict-project-terms"]');
    expect(commands).toContain('do not put revision objects into `selected[]`');
    expect(commands).toContain('mercury dictionary create --name "项目术语" --scope project --project "demo-project" --json');
    expect(commands).toContain('mercury dictionary create --name "通用术语" --scope global --json');
    expect(commands).toContain('mercury dictionary entry add <dictionary-id> --revision <current-revision> --entry-id entry-product-name');
    expect(commands).toContain('mercury dictionary entry edit <dictionary-id> --revision <latest-revision> --entry-id entry-product-name');
    expect(commands).toContain('mercury dictionary entry remove <dictionary-id> --revision <latest-revision> --entry-id entry-product-name --json');
    expect(commands).toContain('`--scope` is exactly `global` or `project`');
    expect(commands).toContain('Every entry ID must match `entry-[a-z0-9][a-z0-9-]{2,63}`');
    expect(commands).toContain('Every successful mutation returns `data.dictionary.revision`');
    expect(commands).toContain('`term|person|brand|product|acronym|other`');
    const troubleshooting = await readFile(path.join(source, 'references', 'troubleshooting.md'), 'utf8');
    expect(troubleshooting).toContain('If `approved_srt.exists` is false, do not call `task deliver`');
    expect(troubleshooting).toContain('never reuse the conflicting ID or choose a random replacement');
    const taskStates = await readFile(path.join(source, 'references', 'task-states.md'), 'utf8');
    expect(taskStates).toContain('`resume.allowed` is true');
    expect(taskStates).toContain('not permission to act');
  });

  it('executes the documented first dictionary CRUD flow without invalid command probing', async () => {
    const { home, currentDirectory } = await isolatedContext('mercury-skill-dictionary-forward-');
    const invoke = async (args: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(args, {
        homeDirectory: home,
        currentDirectory,
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      });
      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toHaveLength(1);
      return JSON.parse(stdout[0]!);
    };

    const created = await invoke(['dictionary', 'create', '--name', '项目术语', '--scope', 'project', '--project', 'demo-project', '--json']);
    const dictionaryId = created.data.dictionary_id as string;
    expect(dictionaryId).toMatch(/^dict-/u);
    const added = await invoke(['dictionary', 'entry', 'add', dictionaryId, '--revision', created.data.revision, '--entry-id', 'entry-product-name', '--canonical', 'Mercury', '--variant', '水星', '--kind', 'product', '--language', 'zh-CN', '--case-sensitive', 'false', '--number-sensitive', 'false', '--enabled', 'true', '--json']);
    expect(added.data.dictionary.entries).toEqual([expect.objectContaining({ entry_id: 'entry-product-name', canonical: 'Mercury' })]);
    const edited = await invoke(['dictionary', 'entry', 'edit', dictionaryId, '--revision', added.data.dictionary.revision, '--entry-id', 'entry-product-name', '--canonical', 'Mercury 字幕', '--clear-variants', '--clear-tags', '--clear-notes', '--case-sensitive', 'false', '--number-sensitive', 'false', '--enabled', 'true', '--json']);
    expect(edited.data.dictionary.entries).toEqual([expect.objectContaining({ entry_id: 'entry-product-name', canonical: 'Mercury 字幕', variants: [] })]);
    const shown = await invoke(['dictionary', 'show', dictionaryId, '--json']);
    expect(shown.data).toMatchObject({ dictionary_id: dictionaryId, revision: edited.data.dictionary.revision });
    const selected = { selected: [dictionaryId] };
    expect(selected.selected).toEqual([dictionaryId]);
    const removed = await invoke(['dictionary', 'entry', 'remove', dictionaryId, '--revision', shown.data.revision, '--entry-id', 'entry-product-name', '--json']);
    expect(removed.data.dictionary.entries).toEqual([]);
  });
});
