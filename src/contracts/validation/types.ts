import type { AudioVerification } from '../generated/audio-verification.js';
import type { CalibrationResult } from '../generated/calibration-result.js';
import type { AdapterFailureRecord } from '../generated/common.js';
import type { ModelConfigRegistry } from '../generated/model-config.js';
import type { ModelSnapshot } from '../generated/model-snapshot.js';
import type { TranscriptRaw } from '../generated/transcript-raw.js';

export interface ContractTypeMap {
  'model-config': ModelConfigRegistry;
  'model-snapshot': ModelSnapshot;
  'transcript.raw': TranscriptRaw;
  'calibration-result': CalibrationResult;
  'audio-verification': AudioVerification;
}

export type ContractName = keyof ContractTypeMap;

export interface ContractGraph {
  modelConfig?: ModelConfigRegistry;
  modelSnapshot?: ModelSnapshot;
  transcriptRaw?: TranscriptRaw;
  calibrationResult?: CalibrationResult;
  audioVerification?: AudioVerification;
  adapterFailures?: AdapterFailureRecord[];
  availableTaskFiles?: string[];
  availableModificationIds?: string[];
  availableReferenceSegmentIds?: string[];
}

export interface ValidationIssue {
  invariant_id: string;
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { valid: true; value: T; issues: [] }
  | { valid: false; value: null; issues: ValidationIssue[] };
