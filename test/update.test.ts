import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  applyUpdate,
  checkForUpdates,
  compareVersions,
  defaultSpawnCommand,
  detectInstallationOrigin,
  fetchRegistryFacts,
  nodeSatisfiesEngine,
  UPDATE_PACKAGE_NAME,
  type SpawnCommand,
} from '../src/update.js';

function metadata(input: { latest?: string; next?: string; versions?: Record<string, string> } = {}) {
  const latest = input.latest ?? '0.2.0-alpha.2';
  const next = input.next ?? '0.3.0-rc.1';
  const versions = input.versions ?? { [latest]: '>=24.0.0 <25.0.0', [next]: '>=24.0.0 <25.0.0' };
  return {
    name: UPDATE_PACKAGE_NAME,
    'dist-tags': { latest, next },
    versions: Object.fromEntries(Object.entries(versions).map(([version, engine]) => [version, {
      name: UPDATE_PACKAGE_NAME,
      version,
      engines: { node: engine },
    }])),
  };
}

function registry(value = metadata()): typeof fetch {
  return async () => Response.json(value);
}

async function installation(kind: 'global' | 'local' | 'exec' | 'source') {
  const root = await mkdtemp(path.join(os.tmpdir(), `mercury-update-${kind}-`));
  const packageRoot = kind === 'global'
    ? path.join(root, 'lib/node_modules/mercury-subtitles')
    : kind === 'local'
      ? path.join(root, 'project/node_modules/mercury-subtitles')
      : kind === 'exec'
        ? path.join(root, '.npm/_npx/cache/node_modules/mercury-subtitles')
        : path.join(root, 'source');
  const executablePath = path.join(packageRoot, 'dist/src/bin.js');
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(executablePath, '#!/usr/bin/env node\n', { mode: 0o755 });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: UPDATE_PACKAGE_NAME }));
  if (kind === 'source') await mkdir(path.join(packageRoot, '.git'));
  return { root, packageRoot, executablePath };
}

async function globalInstallationAt(prefix: string) {
  const packageRoot = path.join(prefix, 'lib/node_modules/mercury-subtitles');
  const executablePath = path.join(packageRoot, 'dist/src/bin.js');
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(executablePath, '#!/usr/bin/env node\n', { mode: 0o755 });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: UPDATE_PACKAGE_NAME }));
  return { root: prefix, packageRoot, executablePath };
}

async function fakeNode(root: string) {
  const nodeExecutable = path.join(root, 'node/bin/node');
  const npmCliPath = path.join(root, 'node/bin/npm');
  const npmReal = path.join(root, 'node/lib/node_modules/npm/bin/npm-cli.js');
  await mkdir(path.dirname(nodeExecutable), { recursive: true });
  await mkdir(path.dirname(npmReal), { recursive: true });
  await writeFile(nodeExecutable, '', { mode: 0o755 });
  await writeFile(npmReal, '', { mode: 0o755 });
  await (await import('node:fs/promises')).symlink(npmReal, npmCliPath);
  return { nodeExecutable, npmCliPath };
}

function boundSpawn(
  install: Awaited<ReturnType<typeof installation>>,
  version = '0.3.0-rc.1',
  options: { installCode?: number; verifyVersion?: string } = {},
): { calls: Array<{ command: string; args: string[] }>; spawnCommand: SpawnCommand } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    spawnCommand: async (command, args) => {
      calls.push({ command, args: [...args] });
      if (args.join(' ') === 'prefix --global') return { code: 0, stdout: `${install.root}\n`, stderr: '' };
      if (args.join(' ') === 'root --global') return { code: 0, stdout: `${path.join(install.root, 'lib/node_modules')}\n`, stderr: '' };
      if (args[0] === 'install') return { code: options.installCode ?? 0, stdout: '', stderr: options.installCode ? 'private detail' : '' };
      return { code: 0, stdout: `${options.verifyVersion ?? version}\n`, stderr: '' };
    },
  };
}

function capture(home: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { homeDirectory: home, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) } };
}

describe('safe CLI update contract', () => {
  it('compares strict semver and evaluates the published Node engine without executing commands', () => {
    expect(compareVersions('0.3.0-alpha.2', '0.3.0-rc.1')).toBeLessThan(0);
    expect(compareVersions('0.3.0-rc.1', '0.3.0')).toBeLessThan(0);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(nodeSatisfiesEngine('24.19.0', '>=24.0.0 <25.0.0')).toBe(true);
    expect(nodeSatisfiesEngine('22.23.2', '>=24.0.0 <25.0.0')).toBe(false);
  });

  it('recommends next while latest is older, then moves a prerelease user to a suitable stable latest', async () => {
    const source = await installation('source');
    const next = await checkForUpdates({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...source, fetch: registry(),
    });
    expect(next).toMatchObject({ recommended_channel: 'next', recommended_version: '0.3.0-rc.1', update_available: true, status: 'update_available', can_auto_apply: false });
    const stable = await checkForUpdates({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...source,
      fetch: registry(metadata({ latest: '0.3.0', next: '0.3.1-alpha.1' })),
    });
    expect(stable).toMatchObject({ recommended_channel: 'latest', recommended_version: '0.3.0', update_available: true });
  });

  it('classifies global, local, npm exec and source layouts from fixed package roots', async () => {
    for (const [fixture, expected] of [['global', 'npm_global'], ['local', 'npm_local'], ['exec', 'npm_exec'], ['source', 'source']] as const) {
      const found = await installation(fixture);
      expect(await detectInstallationOrigin(found.packageRoot, found.executablePath)).toMatchObject({ kind: expected, auto_apply: false, prefix_verified: false });
    }
  });

  it('returns one stable read-only envelope and creates no workspace', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-update-cli-check-'));
    const source = await installation('source');
    const output = capture(home);
    expect(await runCli(['update', 'check', '--json'], output.io, {}, {}, { update: {
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...source, fetch: registry(),
    } })).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({
      contract: 'mercury.cli/v1', command: 'update.check', ok: true,
      data: { current_version: '0.3.0-alpha.2', latest_version: '0.2.0-alpha.2', next_version: '0.3.0-rc.1', installation: { kind: 'source' } },
    });
    await expect(readFile(path.join(home, 'mercury-workspace/config/model-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps human check read-only and treats an explicit cancellation as a normal 130 exit', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-update-human-'));
    const source = await installation('source');
    const checked = capture(home);
    expect(await runCli(['update', '--check'], checked.io, {}, {}, { update: {
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...source, fetch: registry(),
    } })).toBe(0);
    expect(checked.stdout.join('')).toContain('官方 stable（latest）');
    expect(checked.stdout.join('')).toContain('源码检出');
    await expect(readFile(path.join(home, 'mercury-workspace/config/model-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    const global = await installation('global');
    const node = await fakeNode(global.root);
    const bound = boundSpawn(global);
    const cancelled = capture(home);
    expect(await runCli(['update'], { ...cancelled.io, prompt: async () => 'n' }, {}, {}, { update: {
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...global, ...node, fetch: registry(), spawnCommand: bound.spawnCommand,
    } })).toBe(130);
    expect(cancelled.stderr.join('')).toBe('已取消，未执行安装。\n');
  });

  it('requires explicit machine confirmation before any registry or npm side effect', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-update-cli-confirm-'));
    const global = await installation('global');
    let fetches = 0;
    let spawns = 0;
    const output = capture(home);
    expect(await runCli(['update', 'apply', '--channel', 'next', '--json'], output.io, {}, {}, { update: {
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...global,
      fetch: async () => { fetches += 1; return Response.json(metadata()); },
      spawnCommand: async () => { spawns += 1; return { code: 0, stdout: '', stderr: '' }; },
    } })).toBe(2);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ ok: false, error: { code: 'UPDATE_CONFIRMATION_REQUIRED' } });
    expect(fetches).toBe(0);
    expect(spawns).toBe(0);
  });

  it('uses an argument array for one trusted global npm install and verifies the same entry', async () => {
    const global = await installation('global');
    const node = await fakeNode(global.root);
    const bound = boundSpawn(global);
    const result = await applyUpdate({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...global, ...node,
      yes: true, channel: 'next', fetch: registry(), spawnCommand: bound.spawnCommand,
    });
    expect(result).toMatchObject({ applied: true, verified_version: '0.3.0-rc.1', requested: { direction: 'upgrade' } });
    expect(bound.calls).toHaveLength(4);
    expect(bound.calls[0]!.args).toEqual(['prefix', '--global']);
    expect(bound.calls[1]!.args).toEqual(['root', '--global']);
    expect(bound.calls[2]).toEqual({
      command: node.npmCliPath,
      args: ['install', '--global', '--prefix', result.installation.npm_global_prefix!, 'mercury-subtitles@0.3.0-rc.1', '--registry', 'https://registry.npmjs.org/', '--no-audit', '--no-fund', '--ignore-scripts'],
    });
    expect(bound.calls[2]!.args.join(' ')).not.toMatch(/sudo|[;&|`$()]/u);
    expect(bound.calls[3]).toEqual({ command: node.nodeExecutable, args: [global.executablePath, '--version'] });
    expect(result.installation).toMatchObject({ prefix_verified: true, auto_apply: true });
  });

  it('refuses a package in prefix A when the trusted npm is configured for prefix B', async () => {
    const prefixA = await installation('global');
    const prefixB = await installation('global');
    const node = await fakeNode(prefixB.root);
    const calls: Array<{ args: string[] }> = [];
    const mismatchedSpawn: SpawnCommand = async (_command, args) => {
      calls.push({ args: [...args] });
      if (args[0] === 'prefix') return { code: 0, stdout: `${prefixB.root}\n`, stderr: '' };
      if (args[0] === 'root') return { code: 0, stdout: `${path.join(prefixB.root, 'lib/node_modules')}\n`, stderr: '' };
      throw new Error('install must not run');
    };
    const checked = await checkForUpdates({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...prefixA, ...node,
      fetch: registry(), spawnCommand: mismatchedSpawn,
    });
    expect(checked).toMatchObject({
      can_auto_apply: false,
      installation: { kind: 'npm_global', auto_apply: false, prefix_verified: false, prefix_error: 'UPDATE_NPM_PREFIX_MISMATCH' },
    });
    calls.length = 0;
    await expect(applyUpdate({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...prefixA, ...node,
      yes: true, channel: 'next', fetch: registry(),
      spawnCommand: mismatchedSpawn,
    })).rejects.toMatchObject({ code: 'UPDATE_NPM_PREFIX_MISMATCH' });
    expect(calls.map((call) => call.args[0])).toEqual(['prefix', 'root']);
  });

  it('uses npm prefix/root facts instead of guessing nvm, Homebrew, Volta or custom-prefix layouts', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'mercury-update-manager-layouts-'));
    for (const managerPath of [
      '.nvm/versions/node/v24.19.0',
      'homebrew/Cellar/node/24.19.0',
      '.volta/tools/image/node/24.19.0',
      'custom/npm-config-prefix',
    ]) {
      const prefix = path.join(base, managerPath, 'global-prefix');
      const found = await globalInstallationAt(prefix);
      const node = await fakeNode(path.join(base, managerPath, 'toolchain'));
      const bound = boundSpawn(found);
      const checked = await checkForUpdates({
        currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...found, ...node,
        fetch: registry(), spawnCommand: bound.spawnCommand,
      });
      expect(checked.installation).toMatchObject({ kind: 'npm_global', prefix_verified: true, auto_apply: true });
      expect(bound.calls.map((call) => call.args)).toEqual([['prefix', '--global'], ['root', '--global']]);
    }
  });

  it('refuses local, temporary and source installs without invoking npm', async () => {
    for (const kind of ['local', 'exec', 'source'] as const) {
      const found = await installation(kind);
      let calls = 0;
      await expect(applyUpdate({
        currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...found,
        nodeExecutable: process.execPath, npmCliPath: process.execPath,
        yes: true, channel: 'next', fetch: registry(),
        spawnCommand: async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; },
      })).rejects.toMatchObject({ code: 'UPDATE_INSTALLATION_NOT_WRITABLE' });
      expect(calls).toBe(0);
    }
  });

  it('rejects incompatible Node, channel downgrade and post-install version mismatch safely', async () => {
    const global = await installation('global');
    const node = await fakeNode(global.root);
    await expect(applyUpdate({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '22.23.2', ...global, ...node,
      yes: true, channel: 'next', fetch: registry(), spawnCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    })).rejects.toMatchObject({ code: 'UPDATE_NODE_INCOMPATIBLE' });
    await expect(applyUpdate({
      currentVersion: '0.3.0', nodeVersion: '24.19.0', ...global, ...node,
      yes: true, channel: 'latest', fetch: registry(), spawnCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    })).rejects.toMatchObject({ code: 'UPDATE_CHANNEL_OLDER' });
    let calls = 0;
    const mismatch = boundSpawn(global, '0.3.0-rc.1', { verifyVersion: '0.3.0-alpha.2' });
    await expect(applyUpdate({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...global, ...node,
      yes: true, channel: 'next', fetch: registry(),
      spawnCommand: async (command, args, options) => { calls += 1; return mismatch.spawnCommand(command, args, options); },
    })).rejects.toMatchObject({ code: 'UPDATE_VERIFY_FAILED' });
  });

  it('keeps npm failure explicit and does not attempt post-install verification', async () => {
    const global = await installation('global');
    const node = await fakeNode(global.root);
    const failed = boundSpawn(global, '0.3.0-rc.1', { installCode: 73 });
    await expect(applyUpdate({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...global, ...node,
      yes: true, channel: 'next', fetch: registry(),
      spawnCommand: failed.spawnCommand,
    })).rejects.toMatchObject({ code: 'UPDATE_INSTALL_FAILED', message: expect.not.stringContaining('permission denied') });
    expect(failed.calls.map((call) => call.args[0])).toEqual(['prefix', 'root', 'install']);
  });

  it('allows an explicit exact rollback without describing it as a recommended upgrade', async () => {
    const global = await installation('global');
    const node = await fakeNode(global.root);
    const exactMetadata = metadata({
      latest: '0.3.0', next: '0.3.1-alpha.1',
      versions: { '0.3.0': '>=24 <25', '0.3.1-alpha.1': '>=24 <25', '0.2.0-alpha.2': '>=24 <25' },
    });
    const bound = boundSpawn(global, '0.2.0-alpha.2');
    const result = await applyUpdate({
      currentVersion: '0.3.0', nodeVersion: '24.19.0', ...global, ...node,
      yes: true, version: '0.2.0-alpha.2', fetch: registry(exactMetadata),
      spawnCommand: bound.spawnCommand,
    });
    expect(result.requested).toMatchObject({ version: '0.2.0-alpha.2', direction: 'downgrade', channel: null });
    expect(result.next_action).not.toContain('推荐升级');
  });

  it('bounds redirects, response bytes, malformed metadata and offline failures', async () => {
    await expect(fetchRegistryFacts(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/pkg' } }))).rejects.toMatchObject({ code: 'UPDATE_REDIRECT_UNSAFE' });
    await expect(fetchRegistryFacts(async () => new Response('{}', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } }))).rejects.toMatchObject({ code: 'UPDATE_REGISTRY_TOO_LARGE' });
    await expect(fetchRegistryFacts(registry({ name: UPDATE_PACKAGE_NAME, 'dist-tags': { latest: 'bad', next: '0.3.0-rc.1' }, versions: {} }))).rejects.toMatchObject({ code: 'UPDATE_REGISTRY_INVALID' });
    await expect(fetchRegistryFacts(async () => { throw new Error('offline'); })).rejects.toMatchObject({ code: 'UPDATE_CHECK_OFFLINE' });
  });

  it('times out a silent registry, rejects a redirect loop, and stops a streamed oversized response', async () => {
    vi.useFakeTimers();
    try {
      const pending = fetchRegistryFacts(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }));
      const timedOut = expect(pending).rejects.toMatchObject({ code: 'UPDATE_CHECK_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(5_001);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }

    await expect(fetchRegistryFacts(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://registry.npmjs.org/mercury-subtitles' },
    }))).rejects.toMatchObject({ code: 'UPDATE_REDIRECT_LIMIT' });

    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < 5) {
          controller.enqueue(chunk);
          sent += 1;
        } else controller.close();
      },
    });
    await expect(fetchRegistryFacts(async () => new Response(body))).rejects.toMatchObject({ code: 'UPDATE_REGISTRY_TOO_LARGE' });
  });

  it('maps headers-then-stall, partial-body reset and reader errors to stable transport errors', async () => {
    vi.useFakeTimers();
    try {
      const stalled = fetchRegistryFacts(async () => new Response(new ReadableStream<Uint8Array>({ pull() {} })));
      const timeout = expect(stalled).rejects.toMatchObject({ code: 'UPDATE_CHECK_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(5_001);
      await timeout;
    } finally {
      vi.useRealTimers();
    }
    for (const partial of [false, true]) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (partial) controller.enqueue(new TextEncoder().encode('{'));
          controller.error(new Error('connection reset private detail'));
        },
      });
      await expect(fetchRegistryFacts(async () => new Response(body))).rejects.toMatchObject({ code: 'UPDATE_REGISTRY_UNAVAILABLE' });
    }
  });

  it('settles timeout and oversized-output processes even when SIGTERM is ignored', async () => {
    const started = Date.now();
    await expect(defaultSpawnCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 50 }))
      .rejects.toMatchObject({ code: 'UPDATE_COMMAND_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(defaultSpawnCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("x".repeat(300000));setInterval(()=>{},1000)'], { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: 'UPDATE_COMMAND_OUTPUT_TOO_LARGE' });
  });

  it('never turns timed-out install or post-verify subprocesses into a late success', async () => {
    const global = await installation('global');
    const node = await fakeNode(global.root);
    for (const phase of ['install', 'verify'] as const) {
      const calls: string[] = [];
      await expect(applyUpdate({
        currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...global, ...node,
        yes: true, channel: 'next', fetch: registry(),
        spawnCommand: async (_command, args) => {
          calls.push(args[0]!);
          if (args[0] === 'prefix') return { code: 0, stdout: `${global.root}\n`, stderr: '' };
          if (args[0] === 'root') return { code: 0, stdout: `${path.join(global.root, 'lib/node_modules')}\n`, stderr: '' };
          if (phase === 'verify' && args[0] === 'install') return { code: 0, stdout: '', stderr: '' };
          return defaultSpawnCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),500);setInterval(()=>{},1000)'], { timeoutMs: 50 });
        },
      })).rejects.toMatchObject({ code: 'UPDATE_COMMAND_TIMEOUT' });
      expect(calls).toEqual(phase === 'install' ? ['prefix', 'root', 'install'] : ['prefix', 'root', 'install', global.executablePath]);
    }
  });

  it('rejects malicious versions and engines before invoking npm', async () => {
    const global = await installation('global');
    const node = await fakeNode(global.root);
    let spawns = 0;
    await expect(applyUpdate({
      currentVersion: '0.3.0-alpha.2', nodeVersion: '24.19.0', ...global, ...node,
      yes: true, version: '0.3.0;touch-pwned', fetch: registry(),
      spawnCommand: async () => { spawns += 1; return { code: 0, stdout: '', stderr: '' }; },
    })).rejects.toMatchObject({ code: 'UPDATE_VERSION_NOT_FOUND' });
    await expect(fetchRegistryFacts(registry(metadata({
      latest: '0.3.0', next: '0.3.0-rc.1',
      versions: { '0.3.0': '>=24 <25 || >=99', '0.3.0-rc.1': '>=24 <25' },
    })))).rejects.toMatchObject({ code: 'UPDATE_REGISTRY_INVALID' });
    expect(spawns).toBe(0);
  });

  it('does not auto-apply from a global-looking directory that is not writable', async () => {
    const global = await installation('global');
    await chmod(path.dirname(global.packageRoot), 0o555);
    const origin = await detectInstallationOrigin(global.packageRoot, global.executablePath);
    expect(origin).toMatchObject({ kind: 'npm_global', auto_apply: false });
    expect(origin.reason).toContain('不可写');
  });

  it('does not trust a package root when the actual executable is outside it', async () => {
    const global = await installation('global');
    const outside = path.join(global.root, 'other/bin.js');
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, '');
    expect(await detectInstallationOrigin(global.packageRoot, outside)).toMatchObject({ kind: 'unknown', auto_apply: false });
  });
});
