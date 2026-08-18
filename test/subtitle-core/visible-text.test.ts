import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { CalibrationResult, TranscriptRaw } from '../../src/contracts/index.js';
import {
  normalizeVisibleSubtitleText,
  runSubtitleCore,
  VISIBLE_SUBTITLE_STYLE_VERSION,
} from '../../src/subtitle-core/index.js';

describe('V03-F018 visible subtitle style', () => {
  it.each([
    ['你好，世界！', '你好 世界'],
    ['版本 3.0，使用 B-roll。', '版本 3.0 使用 B-roll'],
    ['访问 https://example.com/a?x=1。', '访问 https://example.com/a?x=1'],
    ['访问 https://example.com/a.', '访问 https://example.com/a'],
    ['U.S. 版本，价格 1,000 元。', 'U.S. 版本 价格 1,000 元'],
    ['v0.3.0-alpha.2：A/B、C++。', 'v0.3.0-alpha.2 A/B C++'],
    ["don't，C#！", "don't C#"],
    ['“你好”（世界）', '你好 世界'],
    ['你好，，  世界！！', '你好 世界'],
  ])('replaces sentence punctuation with one space while preserving lexical spans: %s', (source, expected) => {
    const result = normalizeVisibleSubtitleText(source);
    expect(result.text).toBe(expected);
    expect(result.removed_punctuation_count).toBeGreaterThan(0);
    expect(VISIBLE_SUBTITLE_STYLE_VERSION).toBe('sentence-punctuation-as-space-v2');
  });

  it('returns an empty visible value when a segment contains punctuation only', () => {
    expect(normalizeVisibleSubtitleText('，。！？').text).toBe('');
  });

  it.each([
    ['(https://example.com/a)', 'https://example.com/a'],
    ['[https://example.com/a]', 'https://example.com/a'],
    ['“https://example.com/a”', 'https://example.com/a'],
    ["'https://example.com/a'", 'https://example.com/a'],
    ['访问 https://example.com/a).', '访问 https://example.com/a'],
    ['访问 https://example.com/a?x=1#fragment。', '访问 https://example.com/a?x=1#fragment'],
    ['http://[::1]/a。', 'http://[::1]/a'],
    ['https://en.wikipedia.org/wiki/Function_(mathematics)。', 'https://en.wikipedia.org/wiki/Function_(mathematics)'],
    ['https://example.com/a?x=(1)#top。', 'https://example.com/a?x=(1)#top'],
    ['https://example.com/a)]}。', 'https://example.com/a'],
  ])('protects only the URL body and removes surrounding separators: %s', (source, expected) => {
    expect(normalizeVisibleSubtitleText(source).text).toBe(expected);
  });
});

describe('V03-F018 frozen transcribed cue segmentation', () => {
  async function validFixture<T>(name: string): Promise<T> {
    return JSON.parse(await readFile(fileURLToPath(new URL(`../fixtures/valid/${name}`, import.meta.url)), 'utf8')) as T;
  }

  async function runTranscript(transcript: TranscriptRaw) {
    const calibration = await validFixture<CalibrationResult>('calibration-result.json');
    calibration.task_id = transcript.task_id;
    calibration.model_snapshot_ref = transcript.model_snapshot_ref;
    calibration.request.reference_srt_ref = null;
    calibration.request.mode = null;
    calibration.suggestions = [];
    return runSubtitleCore({ transcript, calibrationResult: calibration, referenceSrtText: null });
  }

  async function runSegments(texts: string[], gapMs = 0) {
    const transcript = await validFixture<TranscriptRaw>('transcript.raw.json');
    let cursor = 0;
    const segments = texts.map((text, segmentIndex) => {
      const start = cursor;
      const words = [...text].map((character, index) => ({
        word_id: `word-${segmentIndex + 1}-${index + 1}`,
        index,
        start_ms: start + index * 120,
        end_ms: start + (index + 1) * 120,
        text: character,
        confidence: 0.99,
      }));
      const end = start + Math.max(1, text.length) * 120;
      cursor = end + gapMs;
      return { segment_id: `seg-${segmentIndex + 1}`, index: segmentIndex, start_ms: start, end_ms: end, text, confidence: 0.99, words };
    });
    transcript.segments = segments as typeof transcript.segments;
    transcript.audio.duration_ms = cursor;
    transcript.full_text = texts.join('\n');
    return runTranscript(transcript);
  }

  it('preserves every legal source segment instead of merging the document toward 18 characters', async () => {
    const result = await runSegments(['第一段保持原有边界', '第二段也保持原有边界']);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text)).toEqual(['第一段保持原有边界', '第二段也保持原有边界']);
  });

  it('does not split a legal 20-character source segment only because it exceeds the soft target', async () => {
    const text = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉';
    const result = await runSegments([text]);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments).toHaveLength(1);
    expect(result.artifact.segments[0]!.text).toBe(text);
  });

  it('keeps sentence punctuation cleanup inside the original cue', async () => {
    const result = await runSegments(['第一句话结束。第二句话继续']);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text)).toEqual(['第一句话结束 第二句话继续']);
    expect(result.artifact.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'VISIBLE_SENTENCE_PUNCTUATION_SPACED' }),
      expect.objectContaining({ code: 'CALIBRATION_TIMELINE_FROZEN' }),
    ]));
  });

  it('does not split on silence or punctuation-plus-pause', async () => {
    const withGap = async (gap: number, punctuation: boolean) => {
      const transcript = await validFixture<TranscriptRaw>('transcript.raw.json');
      transcript.audio.duration_ms = 2_000;
      transcript.full_text = punctuation ? '甲乙，丙丁' : '甲乙丙丁';
      transcript.segments = [{
        segment_id: 'seg-1', index: 0, start_ms: 0, end_ms: 2_000, text: transcript.full_text, confidence: 0.99,
        words: [
          { word_id: 'word-1', index: 0, start_ms: 0, end_ms: 100, text: '甲', confidence: 0.99 },
          { word_id: 'word-2', index: 1, start_ms: 100, end_ms: 200, text: '乙', confidence: 0.99 },
          { word_id: 'word-3', index: 2, start_ms: 200 + gap, end_ms: 300 + gap, text: '丙', confidence: 0.99 },
          { word_id: 'word-4', index: 3, start_ms: 300 + gap, end_ms: 400 + gap, text: '丁', confidence: 0.99 },
        ],
      }];
      return runTranscript(transcript);
    };
    const silenceOnly = await withGap(800, false);
    const punctuatedPause = await withGap(400, true);
    const shortPunctuatedPause = await withGap(399, true);
    expect(silenceOnly.status).toBe('completed');
    expect(punctuatedPause.status).toBe('completed');
    expect(shortPunctuatedPause.status).toBe('completed');
    if (silenceOnly.status !== 'completed' || punctuatedPause.status !== 'completed' || shortPunctuatedPause.status !== 'completed') return;
    expect(silenceOnly.artifact.segments).toHaveLength(1);
    expect(punctuatedPause.artifact.segments).toHaveLength(1);
    expect(shortPunctuatedPause.artifact.segments).toHaveLength(1);
  });

  it('keeps every frozen semantic phrase intact in a redacted-equivalent fixture', async () => {
    const benchmark = JSON.parse(await readFile(fileURLToPath(new URL('../fixtures/segmentation-quality-benchmark.json', import.meta.url)), 'utf8')) as { forbidden_boundaries: Array<[string, string]> };
    const phrases = benchmark.forbidden_boundaries.map(([left, right]) => `${left}${right}`);
    const result = await runSegments(phrases);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifact.segments.map((segment) => segment.text)).toEqual(phrases);
  });
});
