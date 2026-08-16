export type {
  AbsoluteHttpsUrl,
  AdapterFailureRecord,
  AsrCapabilities,
  AudioChunkRecord,
  AudioSource,
  AudioVerificationCapabilities,
  CallRecord,
  CalibrationCapabilities,
  ChatCompletionsProviderConfig,
  CloudDataConfirmation,
  CredentialRef,
  ErrorRecord,
  Evidence,
  GeminiDeveloperProviderConfig,
  GeminiFileResourceName,
  GeminiFilesCapabilities,
  GcsObjectUri,
  InlineAudioCapabilities,
  LocalAudioChunkingCapabilities,
  ModelCheckRecord,
  ModelCapabilities,
  ModelRole,
  NonBlankString,
  NonNegativeMilliseconds,
  PositiveMilliseconds,
  PrivateGcsCapabilities,
  ProtocolId,
  Runtime,
  SchemaVersion,
  Sha256,
  StagingRecord,
  TaskRelativePath,
  Timestamp,
  VisibleString,
  VertexAudioProviderConfig,
  VolcengineAsrProviderConfig,
  WarningRecord
} from './generated/common.js';
export type { ProtocolId as CallId } from './generated/common.js';
export type {
  AsrModelConfig,
  AudioVerificationModelConfig,
  CalibrationModelConfig,
  ChatPluginModelConfig,
  GeminiPluginModelConfig,
  ModelConfig,
  ModelConfigBase,
  ModelConfigRegistry,
  PluginModelConfigBase,
  VolcenginePluginModelConfig
} from './generated/model-config.js';
export type {
  AsrModelSnapshotEntry,
  AudioVerificationModelSnapshotEntry,
  CalibrationModelSnapshotEntry,
  ChatPluginModelSnapshotEntry,
  GeminiPluginModelSnapshotEntry,
  ModelSnapshot,
  ModelSnapshotEntry,
  ModelSnapshotEntryBase,
  PluginModelSnapshotEntryBase,
  VolcenginePluginModelSnapshotEntry
} from './generated/model-snapshot.js';
export type {
  TranscriptRaw,
  TranscriptSegment,
  WordTiming
} from './generated/transcript-raw.js';
export type {
  CalibrationMode,
  CalibrationRequest,
  CalibrationResult,
  CalibrationSuggestion
} from './generated/calibration-result.js';
export type {
  ApplicationResult,
  AudioVerification,
  LocalAudioChunkingExecution,
  SkipReason,
  VerificationFinding,
  VerificationInput
} from './generated/audio-verification.js';
export type { ModelCategory, ModelCapabilityProfileV2, ModelCheckV2, ModelConfigRegistryV2, ModelConfigV2 } from './generated/model-config-v2.js';
export type { ModelCheckSnapshotV2, ModelSnapshotEntryV2, ModelSnapshotV2 } from './generated/model-snapshot-v2.js';
export type { AudioInputRef, CalibrationRequestV2, CalibrationResultV2, CalibrationSuggestionV2 } from './generated/calibration-result-v2.js';
export type { CalibrationResultV3, CalibrationStrategyV3, CorrectedUnitV3 } from './generated/calibration-result-v3.js';
export type { BackgroundTaskV4 } from './generated/background-task-v4.js';
export type { BackgroundJobV1 } from './generated/background-job-v1.js';
export type { BackgroundRequestV1 } from './generated/background-request-v1.js';
export type { TaskEventV1 } from './generated/task-event-v1.js';
export type { ReviewRecordV1 } from './generated/review-v1.js';
export { assertV2Contract, computeModelConfigFingerprintV2, validateV2Contract } from './v2.js';
export type { V2ContractName, V2ContractTypeMap, V2ValidationResult } from './v2.js';
export { assertV3CalibrationResult, validateV3CalibrationResult } from './v3.js';
export type { V3ValidationResult } from './v3.js';
export { assertV4Contract, validateV4Contract } from './v4.js';
export type { V4ContractName, V4ContractTypeMap, V4ValidationResult } from './v4.js';
export type { AdapterExecutionResult } from './adapters/result.js';
export type { AsrAdapter } from './adapters/asr.js';
export type { CalibrationAdapter } from './adapters/chat-calibration.js';
export type { AudioVerificationAdapter } from './adapters/audio-verification.js';
export type {
  AdapterAudioInput,
  AsrAdapterInput,
  AudioVerificationAdapterInput,
  CalibrationAdapterInput,
  ReferenceSrtInput
} from './adapters/types.js';
export {
  assertContract,
  assertContractGraph,
  ContractRegistryError,
  ContractValidationError,
  SUPPORTED_SCHEMA_VERSION,
  validateAllSchemas,
  validateContract,
  validateContractGraph
} from './validation/index.js';
export type {
  ContractGraph,
  ContractName,
  ContractTypeMap,
  ValidationIssue,
  ValidationResult
} from './validation/index.js';
