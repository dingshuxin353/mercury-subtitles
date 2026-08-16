import type {
  CalibrationMode,
  CalibrationSuggestion,
  TranscriptRaw
} from '../contracts/index.js';
import { validateContract } from '../contracts/index.js';
import {
  alignTranscriptToReference,
  audioOnlyAlignment,
  mapTextPartsToTranscriptUnits,
  mappedAsrRefs,
  mappedReferenceRefs,
  normalizeMatchText,
  type TextPart
} from './alignment.js';
import { parseReferenceSrt, textOnlyTimelineIssue } from './srt.js';
import type {
  AlignmentArtifact,
  CalibratedSubtitleSegment,
  CalibratedTranscript,
  ReferenceSrtSegment,
  SubtitleCoreInput,
  SubtitleCoreIssue,
  SubtitleCoreResult,
  SubtitleCoreWarning,
  SubtitleModification,
  TimedTextUnit
} from './types.js';
import { countSubtitleCharacters, lineCount } from './text.js';
import {
  HARD_MAX_CHARACTERS,
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

interface SegmentationResult {
  segments: CalibratedSubtitleSegment[];
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
    if (mode === 'text-only') {
      const issue = textOnlyTimelineIssue(referenceSegments, transcript.audio.duration_ms);
      if (issue) return needsInput(issue, null);
    }
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

  const documentUsesReference = referenceSegments !== null;
  const sourceDocument = documentUsesReference
    ? documentFromReference(referenceSegments ?? [], alignment, transcript)
    : documentFromTranscript(transcript);
  const nextModificationId = sequentialId('modification');
  const applied = applyCalibrationSuggestions(
    sourceDocument,
    calibration.suggestions,
    transcript,
    alignment,
    mode,
    referenceSegments,
    documentUsesReference,
    nextModificationId
  );

  let segments: CalibratedSubtitleSegment[];
  const warnings: SubtitleCoreWarning[] = [
    ...alignmentWarnings(alignment),
    ...applied.warnings
  ];
  if (mode === 'text-only' && referenceSegments) {
    segments = textOnlySegments(applied.document, referenceSegments, transcript, alignment, applied.modifications);
    const illegalSegment = segments.find((segment) =>
      countSubtitleCharacters(segment.text) > HARD_MAX_CHARACTERS || lineCount(segment.text) > 2
    );
    if (illegalSegment) {
      return needsInput({
        code: 'CALIBRATED_HARD_LIMIT_INVALID_FOR_TEXT_ONLY',
        message: `Calibrated segment ${illegalSegment.subtitle_segment_id} exceeds the 24-character or two-line hard limit.`,
        remediation: 'Use text-and-segmentation mode so the corrected text can be split without changing its content.'
      }, alignment);
    }
  } else {
    const parts = documentParts(applied.document);
    const units = mapTextPartsToTranscriptUnits(transcript, parts);
    if (!units) {
      return failed(
        'TIMELINE_EVIDENCE_UNAVAILABLE',
        'The calibrated text could not be mapped to ASR timing evidence.',
        alignment
      );
    }
    const segmented = segmentTimedUnits(units, transcript.audio.duration_ms, applied.modifications);
    if ('issue' in segmented) return failed(segmented.issue.code, segmented.issue.message, alignment);
    segments = segmented.segments;
    warnings.push(...segmented.warnings);
    if (referenceSegments !== null) {
      for (const segment of segments) {
        segment.reference_segment_refs = mappedReferenceRefs(alignment, segment.asr_segment_refs, {
          startMs: segment.start_ms,
          endMs: segment.end_ms
        });
      }
      addAsrGapModifications(applied.modifications, segments, alignment, nextModificationId);
    }
    addStructuralModifications(
      applied.modifications,
      segments,
      referenceSegments,
      transcript,
      nextModificationId
    );
  }

  populateModificationResults(applied.modifications, segments);
  const artifact: CalibratedTranscript = {
    artifact_version: '1.0.0',
    task_id: transcript.task_id,
    mode,
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

function validateSuggestionEvidenceBoundary(
  suggestions: CalibrationSuggestion[],
  transcript: TranscriptRaw
): SubtitleCoreIssue | null {
  const segmentById = new Map(transcript.segments.map((segment) => [segment.segment_id, segment]));
  for (const suggestion of suggestions) {
    const sourceSegments = suggestion.source_segment_refs.map((reference) => segmentById.get(reference));
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
    if (suggestion.start_ms < earliestStart || suggestion.end_ms > latestEnd) {
      return {
        code: 'UPSTREAM_SUGGESTION_EVIDENCE_INVALID',
        message: `Suggestion ${suggestion.suggestion_id} has a time range outside its transcript evidence.`
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
  documentUsesReference: boolean,
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
    const documentTargetRefs = documentUsesReference
      ? referenceTargetRefs
      : unique(suggestion.source_segment_refs);
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
          documentUsesReference ? null : { startMs: suggestion.start_ms, endMs: suggestion.end_ms }
        )
      : null;
    const applied = replacement !== null;
    if (replacement) document = replacement.document;
    const resolvedTargetRefs = replacement?.sourceRefs ?? (
      hasReference ? referenceTargetRefs : documentTargetRefs
    );

    const asrRefs = unique(suggestion.source_segment_refs);
    const referenceRefs = hasReference ? resolvedTargetRefs : [];
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

function textOnlySegments(
  document: DocumentCharacter[],
  referenceSegments: ReferenceSrtSegment[],
  transcript: TranscriptRaw,
  alignment: AlignmentArtifact,
  modifications: SubtitleModification[]
): CalibratedSubtitleSegment[] {
  return referenceSegments.map((reference, index) => {
    const text = document
      .filter((entry) => entry.sourceRefs.includes(reference.reference_segment_id))
      .map((entry) => entry.value)
      .join('');
    const asrRefs = mappedAsrRefs(alignment, [reference.reference_segment_id]);
    const appliedConfidence = modifications
      .filter((modification) =>
        modification.applied && modification.original_segment_refs.includes(reference.reference_segment_id)
      )
      .map((modification) => modification.confidence);
    return {
      subtitle_segment_id: subtitleId(index),
      index,
      start_ms: reference.start_ms,
      end_ms: reference.end_ms,
      text,
      confidence: lowestConfidence(appliedConfidence),
      asr_segment_refs: asrRefs.length > 0 ? asrRefs : transcript.segments
        .filter((segment) => segment.end_ms > reference.start_ms && segment.start_ms < reference.end_ms)
        .map((segment) => segment.segment_id),
      reference_segment_refs: [reference.reference_segment_id]
    };
  });
}

function segmentTimedUnits(
  units: TimedTextUnit[],
  audioDurationMs: number,
  modifications: SubtitleModification[]
): SegmentationResult | { issue: SubtitleCoreIssue } {
  const usable = units.filter((unit) => unit.text.trim().length > 0);
  if (usable.length === 0) {
    return { issue: { code: 'CALIBRATED_TEXT_EMPTY', message: 'No usable calibrated subtitle text remains.' } };
  }

  const groups: TimedTextUnit[][] = [];
  let current: TimedTextUnit[] = [];
  for (const unit of usable) {
    if (
      unit.start_ms < 0 || unit.end_ms <= unit.start_ms || unit.end_ms > audioDurationMs ||
      countSubtitleCharacters(unit.text) > HARD_MAX_CHARACTERS
    ) {
      return {
        issue: {
          code: 'TIMELINE_HARD_LIMIT_UNRESOLVABLE',
          message: 'ASR timing evidence cannot produce a legal segment within the 24-character hard limit.'
        }
      };
    }
    if (current.length > 0 && shouldBreak(current, unit)) {
      groups.push(current);
      current = [];
    }
    current.push(unit);
    const currentText = joinedUnitText(current);
    if (countSubtitleCharacters(currentText) > HARD_MAX_CHARACTERS) {
      return {
        issue: {
          code: 'TIMELINE_HARD_LIMIT_UNRESOLVABLE',
          message: 'Overlapping ASR evidence would require a subtitle longer than 24 counted characters.'
        }
      };
    }
  }
  if (current.length > 0) groups.push(current);

  const warnings: SubtitleCoreWarning[] = [];
  const segments = groups.map((group, index): CalibratedSubtitleSegment => {
    const startMs = Math.min(...group.map((entry) => entry.start_ms));
    const endMs = Math.max(...group.map((entry) => entry.end_ms));
    const text = joinedUnitText(group).replaceAll(/\s*\n\s*/gu, ' ').trim();
    const count = countSubtitleCharacters(text);
    const duration = endMs - startMs;
    const speed = duration > 0 ? count / (duration / 1_000) : Number.POSITIVE_INFINITY;
    const refs = unique(group.flatMap((entry) => entry.source_segment_refs));
    if (count < TARGET_MIN_CHARACTERS || count > TARGET_MAX_CHARACTERS) {
      warnings.push({
        warning_id: `warning-character-target-${String(index + 1).padStart(4, '0')}`,
        code: 'SUBTITLE_CHARACTER_TARGET_EXCEEDED',
        message: `Segment ${index + 1} contains ${count} counted characters; the soft target is 8–18.`,
        segment_refs: refs
      });
    }
    if (duration < SOFT_MIN_DURATION_MS || duration > SOFT_MAX_DURATION_MS) {
      warnings.push({
        warning_id: `warning-duration-target-${String(index + 1).padStart(4, '0')}`,
        code: 'SUBTITLE_DURATION_TARGET_EXCEEDED',
        message: `Segment ${index + 1} lasts ${duration} ms; the soft target is 800–6,000 ms.`,
        segment_refs: refs
      });
    }
    if (speed > SOFT_MAX_READING_SPEED) {
      warnings.push({
        warning_id: `warning-reading-speed-${String(index + 1).padStart(4, '0')}`,
        code: 'SUBTITLE_READING_SPEED_TARGET_EXCEEDED',
        message: `Segment ${index + 1} reads at ${speed.toFixed(2)} counted characters per second; the soft maximum is 12.`,
        segment_refs: refs
      });
    }
    const confidence = lowestConfidence(
      modifications
        .filter((modification) => modification.applied && modification.evidence.asr_segment_refs.some((ref) =>
          group.some((entry) => entry.asr_segment_refs.includes(ref))
        ))
        .map((modification) => modification.confidence)
    );
    return {
      subtitle_segment_id: subtitleId(index),
      index,
      start_ms: startMs,
      end_ms: endMs,
      text,
      confidence,
      asr_segment_refs: unique(group.flatMap((entry) => entry.asr_segment_refs)),
      reference_segment_refs: unique(group.flatMap((entry) => entry.source_segment_refs).filter((ref) => ref.startsWith('reference-')))
    };
  });

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]!.start_ms < segments[index - 1]!.end_ms) {
      return { issue: { code: 'TIMELINE_OVERLAP', message: 'ASR evidence produced overlapping subtitle segments.' } };
    }
  }
  return { segments, warnings };
}

function shouldBreak(current: TimedTextUnit[], next: TimedTextUnit): boolean {
  const text = joinedUnitText(current);
  const combined = `${text}${next.text}`;
  const currentEnd = Math.max(...current.map((entry) => entry.end_ms));
  const currentStart = Math.min(...current.map((entry) => entry.start_ms));
  const canSeparate = next.start_ms >= currentEnd;
  if (!canSeparate) return false;
  if (countSubtitleCharacters(combined) > HARD_MAX_CHARACTERS) return true;
  if (currentEnd - currentStart >= SOFT_MAX_DURATION_MS) return true;
  return countSubtitleCharacters(text) >= TARGET_MIN_CHARACTERS && (
    /[。！？!?；;]$/u.test(text.trim()) ||
    countSubtitleCharacters(combined) > TARGET_MAX_CHARACTERS
  );
}

function addStructuralModifications(
  modifications: SubtitleModification[],
  segments: CalibratedSubtitleSegment[],
  referenceSegments: ReferenceSrtSegment[] | null,
  transcript: TranscriptRaw,
  nextModificationId: () => string
): void {
  const sourceSegments = referenceSegments ?? transcript.segments.map((segment) => ({
    reference_segment_id: segment.segment_id,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    text: segment.text
  }));
  const sourceId = (segment: (typeof sourceSegments)[number]) => segment.reference_segment_id;

  for (const source of sourceSegments) {
    const outputs = segments.filter((segment) =>
      [...segment.reference_segment_refs, ...segment.asr_segment_refs].includes(sourceId(source))
    );
    if (outputs.length > 1) {
      modifications.push(structuralModification(
        nextModificationId(), 'split', source.text, [sourceId(source)], outputs,
        source.start_ms, source.end_ms, 'ASR timing and subtitle hard limits require a traceable split.'
      ));
    }
  }

  for (const segment of segments) {
    const refs = referenceSegments ? segment.reference_segment_refs : segment.asr_segment_refs;
    if (refs.length > 1) {
      const originals = sourceSegments.filter((source) => refs.includes(sourceId(source)));
      modifications.push(structuralModification(
        nextModificationId(), 'merge', originals.map((source) => source.text).join(''), refs, [segment],
        Math.min(...originals.map((source) => source.start_ms)),
        Math.max(...originals.map((source) => source.end_ms)),
        'Adjacent source units were merged at an ASR-backed semantic boundary.'
      ));
    }
    if (referenceSegments && refs.length > 0) {
      const originals = referenceSegments.filter((source) => refs.includes(source.reference_segment_id));
      const originalStart = Math.min(...originals.map((source) => source.start_ms));
      const originalEnd = Math.max(...originals.map((source) => source.end_ms));
      if (segment.start_ms !== originalStart || segment.end_ms !== originalEnd) {
        modifications.push(structuralModification(
          nextModificationId(), 'timing_adjustment', originals.map((source) => source.text).join(''), refs, [segment],
          originalStart, originalEnd, 'The rebuilt timeline follows monotonic ASR timing evidence.'
        ));
      }
    }
  }
}

function addAsrGapModifications(
  modifications: SubtitleModification[],
  segments: CalibratedSubtitleSegment[],
  alignment: AlignmentArtifact,
  nextModificationId: () => string
): void {
  for (const region of alignment.unaligned_regions.filter((entry) => entry.side === 'asr')) {
    const previousRelation = alignment.relations
      .filter((relation) => relation.asr_character_range.end <= region.character_range.start)
      .sort((left, right) => right.asr_character_range.end - left.asr_character_range.end)[0];
    const nextRelation = alignment.relations
      .filter((relation) => relation.asr_character_range.start >= region.character_range.end)
      .sort((left, right) => left.asr_character_range.start - right.asr_character_range.start)[0];
    const referenceSlotStart = previousRelation?.reference_character_range.end ?? 0;
    const referenceSlotEnd = nextRelation?.reference_character_range.start ??
      alignment.reference_character_count ?? referenceSlotStart;
    const replacementGap = alignment.unaligned_regions.some((candidate) =>
      candidate.side === 'reference' &&
      candidate.character_range.start < referenceSlotEnd &&
      candidate.character_range.end > referenceSlotStart
    );
    if (replacementGap) continue;

    const referenceRefs = unique([
      ...(previousRelation?.reference_segment_refs ?? []),
      ...(nextRelation?.reference_segment_refs ?? [])
    ]);
    const outputs = segments.filter((segment) =>
      segment.end_ms > region.start_ms && segment.start_ms < region.end_ms &&
      segment.asr_segment_refs.some((reference) => region.segment_refs.includes(reference))
    );
    modifications.push({
      modification_id: nextModificationId(),
      type: 'omission_recovery',
      original_text: '',
      original_segment_refs: referenceRefs,
      replacement_text: region.normalized_text,
      result_segment_refs: outputs.map((segment) => segment.subtitle_segment_id),
      start_ms: region.start_ms,
      end_ms: region.end_ms,
      evidence: {
        asr_segment_refs: region.segment_refs,
        reference_segment_refs: referenceRefs,
        calibration_suggestion_ref: null
      },
      reason: 'ASR timing evidence contains spoken content that is absent from the aligned reference text.',
      confidence: 'high',
      applied: true
    });
  }
}

function structuralModification(
  id: string,
  type: 'split' | 'merge' | 'timing_adjustment',
  originalText: string,
  originalRefs: string[],
  outputs: CalibratedSubtitleSegment[],
  startMs: number,
  endMs: number,
  reason: string
): SubtitleModification {
  return {
    modification_id: id,
    type,
    original_text: originalText,
    original_segment_refs: originalRefs,
    replacement_text: outputs.map((segment) => segment.text).join(''),
    result_segment_refs: outputs.map((segment) => segment.subtitle_segment_id),
    start_ms: startMs,
    end_ms: endMs,
    evidence: {
      asr_segment_refs: unique(outputs.flatMap((segment) => segment.asr_segment_refs)),
      reference_segment_refs: unique(outputs.flatMap((segment) => segment.reference_segment_refs)),
      calibration_suggestion_ref: null
    },
    reason,
    confidence: 'high',
    applied: true
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

function documentFromReference(
  referenceSegments: ReferenceSrtSegment[],
  alignment: AlignmentArtifact,
  transcript: TranscriptRaw
): DocumentCharacter[] {
  const transcriptDocument = documentFromTranscript(transcript);
  return referenceSegments.flatMap((segment) => {
    const asrRefs = mappedAsrRefs(alignment, [segment.reference_segment_id]);
    const relations = alignment.relations.filter((relation) =>
      relation.reference_segment_refs.includes(segment.reference_segment_id)
    );
    const evidenceCharacters = transcriptDocument.filter((character) => {
      if (
        !character.evidence ||
        !character.sourceRefs.some((reference) => asrRefs.includes(reference))
      ) return false;
      const midpoint = (character.evidence.startMs + character.evidence.endMs) / 2;
      return relations.some((relation) =>
        relation.asr_segment_refs.some((reference) =>
          character.evidence!.asrSegmentRefs.includes(reference)
        ) && midpoint >= relation.start_ms && midpoint <= relation.end_ms
      );
    });
    const characters = [...segment.text];
    return characters.map((value, index) => {
      const evidence = evidenceCharacters.length === 0
        ? undefined
        : evidenceCharacters[
            Math.min(
              evidenceCharacters.length - 1,
              Math.floor((index * evidenceCharacters.length) / Math.max(1, characters.length))
            )
          ]?.evidence;
      return {
      value,
      sourceRefs: [segment.reference_segment_id],
      ...(evidence === undefined ? {} : { evidence })
      };
    });
  });
}

function documentFromTranscript(transcript: TranscriptRaw): DocumentCharacter[] {
  return transcript.segments.flatMap((segment) => {
    const characters = [...segment.text];
    const fallbackEvidence = {
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      asrSegmentRefs: [segment.segment_id]
    };
    const evidence: Array<typeof fallbackEvidence | undefined> = characters.map(() => undefined);
    let cursor = 0;
    for (const word of segment.words) {
      const wordCharacters = [...word.text];
      const start = findCharacterSubsequence(characters, wordCharacters, cursor);
      if (start < 0) continue;
      for (let index = start; index < start + wordCharacters.length; index += 1) {
        evidence[index] = {
          startMs: word.start_ms,
          endMs: word.end_ms,
          asrSegmentRefs: [segment.segment_id]
        };
      }
      cursor = start + wordCharacters.length;
    }
    let previousEvidence: typeof fallbackEvidence | undefined;
    for (let index = 0; index < evidence.length; index += 1) {
      if (evidence[index]) previousEvidence = evidence[index];
      else if (previousEvidence) evidence[index] = previousEvidence;
    }
    let nextEvidence: typeof fallbackEvidence | undefined;
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      if (evidence[index]) nextEvidence = evidence[index];
      else if (nextEvidence) evidence[index] = nextEvidence;
    }
    return characters.map((value, index) => ({
      value,
      sourceRefs: [segment.segment_id],
      evidence: evidence[index] ?? fallbackEvidence
    }));
  });
}

function documentParts(document: DocumentCharacter[]): TextPart[] {
  const parts: TextPart[] = [];
  for (const character of document) {
    const id = character.sourceRefs[0];
    if (!id) continue;
    const previous = parts.at(-1);
    if (
      previous &&
      sameValues(previous.sourceRefs ?? [previous.id], character.sourceRefs) &&
      sameEvidence(previous.evidence, character.evidence)
    ) {
      previous.text += character.value;
    } else {
      parts.push({
        id,
        text: character.value,
        sourceRefs: character.sourceRefs,
        ...(character.evidence === undefined ? {} : { evidence: character.evidence })
      });
    }
  }
  return parts;
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

function joinedUnitText(units: TimedTextUnit[]): string {
  return units.map((unit) => unit.text).join('');
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

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameEvidence(
  left: TextPart['evidence'],
  right: DocumentCharacter['evidence']
): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined;
  return left.startMs === right.startMs && left.endMs === right.endMs &&
    sameValues(left.asrSegmentRefs, right.asrSegmentRefs);
}

function findCharacterSubsequence(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) return -1;
  for (let index = from; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((value, offset) => haystack[index + offset] === value)) return index;
  }
  return -1;
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
