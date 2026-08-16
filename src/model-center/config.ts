import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ModelCheckRecord,
  ModelConfig,
  ModelConfigRegistry,
  ModelRole,
  ModelSnapshotEntry
} from '../contracts/index.js';
import { validateContract } from '../contracts/index.js';
import { computeModelConfigFingerprint } from '../contracts/validation/semantic.js';
import { MercuryError } from '../errors.js';
import { capabilityProfileForPlugin, requiredCapability } from './profiles.js';
import type {
  ModelCapabilityProfile,
  ModelInstance,
  PluginModelConfig,
  PluginModelSnapshotEntry,
  ProviderConnection,
  TaskRoleAssignment
} from './types.js';

type JsonRecord = Record<string, unknown>;

const LEGACY_PLUGIN_CONNECTIONS: Record<string, string> = {
  volcengine_asr: 'volcengine_cloud',
  volcengine_subtitle_asr: 'volcengine_subtitle_cloud',
  openai_chat_completions: 'compatible_endpoint',
  vertex_gemini_audio_verifier: 'vertex_ai'
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrationError(message: string): MercuryError {
  return new MercuryError('MODEL_CONFIG_MIGRATION_FAILED', message);
}

function verifiedCheck(
  check: ModelCheckRecord | null,
  profile: ModelCapabilityProfile
): PluginModelConfig['last_check'] {
  if (check === null) return null;
  const existing = isRecord(check) && isRecord(check.verified_capabilities)
    ? check.verified_capabilities as unknown as ModelCapabilityProfile
    : null;
  return {
    ...structuredClone(check),
    verified_capabilities: check.outcome === 'passed'
      ? structuredClone(existing ?? profile)
      : null
  } as PluginModelConfig['last_check'];
}

function normalizeLegacyModel(model: ModelConfig): ModelConfig | PluginModelConfig {
  const value = model as unknown as JsonRecord;
  if (typeof value.plugin_id === 'string') return structuredClone(model);
  const adapter = typeof value.adapter === 'string' ? value.adapter : '';
  const connectionType = LEGACY_PLUGIN_CONNECTIONS[adapter];
  if (!connectionType) {
    throw migrationError(`旧模型配置引用未注册的 Adapter：${adapter || '(missing)'}`);
  }
  const pluginId = adapter === 'vertex_gemini_audio_verifier' ? 'gemini' : adapter;
  const profile = capabilityProfileForPlugin(pluginId);
  if (!profile) throw migrationError(`无法为旧模型配置映射能力：${adapter}`);
  const { adapter: _adapter, ...rest } = value;
  const candidate = {
    ...structuredClone(rest),
    plugin_id: pluginId,
    connection_id: String(value.config_id),
    connection_type: connectionType,
    declared_capabilities: structuredClone(profile),
    last_check: verifiedCheck(model.last_check, profile)
  } as unknown as PluginModelConfig;
  candidate.config_fingerprint = computeModelConfigFingerprint(candidate as unknown as Record<string, unknown>);
  if (candidate.last_check) candidate.last_check.config_fingerprint = candidate.config_fingerprint;
  return candidate;
}

export function normalizeModelRegistry(value: unknown): ModelConfigRegistry {
  const validation = validateContract('model-config', value);
  if (!validation.valid) {
    const summary = validation.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
    throw migrationError(`模型配置不符合兼容协议：${summary}`);
  }
  const candidate = {
    ...structuredClone(validation.value),
    models: validation.value.models.map(normalizeLegacyModel)
  };
  const normalized = validateContract('model-config', candidate);
  if (!normalized.valid) {
    const summary = normalized.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
    throw migrationError(`模型配置无法原子归一化：${summary}`);
  }
  return normalized.value;
}

export async function loadNormalizedModelRegistry(workspaceRoot: string): Promise<ModelConfigRegistry> {
  const filePath = path.join(workspaceRoot, 'config', 'model-config.json');
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MercuryError('MODEL_NOT_CONFIGURED', '尚未找到模型配置。', {
        remediation: '请运行 mercury 打开交互式 App，在“模型中心”完成模型配置；密钥请在隐藏输入中填写，不要在聊天中发送凭据。'
      });
    }
    throw new MercuryError(
      'MODEL_CONFIG_READ_FAILED',
      `无法读取模型配置：${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    return normalizeModelRegistry(value);
  } catch (error) {
    if (error instanceof MercuryError) {
      throw new MercuryError('MODEL_CONFIG_INVALID', error.message);
    }
    throw error;
  }
}

export function isPluginModelConfig(model: ModelConfig): model is ModelConfig & PluginModelConfig {
  return typeof (model as unknown as JsonRecord).plugin_id === 'string';
}

export function requirePluginModelConfig(model: ModelConfig, role?: ModelRole): PluginModelConfig {
  if (!isPluginModelConfig(model)) {
    throw new MercuryError('MODEL_PLUGIN_NOT_MIGRATED', `${model.role} 模型尚未迁入已注册的内置插件。`);
  }
  if (role !== undefined && model.role !== role) {
    throw new MercuryError('MODEL_ROLE_ASSIGNMENT_INVALID', `模型 ${model.config_id} 不能分配给 ${role}。`);
  }
  return model as unknown as PluginModelConfig;
}

export function normalizeSnapshotEntry(entry: ModelSnapshotEntry): PluginModelSnapshotEntry {
  const value = entry as unknown as JsonRecord;
  if (typeof value.plugin_id === 'string') return structuredClone(entry) as unknown as PluginModelSnapshotEntry;
  const adapter = typeof value.adapter === 'string' ? value.adapter : '';
  const connectionType = LEGACY_PLUGIN_CONNECTIONS[adapter];
  const pluginId = adapter === 'vertex_gemini_audio_verifier' ? 'gemini' : adapter;
  const profile = capabilityProfileForPlugin(pluginId);
  if (!connectionType || !profile) {
    throw new MercuryError('MODEL_PLUGIN_UNKNOWN', `模型快照引用未注册的内置插件：${adapter || '(missing)'}`);
  }
  const { adapter: _adapter, ...rest } = value;
  return {
    ...structuredClone(rest),
    plugin_id: pluginId,
    connection_id: String(value.config_id),
    connection_type: connectionType,
    declared_capabilities: structuredClone(profile),
    check_snapshot: verifiedCheck(entry.check_snapshot, profile)
  } as unknown as PluginModelSnapshotEntry;
}

export interface ModelCenterConfigurationView {
  connections: ProviderConnection[];
  model_instances: ModelInstance[];
  role_assignments: TaskRoleAssignment[];
}

export function modelCenterConfiguration(registry: ModelConfigRegistry): ModelCenterConfigurationView {
  const normalized = normalizeModelRegistry(registry);
  const models = normalized.models.filter(isPluginModelConfig).map((model) => model as unknown as PluginModelConfig);
  const connections = models.map((model): ProviderConnection => ({
    connection_id: model.connection_id,
    plugin_id: model.plugin_id,
    connection_type: model.connection_type,
    runtime: model.runtime,
    endpoint: model.endpoint,
    credential_ref: model.credential_ref,
    provider_config: structuredClone(model.provider_config)
  }));
  const modelInstances = models.map((model): ModelInstance => ({
    model_instance_id: model.config_id,
    connection_id: model.connection_id,
    model: model.model,
    declared_capabilities: structuredClone(model.declared_capabilities),
    verified_capabilities: model.last_check?.outcome === 'passed'
      ? structuredClone(model.last_check.verified_capabilities)
      : null
  }));
  const roleAssignments = (Object.entries(normalized.defaults) as Array<[ModelRole, string]>)
    .map(([role, modelId]): TaskRoleAssignment => {
      if (!modelInstances.some((model) => model.model_instance_id === modelId)) {
        throw new MercuryError(
          'MODEL_ROLE_ASSIGNMENT_INVALID',
          `角色 ${role} 引用了未迁入内置插件的模型实例。`
        );
      }
      return {
        role,
        capability: requiredCapability(role).capability,
        model_instance_id: modelId
      };
    });
  return {
    connections,
    model_instances: modelInstances,
    role_assignments: roleAssignments
  };
}
