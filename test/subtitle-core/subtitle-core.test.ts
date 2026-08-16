import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  CalibrationResult,
  TranscriptRaw
} from '../../src/contracts/index.js';
import {
  alignTranscriptToReference,
  countSubtitleCharacters,
  mapTextPartsToTranscriptUnits,
  normalizeMatchText,
  parseReferenceSrt,
  runSubtitleCore
} from '../../src/subtitle-core/index.js';

const fixtureDirectory = new URL('../fixtures/valid/', import.meta.url);

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(fileURLToPath(new URL(name, fixtureDirectory)), 'utf8')) as T;
}

async function referenceInput(): Promise<{
  transcript: TranscriptRaw;
  calibrationResult: CalibrationResult;
}> {
  return {
    transcript: await fixture<TranscriptRaw>('transcript.raw.json'),
    calibrationResult: await fixture<CalibrationResult>('calibration-result.json')
  };
}

function referenceSrt(firstText = '欢迎使用水兴'): string {
  return [
    '1',
    '00:00:00,000 --> 00:00:02,500',
    firstText,
    '',
    '2',
    '00:00:02,500 --> 00:00:05,000',
    '字幕工具'
  ].join('\n');
}

function withoutReference(calibration: CalibrationResult): CalibrationResult {
  const result = structuredClone(calibration);
  result.request.reference_srt_ref = null;
  result.request.mode = null;
  return result;
}

async function timedTranscript(characterCount: number, withWords = true): Promise<TranscriptRaw> {
  const transcript = await fixture<TranscriptRaw>('transcript.raw.json');
  const text = Array.from({ length: characterCount }, (_, index) =>
    String.fromCodePoint(0x4e00 + index)
  ).join('');
  transcript.audio.duration_ms = characterCount * 200;
  transcript.full_text = text;
  transcript.segments = [{
    segment_id: 'seg-0001',
    index: 0,
    start_ms: 0,
    end_ms: transcript.audio.duration_ms,
    text,
    confidence: 0.99,
    words: withWords
      ? [...text].map((character, index) => ({
          word_id: `word-${String(index + 1).padStart(4, '0')}`,
          index,
          start_ms: index * 200,
          end_ms: (index + 1) * 200,
          text: character,
          confidence: 0.99
        }))
      : []
  }];
  return transcript;
}

function setTimedText(transcript: TranscriptRaw, text: string, stepMs = 200): void {
  transcript.audio.duration_ms = [...text].length * stepMs;
  transcript.full_text = text;
  transcript.segments = [{
    segment_id: 'seg-0001',
    index: 0,
    start_ms: 0,
    end_ms: transcript.audio.duration_ms,
    text,
    confidence: 0.99,
    words: [...text].map((character, index) => ({
      word_id: `word-${String(index + 1).padStart(4, '0')}`,
      index,
      start_ms: index * stepMs,
      end_ms: (index + 1) * stepMs,
      text: character,
      confidence: 0.99
    }))
  }];
}

describe('reference SRT parsing and comparison primitives', () => {
  it('parses BOM, CRLF, and multiline blocks without changing text order', () => {
    const result = parseReferenceSrt(`\uFEFF1\r\n00:00:00,000 --> 00:00:01,000\r\n第一行\r\n第二行\r\n`);

    expect(result).toEqual({
      ok: true,
      segments: [{
        reference_segment_id: 'reference-0001',
        sequence: 1,
        start_ms: 0,
        end_ms: 1000,
        text: '第一行\n第二行'
      }]
    });
  });

  it.each([
    ['', 'contains no subtitle blocks'],
    ['1\n00:00:00,000 --> 00:00:01,000', 'is incomplete'],
    ['0\n00:00:00,000 --> 00:00:01,000\n字幕', 'invalid sequence'],
    ['1\n00:61:00,000 --> 00:00:01,000\n字幕', 'invalid timeline'],
    ['1\n00:00:00,000 --> 00:00:01,000\n   ', 'incomplete']
  ])('rejects an unparseable SRT (%s)', (source, message) => {
    const result = parseReferenceSrt(source);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.code).toBe('REFERENCE_SRT_UNPARSABLE');
    expect(result.issue.message).toContain(message);
  });

  it('normalizes comparison-only differences and counts subtitle characters by the frozen rule', () => {
    expect(normalizeMatchText('ＡｂＣ， 水星 １２！')).toBe('ABC水星12');
    expect(countSubtitleCharacters('水星 12 Mercury，AI!')).toBe(6);
  });
});

describe('monotonic reference matching', () => {
  it('accepts the exact 80% threshold on both sides and records local gaps', async () => {
    const transcript = await timedTranscript(10);
    transcript.full_text = '一二三四五六七八甲乙';
    transcript.segments[0]!.text = transcript.full_text;
    transcript.segments[0]!.words = [];
    const parsed = parseReferenceSrt('1\n00:00:00,000 --> 00:00:02,000\n一二三四五六七八丙丁');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const alignment = alignTranscriptToReference(transcript, parsed.segments);

    expect(alignment).toMatchObject({
      matched_character_count: 8,
      asr_coverage: 0.8,
      reference_coverage: 0.8,
      threshold: 0.8,
      monotonic: true,
      conclusion: 'matched'
    });
    expect(alignment.unaligned_regions.map((region) => region.side).sort()).toEqual(['asr', 'reference']);
  });

  it('rejects reordered or unrelated content below the dual coverage threshold', async () => {
    const transcript = await timedTranscript(10);
    transcript.full_text = '一二三四五六七八九十';
    transcript.segments[0]!.text = transcript.full_text;
    transcript.segments[0]!.words = [];
    const parsed = parseReferenceSrt('1\n00:00:00,000 --> 00:00:02,000\n十九八七六五四三二一');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(alignTranscriptToReference(transcript, parsed.segments).conclusion).toBe('needs_input');
  });

  it('does not manufacture timing for unmatched normalized characters', async () => {
    const transcript = await timedTranscript(10);
    setTimedText(transcript, '一二三四五六七八甲乙');

    expect(mapTextPartsToTranscriptUnits(transcript, [{
      id: 'reference-0001',
      text: '一二三四五六七八丙丁'
    }])).toBeNull();
  });
});

describe('text-only fidelity', () => {
  it('defaults to text-only and only writes a high-confidence correction inside its original block', async () => {
    const input = await referenceInput();

    const result = runSubtitleCore({
      ...input,
      referenceSrtText: referenceSrt()
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.mode).toBe('text-only');
    expect(result.artifact.segments.map(({ start_ms, end_ms, text }) => ({ start_ms, end_ms, text }))).toEqual([
      { start_ms: 0, end_ms: 2500, text: '欢迎使用水星' },
      { start_ms: 2500, end_ms: 5000, text: '字幕工具' }
    ]);
    expect(result.artifact.modifications).toEqual([
      expect.objectContaining({
        type: 'text_correction',
        original_segment_refs: ['reference-0001'],
        replacement_text: '欢迎使用水星',
        applied: true
      })
    ]);
  });

  it.each(['medium', 'low'] as const)('applies structurally valid model text regardless of %s confidence', async (confidence) => {
    const input = await referenceInput();
    input.calibrationResult.suggestions[0]!.confidence = confidence;

    const result = runSubtitleCore({ ...input, referenceSrtText: referenceSrt() });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments[0]!.text).toBe('欢迎使用水星');
    expect(result.artifact.modifications[0]).toMatchObject({ applied: true, confidence });
    if (confidence === 'low') {
      expect(result.artifact.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'LOW_CONFIDENCE_TEXT_APPLIED' })
      ]));
    }
  });

  it('applies an expanded model correction without a content-similarity gate', async () => {
    const input = await referenceInput();
    input.calibrationResult.suggestions[0]!.suggested_text = '欢迎使用水星，这是一个更好用的字幕工具';

    const result = runSubtitleCore({ ...input, referenceSrtText: referenceSrt() });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments[0]!.text).toBe('欢迎使用水星，这是一个更好用的字幕工具');
    expect(result.artifact.modifications[0]).toMatchObject({ applied: true });
  });

  it('applies a shorter model correction while preserving the time boundary', async () => {
    const input = await referenceInput();
    input.calibrationResult.suggestions[0]!.suggested_text = '水星';

    const result = runSubtitleCore({ ...input, referenceSrtText: referenceSrt() });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments[0]!.text).toBe('水星');
    expect(result.artifact.segments[0]).toMatchObject({ start_ms: 0, end_ms: 2500 });
    expect(result.artifact.modifications[0]).toMatchObject({ applied: true });
  });

  it('uses suggestion time evidence to disambiguate repeated reference text', async () => {
    const input = await referenceInput();
    const text = '一二三四甲乙一二三四甲乙';
    input.transcript.audio.duration_ms = 2400;
    input.transcript.full_text = text;
    input.transcript.segments = [{
      segment_id: 'seg-0001',
      index: 0,
      start_ms: 0,
      end_ms: 2400,
      text,
      confidence: 0.99,
      words: [...text].map((character, index) => ({
        word_id: `word-${String(index + 1).padStart(4, '0')}`,
        index,
        start_ms: index * 200,
        end_ms: (index + 1) * 200,
        text: character,
        confidence: 0.99
      }))
    }];
    input.calibrationResult.suggestions = [{
      ...input.calibrationResult.suggestions[0]!,
      start_ms: 1200,
      end_ms: 2400,
      original_text: '一二三四甲丙',
      suggested_text: '一二三四甲乙'
    }];
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:01,200',
      '一二三四甲丙',
      '',
      '2',
      '00:00:01,200 --> 00:00:02,400',
      '一二三四甲丙'
    ].join('\n');

    const result = runSubtitleCore({ ...input, referenceSrtText: srt });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text)).toEqual([
      '一二三四甲丙',
      '一二三四甲乙'
    ]);
    expect(result.artifact.modifications[0]?.original_segment_refs).toEqual(['reference-0002']);
  });

  it('applies one high-confidence correction across reference blocks and writes each character back to its original block', async () => {
    const input = await referenceInput();
    input.transcript.audio.duration_ms = 1000;
    input.transcript.full_text = '甲乙丙您\n好';
    input.transcript.segments = [
      {
        segment_id: 'seg-0001',
        index: 0,
        start_ms: 0,
        end_ms: 800,
        text: '甲乙丙您',
        confidence: 0.99,
        words: [...'甲乙丙您'].map((text, index) => ({
          word_id: `word-${String(index + 1).padStart(4, '0')}`,
          index,
          start_ms: index * 200,
          end_ms: (index + 1) * 200,
          text,
          confidence: 0.99
        }))
      },
      {
        segment_id: 'seg-0002',
        index: 1,
        start_ms: 800,
        end_ms: 1000,
        text: '好',
        confidence: 0.99,
        words: [{
          word_id: 'word-0005',
          index: 0,
          start_ms: 800,
          end_ms: 1000,
          text: '好',
          confidence: 0.99
        }]
      }
    ];
    input.calibrationResult.suggestions = [{
      ...input.calibrationResult.suggestions[0]!,
      source_segment_refs: ['seg-0001', 'seg-0002'],
      start_ms: 0,
      end_ms: 1000,
      original_text: '甲乙丙你好',
      suggested_text: '甲乙丙您好'
    }];
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:00,800',
      '甲乙丙你',
      '',
      '2',
      '00:00:00,800 --> 00:00:01,000',
      '好'
    ].join('\n');

    const result = runSubtitleCore({ ...input, referenceSrtText: srt });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.alignment).toMatchObject({ asr_coverage: 0.8, reference_coverage: 0.8 });
    expect(result.artifact.segments.map(({ start_ms, end_ms, text }) => ({ start_ms, end_ms, text }))).toEqual([
      { start_ms: 0, end_ms: 800, text: '甲乙丙您' },
      { start_ms: 800, end_ms: 1000, text: '好' }
    ]);
    expect(result.artifact.modifications[0]).toMatchObject({
      original_segment_refs: ['reference-0001', 'reference-0002'],
      replacement_text: '甲乙丙您好',
      applied: true
    });
  });

  it.each([
    ['overlap', '1\n00:00:00,000 --> 00:00:03,000\n欢迎使用水兴\n\n2\n00:00:02,500 --> 00:00:05,000\n字幕工具'],
    ['out of range', '1\n00:00:00,000 --> 00:00:06,000\n欢迎使用水兴字幕工具'],
    ['reversed time', '1\n00:00:03,000 --> 00:00:02,000\n欢迎使用水兴字幕工具']
  ])('returns needs_input for a text-only %s timeline', async (_case, srt) => {
    const input = await referenceInput();

    const result = runSubtitleCore({ ...input, referenceSrtText: srt });

    expect(result.status).toBe('needs_input');
    expect(result.issues[0]).toMatchObject({ code: 'REFERENCE_TIMELINE_INVALID_FOR_TEXT_ONLY' });
    expect(result.issues[0]!.remediation).toContain('text-and-segmentation');
  });

  it.each([
    ['25 counted characters', `${'一'.repeat(25)}`],
    ['three lines', '一二三\n四五六\n七八九']
  ])('returns needs_input when text-only reference text exceeds the %s hard limit', async (_case, text) => {
    const input = await referenceInput();
    const normalizedText = text.replaceAll('\n', '');
    setTimedText(input.transcript, normalizedText);
    input.calibrationResult.suggestions = [];
    const endMs = input.transcript.audio.duration_ms;
    const seconds = String(Math.floor(endMs / 1000)).padStart(2, '0');
    const milliseconds = String(endMs % 1000).padStart(3, '0');
    const srt = `1\n00:00:00,000 --> 00:00:${seconds},${milliseconds}\n${text}`;

    const result = runSubtitleCore({ ...input, referenceSrtText: srt });

    expect(result.status).toBe('needs_input');
    expect(result.issues[0]).toMatchObject({ code: 'REFERENCE_HARD_LIMIT_INVALID_FOR_TEXT_ONLY' });
    expect(result.issues[0]!.remediation).toContain('text-and-segmentation');
  });

  it('does not let an applied text-only correction create a 25-character output block', async () => {
    const input = await referenceInput();
    const referenceText = '一'.repeat(24);
    const asrText = `${referenceText}乙`;
    setTimedText(input.transcript, asrText);
    input.calibrationResult.suggestions = [{
      ...input.calibrationResult.suggestions[0]!,
      start_ms: 0,
      end_ms: input.transcript.audio.duration_ms,
      original_text: referenceText,
      suggested_text: asrText
    }];
    const srt = `1\n00:00:00,000 --> 00:00:05,000\n${referenceText}`;

    const result = runSubtitleCore({ ...input, referenceSrtText: srt });

    expect(result.status).toBe('needs_input');
    expect(result.issues[0]).toMatchObject({ code: 'CALIBRATED_HARD_LIMIT_INVALID_FOR_TEXT_ONLY' });
    expect(result.artifact).toBeNull();
  });
});

describe('segmentation and ASR-backed timeline generation', () => {
  it('keeps sub-range timing distinct when one ASR segment aligns to multiple reference blocks', async () => {
    const input = await referenceInput();
    const transcript = await timedTranscript(40);
    const characters = [...transcript.full_text];
    const first = characters.slice(0, 20).join('');
    const second = characters.slice(20).join('');
    const expanded = `${first}${characters.slice(0, 10).join('')}`;
    const calibrationResult = structuredClone(input.calibrationResult);
    calibrationResult.request.reference_srt_ref = 'input/reference.srt';
    calibrationResult.request.mode = 'text-and-segmentation';
    calibrationResult.suggestions = [{
      ...calibrationResult.suggestions[0]!,
      source_segment_refs: ['seg-0001'],
      start_ms: 0,
      end_ms: 4000,
      original_text: first,
      suggested_text: expanded,
      confidence: 'high'
    }];
    const srt = [
      '1', '00:00:00,000 --> 00:00:04,000', first, '',
      '2', '00:00:04,000 --> 00:00:08,000', second
    ].join('\n');

    const result = runSubtitleCore({
      transcript,
      calibrationResult,
      referenceSrtText: srt,
      requestedMode: 'text-and-segmentation'
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe(`${expanded}${second}`);
    expect(result.artifact.segments.every((segment, index, values) =>
      countSubtitleCharacters(segment.text) <= 24 &&
      (index === 0 || segment.start_ms >= values[index - 1]!.end_ms)
    )).toBe(true);
  });

  it('records an ASR-backed reference correction in text-and-segmentation mode without rewriting ASR evidence', async () => {
    const input = await referenceInput();
    input.calibrationResult.request.mode = 'text-and-segmentation';

    const result = runSubtitleCore({
      ...input,
      referenceSrtText: referenceSrt(),
      requestedMode: 'text-and-segmentation'
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe('欢迎使用水星字幕工具');
    expect(result.artifact.modifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'text_correction',
        original_text: '欢迎使用水兴',
        replacement_text: '欢迎使用水星',
        applied: true
      })
    ]));
    expect(result.artifact.modifications.some((modification) => modification.type === 'omission_recovery')).toBe(false);
  });

  it('segments no-reference text by word timing, preserves all content, and records the split', async () => {
    const input = await referenceInput();
    const transcript = await timedTranscript(30);
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions = [];

    const result = runSubtitleCore({ transcript, calibrationResult, referenceSrtText: null });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.mode).toBeNull();
    expect(result.artifact.segments.length).toBeGreaterThan(1);
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe(transcript.full_text);
    expect(result.artifact.segments.every((segment) => countSubtitleCharacters(segment.text) <= 24)).toBe(true);
    expect(result.artifact.segments.every((segment, index, all) =>
      segment.start_ms >= 0 && segment.start_ms < segment.end_ms &&
      segment.end_ms <= transcript.audio.duration_ms &&
      (index === 0 || segment.start_ms >= all[index - 1]!.end_ms)
    )).toBe(true);
    expect(result.artifact.modifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'split', original_segment_refs: ['seg-0001'], applied: true })
    ]));
  });

  it('assigns punctuation omitted from word timing to adjacent evidence without blocking legal splits', async () => {
    const input = await referenceInput();
    const transcript = await timedTranscript(30);
    const text = '一二三，四五六，七八九，十一二，十三四，十五六，十七八，十九二十';
    const spokenCharacters = [...text].filter((character) => character !== '，');
    transcript.audio.duration_ms = spokenCharacters.length * 200;
    transcript.full_text = text;
    transcript.segments = [{
      segment_id: 'seg-0001', index: 0, start_ms: 0, end_ms: transcript.audio.duration_ms,
      text, confidence: 0.99,
      words: spokenCharacters.map((character, index) => ({
        word_id: `word-${String(index + 1).padStart(4, '0')}`,
        index,
        start_ms: index * 200,
        end_ms: (index + 1) * 200,
        text: character,
        confidence: 0.99
      }))
    }];
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions = [];

    const result = runSubtitleCore({ transcript, calibrationResult, referenceSrtText: null });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.length).toBeGreaterThan(1);
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe(text);
    expect(result.artifact.segments.every((segment) => countSubtitleCharacters(segment.text) <= 24)).toBe(true);
  });

  it('accepts an invalid reference timeline in segmentation mode and rebuilds it from ASR word timing', async () => {
    const input = await referenceInput();
    const transcript = await timedTranscript(30);
    const calibrationResult = structuredClone(input.calibrationResult);
    calibrationResult.request.mode = 'text-and-segmentation';
    calibrationResult.suggestions = [];
    const invalidTimelineSrt = `1\n00:00:09,000 --> 00:00:01,000\n${transcript.full_text}`;

    const result = runSubtitleCore({
      transcript,
      calibrationResult,
      referenceSrtText: invalidTimelineSrt,
      requestedMode: 'text-and-segmentation'
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe(transcript.full_text);
    expect(result.artifact.segments[0]).toMatchObject({ start_ms: 0 });
    expect(result.artifact.modifications.map((modification) => modification.type)).toEqual(
      expect.arrayContaining(['split', 'timing_adjustment'])
    );
  });

  it('keeps a fully returned reference unit authoritative at exactly 80% alignment', async () => {
    const input = await referenceInput();
    setTimedText(input.transcript, '一二三四五六七八甲乙');
    input.calibrationResult.request.mode = 'text-and-segmentation';
    input.calibrationResult.suggestions = [];
    const srt = '1\n00:00:00,000 --> 00:00:02,000\n一二三四五六七八丙丁';

    const result = runSubtitleCore({
      ...input,
      referenceSrtText: srt,
      requestedMode: 'text-and-segmentation'
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.alignment).toMatchObject({
      asr_coverage: 0.8,
      reference_coverage: 0.8,
      conclusion: 'matched'
    });
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe('一二三四五六七八丙丁');
    expect(result.artifact.warnings.filter((warning) => warning.code === 'LOCAL_ALIGNMENT_GAP')).toHaveLength(2);
    expect(result.artifact.modifications.some((modification) => modification.type === 'omission_recovery')).toBe(false);
  });

  it('does not synthesize omitted text when the complete model response preserves the reference', async () => {
    const input = await referenceInput();
    setTimedText(input.transcript, '一二三四五六七八甲乙');
    input.calibrationResult.request.mode = 'text-and-segmentation';
    input.calibrationResult.suggestions = [];
    const srt = '1\n00:00:00,000 --> 00:00:01,600\n一二三四五六七八';

    const result = runSubtitleCore({
      ...input,
      referenceSrtText: srt,
      requestedMode: 'text-and-segmentation'
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.alignment).toMatchObject({ asr_coverage: 0.8, reference_coverage: 1 });
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe('一二三四五六七八');
  });

  it('fails instead of inventing character-average timing when a timed ASR unit exceeds the hard limit', async () => {
    const input = await referenceInput();
    const transcript = await timedTranscript(25, false);
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions = [];

    const result = runSubtitleCore({ transcript, calibrationResult, referenceSrtText: null });

    expect(result.status).toBe('failed');
    expect(result.issues[0]?.code).toBe('TIMELINE_HARD_LIMIT_UNRESOLVABLE');
  });

  it.each([4, 20])('keeps a faithful legal %i-character ASR unit and reports the soft character target', async (characterCount) => {
    const input = await referenceInput();
    const transcript = await timedTranscript(characterCount, false);
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions = [];

    const result = runSubtitleCore({ transcript, calibrationResult, referenceSrtText: null });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments[0]!.text).toBe(transcript.full_text);
    expect(result.artifact.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SUBTITLE_CHARACTER_TARGET_EXCEEDED',
        message: expect.stringContaining(String(characterCount))
      })
    ]));
  });

  it('applies a bounded low-confidence local correction without a reference and emits a warning', async () => {
    const input = await referenceInput();
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions[0] = {
      ...calibrationResult.suggestions[0]!,
      original_text: '欢迎使用水星',
      suggested_text: '欢迎使用水兴',
      confidence: 'low'
    };

    const result = runSubtitleCore({
      transcript: input.transcript,
      calibrationResult,
      referenceSrtText: null
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toContain('欢迎使用水兴');
    expect(result.artifact.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LOW_CONFIDENCE_TEXT_APPLIED' })
    ]));
  });

  it('applies a structurally valid large replacement without a reference', async () => {
    const input = await referenceInput();
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions[0] = {
      ...calibrationResult.suggestions[0]!,
      original_text: '欢迎使用水星',
      suggested_text: 'Welcome to Mercury',
      confidence: 'high'
    };

    const result = runSubtitleCore({
      transcript: input.transcript,
      calibrationResult,
      referenceSrtText: null
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toContain('Welcome to Mercury');
    expect(result.artifact.modifications[0]).toMatchObject({ applied: true });
  });

  it('applies an arbitrary structurally valid Chinese rewrite without a reference', async () => {
    const input = await referenceInput();
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions[0] = {
      ...calibrationResult.suggestions[0]!,
      original_text: '欢迎使用水星',
      suggested_text: '完全不同',
      confidence: 'high'
    };

    const result = runSubtitleCore({
      transcript: input.transcript,
      calibrationResult,
      referenceSrtText: null
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe('完全不同字幕工具');
    expect(result.artifact.modifications[0]).toMatchObject({ applied: true });
  });

  it('applies a one-character substitution using its source time evidence', async () => {
    const input = await referenceInput();
    setTimedText(input.transcript, '甲');
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions[0] = {
      ...calibrationResult.suggestions[0]!,
      start_ms: 0,
      end_ms: 200,
      original_text: '甲',
      suggested_text: '乙',
      confidence: 'high'
    };

    const result = runSubtitleCore({
      transcript: input.transcript,
      calibrationResult,
      referenceSrtText: null
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe('乙');
    expect(result.artifact.modifications[0]).toMatchObject({ applied: true });
  });

  it.each([
    '听不清',
    '无法识别',
    '听不见',
    '不明内容'
  ])('rejects the uncertainty placeholder %s and records the audio evidence gap', async (placeholder) => {
    const input = await referenceInput();
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions[0] = {
      ...calibrationResult.suggestions[0]!,
      original_text: '欢迎使用水星',
      suggested_text: placeholder,
      confidence: 'high'
    };

    const result = runSubtitleCore({
      transcript: input.transcript,
      calibrationResult,
      referenceSrtText: null
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toContain('欢迎使用水星');
    expect(result.artifact.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AUDIO_EVIDENCE_GAP' })
    ]));
  });

  it('uses word timing to update only the requested repeated occurrence', async () => {
    const input = await referenceInput();
    setTimedText(input.transcript, '甲乙甲乙');
    const calibrationResult = withoutReference(input.calibrationResult);
    calibrationResult.suggestions[0] = {
      ...calibrationResult.suggestions[0]!,
      source_segment_refs: ['seg-0001'],
      start_ms: 400,
      end_ms: 800,
      original_text: '甲乙',
      suggested_text: '甲丙',
      confidence: 'high'
    };

    const result = runSubtitleCore({
      transcript: input.transcript,
      calibrationResult,
      referenceSrtText: null
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text).join('')).toBe('甲乙甲丙');
    expect(result.artifact.modifications[0]).toMatchObject({ start_ms: 400, end_ms: 800, applied: true });
  });
});

describe('D001 artifact boundary failures', () => {
  it('rejects a mode when no reference SRT exists', async () => {
    const input = await referenceInput();
    const calibrationResult = withoutReference(input.calibrationResult);

    const result = runSubtitleCore({
      transcript: input.transcript,
      calibrationResult,
      referenceSrtText: null,
      requestedMode: 'text-only'
    });

    expect(result).toMatchObject({ status: 'rejected', issues: [{ code: 'MODE_REQUIRES_REFERENCE_SRT' }] });
  });

  it('fails closed for an incomplete D004 artifact or mismatched D003/D004 task identity', async () => {
    const input = await referenceInput();
    const failedCalibration = structuredClone(input.calibrationResult);
    failedCalibration.status = 'failed';
    failedCalibration.call.outcome = 'failed';
    failedCalibration.call.error_ref = 'error-test';
    failedCalibration.errors = [{
      error_id: 'error-test',
      code: 'MODEL_CALL_FAILED',
      message: 'The model call failed.',
      stage: 'model_call' as const,
      retryable: true
    }];
    failedCalibration.suggestions = [];

    expect(runSubtitleCore({
      transcript: input.transcript,
      calibrationResult: failedCalibration,
      referenceSrtText: referenceSrt()
    }).issues[0]?.code).toBe('UPSTREAM_CALIBRATION_INVALID');

    const mismatched = structuredClone(input.calibrationResult);
    mismatched.task_id = 'task-002';
    expect(runSubtitleCore({
      transcript: input.transcript,
      calibrationResult: mismatched,
      referenceSrtText: referenceSrt()
    }).issues[0]?.code).toBe('UPSTREAM_ARTIFACT_MISMATCH');
  });

  it.each([
    ['unknown source segment', (calibration: CalibrationResult) => {
      calibration.suggestions[0]!.source_segment_refs = ['seg-9999'];
    }],
    ['out-of-range suggestion time', (calibration: CalibrationResult) => {
      calibration.suggestions[0]!.start_ms = 4000;
      calibration.suggestions[0]!.end_ms = 4500;
    }]
  ])('fails closed for an %s before creating a calibrated artifact', async (_case, mutate) => {
    const input = await referenceInput();
    const calibrationResult = withoutReference(input.calibrationResult);
    mutate(calibrationResult);

    const result = runSubtitleCore({
      transcript: input.transcript,
      calibrationResult,
      referenceSrtText: null
    });

    expect(result).toMatchObject({
      status: 'failed',
      artifact: null,
      issues: [{ code: 'UPSTREAM_SUGGESTION_EVIDENCE_INVALID' }]
    });
  });
});
