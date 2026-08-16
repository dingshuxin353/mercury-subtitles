import { createHash } from 'node:crypto';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import commonSchema from '../../schemas/v1/common.schema.json' with { type: 'json' };
import modelConfigSchema from '../../schemas/v2/model-config.schema.json' with { type: 'json' };
import modelSnapshotSchema from '../../schemas/v2/model-snapshot.schema.json' with { type: 'json' };
import calibrationResultSchema from '../../schemas/v2/calibration-result.schema.json' with { type: 'json' };
import type {
  ModelConfigRegistryV2,
  ModelConfigV2,
} from './generated/model-config-v2.js';
import type {
  ModelSnapshotEntryV2,
  ModelSnapshotV2,
} from './generated/model-snapshot-v2.js';
import type { CalibrationResultV2 } from './generated/calibration-result-v2.js';

export type V2ContractName =
  | 'model-config'
  | 'model-snapshot'
  | 'calibration-result';
export interface V2ContractTypeMap {
  'model-config': ModelConfigRegistryV2;
  'model-snapshot': ModelSnapshotV2;
  'calibration-result': CalibrationResultV2;
}
export type V2ValidationResult<T> =
  | { valid: true; value: T; issues: [] }
  | {
      valid: false;
      value: null;
      issues: Array<{ path: string; message: string }>;
    };

const schemas = {
  'model-config': modelConfigSchema,
  'model-snapshot': modelSnapshotSchema,
  'calibration-result': calibrationResultSchema,
} as const;
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
});
addFormats(ajv);
ajv.addKeyword({
  keyword: 'x-mercury-invariant-id',
  schemaType: 'string',
  valid: true,
});
ajv.addKeyword({
  keyword: 'x-mercury-semantic-checks',
  schemaType: 'array',
  valid: true,
});
ajv.addSchema(commonSchema);
for (const schema of Object.values(schemas)) ajv.addSchema(schema);

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

function validProfile(
  category: 'asr' | 'chat',
  profile: ModelConfigV2['declared_capabilities'],
): boolean {
  if (!profile.structured_output) return false;
  if (category === 'asr') {
    return (
      sameStrings(profile.capabilities, ['transcription']) &&
      sameStrings(profile.input_modalities, ['audio']) &&
      sameStrings(profile.output_types, ['timed_transcript'])
    );
  }
  return (
    sameStrings(profile.capabilities, ['calibration']) &&
    profile.input_modalities.includes('text') &&
    sameStrings(profile.output_types, ['structured_result'])
  );
}

function profileSubset(
  verified: ModelConfigV2['verified_capabilities'],
  declared: ModelConfigV2['declared_capabilities'],
): boolean {
  if (verified === null) return true;
  return (
    verified.capabilities.every((value) =>
      declared.capabilities.includes(value),
    ) &&
    verified.input_modalities.every((value) =>
      declared.input_modalities.includes(value),
    ) &&
    verified.output_types.every((value) =>
      declared.output_types.includes(value),
    ) &&
    (!verified.structured_output || declared.structured_output)
  );
}

export function computeModelConfigFingerprintV2(
  model: Pick<
    ModelConfigV2,
    | 'category'
    | 'plugin_id'
    | 'connection_id'
    | 'connection_type'
    | 'provider_model'
    | 'runtime'
    | 'endpoint'
    | 'credential_ref'
    | 'provider_config'
    | 'declared_capabilities'
    | 'cloud_data_confirmation'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        sorted({
          category: model.category,
          plugin_id: model.plugin_id,
          connection_id: model.connection_id,
          connection_type: model.connection_type,
          provider_model: model.provider_model,
          runtime: model.runtime,
          endpoint: model.endpoint,
          credential_ref: model.credential_ref,
          provider_config: model.provider_config,
          declared_capabilities: model.declared_capabilities,
          cloud_data_confirmation_id:
            model.cloud_data_confirmation.confirmation_id,
        }),
      ),
      'utf8',
    )
    .digest('hex');
}

function semanticIssues(
  name: V2ContractName,
  value: unknown,
): Array<{ path: string; message: string }> {
  const root = value as Record<string, any>;
  const issues: Array<{ path: string; message: string }> = [];
  if (name === 'model-config') {
    const models = root.models as ModelConfigV2[];
    const ids = models.map((model) => model.model_id);
    if (new Set(ids).size !== ids.length)
      issues.push({ path: '/models', message: 'model_id 必须全局唯一' });
    for (const category of ['asr', 'chat'] as const) {
      const selected = models.find(
        (model) => model.model_id === root.defaults[category],
      );
      if (!selected || selected.category !== category || !selected.enabled) {
        issues.push({
          path: `/defaults/${category}`,
          message: '默认模型必须存在、启用且类别匹配',
        });
      }
    }
    models.forEach((model, index) => {
      if (
        model.category === 'asr' &&
        !['volcengine_asr', 'volcengine_subtitle_asr'].includes(model.plugin_id)
      )
        issues.push({
          path: `/models/${index}/plugin_id`,
          message: 'ASR 只能使用已发布的火山内置插件',
        });
      if (
        model.category === 'chat' &&
        ['volcengine_asr', 'volcengine_subtitle_asr'].includes(model.plugin_id)
      )
        issues.push({
          path: `/models/${index}/plugin_id`,
          message: 'Chat 不能使用 ASR 插件',
        });
      const connectionAllowed =
        model.plugin_id === 'volcengine_asr'
          ? model.connection_type === 'volcengine_cloud'
          : model.plugin_id === 'volcengine_subtitle_asr'
            ? model.connection_type === 'volcengine_subtitle_cloud'
          : model.plugin_id === 'openai_chat_completions'
            ? model.connection_type === 'compatible_endpoint'
            : model.connection_type === 'vertex_ai' ||
              model.connection_type === 'developer_api';
      if (!connectionAllowed)
        issues.push({
          path: `/models/${index}/connection_type`,
          message: '连接方式与插件不匹配',
        });
      if (!validProfile(model.category, model.declared_capabilities))
        issues.push({
          path: `/models/${index}/declared_capabilities`,
          message: '声明能力不满足模型类别的稳定能力',
        });
      if (
        model.verified_capabilities &&
        !validProfile(model.category, model.verified_capabilities)
      )
        issues.push({
          path: `/models/${index}/verified_capabilities`,
          message: '已验证能力不满足模型类别的稳定能力',
        });
      if (
        !profileSubset(model.verified_capabilities, model.declared_capabilities)
      )
        issues.push({
          path: `/models/${index}/verified_capabilities`,
          message: '已验证能力不得超出插件声明能力',
        });
      if (model.config_fingerprint !== computeModelConfigFingerprintV2(model))
        issues.push({
          path: `/models/${index}/config_fingerprint`,
          message: '配置指纹与执行字段不一致',
        });
      if (model.check === null && model.verified_capabilities !== null)
        issues.push({
          path: `/models/${index}/verified_capabilities`,
          message: '没有检查时不得保留已验证能力',
        });
      if (model.check) {
        if (
          model.check.model_id !== model.model_id ||
          model.check.category !== model.category ||
          model.check.config_fingerprint !== model.config_fingerprint
        ) {
          issues.push({
            path: `/models/${index}/check`,
            message: '检查身份或配置指纹不匹配',
          });
        }
        if (
          model.check.confirmation_ref !==
          model.cloud_data_confirmation.confirmation_id
        )
          issues.push({
            path: `/models/${index}/check/confirmation_ref`,
            message: '检查必须引用当前云端确认',
          });
        if (
          Date.parse(model.check.started_at) > Date.parse(model.check.ended_at)
        )
          issues.push({
            path: `/models/${index}/check`,
            message: '检查开始时间不得晚于结束时间',
          });
        if (
          model.check.outcome === 'passed' &&
          (model.check.verified_capabilities === null ||
            model.check.error !== null)
        ) {
          issues.push({
            path: `/models/${index}/check`,
            message: 'passed 检查必须包含已验证能力且没有错误',
          });
        }
        if (
          model.check.outcome === 'failed' &&
          (model.check.verified_capabilities !== null ||
            model.verified_capabilities !== null ||
            model.check.error === null)
        ) {
          issues.push({
            path: `/models/${index}/check`,
            message: 'failed 检查必须清空已验证能力并记录错误',
          });
        }
        if (
          JSON.stringify(model.check.verified_capabilities) !==
          JSON.stringify(model.verified_capabilities)
        ) {
          issues.push({
            path: `/models/${index}/verified_capabilities`,
            message: '已验证能力必须与检查快照一致',
          });
        }
      }
    });
  } else if (name === 'model-snapshot') {
    if (
      root.models.asr.category !== 'asr' ||
      root.models.chat.category !== 'chat'
    )
      issues.push({ path: '/models', message: '快照必须恰好包含 ASR 与 Chat' });
    if (
      root.models.asr.snapshot_entry_id === root.models.chat.snapshot_entry_id
    )
      issues.push({ path: '/models', message: '快照条目标识必须唯一' });
    for (const category of ['asr', 'chat'] as const) {
      const model = root.models[category] as ModelSnapshotEntryV2;
      if (
        !validProfile(category, model.declared_capabilities) ||
        !validProfile(category, model.verified_capabilities)
      )
        issues.push({
          path: `/models/${category}`,
          message: '快照能力与模型类别不匹配',
        });
      if (
        !profileSubset(model.verified_capabilities, model.declared_capabilities)
      )
        issues.push({
          path: `/models/${category}/verified_capabilities`,
          message: '快照已验证能力超出声明能力',
        });
      if (model.config_fingerprint !== computeModelConfigFingerprintV2(model))
        issues.push({
          path: `/models/${category}/config_fingerprint`,
          message: '快照配置指纹不匹配',
        });
      if (
        model.check_snapshot.model_id !== model.model_id ||
        model.check_snapshot.category !== category ||
        model.check_snapshot.config_fingerprint !== model.config_fingerprint ||
        model.check_snapshot.confirmation_ref !==
          model.cloud_data_confirmation.confirmation_id
      )
        issues.push({
          path: `/models/${category}/check_snapshot`,
          message: '快照检查与冻结模型不匹配',
        });
    }
  } else {
    const request = root.request;
    if (
      request.evidence_mode === 'audio_multimodal' &&
      (request.non_strong_reason !== null || !request.audio)
    )
      issues.push({
        path: '/request',
        message: '强校验必须包含唯一音频引用且没有非强原因',
      });
    if (
      request.evidence_mode === 'text' &&
      (request.non_strong_reason === null || request.audio !== null)
    )
      issues.push({
        path: '/request',
        message: '非强校验必须记录唯一原因且不含音频引用',
      });
    if (root.call.model_snapshot_entry_ref.length === 0)
      issues.push({
        path: '/call/model_snapshot_entry_ref',
        message: '调用必须引用 Chat 快照条目',
      });
    root.suggestions.forEach((suggestion: any, index: number) => {
      if (suggestion.end_ms <= suggestion.start_ms)
        issues.push({
          path: `/suggestions/${index}`,
          message: '建议时间范围必须为正',
        });
      if (
        suggestion.kind === 'uncertain' &&
        suggestion.disposition === 'applied'
      )
        issues.push({
          path: `/suggestions/${index}/disposition`,
          message: '不确定建议不得应用',
        });
      if (
        suggestion.disposition === 'applied' &&
        suggestion.modification_refs.length === 0
      )
        issues.push({
          path: `/suggestions/${index}/modification_refs`,
          message: '已应用建议必须引用修改记录',
        });
    });
  }
  return issues;
}

export function validateV2Contract<N extends V2ContractName>(
  name: N,
  value: unknown,
): V2ValidationResult<V2ContractTypeMap[N]> {
  const validator = ajv.getSchema(schemas[name].$id)!;
  if (!validator(value)) {
    return {
      valid: false,
      value: null,
      issues: (validator.errors ?? []).map((error: ErrorObject) => ({
        path: error.instancePath || '/',
        message: error.message ?? error.keyword,
      })),
    };
  }
  const issues = semanticIssues(name, value);
  return issues.length === 0
    ? {
        valid: true,
        value: structuredClone(value) as V2ContractTypeMap[N],
        issues: [],
      }
    : { valid: false, value: null, issues };
}

export function assertV2Contract<N extends V2ContractName>(
  name: N,
  value: unknown,
): V2ContractTypeMap[N] {
  const result = validateV2Contract(name, value);
  if (!result.valid)
    throw new Error(
      `${name} v2 invalid: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
    );
  return result.value;
}
