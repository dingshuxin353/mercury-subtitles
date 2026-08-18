import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { computeModelConfigFingerprintV2 } from '../src/contracts/index.js';

function capture(home: string) {
  const stdout: string[] = [],
    stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      homeDirectory: home,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}
async function mp3(target: string) {
  const data = Buffer.alloc(834);
  data.set([0xff, 0xfb, 0x90, 0x64], 0);
  data.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(target, data);
}
function completeCalibrationResponse(init?: RequestInit): string {
  const request = JSON.parse(String(init?.body ?? '{}')) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  const prompt = request.messages?.find((message) => message.role === 'user')?.content ?? '';
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as {
    calibration_units: Array<{ unit_id: string; original_text: string }>;
  };
  return JSON.stringify({
    corrected_units: payload.calibration_units.map((unit) => ({
      unit_id: unit.unit_id,
      corrected_text: unit.original_text,
      rationale: null,
    })),
  });
}
describe('Mercury v2 CLI', () => {
  it('keeps the brand-new machine model guidance App-first and never asks for credentials', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-machine-new-user-'));
    const output = capture(home);
    expect(await runCli(['model', 'list', '--json'], output.io)).toBe(1);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    const envelope = JSON.parse(output.stdout[0]!) as any;
    expect(envelope).toMatchObject({
      ok: false,
      command: 'model.list',
      error: {
        code: 'MODEL_NOT_CONFIGURED',
        remediation: expect.stringContaining('运行 mercury 打开交互式 App'),
      },
    });
    expect(envelope.error.remediation).toContain('模型中心');
    expect(envelope.error.remediation).toContain('隐藏输入');
    expect(envelope.error.remediation).not.toContain('mercury setup');
    expect(JSON.stringify(envelope)).not.toMatch(/API[_ -]?Key|Access Token|credential_ref|\.env/iu);
  });

  it('guides a brand-new user without exposing credential references', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-new-user-'));
    const output = capture(home);
    const answers = ['1', '1', 'fixture-subtitle-app', '1', 'fixture-chat-model', 'https://chat.example/v1', 'y', 'n', '0'];
    const secrets = ['fixture-asr-secret', 'fixture-chat-secret'];
    const io = {
      ...output.io,
      prompt: async () => answers.shift() ?? '0',
      secretPrompt: async () => secrets.shift() ?? '',
    };
    expect(await runCli([], io), output.stderr.join('')).toBe(0);
    const visible = `${output.stdout.join('')}\n${output.stderr.join('')}`;
    expect(visible).toContain('欢迎使用 Mercury');
    expect(visible).toContain('火山音视频字幕');
    expect(visible).not.toMatch(/credential_ref|file:|env:|fixture-asr-secret|fixture-chat-secret/u);
    const workspace = path.join(home, 'mercury-workspace');
    const registry = JSON.parse(await readFile(path.join(workspace, 'config/model-config.json'), 'utf8'));
    expect(registry.models[0]).toMatchObject({
      plugin_id: 'volcengine_subtitle_asr',
      provider_config: {
        auth_mode: 'legacy',
        app_id: 'fixture-subtitle-app',
      },
    });
    expect(registry.models[1]).toMatchObject({ plugin_id: 'openai_chat_completions' });
    expect(JSON.stringify(registry)).not.toContain('fixture-asr-secret');
    const secretPath = String(registry.models[0].credential_ref).slice(5);
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
  });
  it('does not persist entered secrets when first-time setup is cancelled', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-cancel-'));
    const output = capture(home);
    const answers = [
      '1',
      '1',
      'cancelled-subtitle-app',
      '1',
      'fixture-chat-model',
      'https://chat.example/v1',
      'n',
    ];
    const secrets = ['cancelled-asr-secret', 'cancelled-chat-secret'];
    const io = {
      ...output.io,
      prompt: async () => answers.shift() ?? 'n',
      secretPrompt: async () => secrets.shift() ?? '',
    };
    expect(await runCli([], io)).toBe(130);
    expect(output.stderr.join('')).toContain('已取消');
    expect(output.stderr.join('')).not.toContain('UNEXPECTED_ERROR');
    const workspace = path.join(home, 'mercury-workspace');
    expect(
      await readdir(path.join(workspace, 'config', 'secrets')).catch(() => []),
    ).toHaveLength(0);
    expect(
      await readFile(path.join(workspace, 'config', 'model-config.json'), 'utf8').catch(
        () => '',
      ),
    ).toBe('');
  });
  it('validates setup fields before persisting entered secrets', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-invalid-'));
    const output = capture(home);
    const answers = [
      '1', '2', '1', '1', 'fixture-chat-model', 'http://unsafe.example/v1', 'y',
    ];
    const secrets = ['invalid-asr-secret', 'invalid-chat-secret'];
    const io = {
      ...output.io,
      prompt: async () => answers.shift() ?? 'n',
      secretPrompt: async () => secrets.shift() ?? '',
    };
    expect(await runCli([], io)).toBe(1);
    expect(output.stderr.join('')).toContain('未完成：');
    expect(output.stderr.join('')).toContain('服务地址是否为 HTTPS');
    expect(output.stderr.join('')).toContain('mercury help 查看可用命令');
    const workspace = path.join(home, 'mercury-workspace');
    expect(
      await readdir(path.join(workspace, 'config', 'secrets')).catch(() => []),
    ).toHaveLength(0);
  });
  it('C09 publishes ASR/Chat selection and rejects the removed verification flag before task creation', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-cli-'));
    const output = capture(home);
    expect(await runCli(['--help'], output.io)).toBe(0);
    expect(output.stdout.join('').startsWith('Mercury 0.3')).toBe(true);
    expect(output.stdout.join('')).toContain('打开交互式 App（推荐）');
    expect(output.stdout.join('')).toContain('创建字幕');
    expect(output.stdout.join('')).not.toContain('mercury setup');
    expect(output.stdout.join('')).not.toContain('--asr-model');
    expect(output.stdout.join('')).not.toContain('audio-verification');
    const rejected = capture(home);
    expect(
      await runCli(
        ['calibrate', '--audio', '/missing.mp3', '--verify-audio'],
        rejected.io,
      ),
    ).toBe(2);
    expect(rejected.stderr.join('')).toContain('--verify-audio 已移除');
    expect(rejected.stderr.join('')).toContain('mercury help legacy');
    const tasks = path.join(home, 'mercury-workspace', 'tasks');
    expect(await readdir(tasks).catch(() => [])).toHaveLength(0);
  });
  it('requires model check to target a model instance', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-cli-'));
    const output = capture(home);
    expect(await runCli(['model', 'check', '--role', 'asr'], output.io)).toBe(
      2,
    );
    expect(output.stderr.join('')).toContain('不支持的参数：--role');
    expect(output.stderr.join('')).toContain('mercury help model check');
    const missing = capture(home);
    expect(await runCli(['model', 'check'], missing.io)).toBe(2);
    expect(missing.stderr.join('')).toContain('model check 必须提供 --model');
    expect(missing.stderr.join('')).toContain('mercury help model check');
  });
  it('persists only ASR/Chat defaults and checks the selected Chat instance', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-cli-'));
    const config = path.join(home, 'setup.json');
    await writeFile(
      config,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default',
            name: 'ASR',
            category: 'asr',
            plugin_id: 'volcengine_asr',
            connection_id: 'conn-asr',
            connection_type: 'volcengine_cloud',
            provider_model: 'bigmodel',
            runtime: 'cloud',
            endpoint: null,
            credential_ref: 'env:ASR_KEY',
            provider_config: { resource_id: 'volc.bigasr.auc_turbo' },
            default: true,
          },
          {
            model_id: 'chat-default',
            name: 'Chat',
            category: 'chat',
            plugin_id: 'openai_chat_completions',
            connection_id: 'conn-chat',
            connection_type: 'compatible_endpoint',
            provider_model: 'fixture-chat',
            runtime: 'cloud',
            endpoint: 'https://chat.example/v1',
            credential_ref: 'env:CHAT_KEY',
            provider_config: {},
            default: true,
          },
        ],
      }),
    );
    const setup = capture(home);
    expect(
      await runCli(
        ['setup', '--config', config, '--confirm-cloud-data'],
        setup.io,
        {},
      ),
      setup.stderr.join(''),
    ).toBe(0);
    const registryPath = path.join(
      home,
      'mercury-workspace/config/model-config.json',
    );
    let registry = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(registry).toMatchObject({
      schema_version: '2.0.0',
      defaults: { asr: 'asr-default', chat: 'chat-default' },
    });
    expect(JSON.stringify(registry)).not.toMatch(
      /audio_verification|"role"|"default"/u,
    );
    const checked = capture(home);
    expect(
      await runCli(['model', 'check', '--model', 'chat-default'], checked.io, {
        fetch: async (_input, init) =>
          Response.json({
            id: 'check-request',
            choices: [{ message: { content: completeCalibrationResponse(init) } }],
          }),
        readCredential: async () => 'ephemeral-check-secret',
      }),
      checked.stderr.join(''),
    ).toBe(0);
    registry = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(
      registry.models.find((item: any) => item.model_id === 'chat-default'),
    ).toMatchObject({
      verified_capabilities: {
        capabilities: ['calibration'],
        input_modalities: ['text'],
      },
      check: { outcome: 'passed' },
    });
    expect(JSON.stringify(registry)).not.toContain('ephemeral-check-secret');
  });
  it('normalizes Ctrl+C and rejects interactive commands without a TTY', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-cancel-'));
    const cancelled = capture(home);
    expect(
      await runCli([], {
        ...cancelled.io,
        prompt: async () => {
          throw new Error('Aborted with Ctrl+C');
        },
      }),
    ).toBe(130);
    expect(cancelled.stderr.join('')).toContain('已取消');
    expect(cancelled.stderr.join('')).not.toContain('UNEXPECTED_ERROR');

    const nonInteractive = capture(home);
    expect(await runCli(['model', 'add'], nonInteractive.io)).toBe(2);
    expect(nonInteractive.stderr.join('')).toContain('需要交互式终端');
    expect(nonInteractive.stderr.join('')).toContain('直接运行 mercury');
  });

  it('keeps model check and edit inside the interactive model center', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-center-'));
    const config = path.join(home, 'setup.json');
    await writeFile(
      config,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default', name: 'ASR', category: 'asr',
            plugin_id: 'volcengine_asr', connection_id: 'conn-asr',
            connection_type: 'volcengine_cloud', provider_model: 'bigmodel',
            runtime: 'cloud', endpoint: null, credential_ref: 'env:ASR_KEY',
            provider_config: { resource_id: 'volc.bigasr.auc_turbo' }, default: true,
          },
          {
            model_id: 'chat-default', name: 'Chat', category: 'chat',
            plugin_id: 'openai_chat_completions', connection_id: 'conn-chat',
            connection_type: 'compatible_endpoint', provider_model: 'fixture-chat',
            runtime: 'cloud', endpoint: 'https://chat.example/v1',
            credential_ref: 'env:CHAT_KEY', provider_config: {}, default: true,
          },
        ],
      }),
    );
    expect(
      await runCli(
        ['setup', '--config', config, '--confirm-cloud-data'],
        capture(home).io,
      ),
    ).toBe(0);
    const output = capture(home);
    const answers = [
      '3', '2', '1', '2', '', 'fixture-chat-edited',
      'https://edited.example/v1', '我的校准', 'y', 'y', '0', '0', '0',
    ];
    expect(
      await runCli(
        [],
        {
          ...output.io,
          prompt: async () => answers.shift() ?? '0',
          secretPrompt: async () => '',
        },
        {
          fetch: async (_input, init) =>
            Response.json({
              id: 'check-request',
              choices: [{ message: { content: completeCalibrationResponse(init) } }],
            }),
          readCredential: async () => 'ephemeral-check-secret',
        },
      ),
      output.stderr.join(''),
    ).toBe(0);
    const visible = output.stdout.join('');
    expect(visible).toContain('模型中心');
    expect(visible).toContain('模型详情');
    expect(visible).toContain('检查通过');
    expect(visible).toContain('模型配置已更新');
    expect(visible).not.toContain('可用命令：mercury model');
    const registry = JSON.parse(
      await readFile(
        path.join(home, 'mercury-workspace/config/model-config.json'),
        'utf8',
      ),
    );
    expect(
      registry.models.find((item: any) => item.model_id === 'chat-default'),
    ).toMatchObject({
      provider_model: 'fixture-chat-edited',
      name: '我的校准',
      endpoint: 'https://edited.example/v1',
      credential_ref: 'env:CHAT_KEY',
    });
  });

  it('stops a removed subtitle APP Key configuration and guides an in-App migration', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-subtitle-migrate-'));
    const workspace = path.join(home, 'mercury-workspace');
    const config = path.join(home, 'setup.json');
    const audio = path.join(home, 'check.mp3');
    await mp3(audio);
    await writeFile(
      config,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default', name: '火山音视频字幕', category: 'asr',
            plugin_id: 'volcengine_subtitle_asr', connection_id: 'conn-asr',
            connection_type: 'volcengine_subtitle_cloud', provider_model: 'video-caption',
            runtime: 'cloud', endpoint: null, credential_ref: 'env:ASR_KEY',
            provider_config: { auth_mode: 'legacy', app_id: 'old-documented-app' }, default: true,
          },
          {
            model_id: 'chat-default', name: '内容校准', category: 'chat',
            plugin_id: 'openai_chat_completions', connection_id: 'conn-chat',
            connection_type: 'compatible_endpoint', provider_model: 'fixture-chat',
            runtime: 'cloud', endpoint: 'https://chat.example/v1',
            credential_ref: 'env:CHAT_KEY', provider_config: {}, default: true,
          },
        ],
      }),
    );
    expect(
      await runCli(
        ['setup', '--config', config, '--confirm-cloud-data'],
        capture(home).io,
      ),
    ).toBe(0);
    const registryPath = path.join(workspace, 'config/model-config.json');
    const oldRegistry = JSON.parse(await readFile(registryPath, 'utf8'));
    oldRegistry.models[0].provider_config = { auth_mode: 'api_key' };
    oldRegistry.models[0].credential_ref = 'env:REMOVED_SUBTITLE_APP_KEY';
    oldRegistry.models[0].check = null;
    oldRegistry.models[0].verified_capabilities = null;
    oldRegistry.models[0].config_fingerprint = computeModelConfigFingerprintV2(
      oldRegistry.models[0],
    );
    await writeFile(registryPath, `${JSON.stringify(oldRegistry, null, 2)}\n`);

    let providerCalls = 0;
    const checked = capture(home);
    expect(
      await runCli(
        ['model', 'check', '--model', 'asr-default', '--audio', audio],
        checked.io,
        {
          readCredential: async () =>
            JSON.stringify({ mode: 'api_key', value: 'removed-app-key' }),
          fetch: async () => {
            providerCalls += 1;
            return Response.json({ code: 0, message: 'Success' });
          },
        },
      ),
    ).toBe(1);
    expect(providerCalls).toBe(0);
    expect(`${checked.stdout.join('')}\n${checked.stderr.join('')}`).toContain(
      'APP ID',
    );

    const edited = capture(home);
    const answers = ['1', 'replacement-subtitle-app', '', 'n', 'y'];
    const asked: string[] = [];
    expect(
      await runCli(
        ['model', 'edit', '--model', 'asr-default'],
        {
          ...edited.io,
          prompt: async (question) => {
            asked.push(question);
            return answers.shift() ?? '';
          },
          secretPrompt: async (question) => {
            asked.push(question);
            return 'replacement-access-token';
          },
        },
      ),
      `${edited.stderr.join('')}\nremaining=${JSON.stringify(answers)}`,
    ).toBe(0);
    expect(answers).toHaveLength(0);
    expect(asked.some((question) => question.includes('应用标识（APP ID）'))).toBe(true);
    expect(asked.some((question) => question.includes('访问令牌（Access Token'))).toBe(true);
    expect(asked.every((question) => !question.includes('APP Key'))).toBe(true);
    const migrated = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(migrated.models[0].provider_config).toEqual({
      auth_mode: 'legacy',
      app_id: 'replacement-subtitle-app',
    });
    expect(migrated.models[0].credential_ref).toMatch(/^file:/u);
    expect(JSON.stringify(migrated)).not.toContain('replacement-access-token');
  });

  it('distinguishes, edits, switches, disables, and deletes same-provider instances', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-multi-model-'));
    const workspace = path.join(home, 'mercury-workspace');
    const config = path.join(home, 'setup.json');
    await writeFile(
      config,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default', name: '火山极速版', category: 'asr',
            plugin_id: 'volcengine_asr', connection_id: 'conn-asr',
            connection_type: 'volcengine_cloud', provider_model: 'bigmodel',
            runtime: 'cloud', endpoint: null, credential_ref: 'env:ASR_KEY',
            provider_config: { resource_id: 'volc.bigasr.auc_turbo' }, default: true,
          },
          {
            model_id: 'chat-default', name: 'OpenAI 兼容校准', category: 'chat',
            plugin_id: 'openai_chat_completions', connection_id: 'conn-chat',
            connection_type: 'compatible_endpoint', provider_model: 'demo-chat',
            runtime: 'cloud', endpoint: 'https://chat.example/v1',
            credential_ref: 'env:CHAT_KEY', provider_config: {}, default: true,
          },
        ],
      }),
    );
    expect(
      await runCli(
        ['setup', '--config', config, '--confirm-cloud-data'],
        capture(home).io,
      ),
    ).toBe(0);

    const output = capture(home);
    const asked: string[] = [];
    const answers = [
      '3',
      'a', '1', '2', '', 'n', 'y',
      'a', '2', '1', 'backup-chat', 'https://backup.example/v1',
      '我的备用校准', 'y', 'y',
      '4', '2', '', 'backup-chat-v2', '', '我的备用校准新版', 'n', 'y',
      '4', '0',
      '2', '4', '0',
      '4', '3', 'y', '3', '5', 'y',
      '0', '0',
    ];
    const secrets = ['fixture-added-asr', 'fixture-added-chat', ''];
    expect(
      await runCli([], {
        ...output.io,
        prompt: async (question) => {
          asked.push(question);
          return answers.shift() ?? '0';
        },
        secretPrompt: async () => secrets.shift() ?? '',
      }),
      `${output.stderr.join('')}\nremaining=${JSON.stringify(answers)}`,
    ).toBe(0);
    expect(answers).toHaveLength(0);

    const visible = output.stdout.join('');
    expect(visible).toContain('火山极速版 · bigmodel');
    expect(visible).toContain('火山极速版 · bigmodel（2）');
    expect(visible).toContain('OpenAI 兼容校准 · demo-chat');
    expect(visible).toContain('我的备用校准 · backup-chat');
    expect(visible).toContain('我的备用校准新版 · backup-chat-v2');
    expect(visible).toContain('已将“我的备用校准新版 · backup-chat-v2”设为内容校准默认模型');
    expect(visible).toContain('已停用“我的备用校准新版 · backup-chat-v2”');
    expect(visible).toContain('已删除“我的备用校准新版 · backup-chat-v2”');
    expect(asked).toContain(
      '删除“我的备用校准新版 · backup-chat-v2”？此操作不能撤销。[y/N] ',
    );

    const registry = JSON.parse(
      await readFile(path.join(workspace, 'config/model-config.json'), 'utf8'),
    );
    expect(registry.defaults.chat).toBe('chat-default');
    expect(registry.models.some((item: any) => item.provider_model === 'backup-chat-v2')).toBe(false);
    expect(registry.models.filter((item: any) => item.plugin_id === 'volcengine_asr')).toHaveLength(2);
    expect(await readdir(path.join(workspace, 'config/secrets'))).toHaveLength(1);
  });

  it('offers an in-App check or model-center recovery before creating a task', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-ready-'));
    const config = path.join(home, 'setup.json');
    await writeFile(
      config,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default', name: '火山极速版', category: 'asr',
            plugin_id: 'volcengine_asr', connection_id: 'conn-asr',
            connection_type: 'volcengine_cloud', provider_model: 'bigmodel',
            runtime: 'cloud', endpoint: null, credential_ref: 'env:ASR_KEY',
            provider_config: { resource_id: 'volc.bigasr.auc_turbo' }, default: true,
          },
          {
            model_id: 'chat-default', name: '内容校准', category: 'chat',
            plugin_id: 'openai_chat_completions', connection_id: 'conn-chat',
            connection_type: 'compatible_endpoint', provider_model: 'fixture-chat',
            runtime: 'cloud', endpoint: 'https://chat.example/v1',
            credential_ref: 'env:CHAT_KEY', provider_config: {}, default: true,
          },
        ],
      }),
    );
    expect(
      await runCli(
        ['setup', '--config', config, '--confirm-cloud-data'],
        capture(home).io,
      ),
    ).toBe(0);
    const output = capture(home);
    const answers = ['1', '/tmp/not-yet-read.mp3', '', '0', '0'];
    const questions: string[] = [];
    expect(
      await runCli([], {
        ...output.io,
        prompt: async (question) => { questions.push(question); return answers.shift() ?? '0'; },
      }),
    ).toBe(0);
    const visible = `${output.stdout.join('')}\n${output.stderr.join('')}`;
    expect(visible).toContain('运行前需要检查');
    expect(visible).toContain('1. 现在检查');
    expect(visible).toContain('2. 打开模型中心');
    expect(visible).toContain('已取消任务');
    expect(visible).toContain('校准只修改文字');
    expect(questions.join('\n')).not.toContain('校准范围');
    expect(questions.join('\n')).not.toContain('文字和断句');
    expect(visible).not.toContain('MODEL_CHECK_NOT_PASSED');
    expect(
      await readdir(path.join(home, 'mercury-workspace/tasks')),
    ).toHaveLength(0);
  });

  it('renders the known subtitle resource denial in Chinese without raw provider prose', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-1022-'));
    const config = path.join(home, 'setup.json');
    const audio = path.join(home, 'check.mp3');
    await mp3(audio);
    await writeFile(
      config,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default', name: '火山音视频字幕', category: 'asr',
            plugin_id: 'volcengine_subtitle_asr', connection_id: 'conn-asr',
            connection_type: 'volcengine_subtitle_cloud', provider_model: 'video-caption',
            runtime: 'cloud', endpoint: null, credential_ref: 'env:ASR_KEY',
            provider_config: { auth_mode: 'legacy', app_id: 'fixture-subtitle-app' }, default: true,
          },
          {
            model_id: 'chat-default', name: '内容校准', category: 'chat',
            plugin_id: 'openai_chat_completions', connection_id: 'conn-chat',
            connection_type: 'compatible_endpoint', provider_model: 'fixture-chat',
            runtime: 'cloud', endpoint: 'https://chat.example/v1',
            credential_ref: 'env:CHAT_KEY', provider_config: {}, default: true,
          },
        ],
      }),
    );
    expect(
      await runCli(
        ['setup', '--config', config, '--confirm-cloud-data'],
        capture(home).io,
      ),
    ).toBe(0);
    const checked = capture(home);
    expect(
      await runCli(
        ['model', 'check', '--model', 'asr-default', '--audio', audio],
        checked.io,
        {
          readCredential: async () => 'redacted-access-token',
          fetch: async () =>
            Response.json(
              {
                code: 1022,
                message:
                  '[resource_id=vc.async.default] Requested Resource Not Granted',
              },
              { headers: { 'X-Tt-Logid': 'safe-log-id-1234567890' } },
            ),
        },
      ),
    ).toBe(1);
    expect(checked.stdout.join('')).toContain(
      '请求使用的火山应用未获“音视频字幕”资源 vc.async.default',
    );
    expect(checked.stdout.join('')).toContain('APP ID');
    expect(checked.stdout.join('')).toContain('Access Token');
    expect(checked.stdout.join('')).toContain('项目');
    expect(checked.stdout.join('')).not.toContain('未开通');
    expect(checked.stdout.join('')).toContain('Provider code=1022');
    expect(checked.stdout.join('')).toContain('控制台');
    expect(checked.stdout.join('')).not.toContain(
      'Requested Resource Not Granted',
    );
  });

  it('shows meaningful recent task details and absolute result paths', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-recent-'));
    const workspace = path.join(home, 'mercury-workspace');
    const config = path.join(home, 'setup.json');
    await writeFile(
      config,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default', name: 'ASR', category: 'asr',
            plugin_id: 'volcengine_asr', connection_id: 'conn-asr',
            connection_type: 'volcengine_cloud', provider_model: 'bigmodel',
            runtime: 'cloud', endpoint: null, credential_ref: 'env:ASR_KEY',
            provider_config: { resource_id: 'volc.bigasr.auc_turbo' }, default: true,
          },
          {
            model_id: 'chat-default', name: 'Chat', category: 'chat',
            plugin_id: 'openai_chat_completions', connection_id: 'conn-chat',
            connection_type: 'compatible_endpoint', provider_model: 'fixture-chat',
            runtime: 'cloud', endpoint: 'https://chat.example/v1',
            credential_ref: 'env:CHAT_KEY', provider_config: {}, default: true,
          },
        ],
      }),
    );
    expect(
      await runCli(
        ['setup', '--config', config, '--confirm-cloud-data'],
        capture(home).io,
      ),
    ).toBe(0);
    const directory = 'tsk-20260815-120000-abcdef12-sample';
    const taskRoot = path.join(workspace, 'tasks', directory);
    await mkdir(path.join(taskRoot, 'output'), { recursive: true });
    await writeFile(
      path.join(taskRoot, 'task.json'),
      JSON.stringify({
        schema_version: '2.0.0', task_id: 'tsk-20260815-120000-abcdef12',
        task_type: 'subtitle_calibration', created_at: '2026-08-15T12:00:00.000+09:00',
        updated_at: '2026-08-15T12:01:00.000+09:00', task_directory: directory,
        input_config: { has_reference_srt: false, mode: null, source_language: 'zh-CN', evidence_mode: 'audio_multimodal', non_strong_reason: null },
        inputs: { audio: { original_path: '/tmp/sample.mp3', original_name: 'sample.mp3', bytes: 123, modified_at: '2026-08-15T12:00:00.000+09:00', sha256: 'a'.repeat(64), workspace_copy_path: 'input/sample.mp3', copy_verified: true, duration_ms: 30000 }, reference_srt: null },
        model_snapshot: { path: 'work/model-snapshot.json', sha256: 'b'.repeat(64) },
        execution: { status: 'completed', last_completed_stage: 'completed', started_at: '2026-08-15T12:00:01.000+09:00', ended_at: '2026-08-15T12:01:00.000+09:00', execution_interrupted: false },
        artifacts: { work: [], outputs: ['output/sample.calibrated.srt'], report: 'output/calibration-report.md' },
        adapter_failures: [], warnings: [], error: null, failure_stage: null,
      }),
    );
    const output = capture(home);
    const answers = ['2', '1', '', '0', '0'];
    expect(
      await runCli([], {
        ...output.io,
        prompt: async () => answers.shift() ?? '0',
      }),
      output.stderr.join(''),
    ).toBe(0);
    const visible = output.stdout.join('');
    expect(visible).toContain('sample.mp3');
    expect(visible).toContain('已完成');
    expect(visible).toContain('任务详情');
    expect(visible).toContain('纯转写字幕（未经 Chat 校验）：尚未生成');
    expect(visible).toContain(
      `校验后字幕：${path.join(taskRoot, 'output/sample.calibrated.srt')}`,
    );
    expect(visible).toContain(path.join(taskRoot, 'output/sample.calibrated.srt'));
    expect(visible).toContain(path.join(taskRoot, 'output/calibration-report.md'));
  });

  it('localizes an old failed task and keeps appended provider detail technical', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-failed-task-'));
    const workspace = path.join(home, 'mercury-workspace');
    const taskId = 'tsk-20260815-130000-deadbeef';
    const directory = `${taskId}-failed`;
    const taskRoot = path.join(workspace, 'tasks', directory);
    await mkdir(taskRoot, { recursive: true });
    const rawProviderDetail =
      'Could not load the default credentials. Browse to https://provider.example/auth for more information.';
    await writeFile(
      path.join(taskRoot, 'task.json'),
      JSON.stringify({
        schema_version: '2.0.0', task_id: taskId,
        task_type: 'subtitle_calibration', created_at: '2026-08-15T13:00:00.000+09:00',
        updated_at: '2026-08-15T13:00:10.000+09:00', task_directory: directory,
        input_config: { has_reference_srt: false, mode: null, source_language: 'zh-CN', evidence_mode: 'text', non_strong_reason: 'chat_model_text_only' },
        inputs: { audio: { original_path: '/tmp/failed.mp3', original_name: 'failed.mp3', bytes: 123, modified_at: '2026-08-15T13:00:00.000+09:00', sha256: 'a'.repeat(64), workspace_copy_path: 'input/failed.mp3', copy_verified: true, duration_ms: 30000 }, reference_srt: null },
        model_snapshot: { path: null, sha256: null },
        execution: { status: 'failed', last_completed_stage: 'preparing', started_at: '2026-08-15T13:00:01.000+09:00', ended_at: '2026-08-15T13:00:10.000+09:00', execution_interrupted: false },
        artifacts: { work: [], outputs: [], report: null },
        adapter_failures: [], warnings: [],
        error: { error_id: 'err-fixture', code: 'GEMINI_VERTEX_UNAUTHENTICATED', message: `Vertex AI 身份验证失败。请重新登录 ADC 后再检查模型。Provider detail=${rawProviderDetail}`, stage: 'model_call', retryable: true },
        failure_stage: 'model_call',
      }),
    );
    const output = capture(home);
    expect(await runCli(['task', 'status', taskId], output.io)).toBe(0);
    const visible = output.stdout.join('');
    const [ordinary, technical = ''] = visible.split('技术详情：');
    expect(ordinary).toContain('当前阶段：已停止（调用模型）');
    expect(ordinary).toContain(
      '错误：Vertex AI 身份验证失败。请重新登录 ADC 后再检查模型。',
    );
    expect(ordinary).not.toContain(rawProviderDetail);
    expect(ordinary).not.toContain('Provider detail=');
    expect(ordinary).not.toContain('https://');
    expect(technical).toContain(rawProviderDetail);
    expect(technical).toContain('GEMINI_VERTEX_UNAUTHENTICATED');
  });

  it('keeps legacy calibration parser details technical', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v3-parser-task-'));
    const workspace = path.join(home, 'mercury-workspace');
    const taskId = 'tsk-20260815-130100-deadbeef';
    const directory = `${taskId}-failed`;
    const taskRoot = path.join(workspace, 'tasks', directory);
    await mkdir(taskRoot, { recursive: true });
    const rawMessage = 'Unexpected token at position 42 while parsing JSON';
    await writeFile(
      path.join(taskRoot, 'task.json'),
      JSON.stringify({
        schema_version: '2.0.0', task_id: taskId,
        task_type: 'subtitle_calibration', created_at: '2026-08-15T13:01:00.000+09:00',
        updated_at: '2026-08-15T13:01:10.000+09:00', task_directory: directory,
        input_config: { has_reference_srt: false, mode: null, source_language: 'zh-CN', evidence_mode: 'text', non_strong_reason: 'audio_not_supported' },
        inputs: { audio: { original_path: '/tmp/failed.mp3', original_name: 'failed.mp3', bytes: 123, modified_at: '2026-08-15T13:01:00.000+09:00', sha256: 'a'.repeat(64), workspace_copy_path: 'input/failed.mp3', copy_verified: true, duration_ms: 30000 }, reference_srt: null },
        model_snapshot: { path: null, sha256: null },
        execution: { status: 'failed', last_completed_stage: 'aligning', started_at: '2026-08-15T13:01:01.000+09:00', ended_at: '2026-08-15T13:01:10.000+09:00', execution_interrupted: false },
        artifacts: { work: [], outputs: ['output/failed.transcribed.srt'], report: null },
        adapter_failures: [], warnings: [],
        error: { error_id: 'err-parser', code: 'CALIBRATION_COVERAGE_INVALID', message: rawMessage, stage: 'response_validation', retryable: false },
        failure_stage: 'response_validation',
      }),
    );
    const output = capture(home);
    expect(await runCli(['task', 'status', taskId], output.io)).toBe(0);
    const visible = output.stdout.join('');
    const [ordinary, technical = ''] = visible.split('技术详情：');
    expect(ordinary).toContain('校准服务返回的正文不完整或结构不符合要求');
    expect(ordinary).not.toContain('Unexpected token');
    expect(technical).toContain(rawMessage);
    expect(technical).toContain('CALIBRATION_COVERAGE_INVALID');
  });

  it('rejects new Vertex setup fields that would reintroduce GCS staging', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'mercury-v2-cli-'));
    const config = path.join(home, 'setup.json');
    await writeFile(
      config,
      JSON.stringify({
        models: [
          {
            model_id: 'asr-default',
            name: 'ASR',
            category: 'asr',
            plugin_id: 'volcengine_asr',
            connection_id: 'conn-asr',
            connection_type: 'volcengine_cloud',
            provider_model: 'bigmodel',
            runtime: 'cloud',
            endpoint: null,
            credential_ref: 'env:ASR_KEY',
            provider_config: { resource_id: 'volc.bigasr.auc_turbo' },
            default: true,
          },
          {
            model_id: 'chat-default',
            name: 'Gemini',
            category: 'chat',
            plugin_id: 'gemini',
            connection_id: 'conn-chat',
            connection_type: 'vertex_ai',
            provider_model: 'gemini-3.6-flash',
            runtime: 'cloud',
            endpoint: null,
            credential_ref: 'adc:local',
            provider_config: {
              project: 'safe-project',
              location: 'us-central1',
              gcs_bucket: 'forbidden',
            },
            default: true,
          },
        ],
      }),
    );
    const output = capture(home);
    expect(
      await runCli(
        ['setup', '--config', config, '--confirm-cloud-data'],
        output.io,
      ),
    ).toBe(1);
    expect(output.stderr.join('')).toContain('Vertex AI provider_config 包含不支持的字段：gcs_bucket');
    expect(output.stderr.join('')).toContain('mercury help legacy');
  });
});
