import type {
  AdapterAudioInput,
  AdapterExecutionResult,
  AudioVerification,
  CalibrationResult,
  CloudDataConfirmation,
  ModelCheckRecord,
  ModelRole,
  ReferenceSrtInput,
  TranscriptRaw
} from '../contracts/index.js';
import type { GeminiAdapterDependencies } from '../adapters/gemini-audio-verification.js';
import type { CalibratedTranscript } from '../subtitle-core/index.js';

export type ModelTaskCapability = 'transcription' | 'proofreading' | 'audio_verification';
export type ModelInputModality = 'text' | 'audio' | 'image' | 'video';
export type ModelOutputType = 'text' | 'timed_transcript' | 'structured_result';

export interface ModelCapabilityProfile {
  task_capabilities: ModelTaskCapability[];
  input_modalities: ModelInputModality[];
  output_types: ModelOutputType[];
  structured_output: boolean;
}

export interface PluginModelConfig {
  config_id: string;
  name: string;
  role: ModelRole;
  runtime: 'cloud';
  plugin_id: string;
  connection_id: string;
  connection_type: string;
  model: string;
  endpoint: string | null;
  credential_ref: string | null;
  provider_config: Record<string, unknown>;
  declared_capabilities: ModelCapabilityProfile;
  enabled: boolean;
  cloud_data_confirmation: CloudDataConfirmation;
  config_fingerprint: string;
  last_check: (ModelCheckRecord & { verified_capabilities: ModelCapabilityProfile | null }) | null;
}

export interface PluginModelSnapshotEntry {
  snapshot_entry_id: string;
  role: ModelRole;
  config_id: string;
  name: string;
  config_fingerprint: string;
  plugin_id: string;
  connection_id: string;
  connection_type: string;
  model: string;
  runtime: 'cloud';
  endpoint: string | null;
  credential_ref: string | null;
  provider_config: Record<string, unknown>;
  declared_capabilities: ModelCapabilityProfile;
  cloud_data_confirmation: CloudDataConfirmation;
  check_snapshot: ModelCheckRecord & { verified_capabilities: ModelCapabilityProfile | null };
}

export interface ProviderConnection {
  connection_id: string;
  plugin_id: string;
  connection_type: string;
  runtime: 'cloud';
  endpoint: string | null;
  credential_ref: string | null;
  provider_config: Record<string, unknown>;
}

export interface ModelInstance {
  model_instance_id: string;
  connection_id: string;
  model: string;
  declared_capabilities: ModelCapabilityProfile;
  verified_capabilities: ModelCapabilityProfile | null;
}

export interface TaskRoleAssignment {
  role: ModelRole;
  capability: ModelTaskCapability;
  model_instance_id: string;
}

export interface TranscriptionInput {
  taskId: string;
  modelSnapshotRef: string;
  model: PluginModelSnapshotEntry;
  audio: AdapterAudioInput;
}

export interface ProofreadingInput {
  taskId: string;
  modelSnapshotRef: string;
  model: PluginModelSnapshotEntry;
  transcript: TranscriptRaw;
  referenceSrt: ReferenceSrtInput | null;
  mode: 'text-only' | 'text-and-segmentation' | null;
}

export interface AudioVerificationInput {
  taskId: string;
  modelSnapshotRef: string;
  model: PluginModelSnapshotEntry;
  audio: AdapterAudioInput;
  transcript: TranscriptRaw;
  calibrationResult: CalibrationResult & { status: 'completed' };
  calibratedTranscript: CalibratedTranscript;
  referenceSrt: ReferenceSrtInput | null;
}

export interface TranscriptionRuntime {
  readonly capability: 'transcription';
  run(input: TranscriptionInput): Promise<AdapterExecutionResult<TranscriptRaw>>;
}

export interface ProofreadingRuntime {
  readonly capability: 'proofreading';
  run(input: ProofreadingInput): Promise<AdapterExecutionResult<CalibrationResult>>;
}

export interface AudioVerificationRuntime {
  readonly capability: 'audio_verification';
  run(input: AudioVerificationInput): Promise<AdapterExecutionResult<AudioVerification>>;
}

export interface ModelPluginRuntimeDependencies extends GeminiAdapterDependencies {
  fetch?: typeof globalThis.fetch;
  readCredential?: (reference: string) => Promise<string>;
  resolveAsrCredential?: (reference: string) => Promise<
    | { mode: 'api_key'; uid: string; value: string }
    | { mode: 'legacy'; uid: string; appKey: string; accessKey: string }
  >;
  captureCalibrationResponseBody?: (body: string) => Promise<void>;
}

export interface BuiltinModelPlugin {
  readonly pluginId: string;
  readonly apiVersion: 1;
  readonly connectionTypes: readonly string[];
  readonly declaredCapabilities: ModelCapabilityProfile;
  createTranscriptionRuntime?(dependencies: ModelPluginRuntimeDependencies): TranscriptionRuntime;
  createProofreadingRuntime?(dependencies: ModelPluginRuntimeDependencies): ProofreadingRuntime;
  createAudioVerificationRuntime?(dependencies: ModelPluginRuntimeDependencies): AudioVerificationRuntime;
}
