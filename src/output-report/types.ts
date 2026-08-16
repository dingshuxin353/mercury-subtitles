import type {
  AudioVerification,
  CalibrationResult,
  ModelSnapshot,
  TranscriptRaw
} from '../contracts/index.js';
import type {
  AlignmentArtifact,
  CalibratedTranscript
} from '../subtitle-core/index.js';
import type { TaskRecord } from '../tasks.js';

export type ReportModificationType =
  | 'recognition_error'
  | 'proper_noun'
  | 'term'
  | 'number_unit'
  | 'punctuation'
  | 'missing_content'
  | 'split'
  | 'merge'
  | 'timing';

export interface ParsedSrtSegment {
  sequence: number;
  start_ms: number;
  end_ms: number;
  text: string;
  lines: string[];
}

export interface QualityCheck {
  check_id: string;
  status: 'passed' | 'warning' | 'failed';
  message: string;
  segment_refs: string[];
}

export type SrtValidationResult =
  | {
      valid: true;
      segments: ParsedSrtSegment[];
      checks: QualityCheck[];
    }
  | {
      valid: false;
      segments: ParsedSrtSegment[];
      checks: QualityCheck[];
    };

export interface OutputSourceArtifacts {
  modelSnapshot: ModelSnapshot | null;
  transcript: TranscriptRaw | null;
  calibrationResult: CalibrationResult | null;
  alignment: AlignmentArtifact | null;
  calibratedTranscript: CalibratedTranscript | null;
  audioVerification: AudioVerification | null;
  hashes: Record<string, string>;
}

export interface GenerateTaskOutputsOptions {
  now?: () => Date;
}

export interface GenerateTaskOutputsResult {
  task: TaskRecord;
  srt_path: string | null;
  report_path: 'output/calibration-report.md';
  srt_validation: SrtValidationResult | null;
  sources: OutputSourceArtifacts;
}
