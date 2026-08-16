import type { ModelRole, ModelSnapshotEntry } from '../contracts/index.js';
import { MercuryError } from '../errors.js';
import { builtinModelPlugins } from './builtin-plugins.js';
import { normalizeSnapshotEntry } from './config.js';
import { profileSatisfies, requiredCapability } from './profiles.js';
import type {
  AudioVerificationRuntime,
  BuiltinModelPlugin,
  ModelPluginRuntimeDependencies,
  PluginModelSnapshotEntry,
  ProofreadingRuntime,
  TranscriptionRuntime
} from './types.js';

export interface BuiltinPluginSummary {
  plugin_id: string;
  api_version: number;
  connection_types: string[];
  task_capabilities: string[];
}

export class BuiltinPluginRegistry {
  private readonly plugins = new Map<string, BuiltinModelPlugin>();

  constructor(plugins: readonly BuiltinModelPlugin[] = builtinModelPlugins) {
    for (const plugin of plugins) {
      if (plugin.apiVersion !== 1) {
        throw new MercuryError(
          'MODEL_PLUGIN_VERSION_INCOMPATIBLE',
          `内置模型插件 ${plugin.pluginId} 使用不兼容的 API 版本。`
        );
      }
      if (this.plugins.has(plugin.pluginId)) {
        throw new MercuryError('MODEL_PLUGIN_DUPLICATE', `内置模型插件标识重复：${plugin.pluginId}`);
      }
      this.plugins.set(plugin.pluginId, plugin);
    }
  }

  list(): BuiltinPluginSummary[] {
    return [...this.plugins.values()].map((plugin) => ({
      plugin_id: plugin.pluginId,
      api_version: plugin.apiVersion,
      connection_types: [...plugin.connectionTypes],
      task_capabilities: [...plugin.declaredCapabilities.task_capabilities]
    }));
  }

  private resolveEntry(entry: ModelSnapshotEntry, role: ModelRole): {
    entry: PluginModelSnapshotEntry;
    plugin: BuiltinModelPlugin;
  } {
    const normalized = normalizeSnapshotEntry(entry);
    if (normalized.role !== role) {
      throw new MercuryError('MODEL_ROLE_ASSIGNMENT_INVALID', `角色 ${role} 的模型快照分配不匹配。`);
    }
    const plugin = this.plugins.get(normalized.plugin_id);
    if (!plugin) {
      throw new MercuryError('MODEL_PLUGIN_UNKNOWN', `未注册的内置模型插件：${normalized.plugin_id}`);
    }
    if (!plugin.connectionTypes.includes(normalized.connection_type)) {
      throw new MercuryError(
        'MODEL_CONNECTION_TYPE_UNSUPPORTED',
        `插件 ${normalized.plugin_id} 不支持连接方式 ${normalized.connection_type}。`
      );
    }
    const requirement = requiredCapability(role).profile;
    if (!profileSatisfies(plugin.declaredCapabilities, requirement)
      || !profileSatisfies(normalized.declared_capabilities, requirement)) {
      throw new MercuryError('MODEL_CAPABILITY_NOT_DECLARED', `${role} 分配缺少插件声明能力。`);
    }
    const checked = normalized.check_snapshot;
    if (checked.outcome !== 'passed' || checked.verified_capabilities === null) {
      throw new MercuryError('MODEL_CAPABILITY_NOT_VERIFIED', `${role} 分配尚未通过实际能力检查。`);
    }
    if (!profileSatisfies(checked.verified_capabilities, requirement)) {
      throw new MercuryError('MODEL_CAPABILITY_NOT_VERIFIED', `${role} 分配的已验证模态或输出能力不足。`);
    }
    return { entry: normalized, plugin };
  }

  resolveTranscription(
    entry: ModelSnapshotEntry,
    dependencies: ModelPluginRuntimeDependencies = {}
  ): { entry: PluginModelSnapshotEntry; runtime: TranscriptionRuntime } {
    const resolved = this.resolveEntry(entry, 'asr');
    if (!resolved.plugin.createTranscriptionRuntime) {
      throw new MercuryError('MODEL_CAPABILITY_RUNTIME_MISSING', '所选插件未提供 transcription 运行时。');
    }
    return {
      entry: resolved.entry,
      runtime: resolved.plugin.createTranscriptionRuntime(dependencies)
    };
  }

  resolveProofreading(
    entry: ModelSnapshotEntry,
    dependencies: ModelPluginRuntimeDependencies = {}
  ): { entry: PluginModelSnapshotEntry; runtime: ProofreadingRuntime } {
    const resolved = this.resolveEntry(entry, 'calibration');
    if (!resolved.plugin.createProofreadingRuntime) {
      throw new MercuryError('MODEL_CAPABILITY_RUNTIME_MISSING', '所选插件未提供 proofreading 运行时。');
    }
    return {
      entry: resolved.entry,
      runtime: resolved.plugin.createProofreadingRuntime(dependencies)
    };
  }

  resolveAudioVerification(
    entry: ModelSnapshotEntry,
    dependencies: ModelPluginRuntimeDependencies = {}
  ): { entry: PluginModelSnapshotEntry; runtime: AudioVerificationRuntime } {
    const resolved = this.resolveEntry(entry, 'audio_verification');
    if (!resolved.plugin.createAudioVerificationRuntime) {
      throw new MercuryError('MODEL_CAPABILITY_RUNTIME_MISSING', '所选插件未提供 audio_verification 运行时。');
    }
    return {
      entry: resolved.entry,
      runtime: resolved.plugin.createAudioVerificationRuntime(dependencies)
    };
  }
}

export function createBuiltinPluginRegistry(): BuiltinPluginRegistry {
  return new BuiltinPluginRegistry();
}
