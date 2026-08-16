import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ErrorRecord,
  ModelCapabilityProfileV2,
  ModelConfig,
  ModelConfigRegistryV2,
  ModelConfigV2,
  ModelSnapshotEntryV2,
  ModelSnapshotV2,
} from './contracts/index.js';
import {
  computeModelConfigFingerprintV2,
  validateContract,
  validateV2Contract,
} from './contracts/index.js';
import { MercuryError } from './errors.js';
import { ensureWorkspace } from './workspace.js';
import { VolcengineAsrAdapter } from './adapters/volcengine-asr.js';
import { VolcengineSubtitleAsrAdapter } from './adapters/volcengine-subtitle-asr.js';
import {
  CHAT_INLINE_AUDIO_LIMIT_BYTES,
  createChatCalibrationRuntimeV2,
  type ChatCalibrationV2Dependencies,
} from './adapters/chat-calibration-v2.js';
import {
  readCredentialReference,
  readMp3DurationMs,
  parseVolcengineCredential,
  resolveVolcengineCredentialReference,
} from './models.js';
import { sha256File } from './tasks.js';
import type { TranscriptRaw } from './contracts/index.js';
import { audioOnlyAlignment } from './subtitle-core/index.js';

type SetupMethod = 'interactive_cli' | 'non_interactive_flag';
type JsonRecord = Record<string, unknown>;
const CONFIG_NAME = 'model-config.json';

export const ASR_PROFILE_V2: ModelCapabilityProfileV2 = {
  capabilities: ['transcription'],
  input_modalities: ['audio'],
  output_types: ['timed_transcript'],
  structured_output: true,
};
export const TEXT_CHAT_PROFILE_V2: ModelCapabilityProfileV2 = {
  capabilities: ['calibration'],
  input_modalities: ['text'],
  output_types: ['structured_result'],
  structured_output: true,
};
export const AUDIO_CHAT_PROFILE_V2: ModelCapabilityProfileV2 = {
  capabilities: ['calibration'],
  input_modalities: ['text', 'audio'],
  output_types: ['structured_result'],
  structured_output: true,
};

export interface ModelV2RuntimeDependencies {
  now?: () => Date;
  createId?: () => string;
  beforeMigrationTempWrite?: () => void | Promise<void>;
  beforeMigrationReplace?: () => void | Promise<void>;
}
export interface ModelCheckV2Dependencies
  extends ModelV2RuntimeDependencies,
    ChatCalibrationV2Dependencies {}
export interface ModelCheckResultV2 {
  model_id: string;
  category: 'asr' | 'chat';
  outcome: 'passed' | 'failed';
  error: ErrorRecord | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function configPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'config', CONFIG_NAME);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function id(createId: () => string, prefix: string): string {
  return `${prefix}-${createId()}`;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      `${label} 必须是非空字符串。`,
    );
  return value.trim().normalize('NFC');
}
function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}
function assertKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length)
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      `${label} 包含不支持的字段：${extra.join(', ')}`,
    );
}

function declaredProfile(
  pluginId: ModelConfigV2['plugin_id'],
): ModelCapabilityProfileV2 {
  return structuredClone(
    pluginId === 'volcengine_asr' || pluginId === 'volcengine_subtitle_asr'
      ? ASR_PROFILE_V2
      : pluginId === 'gemini'
        ? AUDIO_CHAT_PROFILE_V2
        : TEXT_CHAT_PROFILE_V2,
  );
}

function categories(
  category: 'asr' | 'chat',
  pluginId: ModelConfigV2['plugin_id'],
): Array<
  | 'audio'
  | 'transcript'
  | 'reference_srt'
  | 'calibration_candidate'
  | 'timed_text'
  | 'context'
> {
  if (category === 'asr') return ['audio'];
  return pluginId === 'gemini'
    ? [
        'audio',
        'transcript',
        'reference_srt',
        'calibration_candidate',
        'timed_text',
        'context',
      ]
    : ['transcript', 'reference_srt', 'context'];
}

function confirmation(
  category: 'asr' | 'chat',
  pluginId: ModelConfigV2['plugin_id'],
  confirmed: boolean,
  method: SetupMethod,
  at: string,
  createId: () => string,
) {
  return confirmed
    ? {
        confirmation_id: id(createId, 'confirm'),
        confirmed: true as const,
        confirmed_at: at,
        method,
        data_categories: categories(category, pluginId),
      }
    : {
        confirmation_id: id(createId, 'confirm'),
        confirmed: false as const,
        confirmed_at: null,
        method: null,
        data_categories: [],
      };
}

function setupModel(
  value: unknown,
  confirmed: boolean,
  method: SetupMethod,
  at: string,
  createId: () => string,
): { model: ModelConfigV2; makeDefault: boolean } {
  if (!isRecord(value))
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      'models 中的每一项都必须是对象。',
    );
  assertKeys(
    value,
    [
      'model_id',
      'config_id',
      'name',
      'category',
      'role',
      'plugin_id',
      'adapter',
      'connection_id',
      'connection_type',
      'provider_model',
      'model',
      'runtime',
      'endpoint',
      'credential_ref',
      'provider_config',
      'default',
    ],
    '模型配置',
  );
  const legacyRole = typeof value.role === 'string' ? value.role : null;
  const category = text(
    value.category ?? (legacyRole === 'asr' ? 'asr' : 'chat'),
    'category',
  );
  if (category !== 'asr' && category !== 'chat')
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      `不支持的模型类别：${category}`,
    );
  if (value.runtime !== 'cloud' || !isRecord(value.provider_config))
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      'V0.1 只接受 cloud 模型且 provider_config 必须是对象。',
    );
  const rawPlugin = value.plugin_id ?? value.adapter;
  const pluginId = text(
    rawPlugin === 'vertex_gemini_audio_verifier' ? 'gemini' : rawPlugin,
    'plugin_id',
  ) as ModelConfigV2['plugin_id'];
  const connectionType = text(
    value.connection_type ??
      (pluginId === 'volcengine_asr'
        ? 'volcengine_cloud'
        : pluginId === 'volcengine_subtitle_asr'
          ? 'volcengine_subtitle_cloud'
        : pluginId === 'openai_chat_completions'
          ? 'compatible_endpoint'
          : 'vertex_ai'),
    'connection_type',
  ) as ModelConfigV2['connection_type'];
  if (
    category === 'asr' &&
    (!['volcengine_asr', 'volcengine_subtitle_asr'].includes(pluginId) ||
      !['volcengine_cloud', 'volcengine_subtitle_cloud'].includes(connectionType))
  )
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      'ASR 必须使用 Mercury 随包提供的火山 ASR 插件。',
    );
  if (
    category === 'chat' &&
    ['volcengine_asr', 'volcengine_subtitle_asr'].includes(pluginId)
  )
    throw new MercuryError('MODEL_SETUP_INVALID', 'Chat 不能使用 ASR 插件。');
  if (
    pluginId === 'openai_chat_completions' &&
    connectionType !== 'compatible_endpoint'
  )
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      'OpenAI 兼容 Chat 必须使用 compatible_endpoint。',
    );
  if (
    pluginId === 'gemini' &&
    !['vertex_ai', 'developer_api'].includes(connectionType)
  )
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      'Gemini 必须使用 vertex_ai 或 developer_api。',
    );
  if (pluginId === 'volcengine_asr') {
    assertKeys(
      value.provider_config,
      ['resource_id'],
      '火山 ASR provider_config',
    );
    text(value.provider_config.resource_id, '火山 ASR resource_id');
    if (value.endpoint !== null)
      throw new MercuryError(
        'MODEL_SETUP_INVALID',
        '火山 ASR endpoint 必须为 null。',
      );
  } else if (pluginId === 'volcengine_subtitle_asr') {
    assertKeys(value.provider_config, ['app_id', 'auth_mode'], '火山音视频字幕 provider_config');
    const authMode = text(value.provider_config.auth_mode, '火山音视频字幕凭证方式');
    if (authMode !== 'legacy')
      throw new MercuryError(
        'MODEL_SETUP_INVALID',
        '火山音视频字幕只支持 APP ID + Access Token；请在 Mercury App 的模型中心重新配置。',
      );
    text(value.provider_config.app_id, '火山音视频字幕 APP ID');
    if (connectionType !== 'volcengine_subtitle_cloud' || value.endpoint !== null)
      throw new MercuryError(
        'MODEL_SETUP_INVALID',
        '火山音视频字幕连接配置无效。',
      );
  } else if (pluginId === 'openai_chat_completions') {
    assertKeys(value.provider_config, [], 'OpenAI 兼容 Chat provider_config');
    text(value.endpoint, 'OpenAI 兼容 Chat endpoint');
  } else if (connectionType === 'developer_api') {
    assertKeys(
      value.provider_config,
      [],
      'Gemini Developer API provider_config',
    );
    if (value.endpoint !== null || value.credential_ref === null)
      throw new MercuryError(
        'MODEL_SETUP_INVALID',
        'Gemini Developer API 需要凭证引用且 endpoint 必须为 null。',
      );
  } else {
    assertKeys(
      value.provider_config,
      ['project', 'location'],
      'Vertex AI provider_config',
    );
    text(value.provider_config.project, 'Vertex AI project');
    text(value.provider_config.location, 'Vertex AI location');
    if (value.endpoint !== null)
      throw new MercuryError(
        'MODEL_SETUP_INVALID',
        'Vertex AI endpoint 必须为 null。',
      );
  }
  const modelId = text(value.model_id ?? value.config_id, 'model_id');
  const candidate: ModelConfigV2 = {
    model_id: modelId,
    name: text(value.name, 'name'),
    category,
    plugin_id: pluginId,
    connection_id:
      value.connection_id === undefined
        ? modelId
        : text(value.connection_id, 'connection_id'),
    connection_type: connectionType,
    provider_model: text(value.provider_model ?? value.model, 'provider_model'),
    runtime: 'cloud',
    endpoint: nullableText(value.endpoint, 'endpoint'),
    credential_ref: nullableText(value.credential_ref, 'credential_ref'),
    provider_config: structuredClone(value.provider_config),
    declared_capabilities: declaredProfile(pluginId),
    verified_capabilities: null,
    enabled: true,
    cloud_data_confirmation: confirmation(
      category,
      pluginId,
      confirmed,
      method,
      at,
      createId,
    ) as ModelConfigV2['cloud_data_confirmation'],
    config_fingerprint: '',
    check: null,
  };
  candidate.config_fingerprint = computeModelConfigFingerprintV2(candidate);
  return {
    model: candidate,
    makeDefault: value.default === true && legacyRole !== 'audio_verification',
  };
}

function checkFromLegacy(
  model: ModelConfig,
  candidate: ModelConfigV2,
): ModelConfigV2['check'] {
  if (
    model.role === 'audio_verification' ||
    model.last_check?.outcome !== 'passed'
  )
    return null;
  const verified = model.role === 'asr' ? ASR_PROFILE_V2 : TEXT_CHAT_PROFILE_V2;
  return {
    check_id: model.last_check.check_id,
    model_id: candidate.model_id,
    config_fingerprint: candidate.config_fingerprint,
    category: candidate.category,
    confirmation_ref: candidate.cloud_data_confirmation.confirmation_id,
    started_at: model.last_check.started_at,
    ended_at: model.last_check.ended_at,
    outcome: 'passed',
    actual_model: model.last_check.actual_model ?? candidate.provider_model,
    verified_capabilities: structuredClone(verified),
    evidence: {
      migrated_from: '1.0.0',
      capability: model.role === 'asr' ? 'transcription' : 'calibration',
    },
    error: null,
  };
}

export function migrateModelRegistryV1(value: unknown): ModelConfigRegistryV2 {
  const legacy = validateContract('model-config', value);
  if (!legacy.valid)
    throw new MercuryError(
      'MODEL_CONFIG_MIGRATION_FAILED',
      `v1 配置解析/校验失败：${legacy.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
    );
  const defaults: Partial<ModelConfigRegistryV2['defaults']> = {};
  const models = legacy.value.models.map((old): ModelConfigV2 => {
    const raw = old as unknown as JsonRecord;
    const category = old.role === 'asr' ? 'asr' : 'chat';
    const adapter = String(raw.plugin_id ?? raw.adapter);
    const pluginId = (
      adapter === 'vertex_gemini_audio_verifier' ? 'gemini' : adapter
    ) as ModelConfigV2['plugin_id'];
    const connectionType = String(
      raw.connection_type ??
        (pluginId === 'volcengine_asr'
          ? 'volcengine_cloud'
          : pluginId === 'volcengine_subtitle_asr'
            ? 'volcengine_subtitle_cloud'
          : pluginId === 'openai_chat_completions'
            ? 'compatible_endpoint'
            : 'vertex_ai'),
    ) as ModelConfigV2['connection_type'];
    const candidate: ModelConfigV2 = {
      model_id: old.config_id,
      name: old.name,
      category,
      plugin_id: pluginId,
      connection_id: String(raw.connection_id ?? old.config_id),
      connection_type: connectionType,
      provider_model: old.model,
      runtime: 'cloud',
      endpoint: old.endpoint,
      credential_ref: old.credential_ref,
      provider_config: structuredClone(old.provider_config),
      declared_capabilities: declaredProfile(pluginId),
      verified_capabilities: null,
      enabled: old.enabled,
      cloud_data_confirmation: structuredClone(old.cloud_data_confirmation),
      config_fingerprint: '',
      check: null,
    };
    candidate.config_fingerprint = computeModelConfigFingerprintV2(candidate);
    candidate.check = checkFromLegacy(old, candidate);
    candidate.verified_capabilities =
      candidate.check?.verified_capabilities ?? null;
    if (old.role === 'asr' && legacy.value.defaults.asr === old.config_id)
      defaults.asr = old.config_id;
    if (
      old.role === 'calibration' &&
      legacy.value.defaults.calibration === old.config_id
    )
      defaults.chat = old.config_id;
    return candidate;
  });
  if (!defaults.asr || !defaults.chat)
    throw new MercuryError(
      'MODEL_CONFIG_MIGRATION_FAILED',
      'v1 默认 ASR/校准无法映射到 v2。',
    );
  const candidate = {
    schema_version: '2.0.0',
    updated_at: legacy.value.updated_at,
    defaults,
    models,
  };
  const validation = validateV2Contract('model-config', candidate);
  if (!validation.valid)
    throw new MercuryError(
      'MODEL_CONFIG_MIGRATION_FAILED',
      `v2 配置校验失败：${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
    );
  return validation.value;
}

async function atomicWrite(
  filePath: string,
  value: unknown,
  dependencies: ModelV2RuntimeDependencies,
): Promise<void> {
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await dependencies.beforeMigrationTempWrite?.();
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await dependencies.beforeMigrationReplace?.();
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function loadModelRegistryV2(
  workspaceRoot: string,
  dependencies: ModelV2RuntimeDependencies = {},
): Promise<ModelConfigRegistryV2> {
  const filePath = configPath(workspaceRoot);
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new MercuryError('MODEL_NOT_CONFIGURED', '尚未找到模型配置。', {
        remediation: '请运行 mercury 打开交互式 App，在“模型中心”完成模型配置；密钥请在隐藏输入中填写，不要在聊天中发送凭据。',
      });
    throw new MercuryError(
      'MODEL_CONFIG_READ_FAILED',
      `无法读取模型配置：${errorMessage(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new MercuryError(
      'MODEL_CONFIG_INVALID',
      `模型配置 JSON 无法解析：${errorMessage(error)}`,
    );
  }
  if (isRecord(parsed) && parsed.schema_version === '2.0.0') {
    const validation = validateV2Contract('model-config', parsed);
    if (!validation.valid)
      throw new MercuryError(
        'MODEL_CONFIG_INVALID',
        validation.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join('; '),
      );
    return validation.value;
  }
  const migrated = migrateModelRegistryV1(parsed);
  try {
    await atomicWrite(filePath, migrated, dependencies);
  } catch (error) {
    throw new MercuryError(
      'MODEL_CONFIG_MIGRATION_FAILED',
      `原子迁移未完成，原 v1 配置保持不变：${errorMessage(error)}`,
    );
  }
  return migrated;
}

export async function saveModelRegistryV2(
  workspaceRoot: string,
  registry: unknown,
  dependencies: ModelV2RuntimeDependencies = {},
): Promise<ModelConfigRegistryV2> {
  const validation = validateV2Contract('model-config', registry);
  if (!validation.valid)
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; '),
    );
  await atomicWrite(configPath(workspaceRoot), validation.value, dependencies);
  return validation.value;
}

export async function setupFromFileV2(
  workspaceRoot: string,
  inputPath: string,
  confirmCloudData: boolean,
  dependencies: ModelV2RuntimeDependencies = {},
): Promise<ModelConfigRegistryV2> {
  await ensureWorkspace(workspaceRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true })
        .decode(await readFile(path.resolve(inputPath)))
        .replace(/^\uFEFF/, ''),
    );
  } catch (error) {
    throw new MercuryError(
      'MODEL_SETUP_READ_FAILED',
      `无法读取 setup JSON：${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models))
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      'setup JSON 必须包含 models 数组。',
    );
  assertKeys(parsed, ['models'], 'setup JSON');
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const at = now().toISOString();
  const inputs = parsed.models.map((value) =>
    setupModel(value, confirmCloudData, 'non_interactive_flag', at, createId),
  );
  const ids = inputs.map(({ model }) => model.model_id);
  if (new Set(ids).size !== ids.length)
    throw new MercuryError('MODEL_SETUP_INVALID', 'model_id 不能重复。');
  const defaults: Partial<ModelConfigRegistryV2['defaults']> = {};
  for (const category of ['asr', 'chat'] as const) {
    const candidates = inputs.filter(
      (input) => input.model.category === category && input.makeDefault,
    );
    if (candidates.length !== 1)
      throw new MercuryError(
        'MODEL_SETUP_INVALID',
        `${category} 必须且只能设置一个 default=true。`,
      );
    defaults[category] = candidates[0]!.model.model_id;
  }
  return saveModelRegistryV2(
    workspaceRoot,
    {
      schema_version: '2.0.0',
      updated_at: at,
      defaults,
      models: inputs.map((input) => input.model),
    },
    dependencies,
  );
}

function yes(value: string, fallback = false): boolean {
  const answer = value.trim().toLowerCase();
  return answer === '' ? fallback : ['y', 'yes', '是'].includes(answer);
}

async function savePrivateSecret(
  workspaceRoot: string,
  name: string,
  value: string,
): Promise<string> {
  if (!value.trim())
    throw new MercuryError('MODEL_SETUP_INVALID', '密钥不能为空。');
  const directory = path.join(workspaceRoot, 'config', 'secrets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${name}.secret`);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temporary, value, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return `file:${target}`;
}

export async function setupInteractiveV2(
  workspaceRoot: string,
  prompt: (question: string) => Promise<string>,
  secretPrompt: (question: string) => Promise<string> = prompt,
  dependencies: ModelV2RuntimeDependencies = {},
): Promise<ModelConfigRegistryV2> {
  await ensureWorkspace(workspaceRoot);
  const values: JsonRecord[] = [];
  let asrSecret: string;
  let chatSecret: string | null = null;
  const asrChoice =
    (await prompt('语音转文字服务：1 火山音视频字幕（推荐） / 2 火山极速版 [1]：')).trim() || '1';
  if (asrChoice === '1') {
    const appId = (await prompt('应用标识（APP ID）：')).trim();
    const token = (await secretPrompt('访问令牌（Access Token，输入时隐藏）：')).trim();
    if (!appId || !token)
      throw new MercuryError(
        'MODEL_SETUP_INVALID',
        'APP ID 和 Access Token 都不能为空。',
      );
    asrSecret = JSON.stringify({ mode: 'legacy', appId, token });
    values.push({
      model_id: 'asr-default', name: '火山音视频字幕 · video-caption', category: 'asr',
      plugin_id: 'volcengine_subtitle_asr', connection_type: 'volcengine_subtitle_cloud',
      provider_model: 'video-caption', runtime: 'cloud', endpoint: null,
      credential_ref: null,
      provider_config: { auth_mode: 'legacy', app_id: appId }, default: true,
    });
  } else if (asrChoice === '2') {
    const credentialMode =
      (await prompt('极速版凭证：1 新版 API Key / 2 旧版 APP ID + APP Key + Access Token [1]：')).trim() || '1';
    let secret: string;
    if (credentialMode === '1') {
      const appKey = (await secretPrompt('APP Key（输入时隐藏）：')).trim();
      if (!appKey)
        throw new MercuryError('MODEL_SETUP_INVALID', 'APP Key 不能为空。');
      secret = JSON.stringify({ mode: 'api_key', uid: appKey, value: appKey });
    } else {
      const appId = (await prompt('APP ID：')).trim();
      const appKey = (await secretPrompt('APP Key（输入时隐藏）：')).trim();
      const accessToken = (await secretPrompt('Access Token（输入时隐藏）：')).trim();
      if (!appId || !appKey || !accessToken)
        throw new MercuryError(
          'MODEL_SETUP_INVALID',
          'APP ID、APP Key 和 Access Token 都不能为空。',
        );
      secret = JSON.stringify({ mode: 'legacy', uid: appId, appKey, accessKey: accessToken });
    }
    asrSecret = secret;
    values.push({
      model_id: 'asr-default', name: '火山极速版 · bigmodel', category: 'asr',
      plugin_id: 'volcengine_asr', connection_type: 'volcengine_cloud',
      provider_model: 'bigmodel', runtime: 'cloud', endpoint: null,
      credential_ref: null,
      provider_config: { resource_id: 'volc.bigasr.auc_turbo' }, default: true,
    });
  } else throw new MercuryError('MODEL_SETUP_INVALID', '请选择 1 或 2。');

  const chatChoice =
    (await prompt('内容校准服务：1 OpenAI 兼容服务 / 2 Vertex AI Gemini [1]：')).trim() || '1';
  if (chatChoice === '2') {
    const providerModel = (await prompt('Gemini 模型名称：')).trim();
    values.push({
      model_id: 'chat-default', name: `Vertex AI Gemini · ${providerModel}`, category: 'chat',
      plugin_id: 'gemini', connection_type: 'vertex_ai',
      provider_model: providerModel, runtime: 'cloud', endpoint: null,
      credential_ref: 'adc:local',
      provider_config: {
        project: await prompt('Google Cloud 项目 ID：'),
        location: (await prompt('Vertex 区域 [global]：')).trim() || 'global',
      },
      default: true,
    });
  } else if (chatChoice === '1') {
    const apiKey = (await secretPrompt('Chat API Key（输入时隐藏，可留空）：')).trim();
    chatSecret = apiKey || null;
    const providerModel = (await prompt('模型名称：')).trim();
    values.push({
      model_id: 'chat-default',
      name: `OpenAI 兼容校准 · ${providerModel}`,
      category: 'chat',
      plugin_id: 'openai_chat_completions',
      connection_type: 'compatible_endpoint',
      provider_model: providerModel,
      runtime: 'cloud',
      endpoint: await prompt('服务地址（例如 https://example.com/v1）：'),
      credential_ref: null,
      provider_config: {},
      default: true,
    });
  } else throw new MercuryError('MODEL_SETUP_INVALID', '请选择 1 或 2。');

  const asrDestination =
    values[0]!.plugin_id === 'volcengine_subtitle_asr'
      ? '火山音视频字幕'
      : '火山极速版';
  const chatDestination =
    values[1]!.plugin_id === 'gemini'
      ? 'Vertex AI Gemini（发送转写；强校准时还会发送 MP3）'
      : 'OpenAI 兼容内容校准服务（只发送转写，不发送音频）';
  if (
    !yes(
      await prompt(
        `将把 MP3 上传给 ${asrDestination} 做语音转文字；把转写发送给 ${chatDestination}。确认保存？[y/N] `,
      ),
    )
  )
    throw new MercuryError(
      'MODEL_SETUP_CANCELLED',
      '已取消 setup，未写入模型配置。',
    );
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const timestamp = now().toISOString();
  // Validate every non-secret field before persisting either credential. This
  // keeps a rejected endpoint/project/model from leaving orphaned secrets.
  const provisionalValues = values.map((value, index) => ({
    ...value,
    credential_ref:
      index === 0 || chatSecret ? `file:/pending/${String(value.model_id)}` : null,
  }));
  const inputs = provisionalValues.map((value) =>
    setupModel(value, true, 'interactive_cli', timestamp, createId),
  );
  const provisionalRegistry = {
    schema_version: '2.0.0',
    updated_at: timestamp,
    defaults: { asr: 'asr-default', chat: 'chat-default' },
    models: inputs.map((item) => item.model),
  };
  const provisionalValidation = validateV2Contract(
    'model-config',
    provisionalRegistry,
  );
  if (!provisionalValidation.valid)
    throw new MercuryError(
      'MODEL_SETUP_INVALID',
      provisionalValidation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; '),
    );
  inputs[0]!.model.credential_ref = await savePrivateSecret(
    workspaceRoot,
    'asr-default',
    asrSecret!,
  );
  inputs[0]!.model.config_fingerprint = computeModelConfigFingerprintV2(
    inputs[0]!.model,
  );
  if (chatSecret) {
    inputs[1]!.model.credential_ref = await savePrivateSecret(
      workspaceRoot,
      'chat-default',
      chatSecret,
    );
    inputs[1]!.model.config_fingerprint = computeModelConfigFingerprintV2(
      inputs[1]!.model,
    );
  }
  return saveModelRegistryV2(
    workspaceRoot,
    {
      ...provisionalRegistry,
      models: inputs.map((item) => item.model),
    },
    dependencies,
  );
}

export async function upsertModelV2(
  workspaceRoot: string,
  value: unknown,
  makeDefault: boolean,
  dependencies: ModelV2RuntimeDependencies = {},
): Promise<ModelConfigRegistryV2> {
  await ensureWorkspace(workspaceRoot);
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const timestamp = now().toISOString();
  const input = setupModel(
    isRecord(value) ? { ...value, default: makeDefault } : value,
    true,
    'interactive_cli',
    timestamp,
    createId,
  );
  let registry: ModelConfigRegistryV2;
  try {
    registry = await loadModelRegistryV2(workspaceRoot, dependencies);
  } catch (error) {
    if (!(error instanceof MercuryError) || error.code !== 'MODEL_NOT_CONFIGURED') throw error;
    throw new MercuryError('MODEL_SETUP_INVALID', '请先完成首次设置，再添加其他模型。');
  }
  const index = registry.models.findIndex((item) => item.model_id === input.model.model_id);
  if (index >= 0) {
    input.model.enabled = registry.models[index]!.enabled;
    registry.models[index] = input.model;
  }
  else registry.models.push(input.model);
  if (makeDefault) registry.defaults[input.model.category] = input.model.model_id;
  registry.updated_at = timestamp;
  return saveModelRegistryV2(workspaceRoot, registry, dependencies);
}

export async function setDefaultModelV2(
  workspaceRoot: string,
  modelId: string,
  dependencies: ModelV2RuntimeDependencies = {},
): Promise<ModelConfigRegistryV2> {
  const registry = await loadModelRegistryV2(workspaceRoot, dependencies);
  const model = registry.models.find((item) => item.model_id === modelId && item.enabled);
  if (!model) throw new MercuryError('MODEL_NOT_CONFIGURED', `模型 ${modelId} 不存在或已禁用。`);
  registry.defaults[model.category] = model.model_id;
  registry.updated_at = (dependencies.now ?? (() => new Date()))().toISOString();
  return saveModelRegistryV2(workspaceRoot, registry, dependencies);
}

export async function setModelEnabledV2(
  workspaceRoot: string,
  modelId: string,
  enabled: boolean,
  dependencies: ModelV2RuntimeDependencies = {},
): Promise<ModelConfigRegistryV2> {
  const registry = await loadModelRegistryV2(workspaceRoot, dependencies);
  const model = registry.models.find((item) => item.model_id === modelId);
  if (!model) throw new MercuryError('MODEL_NOT_CONFIGURED', `模型 ${modelId} 不存在。`);
  if (!enabled && registry.defaults[model.category] === modelId)
    throw new MercuryError('MODEL_IS_DEFAULT', '默认模型不能禁用；请先设置另一个默认模型。');
  model.enabled = enabled;
  registry.updated_at = (dependencies.now ?? (() => new Date()))().toISOString();
  return saveModelRegistryV2(workspaceRoot, registry, dependencies);
}

export async function deleteModelV2(
  workspaceRoot: string,
  modelId: string,
  dependencies: ModelV2RuntimeDependencies = {},
): Promise<ModelConfigRegistryV2> {
  const registry = await loadModelRegistryV2(workspaceRoot, dependencies);
  const model = registry.models.find((item) => item.model_id === modelId);
  if (!model) throw new MercuryError('MODEL_NOT_CONFIGURED', `模型 ${modelId} 不存在。`);
  if (registry.defaults[model.category] === modelId)
    throw new MercuryError('MODEL_IS_DEFAULT', '默认模型不能删除；请先设置另一个默认模型。');
  registry.models = registry.models.filter((item) => item.model_id !== modelId) as typeof registry.models;
  registry.updated_at = (dependencies.now ?? (() => new Date()))().toISOString();
  const saved = await saveModelRegistryV2(workspaceRoot, registry, dependencies);
  const credentialRef = model.credential_ref;
  if (
    credentialRef?.startsWith('file:') &&
    !saved.models.some((item) => item.credential_ref === credentialRef)
  ) {
    const secretsDirectory = path.resolve(workspaceRoot, 'config', 'secrets');
    const secretPath = path.resolve(credentialRef.slice('file:'.length));
    const ownedSecretPath = path.join(secretsDirectory, `${model.model_id}.secret`);
    if (secretPath === ownedSecretPath) await rm(secretPath, { force: true });
  }
  return saved;
}

export { savePrivateSecret };

export function snapshotModelV2(
  model: ModelConfigV2,
  taskId: string,
): ModelSnapshotEntryV2 {
  if (
    !model.enabled ||
    !model.check ||
    model.check.outcome !== 'passed' ||
    !model.verified_capabilities
  )
    throw new MercuryError(
      'MODEL_CHECK_NOT_PASSED',
      `模型 ${model.model_id} 尚未通过有效能力检查。`,
      {
        remediation:
          '运行 mercury 进入 App，在“管理模型”中选择该模型并执行“检查是否可用”。',
      },
    );
  return {
    snapshot_entry_id: `${taskId}-${model.category}`,
    model_id: model.model_id,
    name: model.name,
    category: model.category,
    plugin_id: model.plugin_id,
    connection_id: model.connection_id,
    connection_type: model.connection_type,
    provider_model: model.provider_model,
    runtime: model.runtime,
    endpoint: model.endpoint,
    credential_ref: model.credential_ref,
    provider_config: structuredClone(model.provider_config),
    declared_capabilities: structuredClone(model.declared_capabilities),
    verified_capabilities: structuredClone(model.verified_capabilities),
    cloud_data_confirmation: structuredClone(model.cloud_data_confirmation),
    config_fingerprint: model.config_fingerprint,
    check_snapshot: structuredClone(
      model.check,
    ) as ModelSnapshotEntryV2['check_snapshot'],
  };
}

export function prepareModelSnapshotV2(
  registry: ModelConfigRegistryV2,
  taskId: string,
  capturedAt: string,
  asrModelId?: string,
  chatModelId?: string,
): ModelSnapshotV2 {
  const select = (category: 'asr' | 'chat', explicit?: string) => {
    const modelId = explicit ?? registry.defaults[category];
    const model = registry.models.find(
      (candidate) => candidate.model_id === modelId,
    );
    if (!model || model.category !== category)
      throw new MercuryError(
        'MODEL_SELECTION_INVALID',
        `${category} 模型 ${modelId} 不存在或类别不匹配。`,
      );
    if (!model.cloud_data_confirmation.confirmed)
      throw new MercuryError(
        'CLOUD_DATA_NOT_CONFIRMED',
        `模型 ${modelId} 尚未确认云端数据发送。`,
      );
    return snapshotModelV2(model, taskId);
  };
  const candidate = {
    schema_version: '2.0.0',
    snapshot_id: `${taskId}-models`,
    task_id: taskId,
    captured_at: capturedAt,
    models: {
      asr: select('asr', asrModelId),
      chat: select('chat', chatModelId),
    },
  };
  const validation = validateV2Contract('model-snapshot', candidate);
  if (!validation.valid)
    throw new MercuryError(
      'MODEL_SNAPSHOT_INVALID',
      validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; '),
    );
  return validation.value;
}

function provisionalSnapshot(
  model: ModelConfigV2,
  taskId: string,
  at: string,
): ModelSnapshotEntryV2 {
  const verified = structuredClone(model.declared_capabilities);
  return {
    snapshot_entry_id: `${taskId}-${model.category}`,
    model_id: model.model_id,
    name: model.name,
    category: model.category,
    plugin_id: model.plugin_id,
    connection_id: model.connection_id,
    connection_type: model.connection_type,
    provider_model: model.provider_model,
    runtime: 'cloud',
    endpoint: model.endpoint,
    credential_ref: model.credential_ref,
    provider_config: structuredClone(model.provider_config),
    declared_capabilities: structuredClone(model.declared_capabilities),
    verified_capabilities: verified,
    cloud_data_confirmation: structuredClone(model.cloud_data_confirmation),
    config_fingerprint: model.config_fingerprint,
    check_snapshot: {
      check_id: 'check-bootstrap',
      model_id: model.model_id,
      config_fingerprint: model.config_fingerprint,
      category: model.category,
      confirmation_ref: model.cloud_data_confirmation.confirmation_id,
      started_at: at,
      ended_at: at,
      outcome: 'passed',
      actual_model: model.provider_model,
      verified_capabilities: verified,
      evidence: { bootstrap: true },
      error: null,
    },
  };
}
function asrLegacy(entry: ModelSnapshotEntryV2): any {
  return {
    snapshot_entry_id: entry.snapshot_entry_id,
    role: 'asr',
    config_id: entry.model_id,
    name: entry.name,
    config_fingerprint: entry.config_fingerprint,
    adapter: 'volcengine_asr',
    model: entry.provider_model,
    runtime: 'cloud',
    endpoint: null,
    credential_ref: entry.credential_ref,
    provider_config: entry.provider_config,
    cloud_data_confirmation: entry.cloud_data_confirmation,
    check_snapshot: {
      check_id: 'check-bootstrap',
      config_id: entry.model_id,
      config_fingerprint: entry.config_fingerprint,
      role: 'asr',
      confirmation_ref: entry.cloud_data_confirmation.confirmation_id,
      started_at: entry.check_snapshot.started_at,
      ended_at: entry.check_snapshot.ended_at,
      outcome: 'passed',
      actual_model: entry.provider_model,
      capabilities: {
        role: 'asr',
        sample_sha256: '0'.repeat(64),
        language: 'zh-CN',
        mime_type: 'audio/mpeg',
        audio_input: 'audio_data_base64',
        max_input_bytes: 104857600,
        max_audio_duration_ms: 7200000,
        transcript_chars: 1,
        segment_count: 1,
        timing_granularity: 'segment',
      },
      error: null,
    },
  };
}
function fixedTranscriptV2(
  taskId: string,
  snapshotId: string,
  entryId: string,
  at: string,
  duration = 1000,
  sha = '0'.repeat(64),
): TranscriptRaw {
  return {
    schema_version: '1.0.0',
    task_id: taskId,
    created_at: at,
    audio: {
      path_ref: 'input/check.mp3',
      sha256: sha,
      duration_ms: duration,
      language: 'zh-CN',
      mime_type: 'audio/mpeg',
    },
    full_text: '你好，Mercury。',
    segments: [
      {
        segment_id: 'seg-check-1',
        index: 0,
        start_ms: 0,
        end_ms: duration,
        text: '你好，Mercury。',
        confidence: null,
        words: [],
      },
    ],
    model_snapshot_ref: snapshotId,
    call: {
      call_id: 'call-check-fixture',
      model_snapshot_entry_ref: entryId,
      started_at: at,
      ended_at: at,
      outcome: 'completed',
      error_ref: null,
    },
    raw_response_ref: null,
    warnings: [],
    errors: [],
  };
}
function checkError(
  createId: () => string,
  code: string,
  message: string,
  stage: ErrorRecord['stage'],
  remediation?: string,
): ErrorRecord {
  return {
    error_id: id(createId, 'error'),
    code,
    message,
    stage,
    retryable: false,
    ...(remediation ? { remediation } : {}),
  };
}

export async function checkModelV2(
  workspaceRoot: string,
  modelId: string,
  audioPath: string | undefined,
  dependencies: ModelCheckV2Dependencies = {},
): Promise<ModelCheckResultV2> {
  const registry = await loadModelRegistryV2(workspaceRoot, dependencies);
  const model = registry.models.find((item) => item.model_id === modelId);
  if (!model || !model.enabled)
    throw new MercuryError(
      'MODEL_NOT_CONFIGURED',
      `模型 ${modelId} 不存在或未启用。`,
    );
  if (!model.cloud_data_confirmation.confirmed)
    throw new MercuryError(
      'CLOUD_DATA_NOT_CONFIRMED',
      `模型 ${modelId} 尚未确认云端数据发送。`,
    );
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const started = now().toISOString();
  const checkId = id(createId, 'check');
  const taskId = id(createId, 'model-check');
  const snapshotId = id(createId, 'snapshot');
  const entry = provisionalSnapshot(model, taskId, started);
  let error: ErrorRecord | null = null;
  let profile: ModelCapabilityProfileV2 | null = null;
  let evidence: JsonRecord = {};
  try {
    if (model.category === 'asr') {
      if (!audioPath)
        throw new MercuryError(
          'MODEL_CHECK_AUDIO_REQUIRED',
          '检查 ASR 必须提供 --audio。',
        );
      const absolute = path.resolve(audioPath);
      const duration = await readMp3DurationMs(absolute);
      const sha = await sha256File(absolute);
      const adapter =
        model.plugin_id === 'volcengine_subtitle_asr'
          ? new VolcengineSubtitleAsrAdapter({
              readCredential:
                dependencies.readCredential ?? readCredentialReference,
              ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
            })
          : new VolcengineAsrAdapter({
              resolveCredential: dependencies.readCredential
                ? async (ref) =>
                    parseVolcengineCredential(
                      await dependencies.readCredential!(ref),
                    )
                : resolveVolcengineCredentialReference,
              ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
            });
      const result = await adapter.run({
        taskId,
        modelSnapshotRef: snapshotId,
        model: asrLegacy(entry),
        audio: {
          sourcePath: absolute,
          pathRef: 'input/check.mp3',
          sha256: sha,
          durationMs: duration,
          mimeType: 'audio/mpeg',
          language: 'zh-CN',
        },
      });
      if (result.kind === 'failure')
        throw new MercuryError(
          result.failure.errors[0]!.code,
          result.failure.errors[0]!.message,
          result.failure.errors[0]!.remediation
            ? { remediation: result.failure.errors[0]!.remediation }
            : {},
        );
      profile = structuredClone(ASR_PROFILE_V2);
      evidence = {
        actual_input_modalities: ['audio'],
        structured_output: true,
        segment_count: result.artifact.segments.length,
        sample_sha256: sha,
      };
    } else {
      let audio: null | {
        sourcePath: string;
        pathRef: string;
        sha256: string;
        bytes: number;
        durationMs: number;
        mimeType: 'audio/mpeg';
      } = null;
      if (audioPath && model.plugin_id === 'gemini') {
        const absolute = path.resolve(audioPath);
        const info = await import('node:fs/promises').then((fs) =>
          fs.stat(absolute),
        );
        if (info.size > CHAT_INLINE_AUDIO_LIMIT_BYTES)
          throw new MercuryError(
            'MODEL_CHECK_AUDIO_TOO_LARGE',
            'Chat 音频检查样本必须不大于 15,000,000 bytes。',
          );
        audio = {
          sourcePath: absolute,
          pathRef: 'input/check.mp3',
          sha256: await sha256File(absolute),
          bytes: info.size,
          durationMs: await readMp3DurationMs(absolute),
          mimeType: 'audio/mpeg',
        };
      }
      const transcript = fixedTranscriptV2(
        taskId,
        snapshotId,
        entry.snapshot_entry_id,
        started,
        audio?.durationMs ?? 1000,
        audio?.sha256,
      );
      const runtime = createChatCalibrationRuntimeV2(entry, {
        ...dependencies,
        readCredential: dependencies.readCredential ?? readCredentialReference,
      });
      const result = await runtime.run({
        taskId,
        modelSnapshotRef: snapshotId,
        model: entry,
        transcript,
        alignment: audioOnlyAlignment(transcript),
        referenceSrt: null,
        mode: null,
        evidenceMode: audio ? 'audio_multimodal' : 'text',
        nonStrongReason: audio
          ? null
          : model.declared_capabilities.input_modalities.includes('audio')
            ? 'audio_check_missing_or_stale'
            : 'audio_not_supported',
        audio,
      });
      if (result.kind === 'failure')
        throw new MercuryError(
          result.failure.errors[0]!.code,
          result.failure.errors[0]!.message,
        );
      if (result.artifact.status === 'failed') {
        const checkFailure = result.artifact.errors[0] as
          | ErrorRecord
          | undefined;
        if (!checkFailure)
          throw new MercuryError(
            'MODEL_CHECK_FAILED',
            'Chat 检查失败但没有错误记录。',
          );
        throw new MercuryError(checkFailure.code, checkFailure.message);
      }
      profile = structuredClone(
        audio ? AUDIO_CHAT_PROFILE_V2 : TEXT_CHAT_PROFILE_V2,
      );
      evidence = {
        actual_input_modalities: audio ? ['text', 'audio'] : ['text'],
        structured_output: true,
        suggestion_count: result.artifact.suggestions.length,
      };
    }
  } catch (cause) {
    error =
      cause instanceof MercuryError
        ? checkError(createId, cause.code, cause.message, 'capability', cause.remediation)
        : checkError(
            createId,
            'MODEL_CHECK_FAILED',
            errorMessage(cause),
            'capability',
          );
  }
  const ended = now().toISOString();
  model.verified_capabilities = profile;
  model.check = {
    check_id: checkId,
    model_id: model.model_id,
    config_fingerprint: model.config_fingerprint,
    category: model.category,
    confirmation_ref: model.cloud_data_confirmation.confirmation_id,
    started_at: started,
    ended_at: ended,
    outcome: error ? 'failed' : 'passed',
    actual_model: error ? null : model.provider_model,
    verified_capabilities: profile,
    evidence,
    error,
  };
  registry.updated_at = ended;
  await saveModelRegistryV2(workspaceRoot, registry, dependencies);
  return {
    model_id: model.model_id,
    category: model.category,
    outcome: error ? 'failed' : 'passed',
    error,
  };
}
