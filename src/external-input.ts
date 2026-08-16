import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExchangeTranscriptV1 } from './contracts/index.js';
import { assertExchangeContract } from './contracts/index.js';
import { MercuryError } from './errors.js';
import { canonicalJson } from './exchange/storage.js';

export type TranscriptInputFormat = 'srt' | 'vtt' | 'transcript_json';
export type TranscriptInputRole = 'transcript_source' | 'reference';

export interface InspectedTranscriptInput {
  absolute_path: string;
  bytes: number;
  sha256: string;
  format: TranscriptInputFormat;
  role: TranscriptInputRole;
  cue_count: number;
  duration_ms: number;
  language: string;
  warnings: string[];
  transcript: ExchangeTranscriptV1;
}

export function serializeTranscriptSrt(transcript: ExchangeTranscriptV1): string {
  const stamp = (ms: number) => {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    const milli = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
  };
  return `${transcript.segments.map((segment, index) => `${index + 1}\n${stamp(segment.start_ms)} --> ${stamp(segment.end_ms)}\n${segment.text}\n`).join('\n')}\n`;
}

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const ZERO_HASH = '0'.repeat(64);

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeText(value: string, label: string): string {
  const normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n').trim();
  if (!normalized || !/\S/u.test(normalized)) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `${label}正文为空。`, { exitCode: 2 });
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `${label}正文包含不安全控制字符。`, { exitCode: 2 });
  }
  if (normalized.length > 10_000) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `${label}正文超过 10,000 字符。`, { exitCode: 2 });
  return normalized;
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  } catch {
    throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '字幕必须是 UTF-8；Mercury 不会猜测或转换其他编码。', { exitCode: 2 });
  }
}

function timestamp(value: string, vtt: boolean): number {
  const pattern = vtt
    ? /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/u
    : /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/u;
  const match = pattern.exec(value.trim());
  if (!match) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `字幕时间戳无效：${value.trim().slice(0, 40)}`, { exitCode: 2 });
  const hours = Number(vtt ? (match[1] ?? '0') : match[1]);
  const minutes = Number(vtt ? match[2] : match[2]);
  const seconds = Number(vtt ? match[3] : match[3]);
  const milliseconds = Number(vtt ? match[4] : match[4]);
  if (minutes > 59 || seconds > 59) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '字幕时间戳分钟或秒超出范围。', { exitCode: 2 });
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + milliseconds;
}

interface ParsedCue { start_ms: number; end_ms: number; text: string; provenance: Record<string, unknown> }

function validateCues(cues: ParsedCue[]): void {
  if (cues.length === 0) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '字幕没有可导入的正文片段。', { exitCode: 2 });
  let previousEnd = -1;
  for (const [index, cue] of cues.entries()) {
    if (cue.start_ms < 0 || cue.end_ms <= cue.start_ms) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `第 ${index + 1} 个片段时间区间无效。`, { exitCode: 2 });
    if (cue.start_ms < previousEnd) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `第 ${index + 1} 个片段与前一片段重叠或倒序。`, { exitCode: 2 });
    previousEnd = cue.end_ms;
  }
}

function parseSrt(source: string): { cues: ParsedCue[]; warnings: string[] } {
  const blocks = source.trim().split(/\n[ \t]*\n+/u).filter((entry) => entry.trim());
  const cues = blocks.map((block, index) => {
    const lines = block.split('\n');
    const hasIdentifier = !lines[0]?.includes('-->');
    const identifier = hasIdentifier ? lines.shift()!.trim() : null;
    const timing = lines.shift() ?? '';
    const match = /^(\S+)\s+-->\s+(\S+)\s*$/u.exec(timing);
    if (!match) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `第 ${index + 1} 个 SRT cue 缺少合法时间行。`, { exitCode: 2 });
    return {
      start_ms: timestamp(match[1]!, false), end_ms: timestamp(match[2]!, false),
      text: safeText(lines.join('\n'), `第 ${index + 1} 个 SRT cue`),
      provenance: { cue_identifier: identifier },
    };
  });
  validateCues(cues);
  return { cues, warnings: [] };
}

function stripVttMarkup(value: string, warnings: string[], cue: number): string {
  if (!/[<&]/u.test(value)) return value;
  const stripped = value
    .replace(/<v(?:\.[^ >]+)*(?:\s+[^>]*)?>/giu, '')
    .replace(/<\/v>/giu, '')
    .replace(/<(?:c|i|b|u|ruby|rt|lang)(?:\.[^ >]+)*(?:\s+[^>]*)?>/giu, '')
    .replace(/<\/(?:c|i|b|u|ruby|rt|lang)>/giu, '')
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&').replace(/&nbsp;/gu, '\u00a0');
  if (/<[^>]*>/u.test(stripped) || /&[a-zA-Z0-9#]+;/u.test(stripped)) {
    throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `第 ${cue} 个 VTT cue 包含不支持的嵌套标记。`, { exitCode: 2 });
  }
  warnings.push(`VTT cue ${cue} 的展示标记已安全移除；原件保持不变。`);
  return stripped;
}

function parseVtt(source: string): { cues: ParsedCue[]; warnings: string[] } {
  const lines = source.split('\n');
  if (!/^WEBVTT(?:[ \t].*)?$/u.test(lines.shift()?.trim() ?? '')) {
    throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', 'VTT 缺少 WEBVTT 标头。', { exitCode: 2 });
  }
  const warnings: string[] = [];
  const cues: ParsedCue[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index]!.trim()) index += 1;
    if (index >= lines.length) break;
    const first = lines[index]!.trim();
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/u.test(first)) {
      const kind = first.split(/\s/u)[0]!;
      warnings.push(`VTT ${kind} 块已作为不可信元数据安全忽略。`);
      index += 1;
      while (index < lines.length && lines[index]!.trim()) index += 1;
      continue;
    }
    const identifier = first.includes('-->') ? null : first;
    if (identifier !== null) index += 1;
    const timing = lines[index++]?.trim() ?? '';
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/u.exec(timing);
    if (!match) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `第 ${cues.length + 1} 个 VTT cue 缺少合法时间行。`, { exitCode: 2 });
    const payload: string[] = [];
    while (index < lines.length && lines[index]!.trim()) payload.push(lines[index++]!);
    cues.push({
      start_ms: timestamp(match[1]!, true), end_ms: timestamp(match[2]!, true),
      text: safeText(stripVttMarkup(payload.join('\n'), warnings, cues.length + 1), `第 ${cues.length + 1} 个 VTT cue`),
      provenance: { cue_identifier: identifier, settings: match[3]?.trim() || null },
    });
  }
  validateCues(cues);
  return { cues, warnings };
}

function normalizedHash(value: ExchangeTranscriptV1): string {
  const copy = structuredClone(value);
  copy.source.normalized_sha256 = ZERO_HASH;
  return hash(canonicalJson(copy));
}

function fromCues(input: {
  cues: ParsedCue[]; warnings: string[]; format: 'srt' | 'vtt'; absolute: string; originalHash: string; createdAt: string;
}): ExchangeTranscriptV1 {
  const segments = input.cues.map((cue, index) => ({
    segment_id: `seg-${hash(`${input.originalHash}\n${index}\n${cue.start_ms}\n${cue.end_ms}\n${cue.text}`).slice(0, 16)}`,
    index, start_ms: cue.start_ms, end_ms: cue.end_ms, text: cue.text, words: [],
  }));
  const transcript = {
    contract: 'mercury.transcript/v1' as const,
    transcript_id: `trn-${hash(`${input.originalHash}\n${input.format}`).slice(0, 24)}`,
    created_at: input.createdAt,
    language: 'zh-CN', duration_ms: segments.at(-1)!.end_ms,
    text: segments.map((entry) => entry.text).join('\n'), segments,
    source: { kind: 'provided' as const, format: input.format, original_path: input.absolute, original_sha256: input.originalHash, normalized_sha256: ZERO_HASH },
    warnings: input.warnings, extensions: {},
  };
  transcript.source.normalized_sha256 = normalizedHash(transcript as unknown as ExchangeTranscriptV1);
  return assertExchangeContract('transcript', transcript);
}

function sanitizeTranscriptJson(raw: unknown, absolute: string, originalHash: string): ExchangeTranscriptV1 {
  if (typeof raw !== 'object' || raw === null) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', 'transcript JSON 顶层必须是对象。', { exitCode: 2 });
  const candidate = structuredClone(raw) as any;
  if (candidate.contract !== 'mercury.transcript/v1') throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', 'JSON 不是 mercury.transcript/v1。', { exitCode: 2 });
  if (!Array.isArray(candidate.segments)) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', 'transcript JSON 缺少 segments。', { exitCode: 2 });
  const warnings = Array.isArray(candidate.warnings) && candidate.warnings.every((entry: unknown) => typeof entry === 'string') ? [...candidate.warnings] : [];
  let dropped = 0;
  let previousEnd = -1;
  candidate.segments = candidate.segments.map((segment: any, index: number) => {
    if (!segment || typeof segment !== 'object' || segment.index !== index || !Number.isSafeInteger(segment.start_ms) || !Number.isSafeInteger(segment.end_ms)
      || segment.start_ms < previousEnd || segment.end_ms <= segment.start_ms || typeof segment.text !== 'string' || !/\S/u.test(segment.text)) {
      throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `transcript JSON 第 ${index + 1} 个 segment 无效。`, { exitCode: 2 });
    }
    previousEnd = segment.end_ms;
    const words = Array.isArray(segment.words) ? segment.words.filter((word: any) => {
      const valid = word && typeof word === 'object' && typeof word.text === 'string' && /\S/u.test(word.text)
        && Number.isSafeInteger(word.start_ms) && Number.isSafeInteger(word.end_ms)
        && word.start_ms >= segment.start_ms && word.end_ms <= segment.end_ms && word.end_ms > word.start_ms
        && (word.confidence === null || (typeof word.confidence === 'number' && word.confidence >= 0 && word.confidence <= 1));
      if (!valid) dropped += 1;
      return valid;
    }) : [];
    const ordered = words.filter((word: any, wordIndex: number) => {
      const valid = wordIndex === 0 || word.start_ms >= words[wordIndex - 1]!.end_ms;
      if (!valid) dropped += 1;
      return valid;
    });
    return { ...segment, text: safeText(segment.text, `第 ${index + 1} 个 segment`), words: ordered };
  });
  const exactText = candidate.segments.map((segment: any) => segment.text).join('\n');
  if (candidate.text !== exactText) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', 'transcript JSON 顶层 text 与 segments 逐行正文不一致。', { exitCode: 2 });
  if (dropped > 0) warnings.push(`已忽略 ${dropped} 个非法或越界 word；合法 segment 仍是权威时间证据。`);
  candidate.source = { kind: 'provided', format: 'transcript_json', original_path: absolute, original_sha256: originalHash, normalized_sha256: ZERO_HASH };
  candidate.warnings = warnings;
  candidate.extensions ??= {};
  candidate.source.normalized_sha256 = normalizedHash(candidate as ExchangeTranscriptV1);
  try { return assertExchangeContract('transcript', candidate); } catch (error) {
    throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', error instanceof Error ? error.message : 'transcript JSON 无效。', { exitCode: 2 });
  }
}

function detectFormat(absolute: string, source: string): TranscriptInputFormat {
  const extension = path.extname(absolute).toLocaleLowerCase('en-US');
  if (/^WEBVTT(?:\s|$)/u.test(source.trimStart())) return 'vtt';
  if (source.trimStart().startsWith('{')) return 'transcript_json';
  if (extension === '.srt') return 'srt';
  throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '无法安全识别输入格式；请显式指定 srt、vtt 或 transcript-json。', { exitCode: 2 });
}

export async function inspectTranscriptInput(options: {
  filePath: string; format: 'auto' | TranscriptInputFormat; role: TranscriptInputRole; now?: () => Date;
}): Promise<InspectedTranscriptInput> {
  if (!path.isAbsolute(options.filePath)) throw new MercuryError('CLI_ARGUMENT_INVALID', '输入文件必须使用绝对路径。', { exitCode: 2 });
  const absolute = path.resolve(options.filePath);
  let entry;
  try { entry = await lstat(absolute); } catch { throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `输入文件不存在：${absolute}`, { exitCode: 2 }); }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', '输入必须是普通文件，不能是目录或符号链接。', { exitCode: 2 });
  if (entry.size < 1 || entry.size > MAX_INPUT_BYTES) throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', `输入文件大小必须为 1–${MAX_INPUT_BYTES} bytes。`, { exitCode: 2 });
  const bytes = await readFile(absolute);
  const source = decodeUtf8(bytes);
  const originalHash = hash(bytes);
  const format = options.format === 'auto' ? detectFormat(absolute, source) : options.format;
  const createdAt = options.now?.().toISOString() ?? (await stat(absolute)).mtime.toISOString();
  let transcript: ExchangeTranscriptV1;
  if (format === 'srt') transcript = fromCues({ ...parseSrt(source), format, absolute, originalHash, createdAt });
  else if (format === 'vtt') transcript = fromCues({ ...parseVtt(source), format, absolute, originalHash, createdAt });
  else {
    let raw: unknown;
    try { raw = JSON.parse(source); } catch { throw new MercuryError('TRANSCRIPT_IMPORT_INVALID', 'transcript JSON 不是合法 JSON。', { exitCode: 2 }); }
    transcript = sanitizeTranscriptJson(raw, absolute, originalHash);
  }
  return {
    absolute_path: absolute, bytes: entry.size, sha256: originalHash, format, role: options.role,
    cue_count: transcript.segments.length, duration_ms: transcript.duration_ms ?? transcript.segments.at(-1)!.end_ms,
    language: transcript.language, warnings: transcript.warnings, transcript,
  };
}
