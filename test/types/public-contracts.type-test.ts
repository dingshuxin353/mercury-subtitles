import type {
  AdapterFailureRecord,
  AdapterExecutionResult,
  AudioVerification,
  AudioVerificationCapabilities,
  CallRecord,
  CalibrationResult,
  ContractGraph,
  ModelCheckRecord,
  ModelConfig,
  ModelSnapshotEntry,
  StagingRecord,
  TranscriptRaw
} from '../../src/contracts/index.js';

type ModelConfigRequiresExplicitCheckState = ModelConfig extends {
  last_check: ModelCheckRecord | null;
}
  ? true
  : false;
const modelConfigRequiresExplicitCheckState: ModelConfigRequiresExplicitCheckState = true;
const uncheckedConfig: Pick<ModelConfig, 'last_check'> = { last_check: null };
// @ts-expect-error Every model config requires adapter-specific provider configuration.
const modelConfigWithoutProviderConfig: Pick<ModelConfig, 'provider_config'> = {};
// @ts-expect-error Every snapshot entry freezes adapter-specific provider configuration.
const snapshotWithoutProviderConfig: Pick<ModelSnapshotEntry, 'provider_config'> = {};
type AudioCapabilityRequiresPrivateGcs = AudioVerificationCapabilities extends {
  private_gcs: unknown;
}
  ? true
  : false;
const audioCapabilityRequiresPrivateGcs: AudioCapabilityRequiresPrivateGcs = true;
const completeAudioCapability: AudioVerificationCapabilities = {
  role: 'audio_verification',
  sample_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  mime_type: 'audio/mpeg',
  timed_text_fixture_id: 'timed-text-fixture-v1',
  result_schema_version: '1.0.0',
  inline_audio: {
    max_inline_bytes: 20971520,
    max_audio_duration_ms: 3600000,
    parsed_finding_count: 0
  },
  private_gcs: null
};

const audioCapabilityWithUnknownField: AudioVerificationCapabilities = {
  ...completeAudioCapability,
  // @ts-expect-error Audio capability summaries are closed persisted records.
  unexpected: true
};

// @ts-expect-error CallRecord requires call identity, timing, outcome, and confirmation fields.
const emptyCall: CallRecord = {};

// @ts-expect-error A failed call must include a non-null error reference.
const failedCallWithoutError: CallRecord = {
  call_id: 'call-type-test',
  model_snapshot_entry_ref: 'snapshot-entry-asr',
  started_at: '2026-08-04T08:00:00.000+08:00',
  ended_at: '2026-08-04T08:00:01.000+08:00',
  outcome: 'failed'
};

// @ts-expect-error Completed staging records require a cleanup terminal time and null error reference.
const incompleteStaging: StagingRecord = {
  staging_id: 'staging-type-test',
  object_uri: 'gs://fixture-bucket/task/object.mp3',
  call_ref: 'call-type-test',
  created_at: '2026-08-04T08:00:00.000+08:00',
  cleanup_status: 'completed'
};

const terminalFailureRecord: AdapterFailureRecord = {
  failure_id: 'failure-type-test',
  task_id: 'task-type-test',
  role: 'asr',
  model_snapshot_ref: 'snapshot-type-test',
  occurred_at: '2026-08-04T08:00:02.000+08:00',
  provider_outcome_certainty: 'known_terminal',
  errors: [{
    error_id: 'error-type-test',
    code: 'MODEL_CALL_FAILED',
    message: 'The model call failed.',
    stage: 'model_call',
    retryable: true
  }],
  warnings: [],
  call: {
    call_id: 'call-type-test',
    model_snapshot_entry_ref: 'snapshot-entry-asr',
    started_at: '2026-08-04T08:00:00.000+08:00',
    ended_at: '2026-08-04T08:00:01.000+08:00',
    outcome: 'failed',
    error_ref: 'error-type-test'
  },
  staging: []
};

declare const transcript: TranscriptRaw;
const transcriptWithUnknownField: TranscriptRaw = {
  ...transcript,
  // @ts-expect-error Generated persisted transcript types are closed.
  supplier_payload: {}
};

declare const calibration: CalibrationResult;
const calibrationWithUnknownField: CalibrationResult = {
  ...calibration,
  // @ts-expect-error Generated persisted calibration types are closed.
  supplier_payload: {}
};

declare const audioVerification: AudioVerification;
const audioVerificationWithUnknownField: AudioVerification = {
  ...audioVerification,
  // @ts-expect-error Generated persisted audio-verification types are closed.
  supplier_payload: {}
};

const graphWithUnknownField: ContractGraph = {
  // @ts-expect-error ContractGraph accepts exactly its eight declared context fields.
  supplierPayload: {}
};

// @ts-expect-error Adapter execution has no third or partially duplicated envelope branch.
const invalidAdapterEnvelope: AdapterExecutionResult<TranscriptRaw> = { kind: 'warning' };

void emptyCall;
void failedCallWithoutError;
void incompleteStaging;
void audioCapabilityRequiresPrivateGcs;
void completeAudioCapability;
void audioCapabilityWithUnknownField;
void modelConfigRequiresExplicitCheckState;
void uncheckedConfig;
void modelConfigWithoutProviderConfig;
void snapshotWithoutProviderConfig;
void terminalFailureRecord;
void transcriptWithUnknownField;
void calibrationWithUnknownField;
void audioVerificationWithUnknownField;
void graphWithUnknownField;
void invalidAdapterEnvelope;
