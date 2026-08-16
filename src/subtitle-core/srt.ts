import type {
  ReferenceSrtSegment,
  SubtitleCoreIssue
} from './types.js';
import { countSubtitleCharacters, lineCount } from './text.js';
import { HARD_MAX_CHARACTERS } from './types.js';

export type ReferenceSrtParseResult =
  | { ok: true; segments: ReferenceSrtSegment[] }
  | { ok: false; issue: SubtitleCoreIssue };

const TIMELINE_PATTERN =
  /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/;

export function parseReferenceSrt(source: string): ReferenceSrtParseResult {
  const normalized = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const blocks = normalized
    .split(/\n[\t ]*\n/u)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) return unparseable('The reference SRT contains no subtitle blocks.');

  const segments: ReferenceSrtSegment[] = [];
  let previousSequence = 0;
  for (const [index, block] of blocks.entries()) {
    const lines = block.split('\n');
    if (lines.length < 3) return unparseable(`Reference SRT block ${index + 1} is incomplete.`);

    const sequenceText = lines[0]?.trim() ?? '';
    if (!/^[1-9][0-9]*$/u.test(sequenceText)) {
      return unparseable(`Reference SRT block ${index + 1} has an invalid sequence number.`);
    }
    const sequence = Number(sequenceText);
    if (!Number.isSafeInteger(sequence) || sequence <= previousSequence) {
      return unparseable('Reference SRT sequence numbers must preserve subtitle text order.');
    }

    const timeline = parseTimeline(lines[1]?.trim() ?? '');
    if (!timeline) return unparseable(`Reference SRT block ${index + 1} has an invalid timeline.`);

    const text = lines.slice(2).join('\n').trim();
    if (text.length === 0) return unparseable(`Reference SRT block ${index + 1} has empty text.`);

    segments.push({
      reference_segment_id: `reference-${String(index + 1).padStart(4, '0')}`,
      sequence,
      ...timeline,
      text
    });
    previousSequence = sequence;
  }

  return { ok: true, segments };
}

export function textOnlyTimelineIssue(
  segments: ReferenceSrtSegment[],
  audioDurationMs: number
): SubtitleCoreIssue | null {
  for (const [index, segment] of segments.entries()) {
    if (countSubtitleCharacters(segment.text) > HARD_MAX_CHARACTERS || lineCount(segment.text) > 2) {
      return needsHardLimitRepair(
        `Reference SRT block ${index + 1} exceeds the 24-character or two-line hard limit.`
      );
    }
    if (segment.start_ms < 0 || segment.end_ms > audioDurationMs || segment.start_ms >= segment.end_ms) {
      return needsSegmentation(`Reference SRT block ${index + 1} has an invalid or out-of-range timeline.`);
    }
    const previous = segments[index - 1];
    if (previous && segment.start_ms < previous.end_ms) {
      return needsSegmentation(`Reference SRT block ${index + 1} overlaps the previous block.`);
    }
  }
  return null;
}

function parseTimeline(value: string): { start_ms: number; end_ms: number } | null {
  const match = TIMELINE_PATTERN.exec(value);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  const [startHours, startMinutes, startSeconds, startMilliseconds,
    endHours, endMinutes, endSeconds, endMilliseconds] = values;
  if (
    values.some((entry) => !Number.isSafeInteger(entry)) ||
    startHours === undefined || startMinutes === undefined || startSeconds === undefined || startMilliseconds === undefined ||
    endHours === undefined || endMinutes === undefined || endSeconds === undefined || endMilliseconds === undefined ||
    startMinutes > 59 || startSeconds > 59 || endMinutes > 59 || endSeconds > 59
  ) {
    return null;
  }
  return {
    start_ms: ((startHours * 60 + startMinutes) * 60 + startSeconds) * 1_000 + startMilliseconds,
    end_ms: ((endHours * 60 + endMinutes) * 60 + endSeconds) * 1_000 + endMilliseconds
  };
}

function unparseable(message: string): ReferenceSrtParseResult {
  return {
    ok: false,
    issue: {
      code: 'REFERENCE_SRT_UNPARSABLE',
      message,
      remediation: 'Provide a valid SRT with ordered sequence numbers, timelines, and non-empty text.'
    }
  };
}

function needsSegmentation(message: string): SubtitleCoreIssue {
  return {
    code: 'REFERENCE_TIMELINE_INVALID_FOR_TEXT_ONLY',
    message,
    remediation: 'Use text-and-segmentation mode or provide a reference SRT with a valid timeline.'
  };
}

function needsHardLimitRepair(message: string): SubtitleCoreIssue {
  return {
    code: 'REFERENCE_HARD_LIMIT_INVALID_FOR_TEXT_ONLY',
    message,
    remediation: 'Use text-and-segmentation mode so the subtitle can be split without changing its content.'
  };
}
