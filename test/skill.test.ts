import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { installSkill, skillStatus } from '../src/skill.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('V02-D004 packaged Mercury skill', () => {
  it('installs deterministically without overwriting and reports contract compatibility', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-skill-'));
    roots.push(home);
    expect(await skillStatus(home)).toMatchObject({ installed: false, product_version: '0.2.0-alpha.2', machine_contract: 'mercury-cli-experimental-v1' });
    const installed = await installSkill(home);
    expect(installed).toMatchObject({ installed: true, compatible: true, update_required: false });
    expect((await lstat(installed.install_path)).isDirectory()).toBe(true);
    expect(await readFile(path.join(installed.install_path, 'SKILL.md'), 'utf8')).toContain('name: mercury-subtitles');
    await expect(installSkill(home)).rejects.toMatchObject({ code: 'SKILL_ALREADY_INSTALLED' });
  });

  it('keeps Skill state machine-readable and does not expose credential concepts in stdout', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-skill-cli-'));
    roots.push(home);
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await runCli(['skill', 'install', '--json'], { homeDirectory: home, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) })).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ contract_version: 'mercury-cli-experimental-v1', ok: true, command: 'skill.install', data: { installed: true, compatible: true } });
    expect(stdout.join('')).not.toMatch(/API[_ -]?Key|Access Token|credential_ref|\.env/iu);
  });

  it('contains concise routing references and explicit no-Provider/no-secret boundaries', async () => {
    const source = path.resolve('skills/mercury-subtitles');
    const skill = await readFile(path.join(source, 'SKILL.md'), 'utf8');
    expect(skill).toContain('references/commands.md');
    expect(skill).toContain('Never call a Provider directly');
    expect(skill).toContain('Never ask the user to paste a key');
    expect(skill).not.toContain('TODO');
    for (const reference of ['commands.md', 'task-states.md', 'review.md', 'troubleshooting.md']) {
      expect((await readFile(path.join(source, 'references', reference), 'utf8')).length).toBeGreaterThan(200);
    }
  });
});
