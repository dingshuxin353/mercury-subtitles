import { cp, lstat, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { applyConfigMigration, inspectConfigMigration } from '../src/stable-cli/config.js';
import { stableErrorFrom } from '../src/stable-cli/envelope.js';
import { sha256File } from '../src/tasks.js';
import { MercuryError } from '../src/errors.js';

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
      expect(envelope).toMatchObject({ contract: 'mercury.cli/v1', ok: true, error: null, meta: { cli_version: '0.3.0-rc.1', protocol_versions: ['v1'] } });
    }
    const capabilities = JSON.parse(capture(home).stdout[0] ?? 'null');
    expect(capabilities).toBeNull();
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
    const output = capture(home);
    await runCli(['protocol', 'capabilities', '--json'], output.io);
    const data = JSON.parse(output.stdout[0]!).data;
    expect(data.commands).toMatchObject({ external_srt: true, dictionary: true, pause: true, retry: true, venus_adapter: false });
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

  it('projects only non-sensitive model readiness/default facts for stable Agent discovery', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-config-models-'));
    const configDirectory = path.join(home, 'mercury-workspace', 'config');
    await mkdir(configDirectory, { recursive: true });
    const target = path.join(configDirectory, 'model-config.json');
    await cp(path.join(process.cwd(), 'test/fixtures/valid/model-config.json'), target);
    await (await import('node:fs/promises')).chmod(target, 0o600);
    const migration = await inspectConfigMigration(path.join(home, 'mercury-workspace'));
    await applyConfigMigration(path.join(home, 'mercury-workspace'), migration.plan_id!);
    const output = capture(home);
    expect(await runCli(['config', 'status', '--json'], output.io)).toBe(0);
    const envelope = JSON.parse(output.stdout[0]!);
    expect(envelope).toMatchObject({ contract: 'mercury.cli/v1', ok: true, data: { state: 'current', defaults: { asr: expect.any(String), chat: expect.any(String) }, models: expect.any(Array) } });
    expect(envelope.data.models.length).toBeGreaterThanOrEqual(2);
    expect(envelope.data.models[0]).toEqual(expect.objectContaining({ model_id: expect.any(String), name: expect.any(String), category: expect.stringMatching(/^(?:asr|chat)$/u), provider: expect.any(String), enabled: expect.any(Boolean), check: expect.any(String), ready: expect.any(Boolean) }));
    expect(JSON.stringify(envelope)).not.toMatch(/credential_ref|keychain:|env:|api[_-]?key|access[_-]?token|secret/iu);
  });

  it('inspects one immutable MP3 buffer without creating workspace state', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-media-inspect-'));
    const audio = path.join(home, 'fixture.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417);
    await writeFile(audio, bytes, { mode: 0o600 });
    const output = capture(home);
    expect(await runCli(['input', 'inspect', '--file', audio, '--format', 'mp3', '--role', 'media', '--json'], output.io)).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ contract: 'mercury.cli/v1', command: 'input.inspect', ok: true, data: { path: audio, format: 'mp3', role: 'media', bytes: 834, sha256: await sha256File(audio), duration_ms: expect.any(Number), mime_type: 'audio/mpeg', valid: true } });
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns worker status through the stable envelope without creating workspace state', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-worker-status-'));
    const output = capture(home);
    expect(await runCli(['worker', 'status', '--json'], output.io)).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      contract: 'mercury.cli/v1',
      command: 'worker.status',
      ok: true,
      data: {
        running: false,
        stale: false,
        state: 'stopped',
        task_id: null,
        heartbeat_at: null,
        diagnostic_count: 0,
      },
      error: null,
    });
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('projects an exited Worker as stopped while preserving stale record evidence separately and read-only', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-worker-stopped-'));
    const runtime = path.join(home, 'mercury-workspace', 'runtime');
    await mkdir(runtime, { recursive: true });
    const recordPath = path.join(runtime, 'worker.json');
    const record = {
      contract_version: 'mercury-worker-experimental-v1',
      worker_id: 'worker-finished', pid: 999_999, started_at: '2026-08-17T10:00:00.000Z',
      heartbeat_at: '2026-08-17T10:01:00.000Z', state: 'stopping', task_id: null, diagnostic_count: 0,
    };
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const before = await readFile(recordPath, 'utf8');
    const output = capture(home);
    expect(await runCli(['worker', 'status', '--json'], output.io)).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      contract: 'mercury.cli/v1', command: 'worker.status', ok: true,
      data: {
        running: false, stale: false, state: 'stopped', task_id: null, heartbeat_at: null,
        last_record: { state: 'stopping', task_id: null, heartbeat_at: record.heartbeat_at, stale: true },
        next_action: 'Worker 已停止；查询不会启动任务。只有存在安全 queued 任务时才显式执行 worker start。',
      },
    });
    expect(await readFile(recordPath, 'utf8')).toBe(before);
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

  it('reuses an identical migration backup after an injected failure and retries successfully', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-migrate-retry-'));
    const workspace = path.join(home, 'mercury-workspace');
    const configDirectory = path.join(workspace, 'config');
    await mkdir(configDirectory, { recursive: true });
    const target = path.join(configDirectory, 'model-config.json');
    await cp(path.join(process.cwd(), 'test/fixtures/valid/model-config.json'), target);
    const before = await sha256File(target);
    const plan = await inspectConfigMigration(workspace);
    await expect(applyConfigMigration(workspace, plan.plan_id!, { faultAfterBackup: () => { throw new Error('fixture crash'); } })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    expect(await sha256File(target)).toBe(before);
    const after = await applyConfigMigration(workspace, plan.plan_id!);
    expect(after.state).toBe('current');
    expect(await sha256File(after.backup_path)).toBe(before);
    expect((await stat(after.backup_path)).mode & 0o777).toBe(0o600);
  });

  it('classifies invalid dictionary imports as stable input errors', () => {
    const { error } = stableErrorFrom(new MercuryError('DICTIONARY_IMPORT_INVALID', 'bad import', { exitCode: 2 }));
    expect(error.category).toBe('input');
    const secretError = stableErrorFrom(new MercuryError('REQUEST_INVALID', `bad ${'Author'}ization: ${'Bear'}er ${'x'.repeat(40)}`, { exitCode: 2 })).error;
    expect(secretError.message).toContain('已脱敏');
    expect(JSON.stringify(secretError)).not.toContain('Bearer');
    expect(stableErrorFrom(new MercuryError('DELIVERY_DIRECTORY_NOT_WRITABLE', '目录不可写', { exitCode: 2 })).error).toMatchObject({ category: 'input', retryability: 'after_user_action' });
    expect(stableErrorFrom(new MercuryError('DELIVERY_PATH_UNSAFE', '目录不安全', { exitCode: 4 })).error).toMatchObject({ category: 'security', retryability: 'after_user_action' });
    expect(stableErrorFrom(new MercuryError('DELIVERY_CONFLICT', '文件冲突', { exitCode: 3 })).error).toMatchObject({ category: 'conflict', retryability: 'after_user_action' });
  });

  it('uses a strict stable error envelope for bad machine arguments', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-error-'));
    const output = capture(home);
    expect(await runCli(['protocol', 'version', '--unexpected', '--json'], output.io)).toBe(2);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ contract: 'mercury.cli/v1', command: 'protocol.version', ok: false, data: null, error: { contract: 'mercury.error/v1', code: 'CLI_ARGUMENT_INVALID' } });
  });

  it('rejects a transcript request without an explicit role before creating workspace state', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-role-'));
    const requestPath = path.join(home, 'request.json');
    await writeFile(requestPath, `${JSON.stringify({
      contract: 'mercury.exchange.request/v1', request_id: 'request-role-missing', created_at: '2026-08-16T12:00:00.000Z', operation: 'subtitle_calibration',
      inputs: { media: null, transcript: { path: '/tmp/input.srt', sha256: 'a'.repeat(64), format: 'srt' } }, transcription_mode: 'provided',
      calibration: { mode: 'text-only', source_language: 'zh-CN' }, models: { asr: null, chat: 'chat-default' }, dictionaries: { project_key: null, selected: [], task_overrides: [] }, output: { formats: ['srt'], workspace_policy: 'managed' }, extensions: {},
    })}\n`);
    const output = capture(home);
    expect(await runCli(['task', 'submit', '--request', requestPath, '--json'], output.io)).toBe(2);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ contract: 'mercury.cli/v1', ok: false, error: { code: 'TRANSCRIPT_ROLE_REQUIRED' } });
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the main help task-oriented and moves deprecated commands to help legacy', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-stable-help-'));
    const output = capture(home);
    expect(await runCli(['--help'], output.io)).toBe(0);
    const text = output.stdout.join('');
    expect(text).toContain('mercury protocol capabilities --json');
    expect(text).toContain('mercury task submit --request');
    expect(text).not.toContain('mercury setup');
    const legacy = capture(home);
    expect(await runCli(['help', 'legacy'], legacy.io)).toBe(0);
    expect(legacy.stdout.join('')).toContain('mercury setup');
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
