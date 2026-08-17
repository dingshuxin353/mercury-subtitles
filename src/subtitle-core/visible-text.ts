export const VISIBLE_SUBTITLE_STYLE_VERSION = 'no-sentence-punctuation-v1' as const;

export interface VisibleSubtitleTextResult {
  text: string;
  removed_punctuation_count: number;
  protected_span_count: number;
}

interface Range {
  start: number;
  end: number;
}

const PROTECTED_PATTERNS = [
  /\b(?:https?:\/\/|www\.)[^\s<>"'“”‘’，。！？；：、（）【】《》]+/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b[vV]?\d+(?:[.,]\d+)+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?\b/gu,
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/gu,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/gu,
  /(?:\b[A-Za-z]\.){2,}/gu,
  /\b(?:e\.g\.|i\.e\.)/giu,
  /\b[A-Za-z]+['’][A-Za-z]+\b/gu,
  /[A-Za-z0-9]+(?:[-_\/+@&#=][A-Za-z0-9]+|[+#]{1,2})+/gu,
] as const;

const URL_CLOSING_DELIMITERS = [
  { open: '(', close: ')' },
  { open: '[', close: ']' },
  { open: '{', close: '}' },
] as const;

function occurrences(value: string, character: string): number {
  return [...value].filter((candidate) => candidate === character).length;
}

function urlProtectedLength(value: string): number {
  let protectedValue = value.replace(/[.,!;:?]+$/gu, '');
  let changed = true;
  while (changed && protectedValue.length > 0) {
    changed = false;
    for (const delimiter of URL_CLOSING_DELIMITERS) {
      if (
        protectedValue.endsWith(delimiter.close) &&
        occurrences(protectedValue, delimiter.close) > occurrences(protectedValue, delimiter.open)
      ) {
        protectedValue = protectedValue.slice(0, -delimiter.close.length).replace(/[.,!;:?]+$/gu, '');
        changed = true;
        break;
      }
    }
  }
  return protectedValue.length;
}

function protectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || !match[0]) continue;
      const protectedLength = pattern === PROTECTED_PATTERNS[0]
        ? urlProtectedLength(match[0])
        : match[0].length;
      if (protectedLength > 0) ranges.push({ start: match.index, end: match.index + protectedLength });
    }
  }
  return ranges.sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce<Range[]>((combined, range) => {
      const previous = combined.at(-1);
      if (previous && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        combined.push({ ...range });
      }
      return combined;
    }, []);
}

function protectedAt(ranges: Range[], start: number, end: number): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end);
}

export function normalizeVisibleSubtitleText(value: string): VisibleSubtitleTextResult {
  const normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n');
  const ranges = protectedRanges(normalized);
  let text = '';
  let removed = 0;
  for (let index = 0; index < normalized.length;) {
    const character = String.fromCodePoint(normalized.codePointAt(index)!);
    const end = index + character.length;
    if (!protectedAt(ranges, index, end) && /[\p{P}…]/u.test(character)) {
      removed += 1;
    } else {
      text += character;
    }
    index = end;
  }
  return {
    text: text.split('\n')
      .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n'),
    removed_punctuation_count: removed,
    protected_span_count: ranges.length,
  };
}
