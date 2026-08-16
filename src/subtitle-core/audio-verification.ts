import type { AudioVerification, VerificationFinding } from '../contracts/index.js';
import type { CalibratedSubtitleSegment, CalibratedTranscript, SubtitleModification } from './types.js';

const EXPLANATION_PLACEHOLDER = /(?:听不清|听不见|无法(?:辨认|确认|识别)|不能确认|不确定|未知内容|不明内容|inaudible|unclear|unrecognized|cannot hear|not audible)/iu;

function characters(value: string): string[] {
  return Array.from(value);
}

function lcsLength(left: string[], right: string[]): number {
  const row = new Array<number>(right.length + 1).fill(0);
  for (const leftCharacter of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const previous = row[index]!;
      row[index] = leftCharacter === right[index - 1]
        ? diagonal + 1
        : Math.max(row[index]!, row[index - 1]!);
      diagonal = previous;
    }
  }
  return row[right.length]!;
}

function hasLocalTextEvidence(currentText: string, suggestedText: string): boolean {
  const current = characters(currentText);
  const suggested = characters(suggestedText);
  if (current.length === 0 || suggested.length === 0 || EXPLANATION_PLACEHOLDER.test(suggestedText)) return false;
  const shared = lcsLength(current, suggested);
  const anchored = shared / Math.max(current.length, suggested.length) >= 0.6
    || (current.length === suggested.length && current.length >= 2 && current.length <= 4 && shared >= current.length - 1);
  return anchored
    && Math.abs(current.length - suggested.length) <= Math.max(2, Math.ceil(current.length * 0.25));
}

function overlappingSegments(segments: CalibratedSubtitleSegment[], finding: VerificationFinding): CalibratedSubtitleSegment[] {
  const sourceRefs = new Set(finding.source_segment_refs ?? []);
  return segments.filter((segment) =>
    segment.start_ms < finding.end_ms &&
    segment.end_ms > finding.start_ms &&
    (sourceRefs.size === 0 || [...segment.asr_segment_refs, ...segment.reference_segment_refs].some((ref) => sourceRefs.has(ref)))
  );
}

function replaceAcrossSegments(
  source: CalibratedSubtitleSegment[],
  currentText: string,
  suggestedText: string
): boolean {
  const document = source.map((segment) => segment.text).join('');
  const first = document.indexOf(currentText);
  if (first < 0 || document.indexOf(currentText, first + currentText.length) >= 0) return false;
  const before = characters(document.slice(0, first));
  const original = characters(currentText);
  const replacement = characters(suggestedText);
  const after = characters(document.slice(first + currentText.length));
  const originalLengths = source.map((segment) => characters(segment.text).length);
  const result = [...before, ...replacement, ...after];
  let cursor = 0;
  for (let index = 0; index < source.length; index += 1) {
    const remainingOriginal = originalLengths.slice(index + 1).reduce((sum, value) => sum + value, 0);
    const length = index === source.length - 1
      ? result.length - cursor
      : Math.max(0, result.length - remainingOriginal - cursor);
    source[index]!.text = result.slice(cursor, cursor + length).join('');
    cursor += length;
  }
  return original.length > 0;
}

export function applyAudioVerificationFindings(
  calibrated: CalibratedTranscript,
  verification: AudioVerification
): { calibrated: CalibratedTranscript; verification: AudioVerification } {
  const updatedTranscript = structuredClone(calibrated);
  const updatedVerification = structuredClone(verification);
  if (updatedVerification.status !== 'completed') return { calibrated: updatedTranscript, verification: updatedVerification };

  for (const application of updatedVerification.application_results) {
    const finding = updatedVerification.findings.find((candidate) => candidate.finding_id === application.finding_ref);
    if (!finding) continue;
    if (finding.kind === 'translation') {
      application.reason = 'translation_out_of_scope';
      continue;
    }
    if (finding.kind !== 'text_correction' || finding.confidence !== 'high' || !finding.suggested_text) {
      application.reason = 'insufficient_evidence';
      continue;
    }
    if (finding.current_text === finding.suggested_text) {
      application.reason = 'no_change';
      continue;
    }
    if (!hasLocalTextEvidence(finding.current_text, finding.suggested_text)) {
      application.reason = 'insufficient_evidence';
      continue;
    }
    const targets = overlappingSegments(updatedTranscript.segments, finding);
    const allowedOriginalRefs = new Set(targets.flatMap((segment) => [
      ...segment.asr_segment_refs,
      ...segment.reference_segment_refs
    ]));
    const findingRefs = finding.source_segment_refs ?? [];
    if (
      targets.length === 0 ||
      findingRefs.some((ref) => !allowedOriginalRefs.has(ref)) ||
      !replaceAcrossSegments(targets, finding.current_text, finding.suggested_text)
    ) {
      application.reason = 'invalid_timeline';
      continue;
    }
    const modificationId = `audio-${finding.finding_id}`;
    const modification: SubtitleModification = {
      modification_id: modificationId,
      type: 'text_correction',
      original_text: finding.current_text,
      original_segment_refs: findingRefs.length > 0 ? [...findingRefs] : [...allowedOriginalRefs],
      replacement_text: finding.suggested_text,
      result_segment_refs: targets.map((segment) => segment.subtitle_segment_id),
      start_ms: finding.start_ms,
      end_ms: finding.end_ms,
      evidence: {
        asr_segment_refs: [...new Set(targets.flatMap((segment) => segment.asr_segment_refs))],
        reference_segment_refs: [...new Set(targets.flatMap((segment) => segment.reference_segment_refs))],
        calibration_suggestion_ref: null
      },
      reason: `Gemini audio verification: ${finding.rationale}`,
      confidence: 'high',
      applied: true
    };
    updatedTranscript.modifications.push(modification);
    application.disposition = 'applied';
    application.reason = 'accepted_by_rules';
    application.modification_ref = modificationId;
  }
  return { calibrated: updatedTranscript, verification: updatedVerification };
}
