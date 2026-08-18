import type {
  CalibrationMode,
  CalibrationSuggestion,
  TranscriptRaw
} from '../contracts/index.js';
import { validateContract } from '../contracts/index.js';
import {
  alignTranscriptToReference,
  audioOnlyAlignment,
  mappedReferenceRefs,
  normalizeMatchText
} from './alignment.js';
import { parseReferenceSrt } from './srt.js';
import { normalizeCalibrationUnitText } from './srt.js';
import type {
  AlignmentArtifact,
  CalibratedSubtitleSegment,
  CalibratedTranscript,
  ReferenceSrtSegment,
  SubtitleCoreInput,
  SubtitleCoreIssue,
  SubtitleCoreResult,
  SubtitleCoreWarning,
  SubtitleModification
} from './types.js';
import { countSubtitleCharacters, lineCount } from './text.js';
import { normalizeVisibleSubtitleText, VISIBLE_SUBTITLE_STYLE_VERSION } from './visible-text.js';
import {
  HARD_MAX_CHARACTERS,
  SEGMENTATION_POLICY_VERSION,
  SOFT_MAX_DURATION_MS,
  SOFT_MAX_READING_SPEED,
  SOFT_MIN_DURATION_MS,
  SUBTITLE_THRESHOLDS_VERSION,
  TARGET_MAX_CHARACTERS,
  TARGET_MIN_CHARACTERS
} from './types.js';

interface DocumentCharacter {
  value: string;
  sourceRefs: string[];
  evidence?: {
    startMs: number;
    endMs: number;
    asrSegmentRefs: string[];
  };
}

interface AppliedSuggestions {
  document: DocumentCharacter[];
  modifications: SubtitleModification[];
  warnings: SubtitleCoreWarning[];
}

export function runSubtitleCore(input: SubtitleCoreInput): SubtitleCoreResult {
  const transcriptValidation = validateContract('transcript.raw', input.transcript);
  if (!transcriptValidation.valid) {
    return failed('UPSTREAM_TRANSCRIPT_INVALID', 'The D003 transcript does not satisfy the D001 transcript.raw contract.');
  }
  const calibrationValidation = validateContract('calibration-result', input.calibrationResult);
  if (!calibrationValidation.valid || input.calibrationResult.status !== 'completed') {
    return failed('UPSTREAM_CALIBRATION_INVALID', 'The D004 calibration result is not a completed D001 calibration artifact.');
  }

  const transcript = transcriptValidation.value;
  const calibration = calibrationValidation.value;
  if (
    transcript.task_id !== calibration.task_id ||
    transcript.model_snapshot_ref !== calibration.model_snapshot_ref
  ) {
    return failed('UPSTREAM_ARTIFACT_MISMATCH', 'The D003 and D004 artifacts do not belong to the same task and model snapshot.');
  }
  const suggestionBoundaryIssue = validateSuggestionEvidenceBoundary(calibration.suggestions, transcript);
  if (suggestionBoundaryIssue) {
    return failed(suggestionBoundaryIssue.code, suggestionBoundaryIssue.message);
  }

  const modeResult = resolveMode(input.referenceSrtText, input.requestedMode);
  if ('issue' in modeResult) return rejected(modeResult.issue);
  const mode = modeResult.mode;
  if (input.referenceSrtText !== null && input.transcriptSourceMode != null) {
    return rejected({ code: 'TRANSCRIPT_SOURCE_MODE_CONFLICT', message: 'Transcript-source mode cannot be combined with reference SRT.' });
  }
  const documentMode = input.referenceSrtText === null && input.transcriptSourceMode != null
    ? input.transcriptSourceMode
    : mode;
  const expectedReference = input.referenceSrtText === null ? null : 'input/reference.srt';
  if (
    calibration.request.reference_srt_ref !== expectedReference ||
    calibration.request.mode !== mode
  ) {
    return failed('UPSTREAM_REQUEST_MISMATCH', 'The D004 request does not match the D005 reference SRT and calibration mode.');
  }

  let referenceSegments: ReferenceSrtSegment[] | null = null;
  let alignment: AlignmentArtifact;
  if (input.referenceSrtText !== null) {
    const parsed = parseReferenceSrt(input.referenceSrtText);
    if (!parsed.ok) return rejected(parsed.issue);
    referenceSegments = parsed.segments;
    const issue = referenceTimelineIssue(referenceSegments, transcript.audio.duration_ms);
    if (issue) return needsInput(issue, null);
    alignment = alignTranscriptToReference(transcript, referenceSegments);
    if (alignment.conclusion !== 'matched') {
      return needsInput({
        code: 'REFERENCE_AUDIO_MISMATCH',
        message: `ASR coverage ${percentage(alignment.asr_coverage)} and reference coverage ${percentage(alignment.reference_coverage ?? 0)} must both reach 80%.`,
        remediation: 'Check that the reference SRT belongs to this audio and retry with matching inputs.'
      }, alignment);
    }
  } else {
    alignment = audioOnlyAlignment(transcript);
  }

  const sourceDocument = documentFromTranscript(transcript);
  const nextModificationId = sequentialId('modification');
  const applied = applyCalibrationSuggestions(
    sourceDocument,
    calibration.suggestions,
    transcript,
    alignment,
    documentMode,
    referenceSegments,
    nextModificationId
  );

  let segments: CalibratedSubtitleSegment[];
  const warnings: SubtitleCoreWarning[] = [
    ...alignmentWarnings(alignment),
    ...applied.warnings
  ];
  segments = transcriptTextOnlySegments(applied.document, transcript, applied.modifications);
  if (referenceSegments !== null) {
    for (const segment of segments) {
      segment.reference_segment_refs = mappedReferenceRefs(alignment, segment.asr_segment_refs, {
        startMs: segment.start_ms,
        endMs: segment.end_ms
      });
    }
  }
  const visible = visibleSubtitleSegments(segments);
  if ('issue' in visible) return failed(visible.issue.code, visible.issue.message, alignment);
  segments = visible.segments;
  if (visible.removed > 0) warnings.push(visibleStyleWarning(segments, visible.removed, visible.protected));
  warnings.push({
    warning_id: 'warning-segmentation-policy-0001',
    code: 'CALIBRATION_TIMELINE_FROZEN',
    message: `${SEGMENTATION_POLICY_VERSION} preserved ${segments.length} transcribed cues without split, merge, reorder, or timing changes.`,
    segment_refs: unique(segments.flatMap((segment) => [...segment.asr_segment_refs, ...segment.reference_segment_refs]))
  });
  for (const segment of segments) {
    const count = countSubtitleCharacters(segment.text);
    const duration = segment.end_ms - segment.start_ms;
    const speed = duration > 0 ? count / (duration / 1_000) : Number.POSITIVE_INFINITY;
    if (count < TARGET_MIN_CHARACTERS || count > TARGET_MAX_CHARACTERS) {
      warnings.push({
        warning_id: `warning-character-target-${String(segment.index + 1).padStart(4, '0')}`,
        code: 'SUBTITLE_CHARACTER_TARGET_EXCEEDED',
        message: `Segment ${segment.index + 1} contains ${count} counted characters; the soft target is 8–18 and does not change the frozen cue.`,
        segment_refs: unique([...segment.asr_segment_refs, ...segment.reference_segment_refs])
      });
    }
    if (duration < SOFT_MIN_DURATION_MS || duration > SOFT_MAX_DURATION_MS) {
      warnings.push({
        warning_id: `warning-duration-target-${String(segment.index + 1).padStart(4, '0')}`,
        code: 'SUBTITLE_DURATION_TARGET_EXCEEDED',
        message: `Segment ${segment.index + 1} lasts ${duration} ms; the soft target is 800–6,000 ms and does not change the frozen cue.`,
        segment_refs: unique([...segment.asr_segment_refs, ...segment.reference_segment_refs])
      });
    }
    if (speed > SOFT_MAX_READING_SPEED) {
      warnings.push({
        warning_id: `warning-reading-speed-${String(segment.index + 1).padStart(4, '0')}`,
        code: 'SUBTITLE_READING_SPEED_TARGET_EXCEEDED',
        message: `Segment ${segment.index + 1} reads at ${speed.toFixed(2)} counted characters per second; this diagnostic does not change the frozen cue.`,
        segment_refs: unique([...segment.asr_segment_refs, ...segment.reference_segment_refs])
      });
    }
  }
  const illegalSegment = segments.find((segment) =>
    countSubtitleCharacters(segment.text) > HARD_MAX_CHARACTERS || lineCount(segment.text) > 2
  );
  if (illegalSegment) {
    return needsInput({
      code: 'CALIBRATED_HARD_LIMIT_INVALID_FOR_FIXED_TIMELINE',
      message: `Calibrated segment ${illegalSegment.subtitle_segment_id} exceeds the 24-character or two-line hard limit while its transcribed cue timeline is frozen.`,
      remediation: 'Keep the transcribed cue timeline unchanged; prepare corrected external transcript text on the same real cue boundaries and create a new request ID.'
    }, alignment);
  }

  populateModificationResults(applied.modifications, segments);
  const artifact: CalibratedTranscript = {
    artifact_version: '1.0.0',
    task_id: transcript.task_id,
    mode: documentMode,
    thresholds_version: SUBTITLE_THRESHOLDS_VERSION,
    source_refs: {
      transcript_ref: 'work/transcript.raw.json',
      calibration_ref: 'work/calibration-result.json',
      reference_srt_ref: expectedReference
    },
    segments,
    modifications: applied.modifications,
    warnings
  };
  return { status: 'completed', alignment, artifact, issues: [] };
}

function resolveMode(
  referenceSrtText: string | null,
  requestedMode: CalibrationMode | null | undefined
): { mode: CalibrationMode | null } | { issue: SubtitleCoreIssue } {
  if (referenceSrtText === null) {
    if (requestedMode !== undefined && requestedMode !== null) {
      return {
        issue: {
          code: 'MODE_REQUIRES_REFERENCE_SRT',
          message: 'Calibration mode cannot be selected without a reference SRT.'
        }
      };
    }
    return { mode: null };
  }
  return { mode: requestedMode ?? 'text-only' };
}

function referenceTimelineIssue(
  segments: ReferenceSrtSegment[],
  audioDurationMs: number
): SubtitleCoreIssue | null {
  for (const [index, segment] of segments.entries()) {
    if (segment.start_ms < 0 || segment.end_ms > audioDurationMs || segment.start_ms >= segment.end_ms) {
      return {
        code: 'REFERENCE_TIMELINE_INVALID_FOR_CALIBRATION_EVIDENCE',
        message: `Reference SRT block ${index + 1} has an invalid or out-of-range timeline.`,
        remediation: 'Provide a reference SRT with ordered, non-overlapping cue times inside the current audio; the transcribed cue timeline will remain unchanged.'
      };
    }
    const previous = segments[index - 1];
    if (previous && segment.start_ms < previous.end_ms) {
      return {
        code: 'REFERENCE_TIMELINE_INVALID_FOR_CALIBRATION_EVIDENCE',
        message: `Reference SRT block ${index + 1} overlaps the previous block.`,
        remediation: 'Provide a reference SRT with ordered, non-overlapping cue times inside the current audio; the transcribed cue timeline will remain unchanged.'
      };
    }
  }
  return null;
}

function validateSuggestionEvidenceBoundary(
  suggestions: CalibrationSuggestion[],
  transcript: TranscriptRaw
): SubtitleCoreIssue | null {
  const segmentById = new Map(transcript.segments.map((segment) => [segment.segment_id, segment]));
  for (const suggestion of suggestions) {
    if (suggestion.kind !== 'text_correction') {
      return {
        code: 'UPSTREAM_SUGGESTION_CUE_MAPPING_INVALID',
        message: `Suggestion ${suggestion.suggestion_id} attempts a structural or timing change while the transcribed cue timeline is frozen.`
      };
    }
    const sourceSegments = suggestion.source_segment_refs.map((reference) => segmentById.get(reference));
    if (suggestion.source_segment_refs.length !== 1) {
      return {
        code: 'UPSTREAM_SUGGESTION_CUE_MAPPING_INVALID',
        message: `Suggestion ${suggestion.suggestion_id} must map to exactly one transcribed cue.`
      };
    }
    if (sourceSegments.some((segment) => segment === undefined)) {
      return {
        code: 'UPSTREAM_SUGGESTION_EVIDENCE_INVALID',
        message: `Suggestion ${suggestion.suggestion_id} references an unknown transcript segment.`
      };
    }
    const resolved = sourceSegments.filter((segment): segment is TranscriptRaw['segments'][number] =>
      segment !== undefined
    );
    if (resolved.some((segment) =>
      suggestion.start_ms >= segment.end_ms || suggestion.end_ms <= segment.start_ms
    )) {
      return {
        code: 'UPSTREAM_SUGGESTION_EVIDENCE_INVALID',
        message: `Suggestion ${suggestion.suggestion_id} does not overlap every referenced transcript segment.`
      };
    }
    const earliestStart = Math.min(...resolved.map((segment) => segment.start_ms));
    const latestEnd = Math.max(...resolved.map((segment) => segment.end_ms));
    if (suggestion.start_ms !== earliestStart || suggestion.end_ms !== latestEnd) {
      return {
        code: 'UPSTREAM_SUGGESTION_CUE_MAPPING_INVALID',
        message: `Suggestion ${suggestion.suggestion_id} must preserve its transcribed cue time range exactly.`
      };
    }
  }
  return null;
}

function applyCalibrationSuggestions(
  initialDocument: DocumentCharacter[],
  suggestions: CalibrationSuggestion[],
  transcript: TranscriptRaw,
  alignment: AlignmentArtifact,
  mode: CalibrationMode | null,
  referenceSegments: ReferenceSrtSegment[] | null,
  nextModificationId: () => string
): AppliedSuggestions {
  let document = initialDocument;
  const modifications: SubtitleModification[] = [];
  const warnings: SubtitleCoreWarning[] = [];
  const hasReference = referenceSegments !== null;

  for (const suggestion of suggestions) {
    const referenceTargetRefs = hasReference
      ? mappedReferenceRefs(alignment, suggestion.source_segment_refs, {
          startMs: suggestion.start_ms,
          endMs: suggestion.end_ms
        })
      : [];
    const documentTargetRefs = unique(suggestion.source_segment_refs);
    const allowedByMode = mode !== 'text-only' || suggestion.kind === 'text_correction';
    const evidenceText = transcriptEvidenceText(transcript, suggestion);
    const placeholder = isExplanationPlaceholder(suggestion.suggested_text, evidenceText);
    const structurallyAllowed = suggestion.disposition_reason !== 'out_of_scope' && !placeholder;
    const replacement = allowedByMode && structurallyAllowed && documentTargetRefs.length > 0
      ? replaceDocumentText(
          document,
          suggestion.original_text,
          suggestion.suggested_text,
          documentTargetRefs,
          mode === 'text-only',
          { startMs: suggestion.start_ms, endMs: suggestion.end_ms }
        )
      : null;
    const applied = replacement !== null;
    if (replacement) document = replacement.document;
    const resolvedTargetRefs = replacement?.sourceRefs ?? (
      hasReference ? referenceTargetRefs : documentTargetRefs
    );

    const asrRefs = unique(suggestion.source_segment_refs);
    const referenceRefs = hasReference ? referenceTargetRefs : [];
    modifications.push({
      modification_id: nextModificationId(),
      type: suggestion.kind === 'text_correction'
        ? 'text_correction'
        : suggestion.kind === 'segmentation'
          ? 'segmentation'
          : 'timing_adjustment',
      original_text: suggestion.original_text,
      original_segment_refs: resolvedTargetRefs,
      replacement_text: suggestion.suggested_text,
      result_segment_refs: [],
      start_ms: suggestion.start_ms,
      end_ms: suggestion.end_ms,
      evidence: {
        asr_segment_refs: asrRefs,
        reference_segment_refs: referenceRefs,
        calibration_suggestion_ref: suggestion.suggestion_id
      },
      reason: applied
        ? suggestion.rationale
        : modificationRejectionReason(
            allowedByMode,
            structurallyAllowed,
            documentTargetRefs.length > 0
          ),
      confidence: suggestion.confidence,
      applied
    });

    if (!applied) {
      warnings.push({
        warning_id: `warning-suggestion-${suggestion.suggestion_id}`,
        code: 'CALIBRATION_SUGGESTION_NOT_APPLIED',
        message: `Suggestion ${suggestion.suggestion_id} was not applied because its source, structure, mode, or original-text location was invalid.`,
        segment_refs: unique([...asrRefs, ...referenceRefs])
      });
      if (placeholder) {
        warnings.push({
          warning_id: `warning-audio-gap-${suggestion.suggestion_id}`,
          code: 'AUDIO_EVIDENCE_GAP',
          message: `Suggestion ${suggestion.suggestion_id} contained an explanatory uncertainty placeholder and was not written to subtitle text.`,
          segment_refs: asrRefs
        });
      }
    } else if (suggestion.confidence === 'low') {
      warnings.push({
        warning_id: `warning-low-confidence-${suggestion.suggestion_id}`,
        code: 'LOW_CONFIDENCE_TEXT_APPLIED',
        message: `Low-confidence suggestion ${suggestion.suggestion_id} was applied because confidence no longer gates structurally valid model text.`,
        segment_refs: asrRefs
      });
    }
  }
  return { document, modifications, warnings };
}

function transcriptTextOnlySegments(
  document: DocumentCharacter[],
  transcript: TranscriptRaw,
  modifications: SubtitleModification[]
): CalibratedSubtitleSegment[] {
  return transcript.segments.map((source, index) => {
    const text = document
      .filter((entry) => entry.sourceRefs.includes(source.segment_id))
      .map((entry) => entry.value)
      .join('');
    const appliedConfidence = modifications
      .filter((modification) => modification.applied && modification.original_segment_refs.includes(source.segment_id))
      .map((modification) => modification.confidence);
    return {
      subtitle_segment_id: subtitleId(index),
      index,
      start_ms: source.start_ms,
      end_ms: source.end_ms,
      text,
      confidence: lowestConfidence(appliedConfidence),
      asr_segment_refs: [source.segment_id],
      reference_segment_refs: [],
    };
  });
}

function visibleSubtitleSegments(
  segments: CalibratedSubtitleSegment[]
): { segments: CalibratedSubtitleSegment[]; removed: number; protected: number } | { issue: SubtitleCoreIssue } {
  let removed = 0;
  let protectedCount = 0;
  const visible = segments.map((segment) => {
    const normalized = normalizeVisibleSubtitleText(segment.text);
    removed += normalized.removed_punctuation_count;
    protectedCount += normalized.protected_span_count;
    return { ...segment, text: normalized.text };
  });
  if (visible.some((segment) => segment.text.length === 0)) {
    return {
      issue: {
        code: 'VISIBLE_SUBTITLE_TEXT_EMPTY',
        message: 'Removing sentence punctuation would leave an empty visible subtitle segment.'
      }
    };
  }
  return { segments: visible, removed, protected: protectedCount };
}

function visibleStyleWarning(
  segments: CalibratedSubtitleSegment[],
  removed: number,
  protectedCount: number
): SubtitleCoreWarning {
  return {
    warning_id: 'warning-visible-subtitle-style-0001',
    code: 'VISIBLE_SENTENCE_PUNCTUATION_SPACED',
    message: `${VISIBLE_SUBTITLE_STYLE_VERSION} replaced ${removed} sentence punctuation characters with collapsed spaces after preserving ${protectedCount} lexical spans.`,
    segment_refs: unique(segments.flatMap((segment) => [...segment.asr_segment_refs, ...segment.reference_segment_refs]))
  };
}

function populateModificationResults(
  modifications: SubtitleModification[],
  segments: CalibratedSubtitleSegment[]
): void {
  for (const modification of modifications) {
    if (!modification.applied || modification.result_segment_refs.length > 0) continue;
    modification.result_segment_refs = segments
      .filter((segment) =>
        segment.asr_segment_refs.some((ref) => modification.evidence.asr_segment_refs.includes(ref)) ||
        segment.reference_segment_refs.some((ref) => modification.evidence.reference_segment_refs.includes(ref))
      )
      .map((segment) => segment.subtitle_segment_id);
  }
}

function alignmentWarnings(alignment: AlignmentArtifact): SubtitleCoreWarning[] {
  return alignment.unaligned_regions.map((region, index) => ({
    warning_id: `warning-alignment-${String(index + 1).padStart(4, '0')}`,
    code: 'LOCAL_ALIGNMENT_GAP',
    message: `${region.side} contains a locally unaligned region inside an overall matching result.`,
    segment_refs: region.segment_refs
  }));
}

function documentFromTranscript(transcript: TranscriptRaw): DocumentCharacter[] {
  return transcript.segments.flatMap((segment) => {
    const characters = [...normalizeCalibrationUnitText(segment.text)];
    const fallbackEvidence = {
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      asrSegmentRefs: [segment.segment_id]
    };
    return characters.map((value) => ({
      value,
      sourceRefs: [segment.segment_id],
      evidence: fallbackEvidence
    }));
  });
}

function replaceDocumentText(
  document: DocumentCharacter[],
  originalText: string,
  replacementText: string,
  eligibleRefs: string[],
  preserveSourceOwnership: boolean,
  requiredTimeRange: { startMs: number; endMs: number } | null
): { document: DocumentCharacter[]; sourceRefs: string[] } | null {
  const needle = [...originalText];
  if (needle.length === 0 || replacementText.trim().length === 0) return null;
  const allowed = new Set(eligibleRefs);
  for (let start = 0; start <= document.length - needle.length; start += 1) {
    const candidate = document.slice(start, start + needle.length);
    if (!candidate.every((entry, index) => entry.value === needle[index])) continue;
    const refs = unique(candidate.flatMap((entry) => entry.sourceRefs));
    if (refs.length === 0 || refs.some((ref) => !allowed.has(ref))) continue;
    const candidateEvidence = candidate
      .map((entry) => entry.evidence)
      .filter((entry): entry is NonNullable<DocumentCharacter['evidence']> => entry !== undefined);
    if (requiredTimeRange !== null && (
      candidateEvidence.length !== candidate.length ||
      Math.min(...candidateEvidence.map((entry) => entry.startMs)) < requiredTimeRange.startMs ||
      Math.max(...candidateEvidence.map((entry) => entry.endMs)) > requiredTimeRange.endMs
    )) {
      continue;
    }
    return {
      document: [
        ...document.slice(0, start),
        ...replacementDocumentCharacters(candidate, replacementText, refs, preserveSourceOwnership),
        ...document.slice(start + needle.length)
      ],
      sourceRefs: refs
    };
  }
  return null;
}

function replacementDocumentCharacters(
  candidate: DocumentCharacter[],
  replacementText: string,
  allSourceRefs: string[],
  preserveSourceOwnership: boolean
): DocumentCharacter[] {
  const replacementCharacters = [...replacementText];
  const sourceIndexes = replacementSourceIndexes(
    candidate.map((entry) => entry.value),
    replacementCharacters
  );
  return replacementCharacters.map((value, index) => {
    const source = candidate[sourceIndexes[index] ?? Math.min(index, candidate.length - 1)]!;
    return {
      value,
      sourceRefs: preserveSourceOwnership ? source.sourceRefs : allSourceRefs,
      ...(source.evidence === undefined ? {} : { evidence: source.evidence })
    };
  });
}

function replacementSourceIndexes(original: string[], replacement: string[]): number[] {
  const distances = Array.from(
    { length: original.length + 1 },
    () => new Uint32Array(replacement.length + 1)
  );
  for (let originalIndex = 0; originalIndex <= original.length; originalIndex += 1) {
    distances[originalIndex]![0] = originalIndex;
  }
  for (let replacementIndex = 0; replacementIndex <= replacement.length; replacementIndex += 1) {
    distances[0]![replacementIndex] = replacementIndex;
  }
  for (let originalIndex = 1; originalIndex <= original.length; originalIndex += 1) {
    for (let replacementIndex = 1; replacementIndex <= replacement.length; replacementIndex += 1) {
      distances[originalIndex]![replacementIndex] = original[originalIndex - 1] === replacement[replacementIndex - 1]
        ? distances[originalIndex - 1]![replacementIndex - 1]!
        : Math.min(
            distances[originalIndex - 1]![replacementIndex - 1]!,
            distances[originalIndex - 1]![replacementIndex]!,
            distances[originalIndex]![replacementIndex - 1]!
          ) + 1;
    }
  }

  const indexes = new Array<number>(replacement.length);
  let originalIndex = original.length;
  let replacementIndex = replacement.length;
  while (replacementIndex > 0) {
    const diagonalCost = originalIndex > 0
      ? distances[originalIndex - 1]![replacementIndex - 1]! +
        (original[originalIndex - 1] === replacement[replacementIndex - 1] ? 0 : 1)
      : Number.POSITIVE_INFINITY;
    if (originalIndex > 0 && distances[originalIndex]![replacementIndex] === diagonalCost) {
      indexes[replacementIndex - 1] = originalIndex - 1;
      originalIndex -= 1;
      replacementIndex -= 1;
      continue;
    }
    const insertionCost = distances[originalIndex]![replacementIndex - 1]! + 1;
    if (distances[originalIndex]![replacementIndex] === insertionCost) {
      indexes[replacementIndex - 1] = Math.max(0, originalIndex - 1);
      replacementIndex -= 1;
      continue;
    }
    originalIndex -= 1;
  }
  return indexes;
}

function modificationRejectionReason(
  mode: boolean,
  structurallyAllowed: boolean,
  mapped: boolean
): string {
  if (!mode) return 'The active text-only mode forbids structural or timing changes.';
  if (!structurallyAllowed) return 'The suggested text contains an out-of-scope or explanatory placeholder structure.';
  if (!mapped) return 'The suggestion does not resolve to aligned source evidence.';
  return 'The suggested original text was not found inside its aligned source segment.';
}

function isExplanationPlaceholder(value: string, evidenceText: string): boolean {
  if (normalizeMatchText(evidenceText).includes(normalizeMatchText(value))) return false;
  return /(?:听不(?:清|见|到)|无法(?:辨认|确认|识别|听清|听见)|不能(?:确认|识别|听清|听见)|未能?识别|不确定|(?:未知|不明)(?:内容|语音)|内容不明|inaudible|unclear|unintelligible|unrecognized|unknown(?: audio| content)?|cannot (?:hear|identify|recognize)|not audible)/iu.test(value) ||
    /(?:修正|建议|翻译|解释|说明)(?:为|后)?\s*[:：]|^(?:here is|translation|corrected)\s*[:：]/iu.test(value);
}

function transcriptEvidenceText(
  transcript: TranscriptRaw,
  suggestion: CalibrationSuggestion
): string {
  const requested = new Set(suggestion.source_segment_refs);
  return transcript.segments
    .filter((segment) => requested.has(segment.segment_id))
    .map((segment) => {
      if (segment.words.length === 0) return segment.text;
      return segment.words
        .filter((word) => word.end_ms > suggestion.start_ms && word.start_ms < suggestion.end_ms)
        .map((word) => word.text)
        .join('');
    })
    .join('');
}

function lowestConfidence(values: Array<'high' | 'medium' | 'low'>): 'high' | 'medium' | 'low' {
  if (values.includes('low')) return 'low';
  if (values.includes('medium') || values.length === 0) return 'medium';
  return 'high';
}

function sequentialId(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${String(++value).padStart(4, '0')}`;
}

function subtitleId(index: number): string {
  return `subtitle-${String(index + 1).padStart(4, '0')}`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function rejected(issue: SubtitleCoreIssue): SubtitleCoreResult {
  return { status: 'rejected', alignment: null, artifact: null, issues: [issue] };
}

function needsInput(issue: SubtitleCoreIssue, alignment: AlignmentArtifact | null): SubtitleCoreResult {
  return { status: 'needs_input', alignment, artifact: null, issues: [issue] };
}

function failed(code: string, message: string, alignment: AlignmentArtifact | null = null): SubtitleCoreResult {
  return { status: 'failed', alignment, artifact: null, issues: [{ code, message }] };
}
