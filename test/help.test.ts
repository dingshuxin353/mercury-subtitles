import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { helpGroups, mainHelp } from '../src/help.js';

function capture(home: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { homeDirectory: home, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) } };
}

async function configure(home: string): Promise<void> {
  const config = path.join(home, 'setup.json');
  await writeFile(config, JSON.stringify({ models: [
    { model_id: 'asr-default', name: 'ASR', category: 'asr', plugin_id: 'volcengine_asr', connection_id: 'conn-asr', connection_type: 'volcengine_cloud', provider_model: 'bigmodel', runtime: 'cloud', endpoint: null, credential_ref: 'env:ASR_KEY', provider_config: { resource_id: 'volc.bigasr.auc_turbo' }, default: true },
    { model_id: 'chat-default', name: 'Chat', category: 'chat', plugin_id: 'openai_chat_completions', connection_id: 'conn-chat', connection_type: 'compatible_endpoint', provider_model: 'fixture-chat', runtime: 'cloud', endpoint: 'https://chat.example/v1', credential_ref: 'env:CHAT_KEY', provider_config: {}, default: true },
  ] }));
  expect(await runCli(['setup', '--config', config, '--confirm-cloud-data'], capture(home).io)).toBe(0);
}

function displayWidth(value: string): number {
  return [...value].reduce((total, character) => total + (/^[\x00-\x7f]$/u.test(character) ? 1 : 2), 0);
}

describe('static human help router', () => {
  it('keeps the task-oriented main help within one 80-column screen and hides legacy commands', () => {
    const text = mainHelp('0.3.0-rc.1');
    const lines = text.trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(45);
    expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(80);
    expect(text).toContain('第一次使用');
    expect(text).toContain('创建字幕');
    expect(text).toContain('检查 CLI 更新');
    expect(text).not.toContain('mercury setup');
    expect(text).not.toContain('--experimental');
  });

  it('makes root help and every naked/group route consistent and side-effect free', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-help-routes-'));
    const rootForms = [['--help'], ['help']];
    const rootOutputs: string[] = [];
    for (const args of rootForms) {
      const output = capture(home);
      expect(await runCli(args, output.io)).toBe(0);
      expect(output.stderr).toEqual([]);
      rootOutputs.push(output.stdout.join(''));
    }
    expect(rootOutputs[0]).toBe(rootOutputs[1]);
    for (const group of helpGroups()) {
      const texts: string[] = [];
      const forms = group.name === 'update'
        ? [[group.name, '--help'], ['help', group.name]]
        : [[group.name], [group.name, '--help'], ['help', group.name]];
      for (const args of forms) {
        const output = capture(home);
        expect(await runCli(args, output.io), args.join(' ')).toBe(0);
        expect(output.stderr).toEqual([]);
        texts.push(output.stdout.join(''));
      }
      expect(new Set(texts).size, group.name).toBe(1);
      expect(texts[0]).toContain('子命令');
    }
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renders every concrete command with usage, copyable example, side effects and next step', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-help-command-'));
    for (const group of helpGroups()) {
      for (const command of group.commands) {
        const pathParts = command.name.split(' ');
        const direct = capture(home);
        expect(await runCli([group.name, ...pathParts, '--help', '--json'], direct.io), `${group.name} ${command.name}`).toBe(0);
        const viaHelp = capture(home);
        expect(await runCli(['help', group.name, ...pathParts], viaHelp.io)).toBe(0);
        expect(direct.stdout.join('')).toBe(viaHelp.stdout.join(''));
        const text = direct.stdout.join('');
        expect(text).toContain('用法');
        expect(text).toContain('示例');
        expect(text).toContain('副作用');
        expect(text).toContain('下一步');
        expect(text).toContain(command.example);
        expect(text).not.toMatch(/\u001b\[/u);
      }
    }
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('gives help priority over JSON, required arguments, Worker startup and registry access', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-help-priority-'));
    let fetches = 0;
    let workers = 0;
    const cases = [
      ['task', 'submit', '--help', '--json'],
      ['review', 'decide', '--help', '--json'],
      ['dictionary', 'entry', 'add', '--help', '--json'],
      ['worker', 'start', '--help', '--json'],
      ['update', 'apply', '--help', '--json'],
    ];
    for (const args of cases) {
      const output = capture(home);
      expect(await runCli(args, output.io, {}, {}, {
        startDetachedWorker: async () => { workers += 1; return { pid: 1, worker_id: 'should-not-run', ready: true }; },
        update: { fetch: async () => { fetches += 1; return Response.json({}); } },
      })).toBe(0);
      expect(output.stderr).toEqual([]);
      expect(output.stdout.join('')).toContain('用法');
      expect(output.stdout.join('')).not.toContain('mercury.cli/v1');
    }
    expect(fetches).toBe(0);
    expect(workers).toBe(0);
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps legacy discoverable only in its own help page', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-help-legacy-'));
    const root = capture(home);
    await runCli(['help'], root.io);
    expect(root.stdout.join('')).not.toContain('mercury setup');
    const legacy = capture(home);
    expect(await runCli(['help', 'legacy'], legacy.io)).toBe(0);
    expect(legacy.stdout.join('')).toContain('mercury setup');
    expect(legacy.stdout.join('')).toContain('--experimental');
  });

  it('suggests only a static same-level command and never executes the guess', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-help-suggest-'));
    const root = capture(home);
    expect(await runCli(['updat'], root.io)).toBe(2);
    expect(root.stderr.join('')).toContain('mercury update');
    expect(root.stderr.join('')).toContain('该建议未执行');

    const child = capture(home);
    expect(await runCli(['task', 'stats'], child.io)).toBe(2);
    expect(child.stderr.join('')).toContain('mercury task status');
    expect(child.stderr.join('')).toContain('该建议未执行');

    const positional = capture(home);
    expect(await runCli(['task', 'stats', 'abc'], positional.io)).toBe(2);
    expect(positional.stderr.join('')).toContain('mercury task status');

    const nested = capture(home);
    expect(await runCli(['dictionary', 'entri', 'ad', 'dict-demo', '--json'], nested.io)).toBe(2);
    expect(JSON.parse(nested.stdout[0]!).error.remediation.join(' ')).toContain('mercury dictionary entry add');

    const unreliable = capture(home);
    expect(await runCli(['task', 'zzzz', 'abc'], unreliable.io)).toBe(2);
    expect(unreliable.stderr.join('')).not.toContain('你是否想运行');

    const machine = capture(home);
    expect(await runCli(['task', 'stats', '--json'], machine.io)).toBe(2);
    const envelope = JSON.parse(machine.stdout[0]!);
    expect(envelope).toMatchObject({ contract: 'mercury.cli/v1', ok: false, error: { code: 'CLI_COMMAND_INVALID' } });
    expect(envelope.error.remediation.join(' ')).toContain('mercury task status');
    await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('describes Provider, Worker, registry and install side effects without generic contradictions', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-help-effects-'));
    const model = capture(home);
    expect(await runCli(['help', 'model', 'check'], model.io)).toBe(0);
    expect(model.stdout.join('')).toContain('立即调用所选 Provider');
    expect(model.stdout.join('')).toContain('写入检查结果');
    expect(model.stdout.join('')).not.toContain('安装 CLI');

    for (const args of [['help', 'worker', 'start'], ['help', 'task', 'submit']] as const) {
      const output = capture(home);
      expect(await runCli([...args], output.io)).toBe(0);
      expect(output.stdout.join('')).toContain('可能启动 Worker');
      expect(output.stdout.join('')).toContain('随后可能调用 Provider');
      expect(output.stdout.join('')).not.toContain('不调用 Provider');
    }
    const check = capture(home);
    expect(await runCli(['help', 'update', 'check'], check.io)).toBe(0);
    expect(check.stdout.join('')).toContain('只读访问官方 npm registry');
    expect(check.stdout.join('')).not.toContain('安装 CLI');
    const apply = capture(home);
    expect(await runCli(['help', 'update', 'apply'], apply.io)).toBe(0);
    expect(apply.stdout.join('')).toContain('确认后由已验证 npm 安装 CLI');

    for (const args of [['help', 'dictionary', 'import'], ['help', 'config', 'migrate']] as const) {
      const output = capture(home);
      expect(await runCli([...args], output.io)).toBe(0);
      expect(output.stdout.join('')).toContain('预检只读，只有显式确认后才写入本地目标');
    }
  });

  it('offers setup, update, help and exit before creating a first workspace', async () => {
    const metadata = {
      name: 'mercury-subtitles',
      'dist-tags': { latest: '0.3.0', next: '0.3.0-rc.1' },
      versions: {
        '0.3.0': { name: 'mercury-subtitles', version: '0.3.0', engines: { node: '>=24 <25' } },
        '0.3.0-rc.1': { name: 'mercury-subtitles', version: '0.3.0-rc.1', engines: { node: '>=24 <25' } },
      },
    };
    for (const [name, answers, expected] of [
      ['exit', ['0'], '首次使用'],
      ['help', ['3', '', '0'], '第一次使用'],
      ['update', ['2', '0'], '官方 stable（latest）'],
    ] as const) {
      const home = await mkdtemp(path.join(os.tmpdir(), `mercury-first-${name}-`));
      const output = capture(home);
      const queue = [...answers];
      expect(await runCli([], { ...output.io, prompt: async () => queue.shift() ?? '0' }, {}, {}, { update: {
        currentVersion: '0.3.0-rc.1', nodeVersion: '24.19.0',
        packageRoot: process.cwd(), executablePath: path.join(process.cwd(), 'src/bin.ts'),
        fetch: async () => Response.json(metadata),
      } })).toBe(0);
      expect(output.stdout.join('')).toContain(expected);
      expect(output.stdout.join('')).toContain('开始设置模型与服务');
      await expect(lstat(path.join(home, 'mercury-workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps human errors friendly and points to the local command help', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-help-errors-'));
    const output = capture(home);
    expect(await runCli(['model', 'check'], output.io)).toBe(2);
    expect(output.stderr.join('')).toContain('未完成：model check 必须提供 --model');
    expect(output.stderr.join('')).toContain('下一步：运行 mercury help model check');
    expect(output.stderr.join('')).not.toContain('MODEL_ID_REQUIRED');
  });

  it('uses no ANSI in human pipe output and honors NO_COLOR by construction', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-help-color-'));
    const before = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const output = capture(home);
      expect(await runCli(['help', 'task'], output.io)).toBe(0);
      expect(output.stdout.join('')).not.toMatch(/\u001b\[/u);
      expect(output.stderr).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = before;
    }
  });

  it('offers task, recent, model, dictionary, update and help pages without a dead end', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-app-product-'));
    await configure(home);
    const output = capture(home);
    const answers = [
      '4', 'a', '产品术语', '1',
      '1', 'a', 'Wan 3.0', '千问万3.0', '0', '0',
      '6', '',
      '5',
      '0',
    ];
    let registryReads = 0;
    expect(await runCli([], {
      ...output.io,
      prompt: async () => answers.shift() ?? '0',
    }, {}, {}, { update: {
      currentVersion: '0.3.0-rc.1', nodeVersion: '24.19.0',
      packageRoot: process.cwd(), executablePath: path.join(process.cwd(), 'src/bin.ts'),
      fetch: async () => {
        registryReads += 1;
        return Response.json({
          name: 'mercury-subtitles',
          'dist-tags': { latest: '0.3.0', next: '0.3.0-rc.1' },
          versions: {
            '0.3.0': { name: 'mercury-subtitles', version: '0.3.0', engines: { node: '>=24 <25' } },
            '0.3.0-rc.1': { name: 'mercury-subtitles', version: '0.3.0-rc.1', engines: { node: '>=24 <25' } },
          },
        });
      },
    } })).toBe(0);
    expect(answers).toEqual([]);
    const visible = `${output.stdout.join('')}\n${output.stderr.join('')}`;
    for (const label of ['创建字幕任务', '最近任务与结果', '模型与服务', '词典', '检查 CLI 更新', '帮助']) expect(visible).toContain(label);
    expect(visible).toContain('已创建“产品术语”');
    expect(visible).toContain('已新增“Wan 3.0”');
    expect(visible).toContain('官方 stable（latest）');
    expect(visible).toContain('Mercury 0.3');
    expect(registryReads).toBe(1);
    const pointer = JSON.parse(await readFile(path.join(home, 'mercury-workspace/dictionaries', (await (await import('node:fs/promises')).readdir(path.join(home, 'mercury-workspace/dictionaries')))[0]!, 'dictionary.json'), 'utf8'));
    expect(pointer.name).toBe('产品术语');
  });

  it('does not start a task when a new user presses Enter on the App home page', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-app-no-default-'));
    await configure(home);
    const output = capture(home);
    const answers = ['', '0'];
    expect(await runCli([], { ...output.io, prompt: async () => answers.shift() ?? '0' })).toBe(0);
    expect(output.stderr.join('')).toContain('请输入 0 到 6');
    expect(await (await import('node:fs/promises')).readdir(path.join(home, 'mercury-workspace/tasks'))).toEqual([]);
  });
});
