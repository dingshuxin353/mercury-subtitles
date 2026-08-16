import type { ErrorObject } from 'ajv';
import { ContractRegistryError, ContractValidationError } from './errors.js';
import {
  createContractRegistry,
  rawSchemaErrors,
  registryBuildIssue,
  registryContractNames,
  schemaErrorInvariantId,
  sharedSchemaErrorInvariantId,
  SUPPORTED_SCHEMA_VERSION,
  type ContractRegistry
} from './registry.js';
import { sensitiveInformationIssues } from './security.js';
import type {
  ContractGraph,
  ContractName,
  ContractTypeMap,
  ValidationIssue,
  ValidationResult
} from './types.js';

export { ContractRegistryError, ContractValidationError, SUPPORTED_SCHEMA_VERSION };
export type {
  ContractGraph,
  ContractName,
  ContractTypeMap,
  ValidationIssue,
  ValidationResult
} from './types.js';

let registry: ContractRegistry | undefined;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const uniqueIssues = new Map<string, ValidationIssue>();
  for (const issue of issues) {
    uniqueIssues.set(
      JSON.stringify([issue.path, issue.invariant_id, issue.message]),
      issue
    );
  }
  return [...uniqueIssues.values()].sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.invariant_id, right.invariant_id) ||
      compareText(left.message, right.message)
  );
}

function getRegistry(): ContractRegistry {
  if (registry) return registry;
  try {
    registry = createContractRegistry();
    return registry;
  } catch (error) {
    throw new ContractRegistryError(stableIssues([registryBuildIssue(error)]));
  }
}

function invariantForSchemaError(
  registry: ContractRegistry,
  contract: ContractName,
  error: ErrorObject
): string {
  if (error.keyword === 'x-mercury-semantic-checks') {
    const invariantId = (error.params as Record<string, unknown>).invariant_id;
    if (typeof invariantId === 'string') return invariantId;
  }
  if (error.keyword === 'additionalProperties' || error.keyword === 'unevaluatedProperties') {
    return 'INV-GEN-005';
  }
  return schemaErrorInvariantId(registry, contract, error) ?? 'INV-API-001';
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function schemaErrorPath(error: ErrorObject): string {
  if (error.keyword === 'required') {
    const missing = (error.params as Record<string, unknown>).missingProperty;
    if (typeof missing === 'string') {
      return `${error.instancePath}/${escapePointerSegment(missing)}` || '/';
    }
  }
  if (error.keyword === 'additionalProperties') {
    const additional = (error.params as Record<string, unknown>).additionalProperty;
    if (typeof additional === 'string') {
      return `${error.instancePath}/${escapePointerSegment(additional)}` || '/';
    }
  }
  if (error.keyword === 'unevaluatedProperties') {
    const additional = (error.params as Record<string, unknown>).unevaluatedProperty;
    if (typeof additional === 'string') {
      return `${error.instancePath}/${escapePointerSegment(additional)}` || '/';
    }
  }
  return error.instancePath || '/';
}

function schemaIssues(
  registry: ContractRegistry,
  contract: ContractName,
  errors: ErrorObject[]
): ValidationIssue[] {
  return errors.map((error) => ({
    invariant_id: invariantForSchemaError(registry, contract, error),
    path: schemaErrorPath(error),
    message: error.message ?? 'schema validation failed'
  }));
}

function checkedContractName(name: string): ContractName {
  if (!registryContractNames().includes(name as ContractName)) {
    throw new ContractRegistryError([
      {
        invariant_id: 'INV-API-001',
        path: '/contract',
        message: `unregistered contract: ${name}`
      }
    ]);
  }
  return name as ContractName;
}

export function validateContract<N extends ContractName>(
  name: N,
  value: unknown
): ValidationResult<ContractTypeMap[N]> {
  const contract = checkedContractName(name);
  const currentRegistry = getRegistry();
  const validator = currentRegistry.validators[contract];
  const structurallyValid = validator(value);
  const issues = stableIssues([
    ...sensitiveInformationIssues(value),
    ...(structurallyValid
      ? []
      : schemaIssues(currentRegistry, contract, rawSchemaErrors(validator)))
  ]);

  if (issues.length > 0) return { valid: false, value: null, issues };
  return { valid: true, value: value as ContractTypeMap[N], issues: [] };
}

export function assertContract<N extends ContractName>(
  name: N,
  value: unknown
): ContractTypeMap[N] {
  const result = validateContract(name, value);
  if (!result.valid) throw new ContractValidationError(result.issues);
  return result.value;
}

export function validateAllSchemas(): void {
  try {
    const validatedRegistry = createContractRegistry();
    registry ??= validatedRegistry;
  } catch (error) {
    throw new ContractRegistryError(stableIssues([registryBuildIssue(error)]));
  }
}

const graphKeys = new Set([
  'modelConfig',
  'modelSnapshot',
  'transcriptRaw',
  'calibrationResult',
  'audioVerification',
  'adapterFailures',
  'availableTaskFiles',
  'availableModificationIds',
  'availableReferenceSegmentIds'
]);

function graphIssue(
  issues: ValidationIssue[],
  invariant_id: string,
  path: string,
  message: string
): void {
  issues.push({ invariant_id, path, message });
}

function prefixedIssues(prefix: string, issues: ValidationIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    ...issue,
    path: issue.path === '/' ? prefix : `${prefix}${issue.path}`
  }));
}

function validateUniqueStringArray(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  registry: ContractRegistry,
  validator: ContractRegistry['sharedValidators']['protocolId'],
  fallbackInvariantId: string
): string[] | undefined {
  if (!Array.isArray(value)) {
    graphIssue(issues, fallbackInvariantId, path, 'must be an array');
    return undefined;
  }
  const values: string[] = [];
  value.forEach((entry, index) => {
    if (!validator(entry)) {
      for (const error of rawSchemaErrors(validator)) {
        graphIssue(
          issues,
          sharedSchemaErrorInvariantId(registry, error) ?? fallbackInvariantId,
          `${path}/${index}${schemaErrorPath(error) === '/' ? '' : schemaErrorPath(error)}`,
          error.message ?? 'does not match the shared string primitive'
        );
      }
      return;
    }
    values.push(entry as string);
  });
  if (new Set(values).size !== values.length) {
    graphIssue(issues, 'INV-GEN-004', path, 'must not contain duplicate values');
  }
  return values;
}

function milliseconds(value: string): number {
  return Date.parse(value);
}

function gcsBucket(uri: string): string | undefined {
  return /^gs:\/\/([^/]+)\/.+/u.exec(uri)?.[1];
}

function isReferenceSrtSegmentId(value: string): boolean {
  const match = /^reference-([0-9]+)$/u.exec(value);
  if (!match) return false;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index > 0 && match[1] === String(index).padStart(4, '0');
}

export function validateContractGraph(graph: ContractGraph): ValidationResult<ContractGraph> {
  const issues: ValidationIssue[] = sensitiveInformationIssues(graph);
  if (typeof graph !== 'object' || graph === null || Array.isArray(graph)) {
    return {
      valid: false,
      value: null,
      issues: [{ invariant_id: 'INV-API-001', path: '/', message: 'must be an object' }]
    };
  }

  const value = graph as ContractGraph & Record<string, unknown>;
  const currentRegistry = getRegistry();
  for (const key of Object.keys(value)) {
    if (!graphKeys.has(key)) {
      graphIssue(issues, 'INV-GEN-005', `/${escapePointerSegment(key)}`, 'must not contain an unregistered graph field');
    }
  }

  const validateNestedContract = <N extends ContractName>(
    field: string,
    contract: N
  ): ContractTypeMap[N] | undefined => {
    const candidate = value[field];
    if (candidate === undefined) return undefined;
    const result = validateContract(contract, candidate);
    if (!result.valid) {
      issues.push(...prefixedIssues(`/${field}`, result.issues));
      return undefined;
    }
    return result.value;
  };
  validateNestedContract('modelConfig', 'model-config');
  const snapshot = validateNestedContract('modelSnapshot', 'model-snapshot');
  const transcript = validateNestedContract('transcriptRaw', 'transcript.raw');
  const calibration = validateNestedContract('calibrationResult', 'calibration-result');
  const audio = validateNestedContract('audioVerification', 'audio-verification');

  const taskFiles = value.availableTaskFiles === undefined
    ? undefined
    : validateUniqueStringArray(
      value.availableTaskFiles,
      '/availableTaskFiles',
      issues,
      currentRegistry,
      currentRegistry.sharedValidators.taskRelativePath,
      'INV-GEN-007'
    );
  const modificationIds = value.availableModificationIds === undefined
    ? undefined
    : validateUniqueStringArray(
      value.availableModificationIds,
      '/availableModificationIds',
      issues,
      currentRegistry,
      currentRegistry.sharedValidators.protocolId,
      'INV-AV-006'
    );
  const referenceSegmentIds = value.availableReferenceSegmentIds === undefined
    ? undefined
    : validateUniqueStringArray(
      value.availableReferenceSegmentIds,
      '/availableReferenceSegmentIds',
      issues,
      currentRegistry,
      currentRegistry.sharedValidators.protocolId,
      'INV-GEN-004'
    );
  referenceSegmentIds?.forEach((reference, index) => {
    if (!isReferenceSrtSegmentId(reference)) {
      graphIssue(
        issues,
        'INV-GEN-004',
        `/availableReferenceSegmentIds/${index}`,
        'must use an original reference-SRT segment ID generated by the parser'
      );
    }
  });
  const validReferenceSegmentIds = referenceSegmentIds?.filter(isReferenceSrtSegmentId);
  const workArtifacts = [value.transcriptRaw, value.calibrationResult, value.audioVerification];
  if (workArtifacts.some((artifact) => artifact !== undefined) && taskFiles === undefined) {
    graphIssue(issues, 'INV-GEN-007', '/availableTaskFiles', 'is required when the graph contains a work artifact');
  }

  const adapterFailures: Array<{
    failure: NonNullable<ContractGraph['adapterFailures']>[number];
    index: number;
  }> = [];
  if (value.adapterFailures !== undefined) {
    if (!Array.isArray(value.adapterFailures)) {
      graphIssue(issues, 'INV-ADP-001', '/adapterFailures', 'must be an array');
    } else {
      value.adapterFailures.forEach((failure, index) => {
        if (!currentRegistry.sharedValidators.adapterFailure(failure)) {
          for (const error of rawSchemaErrors(currentRegistry.sharedValidators.adapterFailure)) {
            graphIssue(
              issues,
              error.keyword === 'additionalProperties'
                ? 'INV-GEN-005'
                : sharedSchemaErrorInvariantId(currentRegistry, error) ?? 'INV-ADP-001',
              `/adapterFailures/${index}${schemaErrorPath(error) === '/' ? '' : schemaErrorPath(error)}`,
              error.message ?? 'invalid adapter failure'
            );
          }
        } else {
          adapterFailures.push({
            failure: failure as NonNullable<ContractGraph['adapterFailures']>[number],
            index
          });
        }
        issues.push(...prefixedIssues(`/adapterFailures/${index}`, sensitiveInformationIssues(failure)));
      });
      const ids = adapterFailures.map(({ failure }) => failure.failure_id);
      if (new Set(ids).size !== ids.length) {
        graphIssue(issues, 'INV-GEN-004', '/adapterFailures', 'failure_id values must be unique');
      }
    }
  }

  const requireDependency = (present: unknown, dependency: unknown, path: string, name: string) => {
    if (present !== undefined && dependency === undefined) {
      graphIssue(issues, 'INV-GEN-007', path, `${name} direct dependency is required`);
    }
  };
  requireDependency(value.transcriptRaw, value.modelSnapshot, '/modelSnapshot', 'transcriptRaw');
  requireDependency(value.calibrationResult, value.modelSnapshot, '/modelSnapshot', 'calibrationResult');
  requireDependency(value.calibrationResult, value.transcriptRaw, '/transcriptRaw', 'calibrationResult');
  if (audio?.input !== null && audio?.input !== undefined) {
    requireDependency(value.audioVerification, value.modelSnapshot, '/modelSnapshot', 'audioVerification');
    requireDependency(value.audioVerification, value.transcriptRaw, '/transcriptRaw', 'audioVerification');
    requireDependency(value.audioVerification, value.calibrationResult, '/calibrationResult', 'audioVerification');
  }
  if (audio?.model_snapshot_ref) {
    requireDependency(value.audioVerification, value.modelSnapshot, '/modelSnapshot', 'audioVerification');
  }
  if (Array.isArray(value.adapterFailures) && value.adapterFailures.length > 0) {
    requireDependency(value.adapterFailures, snapshot, '/modelSnapshot', 'adapterFailures');
  }

  const taskId = snapshot?.task_id;
  for (const [field, artifact] of [
    ['transcriptRaw', transcript],
    ['calibrationResult', calibration],
    ['audioVerification', audio]
  ] as const) {
    if (taskId && artifact && artifact.task_id !== taskId) {
      graphIssue(issues, 'INV-GEN-007', `/${field}/task_id`, 'must equal modelSnapshot.task_id');
    }
  }

  const checkArtifactModel = (
    field: 'transcriptRaw' | 'calibrationResult' | 'audioVerification',
    artifact: { model_snapshot_ref: string | null; call?: { model_snapshot_entry_ref: string; started_at: string }; calls?: Array<{ model_snapshot_entry_ref: string; started_at: string }> } | undefined,
    role: 'asr' | 'calibration' | 'audio_verification'
  ) => {
    if (!artifact || !snapshot || artifact.model_snapshot_ref === null) return;
    if (artifact.model_snapshot_ref !== snapshot.snapshot_id) {
      graphIssue(issues, 'INV-GEN-007', `/${field}/model_snapshot_ref`, 'must equal modelSnapshot.snapshot_id');
    }
    const entry = snapshot.models[role];
    if (!entry) {
      graphIssue(
        issues,
        role === 'audio_verification' && artifact.calls?.length === 0 ? 'INV-MOD-009' : 'INV-CALL-001',
        `/${field}/model_snapshot_ref`,
        `modelSnapshot must contain the ${role} role entry`
      );
    }
    const calls = artifact.call ? [artifact.call] : artifact.calls ?? [];
    calls.forEach((call, index) => {
      const callPath = artifact.call ? `/${field}/call` : `/${field}/calls/${index}`;
      if (!entry || call.model_snapshot_entry_ref !== entry.snapshot_entry_id) {
        graphIssue(issues, 'INV-CALL-001', `${callPath}/model_snapshot_entry_ref`, `must reference the ${role} snapshot entry`);
      }
      if (entry && milliseconds(call.started_at) < milliseconds(snapshot.captured_at)) {
        graphIssue(issues, 'INV-CALL-001', `${callPath}/started_at`, 'must not precede snapshot capture');
      }
      if (
        entry?.cloud_data_confirmation.confirmed_at &&
        milliseconds(call.started_at) < milliseconds(entry.cloud_data_confirmation.confirmed_at)
      ) {
        graphIssue(issues, 'INV-CLD-001', `${callPath}/started_at`, 'must not precede cloud-data confirmation');
      }
    });
  };
  checkArtifactModel('transcriptRaw', transcript, 'asr');
  checkArtifactModel('calibrationResult', calibration, 'calibration');
  checkArtifactModel('audioVerification', audio, 'audio_verification');

  if (
    audio?.status === 'skipped' &&
    ['not_configured', 'cloud_confirmation_missing', 'check_missing_or_stale'].includes(audio.skip_reason ?? '') &&
    snapshot?.models.audio_verification
  ) {
    graphIssue(issues, 'INV-MOD-009', '/audioVerification/skip_reason', 'cannot claim an invalid audio model prerequisite when the task snapshot contains a valid audio role entry');
  }

  const requireFile = (path: string | null | undefined, issuePath: string) => {
    if (path && taskFiles && !taskFiles.includes(path)) {
      graphIssue(issues, 'INV-GEN-007', issuePath, 'must resolve through availableTaskFiles');
    }
  };
  if (transcript) {
    requireFile(transcript.audio.path_ref, '/transcriptRaw/audio/path_ref');
    requireFile(transcript.raw_response_ref, '/transcriptRaw/raw_response_ref');
  }
  if (calibration) {
    requireFile(calibration.request.transcript_ref, '/calibrationResult/request/transcript_ref');
    requireFile(calibration.request.reference_srt_ref, '/calibrationResult/request/reference_srt_ref');
    if (transcript) {
      const segments = new Map(transcript.segments.map((segment) => [segment.segment_id, segment]));
      calibration.suggestions.forEach((suggestion, index) => {
        const referencedSegments = suggestion.source_segment_refs.flatMap((reference) => {
          const segment = segments.get(reference);
          if (!segment) {
            graphIssue(issues, 'INV-GEN-004', `/calibrationResult/suggestions/${index}/source_segment_refs`, 'must reference transcript segments');
            return [];
          }
          return [segment];
        });
        if (
          referencedSegments.length > 0 &&
          (suggestion.start_ms < Math.min(...referencedSegments.map((segment) => segment.start_ms)) ||
            suggestion.end_ms > Math.max(...referencedSegments.map((segment) => segment.end_ms)))
        ) {
          graphIssue(issues, 'INV-GEN-003', `/calibrationResult/suggestions/${index}`, 'time range must be bounded by its source segments');
        }
      });
    }
  }
  if (audio?.input) {
    requireFile(audio.input.audio_ref, '/audioVerification/input/audio_ref');
    requireFile(audio.input.transcript_ref, '/audioVerification/input/transcript_ref');
    requireFile(audio.input.calibration_ref, '/audioVerification/input/calibration_ref');
    requireFile(audio.input.reference_srt_ref, '/audioVerification/input/reference_srt_ref');
    if (transcript && (audio.input.audio_ref !== transcript.audio.path_ref || audio.input.audio_sha256 !== transcript.audio.sha256)) {
      graphIssue(issues, 'INV-AV-006', '/audioVerification/input', 'audio reference and hash must match transcriptRaw');
    }
    if (calibration && (calibration.status !== 'completed' || audio.input.reference_srt_ref !== calibration.request.reference_srt_ref)) {
      graphIssue(issues, 'INV-AV-006', '/audioVerification/input', 'must consume a completed calibration result with the same reference SRT');
    }
    if (transcript) {
      const transcriptSegmentIds = new Set(transcript.segments.map((segment) => segment.segment_id));
      const transcriptSegments = new Map(transcript.segments.map((segment) => [segment.segment_id, segment]));
      const referenceIds = new Set(validReferenceSegmentIds ?? []);
      const chunking = audio.local_chunking;
      if (chunking && chunking.parts.at(-1)?.end_ms !== transcript.audio.duration_ms) {
        graphIssue(
          issues,
          'INV-GEN-003',
          '/audioVerification/local_chunking/parts',
          'chunk timeline must cover the full source audio duration'
        );
      }
      audio.findings.forEach((finding, index) => {
        if (finding.end_ms > transcript.audio.duration_ms) {
          graphIssue(issues, 'INV-GEN-003', `/audioVerification/findings/${index}/end_ms`, 'must not exceed the source audio duration');
        }
        finding.source_segment_refs?.forEach((reference) => {
          if (
            reference.startsWith('subtitle-') ||
            (!transcriptSegmentIds.has(reference) && !referenceIds.has(reference))
          ) {
            graphIssue(
              issues,
              'INV-GEN-004',
              `/audioVerification/findings/${index}/source_segment_refs`,
              'must reference a transcript segment or an available original reference-SRT segment'
            );
          }
        });
        const referencedAsr = (finding.source_segment_refs ?? [])
          .map((reference) => transcriptSegments.get(reference))
          .filter((segment): segment is NonNullable<typeof segment> => segment !== undefined);
        if (
          referencedAsr.length > 0 &&
          (finding.start_ms < Math.min(...referencedAsr.map((segment) => segment.start_ms)) ||
            finding.end_ms > Math.max(...referencedAsr.map((segment) => segment.end_ms)))
        ) {
          graphIssue(
            issues,
            'INV-GEN-003',
            `/audioVerification/findings/${index}`,
            'time range must be bounded by its referenced transcript segments'
          );
        }
      });
    }
    if (calibration?.request.mode === 'text-only') {
      audio.application_results.forEach((application, index) => {
        const finding = audio.findings.find((candidate) => candidate.finding_id === application.finding_ref);
        if (application.disposition === 'applied' && (finding?.kind === 'segmentation' || finding?.kind === 'timing')) {
          graphIssue(issues, 'INV-AV-006', `/audioVerification/application_results/${index}`, 'text-only mode cannot apply segmentation or timing findings');
        }
      });
    }
  }

  const applied = audio?.application_results.filter((entry) => entry.disposition === 'applied') ?? [];
  if (applied.length > 0 && modificationIds === undefined) {
    graphIssue(issues, 'INV-AV-006', '/availableModificationIds', 'is required for applied audio-verification results');
  }
  applied.forEach((entry, index) => {
    if (entry.modification_ref && modificationIds && !modificationIds.includes(entry.modification_ref)) {
      graphIssue(issues, 'INV-AV-006', `/audioVerification/application_results/${index}/modification_ref`, 'must resolve through availableModificationIds');
    }
  });

  if (audio && snapshot?.models.audio_verification) {
    const entry = snapshot.models.audio_verification as typeof snapshot.models.audio_verification & {
      plugin_id?: string;
      connection_type?: string;
    };
    const expectedBucket = (entry.provider_config as Record<string, unknown>).gcs_bucket;
    audio.staging.forEach((staging, index) => {
      if (staging.staging_kind === 'gemini_file') {
        if (entry.plugin_id !== 'gemini' || entry.connection_type !== 'developer_api') {
          graphIssue(issues, 'INV-GCS-003', `/audioVerification/staging/${index}`, 'Gemini Files staging requires the gemini/developer_api snapshot connection');
        }
      } else if (!expectedBucket || gcsBucket(staging.object_uri) !== expectedBucket) {
        graphIssue(issues, 'INV-GCS-003', `/audioVerification/staging/${index}/object_uri`, 'bucket must equal the audio-verification snapshot bucket');
      }
    });
  }

  adapterFailures.forEach(({ failure, index }) => {
    if (taskId && failure.task_id !== taskId) {
      graphIssue(issues, 'INV-GEN-007', `/adapterFailures/${index}/task_id`, 'must equal modelSnapshot.task_id');
    }
    const entry = snapshot?.models[failure.role];
    if (
      snapshot &&
      (!entry ||
        failure.model_snapshot_ref !== snapshot.snapshot_id ||
        (failure.call !== null && failure.call.model_snapshot_entry_ref !== entry.snapshot_entry_id))
    ) {
      graphIssue(issues, 'INV-ADP-001', `/adapterFailures/${index}`, 'must reference the matching model snapshot and role entry');
    }
    if (entry && failure.call) {
      if (milliseconds(failure.call.started_at) < milliseconds(snapshot!.captured_at)) {
        graphIssue(issues, 'INV-CALL-001', `/adapterFailures/${index}/call/started_at`, 'must not precede snapshot capture');
      }
      if (
        entry.cloud_data_confirmation.confirmed_at &&
        milliseconds(failure.call.started_at) < milliseconds(entry.cloud_data_confirmation.confirmed_at)
      ) {
        graphIssue(issues, 'INV-CLD-001', `/adapterFailures/${index}/call/started_at`, 'must not precede cloud-data confirmation');
      }
    }
    if (entry?.role === 'audio_verification') {
      const pluginEntry = entry as typeof entry & { plugin_id?: string; connection_type?: string };
      const expectedBucket = (entry.provider_config as Record<string, unknown>).gcs_bucket;
      failure.staging.forEach((staging, stagingIndex) => {
        if (staging.staging_kind === 'gemini_file') {
          if (pluginEntry.plugin_id !== 'gemini' || pluginEntry.connection_type !== 'developer_api') {
            graphIssue(issues, 'INV-GCS-003', `/adapterFailures/${index}/staging/${stagingIndex}`, 'Gemini Files staging requires the gemini/developer_api snapshot connection');
          }
        } else if (!expectedBucket || gcsBucket(staging.object_uri) !== expectedBucket) {
          graphIssue(issues, 'INV-GCS-003', `/adapterFailures/${index}/staging/${stagingIndex}/object_uri`, 'bucket must equal the audio-verification snapshot bucket');
        }
      });
    }
    const hasArtifact = failure.role === 'asr' ? transcript !== undefined : failure.role === 'calibration' ? calibration !== undefined : audio !== undefined;
    if (hasArtifact) {
      graphIssue(issues, failure.role === 'audio_verification' ? 'INV-AV-005' : 'INV-ADP-001', `/adapterFailures/${index}`, 'must be mutually exclusive with the role work artifact');
    }
  });

  const sorted = stableIssues(issues);
  if (sorted.length > 0) return { valid: false, value: null, issues: sorted };
  return { valid: true, value: graph, issues: [] };
}

export function assertContractGraph(graph: ContractGraph): ContractGraph {
  const result = validateContractGraph(graph);
  if (!result.valid) throw new ContractValidationError(result.issues);
  return result.value;
}
