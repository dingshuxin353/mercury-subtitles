import { describe, expect, it } from 'vitest';
import type { AudioVerification } from '../../src/contracts/index.js';
import { serializeCalibratedSrt, validateSrtText } from '../../src/output-report/index.js';
import { applyAudioVerificationFindings, type CalibratedTranscript } from '../../src/subtitle-core/index.js';

function transcript(): CalibratedTranscript {
  return {
    artifact_version: '1.0.0', task_id: 'task-001', mode: 'text-only', thresholds_version: 'v0.1',
    source_refs: { transcript_ref: 'work/transcript.raw.json', calibration_ref: 'work/calibration-result.json', reference_srt_ref: 'input/reference.srt' },
    segments: [
      { subtitle_segment_id: 'sub-1', index: 0, start_ms: 0, end_ms: 500, text: '欢迎使用', confidence: 'high', asr_segment_refs: ['seg-1'], reference_segment_refs: ['ref-1'] },
      { subtitle_segment_id: 'sub-2', index: 1, start_ms: 500, end_ms: 1000, text: '水兴', confidence: 'high', asr_segment_refs: ['seg-2'], reference_segment_refs: ['ref-2'] }
    ],
    modifications: [], warnings: []
  };
}

function verification(overrides: Partial<AudioVerification['findings'][number]> = {}): AudioVerification {
  return {
    schema_version: '1.0.0', task_id: 'task-001', created_at: '2026-08-10T08:00:00.000Z', status: 'completed',
    model_snapshot_ref: 'snapshot-001',
    input: { audio_ref: 'input/sample.mp3', audio_sha256: 'a'.repeat(64), transcript_ref: 'work/transcript.raw.json', calibration_ref: 'work/calibration-result.json', reference_srt_ref: 'input/reference.srt' },
    calls: [{ call_id: 'call-1', model_snapshot_entry_ref: 'entry-1', started_at: '2026-08-10T07:59:00.000Z', ended_at: '2026-08-10T08:00:00.000Z', outcome: 'completed' as const, error_ref: null }],
    staging: [],
    findings: [{
      finding_id: 'finding-1', kind: 'text_correction', start_ms: 0, end_ms: 1000,
      current_text: '欢迎使用水兴', suggested_text: '欢迎使用水星', rationale: '音频清楚支持“星”。', confidence: 'high',
      source_segment_refs: ['seg-1', 'seg-2', 'ref-1', 'ref-2'],
      ...overrides
    }],
    application_results: [{ application_id: 'application-1', finding_ref: 'finding-1', disposition: 'not_applied', reason: 'insufficient_evidence', modification_ref: null }],
    skip_reason: null, warnings: [], errors: []
  };
}

describe('D009 audio-verification application boundary', () => {
  it('applies a locally anchored high-confidence correction across segments without changing text-only timing or ownership', () => {
    const source = transcript();
    const result = applyAudioVerificationFindings(source, verification());
    expect(result.calibrated.segments.map((segment) => segment.text).join('')).toBe('欢迎使用水星');
    expect(result.calibrated.segments.map(({ start_ms, end_ms }) => ({ start_ms, end_ms }))).toEqual([
      { start_ms: 0, end_ms: 500 }, { start_ms: 500, end_ms: 1000 }
    ]);
    expect(result.calibrated.segments.map((segment) => segment.subtitle_segment_id)).toEqual(['sub-1', 'sub-2']);
    expect(result.verification.application_results[0]).toMatchObject({
      disposition: 'applied', reason: 'accepted_by_rules', modification_ref: 'audio-finding-1'
    });
    expect(result.calibrated.modifications[0]).toMatchObject({ type: 'text_correction', applied: true });
    expect(result.calibrated.modifications[0]?.original_segment_refs).toEqual(['seg-1', 'seg-2', 'ref-1', 'ref-2']);
    expect(result.calibrated.modifications[0]?.original_segment_refs).not.toContain('sub-1');
    expect(source.segments.map((segment) => segment.text).join('')).toBe('欢迎使用水兴');
  });

  it('allows a single anchored substitution in a short phrase but not an unrelated rewrite', () => {
    const applied = applyAudioVerificationFindings(transcript(), verification({
      start_ms: 500, end_ms: 1000, current_text: '水兴', suggested_text: '水星',
      source_segment_refs: ['seg-2', 'ref-2']
    }));
    expect(applied.calibrated.segments[1]?.text).toBe('水星');
    expect(applied.verification.application_results[0]?.disposition).toBe('applied');

    const rejected = applyAudioVerificationFindings(transcript(), verification({
      start_ms: 500, end_ms: 1000, current_text: '水兴', suggested_text: '火山',
      source_segment_refs: ['seg-2', 'ref-2']
    }));
    expect(rejected.calibrated.segments[1]?.text).toBe('水兴');
    expect(rejected.verification.application_results[0]?.reason).toBe('insufficient_evidence');
  });

  it('does not accept subtitle result IDs as original evidence references', () => {
    const result = applyAudioVerificationFindings(transcript(), verification({
      source_segment_refs: ['sub-1']
    }));
    expect(result.verification.application_results[0]).toMatchObject({
      disposition: 'not_applied', reason: 'invalid_timeline'
    });
    expect(result.calibrated.modifications).toEqual([]);
  });

  it('keeps the E01 correction mapped through a lossless SRT line break and its original subtitle identity', () => {
    const source = transcript();
    source.mode = null;
    source.source_refs.reference_srt_ref = null;
    source.segments = [
      {
        subtitle_segment_id: 'subtitle-0086',
        index: 85,
        start_ms: 212_740,
        end_ms: 215_540,
        text: '但是我们这个 skill 是按照兼容 One 3.0的那个',
        confidence: 'high',
        asr_segment_refs: ['asr-segment-0055'],
        reference_segment_refs: []
      },
      {
        subtitle_segment_id: 'subtitle-0087',
        index: 86,
        start_ms: 215_540,
        end_ms: 218_060,
        text: '30秒视频来的，所以如果大家要用别的模',
        confidence: 'high',
        asr_segment_refs: ['asr-segment-0055'],
        reference_segment_refs: []
      }
    ];
    const result = applyAudioVerificationFindings(source, verification({
      start_ms: 213_960,
      end_ms: 216_120,
      current_text: '兼容 One 3.0的那个30秒视频',
      suggested_text: '兼容万相3.0的那个30秒视频',
      source_segment_refs: ['asr-segment-0055']
    }));
    expect(result.verification.application_results[0]).toMatchObject({
      disposition: 'applied', modification_ref: 'audio-finding-1'
    });
    expect(result.calibrated.segments.map((segment) => segment.subtitle_segment_id)).toEqual([
      'subtitle-0086', 'subtitle-0087'
    ]);
    expect(result.calibrated.segments.map((segment) => segment.text).join('')).toBe(
      '但是我们这个 skill 是按照兼容万相3.0的那个30秒视频来的，所以如果大家要用别的模'
    );
    expect(result.calibrated.modifications[0]?.result_segment_refs).toEqual(['subtitle-0086', 'subtitle-0087']);

    const srt = serializeCalibratedSrt(result.calibrated);
    const validated = validateSrtText(srt, {
      audioDurationMs: 220_000,
      expectedSegments: result.calibrated.segments,
      mode: result.calibrated.mode,
      referenceSegments: null
    });
    expect(validated.valid).toBe(true);
    expect(validated.checks).toContainEqual(expect.objectContaining({
      check_id: 'SRT_CALIBRATED_MAPPING', status: 'passed'
    }));
    expect(validated.segments.map((segment) => segment.text.replace('\n', ''))).toEqual(
      result.calibrated.segments.map((segment) => segment.text)
    );
    expect(srt).not.toMatch(/3\.\n0/u);
  });

  it('keeps text-only timestamps unchanged for an incomplete suggestion normalized to uncertain', () => {
    const source = transcript();
    const before = source.segments.map(({ start_ms, end_ms }) => ({ start_ms, end_ms }));
    const result = applyAudioVerificationFindings(source, verification({
      kind: 'uncertain',
      suggested_text: null,
      rationale: '模型建议不完整；Provider 未给出建议文字。'
    }));
    expect(result.verification.application_results[0]).toMatchObject({
      disposition: 'not_applied', reason: 'insufficient_evidence', modification_ref: null
    });
    expect(result.calibrated.segments.map(({ start_ms, end_ms }) => ({ start_ms, end_ms }))).toEqual(before);
    expect(result.calibrated.modifications).toEqual([]);
  });

  it.each([
    [{ confidence: 'medium' as const }, 'insufficient_evidence'],
    [{ suggested_text: '欢迎使用水兴' }, 'no_change'],
    [{ suggested_text: '完全无关内容' }, 'insufficient_evidence'],
    [{ kind: 'translation' as const, suggested_text: 'Welcome to Mercury' }, 'translation_out_of_scope'],
    [{ start_ms: 2000, end_ms: 3000 }, 'invalid_timeline']
  ])('does not apply findings outside the conservative boundary', (overrides, reason) => {
    const result = applyAudioVerificationFindings(transcript(), verification(overrides));
    expect(result.calibrated.segments.map((segment) => segment.text).join('')).toBe('欢迎使用水兴');
    expect(result.verification.application_results[0]).toMatchObject({ disposition: 'not_applied', reason });
    expect(result.calibrated.modifications).toEqual([]);
  });
});
