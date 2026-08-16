import type { TranscriptRaw } from '../contracts/index.js';
import type {
  AlignmentArtifact,
  AlignmentRelation,
  ReferenceSrtSegment,
  TimedTextUnit,
  UnalignedRegion
} from './types.js';
import { MATCH_COVERAGE_THRESHOLD } from './types.js';

interface NormalizedCharacter {
  value: string;
  segmentRef: string;
  startMs: number;
  endMs: number;
  evidenceKey: string;
}

interface CharacterSequence {
  characters: NormalizedCharacter[];
}

interface Pair {
  left: number;
  right: number;
}

export interface TextPart {
  id: string;
  text: string;
  sourceRefs?: string[];
  evidence?: {
    startMs: number;
    endMs: number;
    asrSegmentRefs: string[];
  };
}

interface DisplayCharacter {
  value: string;
  sourceRefs: string[];
  normalizedIndexes: number[];
  explicitEvidence?: NormalizedCharacter;
  explicitAsrRefs?: string[];
}

export function normalizeMatchText(value: string): string {
  return [...value].flatMap((character) => normalizedCharacters(character)).join('');
}

export function alignTranscriptToReference(
  transcript: TranscriptRaw,
  referenceSegments: ReferenceSrtSegment[]
): AlignmentArtifact {
  const asr = transcriptSequence(transcript);
  const reference = referenceSequence(referenceSegments);
  const pairs = longestCommonSubsequence(
    asr.characters.map((entry) => entry.value),
    reference.characters.map((entry) => entry.value)
  );
  const asrCount = asr.characters.length;
  const referenceCount = reference.characters.length;
  const matchedCount = pairs.length;
  const asrCoverage = coverage(matchedCount, asrCount);
  const referenceCoverage = coverage(matchedCount, referenceCount);
  const matched =
    passesThreshold(matchedCount, asrCount) &&
    passesThreshold(matchedCount, referenceCount);

  return {
    artifact_version: '1.0.0',
    task_id: transcript.task_id,
    asr_units: transcript.segments.map((segment) => ({
      segment_id: segment.segment_id,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      text: segment.text
    })),
    reference_segments: referenceSegments,
    relations: alignmentRelations(pairs, asr, reference),
    unaligned_regions: [
      ...unalignedRegions('asr', asr, new Set(pairs.map((pair) => pair.left))),
      ...unalignedRegions('reference', reference, new Set(pairs.map((pair) => pair.right)))
    ],
    matched_character_count: matchedCount,
    asr_character_count: asrCount,
    reference_character_count: referenceCount,
    asr_coverage: asrCoverage,
    reference_coverage: referenceCoverage,
    threshold: MATCH_COVERAGE_THRESHOLD,
    monotonic: true,
    conclusion: matched ? 'matched' : 'needs_input'
  };
}

export function audioOnlyAlignment(transcript: TranscriptRaw): AlignmentArtifact {
  const asr = transcriptSequence(transcript);
  let offset = 0;
  const relations: AlignmentRelation[] = transcript.segments.map((segment) => {
    const length = [...normalizeMatchText(segment.text)].length;
    const relation: AlignmentRelation = {
      asr_segment_refs: [segment.segment_id],
      reference_segment_refs: [],
      asr_character_range: { start: offset, end: offset + length },
      reference_character_range: { start: 0, end: 0 },
      start_ms: segment.start_ms,
      end_ms: segment.end_ms
    };
    offset += length;
    return relation;
  });
  return {
    artifact_version: '1.0.0',
    task_id: transcript.task_id,
    asr_units: transcript.segments.map((segment) => ({
      segment_id: segment.segment_id,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      text: segment.text
    })),
    reference_segments: null,
    relations,
    unaligned_regions: [],
    matched_character_count: asr.characters.length,
    asr_character_count: asr.characters.length,
    reference_character_count: null,
    asr_coverage: 1,
    reference_coverage: null,
    threshold: MATCH_COVERAGE_THRESHOLD,
    monotonic: true,
    conclusion: 'matched'
  };
}

export function mappedReferenceRefs(
  alignment: AlignmentArtifact,
  asrSegmentRefs: readonly string[],
  timeRange?: { startMs: number; endMs: number }
): string[] {
  const requested = new Set(asrSegmentRefs);
  return unique(
    alignment.relations
      .filter((relation) =>
        relation.asr_segment_refs.some((reference) => requested.has(reference)) &&
        (timeRange === undefined || (
          relation.end_ms > timeRange.startMs && relation.start_ms < timeRange.endMs
        ))
      )
      .flatMap((relation) => relation.reference_segment_refs)
  );
}

export function mappedAsrRefs(
  alignment: AlignmentArtifact,
  referenceSegmentRefs: readonly string[]
): string[] {
  const requested = new Set(referenceSegmentRefs);
  return unique(
    alignment.relations
      .filter((relation) => relation.reference_segment_refs.some((reference) => requested.has(reference)))
      .flatMap((relation) => relation.asr_segment_refs)
  );
}

export function mapTextPartsToTranscriptUnits(
  transcript: TranscriptRaw,
  parts: TextPart[]
): TimedTextUnit[] | null {
  const asr = transcriptSequence(transcript);
  const display: DisplayCharacter[] = [];
  const targetCharacters: NormalizedCharacter[] = [];

  for (const part of parts) {
    const sourceRefs = part.sourceRefs ?? [part.id];
    for (const character of part.text) {
      const displayIndex = display.length;
      const normalizedIndexes: number[] = [];
      for (const normalized of normalizedCharacters(character)) {
        normalizedIndexes.push(targetCharacters.length);
        targetCharacters.push({
          value: normalized,
          segmentRef: part.id,
          startMs: 0,
          endMs: 0,
          evidenceKey: String(displayIndex)
        });
      }
      display.push({
        value: character,
        sourceRefs,
        normalizedIndexes,
        ...(part.evidence === undefined
          ? {}
          : {
              explicitEvidence: {
                value: normalizedCharacters(character)[0] ?? '',
                segmentRef: part.evidence.asrSegmentRefs[0] ?? part.id,
                startMs: part.evidence.startMs,
                endMs: part.evidence.endMs,
                evidenceKey: `${part.evidence.asrSegmentRefs.join('+')}:${part.evidence.startMs}-${part.evidence.endMs}`
              },
              explicitAsrRefs: part.evidence.asrSegmentRefs
            })
      });
    }
  }

  if (display.length === 0 || targetCharacters.length === 0 || asr.characters.length === 0) {
    return null;
  }

  const pairs = longestCommonSubsequence(
    asr.characters.map((entry) => entry.value),
    targetCharacters.map((entry) => entry.value)
  );
  if (pairs.length === 0 && display.some((entry) => entry.explicitEvidence === undefined)) return null;

  const evidenceByTargetIndex = new Map<number, NormalizedCharacter>();
  for (const pair of pairs) {
    const evidence = asr.characters[pair.left];
    if (evidence) evidenceByTargetIndex.set(pair.right, evidence);
  }

  const evidenceByDisplayIndex = new Map<number, NormalizedCharacter>();
  display.forEach((entry, index) => {
    const evidence = entry.explicitEvidence ?? entry.normalizedIndexes
      .map((normalizedIndex) => evidenceByTargetIndex.get(normalizedIndex))
      .find((candidate): candidate is NormalizedCharacter => candidate !== undefined);
    if (evidence) evidenceByDisplayIndex.set(index, evidence);
  });

  for (let index = 0; index < display.length; index += 1) {
    if (evidenceByDisplayIndex.has(index)) continue;
    const entry = display[index]!;
    if (entry.normalizedIndexes.length > 0) return null;
    const previous = nearestEvidence(evidenceByDisplayIndex, index, -1, display.length);
    const next = nearestEvidence(evidenceByDisplayIndex, index, 1, display.length);
    const evidence = previous ?? next;
    if (evidence) evidenceByDisplayIndex.set(index, evidence);
  }

  const units: TimedTextUnit[] = [];
  display.forEach((entry, index) => {
    const evidence = evidenceByDisplayIndex.get(index);
    if (!evidence) return;
    const asrRefs = entry.explicitAsrRefs ?? [evidence.segmentRef];
    const previous = units.at(-1);
    if (
      previous &&
      previous.start_ms === evidence.startMs &&
      previous.end_ms === evidence.endMs &&
      sameValues(previous.asr_segment_refs, asrRefs)
    ) {
      previous.text += entry.value;
      previous.source_segment_refs = unique([...previous.source_segment_refs, ...entry.sourceRefs]);
      return;
    }
    units.push({
      text: entry.value,
      start_ms: evidence.startMs,
      end_ms: evidence.endMs,
      asr_segment_refs: asrRefs,
      source_segment_refs: entry.sourceRefs
    });
  });

  return units.length > 0 ? units : null;
}

function transcriptSequence(transcript: TranscriptRaw): CharacterSequence {
  const characters: NormalizedCharacter[] = [];
  for (const segment of transcript.segments) {
    const segmentCharacters = [...segment.text].flatMap((character) => normalizedCharacters(character));
    const evidence = segmentCharacters.map(() => ({
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      evidenceKey: `${segment.segment_id}:segment`
    }));

    let cursor = 0;
    for (const word of segment.words) {
      const wordCharacters = [...word.text].flatMap((character) => normalizedCharacters(character));
      const start = findSubsequence(segmentCharacters, wordCharacters, cursor);
      if (start < 0) continue;
      for (let index = start; index < start + wordCharacters.length; index += 1) {
        evidence[index] = {
          startMs: word.start_ms,
          endMs: word.end_ms,
          evidenceKey: `${segment.segment_id}:${word.word_id}`
        };
      }
      cursor = start + wordCharacters.length;
    }

    segmentCharacters.forEach((value, index) => {
      const timing = evidence[index]!;
      characters.push({
        value,
        segmentRef: segment.segment_id,
        startMs: timing.startMs,
        endMs: timing.endMs,
        evidenceKey: timing.evidenceKey
      });
    });
  }
  return { characters };
}

function referenceSequence(segments: ReferenceSrtSegment[]): CharacterSequence {
  return {
    characters: segments.flatMap((segment) =>
      [...segment.text].flatMap((character) =>
        normalizedCharacters(character).map((value) => ({
          value,
          segmentRef: segment.reference_segment_id,
          startMs: segment.start_ms,
          endMs: segment.end_ms,
          evidenceKey: segment.reference_segment_id
        }))
      )
    )
  };
}

function alignmentRelations(
  pairs: Pair[],
  left: CharacterSequence,
  right: CharacterSequence
): AlignmentRelation[] {
  const relations: AlignmentRelation[] = [];
  for (const [index, pair] of pairs.entries()) {
    const asr = left.characters[pair.left]!;
    const reference = right.characters[pair.right]!;
    const previousPair = pairs[index - 1];
    const previous = relations.at(-1);
    if (
      previous && previousPair &&
      previousPair.left + 1 === pair.left && previousPair.right + 1 === pair.right &&
      previous.asr_segment_refs[0] === asr.segmentRef &&
      previous.reference_segment_refs[0] === reference.segmentRef
    ) {
      previous.asr_character_range.end = pair.left + 1;
      previous.reference_character_range.end = pair.right + 1;
      previous.start_ms = Math.min(previous.start_ms, asr.startMs);
      previous.end_ms = Math.max(previous.end_ms, asr.endMs);
      continue;
    }
    relations.push({
      asr_segment_refs: [asr.segmentRef],
      reference_segment_refs: [reference.segmentRef],
      asr_character_range: { start: pair.left, end: pair.left + 1 },
      reference_character_range: { start: pair.right, end: pair.right + 1 },
      start_ms: asr.startMs,
      end_ms: asr.endMs
    });
  }
  return relations;
}

function unalignedRegions(
  side: 'asr' | 'reference',
  sequence: CharacterSequence,
  matchedIndexes: Set<number>
): UnalignedRegion[] {
  const regions: UnalignedRegion[] = [];
  let index = 0;
  while (index < sequence.characters.length) {
    if (matchedIndexes.has(index)) {
      index += 1;
      continue;
    }
    const start = index;
    const refs: string[] = [];
    let text = '';
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = 0;
    while (index < sequence.characters.length && !matchedIndexes.has(index)) {
      const character = sequence.characters[index]!;
      refs.push(character.segmentRef);
      text += character.value;
      startMs = Math.min(startMs, character.startMs);
      endMs = Math.max(endMs, character.endMs);
      index += 1;
    }
    regions.push({
      side,
      segment_refs: unique(refs),
      character_range: { start, end: index },
      normalized_text: text,
      start_ms: Number.isFinite(startMs) ? startMs : 0,
      end_ms: endMs
    });
  }
  return regions;
}

function normalizedCharacters(character: string): string[] {
  const codePoint = character.codePointAt(0)!;
  const halfWidth = codePoint === 0x3000
    ? ' '
    : codePoint >= 0xff01 && codePoint <= 0xff5e
      ? String.fromCodePoint(codePoint - 0xfee0)
      : character;
  return [...halfWidth.toUpperCase()].filter((value) => /[\p{L}\p{N}]/u.test(value));
}

function coverage(matched: number, total: number): number {
  return total === 0 ? 0 : matched / total;
}

function passesThreshold(matched: number, total: number): boolean {
  return total > 0 && matched * 10 >= total * 8;
}

function longestCommonSubsequence(left: string[], right: string[]): Pair[] {
  return hirschberg(left, right, 0, 0);
}

function hirschberg(left: string[], right: string[], leftOffset: number, rightOffset: number): Pair[] {
  if (left.length === 0 || right.length === 0) return [];
  if (left.length === 1) {
    const index = right.indexOf(left[0]!);
    return index < 0 ? [] : [{ left: leftOffset, right: rightOffset + index }];
  }

  const midpoint = Math.floor(left.length / 2);
  const leftHead = left.slice(0, midpoint);
  const leftTail = left.slice(midpoint);
  const forward = lcsLengths(leftHead, right);
  const backward = lcsLengths([...leftTail].reverse(), [...right].reverse());
  let split = 0;
  let best = -1;
  for (let index = 0; index <= right.length; index += 1) {
    const score = forward[index]! + backward[right.length - index]!;
    if (score > best) {
      best = score;
      split = index;
    }
  }

  return [
    ...hirschberg(leftHead, right.slice(0, split), leftOffset, rightOffset),
    ...hirschberg(leftTail, right.slice(split), leftOffset + midpoint, rightOffset + split)
  ];
}

function lcsLengths(left: string[], right: string[]): Uint32Array {
  let previous = new Uint32Array(right.length + 1);
  for (const leftCharacter of left) {
    const current = new Uint32Array(right.length + 1);
    for (let index = 1; index <= right.length; index += 1) {
      current[index] = leftCharacter === right[index - 1]
        ? previous[index - 1]! + 1
        : Math.max(previous[index]!, current[index - 1]!);
    }
    previous = current;
  }
  return previous;
}

function findSubsequence(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) return -1;
  for (let index = from; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((value, offset) => haystack[index + offset] === value)) return index;
  }
  return -1;
}

function nearestEvidence(
  evidence: Map<number, NormalizedCharacter>,
  origin: number,
  direction: -1 | 1,
  length: number
): NormalizedCharacter | undefined {
  for (let index = origin + direction; index >= 0 && index < length; index += direction) {
    const candidate = evidence.get(index);
    if (candidate) return candidate;
  }
  return undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
