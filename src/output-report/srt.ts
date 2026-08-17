import { readFile } from 'node:fs/promises';
import type { ReferenceSrtSegment } from '../subtitle-core/index.js';
import {
  SOFT_MAX_DURATION_MS,
  SOFT_MAX_READING_SPEED,
  SOFT_MIN_DURATION_MS,
  HARD_MAX_CHARACTERS,
  TARGET_MAX_CHARACTERS,
  countSubtitleCharacters,
  type CalibratedSubtitleSegment,
  type CalibratedTranscript
} from '../subtitle-core/index.js';
import type {
  ParsedSrtSegment,
  QualityCheck,
  SrtValidationResult
} from './types.js';

const TIMELINE_PATTERN =
  /^(\d{2,}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2,}):(\d{2}):(\d{2}),(\d{3})$/u;
const NATURAL_BREAK_PUNCTUATION = /[，。！？；：、,.!?;:]/u;
const NUMERIC_PART = '[0-9０-９]+(?:[.,，．][0-9０-９]+)*';
const UNIT_PART = '(?:万亿元|亿元|万元|千元|百元|人民币|美元|公里|千米|厘米|毫米|公斤|千克|GB|MB|KB|TB|kg|km|cm|mm|ms|年|月|日|号|时|点|分|秒|周|天|元|圆|角|度|个|次|名|位|米|克|吨|兆|%|％)';
const NUMERIC_UNIT_EXPRESSION = new RegExp(`[￥¥$]?${NUMERIC_PART}(?:\\s?${UNIT_PART})+(?:${NUMERIC_PART}(?:\\s?${UNIT_PART})+)*`, 'giu');

export interface SrtValidationContext {
  audioDurationMs: number;
  expectedSegments: CalibratedSubtitleSegment[];
  mode: CalibratedTranscript['mode'];
  referenceSegments: ReferenceSrtSegment[] | null;
  purpose?: 'calibrated' | 'transcribed';
}

function quality(
  check_id: string,
  status: QualityCheck['status'],
  message: string,
  segment_refs: string[] = []
): QualityCheck {
  return { check_id, status, message, segment_refs };
}

function flattenText(text: string): string {
  return text.replace(/\r?\n/gu, '').trim();
}

function protectedNumericRanges(text: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(NUMERIC_UNIT_EXPRESSION)].map((match) => {
    const prefix = text.slice(0, match.index);
    const start = Array.from(prefix).length;
    return { start, end: start + Array.from(match[0]).length };
  });
}

function safeBreakBoundary(
  characters: string[],
  index: number,
  numericRanges: Array<{ start: number; end: number }>
): boolean {
  const left = characters[index - 1] ?? '';
  const right = characters[index] ?? '';
  if (numericRanges.some((range) => range.start < index && index < range.end)) return false;
  if (/\s/u.test(left) || /\s/u.test(right)) return false;
  if (
    (/^[0-9０-９]$/u.test(left) && /^[.,，．]$/u.test(right)) ||
    (/^[.,，．]$/u.test(left) && /^[0-9０-９]$/u.test(right))
  ) return false;
  if (/^[A-Za-z0-9０-９]$/u.test(left) && /^[A-Za-z0-9０-９]$/u.test(right)) return false;
  return true;
}

function chooseBreak(text: string, requireTargetLimit: boolean): number | null {
  const characters = Array.from(text);
  const numericRanges = protectedNumericRanges(text);
  const ideal = Math.ceil(characters.length / 2);
  let best: { index: number; score: number } | null = null;
  for (let index = 1; index < characters.length; index += 1) {
    const left = characters.slice(0, index).join('').trimEnd();
    const right = characters.slice(index).join('').trimStart();
    if (!left || !right || !safeBreakBoundary(characters, index, numericRanges)) continue;
    if (
      requireTargetLimit &&
      (countSubtitleCharacters(left) > TARGET_MAX_CHARACTERS ||
        countSubtitleCharacters(right) > TARGET_MAX_CHARACTERS)
    ) continue;
    const previous = characters[index - 1] ?? '';
    const natural = NATURAL_BREAK_PUNCTUATION.test(previous) ? 30 : 0;
    const score = natural - Math.abs(index - ideal);
    if (!best || score > best.score) best = { index, score };
  }
  return best?.index ?? null;
}

export function wrapSubtitleText(text: string, mode: CalibratedTranscript['mode']): string[] {
  const flattened = flattenText(text);
  if (countSubtitleCharacters(flattened) <= TARGET_MAX_CHARACTERS) return [flattened];
  const requireTargetLimit = mode !== 'text-only' || countSubtitleCharacters(flattened) <= 36;
  const index = chooseBreak(flattened, requireTargetLimit);
  if (index === null) return [flattened];
  const characters = Array.from(flattened);
  return [
    characters.slice(0, index).join('').trimEnd(),
    characters.slice(index).join('').trimStart()
  ];
}

export function formatSrtTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
}

export function serializeCalibratedSrt(artifact: CalibratedTranscript): string {
  const blocks = artifact.segments.map((segment, index) => {
    const lines = wrapSubtitleText(segment.text, artifact.mode);
    return [
      String(index + 1),
      `${formatSrtTimestamp(segment.start_ms)} --> ${formatSrtTimestamp(segment.end_ms)}`,
      ...lines
    ].join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

function parseTimestamp(match: RegExpMatchArray, offset: number): number | null {
  const hour = Number(match[offset]);
  const minute = Number(match[offset + 1]);
  const second = Number(match[offset + 2]);
  const millisecond = Number(match[offset + 3]);
  if (
    !Number.isSafeInteger(hour) ||
    !Number.isSafeInteger(minute) ||
    !Number.isSafeInteger(second) ||
    !Number.isSafeInteger(millisecond) ||
    minute >= 60 ||
    second >= 60
  ) return null;
  return ((hour * 60 + minute) * 60 + second) * 1_000 + millisecond;
}

function forbiddenSubtitleText(lines: string[]): string | null {
  const text = lines.join('\n');
  if (lines.some((line) => line.length === 0 || line !== line.trim())) return '字幕行不能为空或带有首尾空白。';
  if (lines.some((line) => /[\p{Cc}\p{Cf}]/u.test(line))) return '字幕正文包含禁止的控制或格式字符。';
  if (/<\/?[A-Za-z][^>]*>|\{\\[^}]+\}|\\[NnHh]|```/u.test(text)) {
    return '字幕正文包含样式标签、代码围栏或控制标记。';
  }
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return '字幕正文包含疑似 JSON 残片。';
  }
  return null;
}

export function validateSrtText(source: string, context: SrtValidationContext): SrtValidationResult {
  const checks: QualityCheck[] = [];
  const segments: ParsedSrtSegment[] = [];
  if (source.startsWith('\uFEFF')) checks.push(quality('SRT_UTF8', 'failed', '最终 SRT 不得包含 UTF-8 BOM。'));
  const hasCrLf = source.includes('\r\n');
  const withoutCrLf = source.replaceAll('\r\n', '');
  if (withoutCrLf.includes('\r') || (hasCrLf && withoutCrLf.includes('\n'))) {
    checks.push(quality('SRT_NEWLINES', 'failed', '全文件必须使用一致的 LF 或 CRLF 换行。'));
  }
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.endsWith('\n') || normalized.endsWith('\n\n')) {
    checks.push(quality('SRT_FINAL_NEWLINE', 'failed', '文件末尾必须恰好保留一个换行符。'));
  }
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const blocks = body.length === 0 ? [] : body.split('\n\n');
  if (blocks.length === 0) checks.push(quality('SRT_BLOCKS', 'failed', '最终 SRT 至少包含一个字幕块。'));

  for (const [index, block] of blocks.entries()) {
    const lines = block.split('\n');
    const expectedSequence = index + 1;
    if (lines.length < 3 || lines.length > 4) {
      checks.push(quality('SRT_BLOCK_STRUCTURE', 'failed', `字幕块 ${expectedSequence} 必须包含一行序号、一行时间和一至两行正文。`));
      continue;
    }
    if (lines[0] !== String(expectedSequence)) {
      checks.push(quality('SRT_SEQUENCE', 'failed', `字幕块 ${expectedSequence} 的序号不连续。`));
      continue;
    }
    const timeline = lines[1]?.match(TIMELINE_PATTERN);
    if (!timeline) {
      checks.push(quality('SRT_TIME_FORMAT', 'failed', `字幕块 ${expectedSequence} 的时间格式非法。`));
      continue;
    }
    const start = parseTimestamp(timeline, 1);
    const end = parseTimestamp(timeline, 5);
    if (start === null || end === null) {
      checks.push(quality('SRT_TIME_FORMAT', 'failed', `字幕块 ${expectedSequence} 的时间数值非法。`));
      continue;
    }
    const textLines = lines.slice(2);
    const textIssue = forbiddenSubtitleText(textLines);
    if (textIssue) checks.push(quality('SRT_TEXT', 'failed', `字幕块 ${expectedSequence}：${textIssue}`));
    const text = textLines.join('\n');
    segments.push({ sequence: expectedSequence, start_ms: start, end_ms: end, text, lines: textLines });
  }

  const allBlocksParsed = blocks.length > 0 && segments.length === blocks.length;
  if (allBlocksParsed && !checks.some((check) => check.check_id === 'SRT_SEQUENCE' && check.status === 'failed')) {
    checks.push(quality('SRT_SEQUENCE', 'passed', `序号从 1 到 ${segments.length} 连续。`));
  }
  const timeFormatFailed = checks.some((check) =>
    (check.check_id === 'SRT_TIME_FORMAT' || check.check_id === 'SRT_BLOCK_STRUCTURE') && check.status === 'failed'
  );
  const textFailed = checks.some((check) => check.check_id === 'SRT_TEXT' && check.status === 'failed');
  if (allBlocksParsed && !timeFormatFailed) checks.push(quality('SRT_TIME_FORMAT', 'passed', '全部时间行符合标准毫秒格式。'));
  if (allBlocksParsed && !textFailed) checks.push(quality('SRT_TEXT', 'passed', '全部字幕正文非空且不含控制字符、标签或模型残片。'));
  let timelineFailed = timeFormatFailed;
  for (const [index, segment] of segments.entries()) {
    const expected = context.expectedSegments[index];
    const segmentRef = expected ? [expected.subtitle_segment_id] : [];
    if (segment.start_ms < 0 || segment.start_ms >= segment.end_ms || segment.end_ms > context.audioDurationMs) {
      timelineFailed = true;
      checks.push(quality('SRT_TIMELINE', 'failed', `字幕块 ${segment.sequence} 时间不满足音频范围。`, segmentRef));
    }
    const previous = segments[index - 1];
    if (previous && segment.start_ms < previous.end_ms) {
      timelineFailed = true;
      checks.push(quality('SRT_TIMELINE', 'failed', `字幕块 ${segment.sequence} 与前一片段重叠。`, segmentRef));
    }
    if (segment.lines.length > 2) {
      checks.push(quality('SRT_LINE_COUNT', 'failed', `字幕块 ${segment.sequence} 超过两行。`, segmentRef));
    }
    const segmentCharacters = countSubtitleCharacters(segment.text);
    if (segmentCharacters > HARD_MAX_CHARACTERS && context.purpose !== 'transcribed') {
      checks.push(quality('SRT_HARD_CHARACTER_LIMIT', 'failed', `字幕块 ${segment.sequence} 为 ${segmentCharacters} 个计数字符，超过 24 字硬限制。`, segmentRef));
    }
    for (const [lineIndex, line] of segment.lines.entries()) {
      const count = countSubtitleCharacters(line);
      if (count > TARGET_MAX_CHARACTERS) {
        checks.push(quality(
          'SRT_LINE_LENGTH',
          context.mode === 'text-only' || context.purpose === 'transcribed' ? 'warning' : 'failed',
          `字幕块 ${segment.sequence} 第 ${lineIndex + 1} 行为 ${count} 个计数字符。`,
          segmentRef
        ));
      }
    }
    const duration = segment.end_ms - segment.start_ms;
    if (duration < SOFT_MIN_DURATION_MS || duration > SOFT_MAX_DURATION_MS) {
      checks.push(quality('SRT_DURATION', 'warning', `字幕块 ${segment.sequence} 显示时长为 ${duration} ms。`, segmentRef));
    }
    const speed = duration > 0 ? segmentCharacters / (duration / 1_000) : Number.POSITIVE_INFINITY;
    if (speed > SOFT_MAX_READING_SPEED) {
      checks.push(quality('SRT_READING_SPEED', 'warning', `字幕块 ${segment.sequence} 阅读速度为 ${speed.toFixed(2)} 字/秒。`, segmentRef));
    }
  }
  if (!timelineFailed) checks.push(quality('SRT_TIMELINE', 'passed', '时间顺序、范围和重叠检查通过。'));
  if (!checks.some((check) => check.check_id === 'SRT_LINE_COUNT' && check.status === 'failed') && allBlocksParsed) {
    checks.push(quality('SRT_LINE_COUNT', 'passed', '全部字幕块不超过两行。'));
  }
  if (!checks.some((check) => check.check_id === 'SRT_LINE_LENGTH') && allBlocksParsed) {
    checks.push(quality('SRT_LINE_LENGTH', 'passed', '全部字幕行满足 18 个计数字符目标。'));
  }

  let mappingFailed = segments.length !== context.expectedSegments.length;
  if (mappingFailed) {
    checks.push(quality('SRT_CALIBRATED_MAPPING', 'failed', `SRT 片段数 ${segments.length} 与校准产物 ${context.expectedSegments.length} 不一致。`));
  } else {
    for (const [index, segment] of segments.entries()) {
      const expected = context.expectedSegments[index]!;
      if (
        segment.start_ms !== expected.start_ms ||
        segment.end_ms !== expected.end_ms ||
        flattenText(segment.text) !== flattenText(expected.text)
      ) {
        mappingFailed = true;
        checks.push(quality('SRT_CALIBRATED_MAPPING', 'failed', `字幕块 ${segment.sequence} 无法映射回 ${expected.subtitle_segment_id}。`, [expected.subtitle_segment_id]));
      }
    }
  }
  if (!mappingFailed) checks.push(quality('SRT_CALIBRATED_MAPPING', 'passed', '全部字幕块可映射回校准产物。'));

  if (context.mode === 'text-only' && context.purpose !== 'transcribed') {
    const references = context.referenceSegments;
    let modeFailed = !references || references.length !== segments.length;
    if (!modeFailed && references) {
      modeFailed = references.some((reference, index) => {
        const output = segments[index];
        return !output || output.start_ms !== reference.start_ms || output.end_ms !== reference.end_ms;
      });
    }
    checks.push(quality(
      'SRT_TEXT_ONLY_TIMELINE',
      modeFailed ? 'failed' : 'passed',
      modeFailed ? 'text-only 输出未逐毫秒保持来源时间轴。' : 'text-only 片段数、顺序和时间戳逐毫秒保持不变。'
    ));
  }

  const structuralFailure = checks.some((check) => check.status === 'failed');
  return structuralFailure
    ? { valid: false, segments, checks }
    : { valid: true, segments, checks };
}

export async function validateSrtFile(filePath: string, context: SrtValidationContext): Promise<SrtValidationResult> {
  let bytes: Buffer;
  let source: string;
  try {
    bytes = await readFile(filePath);
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      valid: false,
      segments: [],
      checks: [quality('SRT_UTF8', 'failed', '磁盘 SRT 无法按 UTF-8 解码。')]
    };
  }
  const result = validateSrtText(source, context);
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (hasBom) {
    result.checks.unshift(quality('SRT_UTF8', 'failed', '最终 SRT 的磁盘字节不得包含 UTF-8 BOM。'));
    result.valid = false;
  } else if (!result.checks.some((check) => check.check_id === 'SRT_UTF8')) {
    result.checks.unshift(quality('SRT_UTF8', 'passed', '磁盘 SRT 可按无 BOM UTF-8 解码。'));
  }
  return result;
}
