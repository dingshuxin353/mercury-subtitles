import { createHash } from 'node:crypto';
import type { ErrorObject, KeywordDefinition } from 'ajv';
import { sensitiveInformationIssues } from './security.js';

export interface SemanticIssue {
  check: string;
  path: string;
  message: string;
}

type JsonRecord = Record<string, unknown>;
type SemanticCheck = (data: unknown) => SemanticIssue[];

interface SemanticCheckDeclaration {
  check: string;
  invariant_id: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function issue(check: string, path: string, message: string): SemanticIssue {
  return { check, path, message };
}

function walk(value: unknown, visitor: (record: JsonRecord, path: string) => void, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visitor, `${path}/${index}`));
    return;
  }
  if (!isRecord(value)) return;
  visitor(value, path || '/');
  for (const [key, child] of Object.entries(value)) {
    walk(child, visitor, `${path}/${key}`);
  }
}

function rootRecord(data: unknown): JsonRecord {
  return isRecord(data) ? data : {};
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0)!);
  const rightPoints = [...right].map((character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function sortFingerprintObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortFingerprintObjectKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareUnicodeCodePoints)
      .map((key) => [key, sortFingerprintObjectKeys(value[key])])
  );
}

function modelConfigFingerprintInput(model: JsonRecord): JsonRecord {
  const confirmation = isRecord(model.cloud_data_confirmation)
    ? model.cloud_data_confirmation
    : {};
  return {
    role: model.role,
    runtime: model.runtime,
    adapter: model.plugin_id ?? model.adapter,
    model: model.model,
    endpoint: model.endpoint,
    credential_ref: model.credential_ref,
    provider_config: model.provider_config,
    cloud_data_confirmation_id: confirmation.confirmation_id
  };
}

export function computeModelConfigFingerprint(model: JsonRecord): string {
  const input = modelConfigFingerprintInput(model);
  return createHash('sha256')
    .update(JSON.stringify(sortFingerprintObjectKeys(input)), 'utf8')
    .digest('hex');
}

const confirmationCategories: Record<string, readonly string[]> = {
  asr: ['audio'],
  calibration: ['transcript', 'reference_srt', 'context'],
  audio_verification: [
    'audio',
    'reference_srt',
    'calibration_candidate',
    'timed_text',
    'context'
  ]
};

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function snapshotEntries(data: unknown): Array<[string, JsonRecord]> {
  const models = rootRecord(data).models;
  return isRecord(models)
    ? Object.entries(models).filter((entry): entry is [string, JsonRecord] => isRecord(entry[1]))
    : [];
}

function gcsBucket(objectUri: unknown): string | undefined {
  if (typeof objectUri !== 'string') return undefined;
  return objectUri.match(/^gs:\/\/([^/]+)\//)?.[1];
}

function stagingKind(staging: JsonRecord): 'gcs' | 'gemini_file' {
  return staging.staging_kind === 'gemini_file' ? 'gemini_file' : 'gcs';
}

function privateGcsIssues(
  check: string,
  model: JsonRecord,
  path: string,
  capabilities: JsonRecord
): SemanticIssue[] {
  const providerConfig = isRecord(model.provider_config) ? model.provider_config : {};
  const configuredBucket = providerConfig.gcs_bucket;
  const privateGcs = isRecord(capabilities.private_gcs) ? capabilities.private_gcs : undefined;
  const localChunking = isRecord(capabilities.local_chunking);
  const issues: SemanticIssue[] = [];
  if (!localChunking && (typeof configuredBucket === 'string') !== Boolean(privateGcs)) {
    issues.push(issue(check, `${path}/capabilities/private_gcs`, 'private_gcs must exist exactly when gcs_bucket is configured'));
  }
  if (localChunking && privateGcs) {
    issues.push(issue(check, `${path}/capabilities/private_gcs`, 'active local chunking checks cannot retain private GCS evidence'));
  }
  if (privateGcs && gcsBucket(privateGcs.object_uri) !== configuredBucket) {
    issues.push(issue(check, `${path}/capabilities/private_gcs/object_uri`, 'private GCS object bucket must match provider_config.gcs_bucket'));
  }
  if (privateGcs) {
    const uploaded = Date.parse(String(privateGcs.uploaded_at));
    const read = Date.parse(String(privateGcs.model_read_at));
    const deleted = Date.parse(String(privateGcs.deleted_at));
    if (Number.isFinite(uploaded) && Number.isFinite(read) && Number.isFinite(deleted) && !(uploaded <= read && read <= deleted)) {
      issues.push(issue(check, `${path}/capabilities/private_gcs`, 'private GCS lifecycle times must be non-decreasing'));
    }
  }
  return issues;
}

function geminiFilesIssues(
  check: string,
  model: JsonRecord,
  path: string,
  capabilities: JsonRecord
): SemanticIssue[] {
  const isDeveloperApi = model.plugin_id === 'gemini' && model.connection_type === 'developer_api';
  const geminiFiles = isRecord(capabilities.gemini_files) ? capabilities.gemini_files : undefined;
  const issues: SemanticIssue[] = [];
  if (geminiFiles && !isDeveloperApi) {
    issues.push(issue(
      check,
      `${path}/capabilities/gemini_files`,
      'gemini_files compatibility evidence is only valid for gemini/developer_api'
    ));
  }
  if (geminiFiles) {
    const uploaded = Date.parse(String(geminiFiles.uploaded_at));
    const read = Date.parse(String(geminiFiles.model_read_at));
    const deleted = Date.parse(String(geminiFiles.deleted_at));
    if (Number.isFinite(uploaded) && Number.isFinite(read) && Number.isFinite(deleted) && !(uploaded <= read && read <= deleted)) {
      issues.push(issue(check, `${path}/capabilities/gemini_files`, 'Gemini Files lifecycle times must be non-decreasing'));
    }
  }
  return issues;
}

function localChunkingIssues(
  check: string,
  model: JsonRecord,
  path: string,
  capabilities: JsonRecord
): SemanticIssue[] {
  if (model.plugin_id !== 'gemini') return [];
  const local = isRecord(capabilities.local_chunking) ? capabilities.local_chunking : undefined;
  const legacyRemote = isRecord(capabilities.private_gcs) || isRecord(capabilities.gemini_files);
  if (!local) return [];
  const issues: SemanticIssue[] = [];
  if (legacyRemote) {
    issues.push(issue(check, `${path}/capabilities`, 'local chunking evidence cannot be combined with legacy remote staging evidence'));
  }
  if (local.model_request_count !== local.part_count) {
    issues.push(issue(check, `${path}/capabilities/local_chunking/model_request_count`, 'every generated inline part must have a real model request'));
  }
  const parts = records(local.parts);
  if (parts.length !== local.part_count) {
    issues.push(issue(check, `${path}/capabilities/local_chunking/parts`, 'persisted part records must match part_count'));
  }
  if (parts.filter((part) => part.outcome !== 'not_called').length !== local.model_request_count) {
    issues.push(issue(check, `${path}/capabilities/local_chunking/model_request_count`, 'model_request_count must equal persisted called parts'));
  }
  if (parts.some((part) => part.outcome !== 'completed')) {
    issues.push(issue(check, `${path}/capabilities/local_chunking/parts`, 'a passed model check requires every persisted part call to complete'));
  }
  const chunkIds = parts.map((part) => part.chunk_id).filter((value): value is string => typeof value === 'string');
  const callRefs = parts.map((part) => part.call_ref).filter((value): value is string => typeof value === 'string');
  if (new Set(chunkIds).size !== chunkIds.length || new Set(callRefs).size !== callRefs.length) {
    issues.push(issue(check, `${path}/capabilities/local_chunking/parts`, 'persisted chunk and call identifiers must be unique'));
  }
  const partBytes = parts.map((part) => part.bytes).filter((value): value is number => typeof value === 'number');
  if (partBytes.length === parts.length && partBytes.reduce((sum, value) => sum + value, 0) !== local.source_bytes) {
    issues.push(issue(check, `${path}/capabilities/local_chunking/source_bytes`, 'source_bytes must equal the sum of persisted part bytes'));
  }
  if (partBytes.length > 0 && Math.max(...partBytes) !== local.largest_part_bytes) {
    issues.push(issue(check, `${path}/capabilities/local_chunking/largest_part_bytes`, 'largest_part_bytes must equal the largest persisted part'));
  }
  parts.forEach((part, index) => {
    const prior = parts[index - 1];
    if (
      (index === 0 && part.start_ms !== 0) ||
      (prior && part.start_ms !== prior.end_ms) ||
      (typeof part.start_ms === 'number' && typeof part.end_ms === 'number' && part.end_ms <= part.start_ms)
    ) {
      issues.push(issue(check, `${path}/capabilities/local_chunking/parts/${index}`, 'part time ranges must be positive and contiguous from zero'));
    }
  });
  if (typeof local.source_bytes === 'number' && typeof local.part_count === 'number') {
    const expectedMultiple = local.source_bytes > 15_000_000;
    if ((local.part_count > 1) !== expectedMultiple) {
      issues.push(issue(check, `${path}/capabilities/local_chunking/part_count`, 'part count must follow the 15,000,000 byte source boundary'));
    }
  }
  return issues;
}

function modelSnapshot(data: unknown): JsonRecord {
  const root = rootRecord(data);
  return isRecord(root.model_snapshot) ? root.model_snapshot : {};
}

function callRecords(data: unknown): JsonRecord[] {
  const root = rootRecord(data);
  if (isRecord(root.call)) return [root.call];
  return records(root.calls);
}

function nonNfcStringIssues(
  check: string,
  value: unknown,
  path: string
): SemanticIssue[] {
  if (typeof value === 'string') {
    return value === value.normalize('NFC')
      ? []
      : [issue(check, path, 'fingerprint input strings must already use Unicode NFC')];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      nonNfcStringIssues(check, entry, `${path}/${index}`)
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    nonNfcStringIssues(check, entry, `${path}/${key}`)
  );
}

function fingerprintInputIssues(
  check: string,
  model: JsonRecord,
  path: string
): SemanticIssue[] {
  const confirmation = isRecord(model.cloud_data_confirmation)
    ? model.cloud_data_confirmation
    : {};
  return [
    ...nonNfcStringIssues(check, model.role, `${path}/role`),
    ...nonNfcStringIssues(check, model.runtime, `${path}/runtime`),
    ...nonNfcStringIssues(
      check,
      model.plugin_id ?? model.adapter,
      `${path}/${model.plugin_id === undefined ? 'adapter' : 'plugin_id'}`
    ),
    ...nonNfcStringIssues(check, model.model, `${path}/model`),
    ...nonNfcStringIssues(check, model.endpoint, `${path}/endpoint`),
    ...nonNfcStringIssues(check, model.credential_ref, `${path}/credential_ref`),
    ...nonNfcStringIssues(check, model.provider_config, `${path}/provider_config`),
    ...nonNfcStringIssues(
      check,
      confirmation.confirmation_id,
      `${path}/cloud_data_confirmation/confirmation_id`
    )
  ];
}

const roleCapabilityRequirements: Record<string, {
  taskCapability: string;
  inputModalities: readonly string[];
  outputTypes: readonly string[];
}> = {
  asr: {
    taskCapability: 'transcription',
    inputModalities: ['audio'],
    outputTypes: ['timed_transcript']
  },
  calibration: {
    taskCapability: 'proofreading',
    inputModalities: ['text'],
    outputTypes: ['structured_result']
  },
  audio_verification: {
    taskCapability: 'audio_verification',
    inputModalities: ['text', 'audio'],
    outputTypes: ['structured_result']
  }
};

function profileSupportsRole(profile: JsonRecord, role: unknown): boolean {
  const requirement = roleCapabilityRequirements[String(role)];
  if (!requirement) return false;
  const tasks = Array.isArray(profile.task_capabilities) ? profile.task_capabilities : [];
  const inputs = Array.isArray(profile.input_modalities) ? profile.input_modalities : [];
  const outputs = Array.isArray(profile.output_types) ? profile.output_types : [];
  return tasks.includes(requirement.taskCapability)
    && requirement.inputModalities.every((value) => inputs.includes(value))
    && requirement.outputTypes.every((value) => outputs.includes(value))
    && profile.structured_output === true;
}

function callTimeIssues(
  check: string,
  call: JsonRecord,
  path: string
): SemanticIssue[] {
  const started = Date.parse(String(call.started_at));
  const ended = Date.parse(String(call.ended_at));
  return Number.isFinite(started) && Number.isFinite(ended) && ended < started
    ? [issue(check, `${path}/ended_at`, 'ended_at must not precede started_at')]
    : [];
}

function uniqueStringField(
  check: string,
  entries: JsonRecord[],
  field: string,
  path: string,
  label: string
): SemanticIssue[] {
  const seen = new Set<string>();
  const issues: SemanticIssue[] = [];
  entries.forEach((entry, index) => {
    const value = entry[field];
    if (typeof value !== 'string') return;
    if (seen.has(value)) {
      issues.push(issue(check, `${path}/${index}/${field}`, `${label} must be unique`));
    }
    seen.add(value);
  });
  return issues;
}

function timeRangeIssues(
  check: string,
  entry: JsonRecord,
  path: string,
  maximum?: number
): SemanticIssue[] {
  const start = entry.start_ms;
  const end = entry.end_ms;
  if (typeof start !== 'number' || typeof end !== 'number') return [];

  const issues: SemanticIssue[] = [];
  if (start >= end) {
    issues.push(issue(check, path, 'start_ms must be earlier than end_ms'));
  }
  if (maximum !== undefined && end > maximum) {
    issues.push(issue(check, path, 'end_ms must not exceed the audio duration'));
  }
  return issues;
}

function orderedSegmentIssues(
  check: string,
  segments: JsonRecord[],
  path: string,
  requireIndexes: boolean
): SemanticIssue[] {
  const issues = uniqueStringField(check, segments, 'id', path, 'segment id');
  let previousStart = -1;
  let previousEnd = -1;

  segments.forEach((segment, index) => {
    if (requireIndexes && segment.index !== index) {
      issues.push(
        issue(check, `${path}/${index}/index`, 'segment indexes must be zero-based and contiguous')
      );
    }
    const start = typeof segment.start_ms === 'number' ? segment.start_ms : previousStart;
    const end = typeof segment.end_ms === 'number' ? segment.end_ms : previousEnd;
    if (start < previousStart || end < previousEnd) {
      issues.push(issue(check, `${path}/${index}`, 'segment times must be monotonic'));
    }
    previousStart = start;
    previousEnd = end;
  });
  return issues;
}

function providerConfigIssues(data: unknown): SemanticIssue[] {
  const check = 'no-sensitive-provider-config';
  const issues: SemanticIssue[] = [];

  walk(data, (record, path) => {
    if (!isRecord(record.provider_config)) return;
    const providerPath = path === '/' ? '/provider_config' : `${path}/provider_config`;
    for (const securityIssue of sensitiveInformationIssues(record.provider_config)) {
      const nestedPath = securityIssue.path === '/' ? '' : securityIssue.path;
      issues.push(
        issue(check, `${providerPath}${nestedPath}`, 'provider_config must not contain credential material')
      );
    }
  });
  return issues;
}

function modelMetadataIssues(data: unknown): SemanticIssue[] {
  const check = 'no-sensitive-model-metadata';
  const issues: SemanticIssue[] = [];
  const metadataFields = new Set([
    'actual_model',
    'adapter',
    'api_version',
    'bucket',
    'endpoint',
    'location',
    'model',
    'object_uri',
    'provider',
    'region',
    'service'
  ]);

  walk(data, (record, path) => {
    for (const [key, value] of Object.entries(record)) {
      if (!metadataFields.has(key) || typeof value !== 'string') continue;
      const valuePath = `${path === '/' ? '' : path}/${key}`;
      if (sensitiveInformationIssues(value).length > 0) {
        issues.push(issue(check, valuePath, 'model metadata must not contain credential material'));
      }
    }
  });
  return issues;
}

const semanticCheckRegistry: Record<string, SemanticCheck> = {
  'unique-model-config-ids': (data) => {
    const models = records(rootRecord(data).models);
    return uniqueStringField(
      'unique-model-config-ids',
      models,
      'config_id',
      '/models',
      'config_id'
    );
  },

  'model-defaults': (data) => {
    const check = 'model-defaults';
    const root = rootRecord(data);
    const defaults = isRecord(root.defaults) ? root.defaults : {};
    const byId = new Map(
      records(root.models)
        .filter((model) => typeof model.config_id === 'string')
        .map((model) => [model.config_id as string, model])
    );
    const issues: SemanticIssue[] = [];
    for (const role of ['asr', 'calibration', 'audio_verification'] as const) {
      const configId = defaults[role];
      if (configId === undefined) continue;
      const model = typeof configId === 'string' ? byId.get(configId) : undefined;
      if (!model) {
        issues.push(issue(check, `/defaults/${role}`, 'default must reference an existing model config'));
      } else if (model.role !== role || model.enabled !== true) {
        issues.push(issue(check, `/defaults/${role}`, 'default model must be enabled and match its role slot'));
      }
    }
    return issues;
  },

  'model-fingerprints': (data) => {
    const check = 'model-fingerprints';
    const issues: SemanticIssue[] = [];
    records(rootRecord(data).models).forEach((model, index) => {
      issues.push(...fingerprintInputIssues(check, model, `/models/${index}`));
      if (model.config_fingerprint !== computeModelConfigFingerprint(model)) {
        issues.push(issue(check, `/models/${index}/config_fingerprint`, 'config_fingerprint must match the canonical execution configuration'));
      }
    });
    return issues;
  },

  'model-check-consistency': (data) => {
    const check = 'model-check-consistency';
    const issues: SemanticIssue[] = [];
    records(rootRecord(data).models).forEach((model, index) => {
      if (!isRecord(model.last_check)) return;
      const lastCheck = model.last_check;
      const capabilities = isRecord(lastCheck.capabilities) ? lastCheck.capabilities : {};
      const path = `/models/${index}/last_check`;
      for (const [field, expected] of [
        ['config_id', model.config_id],
        ['config_fingerprint', model.config_fingerprint],
        ['role', model.role]
      ] as const) {
        if (lastCheck[field] !== expected) {
          issues.push(issue(check, `${path}/${field}`, `check ${field} must match the current config`));
        }
      }
      if (lastCheck.outcome === 'passed' && capabilities.role !== model.role) {
        issues.push(issue(check, `${path}/capabilities/role`, 'passed capabilities must match the configured role'));
      }
      if (model.plugin_id !== undefined) {
        const declared = isRecord(model.declared_capabilities) ? model.declared_capabilities : {};
        const verified = isRecord(lastCheck.verified_capabilities) ? lastCheck.verified_capabilities : {};
        if (!profileSupportsRole(declared, model.role)) {
          issues.push(issue(check, `/models/${index}/declared_capabilities`, 'declared plugin capabilities must satisfy the configured role'));
        }
        if (lastCheck.outcome === 'passed' && !profileSupportsRole(verified, model.role)) {
          issues.push(issue(check, `${path}/verified_capabilities`, 'passed verified capabilities must satisfy the configured role'));
        }
        if (lastCheck.outcome === 'failed' && lastCheck.verified_capabilities !== null) {
          issues.push(issue(check, `${path}/verified_capabilities`, 'failed checks must not retain verified capabilities'));
        }
      }
    });
    return issues;
  },

  'model-confirmation-before-check': (data) => {
    const check = 'model-confirmation-before-check';
    const issues: SemanticIssue[] = [];
    records(rootRecord(data).models).forEach((model, index) => {
      if (!isRecord(model.last_check)) return;
      const lastCheck = model.last_check;
      const confirmation = isRecord(model.cloud_data_confirmation)
        ? model.cloud_data_confirmation
        : {};
      const path = `/models/${index}/last_check`;
      if (lastCheck.confirmation_ref !== confirmation.confirmation_id) {
        issues.push(issue(check, `${path}/confirmation_ref`, 'check confirmation_ref must match the current confirmation'));
      }
      const startedAt = Date.parse(String(lastCheck.started_at));
      const confirmedAt = Date.parse(String(confirmation.confirmed_at));
      if (
        confirmation.confirmed !== true ||
        !Number.isFinite(confirmedAt) ||
        !Number.isFinite(startedAt) ||
        confirmedAt > startedAt
      ) {
        issues.push(issue(check, `${path}/started_at`, 'cloud capability check requires prior confirmation'));
      }
    });
    return issues;
  },

  'model-check-times': (data) => {
    const check = 'model-check-times';
    const issues: SemanticIssue[] = [];
    records(rootRecord(data).models).forEach((model, index) => {
      if (!isRecord(model.last_check)) return;
      const startedAt = Date.parse(String(model.last_check.started_at));
      const endedAt = Date.parse(String(model.last_check.ended_at));
      if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && startedAt > endedAt) {
        issues.push(issue(check, `/models/${index}/last_check`, 'check started_at must not follow ended_at'));
      }
    });
    return issues;
  },

  'model-confirmation-consistency': (data) => {
    const check = 'model-confirmation-consistency';
    return records(rootRecord(data).models).flatMap((model, index) => {
      const confirmation = isRecord(model.cloud_data_confirmation) ? model.cloud_data_confirmation : {};
      if (confirmation.confirmed !== true) return [];
      return exactStringArray(confirmation.data_categories, confirmationCategories[String(model.role)] ?? [])
        ? []
        : [issue(check, `/models/${index}/cloud_data_confirmation/data_categories`, 'confirmed data categories must exactly match the role in canonical order')];
    });
  },

  'model-registry-times': (data) => {
    const check = 'model-registry-times';
    const root = rootRecord(data);
    const updatedAt = Date.parse(String(root.updated_at));
    return records(root.models).flatMap((model, index) => {
      const confirmation = isRecord(model.cloud_data_confirmation) ? model.cloud_data_confirmation : {};
      const times = [confirmation.confirmed_at, isRecord(model.last_check) ? model.last_check.ended_at : null]
        .filter((value): value is string => typeof value === 'string')
        .map(Date.parse);
      return times.some((time) => Number.isFinite(time) && Number.isFinite(updatedAt) && time > updatedAt)
        ? [issue(check, `/models/${index}`, 'updated_at must not precede confirmation or check completion')]
        : [];
    });
  },

  'model-gcs-capability': (data) => {
    const check = 'model-gcs-capability';
    return records(rootRecord(data).models).flatMap((model, index) => {
      if (model.role !== 'audio_verification' || !isRecord(model.last_check) || model.last_check.outcome !== 'passed') return [];
      const capabilities = isRecord(model.last_check.capabilities) ? model.last_check.capabilities : {};
      return [
        ...privateGcsIssues(check, model, `/models/${index}/last_check`, capabilities),
        ...geminiFilesIssues(check, model, `/models/${index}/last_check`, capabilities),
        ...localChunkingIssues(check, model, `/models/${index}/last_check`, capabilities)
      ];
    });
  },

  'snapshot-unique-ids': (data) => {
    const entries = snapshotEntries(data).map(([, entry]) => entry);
    return [
      ...uniqueStringField('snapshot-unique-ids', entries, 'snapshot_entry_id', '/models', 'snapshot_entry_id'),
      ...uniqueStringField('snapshot-unique-ids', entries, 'config_id', '/models', 'snapshot config_id')
    ];
  },

  'snapshot-entry-consistency': (data) => {
    const check = 'snapshot-entry-consistency';
    return snapshotEntries(data).flatMap(([role, entry]) => {
      const path = `/models/${role}`;
      const checkSnapshot = isRecord(entry.check_snapshot) ? entry.check_snapshot : {};
      const issues: SemanticIssue[] = [];
      if (entry.role !== role || checkSnapshot.outcome !== 'passed') {
        issues.push(issue(check, path, 'snapshot role slot and passed check must agree'));
      }
      for (const [field, expected] of [
        ['config_id', entry.config_id],
        ['config_fingerprint', entry.config_fingerprint],
        ['role', entry.role]
      ] as const) {
        if (checkSnapshot[field] !== expected) issues.push(issue(check, `${path}/check_snapshot/${field}`, `check snapshot ${field} must match the entry`));
      }
      const capabilities = isRecord(checkSnapshot.capabilities)
        ? checkSnapshot.capabilities
        : {};
      if (capabilities.role !== entry.role) {
        issues.push(issue(
          check,
          `${path}/check_snapshot/capabilities/role`,
          'check snapshot capabilities role must match the frozen entry role'
        ));
      }
      if (entry.plugin_id !== undefined) {
        const declared = isRecord(entry.declared_capabilities) ? entry.declared_capabilities : {};
        const verified = isRecord(checkSnapshot.verified_capabilities)
          ? checkSnapshot.verified_capabilities
          : {};
        if (!profileSupportsRole(declared, entry.role)) {
          issues.push(issue(check, `${path}/declared_capabilities`, 'snapshot declared capabilities must satisfy its role'));
        }
        if (!profileSupportsRole(verified, entry.role)) {
          issues.push(issue(check, `${path}/check_snapshot/verified_capabilities`, 'snapshot verified capabilities must satisfy its role'));
        }
      }
      if (entry.config_fingerprint !== computeModelConfigFingerprint(entry)) {
        issues.push(issue(check, `${path}/config_fingerprint`, 'snapshot fingerprint must match its frozen execution configuration'));
      }
      issues.push(...fingerprintInputIssues(check, entry, path));
      return issues;
    });
  },

  'snapshot-confirmation-consistency': (data) => {
    const check = 'snapshot-confirmation-consistency';
    return snapshotEntries(data).flatMap(([role, entry]) => {
      const confirmation = isRecord(entry.cloud_data_confirmation) ? entry.cloud_data_confirmation : {};
      const checkSnapshot = isRecord(entry.check_snapshot) ? entry.check_snapshot : {};
      const issues: SemanticIssue[] = [];
      if (confirmation.confirmed !== true || checkSnapshot.confirmation_ref !== confirmation.confirmation_id) {
        issues.push(issue(check, `/models/${role}/cloud_data_confirmation`, 'snapshot requires the same effective confirmation as its check'));
      }
      if (!exactStringArray(confirmation.data_categories, confirmationCategories[role] ?? [])) {
        issues.push(issue(check, `/models/${role}/cloud_data_confirmation/data_categories`, 'snapshot confirmation categories must match the role in canonical order'));
      }
      return issues;
    });
  },

  'snapshot-capture-times': (data) => {
    const check = 'snapshot-capture-times';
    const capturedAt = Date.parse(String(rootRecord(data).captured_at));
    return snapshotEntries(data).flatMap(([role, entry]) => {
      const confirmation = isRecord(entry.cloud_data_confirmation) ? entry.cloud_data_confirmation : {};
      const checkSnapshot = isRecord(entry.check_snapshot) ? entry.check_snapshot : {};
      const startedAt = Date.parse(String(checkSnapshot.started_at));
      const endedAt = Date.parse(String(checkSnapshot.ended_at));
      const issues: SemanticIssue[] = [];
      if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && startedAt > endedAt) {
        issues.push(issue(check, `/models/${role}/check_snapshot`, 'check snapshot started_at must not follow ended_at'));
      }
      const dependencies = [confirmation.confirmed_at, checkSnapshot.ended_at]
        .filter((value): value is string => typeof value === 'string')
        .map(Date.parse);
      if (dependencies.some((time) => Number.isFinite(time) && Number.isFinite(capturedAt) && time > capturedAt)) {
        issues.push(issue(check, `/models/${role}`, 'captured_at must not precede confirmation or check completion'));
      }
      return issues;
    });
  },

  'snapshot-confirmation-before-check': (data) => {
    const check = 'snapshot-confirmation-before-check';
    return snapshotEntries(data).flatMap(([role, entry]) => {
      const confirmation = isRecord(entry.cloud_data_confirmation) ? entry.cloud_data_confirmation : {};
      const checkSnapshot = isRecord(entry.check_snapshot) ? entry.check_snapshot : {};
      const confirmedAt = Date.parse(String(confirmation.confirmed_at));
      const startedAt = Date.parse(String(checkSnapshot.started_at));
      return confirmation.confirmed !== true ||
        !Number.isFinite(confirmedAt) ||
        !Number.isFinite(startedAt) ||
        confirmedAt > startedAt
        ? [issue(check, `/models/${role}/check_snapshot/started_at`, 'snapshot check requires prior confirmation')]
        : [];
    });
  },

  'snapshot-gcs-capability': (data) => {
    const check = 'snapshot-gcs-capability';
    return snapshotEntries(data).flatMap(([role, entry]) => {
      if (role !== 'audio_verification') return [];
      const checkSnapshot = isRecord(entry.check_snapshot) ? entry.check_snapshot : {};
      const capabilities = isRecord(checkSnapshot.capabilities) ? checkSnapshot.capabilities : {};
      return [
        ...privateGcsIssues(check, entry, `/models/${role}/check_snapshot`, capabilities),
        ...geminiFilesIssues(check, entry, `/models/${role}/check_snapshot`, capabilities),
        ...localChunkingIssues(check, entry, `/models/${role}/check_snapshot`, capabilities)
      ];
    });
  },

  'adapter-failure-consistency': (data) => {
    const check = 'adapter-failure-consistency';
    const root = rootRecord(data);
    const errors = records(root.errors);
    const warnings = records(root.warnings);
    const staging = records(root.staging);
    const call = isRecord(root.call) ? root.call : undefined;
    const errorById = new Map(
      errors
        .filter((entry) => typeof entry.error_id === 'string')
        .map((entry) => [entry.error_id as string, entry])
    );
    const stagingIds = new Set(
      staging
        .map((entry) => entry.staging_id)
        .filter((entry): entry is string => typeof entry === 'string')
    );
    const issues: SemanticIssue[] = [
      ...uniqueStringField(check, errors, 'error_id', '/errors', 'error_id'),
      ...uniqueStringField(check, warnings, 'warning_id', '/warnings', 'warning_id'),
      ...uniqueStringField(check, staging, 'staging_id', '/staging', 'staging_id')
    ];
    if (root.provider_outcome_certainty === 'not_dispatched' && call) {
      issues.push(issue(check, '/provider_outcome_certainty', 'not_dispatched requires call=null'));
    }
    if (root.provider_outcome_certainty === 'outcome_unknown' && !call) {
      issues.push(issue(check, '/provider_outcome_certainty', 'outcome_unknown requires auditable call metadata'));
    }
    warnings.forEach((warning, index) => {
      if (
        typeof warning.related_error_ref === 'string' &&
        !errorById.has(warning.related_error_ref)
      ) {
        issues.push(issue(check, `/warnings/${index}/related_error_ref`, 'warning must reference an existing error'));
      }
      if (
        typeof warning.related_staging_ref === 'string' &&
        !stagingIds.has(warning.related_staging_ref)
      ) {
        issues.push(issue(check, `/warnings/${index}/related_staging_ref`, 'warning must reference an existing staging record'));
      }
    });
    const referencedErrors = new Set<string>();
    if (call?.error_ref !== null && typeof call?.error_ref === 'string') {
      referencedErrors.add(call.error_ref);
      if (!errorById.has(call.error_ref)) issues.push(issue(check, '/call/error_ref', 'failed call must reference an existing error'));
    }
    if (root.role !== 'audio_verification' && staging.length > 0) {
      issues.push(issue(check, '/staging', 'only audio_verification failures may contain staging'));
    }
    staging.forEach((entry, index) => {
      const path = `/staging/${index}`;
      if (call ? entry.call_ref !== call.call_id : entry.call_ref !== null) {
        issues.push(issue(check, `${path}/call_ref`, 'staging call_ref must reference this failure call'));
      }
      const created = Date.parse(String(entry.created_at));
      const cleanup = Date.parse(String(entry.cleanup_finished_at));
      if (Number.isFinite(created) && Number.isFinite(cleanup) && created > cleanup) {
        issues.push(issue(check, path, 'cleanup_finished_at must not precede created_at'));
      }
      if (call) {
        const callStarted = Date.parse(String(call.started_at));
        const callEnded = Date.parse(String(call.ended_at));
        if (Number.isFinite(created) && Number.isFinite(callStarted) && created > callStarted) {
          issues.push(issue(check, `${path}/created_at`, 'staging creation must not follow its model call start'));
        }
        if (Number.isFinite(cleanup) && Number.isFinite(callEnded) && cleanup < callEnded) {
          issues.push(issue(check, `${path}/cleanup_finished_at`, 'staging cleanup must not precede its model call end'));
        }
      }
      if (typeof entry.error_ref === 'string') {
        referencedErrors.add(entry.error_ref);
        const cleanupError = errorById.get(entry.error_ref);
        const geminiFile = stagingKind(entry) === 'gemini_file';
        const cleanupStage = geminiFile ? 'staging_cleanup' : 'gcs_cleanup';
        const cleanupCode = geminiFile ? 'STAGING_CLEANUP_FAILED' : 'GCS_CLEANUP_FAILED';
        if (
          entry.cleanup_status !== 'failed' ||
          cleanupError?.stage !== cleanupStage ||
          cleanupError?.code !== cleanupCode ||
          typeof cleanupError.remediation !== 'string' ||
          cleanupError.resource_uri !== undefined
        ) {
          issues.push(issue(check, `${path}/error_ref`, 'failed cleanup must reference the staging-kind cleanup error with remediation'));
        }
        const matchingWarnings = warnings.filter(
          (warning) =>
            warning.code === cleanupCode &&
            warning.stage === cleanupStage &&
            warning.severity === 'high' &&
            warning.related_error_ref === entry.error_ref &&
            warning.related_staging_ref === entry.staging_id
        );
        if (matchingWarnings.length !== 1) {
          issues.push(issue(check, '/warnings', 'failed cleanup requires exactly one canonical high-severity warning'));
        }
      }
    });
    errors.forEach((entry, index) => {
      if (typeof entry.error_id !== 'string' || referencedErrors.has(entry.error_id)) return;
      const allowed =
        entry.stage === 'artifact_write' ||
        (root.role === 'asr' && entry.stage === 'media_decode') ||
        (root.role === 'audio_verification' && (entry.stage === 'gcs_upload' || entry.stage === 'staging_upload'));
      if (!allowed) issues.push(issue(check, `/errors/${index}/stage`, 'unreferenced failure error has no permitted pre-call or artifact-write stage'));
    });
    const occurred = Date.parse(String(root.occurred_at));
    const terminalTimes = [call?.ended_at, ...staging.map((entry) => entry.cleanup_finished_at)]
      .filter((value): value is string => typeof value === 'string')
      .map(Date.parse);
    if (terminalTimes.some((time) => Number.isFinite(time) && Number.isFinite(occurred) && time > occurred)) {
      issues.push(issue(check, '/occurred_at', 'occurred_at must not precede call or cleanup completion'));
    }
    return issues;
  },

  'no-sensitive-provider-config': providerConfigIssues,
  'no-sensitive-model-metadata': modelMetadataIssues,

  'transcript-content-consistency': (data) => {
    const check = 'transcript-content-consistency';
    const root = rootRecord(data);
    const joined = records(root.segments).map((segment) => segment.text).join('\n');
    return root.full_text === joined
      ? []
      : [issue(check, '/full_text', 'full_text must exactly join segment text with U+000A')];
  },

  'transcript-segment-order': (data) =>
    records(rootRecord(data).segments).flatMap((segment, index, segments) => {
      const issues: SemanticIssue[] = [];
      if (segment.index !== index) {
        issues.push(issue('transcript-segment-order', `/segments/${index}/index`, 'segment indexes must be zero-based and contiguous'));
      }
      const previous = segments[index - 1];
      if (
        previous &&
        typeof previous.end_ms === 'number' &&
        typeof segment.start_ms === 'number' &&
        segment.start_ms < previous.end_ms
      ) {
        issues.push(issue('transcript-segment-order', `/segments/${index}/start_ms`, 'segments must be ordered and non-overlapping'));
      }
      return issues;
    }),

  'transcript-segment-time-ranges': (data) => {
    const check = 'transcript-segment-time-ranges';
    const root = rootRecord(data);
    const audio = isRecord(root.audio) ? root.audio : {};
    const maximum = typeof audio.duration_ms === 'number' ? audio.duration_ms : undefined;
    return records(root.segments).flatMap((segment, index) =>
      timeRangeIssues(check, segment, `/segments/${index}`, maximum)
    );
  },

  'transcript-word-time-ranges': (data) => {
    const check = 'transcript-word-time-ranges';
    const issues: SemanticIssue[] = [];
    records(rootRecord(data).segments).forEach((segment, segmentIndex) => {
      const start = typeof segment.start_ms === 'number' ? segment.start_ms : 0;
      const end = typeof segment.end_ms === 'number' ? segment.end_ms : undefined;
      let previousEnd = start;
      records(segment.words).forEach((word, wordIndex) => {
        const path = `/segments/${segmentIndex}/words/${wordIndex}`;
        issues.push(...timeRangeIssues(check, word, path, end));
        if (word.index !== wordIndex) {
          issues.push(issue(check, `${path}/index`, 'word indexes must be zero-based and contiguous'));
        }
        if (typeof word.start_ms === 'number' && word.start_ms < start) {
          issues.push(issue(check, path, 'word must start within its segment'));
        }
        if (typeof word.start_ms === 'number' && word.start_ms < previousEnd) {
          issues.push(issue(check, path, 'word timings must be ordered'));
        }
        if (typeof word.end_ms === 'number') previousEnd = word.end_ms;
      });
    });
    return issues;
  },

  'transcript-unique-ids': (data) => {
    const check = 'transcript-unique-ids';
    const segments = records(rootRecord(data).segments);
    return [
      ...uniqueStringField(check, segments, 'segment_id', '/segments', 'segment_id'),
      ...uniqueStringField(
        check,
        segments.flatMap((segment) => records(segment.words)),
        'word_id',
        '/segments/*/words',
        'word_id'
      )
    ];
  },

  'transcript-call-success': (data) => {
    const check = 'transcript-call-success';
    const root = rootRecord(data);
    const call = isRecord(root.call) ? root.call : {};
    return call.outcome === 'completed' && records(root.errors).length === 0
      ? []
      : [issue(check, '/call/outcome', 'a persisted transcript requires a successful ASR call')];
  },

  'calibration-request-mode': (data) => {
    const check = 'calibration-request-mode';
    const request = isRecord(rootRecord(data).request) ? rootRecord(data).request as JsonRecord : {};
    const hasReference = request.reference_srt_ref !== null;
    if ((!hasReference && request.mode !== null) || (hasReference && request.mode === null)) {
      return [
        issue(
          check,
          '/request/mode',
          'mode must be null without a reference SRT and selected when a reference SRT exists'
        )
      ];
    }
    return [];
  },

  'calibration-suggestion-time-ranges': (data) => {
    const check = 'calibration-suggestion-time-ranges';
    return records(rootRecord(data).suggestions).flatMap((suggestion, index) =>
      timeRangeIssues(check, suggestion, `/suggestions/${index}`)
    );
  },

  'calibration-text-only-policy': (data) => {
    const check = 'calibration-text-only-policy';
    const root = rootRecord(data);
    const request = isRecord(root.request) ? root.request : {};
    if (request.mode !== 'text-only') return [];
    return records(root.suggestions).flatMap((suggestion, index) =>
      suggestion.kind === 'text_correction'
        ? []
        : [issue(check, `/suggestions/${index}/kind`, 'text-only only permits text_correction suggestions')]
    );
  },

  'calibration-unique-ids': (data) => {
    const suggestions = records(rootRecord(data).suggestions);
    return uniqueStringField('calibration-unique-ids', suggestions, 'suggestion_id', '/suggestions', 'suggestion_id');
  },

  'calibration-completed-consistency': (data) => {
    const check = 'calibration-completed-consistency';
    const root = rootRecord(data);
    const call = isRecord(root.call) ? root.call : {};
    if (root.status !== 'completed') return [];
    return call.outcome === 'completed' && call.error_ref === null && records(root.errors).length === 0
      ? []
      : [issue(check, '/call', 'completed calibration requires one successful call and no errors')];
  },

  'calibration-failed-consistency': (data) => {
    const check = 'calibration-failed-consistency';
    const root = rootRecord(data);
    if (root.status !== 'failed') return [];
    const call = isRecord(root.call) ? root.call : {};
    const errorIds = new Set(records(root.errors).map((entry) => entry.error_id));
    return call.outcome === 'failed' &&
      typeof call.error_ref === 'string' &&
      errorIds.has(call.error_ref) &&
      records(root.suggestions).length === 0
      ? []
      : [issue(check, '/call', 'failed calibration requires a failed call linked to errors and no suggestions')];
  },

  'audio-verification-failed-consistency': (data) => {
    const check = 'audio-verification-failed-consistency';
    const root = rootRecord(data);
    if (root.status !== 'failed') return [];
    const calls = callRecords(data);
    const staging = records(root.staging);
    const errors = records(root.errors);
    const referenced = new Set<string>();
    calls.forEach((call) => {
      if (call.outcome === 'failed' && typeof call.error_ref === 'string') referenced.add(call.error_ref);
    });
    staging.forEach((entry) => {
      if (entry.cleanup_status === 'failed' && typeof entry.error_ref === 'string') referenced.add(entry.error_ref);
    });
    const uploadErrors = errors.filter((entry) => entry.stage === 'gcs_upload' || entry.stage === 'staging_upload');
    const directUploadErrors = uploadErrors.filter(
      (entry) => typeof entry.error_id === 'string' && !referenced.has(entry.error_id)
    );
    const issues: SemanticIssue[] = [];
    if (
      !calls.some((call) => call.outcome === 'failed') &&
      !staging.some((entry) => entry.cleanup_status === 'failed') &&
      directUploadErrors.length === 0
    ) {
      issues.push(issue(check, '/errors', 'failed verification requires a failed call, failed cleanup, or direct gcs_upload error'));
    }
    if (uploadErrors.length > 0 && calls.length > 0) {
      issues.push(issue(check, '/calls', 'a pre-call gcs_upload failure cannot coexist with a model call'));
    }
    errors.forEach((entry, index) => {
      if (
        typeof entry.error_id === 'string' &&
        !referenced.has(entry.error_id) &&
        entry.stage !== 'gcs_upload' &&
        entry.stage !== 'staging_upload'
      ) {
        issues.push(issue(check, `/errors/${index}`, 'failed verification errors must be linked or describe a pre-call gcs_upload failure'));
      }
    });
    records(root.application_results).forEach((entry, index) => {
      if (entry.disposition !== 'not_applied' || entry.reason !== 'verification_failed') {
        issues.push(issue(check, `/application_results/${index}`, 'failed verification cannot apply findings'));
      }
    });
    return issues;
  },

  'audio-verification-completed-consistency': (data) => {
    const check = 'audio-verification-completed-consistency';
    const root = rootRecord(data);
    if (root.status !== 'completed') return [];
    const calls = callRecords(data);
    const staging = records(root.staging);
    const issues: SemanticIssue[] = [];
    if (calls.length === 0 || calls.some((call) => call.outcome !== 'completed')) {
      issues.push(issue(check, '/calls', 'completed verification requires one or more successful calls'));
    }
    if (staging.some((entry) => entry.cleanup_status !== 'completed')) {
      issues.push(issue(check, '/staging', 'completed verification requires completed cleanup'));
    }
    return issues;
  },

  'audio-verification-finding-time-ranges': (data) => {
    const check = 'audio-verification-finding-time-ranges';
    const root = rootRecord(data);
    return records(root.findings).flatMap((finding, index) =>
      timeRangeIssues(check, finding, `/findings/${index}`)
    );
  },

  'audio-verification-application-links': (data) => {
    const check = 'audio-verification-application-links';
    const root = rootRecord(data);
    const findings = records(root.findings);
    const findingIds = new Set(
      findings.map((entry) => entry.finding_id).filter((id): id is string => typeof id === 'string')
    );
    const linkedIds = new Set<string>();
    const issues: SemanticIssue[] = [];
    records(root.application_results).forEach((application, index) => {
      const id = application.finding_ref;
      if (typeof id !== 'string' || !findingIds.has(id)) {
        issues.push(issue(check, `/application_results/${index}/finding_ref`, 'application must reference an existing finding'));
      } else if (linkedIds.has(id)) {
        issues.push(issue(check, `/application_results/${index}/finding_ref`, 'finding may only have one application result'));
      } else {
        linkedIds.add(id);
      }
    });
    if (linkedIds.size !== findingIds.size) {
      issues.push(issue(check, '/application_results', 'every finding must have an application result'));
    }
    return issues;
  },

  'audio-verification-application-policy': (data) => {
    const check = 'audio-verification-application-policy';
    const root = rootRecord(data);
    const findings = new Map(
      records(root.findings)
        .filter((entry) => typeof entry.finding_id === 'string')
        .map((entry) => [entry.finding_id as string, entry])
    );
    const issues: SemanticIssue[] = [];
    records(root.application_results).forEach((application, index) => {
      if (application.disposition !== 'applied' || typeof application.finding_ref !== 'string') return;
      const finding = findings.get(application.finding_ref);
      if (!finding) return;
      if (root.status === 'failed') {
        issues.push(issue(check, `/application_results/${index}`, 'failed verification findings cannot be applied'));
      }
      if (finding.kind === 'translation') {
        issues.push(issue(check, `/application_results/${index}`, 'translation findings cannot be applied in V0.1'));
      }
    });
    return issues;
  },

  'audio-verification-staging-call-links': (data) => {
    const check = 'audio-verification-staging-call-links';
    const root = rootRecord(data);
    const callIds = new Set(
      records(root.calls)
        .map((call) => call.call_id)
        .filter((callId): callId is string => typeof callId === 'string')
    );
    return records(root.staging).flatMap((staging, index) => {
      if (callIds.size === 0) return staging.call_ref === null
        ? []
        : [issue(check, `/staging/${index}/call_ref`, 'staging before a model request must use null call_ref')];
      return typeof staging.call_ref === 'string' && callIds.has(staging.call_ref)
        ? []
        : [issue(check, `/staging/${index}/call_ref`, 'non-null staging call_ref must reference an existing call')];
    });
  },

  'audio-verification-staging-call-times': (data) => {
    const check = 'audio-verification-staging-call-times';
    const root = rootRecord(data);
    const calls = new Map(
      records(root.calls)
        .filter((call) => typeof call.call_id === 'string')
        .map((call) => [call.call_id as string, call])
    );
    const issues: SemanticIssue[] = [];
    records(root.staging).forEach((staging, index) => {
      if (typeof staging.call_ref !== 'string') return;
      const call = calls.get(staging.call_ref);
      if (!call) return;
      const created = Date.parse(String(staging.created_at));
      const cleanup = Date.parse(String(staging.cleanup_finished_at));
      const callStarted = Date.parse(String(call.started_at));
      const callEnded = Date.parse(String(call.ended_at));
      if (Number.isFinite(created) && Number.isFinite(callStarted) && created > callStarted) {
        issues.push(issue(check, `/staging/${index}/created_at`, 'staging creation must not follow its model call start'));
      }
      if (Number.isFinite(cleanup) && Number.isFinite(callEnded) && cleanup < callEnded) {
        issues.push(issue(check, `/staging/${index}/cleanup_finished_at`, 'staging cleanup must not precede its model call end'));
      }
    });
    return issues;
  },

  'audio-verification-chunk-ranges': (data) => {
    const check = 'audio-verification-chunk-ranges';
    const root = rootRecord(data);
    const local = isRecord(root.local_chunking) ? root.local_chunking : undefined;
    if (!local) return [];
    const parts = records(local.parts);
    const issues: SemanticIssue[] = [];
    const partBytes = parts.map((part) => part.bytes).filter((value): value is number => typeof value === 'number');
    if (partBytes.length === parts.length && partBytes.reduce((sum, value) => sum + value, 0) !== local.source_bytes) {
      issues.push(issue(check, '/local_chunking/source_bytes', 'source_bytes must equal the sum of part bytes'));
    }
    if (typeof local.source_bytes === 'number' && ((local.source_bytes > 15_000_000) !== (parts.length > 1))) {
      issues.push(issue(check, '/local_chunking/parts', 'part count must follow the 15,000,000 byte source boundary'));
    }
    parts.forEach((part, index) => {
      const prior = parts[index - 1];
      if (
        (index === 0 && part.start_ms !== 0) ||
        (prior && part.start_ms !== prior.end_ms) ||
        (typeof part.start_ms === 'number' && typeof part.end_ms === 'number' && part.end_ms <= part.start_ms)
      ) {
        issues.push(issue(check, `/local_chunking/parts/${index}`, 'part time ranges must be positive and contiguous from zero'));
      }
    });
    return issues;
  },

  'audio-verification-chunk-links': (data) => {
    const check = 'audio-verification-chunk-links';
    const root = rootRecord(data);
    const local = isRecord(root.local_chunking) ? root.local_chunking : undefined;
    if (!local) return [];
    const calls = new Map(
      records(root.calls)
        .filter((call) => typeof call.call_id === 'string')
        .map((call) => [call.call_id as string, call])
    );
    const errors = new Set(
      records(root.errors).map((entry) => entry.error_id).filter((id): id is string => typeof id === 'string')
    );
    const referencedCalls = new Set<string>();
    const issues: SemanticIssue[] = [];
    let stopped = false;
    records(local.parts).forEach((part, index) => {
      const partPath = `/local_chunking/parts/${index}`;
      if (part.outcome === 'not_called') {
        stopped = true;
        return;
      }
      if (stopped) {
        issues.push(issue(check, partPath, 'called parts must form a prefix before not_called parts'));
      }
      const call = typeof part.call_ref === 'string' ? calls.get(part.call_ref) : undefined;
      if (!call || referencedCalls.has(part.call_ref as string)) {
        issues.push(issue(check, `${partPath}/call_ref`, 'each called part must reference one unique existing call'));
        return;
      }
      referencedCalls.add(part.call_ref as string);
      if (call.outcome !== part.outcome || call.error_ref !== part.error_ref) {
        issues.push(issue(check, partPath, 'part outcome and error_ref must match its call'));
      }
      if (typeof part.error_ref === 'string' && !errors.has(part.error_ref)) {
        issues.push(issue(check, `${partPath}/error_ref`, 'failed part error_ref must reference an artifact error'));
      }
    });
    if (referencedCalls.size !== calls.size) {
      issues.push(issue(check, '/calls', 'every call must be referenced by exactly one persisted part'));
    }
    return issues;
  },

  'audio-verification-chunk-local-only': (data) => {
    const check = 'audio-verification-chunk-local-only';
    const root = rootRecord(data);
    const local = isRecord(root.local_chunking) ? root.local_chunking : undefined;
    if (!local) return [];
    const parts = records(local.parts);
    const issues: SemanticIssue[] = [];
    if (records(root.staging).length > 0) {
      issues.push(issue(check, '/staging', 'active local chunking cannot coexist with remote staging'));
    }
    if ((root.status === 'not_requested' || root.status === 'skipped') && parts.length > 0) {
      issues.push(issue(check, '/local_chunking', 'unrequested or skipped verification cannot persist active chunks'));
    }
    return issues;
  },

  'audio-verification-chunk-completed-status': (data) => {
    const check = 'audio-verification-chunk-completed-status';
    const root = rootRecord(data);
    const local = isRecord(root.local_chunking) ? root.local_chunking : undefined;
    if (!local || root.status !== 'completed') return [];
    const parts = records(local.parts);
    const issues: SemanticIssue[] = [];
    if (root.status === 'completed' && parts.some((part) => part.outcome !== 'completed')) {
      issues.push(issue(check, '/local_chunking/parts', 'completed verification requires every part to complete'));
    }
    return issues;
  },

  'audio-verification-chunk-failed-status': (data) => {
    const check = 'audio-verification-chunk-failed-status';
    const root = rootRecord(data);
    const local = isRecord(root.local_chunking) ? root.local_chunking : undefined;
    if (!local || root.status !== 'failed') return [];
    const parts = records(local.parts);
    const issues: SemanticIssue[] = [];
    if (!parts.some((part) => part.outcome === 'failed')) {
      issues.push(issue(check, '/local_chunking/parts', 'failed chunked verification requires a failed part'));
    }
    if (parts.filter((part) => part.outcome === 'failed').length > 1) {
      issues.push(issue(check, '/local_chunking/parts', 'chunk execution stops after the first failed part'));
    }
    return issues;
  },

  'audio-verification-unique-ids': (data) => {
    const root = rootRecord(data);
    const local = isRecord(root.local_chunking) ? root.local_chunking : {};
    return [
      ...uniqueStringField('audio-verification-unique-ids', records(root.findings), 'finding_id', '/findings', 'finding id'),
      ...uniqueStringField('audio-verification-unique-ids', records(root.application_results), 'application_id', '/application_results', 'application id'),
      ...uniqueStringField('audio-verification-unique-ids', records(root.calls), 'call_id', '/calls', 'call id'),
      ...uniqueStringField('audio-verification-unique-ids', records(root.calls), 'provider_request_id', '/calls', 'provider request id'),
      ...uniqueStringField('audio-verification-unique-ids', records(root.staging), 'staging_id', '/staging', 'staging id'),
      ...uniqueStringField('audio-verification-unique-ids', records(root.staging), 'object_uri', '/staging', 'staging object URI'),
      ...uniqueStringField('audio-verification-unique-ids', records(local.parts), 'chunk_id', '/local_chunking/parts', 'chunk id')
    ];
  },

  'audio-verification-cleanup-consistency': (data) => {
    const check = 'audio-verification-cleanup-consistency';
    const root = rootRecord(data);
    const staging = records(root.staging);
    const errors = records(root.errors);
    const warnings = records(root.warnings);
    const issues: SemanticIssue[] = [];
    staging.forEach((entry, index) => {
      if (entry.cleanup_status !== 'failed' || typeof entry.error_ref !== 'string') return;
      const cleanupError = errors.find((candidate) => candidate.error_id === entry.error_ref);
      const geminiFile = stagingKind(entry) === 'gemini_file';
      const cleanupStage = geminiFile ? 'staging_cleanup' : 'gcs_cleanup';
      const cleanupCode = geminiFile ? 'STAGING_CLEANUP_FAILED' : 'GCS_CLEANUP_FAILED';
      const matchingWarnings = warnings.filter(
        (warning) =>
          warning.code === cleanupCode &&
          warning.stage === cleanupStage &&
          warning.severity === 'high' &&
          warning.related_error_ref === entry.error_ref &&
          warning.related_staging_ref === entry.staging_id
      );
      if (
        cleanupError?.stage !== cleanupStage ||
        cleanupError?.code !== cleanupCode ||
        typeof cleanupError.remediation !== 'string' ||
        cleanupError.resource_uri !== undefined ||
        matchingWarnings.length !== 1
      ) {
        issues.push(issue(check, `/staging/${index}/error_ref`, 'failed cleanup requires one canonical error and high-severity warning'));
      }
    });
    return issues;
  },

  'call-record-time-consistency': (data) =>
    callTimeIssues('call-record-time-consistency', rootRecord(data), ''),

  'artifact-created-after-terminal-records': (data) => {
    const check = 'artifact-created-after-terminal-records';
    const root = rootRecord(data);
    const created = Date.parse(String(root.created_at));
    const terminal = [
      ...callRecords(data).map((call) => call.ended_at),
      ...records(root.staging).map((entry) => entry.cleanup_finished_at)
    ]
      .filter((value): value is string => typeof value === 'string')
      .map(Date.parse);
    return terminal.some((time) => Number.isFinite(created) && Number.isFinite(time) && time > created)
      ? [issue(check, '/created_at', 'created_at must not precede call or cleanup completion')]
      : [];
  },

  'artifact-diagnostic-links': (data) => {
    const check = 'artifact-diagnostic-links';
    const root = rootRecord(data);
    const errors = records(root.errors);
    const warnings = records(root.warnings);
    const staging = records(root.staging);
    const errorIds = new Set(errors.map((entry) => entry.error_id));
    const stagingIds = new Set(staging.map((entry) => entry.staging_id));
    const issues = [
      ...uniqueStringField(check, errors, 'error_id', '/errors', 'error_id'),
      ...uniqueStringField(check, warnings, 'warning_id', '/warnings', 'warning_id')
    ];
    warnings.forEach((warning, index) => {
      if (typeof warning.related_error_ref === 'string' && !errorIds.has(warning.related_error_ref)) {
        issues.push(issue(check, `/warnings/${index}/related_error_ref`, 'warning must reference an existing error'));
      }
      if (typeof warning.related_staging_ref === 'string' && !stagingIds.has(warning.related_staging_ref)) {
        issues.push(issue(check, `/warnings/${index}/related_staging_ref`, 'warning must reference an existing staging record'));
      }
    });
    callRecords(data).forEach((call, index) => {
      if (typeof call.error_ref === 'string' && !errorIds.has(call.error_ref)) {
        issues.push(issue(check, `/calls/${index}/error_ref`, 'failed call must reference an existing error'));
      }
    });
    staging.forEach((entry, index) => {
      if (typeof entry.error_ref === 'string' && !errorIds.has(entry.error_ref)) {
        issues.push(issue(check, `/staging/${index}/error_ref`, 'failed staging must reference an existing error'));
      }
    });
    return issues;
  },

  'staging-time-consistency': (data) => {
    const check = 'staging-time-consistency';
    const issues: SemanticIssue[] = [];
    records(rootRecord(data).staging).forEach((entry, index) => {
      const created = Date.parse(String(entry.created_at));
      const finished = Date.parse(String(entry.cleanup_finished_at));
      if (Number.isFinite(created) && Number.isFinite(finished) && finished < created) {
        issues.push(issue(check, `/staging/${index}/cleanup_finished_at`, 'cleanup_finished_at must not precede created_at'));
      }
    });
    return issues;
  }
};

export const implementedSemanticChecks = Object.freeze(
  Object.keys(semanticCheckRegistry).sort()
);

export function runSemanticChecks(names: readonly string[], data: unknown): SemanticIssue[] {
  return names.flatMap((name) => {
    const check = semanticCheckRegistry[name];
    if (!check) throw new Error(`Unknown semantic check declared by Schema: ${name}`);
    return check(data);
  });
}

function declaredChecks(schema: unknown): Set<string> {
  const names = new Set<string>();
  walk(schema, (record) => {
    const value = record['x-mercury-semantic-checks'];
    if (Array.isArray(value)) {
      value.forEach((declaration) => {
        if (isRecord(declaration) && typeof declaration.check === 'string') {
          names.add(declaration.check);
        }
      });
    }
  });
  return names;
}

export function assertSemanticCheckCoverage(schemas: readonly unknown[]): void {
  const declared = new Set(schemas.flatMap((schema) => [...declaredChecks(schema)]));
  const implemented = new Set(implementedSemanticChecks);
  const unknown = [...declared].filter((name) => !implemented.has(name));
  const unused = [...implemented].filter((name) => !declared.has(name));
  if (unknown.length > 0 || unused.length > 0) {
    throw new Error(
      `Semantic check coverage mismatch. Unknown: ${unknown.join(', ') || 'none'}; unused: ${unused.join(', ') || 'none'}`
    );
  }
}

export function semanticKeywordDefinition(): KeywordDefinition {
  return {
    keyword: 'x-mercury-semantic-checks',
    schemaType: 'array',
    errors: true,
    metaSchema: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['check', 'invariant_id'],
        properties: {
          check: { type: 'string', minLength: 1 },
          invariant_id: { type: 'string', pattern: '^INV-[A-Z0-9]+(?:-[A-Z0-9]+)*$' }
        }
      },
      uniqueItems: true
    },
    compile(schema: unknown) {
      if (
        !Array.isArray(schema) ||
        !schema.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.check === 'string' &&
            typeof entry.invariant_id === 'string'
        )
      ) {
        throw new Error('x-mercury-semantic-checks must contain check and invariant_id objects');
      }
      const declarations = schema as SemanticCheckDeclaration[];
      if (new Set(declarations.map((declaration) => declaration.check)).size !== declarations.length) {
        throw new Error('x-mercury-semantic-checks cannot declare the same check more than once');
      }
      declarations.forEach((declaration) => {
        if (!semanticCheckRegistry[declaration.check]) {
          throw new Error(`Unknown semantic check declared by Schema: ${declaration.check}`);
        }
      });
      const invariantByCheck = new Map(
        declarations.map((declaration) => [declaration.check, declaration.invariant_id])
      );

      type SemanticDataContext = { instancePath?: string };
      type SemanticValidator = ((data: unknown, context?: SemanticDataContext) => boolean) & {
        errors?: ErrorObject[];
      };
      const validate: SemanticValidator = (data, context) => {
        const issues = runSemanticChecks(
          declarations.map((declaration) => declaration.check),
          data
        );
        const basePath = context?.instancePath ?? '';
        validate.errors = issues.map((entry) => ({
          instancePath:
            entry.path === '/'
              ? basePath || '/'
              : `${basePath}${entry.path}`,
          schemaPath: '#/x-mercury-semantic-checks',
          keyword: 'x-mercury-semantic-checks',
          params: {
            check: entry.check,
            invariant_id: invariantByCheck.get(entry.check)
          },
          message: entry.message
        }));
        return issues.length === 0;
      };
      return validate;
    }
  };
}
