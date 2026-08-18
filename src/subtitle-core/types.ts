import type {
  CalibrationMode,
  CalibrationResult,
  TranscriptRaw
} from '../contracts/index.js';

export const SUBTITLE_THRESHOLDS_VERSION = 'v0.1' as const;
export const SEGMENTATION_POLICY_VERSION = 'fixed-cue-text-only-v1' as const;
export const MATCH_COVERAGE_THRESHOLD = 0.8 as const;
export const TARGET_MIN_CHARACTERS = 8 as const;
export const TARGET_MAX_CHARACTERS = 18 as const;
export const HARD_MAX_CHARACTERS = 24 as const;
export const SOFT_MIN_DURATION_MS = 800 as const;
export const SOFT_MAX_DURATION_MS = 6_000 as const;
export const SOFT_MAX_READING_SPEED = 12 as const;

export interface ReferenceSrtSegment {
  reference_segment_id: string;
  sequence: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface AlignmentRelation {
  asr_segment_refs: string[];
  reference_segment_refs: string[];
  asr_character_range: { start: number; end: number };
  reference_character_range: { start: number; end: number };
  start_ms: number;
  end_ms: number;
}

export interface UnalignedRegion {
  side: 'asr' | 'reference';
  segment_refs: string[];
  character_range: { start: number; end: number };
  normalized_text: string;
  start_ms: number;
  end_ms: number;
}

export interface AlignmentArtifact {
  artifact_version: '1.0.0';
  task_id: string;
  asr_units: Array<{
    segment_id: string;
    start_ms: number;
    end_ms: number;
    text: string;
  }>;
  reference_segments: ReferenceSrtSegment[] | null;
  relations: AlignmentRelation[];
  unaligned_regions: UnalignedRegion[];
  matched_character_count: number;
  asr_character_count: number;
  reference_character_count: number | null;
  asr_coverage: number;
  reference_coverage: number | null;
  threshold: typeof MATCH_COVERAGE_THRESHOLD;
  monotonic: true;
  conclusion: 'matched' | 'needs_input';
}

export interface SubtitleCoreIssue {
  code: string;
  message: string;
  remediation?: string;
}

export interface SubtitleCoreWarning {
  warning_id: string;
  code: string;
  message: string;
  segment_refs: string[];
}

export type ModificationType =
  | 'text_correction'
  | 'omission_recovery'
  | 'segmentation'
  | 'split'
  | 'merge'
  | 'timing_adjustment';

export interface SubtitleModification {
  modification_id: string;
  type: ModificationType;
  original_text: string;
  original_segment_refs: string[];
  replacement_text: string;
  result_segment_refs: string[];
  start_ms: number;
  end_ms: number;
  evidence: {
    asr_segment_refs: string[];
    reference_segment_refs: string[];
    calibration_suggestion_ref: string | null;
  };
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  applied: boolean;
}

export interface CalibratedSubtitleSegment {
  subtitle_segment_id: string;
  index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: 'high' | 'medium' | 'low';
  asr_segment_refs: string[];
  reference_segment_refs: string[];
}

export interface CalibratedTranscript {
  artifact_version: '1.0.0';
  task_id: string;
  mode: CalibrationMode | null;
  thresholds_version: typeof SUBTITLE_THRESHOLDS_VERSION;
  source_refs: {
    transcript_ref: 'work/transcript.raw.json';
    calibration_ref: 'work/calibration-result.json';
    reference_srt_ref: 'input/reference.srt' | null;
  };
  segments: CalibratedSubtitleSegment[];
  modifications: SubtitleModification[];
  warnings: SubtitleCoreWarning[];
}

export interface SubtitleCoreInput {
  transcript: TranscriptRaw;
  calibrationResult: CalibrationResult;
  referenceSrtText: string | null;
  requestedMode?: CalibrationMode | null;
  /** Preserve an imported transcript's own segmentation without presenting it as reference SRT. */
  transcriptSourceMode?: CalibrationMode | null;
}

export type SubtitleCoreResult =
  | {
      status: 'completed';
      alignment: AlignmentArtifact;
      artifact: CalibratedTranscript;
      issues: [];
    }
  | {
      status: 'needs_input';
      alignment: AlignmentArtifact | null;
      artifact: null;
      issues: SubtitleCoreIssue[];
    }
  | {
      status: 'rejected';
      alignment: null;
      artifact: null;
      issues: SubtitleCoreIssue[];
    }
  | {
      status: 'failed';
      alignment: AlignmentArtifact | null;
      artifact: null;
      issues: SubtitleCoreIssue[];
    };

export interface TimedTextUnit {
  text: string;
  start_ms: number;
  end_ms: number;
  asr_segment_refs: string[];
  source_segment_refs: string[];
}
