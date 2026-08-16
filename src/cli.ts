import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type {
  ModelConfigRegistryV2,
  ModelConfigV2,
} from './contracts/index.js';
import {
  readAudioVerificationStatus,
  readTaskModelSummary,
  type CoreIntegrationDependencies,
} from './core-integration.js';
import { MercuryError } from './errors.js';
import { type ModelRuntimeDependencies } from './models.js';
import {
  checkModelV2,
  deleteModelV2,
  loadModelRegistryV2,
  savePrivateSecret,
  setDefaultModelV2,
  setModelEnabledV2,
  setupFromFileV2,
  setupInteractiveV2,
  upsertModelV2,
} from './models-v2.js';
import { executeCalibrationTaskV2 } from './core-integration-v2.js';
import {
  findTask,
  listTasks,
  type CalibrationMode,
  type TaskRecord,
} from './tasks.js';
import {
  createCalibrationTaskV2,
  isTaskRecordV2,
  readTaskRecordV2,
  type TaskRecordV2,
} from './tasks-v2.js';
import { defaultWorkspaceRoot, ensureWorkspace } from './workspace.js';
import { readProductVersion } from './version.js';
import {
  cancelBackgroundTask,
  deriveBackgroundRequestId,
  submitBackgroundTask,
  taskMachineView,
} from './background/runtime.js';
import { listJobsIsolated, readTaskEvents } from './background/storage.js';
import {
  CLI_CONTRACT_VERSION,
  machineFailure,
  machineSuccess,
} from './background/types.js';
import {
  runWorker,
  startDetachedWorker,
  workerStatus,
} from './background/worker.js';
import {
  acceptAllReviewChanges,
  decideReviewChange,
  finalizeReview,
  readVerifiedReview,
  type ReviewActor,
} from './review.js';
import { acceptAllV5ReviewChanges, decideV5ReviewChange, finalizeV5Review, readVerifiedV5Review } from './review-v5.js';
import { installSkill, skillStatus } from './skill.js';
import { tryRunStableCli } from './stable-cli/index.js';

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  homeDirectory?: string;
  currentDirectory?: string;
  prompt?: (question: string) => Promise<string>;
  secretPrompt?: (question: string) => Promise<string>;
}

const HELP = `mercury（推荐：打开交互式 App）

Mercury 0.3 Alpha.1

普通用户场景：
  1. 第一次使用：运行 mercury，按向导添加语音转文字和内容校准服务
  2. 日常任务：在主页选择“运行新字幕任务”，提供中文 MP3 和可选 SRT
  3. 配置与找回：在主页进入“管理模型”或“查看最近任务”

常用命令：
  mercury --version
  mercury --help

稳定非交互命令（脚本、Agent 与外部软件）：
  mercury protocol version --json
  mercury protocol capabilities --json
  mercury config status --json
  mercury config migrate --check --json
  mercury config migrate --plan <plan-id> --json
  mercury input inspect --file <absolute-path> --format auto|srt|vtt|transcript-json --role transcript-source|reference --json
  mercury task submit --request <absolute-request.json> --json
  mercury task status|result <task-id> --json
  mercury task list --limit <n> --json
  mercury task watch <task-id> --after <sequence> --jsonl
  mercury dictionary ... --json

高级 / 兼容命令（旧实验合同，deprecated）：
  mercury setup [--config <setup.json>] [--confirm-cloud-data]
  mercury model check --model <model-id> [--audio <check.mp3>]
  mercury model list
  mercury model add | edit | enable | disable | default | delete --model <model-id>
  mercury calibrate --audio <audio.mp3> [--srt <reference.srt>] [--mode text-only|text-and-segmentation] [--asr-model <model-id>] [--chat-model <model-id>]
  mercury calibrate --audio <audio.mp3> [...] --background [--request-id <id>] [--json]
  mercury request id --audio <audio.mp3> --intent <stable-label> [...] --json
  mercury task status <task-id> [--json]
  mercury task list [--json]
  mercury task watch <task-id> [--jsonl] [--after <sequence>]
  mercury task result <task-id> [--json]
  mercury task cancel <task-id> [--json]
  mercury worker status [--json]
  mercury worker start [--json]
  mercury review status|list|decide|accept-all|finalize <task-id> ... --json
  npx skills add dingshuxin353/mercury-subtitles
  mercury skill status [--json]
  mercury skill install [--target <skills-directory>] [--json]  # 旧版兼容
  旧实验机器输出临时兼容：在原机器命令后加 --experimental（至少保留一个 V0.3 Alpha）
`;

const SETUP_HELP = `用法：
  mercury setup [--config <setup.json>] [--confirm-cloud-data]

初始化 ~/mercury-workspace，并配置 ASR 与 Chat 模型实例。
`;

const MODEL_CHECK_HELP = `用法：
  mercury model check --model <model-id> [--audio <check.mp3>]

检查指定模型实例。ASR 必须提供中文 MP3；Chat 提供 MP3 时会额外检查音频输入能力。
`;

const CALIBRATE_HELP = `用法：
  mercury calibrate --audio <audio.mp3>
    [--srt <reference.srt>]
    [--mode text-only|text-and-segmentation]
    [--asr-model <model-id>]
    [--chat-model <model-id>]

创建字幕校准任务。每个新任务只选择一个 ASR 与一个 Chat，并只执行一次 Chat 校准。
加 --background 后任务会持久化入队并立即返回；独立 Worker 会继续处理。
`;

const TASK_STATUS_HELP = `用法：
  mercury task status <task-id>

回读指定任务的状态、模型、输入和产物。
`;

const TASK_LIST_HELP = `用法：
  mercury task list

列出本地 Mercury 工作区中的任务。
`;

function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function localTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function friendlyProviderError(code: string | undefined, message: string): string {
  const calibrationErrors: Record<string, string> = {
    CALIBRATION_COVERAGE_INVALID:
      '校准服务返回的正文不完整或结构不符合要求。请检查该模型的结构化输出能力后重新创建任务。',
    CALIBRATION_RESPONSE_TRUNCATED:
      '校准服务的返回内容没有完整结束。请检查模型输出上限和服务状态后重新创建任务。',
    PROVIDER_RESPONSE_EMPTY_CONTENT:
      '校准服务没有返回可用正文。请检查该模型后重新创建任务。',
    PROVIDER_RESPONSE_INVALID_JSON:
      '校准服务返回的内容无法解析。请检查该模型的结构化输出能力后重新创建任务。',
  };
  if (code && calibrationErrors[code]) return calibrationErrors[code];
  if (
    code === 'VOLCENGINE_SUBTITLE_STATUS_1022' &&
    /vc\.async\.default|requested resource not granted|requested grant not found/iu.test(
      message,
    )
  )
    return '请求使用的火山应用未获“音视频字幕”资源 vc.async.default（Provider code=1022）。请核对 APP ID、Access Token 与控制台项目是否对应同一项音视频字幕服务。';
  return message
    .replace(/\s+/gu, ' ')
    .replace(
      /\s*(?:provider|upstream)\s+(?:detail|details|message|error)\s*[:=].*$/iu,
      '',
    )
    .replace(
      /[，,]\s*信息=.*?(?=[，,]\s*log id=|（log id=|\(log id=|$)/iu,
      '',
    )
    .trim();
}

function modelCheckStatus(model: ModelConfigV2): string {
  const check = model.check;
  if (!check) return '尚未检查';
  if (check.outcome === 'passed') return `最近检查通过（${localTime(check.ended_at)}）`;
  const summary =
    friendlyProviderError(check.error?.code, check.error?.message ?? '未知错误');
  return `最近检查失败（${summary}；${localTime(check.ended_at)}）`;
}

function modelPurpose(model: ModelConfigV2): string {
  return model.category === 'asr' ? '语音转文字' : '内容校准';
}

function providerName(model: ModelConfigV2): string {
  if (model.plugin_id === 'volcengine_subtitle_asr') return '火山音视频字幕';
  if (model.plugin_id === 'volcengine_asr') return '火山极速版';
  if (model.plugin_id === 'gemini') return 'Vertex AI Gemini';
  return 'OpenAI 兼容服务';
}

function capabilityText(model: ModelConfigV2): string {
  if (model.category === 'asr') return '带时间轴的语音转文字';
  return model.verified_capabilities?.input_modalities.includes('audio')
    ? '可听音频的强校准'
    : '文本校准（非强校准）';
}

function modelDisplayName(model: Pick<ModelConfigV2, 'name' | 'provider_model'>): string {
  const providerModel = model.provider_model.trim();
  return providerModel && !model.name.includes(providerModel)
    ? `${model.name} · ${providerModel}`
    : model.name;
}

async function availableModelName(
  workspaceRoot: string,
  proposed: string,
  providerModel: string,
  excludedModelId: string,
): Promise<string> {
  let models: ModelConfigV2[] = [];
  try {
    models = (await loadModelRegistryV2(workspaceRoot)).models;
  } catch (error) {
    if (!(error instanceof MercuryError) || error.code !== 'MODEL_NOT_CONFIGURED')
      throw error;
  }
  const used = new Set(
    models
      .filter((model) => model.model_id !== excludedModelId)
      .map((model) => modelDisplayName(model)),
  );
  const display = (name: string) =>
    modelDisplayName({ name, provider_model: providerModel });
  if (!used.has(display(proposed))) return proposed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${proposed}（${suffix}）`;
    if (!used.has(display(candidate))) return candidate;
  }
}

function modelListText(
  registry: ModelConfigRegistryV2,
  options: { numbered?: boolean; technical?: boolean } = {},
): string {
  return `${registry.models
    .map((model, index) => {
      const isDefault = registry.defaults[model.category] === model.model_id;
      return [
        `${options.numbered ? `${index + 1}. ` : ''}${isDefault ? '★ ' : ''}${modelDisplayName(model)}${options.technical ? `（${model.model_id}）` : ''}`,
        `用途：${modelPurpose(model)}`,
        `服务：${providerName(model)}`,
        `能力：${capabilityText(model)}`,
        `状态：${model.enabled ? modelCheckStatus(model) : '已禁用'}`,
      ].join('｜');
    })
    .join('\n')}\n`;
}

async function hiddenPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try { return await readline.question(question); } finally { readline.close(); }
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new MercuryError('MODEL_SETUP_CANCELLED', '已取消密钥输入。'));
          return;
        }
        if (byte === 13 || byte === 10) {
          process.stdout.write('\n');
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (byte >= 32) {
          value += String.fromCharCode(byte);
          process.stdout.write('•');
        }
      }
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

function terminalPromptSession() {
  let readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    prompt: (question: string) => readline.question(question),
    secret: async (question: string) => {
      // readline itself echoes terminal input. Close it while the raw-mode secret
      // reader owns stdin, then recreate it for the next ordinary question.
      readline.close();
      try {
        return await hiddenPrompt(question);
      } finally {
        readline = createInterface({ input: process.stdin, output: process.stdout });
      }
    },
    close: () => readline.close(),
  };
}

async function interactiveModelValue(
  workspaceRoot: string,
  prompt: (question: string) => Promise<string>,
  secret: (question: string) => Promise<string>,
  existing?: string | ModelConfigV2,
): Promise<{ value: Record<string, unknown>; makeDefault: boolean }> {
  const existingModel = typeof existing === 'object' ? existing : undefined;
  const existingProviderConfig = existingModel?.provider_config as
    | Record<string, unknown>
    | undefined;
  const modelId =
    (typeof existing === 'string' ? existing : existingModel?.model_id) ??
    (await prompt('模型简称（例如 asr-backup）：')).trim();
  if (!modelId) throw new MercuryError('MODEL_SETUP_INVALID', '模型简称不能为空。');
  const categoryChoice = existingModel
    ? existingModel.category === 'asr'
      ? '1'
      : '2'
    : (await prompt('用途：1 语音转文字 / 2 内容校准 [1]：')).trim() || '1';
  let value: Record<string, unknown>;
  let pendingSecret: string | null = null;
  if (categoryChoice === '1') {
    const defaultProvider =
      existingModel?.plugin_id === 'volcengine_asr' ? '2' : '1';
    const provider =
      (await prompt(
        `服务：1 火山音视频字幕 / 2 火山极速版 [${defaultProvider}]：`,
      )).trim() || defaultProvider;
    if (provider === '1') {
      const canKeep =
        existingModel?.plugin_id === 'volcengine_subtitle_asr' &&
        existingProviderConfig?.['auth_mode'] === 'legacy' &&
        typeof existingProviderConfig?.['app_id'] === 'string' &&
        existingProviderConfig['app_id'].trim() &&
        existingModel.credential_ref;
      const currentAppId = canKeep
        ? String(existingProviderConfig?.['app_id'] ?? '')
        : '';
      const appId =
        (await prompt(
          `应用标识（APP ID）${currentAppId ? ` [${currentAppId}]` : ''}：`,
        )).trim() || currentAppId;
      const token = (
        await secret(
          `访问令牌（Access Token，输入时隐藏${canKeep ? '，留空保持不变' : ''}）：`,
        )
      ).trim();
      if (!appId || (!token && !canKeep))
        throw new MercuryError('MODEL_SETUP_INVALID', 'APP ID 和 Access Token 都不能为空。');
      const credential = token
        ? JSON.stringify({ mode: 'legacy', appId, token })
        : '';
      const providerConfig = { auth_mode: 'legacy', app_id: appId };
      pendingSecret = credential || null;
      value = {
        model_id: modelId, name: '火山音视频字幕', category: 'asr',
        plugin_id: 'volcengine_subtitle_asr', connection_type: 'volcengine_subtitle_cloud',
        provider_model: 'video-caption', runtime: 'cloud', endpoint: null,
        credential_ref:
          pendingSecret === null ? existingModel?.credential_ref ?? null : null,
        provider_config: providerConfig,
      };
    } else {
      const canKeep =
        existingModel?.plugin_id === 'volcengine_asr' &&
        existingModel.credential_ref;
      const appKey = (
        await secret(
          `APP Key（输入时隐藏${canKeep ? '，留空保持不变' : ''}）：`,
        )
      ).trim();
      if (!appKey && !canKeep)
        throw new MercuryError('MODEL_SETUP_INVALID', 'APP Key 不能为空。');
      pendingSecret = appKey
        ? JSON.stringify({ mode: 'api_key', uid: appKey, value: appKey })
        : null;
      value = {
        model_id: modelId, name: '火山极速版', category: 'asr',
        plugin_id: 'volcengine_asr', connection_type: 'volcengine_cloud',
        provider_model: 'bigmodel', runtime: 'cloud', endpoint: null,
        credential_ref:
          pendingSecret === null ? existingModel?.credential_ref ?? null : null,
        provider_config: { resource_id: 'volc.bigasr.auc_turbo' },
      };
    }
  } else if (categoryChoice === '2') {
    const defaultProvider = existingModel?.plugin_id === 'gemini' ? '2' : '1';
    const provider =
      (await prompt(
        `服务：1 OpenAI 兼容服务 / 2 Vertex AI Gemini [${defaultProvider}]：`,
      )).trim() || defaultProvider;
    if (provider === '2') {
      const currentProject =
        existingModel?.plugin_id === 'gemini'
          ? String(existingProviderConfig?.['project'] ?? '')
          : '';
      const currentLocation =
        existingModel?.plugin_id === 'gemini'
          ? String(existingProviderConfig?.['location'] ?? 'global')
          : 'global';
      const currentModel =
        existingModel?.plugin_id === 'gemini'
          ? existingModel.provider_model
          : '';
      value = {
        model_id: modelId, name: 'Vertex AI Gemini', category: 'chat', plugin_id: 'gemini',
        connection_type: 'vertex_ai',
        provider_model:
          (await prompt(
            `Gemini 模型名称${currentModel ? ` [${currentModel}]` : ''}：`,
          )).trim() || currentModel,
        runtime: 'cloud', endpoint: null, credential_ref: 'adc:local',
        provider_config: {
          project:
            (await prompt(
              `Google Cloud 项目 ID${currentProject ? ` [${currentProject}]` : ''}：`,
            )).trim() || currentProject,
          location:
            (await prompt(`Vertex 区域 [${currentLocation}]：`)).trim() ||
            currentLocation,
        },
      };
    } else {
      const canKeep =
        existingModel?.plugin_id === 'openai_chat_completions' &&
        existingModel.credential_ref;
      const key = (
        await secret(
          `API Key（输入时隐藏，可留空${canKeep ? '；留空保持不变' : ''}）：`,
        )
      ).trim();
      pendingSecret = key || null;
      const currentModel =
        existingModel?.plugin_id === 'openai_chat_completions'
          ? existingModel.provider_model
          : '';
      const currentEndpoint =
        existingModel?.plugin_id === 'openai_chat_completions'
          ? existingModel.endpoint ?? ''
          : '';
      value = {
        model_id: modelId, name: 'OpenAI 兼容校准', category: 'chat', plugin_id: 'openai_chat_completions',
        connection_type: 'compatible_endpoint',
        provider_model:
          (await prompt(
            `模型名称${currentModel ? ` [${currentModel}]` : ''}：`,
          )).trim() || currentModel,
        runtime: 'cloud',
        endpoint:
          (await prompt(
            `服务地址${currentEndpoint ? ` [${currentEndpoint}]` : ''}：`,
          )).trim() || currentEndpoint,
        credential_ref:
          pendingSecret === null && canKeep
            ? existingModel?.credential_ref ?? null
            : null,
        provider_config: {},
      };
    }
  } else throw new MercuryError('MODEL_SETUP_INVALID', '请选择 1 或 2。');
  const providerModel = String(value.provider_model ?? '').trim();
  const baseName = `${String(value.name)}${providerModel ? ` · ${providerModel}` : ''}`;
  const previousProviderSuffix = existingModel
    ? ` · ${existingModel.provider_model}`
    : '';
  const existingSuggestion =
    existingModel && existingModel.name.endsWith(previousProviderSuffix)
      ? `${existingModel.name.slice(0, -previousProviderSuffix.length)} · ${providerModel}`
      : existingModel?.name;
  const suggestedName = await availableModelName(
    workspaceRoot,
    existingSuggestion ?? baseName,
    providerModel,
    modelId,
  );
  const chosenName =
    (await prompt(
      `给这个配置起个名字（用于列表和确认） [${suggestedName}]：`,
    )).trim() || suggestedName;
  const uniqueName = await availableModelName(
    workspaceRoot,
    chosenName,
    providerModel,
    modelId,
  );
  if (uniqueName !== chosenName)
    throw new MercuryError(
      'MODEL_NAME_DUPLICATE',
      `配置名称“${chosenName}”已在使用，请换一个容易区分的名字。`,
    );
  value.name = chosenName;
  const makeDefault = ['y', 'yes', '是'].includes((await prompt('设为该用途的默认模型？[y/N] ')).trim().toLowerCase());
  const displayName = modelDisplayName({
    name: String(value.name),
    provider_model: String(value.provider_model),
  });
  const destination = value.category === 'asr'
    ? `会把 MP3 上传给 ${displayName} 做语音转文字。`
    : value.plugin_id === 'gemini'
      ? '会把转写发送给 Vertex AI Gemini；强校准时还会发送 MP3。'
      : `会把转写发送给 ${displayName} 做内容校准，不发送音频。`;
  if (!['y', 'yes', '是'].includes((await prompt(`${destination}确认保存？[y/N] `)).trim().toLowerCase()))
    throw new MercuryError('MODEL_SETUP_CANCELLED', '已取消模型更改。');
  if (pendingSecret)
    value.credential_ref = await savePrivateSecret(
      workspaceRoot,
      modelId,
      pendingSecret,
    );
  return { value, makeDefault };
}

function setupResultText(
  workspaceRoot: string,
  registry: ModelConfigRegistryV2,
): string {
  const statusLines = registry.models.map(
    (model) =>
      `- ${modelPurpose(model)}｜${modelDisplayName(model)}：${modelCheckStatus(model)}`,
  );
  return [
    `工作区已就绪：${workspaceRoot}`,
    `模型配置已保存：${registry.models.length} 个实例（ASR / Chat 两类）。`,
    '模型检查状态：',
    ...statusLines,
    '下一步：回到主页检查模型，然后运行第一份字幕任务。',
    '',
  ].join('\n');
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new MercuryError('CLI_OPTION_VALUE_MISSING', `${name} 缺少参数值。`, {
      exitCode: 2,
    });
  return value;
}

function machineCommand(args: string[]): string | null {
  if (!args.includes('--json') && !args.includes('--jsonl')) return null;
  if (args[0] === 'calibrate') return 'calibrate.background';
  if (args[0] === 'request' && args[1]) return `request.${args[1]}`;
  if (args[0] === 'model' && args[1]) return `model.${args[1]}`;
  if (args[0] === 'task' && args[1]) return `task.${args[1]}`;
  if (args[0] === 'worker' && args[1]) return `worker.${args[1]}`;
  if (args[0] === 'review' && args[1]) return `review.${args[1]}`;
  if (args[0] === 'skill' && args[1]) return `skill.${args[1]}`;
  return 'unknown';
}

function writeMachine(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

function reviewActor(args: string[]): ReviewActor {
  const actor = optionValue(args, '--actor');
  if (actor && actor !== 'cli' && actor !== 'skill') throw new MercuryError('CLI_ARGUMENT_INVALID', '--actor 只能是 cli 或 skill。', { exitCode: 2 });
  return actor === 'skill' ? 'user_via_skill' : 'user_via_cli';
}

interface WorkerWakeResult {
  queued: boolean;
  running: boolean;
  started: boolean;
  pid: number | null;
  error: null | { code: string; message: string; remediation: string };
}

async function wakeWorkerIfQueued(
  workspaceRoot: string,
  startWorker: typeof startDetachedWorker = startDetachedWorker,
): Promise<WorkerWakeResult> {
  const queued = (await listJobsIsolated(workspaceRoot)).jobs.some((job) => job.state === 'queued');
  if (!queued) {
    const status = await workerStatus(workspaceRoot);
    return { queued: false, running: status.running, started: false, pid: status.worker?.pid ?? null, error: null };
  }
  const status = await workerStatus(workspaceRoot);
  if (status.running) {
    return { queued: true, running: true, started: false, pid: status.worker?.pid ?? null, error: null };
  }
  try {
    const started = await startWorker(workspaceRoot);
    return { queued: true, running: true, started: true, pid: started.pid, error: null };
  } catch (error) {
    return {
      queued: true,
      running: false,
      started: false,
      pid: null,
      error: {
        code: error instanceof MercuryError ? error.code : 'WORKER_START_FAILED',
        message: '任务已安全入队，但后台 Worker 启动失败；没有改为同步执行。',
        remediation: '修复 Node/安装问题后显式运行 mercury worker start --json；不要重新提交任务。',
      },
    };
  }
}

function assertAllowedArguments(
  args: string[],
  valueOptions: Set<string>,
  flagOptions: Set<string>,
): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (valueOptions.has(argument)) {
      index += 1;
      if (index >= args.length || args[index]!.startsWith('--'))
        throw new MercuryError(
          'CLI_OPTION_VALUE_MISSING',
          `${argument} 缺少参数值。`,
          { exitCode: 2 },
        );
      continue;
    }
    if (flagOptions.has(argument)) continue;
    throw new MercuryError(
      'CLI_ARGUMENT_INVALID',
      `不支持的参数：${argument}`,
      { exitCode: 2 },
    );
  }
}

async function statusText(
  task: TaskRecord | TaskRecordV2,
  workspaceRoot: string,
): Promise<string> {
  const taskDirectory = path.join(workspaceRoot, 'tasks', task.task_directory);
  const modern = isTaskRecordV2(task);
  const audioVerificationStatus = modern
    ? null
    : await readAudioVerificationStatus(taskDirectory, task);
  const modelSummary = await readTaskModelSummary(
    taskDirectory,
    task as unknown as TaskRecord,
  );
  const status = taskStatusText(task.execution.status);
  const stage = taskStageText(task);
  const subtitleMetadata = modern ? task.artifacts.subtitles : undefined;
  const transcribedRelative =
    subtitleMetadata?.transcribed?.path ??
    task.artifacts.outputs.find((item) => item.endsWith('.transcribed.srt')) ??
    null;
  const calibratedRelative =
    subtitleMetadata?.calibrated?.path ??
    task.artifacts.outputs.find((item) => item.endsWith('.calibrated.srt')) ??
    null;
  const transcribedPath = transcribedRelative
    ? path.join(taskDirectory, transcribedRelative)
    : null;
  const calibratedPath = calibratedRelative
    ? path.join(taskDirectory, calibratedRelative)
    : null;
  const approvedRelative = modern
    ? task.artifacts.subtitles?.approved?.path ??
      task.artifacts.outputs.find((item) => item.endsWith('.approved.srt')) ??
      null
    : null;
  const approvedPath = approvedRelative
    ? path.join(taskDirectory, approvedRelative)
    : null;
  const reportPath = task.artifacts.report
    ? path.join(taskDirectory, task.artifacts.report)
    : null;
  const errorMessage = task.error
    ? friendlyProviderError(task.error.code, task.error.message)
    : null;
  const lines = [
    `任务：${task.inputs.audio.original_name}`,
    `创建时间：${localTime(task.created_at)}`,
    `状态：${status}`,
    `当前阶段：${stage}`,
    `输入：${task.input_config.has_reference_srt ? `MP3 + 参考 SRT（${task.input_config.mode === 'text-and-segmentation' ? '文字和断句' : '只改文字'}）` : '仅 MP3'}`,
    `纯转写字幕（未经 Chat 校验）：${transcribedPath ?? '尚未生成'}`,
    `校验后字幕：${calibratedPath ?? '尚未生成'}`,
    `人工批准字幕：${approvedPath ?? (modern && task.execution.status === 'completed' ? '尚待审阅' : '尚未生成')}`,
    `报告：${reportPath ?? '尚未生成'}`,
    `错误：${errorMessage ?? '无'}`,
    `下一步：${taskNextStep(task)}`,
    '',
    '技术详情：',
    `任务 ID：${task.task_id}`,
    `目录：${taskDirectory}`,
    `模型快照：${task.model_snapshot.path ?? '-'}`,
    `模型：${modelSummary}`,
    ...(modern
      ? [
          `证据模式：${task.input_config.evidence_mode}`,
          `非强校验原因：${task.input_config.non_strong_reason ?? '-'}`,
        ]
      : [
          `强校验请求：${task.audio_verification.requested ? '是' : '否'}`,
          `强校验状态：${audioVerificationStatus}`,
        ]),
    `执行中断：${task.execution.execution_interrupted ? '是' : '否'}`,
    `工作产物：${task.artifacts.work.join(', ') || '-'}`,
    `输出产物：${task.artifacts.outputs.join(', ') || '-'}`,
    `原始错误：${task.error ? `${task.error.code}｜${task.error.message}` : '-'}`,
    `Adapter 失败：${task.adapter_failures.map((failure) => `${'role' in failure ? failure.role : failure.model_category}:${failure.errors[0]!.code}`).join(', ') || '-'}`,
    `警告：${task.warnings.map((warning) => warning.code).join(', ') || '-'}`,
  ];
  return `${lines.join('\n')}\n`;
}

function taskStatusText(status: string): string {
  const labels: Record<string, string> = {
    created: '已创建',
    preparing: '正在准备',
    analyzing_audio: '正在语音转文字',
    aligning: '正在对齐字幕',
    calibrating: '正在内容校准',
    segmenting: '正在整理断句',
    validating: '正在验证字幕',
    completed: '已完成',
    needs_input: '需要补充输入',
    failed: '失败',
    queued: '排队中',
    running: '后台处理中',
    cancelled: '已取消',
    interrupted: '已中断（不会自动重试）',
  };
  return labels[status] ?? status;
}

function taskStageText(task: TaskRecord | TaskRecordV2): string {
  if (task.execution.status === 'completed') return '全部完成';
  if (task.execution.status === 'queued') return '等待后台 Worker';
  if (task.execution.status === 'running') {
    const stage = isTaskRecordV2(task) ? task.execution.stage : null;
    return stage ? taskStatusText(stage) : '后台处理中';
  }
  if (task.execution.status === 'cancelled') return '已安全停止';
  if (task.execution.status === 'interrupted') return 'Provider 结果不确定';
  if (task.execution.status === 'failed') {
    const failureLabels: Record<string, string> = {
      preparing: '准备输入',
      asr: '语音转文字',
      transcription: '语音转文字',
      analyzing_audio: '语音转文字',
      chat: '内容校准',
      calibration: '内容校准',
      calibrating: '内容校准',
      model_call: '调用模型',
      provider_call: '调用服务',
      model_check: '检查模型',
      input_validation: '检查输入',
      response_validation: '检查服务结果',
      alignment: '对齐字幕',
      output: '生成结果',
      artifact_write: '生成结果',
      validating: '字幕验证',
    };
    return task.failure_stage
      ? `已停止（${failureLabels[task.failure_stage] ?? task.failure_stage}）`
      : '已停止';
  }
  return task.execution.last_completed_stage
    ? taskStatusText(task.execution.last_completed_stage)
    : '尚未开始';
}

function taskNextStep(task: TaskRecord | TaskRecordV2): string {
  if (task.execution.status === 'completed') return '可直接打开上方字幕和报告。';
  if (task.execution.status === 'cancelled') return '如仍需要字幕，请创建新任务。';
  if (task.execution.status === 'interrupted') return '不要自动重试；先查看技术详情，由用户决定是否新建任务。';
  if (task.error?.code === 'MODEL_CHECK_NOT_PASSED')
    return '回到主页进入“管理模型”，选择对应模型并执行检查。';
  if (task.execution.status === 'needs_input')
    return '检查参考 SRT 是否与 MP3 匹配，然后重新创建任务。';
  if (task.execution.status === 'failed')
    return '先查看上方错误；可进入“管理模型”重新检查或编辑服务配置。';
  return '稍后回到“查看最近任务”刷新状态。';
}

function yes(value: string): boolean {
  return ['y', 'yes', '是'].includes(value.trim().toLowerCase());
}

function cancellation(error: unknown): boolean {
  if (error instanceof MercuryError)
    return ['MODEL_SETUP_CANCELLED', 'CLI_CANCELLED'].includes(error.code);
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'AbortError' ||
    /aborted with ctrl\+c|cancelled|canceled|premature close|end of input|eof/iu.test(
      error.message,
    )
  );
}

function assertInteractive(io: CliIo, operation: string): void {
  if (!io.prompt && !process.stdin.isTTY)
    throw new MercuryError(
      'INTERACTIVE_TTY_REQUIRED',
      `${operation}需要交互式终端。`,
      {
        exitCode: 2,
        remediation:
          '在 Terminal 中直接运行 mercury，进入 App 后完成操作；自动化请使用带参数的高级命令。',
      },
    );
}

function modelDetails(
  model: ModelConfigV2,
  registry: ModelConfigRegistryV2,
): string {
  return [
    `名称：${modelDisplayName(model)}`,
    `用途：${modelPurpose(model)}`,
    `服务：${providerName(model)}`,
    `能力：${capabilityText(model)}`,
    `状态：${model.enabled ? modelCheckStatus(model) : '已禁用'}`,
    `默认：${registry.defaults[model.category] === model.model_id ? '是' : '否'}`,
    '',
    '技术详情：',
    `模型 ID：${model.model_id}`,
    `服务模型：${model.provider_model}`,
    `原始检查错误：${model.check?.error ? `${model.check.error.code}｜${model.check.error.message}` : '-'}`,
    '',
  ].join('\n');
}

async function checkSelectedModel(
  workspaceRoot: string,
  model: ModelConfigV2,
  ask: (question: string) => Promise<string>,
  io: CliIo,
  dependencies: ModelRuntimeDependencies,
  suggestedAudio?: string,
): Promise<boolean> {
  let audio = suggestedAudio;
  if (model.category === 'asr' || model.plugin_id === 'gemini') {
    audio = audio?.trim() || (await ask('检查用中文 MP3 路径：')).trim();
    if (!audio) {
      io.stderr('已取消检查：没有选择 MP3。\n');
      return false;
    }
  }
  const result = await checkModelV2(
    workspaceRoot,
    model.model_id,
    audio,
    dependencies,
  );
  if (result.outcome === 'passed') {
    io.stdout(`${modelDisplayName(model)} 检查通过，可以使用。\n`);
    return true;
  }
  const message = friendlyProviderError(
    result.error?.code,
    result.error?.message ?? '服务没有完成检查。',
  );
  io.stderr(`${modelDisplayName(model)} 检查失败：${message}\n`);
  if (result.error?.remediation)
    io.stderr(`下一步：${result.error.remediation}\n`);
  return false;
}

async function interactiveModelCenter(
  workspaceRoot: string,
  ask: (question: string) => Promise<string>,
  askSecret: (question: string) => Promise<string>,
  io: CliIo,
  dependencies: ModelRuntimeDependencies,
): Promise<void> {
  for (;;) {
    let registry = await loadModelRegistryV2(workspaceRoot, dependencies);
    io.stdout(
      `\n模型中心\n${modelListText(registry, { numbered: true })}A. 新增模型\n0. 返回主页\n`,
    );
    const choice = (await ask('请选择模型或操作：')).trim().toLowerCase();
    if (choice === '0' || choice === '') return;
    if (choice === 'a') {
      try {
        const generatedId = `model-${randomUUID()}`;
        const entry = await interactiveModelValue(
          workspaceRoot,
          ask,
          askSecret,
          generatedId,
        );
        registry = await upsertModelV2(
          workspaceRoot,
          entry.value,
          entry.makeDefault,
          dependencies,
        );
        const added = registry.models.find(
          (item) => item.model_id === generatedId,
        )!;
        io.stdout(`已添加：${modelDisplayName(added)}。\n`);
      } catch (error) {
        if (!cancellation(error)) throw error;
        io.stdout('已取消新增，未进行更改。\n');
      }
      continue;
    }
    const index = Number.parseInt(choice, 10) - 1;
    const model = registry.models[index];
    if (!model) {
      io.stderr('请选择列表中的模型、A 或 0。\n');
      continue;
    }
    for (;;) {
      registry = await loadModelRegistryV2(workspaceRoot, dependencies);
      const selected = registry.models.find(
        (item) => item.model_id === model.model_id,
      );
      if (!selected) break;
      io.stdout(
        `\n模型详情｜${modelDisplayName(selected)}\n${modelDetails(selected, registry)}1. 检查是否可用\n2. 编辑配置\n3. ${selected.enabled ? '停用' : '启用'}\n4. 设为默认\n5. 删除\n0. 返回模型中心\n`,
      );
      const action = (await ask('请选择操作：')).trim();
      if (action === '0' || action === '') break;
      try {
        if (action === '1') {
          await checkSelectedModel(
            workspaceRoot,
            selected,
            ask,
            io,
            dependencies,
          );
        } else if (action === '2') {
          const entry = await interactiveModelValue(
            workspaceRoot,
            ask,
            askSecret,
            selected,
          );
          await upsertModelV2(
            workspaceRoot,
            entry.value,
            entry.makeDefault,
            dependencies,
          );
          io.stdout('模型配置已更新；请重新检查后再运行任务。\n');
        } else if (action === '3') {
          if (
            selected.enabled &&
            !yes(await ask(`确认停用“${modelDisplayName(selected)}”？[y/N] `))
          ) {
            io.stdout('已取消停用。\n');
            continue;
          }
          await setModelEnabledV2(
            workspaceRoot,
            selected.model_id,
            !selected.enabled,
            dependencies,
          );
          io.stdout(
            `已${selected.enabled ? '停用' : '启用'}“${modelDisplayName(selected)}”。\n`,
          );
        } else if (action === '4') {
          await setDefaultModelV2(
            workspaceRoot,
            selected.model_id,
            dependencies,
          );
          io.stdout(
            `已将“${modelDisplayName(selected)}”设为${modelPurpose(selected)}默认模型。\n`,
          );
        } else if (action === '5') {
          if (
            !yes(await ask(`删除“${modelDisplayName(selected)}”？此操作不能撤销。[y/N] `))
          ) {
            io.stdout('已取消删除。\n');
            continue;
          }
          await deleteModelV2(
            workspaceRoot,
            selected.model_id,
            dependencies,
          );
          io.stdout(`已删除“${modelDisplayName(selected)}”。\n`);
          break;
        } else {
          io.stderr('请输入 0 到 5。\n');
        }
      } catch (error) {
        if (cancellation(error)) {
          io.stdout('已取消，未进行更改。\n');
          continue;
        }
        if (error instanceof MercuryError) {
          io.stderr(`${error.message}\n`);
          if (error.remediation)
            io.stderr(`下一步：${error.remediation}\n`);
          continue;
        }
        throw error;
      }
    }
  }
}

async function interactiveTaskCenter(
  workspaceRoot: string,
  ask: (question: string) => Promise<string>,
  io: CliIo,
): Promise<void> {
  for (;;) {
    const tasks = (await listTasks(workspaceRoot)).slice(0, 10);
    io.stdout('\n最近任务\n');
    if (!tasks.length) {
      io.stdout('暂无本地任务。完成任务后，可在这里找回字幕和报告。\n');
      return;
    }
    io.stdout(
      `${tasks
        .map(
          (task, index) =>
            `${index + 1}. ${task.inputs.audio.original_name}｜${localTime(task.created_at)}｜${taskStatusText(task.execution.status)}｜${taskStageText(task)}`,
        )
        .join('\n')}\n0. 返回主页\n`,
    );
    const choice = (await ask('选择任务查看详情：')).trim();
    if (choice === '0' || choice === '') return;
    const task = tasks[Number.parseInt(choice, 10) - 1];
    if (!task) {
      io.stderr('请选择列表中的任务或 0。\n');
      continue;
    }
    let selected = task;
    for (;;) {
      io.stdout(`\n任务详情\n${await statusText(selected, workspaceRoot)}`);
      const modern = isTaskRecordV2(selected) && selected.schema_version === '4.0.0';
      if (!modern) {
        await ask('此历史任务仅支持查看。按回车返回最近任务：');
        break;
      }
      const running = ['queued', 'running'].includes(selected.execution.status);
      const completed = selected.execution.status === 'completed';
      io.stdout(`${running ? '1. 刷新状态\n2. 取消任务\n' : ''}${completed ? '3. 审阅 AI 修改\n' : ''}0. 返回最近任务\n`);
      const action = (await ask('请选择操作：')).trim();
      if (action === '0' || action === '') break;
      if (running && action === '1') {
        selected = await findTask(workspaceRoot, selected.task_id);
        continue;
      }
      if (running && action === '2') {
        if (!yes(await ask(`确认取消“${selected.inputs.audio.original_name}”？[y/N] `))) {
          io.stdout('已取消本次操作。\n');
          continue;
        }
        const result = await cancelBackgroundTask(workspaceRoot, selected as unknown as TaskRecordV2);
        io.stdout(result.pending ? '已记录取消请求；后台会在安全边界停止。\n' : '任务已取消，未调用尚未开始的服务。\n');
        selected = result.task as unknown as TaskRecord;
        continue;
      }
      if (completed && action === '3') {
        const directory = path.join(workspaceRoot, 'tasks', selected.task_directory);
        const { review } = await readVerifiedReview(directory);
        io.stdout(`审阅状态：${review.status}｜共 ${review.counts.total} 项｜待决定 ${review.counts.pending} 项\n`);
        const next = review.changes.find((item) => item.decision === 'pending');
        if (!next) {
          if (!review.approved_artifact && yes(await ask('全部决定完成，现在生成批准后字幕？[Y/n] '))) {
            const finalized = await finalizeReview(directory);
            io.stdout(`批准后字幕：${path.join(directory, finalized.approved_artifact!.path)}\n`);
          } else await ask('按回车返回任务详情：');
          continue;
        }
        io.stdout([`修改 ${next.change_id}`, `时间：${formatMilliseconds(next.start_ms)} → ${formatMilliseconds(next.end_ms)}`, `纯转写：${next.original_text}`, `AI 校验：${next.proposed_text}`, `原因：${next.reason}`, '1. 接受 AI 校验  2. 保留纯转写  3. 自己编辑  0. 稍后处理', ''].join('\n'));
        const choice = (await ask('请选择：')).trim();
        if (choice === '0' || choice === '') continue;
        const text = choice === '3' ? (await ask('批准稿文字：')).trim() : undefined;
        await decideReviewChange(directory, { changeId: next.change_id, decision: choice === '1' ? 'accepted' : choice === '2' ? 'rejected' : 'edited', ...(text !== undefined ? { text } : {}), actor: 'user_via_cli' });
        io.stdout('决定已保存，可退出后继续审阅。\n');
        continue;
      }
      io.stderr('请选择当前可用操作。\n');
    }
  }
}

function formatMilliseconds(value: number): string {
  const seconds = Math.floor(value / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(value % 1_000).padStart(3, '0')}`;
}

async function ensureDefaultModelsReady(
  workspaceRoot: string,
  audio: string,
  ask: (question: string) => Promise<string>,
  askSecret: (question: string) => Promise<string>,
  io: CliIo,
  dependencies: ModelRuntimeDependencies,
): Promise<boolean> {
  for (;;) {
    const registry = await loadModelRegistryV2(workspaceRoot, dependencies);
    const defaults = [registry.defaults.asr, registry.defaults.chat]
      .map((id) => registry.models.find((model) => model.model_id === id))
      .filter((model): model is ModelConfigV2 => Boolean(model));
    const notReady = defaults.filter(
      (model) =>
        !model.enabled ||
        model.check?.outcome !== 'passed' ||
        !model.verified_capabilities,
    );
    if (!notReady.length) return true;
    io.stderr(
      `运行前需要检查：${notReady.map((model) => `${modelDisplayName(model)}（${modelPurpose(model)}）`).join('、')}。\n`,
    );
    io.stdout('1. 现在检查\n2. 打开模型中心\n0. 取消任务\n');
    const action = (await ask('请选择 [1]：')).trim() || '1';
    if (action === '0') {
      io.stdout('已取消任务。\n');
      return false;
    }
    if (action === '2') {
      await interactiveModelCenter(
        workspaceRoot,
        ask,
        askSecret,
        io,
        dependencies,
      );
      continue;
    }
    if (action !== '1') {
      io.stderr('请输入 0、1 或 2。\n');
      continue;
    }
    for (const model of notReady) {
      await checkSelectedModel(
        workspaceRoot,
        model,
        ask,
        io,
        dependencies,
        audio,
      );
    }
  }
}

export async function runCli(
  args: string[],
  io: CliIo = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
  modelDependencies: ModelRuntimeDependencies = {},
  integrationDependencies: CoreIntegrationDependencies = {},
  backgroundDependencies: {
    startDetachedWorker?: typeof startDetachedWorker;
  } = {},
): Promise<number> {
  const experimentalMachine = args.includes('--experimental');
  if (experimentalMachine) {
    if (!args.includes('--json') && !args.includes('--jsonl')) {
      io.stderr('CLI_ARGUMENT_INVALID: --experimental 只用于旧 JSON/JSONL 机器合同。\n');
      return 2;
    }
    args = args.filter((argument) => argument !== '--experimental');
  }
  const workspaceRoot = defaultWorkspaceRoot(io.homeDirectory ?? homedir());
  const requestedMachineCommand = machineCommand(args);
  try {
    if (!experimentalMachine) {
      const stable = await tryRunStableCli(args, { workspaceRoot, io });
      if (stable !== null) return stable;
    }
    if (args[0] === '__worker') {
      const internalArgs = args.slice(1);
      assertAllowedArguments(internalArgs, new Set(['--workspace']), new Set());
      const internalWorkspace = optionValue(internalArgs, '--workspace');
      if (!internalWorkspace)
        throw new MercuryError('WORKER_START_FAILED', 'Worker 缺少工作区参数。');
      await runWorker(internalWorkspace, integrationDependencies);
      return 0;
    }
    if (args[0] === '--version' || args[0] === '-V') {
      if (args.length !== 1)
        throw new MercuryError(
          'CLI_ARGUMENT_INVALID',
          '--version 不接受其他参数。',
          { exitCode: 2 },
        );
      io.stdout(`${await readProductVersion()}\n`);
      return 0;
    }
    if (args.length === 0) {
      if (!io.prompt && !process.stdin.isTTY) {
        io.stdout(HELP);
        return 0;
      }
      await ensureWorkspace(workspaceRoot);
      const terminal = io.prompt ? null : terminalPromptSession();
      const ask = io.prompt ?? terminal!.prompt;
      const askSecret = io.secretPrompt ?? terminal?.secret ?? hiddenPrompt;
      try {
        let registry: ModelConfigRegistryV2;
        try {
          registry = await loadModelRegistryV2(workspaceRoot, modelDependencies);
        } catch (error) {
          if (!(error instanceof MercuryError) || error.code !== 'MODEL_NOT_CONFIGURED') throw error;
          io.stdout([
            '欢迎使用 Mercury',
            '把中文 MP3 变成可继续剪辑的校准字幕。',
            `所有任务都保存在：${workspaceRoot}`,
            '开始前将配置一个语音转文字服务和一个内容校准服务。',
            '',
          ].join('\n'));
          registry = await setupInteractiveV2(workspaceRoot, ask, askSecret, modelDependencies);
          io.stdout(setupResultText(workspaceRoot, registry));
          const checkNow = (await ask('现在用一段中文 MP3 检查两个模型？[Y/n] ')).trim().toLowerCase();
          if (!['n', 'no', '否'].includes(checkNow)) {
            const audio = (await ask('检查用 MP3 路径：')).trim();
            if (audio) {
              const asr = await checkModelV2(workspaceRoot, registry.defaults.asr, audio, modelDependencies);
              io.stdout(`语音转文字检查：${asr.outcome === 'passed' ? '可用' : `失败（${asr.error?.code}）`}\n`);
              const chatModel = registry.models.find((item) => item.model_id === registry.defaults.chat)!;
              const chat = await checkModelV2(
                workspaceRoot,
                registry.defaults.chat,
                chatModel.plugin_id === 'gemini' ? audio : undefined,
                modelDependencies,
              );
              io.stdout(`内容校准检查：${chat.outcome === 'passed' ? '可用' : `失败（${chat.error?.code}）`}\n`);
              registry = await loadModelRegistryV2(workspaceRoot, modelDependencies);
            }
          }
        }
        for (;;) {
          io.stdout([
            '',
            'Mercury 主页',
            '1. 运行新字幕任务（默认）',
            '2. 管理模型',
            '3. 查看最近任务',
            '0. 退出',
            '',
          ].join('\n'));
          const choice = (await ask('请选择 [默认 1]：')).trim() || '1';
          if (choice === '0') return 0;
          if (choice === '2') {
            await interactiveModelCenter(
              workspaceRoot,
              ask,
              askSecret,
              io,
              modelDependencies,
            );
            continue;
          }
          if (choice === '3') {
            await interactiveTaskCenter(workspaceRoot, ask, io);
            continue;
          }
          if (choice !== '1') {
            io.stderr('请输入 0、1、2 或 3。\n');
            continue;
          }
          const audio = (await ask('MP3 路径：')).trim();
          const srt = (await ask('参考 SRT 路径（没有可留空）：')).trim();
          let mode: string[] = [];
          if (srt) {
            const modeChoice = (await ask('校准范围：1 只改文字 / 2 文字和断句 [1]：')).trim() || '1';
            mode = ['--mode', modeChoice === '2' ? 'text-and-segmentation' : 'text-only'];
          }
          if (
            !(await ensureDefaultModelsReady(
              workspaceRoot,
              audio,
              ask,
              askSecret,
              io,
              modelDependencies,
            ))
          )
            continue;
          const code = await runCli(
            ['calibrate', '--audio', audio, ...(srt ? ['--srt', srt] : []), ...mode, '--background'],
            io,
            modelDependencies,
            integrationDependencies,
          );
          if (code !== 0)
            io.stderr(
              '任务未完成。下一步：进入“管理模型”重新检查或编辑服务；也可在“查看最近任务”查看错误和已生成文件。\n',
            );
        }
      } finally {
        terminal?.close();
      }
    }
    if (args[0] === '--help' || args[0] === '-h') {
      io.stdout(HELP);
      return 0;
    }

    if (args[0] === 'setup' && wantsHelp(args.slice(1))) {
      if (args.length !== 2)
        throw new MercuryError(
          'CLI_ARGUMENT_INVALID',
          'setup --help 不接受其他参数。',
          { exitCode: 2 },
        );
      io.stdout(SETUP_HELP);
      return 0;
    }
    if (
      args[0] === 'model' &&
      args[1] === 'check' &&
      wantsHelp(args.slice(2))
    ) {
      if (args.length !== 3)
        throw new MercuryError(
          'CLI_ARGUMENT_INVALID',
          'model check --help 不接受其他参数。',
          { exitCode: 2 },
        );
      io.stdout(MODEL_CHECK_HELP);
      return 0;
    }
    if (args[0] === 'calibrate' && wantsHelp(args.slice(1))) {
      if (args.length !== 2)
        throw new MercuryError(
          'CLI_ARGUMENT_INVALID',
          'calibrate --help 不接受其他参数。',
          { exitCode: 2 },
        );
      io.stdout(CALIBRATE_HELP);
      return 0;
    }
    if (
      args[0] === 'task' &&
      args[1] === 'status' &&
      wantsHelp(args.slice(2))
    ) {
      if (args.length !== 3)
        throw new MercuryError(
          'CLI_ARGUMENT_INVALID',
          'task status --help 不接受其他参数。',
          { exitCode: 2 },
        );
      io.stdout(TASK_STATUS_HELP);
      return 0;
    }
    if (args[0] === 'task' && args[1] === 'list' && wantsHelp(args.slice(2))) {
      if (args.length !== 3)
        throw new MercuryError(
          'CLI_ARGUMENT_INVALID',
          'task list --help 不接受其他参数。',
          { exitCode: 2 },
        );
      io.stdout(TASK_LIST_HELP);
      return 0;
    }

    if (args[0] === 'setup') {
      const commandArgs = args.slice(1);
      assertAllowedArguments(
        commandArgs,
        new Set(['--config']),
        new Set(['--confirm-cloud-data']),
      );
      const config = optionValue(commandArgs, '--config');
      await ensureWorkspace(workspaceRoot);
      if (config) {
        const registry = await setupFromFileV2(
          workspaceRoot,
          config,
          commandArgs.includes('--confirm-cloud-data'),
          modelDependencies,
        );
        io.stdout(setupResultText(workspaceRoot, registry));
        return 0;
      }
      assertInteractive(io, '首次设置');
      const terminal = io.prompt ? null : terminalPromptSession();
      try {
        const registry = await setupInteractiveV2(
          workspaceRoot,
          io.prompt ?? terminal!.prompt,
          io.secretPrompt ?? terminal?.secret ?? hiddenPrompt,
          modelDependencies,
        );
        io.stdout(setupResultText(workspaceRoot, registry));
      } finally {
        terminal?.close();
      }
      return 0;
    }

    if (args[0] === 'model' && args[1] === 'list') {
      assertAllowedArguments(args.slice(2), new Set(), new Set(['--json']));
      await ensureWorkspace(workspaceRoot);
      const registry = await loadModelRegistryV2(workspaceRoot, modelDependencies);
      if (args.includes('--json')) {
        writeMachine(io, machineSuccess('model.list', {
          defaults: registry.defaults,
          models: registry.models.map((model) => ({
            model_id: model.model_id,
            display_name: modelDisplayName(model),
            category: model.category,
            purpose: modelPurpose(model),
            provider: providerName(model),
            capability: capabilityText(model),
            enabled: model.enabled,
            check_outcome: model.check?.outcome ?? 'not_checked',
            is_default: registry.defaults[model.category] === model.model_id,
          })),
        }));
      } else io.stdout(modelListText(registry, { technical: true }));
      return 0;
    }

    if (args[0] === 'model' && ['add', 'edit'].includes(args[1] ?? '')) {
      const edit = args[1] === 'edit';
      const commandArgs = args.slice(2);
      assertAllowedArguments(commandArgs, new Set(['--model']), new Set());
      const modelId = optionValue(commandArgs, '--model');
      if (edit && !modelId) throw new MercuryError('MODEL_ID_REQUIRED', 'model edit 必须提供 --model。', { exitCode: 2 });
      assertInteractive(io, edit ? '编辑模型' : '新增模型');
      const existingModel = edit
        ? (await loadModelRegistryV2(workspaceRoot, modelDependencies)).models.find(
            (item) => item.model_id === modelId,
          )
        : undefined;
      if (edit && !existingModel)
        throw new MercuryError(
          'MODEL_NOT_CONFIGURED',
          `模型 ${modelId} 不存在。`,
        );
      const terminal = io.prompt ? null : terminalPromptSession();
      try {
        const entry = await interactiveModelValue(
          workspaceRoot,
          io.prompt ?? terminal!.prompt,
          io.secretPrompt ?? terminal?.secret ?? hiddenPrompt,
          existingModel,
        );
        const registry = await upsertModelV2(workspaceRoot, entry.value, entry.makeDefault, modelDependencies);
        io.stdout(`模型已${edit ? '更新' : '添加'}。\n${modelListText(registry)}`);
      } finally { terminal?.close(); }
      return 0;
    }

    if (args[0] === 'model' && ['enable', 'disable', 'default', 'delete'].includes(args[1] ?? '')) {
      const commandArgs = args.slice(2);
      assertAllowedArguments(commandArgs, new Set(['--model']), new Set());
      const modelId = optionValue(commandArgs, '--model');
      if (!modelId) throw new MercuryError('MODEL_ID_REQUIRED', `model ${args[1]} 必须提供 --model。`, { exitCode: 2 });
      const registry = args[1] === 'default'
        ? await setDefaultModelV2(workspaceRoot, modelId, modelDependencies)
        : args[1] === 'delete'
          ? await deleteModelV2(workspaceRoot, modelId, modelDependencies)
          : await setModelEnabledV2(workspaceRoot, modelId, args[1] === 'enable', modelDependencies);
      io.stdout(`模型设置已更新。\n${modelListText(registry)}`);
      return 0;
    }

    if (args[0] === 'model' && args[1] === 'check') {
      const commandArgs = args.slice(2);
      assertAllowedArguments(
        commandArgs,
        new Set(['--model', '--audio']),
        new Set(),
      );
      const modelId = optionValue(commandArgs, '--model');
      if (!modelId)
        throw new MercuryError(
          'MODEL_ID_REQUIRED',
          'model check 必须提供 --model <model-id>。',
          { exitCode: 2 },
        );
      await ensureWorkspace(workspaceRoot);
      const result = await checkModelV2(
        workspaceRoot,
        modelId,
        optionValue(commandArgs, '--audio'),
        modelDependencies,
      );
      io.stdout(
        result.outcome === 'passed'
          ? `${result.model_id} 可用｜${result.category === 'asr' ? '语音转文字' : '内容校准'}\n`
          : `${result.model_id} 检查失败｜${friendlyProviderError(result.error?.code, result.error?.message ?? '未知原因')}\n${result.error?.remediation ? `下一步：${result.error.remediation}\n` : ''}`,
      );
      return result.outcome === 'failed' ? 1 : 0;
    }

    if (args[0] === 'request' && args[1] === 'id') {
      const commandArgs = args.slice(2);
      assertAllowedArguments(
        commandArgs,
        new Set(['--audio', '--srt', '--mode', '--asr-model', '--chat-model', '--intent']),
        new Set(['--json']),
      );
      const audio = optionValue(commandArgs, '--audio');
      const intent = optionValue(commandArgs, '--intent');
      if (!audio) throw new MercuryError('AUDIO_REQUIRED', 'request id 必须提供 --audio。', { exitCode: 2 });
      if (!intent) throw new MercuryError('REQUEST_INTENT_REQUIRED', 'request id 必须提供 --intent 稳定标签。', { exitCode: 2 });
      const mode = optionValue(commandArgs, '--mode');
      if (mode && mode !== 'text-only' && mode !== 'text-and-segmentation') {
        throw new MercuryError('CALIBRATION_MODE_INVALID', `不支持的校准模式：${mode}`, { exitCode: 2 });
      }
      const derived = await deriveBackgroundRequestId({
        workspaceRoot,
        audioPath: audio,
        ...(optionValue(commandArgs, '--srt') ? { srtPath: optionValue(commandArgs, '--srt')! } : {}),
        ...(mode ? { mode: mode as CalibrationMode } : {}),
        ...(optionValue(commandArgs, '--asr-model') ? { asrModelId: optionValue(commandArgs, '--asr-model')! } : {}),
        ...(optionValue(commandArgs, '--chat-model') ? { chatModelId: optionValue(commandArgs, '--chat-model')! } : {}),
      }, intent);
      if (commandArgs.includes('--json')) writeMachine(io, machineSuccess('request.id', derived));
      else io.stdout(`稳定 request ID：${derived.request_id}\n请先保存此 ID，再用同一 ID 提交后台任务。\n`);
      return 0;
    }

    if (args[0] === 'calibrate') {
      const commandArgs = args.slice(1);
      if (commandArgs.includes('--verify-audio'))
        throw new MercuryError(
          'VERIFY_AUDIO_REMOVED',
          '--verify-audio 已移除；请选择已验证音频能力的 Chat，系统会在唯一一次校准中自动决定证据模式。',
          { exitCode: 2 },
        );
      assertAllowedArguments(
        commandArgs,
        new Set(['--audio', '--srt', '--mode', '--asr-model', '--chat-model', '--request-id']),
        new Set(['--background', '--json']),
      );
      const audio = optionValue(commandArgs, '--audio');
      if (!audio)
        throw new MercuryError(
          'AUDIO_REQUIRED',
          'calibrate 必须提供 --audio。',
          { exitCode: 2 },
        );
      const mode = optionValue(commandArgs, '--mode');
      if (mode && mode !== 'text-only' && mode !== 'text-and-segmentation') {
        throw new MercuryError(
          'CALIBRATION_MODE_INVALID',
          `不支持的校准模式：${mode}`,
          { exitCode: 2 },
        );
      }
      const createOptions = {
        workspaceRoot,
        audioPath: audio,
        ...(optionValue(commandArgs, '--srt')
          ? { srtPath: optionValue(commandArgs, '--srt')! }
          : {}),
        ...(mode ? { mode: mode as CalibrationMode } : {}),
        ...(optionValue(commandArgs, '--asr-model')
          ? { asrModelId: optionValue(commandArgs, '--asr-model')! }
          : {}),
        ...(optionValue(commandArgs, '--chat-model')
          ? { chatModelId: optionValue(commandArgs, '--chat-model')! }
          : {}),
      };
      if (commandArgs.includes('--json') && !commandArgs.includes('--background')) {
        throw new MercuryError('CLI_ARGUMENT_INVALID', '--json 仅用于后台机器合同；同步 calibrate 保持人类输出。', { exitCode: 2 });
      }
      if (commandArgs.includes('--background')) {
        const explicitRequestId = optionValue(commandArgs, '--request-id');
        if (commandArgs.includes('--json') && !explicitRequestId) {
          throw new MercuryError('REQUEST_ID_REQUIRED', '机器后台提交必须显式提供 --request-id，以便丢失输出后安全重放。', { exitCode: 2 });
        }
        const requestId = explicitRequestId ?? `human-${randomUUID()}`;
        const submitted = await submitBackgroundTask({ ...createOptions, requestId });
        const workerStart = await wakeWorkerIfQueued(
          workspaceRoot,
          backgroundDependencies.startDetachedWorker ?? startDetachedWorker,
        );
        const view = await taskMachineView(workspaceRoot, submitted.task);
        if (commandArgs.includes('--json')) {
          writeMachine(io, machineSuccess('calibrate.background', {
            task_id: submitted.task.task_id,
            request_id_hash: submitted.request_id_hash,
            replayed: submitted.replayed,
            status: view.execution.status,
            task: view,
            worker_start: workerStart,
          }));
        } else {
          io.stdout([
            `后台任务：${submitted.task.inputs.audio.original_name}`,
            `任务 ID：${submitted.task.task_id}`,
            `状态：${taskStatusText(submitted.task.execution.status)}`,
            workerStart.running
              ? '任务已保存在本地，可以退出 Mercury；后台处理会继续。'
              : '任务已安全保存在队列，但 Worker 尚未启动；没有改为同步执行。',
            workerStart.error?.remediation ?? '稍后可在“查看最近任务”找回结果。',
            '',
          ].join('\n'));
        }
        return 0;
      }
      const task = await createCalibrationTaskV2(createOptions);
      const taskDirectory = path.join(
        workspaceRoot,
        'tasks',
        task.task_directory,
      );
      io.stdout(`任务 ID：${task.task_id}\n任务目录：${taskDirectory}\n`);
      io.stdout('正在进行：语音转文字 → 内容校准 → 字幕验证\n');
      const finalTask =
        task.execution.status === 'failed'
          ? task
          : await executeCalibrationTaskV2(
              taskDirectory,
              integrationDependencies,
            );
      const transcribedPath = finalTask.artifacts.subtitles?.transcribed?.path;
      const calibratedPath = finalTask.artifacts.subtitles?.calibrated?.path;
      io.stdout(
        `任务状态：${taskStatusText(finalTask.execution.status)}\n校准证据：${finalTask.input_config.evidence_mode === 'audio_multimodal' ? '强校准（模型同时听取音频）' : '非强校准（模型依据文字和时间轴）'}\n纯转写字幕（未经 Chat 校验）：${transcribedPath ? path.join(taskDirectory, transcribedPath) : '-'}\n校验后字幕：${calibratedPath ? path.join(taskDirectory, calibratedPath) : '-'}\n报告：${finalTask.artifacts.report ? path.join(taskDirectory, finalTask.artifacts.report) : '-'}\n`,
      );
      if (finalTask.execution.status !== 'completed') {
        io.stderr(
          `任务未完成字幕处理：${finalTask.error ? friendlyProviderError(finalTask.error.code, finalTask.error.message) : taskStatusText(finalTask.execution.status)}\n`,
        );
      }
      return finalTask.execution.status === 'completed' ? 0 : 1;
    }

    if (args[0] === 'task' && args[1] === 'status') {
      const commandArgs = args.slice(2);
      assertAllowedArguments(commandArgs.slice(1), new Set(), new Set(['--json']));
      if (!commandArgs[0] || commandArgs[0]!.startsWith('--'))
        throw new MercuryError(
          'TASK_ID_REQUIRED',
          'task status 必须提供一个任务 ID。',
          { exitCode: 2 },
        );
      const found = await findTask(workspaceRoot, commandArgs[0]!);
      const task = found;
      if (commandArgs.includes('--json')) {
        writeMachine(io, machineSuccess('task.status', await taskMachineView(workspaceRoot, task as unknown as TaskRecordV2)));
      } else io.stdout(await statusText(task, workspaceRoot));
      return 0;
    }

    if (args[0] === 'task' && args[1] === 'list') {
      assertAllowedArguments(args.slice(2), new Set(), new Set(['--json']));
      const discovered = await listTasks(workspaceRoot);
      const tasks = discovered;
      if (args.includes('--json')) {
        writeMachine(io, machineSuccess('task.list', {
          tasks: await Promise.all(tasks.map((task) => taskMachineView(workspaceRoot, task as unknown as TaskRecordV2))),
        }));
      } else if (tasks.length === 0) io.stdout('暂无本地任务。\n');
      else
        io.stdout(
          `${tasks
            .map((task) =>
              [
                task.inputs.audio.original_name,
                localTime(task.created_at),
                taskStatusText(task.execution.status),
                taskStageText(task),
                task.input_config.has_reference_srt ? 'MP3 + SRT' : '仅 MP3',
                task.artifacts.report
                  ? path.join(workspaceRoot, 'tasks', task.task_directory, task.artifacts.report)
                  : '尚无报告',
              ].join('\t'),
            )
            .join('\n')}\n`,
        );
      return 0;
    }

    if (args[0] === 'task' && ['result', 'cancel'].includes(args[1] ?? '')) {
      const command = args[1]!;
      const commandArgs = args.slice(2);
      assertAllowedArguments(commandArgs.slice(1), new Set(), new Set(['--json']));
      const taskId = commandArgs[0];
      if (!taskId || taskId.startsWith('--')) throw new MercuryError('TASK_ID_REQUIRED', `task ${command} 必须提供一个任务 ID。`, { exitCode: 2 });
      const found = (await findTask(workspaceRoot, taskId)) as unknown as TaskRecordV2;
      if (command === 'cancel') {
        const cancelled = await cancelBackgroundTask(workspaceRoot, found);
        const view = await taskMachineView(workspaceRoot, cancelled.task);
        if (commandArgs.includes('--json')) writeMachine(io, machineSuccess('task.cancel', { pending: cancelled.pending, task: view }));
        else io.stdout(cancelled.pending ? '已记录取消请求；Worker 会在安全边界停止。\n' : `任务状态：${taskStatusText(cancelled.task.execution.status)}\n`);
      } else {
        const view = await taskMachineView(workspaceRoot, found);
        if (commandArgs.includes('--json')) writeMachine(io, machineSuccess('task.result', view));
        else io.stdout(await statusText(found, workspaceRoot));
      }
      return 0;
    }

    if (args[0] === 'task' && args[1] === 'watch') {
      const commandArgs = args.slice(2);
      assertAllowedArguments(commandArgs.slice(1), new Set(['--after']), new Set(['--jsonl']));
      const taskId = commandArgs[0];
      if (!taskId || taskId.startsWith('--')) throw new MercuryError('TASK_ID_REQUIRED', 'task watch 必须提供一个任务 ID。', { exitCode: 2 });
      let sequence = Number.parseInt(optionValue(commandArgs, '--after') ?? '0', 10);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new MercuryError('CLI_ARGUMENT_INVALID', '--after 必须是非负整数。', { exitCode: 2 });
      let terminalEventSeen = false;
      let historyInspected = false;
      for (;;) {
        const discovered = (await findTask(workspaceRoot, taskId)) as unknown as TaskRecordV2;
        const directory = path.join(workspaceRoot, 'tasks', discovered.task_directory);
        if (discovered.schema_version !== '4.0.0') throw new MercuryError('MACHINE_CONTRACT_UNAVAILABLE', '此历史任务没有后台事件。');
        const found = await readTaskRecordV2(directory);
        if (!historyInspected) {
          terminalEventSeen = (await readTaskEvents(directory)).some((event) =>
            ['task_completed', 'task_failed', 'task_cancelled', 'task_interrupted'].includes(event.type),
          );
          historyInspected = true;
        }
        const events = await readTaskEvents(directory, sequence);
        for (const event of events) {
          sequence = event.sequence;
          terminalEventSeen ||= ['task_completed', 'task_failed', 'task_cancelled', 'task_interrupted'].includes(event.type);
          if (commandArgs.includes('--jsonl')) io.stdout(`${JSON.stringify(event)}\n`);
          else io.stdout(`${localTime(event.occurred_at)}｜${event.message}\n`);
        }
        if (['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(found.execution.status) && terminalEventSeen) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return 0;
    }

    if (args[0] === 'worker' && args[1] === 'status') {
      assertAllowedArguments(args.slice(2), new Set(), new Set(['--json']));
      const status = await workerStatus(workspaceRoot);
      const data = {
        running: status.running,
        stale: status.stale,
        state: status.worker?.state ?? 'stopped',
        task_id: status.worker?.task_id ?? null,
        heartbeat_at: status.worker?.heartbeat_at ?? null,
        diagnostic_count: status.worker?.diagnostic_count ?? 0,
      };
      if (args.includes('--json')) writeMachine(io, machineSuccess('worker.status', data));
      else io.stdout(status.running ? `后台 Worker 正在运行${data.task_id ? `，任务 ${data.task_id}` : ''}。\n` : '后台 Worker 当前未运行；查询不会启动任务，可显式运行 mercury worker start。\n');
      return 0;
    }

    if (args[0] === 'worker' && args[1] === 'start') {
      assertAllowedArguments(args.slice(2), new Set(), new Set(['--json']));
      const data = await wakeWorkerIfQueued(
        workspaceRoot,
        backgroundDependencies.startDetachedWorker ?? startDetachedWorker,
      );
      if (args.includes('--json')) writeMachine(io, machineSuccess('worker.start', data));
      else if (!data.queued) io.stdout('当前没有排队任务；未启动 Worker。\n');
      else if (data.running) io.stdout(data.started ? '后台 Worker 已启动。\n' : '后台 Worker 已在运行。\n');
      else io.stderr(`${data.error?.message ?? '后台 Worker 启动失败。'}\n${data.error?.remediation ?? ''}\n`);
      return data.error ? 1 : 0;
    }

    if (args[0] === 'review' && ['status', 'list', 'decide', 'accept-all', 'finalize'].includes(args[1] ?? '')) {
      const operation = args[1]!;
      const commandArgs = args.slice(2);
      const taskId = commandArgs[0];
      if (!taskId || taskId.startsWith('--')) throw new MercuryError('TASK_ID_REQUIRED', `review ${operation} 必须提供一个任务 ID。`, { exitCode: 2 });
      const valueOptions = new Set<string>(['--actor']);
      const flags = new Set<string>(['--json']);
      if (operation === 'list') { valueOptions.add('--after'); valueOptions.add('--limit'); }
      if (operation === 'decide') { valueOptions.add('--change'); valueOptions.add('--text'); flags.add('--accept'); flags.add('--reject'); }
      if (operation === 'accept-all') valueOptions.add('--confirm-count');
      assertAllowedArguments(commandArgs.slice(1), valueOptions, flags);
      const discovered = await (await import('./stable-cli/tasks.js')).findTaskReadOnly(workspaceRoot, taskId);
      const isV5 = 'identity' in discovered;
      if (!isV5 && (discovered as unknown as { schema_version?: string }).schema_version !== '4.0.0') throw new MercuryError('MACHINE_CONTRACT_UNAVAILABLE', '此历史任务不支持人工审阅。');
      const directoryName = isV5 ? discovered.identity.task_directory : (discovered as TaskRecordV2).task_directory;
      const directory = path.join(workspaceRoot, 'tasks', directoryName);
      if (!isV5) await readTaskRecordV2(directory);
      let data: unknown;
      if (operation === 'status') {
        const review = isV5 ? await readVerifiedV5Review(directory) : (await readVerifiedReview(directory)).review;
        data = { task_id: taskId, status: review.status, counts: review.counts, next_change_id: review.changes.find((item) => item.decision === 'pending')?.change_id ?? null, approved_artifact: review.approved_artifact ? { ...review.approved_artifact, absolute_path: path.join(directory, review.approved_artifact.path) } : null };
      } else if (operation === 'list') {
        const review = isV5 ? await readVerifiedV5Review(directory) : (await readVerifiedReview(directory)).review;
        const after = optionValue(commandArgs, '--after');
        const start = after ? review.changes.findIndex((item) => item.change_id === after) + 1 : 0;
        if (after && start === 0) throw new MercuryError('REVIEW_CHANGE_NOT_FOUND', '审阅游标不存在。', { exitCode: 2 });
        const limit = Number.parseInt(optionValue(commandArgs, '--limit') ?? '10', 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MercuryError('CLI_ARGUMENT_INVALID', '--limit 必须是 1–50。', { exitCode: 2 });
        const changes = review.changes.slice(start, start + limit);
        data = { task_id: taskId, status: review.status, counts: review.counts, changes, next_after: start + changes.length < review.changes.length ? changes.at(-1)?.change_id ?? null : null };
      } else if (operation === 'decide') {
        const change = optionValue(commandArgs, '--change');
        if (!change) throw new MercuryError('REVIEW_CHANGE_REQUIRED', 'review decide 必须提供 --change。', { exitCode: 2 });
        const selected = [commandArgs.includes('--accept'), commandArgs.includes('--reject'), optionValue(commandArgs, '--text') !== undefined].filter(Boolean).length;
        if (selected !== 1) throw new MercuryError('CLI_ARGUMENT_INVALID', '必须且只能选择 --accept、--reject 或 --text。', { exitCode: 2 });
        const reviewInput = {
          changeId: change,
          decision: commandArgs.includes('--accept') ? 'accepted' : commandArgs.includes('--reject') ? 'rejected' : 'edited',
          ...(optionValue(commandArgs, '--text') !== undefined ? { text: optionValue(commandArgs, '--text')! } : {}),
          actor: reviewActor(commandArgs),
        } as const;
        const review = isV5 ? await decideV5ReviewChange(directory, reviewInput) : await decideReviewChange(directory, reviewInput);
        data = { task_id: taskId, status: review.status, counts: review.counts, change: review.changes.find((item) => item.change_id === change) };
      } else if (operation === 'accept-all') {
        const rawCount = optionValue(commandArgs, '--confirm-count');
        const confirmCount = Number.parseInt(rawCount ?? '', 10);
        if (!rawCount || !Number.isSafeInteger(confirmCount) || confirmCount < 0) throw new MercuryError('CLI_ARGUMENT_INVALID', '--confirm-count 必须是非负整数。', { exitCode: 2 });
        const review = isV5 ? await acceptAllV5ReviewChanges(directory, { confirmCount, actor: reviewActor(commandArgs) }) : await acceptAllReviewChanges(directory, { confirmCount, actor: reviewActor(commandArgs) });
        data = { task_id: taskId, status: review.status, counts: review.counts };
      } else {
        const review = isV5 ? await finalizeV5Review(directory) : await finalizeReview(directory);
        data = { task_id: taskId, status: review.status, counts: review.counts, approved_artifact: review.approved_artifact ? { ...review.approved_artifact, absolute_path: path.join(directory, review.approved_artifact.path) } : null };
      }
      if (commandArgs.includes('--json')) writeMachine(io, machineSuccess(`review.${operation}`, data));
      else io.stdout(`${JSON.stringify(data, null, 2)}\n`);
      return 0;
    }

    if (args[0] === 'skill' && ['status', 'install'].includes(args[1] ?? '')) {
      const operation = args[1]!;
      const commandArgs = args.slice(2);
      assertAllowedArguments(commandArgs, new Set(['--target']), new Set(['--json']));
      const target = optionValue(commandArgs, '--target');
      const data = operation === 'install'
        ? await installSkill(
            io.homeDirectory ?? homedir(),
            target,
            io.currentDirectory ?? process.cwd(),
          )
        : await skillStatus(
            io.homeDirectory ?? homedir(),
            target,
            io.currentDirectory ?? process.cwd(),
          );
      if (commandArgs.includes('--json')) writeMachine(io, machineSuccess(`skill.${operation}`, data));
      else if (operation === 'install') {
        const installAction = 'install_action' in data
          ? data.install_action
          : 'already_installed';
        io.stdout(
          `${installAction === 'already_installed' ? '已检测到兼容的 Mercury 字幕 Skill' : '已通过旧版兼容方式安装 Mercury 字幕 Skill'}：${data.install_path}\n` +
          `今后推荐使用标准 Skills CLI 管理：${data.recommended_install_command}\n`,
        );
      } else {
        io.stdout(
          `Mercury 字幕 Skill：${data.installed ? data.compatible ? '已安装且兼容' : '已安装但需处理冲突或更新' : '尚未安装'}\n` +
          `位置：${data.installed ? data.install_path : data.recommended_install_path}\n` +
          `${data.duplicate_installations ? `检测到 ${data.installations.length} 份安装，请人工检查后保留需要的一份。\n` : ''}` +
          `推荐安装/更新：${data.recommended_install_command}\n`,
        );
      }
      return 0;
    }

    throw new MercuryError(
      'CLI_COMMAND_INVALID',
      `不支持的命令：${args.join(' ')}`,
      { exitCode: 2, remediation: '执行 mercury --help 查看命令。' },
    );
  } catch (error) {
    if (cancellation(error)) {
      io.stderr('已取消，未进行更改。\n');
      return 130;
    }
    const mercuryError =
      error instanceof MercuryError
        ? error
        : new MercuryError(
            'UNEXPECTED_ERROR',
            error instanceof Error ? error.message : String(error),
          );
    if (requestedMachineCommand) {
      writeMachine(io, machineFailure(requestedMachineCommand, {
        code: mercuryError.code,
        message: friendlyProviderError(mercuryError.code, mercuryError.message),
        remediation: mercuryError.remediation ?? '请核对命令参数和本地任务状态。',
      }));
      return mercuryError.exitCode;
    }
    io.stderr(`${mercuryError.code}: ${mercuryError.message}\n`);
    if (mercuryError.remediation)
      io.stderr(`下一步：${mercuryError.remediation}\n`);
    return mercuryError.exitCode;
  }
}
