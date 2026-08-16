import { cp, lstat, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { sha256File } from '../src/tasks.js';

function capture(home: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { homeDirectory: home, stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) } };
}

describe('stable CLI v1 protocol and configuration', () => {
  it('returns strict protocol version/capabilities envelopes without creating a workspace', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-protocol-'));
    for (const args of [['protocol', 'version', '--json'], ['protocol', 'capabilities', '--json']]) {
      const output = capture(home);
      expect(await runCli(args, output.io)).toBe(0);
      expect(output.stderr).toEqual([]);
      expect(output.stdout).toHaveLength(1);
      const envelope = JSON.parse(output.stdout[0]!);
      expect(envelope).toMatchObject({ contract: 'mercury.cli/v1', ok: true, error: null, meta: { cli_version: '0.3.0-alpha.1', protocol_versions: ['v1'] } });
    }
    const capabilities = JSON.parse(capture(home).stdout[0] ?? 'null');
    expect(capabilities).toBeNull();
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
    const output = capture(home);
    await runCli(['protocol', 'capabilities', '--json'], output.io);
    const data = JSON.parse(output.stdout[0]!).data;
    expect(data.commands).toMatchObject({ external_srt: true, dictionary: true, pause: false, retry: false, venus_adapter: false });
    expect(data.query_commands_are_read_only).toBe(true);
  });

  it('reports a new HOME as not configured without creating directories or prompting', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-config-new-'));
    const output = capture(home);
    expect(await runCli(['config', 'status', '--json'], output.io)).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      contract: 'mercury.cli/v1', command: 'config.status', ok: true,
      data: { configured: false, state: 'not_configured', migration_required: false },
    });
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks a v1 migration read-only, applies only the matching plan, and preserves a 0600 backup', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-migrate-'));
    const configDirectory = path.join(home, 'mercury-workspace', 'config');
    await mkdir(configDirectory, { recursive: true });
    const target = path.join(configDirectory, 'model-config.json');
    await cp(path.join(process.cwd(), 'test/fixtures/valid/model-config.json'), target);
    await (await import('node:fs/promises')).chmod(target, 0o600);
    const before = await sha256File(target);
    const check = capture(home);
    expect(await runCli(['config', 'migrate', '--check', '--json'], check.io)).toBe(0);
    expect(await sha256File(target)).toBe(before);
    expect(await readdir(configDirectory)).toEqual(['model-config.json']);
    const plan = JSON.parse(check.stdout[0]!).data;
    expect(plan).toMatchObject({ source_schema_version: '1.0.0', target_schema_version: '2.0.0', migration_required: true });

    const stale = capture(home);
    expect(await runCli(['config', 'migrate', '--plan', 'migration-stale', '--json'], stale.io)).toBe(3);
    expect(JSON.parse(stale.stdout[0]!)).toMatchObject({ ok: false, error: { code: 'MIGRATION_PLAN_STALE' } });
    expect(await sha256File(target)).toBe(before);

    const apply = capture(home);
    expect(await runCli(['config', 'migrate', '--plan', plan.plan_id, '--json'], apply.io)).toBe(0);
    const envelope = JSON.parse(apply.stdout[0]!);
    expect(envelope).toMatchObject({ contract: 'mercury.cli/v1', ok: true, data: { source_schema_version: '2.0.0', state: 'current', migration_required: false } });
    const migrated = JSON.parse(await readFile(target, 'utf8'));
    expect(migrated.schema_version).toBe('2.0.0');
    expect(JSON.stringify(migrated)).toContain('credential_ref');
    expect(JSON.stringify(envelope)).not.toMatch(/keychain:|env:VOLCENGINE|Authorization|api_key/iu);
    const backup = envelope.data.backup_path;
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(await sha256File(backup)).toBe(before);
  });

  it('uses a strict stable error envelope for bad machine arguments', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-error-'));
    const output = capture(home);
    expect(await runCli(['protocol', 'version', '--unexpected', '--json'], output.io)).toBe(2);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ contract: 'mercury.cli/v1', command: 'protocol.version', ok: false, data: null, error: { contract: 'mercury.error/v1', code: 'CLI_ARGUMENT_INVALID' } });
  });

  it('places stable commands before deprecated commands in help', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-help-'));
    const output = capture(home);
    expect(await runCli(['--help'], output.io)).toBe(0);
    const text = output.stdout.join('');
    expect(text.indexOf('稳定非交互命令')).toBeLessThan(text.indexOf('deprecated'));
    expect(text).toContain('mercury protocol capabilities --json');
    expect(text).toContain('mercury task submit --request');
  });

  it('projects historical tasks through stable read-only status/list/result and does not invent Alpha.2 controls', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-history-'));
    const workspace = path.join(home, 'mercury-workspace');
    const taskId = 'tsk-20260816-120000-deadbeef';
    const directoryName = `${taskId}-history`;
    const directory = path.join(workspace, 'tasks', directoryName);
    await mkdir(directory, { recursive: true });
    const task = {
      schema_version: '1.0.0', task_id: taskId, task_type: 'subtitle_calibration', created_at: '2026-08-16T12:00:00.000Z', updated_at: '2026-08-16T12:01:00.000Z', task_directory: directoryName,
      input_config: { has_reference_srt: false, mode: null, source_language: 'zh-CN' },
      inputs: { audio: { original_path: '/tmp/history.mp3', original_name: 'history.mp3', workspace_copy_path: 'input/history.mp3', bytes: 10, modified_at: '2026-08-16T12:00:00.000Z', sha256: 'a'.repeat(64), copy_verified: true, duration_ms: 1000 }, reference_srt: null },
      model_snapshot: { path: null, sha256: null }, audio_verification: { requested: false, artifact_path: null, sha256: null },
      execution: { status: 'completed', last_completed_stage: 'validating', started_at: '2026-08-16T12:00:10.000Z', ended_at: '2026-08-16T12:01:00.000Z', execution_interrupted: false },
      artifacts: { work: [], outputs: [], report: null }, adapter_failures: [], warnings: [], error: null, failure_stage: null,
    };
    await writeFile(path.join(directory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
    const before = await sha256File(path.join(directory, 'task.json'));
    for (const args of [
      ['task', 'status', taskId, '--json'],
      ['task', 'list', '--limit', '1', '--json'],
      ['task', 'result', taskId, '--json'],
    ]) {
      const output = capture(home);
      expect(await runCli(args, output.io)).toBe(0);
      expect(output.stderr).toEqual([]);
      const envelope = JSON.parse(output.stdout[0]!);
      expect(envelope.contract).toBe('mercury.cli/v1');
      expect(envelope.ok).toBe(true);
    }
    expect(await sha256File(path.join(directory, 'task.json'))).toBe(before);
    expect(await readdir(directory)).toEqual(['task.json']);
    const statusOutput = capture(home);
    await runCli(['task', 'status', taskId, '--json'], statusOutput.io);
    const stableTask = JSON.parse(statusOutput.stdout[0]!).data;
    expect(stableTask).toMatchObject({ contract: 'mercury.task/v1', request_id: null, source_schema_version: '1.0.0', status: 'completed', capabilities: { pause: { supported: false }, retry: { supported: false }, dictionary_snapshot: { supported: false } } });

    const unsupported = capture(home);
    expect(await runCli(['task', 'pause', taskId, '--json'], unsupported.io)).toBe(5);
    expect(JSON.parse(unsupported.stdout[0]!)).toMatchObject({ contract: 'mercury.cli/v1', ok: false, error: { code: 'CONTRACT_UNSUPPORTED' } });
    expect(await sha256File(path.join(directory, 'task.json'))).toBe(before);
  });

  it('returns strict dictionary envelopes and keeps dictionary list side-effect free', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-dictionary-'));
    const listed = capture(home);
    expect(await runCli(['dictionary', 'list', '--json'], listed.io)).toBe(0);
    expect(JSON.parse(listed.stdout[0]!)).toMatchObject({ contract: 'mercury.cli/v1', command: 'dictionary.list', ok: true, data: { dictionaries: [] } });
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });

    const createdOutput = capture(home);
    expect(await runCli(['dictionary', 'create', '--name', '项目名词', '--scope', 'project', '--project', 'demo', '--json'], createdOutput.io)).toBe(0);
    const created = JSON.parse(createdOutput.stdout[0]!);
    expect(created).toMatchObject({ contract: 'mercury.cli/v1', command: 'dictionary.create', ok: true, data: { scope: 'project', project_key: 'demo' } });
    const changedOutput = capture(home);
    expect(await runCli(['dictionary', 'entry', 'add', created.data.dictionary_id, '--revision', created.data.revision, '--entry-id', 'entry-product', '--canonical', 'Mercury', '--variant', '水星', '--kind', 'product', '--json'], changedOutput.io)).toBe(0);
    expect(JSON.parse(changedOutput.stdout[0]!).data.dictionary.entries).toEqual([expect.objectContaining({ canonical: 'Mercury', variants: ['水星'] })]);
  });
});
