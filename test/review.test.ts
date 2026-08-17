import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { submitBackgroundTask } from '../src/background/runtime.js';
import {
  acceptAllReviewChanges,
  decideReviewChange,
  finalizeReview,
  initializeReview,
  readReview,
  readVerifiedReview,
} from '../src/review.js';
import { persistTaskRecordV2 } from '../src/tasks-v2.js';
import { sha256File } from '../src/tasks.js';
import { ensureWorkspace } from '../src/workspace.js';
import { taskMachineView } from '../src/background/runtime.js';
import { acquireOwnedLock } from '../src/background/owned-lock.js';
import { validateV3CalibrationResult } from '../src/contracts/v3.js';
import { parseReferenceSrt } from '../src/subtitle-core/index.js';

const roots: string[] = [];
function srtSegments(segments: Array<{ start: number; end: number; text: string }>): string {
  return `${segments.map((segment, index) => `${index + 1}\n00:00:0${segment.start / 1_000},000 --> 00:00:0${segment.end / 1_000},000\n${segment.text}`).join('\n\n')}\n`;
}
async function prepared(calibratedTexts = ['甲一', '乙二', '丙三', '丁']): Promise<{ root: string; taskDirectory: string; transcribed: string; calibrated: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'mercury-review-'));
  roots.push(root);
  const workspace = path.join(root, 'mercury-workspace');
  await ensureWorkspace(workspace);
  await writeFile(path.join(workspace, 'config/model-config.json'), await readFile(new URL('./fixtures/valid/model-config.json', import.meta.url)));
  const audio = path.join(root, 'source.mp3');
  const bytes = Buffer.alloc(834);
  bytes.set([0xff, 0xfb, 0x90, 0x64], 0);
  bytes.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(audio, bytes);
  const submitted = await submitBackgroundTask({ workspaceRoot: workspace, audioPath: audio, requestId: 'review-fixture', now: () => new Date('2026-08-16T04:00:00.000Z'), randomHex: () => 'aabbccdd' });
  const task = submitted.task;
  const taskDirectory = path.join(workspace, 'tasks', task.task_directory);
  const texts = ['甲', '乙', '丙', '丁'];
  const srt = (values: string[]) => `${values.map((text, index) => `${index + 1}\n00:00:0${index},000 --> 00:00:0${index + 1},000\n${text}`).join('\n\n')}\n`;
  const transcribed = srt(texts);
  const calibrated = srt(calibratedTexts);
  await writeFile(path.join(taskDirectory, 'output/source.transcribed.srt'), transcribed, { mode: 0o600 });
  await writeFile(path.join(taskDirectory, 'output/source.calibrated.srt'), calibrated, { mode: 0o600 });
  const at = '2026-08-16T04:01:00.000Z';
  const correctedUnits = texts.map((text, index) => ({
    unit_id: `unit-${index + 1}`,
    original_text: text,
    corrected_text: calibratedTexts[index]!,
    rationale: text === calibratedTexts[index] ? null : 'fixture correction',
    start_ms: index * 1_000,
    end_ms: (index + 1) * 1_000,
    asr_segment_refs: [`seg-${index + 1}`],
    reference_segment_refs: [],
    changed: text !== calibratedTexts[index],
  }));
  const suggestions = correctedUnits.filter((unit) => unit.changed).map((unit, index) => ({
    suggestion_id: `suggestion-${index + 1}`,
    kind: 'text_correction',
    source_segment_refs: [...unit.asr_segment_refs],
    start_ms: unit.start_ms,
    end_ms: unit.end_ms,
    original_text: unit.original_text,
    suggested_text: unit.corrected_text,
    rationale: unit.rationale,
    confidence: 'high',
    disposition: 'applied',
    disposition_reason: 'accepted_by_rules',
    modification_refs: [`modification-${index + 1}`],
  }));
  const calibration = {
    schema_version: '3.0.0', task_id: task.task_id, created_at: at, status: 'completed',
    request: {
      transcript_ref: 'work/transcript.raw.json', alignment_ref: 'work/alignment.json', reference_srt_ref: null,
      mode: null, evidence_mode: 'text', non_strong_reason: 'audio_not_supported', input_modalities: ['text'], audio: null,
    },
    model_snapshot_ref: 'chat-fixture', provider_outcome_certainty: 'known_terminal',
    call: { call_id: 'call-fixture', model_snapshot_entry_ref: 'chat-fixture', started_at: at, ended_at: at, outcome: 'completed', error_ref: null },
    strategy: {
      prompt_version: 'mercury-alpha3-full-calibration-v2', response_contract_version: 'corrected-units-v1',
      output_budget_tokens: 4096, provider_finish_reason: 'stop', input_unit_count: 4, returned_unit_count: 4, coverage_complete: true,
    },
    corrected_units: correctedUnits, suggestions, warnings: [], errors: [],
  };
  const modifications = suggestions.map((suggestion, index) => ({
    modification_id: suggestion.modification_refs[0], type: 'text_correction', original_text: suggestion.original_text,
    original_segment_refs: [...suggestion.source_segment_refs], replacement_text: suggestion.suggested_text,
    result_segment_refs: [`subtitle-${String(correctedUnits.findIndex((unit) => unit.start_ms === suggestion.start_ms) + 1).padStart(4, '0')}`],
    start_ms: suggestion.start_ms, end_ms: suggestion.end_ms,
    evidence: { asr_segment_refs: [...suggestion.source_segment_refs], reference_segment_refs: [], calibration_suggestion_ref: suggestion.suggestion_id },
    reason: suggestion.rationale, confidence: 'high', applied: true,
  }));
  const calibratedTranscript = {
    artifact_version: '1.0.0', task_id: task.task_id, mode: null, thresholds_version: 'v0.1',
    source_refs: { transcript_ref: 'work/transcript.raw.json', calibration_ref: 'work/calibration-result.json', reference_srt_ref: null },
    segments: calibratedTexts.map((text, index) => ({
      subtitle_segment_id: `subtitle-${String(index + 1).padStart(4, '0')}`, index, start_ms: index * 1_000, end_ms: (index + 1) * 1_000,
      text, confidence: 'high', asr_segment_refs: [`seg-${index + 1}`], reference_segment_refs: [],
    })),
    modifications, warnings: [],
  };
  await writeFile(path.join(taskDirectory, 'work/calibration-result.json'), JSON.stringify(calibration), { mode: 0o600 });
  await writeFile(path.join(taskDirectory, 'work/transcript.calibrated.json'), JSON.stringify(calibratedTranscript), { mode: 0o600 });
  task.inputs.audio.duration_ms = 4_000;
  task.execution.status = 'completed';
  task.execution.stage = null;
  task.execution.ended_at = '2026-08-16T04:01:00.000Z';
  task.execution.safe_checkpoint = 'outputs_validated';
  task.artifacts.outputs = ['output/source.transcribed.srt', 'output/source.calibrated.srt'];
  task.artifacts.subtitles = {
    transcribed: { path: 'output/source.transcribed.srt', purpose: 'unverified_transcription', sha256: await sha256File(path.join(taskDirectory, 'output/source.transcribed.srt')), segment_count: 4, validation: 'passed' },
    calibrated: { path: 'output/source.calibrated.srt', purpose: 'calibrated_result', sha256: await sha256File(path.join(taskDirectory, 'output/source.calibrated.srt')), segment_count: 4, validation: 'passed' },
  };
  await persistTaskRecordV2(taskDirectory, task);
  return { root, taskDirectory, transcribed, calibrated };
}

async function mappedPrepared(input: {
  transcribed: Array<{ start: number; end: number; text: string }>;
  calibrated: Array<{ start: number; end: number; text: string }>;
  units: Array<{ id: string; original: string; corrected: string; start: number; end: number; refs: string[]; targetRefs: string[] }>;
  extraModifications?: any[];
}) {
  const base = await prepared(['甲', '乙', '丙', '丁']);
  const task = await (await import('../src/tasks-v2.js')).readTaskRecordV2(base.taskDirectory);
  const transcribed = srtSegments(input.transcribed);
  const calibrated = srtSegments(input.calibrated);
  const transcribedPath = path.join(base.taskDirectory, 'output/source.transcribed.srt');
  const calibratedPath = path.join(base.taskDirectory, 'output/source.calibrated.srt');
  await writeFile(transcribedPath, transcribed);
  await writeFile(calibratedPath, calibrated);
  const suggestions = input.units.filter((unit) => unit.original !== unit.corrected).map((unit, index) => ({
    suggestion_id: `mapped-suggestion-${index + 1}`, kind: 'text_correction', source_segment_refs: unit.refs,
    start_ms: unit.start, end_ms: unit.end, original_text: unit.original, suggested_text: unit.corrected,
    rationale: 'mapped fixture', confidence: 'high', disposition: 'applied', disposition_reason: 'accepted_by_rules',
    modification_refs: [`mapped-modification-${index + 1}`],
  }));
  const calibration = JSON.parse(await readFile(path.join(base.taskDirectory, 'work/calibration-result.json'), 'utf8')) as any;
  calibration.strategy.input_unit_count = input.units.length;
  calibration.strategy.returned_unit_count = input.units.length;
  calibration.corrected_units = input.units.map((unit) => ({
    unit_id: unit.id, original_text: unit.original, corrected_text: unit.corrected,
    rationale: unit.original === unit.corrected ? null : 'mapped fixture', start_ms: unit.start, end_ms: unit.end,
    asr_segment_refs: unit.refs, reference_segment_refs: [], changed: unit.original !== unit.corrected,
  }));
  calibration.suggestions = suggestions;
  const modifications = suggestions.map((suggestion: any, index: number) => ({
    modification_id: suggestion.modification_refs[0], type: 'text_correction', original_text: suggestion.original_text,
    original_segment_refs: suggestion.source_segment_refs, replacement_text: suggestion.suggested_text,
    result_segment_refs: input.units.filter((unit) => unit.original !== unit.corrected)[index]!.targetRefs,
    start_ms: suggestion.start_ms, end_ms: suggestion.end_ms,
    evidence: { asr_segment_refs: suggestion.source_segment_refs, reference_segment_refs: [], calibration_suggestion_ref: suggestion.suggestion_id },
    reason: suggestion.rationale, confidence: 'high', applied: true,
  }));
  const transcript = {
    artifact_version: '1.0.0', task_id: task.task_id, mode: null, thresholds_version: 'v0.1',
    source_refs: { transcript_ref: 'work/transcript.raw.json', calibration_ref: 'work/calibration-result.json', reference_srt_ref: null },
    segments: input.calibrated.map((segment, index) => ({
      subtitle_segment_id: `mapped-subtitle-${index + 1}`, index, start_ms: segment.start, end_ms: segment.end,
      text: segment.text, confidence: 'high', asr_segment_refs: [`seg-${index + 1}`], reference_segment_refs: [],
    })),
    modifications: [...modifications, ...(input.extraModifications ?? [])], warnings: [],
  };
  await writeFile(path.join(base.taskDirectory, 'work/calibration-result.json'), JSON.stringify(calibration));
  await writeFile(path.join(base.taskDirectory, 'work/transcript.calibrated.json'), JSON.stringify(transcript));
  task.inputs.audio.duration_ms = Math.max(...input.transcribed.map((segment) => segment.end), ...input.calibrated.map((segment) => segment.end));
  task.artifacts.subtitles!.transcribed = { path: 'output/source.transcribed.srt', purpose: 'unverified_transcription', sha256: await sha256File(transcribedPath), segment_count: input.transcribed.length, validation: 'passed' };
  task.artifacts.subtitles!.calibrated = { path: 'output/source.calibrated.srt', purpose: 'calibrated_result', sha256: await sha256File(calibratedPath), segment_count: input.calibrated.length, validation: 'passed' };
  await persistTaskRecordV2(base.taskDirectory, task);
  return { ...base, transcribed, calibrated };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('V02-D003 review and approved subtitle', () => {
  it('keeps an Alpha.3 calibration result valid when the Alpha.1 certainty extension is absent', async () => {
    const input = await prepared();
    const historical = JSON.parse(await readFile(path.join(input.taskDirectory, 'work/calibration-result.json'), 'utf8')) as any;
    delete historical.provider_outcome_certainty;
    expect(validateV3CalibrationResult(historical).valid).toBe(true);
  });
  it('persists accepted, rejected and edited decisions and finalizes without changing source subtitles', async () => {
    const input = await prepared();
    let review = await initializeReview(input.taskDirectory, () => new Date('2026-08-16T05:00:00.000Z'));
    expect(review.counts).toEqual({ total: 3, pending: 3, accepted: 0, rejected: 0, edited: 0 });
    const [first, second, third] = review.changes;
    review = await decideReviewChange(input.taskDirectory, { changeId: first!.change_id, decision: 'accepted', actor: 'user_via_skill', now: () => new Date('2026-08-16T05:01:00.000Z') });
    review = await decideReviewChange(input.taskDirectory, { changeId: second!.change_id, decision: 'rejected', actor: 'user_via_cli', now: () => new Date('2026-08-16T05:02:00.000Z') });
    review = await decideReviewChange(input.taskDirectory, { changeId: third!.change_id, decision: 'edited', text: '丙，自定义！', actor: 'user_via_skill', now: () => new Date('2026-08-16T05:03:00.000Z') });
    expect(review.counts).toEqual({ total: 3, pending: 0, accepted: 1, rejected: 1, edited: 1 });
    await expect(finalizeReview(input.taskDirectory, () => new Date('2026-08-16T05:04:00.000Z'))).resolves.toMatchObject({ status: 'approved' });
    const final = await readReview(input.taskDirectory);
    const approved = await readFile(path.join(input.taskDirectory, final.approved_artifact!.path), 'utf8');
    expect(approved).toContain('甲一');
    expect(approved).toContain('\n乙\n');
    expect(approved).toContain('丙自定义');
    expect(approved).not.toMatch(/[，！]/u);
    expect(approved.match(/00:00:0\d,000 --> 00:00:0\d,000/gu)).toHaveLength(4);
    expect(await readFile(path.join(input.taskDirectory, 'output/source.transcribed.srt'), 'utf8')).toBe(input.transcribed);
    expect(await readFile(path.join(input.taskDirectory, 'output/source.calibrated.srt'), 'utf8')).toBe(input.calibrated);
    const repeated = await finalizeReview(input.taskDirectory);
    expect(repeated.approved_artifact?.sha256).toBe(final.approved_artifact?.sha256);
  });

  it('rejects stale accept-all and pending finalize, then applies an exact confirmed batch', async () => {
    const input = await prepared();
    await initializeReview(input.taskDirectory);
    await expect(acceptAllReviewChanges(input.taskDirectory, { confirmCount: 2, actor: 'user_via_skill' })).rejects.toMatchObject({ code: 'REVIEW_CONFIRM_COUNT_STALE' });
    await expect(finalizeReview(input.taskDirectory)).rejects.toMatchObject({ code: 'REVIEW_PENDING_CHANGES' });
    const accepted = await acceptAllReviewChanges(input.taskDirectory, { confirmCount: 3, actor: 'user_via_skill' });
    expect(accepted.counts.pending).toBe(0);
    expect(accepted.batches).toHaveLength(1);
    await expect(finalizeReview(input.taskDirectory)).resolves.toMatchObject({ status: 'approved' });
  });

  it('marks zero changes not_required and deterministically creates an approved copy', async () => {
    const input = await prepared(['甲', '乙', '丙', '丁']);
    const review = await initializeReview(input.taskDirectory);
    expect(review).toMatchObject({ status: 'not_required', counts: { total: 0, pending: 0 } });
    const finalized = await finalizeReview(input.taskDirectory);
    expect(finalized.status).toBe('not_required');
    expect(await readFile(path.join(input.taskDirectory, finalized.approved_artifact!.path), 'utf8')).toBe(input.calibrated);
    const task = await (await import('../src/tasks-v2.js')).readTaskRecordV2(input.taskDirectory);
    expect((await taskMachineView(path.join(input.root, 'mercury-workspace'), task)).next_action)
      .toBe('本次没有需要人工决定的修改；批准稿已生成，可以直接打开。');
  });

  it('refuses an edited control character and detects source hash changes', async () => {
    const input = await prepared();
    const review = await initializeReview(input.taskDirectory);
    await expect(decideReviewChange(input.taskDirectory, { changeId: review.changes[0]!.change_id, decision: 'edited', text: '坏\u0000文字', actor: 'user_via_cli' })).rejects.toMatchObject({ code: 'REVIEW_TEXT_INVALID' });
    await writeFile(path.join(input.taskDirectory, 'output/source.calibrated.srt'), `${input.calibrated}\n`);
    await expect(decideReviewChange(input.taskDirectory, { changeId: review.changes[0]!.change_id, decision: 'accepted', actor: 'user_via_cli' })).rejects.toMatchObject({ code: 'REVIEW_SOURCE_CONFLICT' });
  });

  it('keeps all read-only review views bound to task identity and all four source hashes', async () => {
    for (const relative of [
      'output/source.transcribed.srt',
      'output/source.calibrated.srt',
      'work/calibration-result.json',
      'work/transcript.calibrated.json',
    ]) {
      const input = await prepared();
      await initializeReview(input.taskDirectory);
      await writeFile(path.join(input.taskDirectory, relative), `${await readFile(path.join(input.taskDirectory, relative), 'utf8')} `);
      await expect(readVerifiedReview(input.taskDirectory)).rejects.toMatchObject({ code: 'REVIEW_SOURCE_CONFLICT' });
      const task = await (await import('../src/tasks-v2.js')).readTaskRecordV2(input.taskDirectory);
      expect((await taskMachineView(path.join(input.root, 'mercury-workspace'), task)).review.status).toBe('invalid');
    }
    const identity = await prepared();
    await initializeReview(identity.taskDirectory);
    const reviewPath = path.join(identity.taskDirectory, 'review.json');
    const record = JSON.parse(await readFile(reviewPath, 'utf8')) as any;
    record.task_id = 'tsk-20260816-000000-deadbeef';
    await writeFile(reviewPath, JSON.stringify(record));
    await expect(readVerifiedReview(identity.taskDirectory)).rejects.toMatchObject({ code: 'REVIEW_RECORD_INVALID' });

    const linked = await prepared();
    await initializeReview(linked.taskDirectory);
    const calibratedPath = path.join(linked.taskDirectory, 'output/source.calibrated.srt');
    const savedPath = path.join(linked.root, 'saved-calibrated.srt');
    await rename(calibratedPath, savedPath);
    await symlink(savedPath, calibratedPath, 'file');
    await expect(readVerifiedReview(linked.taskDirectory)).rejects.toMatchObject({ code: 'REVIEW_SOURCE_CONFLICT' });
  });

  it('derives stable one-to-many and many-to-one changes from authoritative result segment refs', async () => {
    const input = await mappedPrepared({
      transcribed: [
        { start: 0, end: 1_000, text: 'New' }, { start: 1_000, end: 2_000, text: 'York' },
        { start: 2_000, end: 3_000, text: 'Alpha' }, { start: 3_000, end: 4_000, text: 'Beta' },
      ],
      calibrated: [
        { start: 0, end: 1_000, text: 'New' }, { start: 1_000, end: 2_000, text: 'York' },
        { start: 2_000, end: 4_000, text: 'Alpha Beta' },
      ],
      units: [
        { id: 'unit-new-york', original: 'NueYork', corrected: 'NewYork', start: 0, end: 2_000, refs: ['seg-1', 'seg-2'], targetRefs: ['mapped-subtitle-1', 'mapped-subtitle-2'] },
        { id: 'unit-alpha-beta', original: 'AlphaBeta', corrected: 'Alpha Beta', start: 2_000, end: 4_000, refs: ['seg-3', 'seg-4'], targetRefs: ['mapped-subtitle-3'] },
      ],
      extraModifications: [{
        modification_id: 'segmentation-new-york', type: 'split', original_text: 'NewYork', original_segment_refs: ['seg-1', 'seg-2'], replacement_text: 'NewYork',
        result_segment_refs: ['mapped-subtitle-1', 'mapped-subtitle-2'], start_ms: 0, end_ms: 2_000,
        evidence: { asr_segment_refs: ['seg-1', 'seg-2'], reference_segment_refs: [], calibration_suggestion_ref: null }, reason: 'segmentation fixture', confidence: 'high', applied: true,
      }],
    });
    let review = await initializeReview(input.taskDirectory);
    expect(review.changes).toHaveLength(2);
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit_id: 'unit-new-york', target_segment_indexes: [0, 1], original_text: 'NueYork', proposed_text: 'NewYork' }),
      expect.objectContaining({ unit_id: 'unit-alpha-beta', target_segment_indexes: [2], original_text: 'AlphaBeta', proposed_text: 'Alpha Beta' }),
    ]));
    for (const change of review.changes) review = await decideReviewChange(input.taskDirectory, { changeId: change.change_id, decision: 'rejected', actor: 'user_via_cli' });
    const final = await finalizeReview(input.taskDirectory);
    const approved = await readFile(path.join(input.taskDirectory, final.approved_artifact!.path), 'utf8');
    expect(approved).toContain('Nue');
    expect(approved).toContain('York');
    expect(approved).toContain('AlphaBeta');
    expect((approved.match(/-->/gu) ?? [])).toHaveLength(3);
    const calibratedTimeline = parseReferenceSrt(input.calibrated);
    const approvedTimeline = parseReferenceSrt(approved);
    expect(calibratedTimeline.ok).toBe(true);
    expect(approvedTimeline.ok).toBe(true);
    if (calibratedTimeline.ok && approvedTimeline.ok) {
      expect(approvedTimeline.segments.map(({ start_ms, end_ms }, index) => ({ index, start_ms, end_ms })))
        .toEqual(calibratedTimeline.segments.map(({ start_ms, end_ms }, index) => ({ index, start_ms, end_ms })));
    }
  });

  it('applies two disjoint corrections that share a cross-boundary target group without duplication', async () => {
    const input = await mappedPrepared({
      transcribed: [{ start: 0, end: 1_000, text: 'Nue' }, { start: 1_000, end: 2_000, text: 'Yrok?' }],
      calibrated: [{ start: 0, end: 1_000, text: 'New' }, { start: 1_000, end: 2_000, text: 'York!' }],
      units: [
        { id: 'unit-new', original: 'Nue', corrected: 'New', start: 0, end: 1_000, refs: ['seg-1'], targetRefs: ['mapped-subtitle-1', 'mapped-subtitle-2'] },
        { id: 'unit-york', original: 'Yrok?', corrected: 'York!', start: 1_000, end: 2_000, refs: ['seg-2'], targetRefs: ['mapped-subtitle-1', 'mapped-subtitle-2'] },
      ],
    });
    let review = await initializeReview(input.taskDirectory);
    expect(review.changes.map((change) => [change.target_text_start, change.target_text_end])).toEqual([[0, 3], [3, 7]]);
    for (const change of review.changes) review = await decideReviewChange(input.taskDirectory, { changeId: change.change_id, decision: 'rejected', actor: 'user_via_cli' });
    const final = await finalizeReview(input.taskDirectory);
    const approved = await readFile(path.join(input.taskDirectory, final.approved_artifact!.path), 'utf8');
    expect(approved).toContain('Nue');
    expect(approved).toContain('Yrok');
    expect(approved).not.toMatch(/[?!]/u);
    expect((approved.match(/Nue/gu) ?? [])).toHaveLength(1);
  });

  it('applies disjoint corrections whose authoritative target groups partially overlap', async () => {
    const input = await mappedPrepared({
      transcribed: [
        { start: 0, end: 1_000, text: 'Nue' },
        { start: 1_000, end: 2_000, text: 'Yrok?' },
        { start: 2_000, end: 3_000, text: 'Now' },
      ],
      calibrated: [
        { start: 0, end: 1_000, text: 'New' },
        { start: 1_000, end: 2_000, text: 'York!' },
        { start: 2_000, end: 3_000, text: 'Now' },
      ],
      units: [
        { id: 'unit-new', original: 'Nue', corrected: 'New', start: 0, end: 1_000, refs: ['seg-1'], targetRefs: ['mapped-subtitle-1', 'mapped-subtitle-2'] },
        { id: 'unit-york', original: 'Yrok?', corrected: 'York!', start: 1_000, end: 2_000, refs: ['seg-2'], targetRefs: ['mapped-subtitle-2', 'mapped-subtitle-3'] },
      ],
    });
    let review = await initializeReview(input.taskDirectory);
    expect(review.changes.map((change) => change.target_segment_indexes)).toEqual([[0, 1], [1, 2]]);
    review = await decideReviewChange(input.taskDirectory, {
      changeId: review.changes[0]!.change_id,
      decision: 'rejected',
      actor: 'user_via_cli',
    });
    review = await decideReviewChange(input.taskDirectory, {
      changeId: review.changes[1]!.change_id,
      decision: 'accepted',
      actor: 'user_via_skill',
    });
    const final = await finalizeReview(input.taskDirectory);
    const approved = await readFile(path.join(input.taskDirectory, final.approved_artifact!.path), 'utf8');
    expect(approved).toContain('Nue');
    expect(approved).toContain('York');
    expect(approved).not.toMatch(/[?!]/u);
    expect((approved.match(/-->/gu) ?? [])).toHaveLength(3);
    const calibratedTimeline = parseReferenceSrt(input.calibrated);
    const approvedTimeline = parseReferenceSrt(approved);
    expect(calibratedTimeline.ok).toBe(true);
    expect(approvedTimeline.ok).toBe(true);
    if (calibratedTimeline.ok && approvedTimeline.ok) {
      expect(approvedTimeline.segments.map(({ start_ms, end_ms }) => ({ start_ms, end_ms })))
        .toEqual(calibratedTimeline.segments.map(({ start_ms, end_ms }) => ({ start_ms, end_ms })));
    }
  });

  it('still rejects truly overlapping text patches across partially shared target groups', async () => {
    const input = await mappedPrepared({
      transcribed: [
        { start: 0, end: 1_000, text: 'Alpha' },
        { start: 1_000, end: 2_000, text: 'Old' },
      ],
      calibrated: [
        { start: 0, end: 1_000, text: 'Alpha' },
        { start: 1_000, end: 2_000, text: 'Beta' },
      ],
      units: [
        { id: 'unit-wide', original: 'Old', corrected: 'Beta', start: 0, end: 1_000, refs: ['seg-1'], targetRefs: ['mapped-subtitle-1', 'mapped-subtitle-2'] },
        { id: 'unit-narrow', original: 'Bad', corrected: 'Beta', start: 1_000, end: 2_000, refs: ['seg-2'], targetRefs: ['mapped-subtitle-2'] },
      ],
    });
    let review = await initializeReview(input.taskDirectory);
    for (const change of review.changes) {
      review = await decideReviewChange(input.taskDirectory, {
        changeId: change.change_id,
        decision: 'accepted',
        actor: 'user_via_cli',
      });
    }
    await expect(finalizeReview(input.taskDirectory)).rejects.toMatchObject({ code: 'REVIEW_MAPPING_INVALID' });
  });

  it('rejects an unsafe short one-to-many edit without changing the calibrated timeline', async () => {
    const input = await mappedPrepared({
      transcribed: [{ start: 0, end: 1_000, text: '旧' }, { start: 1_000, end: 2_000, text: '词' }],
      calibrated: [{ start: 0, end: 1_000, text: 'A' }, { start: 1_000, end: 2_000, text: 'B' }],
      units: [{ id: 'unit-short', original: '旧词', corrected: 'AB', start: 0, end: 2_000, refs: ['seg-1', 'seg-2'], targetRefs: ['mapped-subtitle-1', 'mapped-subtitle-2'] }],
    });
    const review = await initializeReview(input.taskDirectory);
    await decideReviewChange(input.taskDirectory, { changeId: review.changes[0]!.change_id, decision: 'edited', text: 'Z', actor: 'user_via_cli' });
    await expect(finalizeReview(input.taskDirectory)).rejects.toMatchObject({ code: 'REVIEW_TEXT_DISTRIBUTION_UNSAFE' });
    const after = await readReview(input.taskDirectory);
    expect(after.approved_artifact).toBeNull();
    expect(await readFile(path.join(input.taskDirectory, 'output/source.calibrated.srt'), 'utf8')).toBe(input.calibrated);
  });

  it('does not create a review item for a punctuation-only model change and finalizes visible text without punctuation', async () => {
    const input = await mappedPrepared({
      transcribed: [{ start: 0, end: 1_000, text: '你好' }],
      calibrated: [{ start: 0, end: 1_000, text: '你好' }],
      units: [{
        id: 'unit-punctuation-only', original: '你好', corrected: '你好！', start: 0, end: 1_000,
        refs: ['seg-1'], targetRefs: ['mapped-subtitle-1'],
      }],
    });
    const review = await initializeReview(input.taskDirectory);
    expect(review.counts).toEqual({ total: 0, pending: 0, accepted: 0, rejected: 0, edited: 0 });
    expect(review.status).toBe('not_required');
    const final = await finalizeReview(input.taskDirectory);
    const approved = await readFile(path.join(input.taskDirectory, final.approved_artifact!.path), 'utf8');
    expect(approved).toContain('你好');
    expect(approved).not.toContain('！');
  });

  it('treats a segmentation-only change as not required and preserves English line output', async () => {
    const input = await mappedPrepared({
      transcribed: [{ start: 0, end: 1_000, text: 'Mercury Skill' }, { start: 1_000, end: 2_000, text: 'address' }],
      calibrated: [{ start: 0, end: 2_000, text: 'Mercury Skill\naddress' }],
      units: [{ id: 'unit-english', original: 'Mercury Skill address', corrected: 'Mercury Skill address', start: 0, end: 2_000, refs: ['seg-1', 'seg-2'], targetRefs: ['mapped-subtitle-1'] }],
      extraModifications: [{
        modification_id: 'merge-english', type: 'merge', original_text: 'Mercury Skilladdress', original_segment_refs: ['seg-1', 'seg-2'], replacement_text: 'Mercury Skill address',
        result_segment_refs: ['mapped-subtitle-1'], start_ms: 0, end_ms: 2_000,
        evidence: { asr_segment_refs: ['seg-1', 'seg-2'], reference_segment_refs: [], calibration_suggestion_ref: null }, reason: 'segmentation only', confidence: 'high', applied: true,
      }],
    });
    const review = await initializeReview(input.taskDirectory);
    expect(review).toMatchObject({ status: 'not_required', counts: { total: 0 } });
    const final = await finalizeReview(input.taskDirectory);
    const approved = await readFile(path.join(input.taskDirectory, final.approved_artifact!.path), 'utf8');
    expect(approved).toContain('Mercury Skill address');
    expect(approved).not.toContain('Skilladdress');
  });

  it('uses review plus the approved-file hash as truth and repairs a stale task pointer', async () => {
    const input = await prepared();
    await initializeReview(input.taskDirectory);
    await acceptAllReviewChanges(input.taskDirectory, { confirmCount: 3, actor: 'user_via_cli' });
    const final = await finalizeReview(input.taskDirectory);
    const task = await (await import('../src/tasks-v2.js')).readTaskRecordV2(input.taskDirectory);
    task.artifacts.outputs = task.artifacts.outputs.filter((item) => item !== final.approved_artifact!.path);
    task.artifacts.subtitles!.approved = null;
    task.artifacts.review = { path: 'review.json', status: 'in_progress', pending_count: 0 };
    await persistTaskRecordV2(input.taskDirectory, task);
    const view = await taskMachineView(path.join(input.root, 'mercury-workspace'), task);
    expect(view).toMatchObject({ review: { status: 'finalized' }, artifacts: { approved: { exists: true, validation: 'passed' } } });
    expect(view.next_action).toBe('人工批准稿已生成，可以打开批准后字幕。');
    for (const command of ['status', 'result']) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(await (await import('../src/cli.js')).runCli(
        ['task', command, task.task_id, '--json', '--experimental'],
        { homeDirectory: input.root, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      )).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout[0]!)).toMatchObject({
        ok: true,
        command: `task.${command}`,
        data: {
          review: { status: 'finalized' },
          artifacts: { approved: { exists: true, validation: 'passed' } },
          next_action: '人工批准稿已生成，可以打开批准后字幕。',
        },
      });
    }
    await finalizeReview(input.taskDirectory);
    const repaired = await (await import('../src/tasks-v2.js')).readTaskRecordV2(input.taskDirectory);
    expect(repaired.artifacts.subtitles?.approved?.sha256).toBe(final.approved_artifact!.sha256);
    expect(repaired.artifacts.outputs).toContain(final.approved_artifact!.path);
  });

  it('does not expose a missing/corrupt approved file as finalized output', async () => {
    const input = await prepared();
    await initializeReview(input.taskDirectory);
    await acceptAllReviewChanges(input.taskDirectory, { confirmCount: 3, actor: 'user_via_cli' });
    const final = await finalizeReview(input.taskDirectory);
    const task = await (await import('../src/tasks-v2.js')).readTaskRecordV2(input.taskDirectory);
    await writeFile(path.join(input.taskDirectory, final.approved_artifact!.path), 'corrupt');
    const view = await taskMachineView(path.join(input.root, 'mercury-workspace'), task);
    expect(view.review).toMatchObject({ status: 'invalid', problem: { code: 'REVIEW_COMMIT_INCOMPLETE' } });
    expect(view.artifacts.approved.validation).toBe('unavailable');
    await expect(finalizeReview(input.taskDirectory)).rejects.toMatchObject({ code: 'REVIEW_COMMIT_INCOMPLETE' });
  });

  it('hides and recovers an orphan approved file/task pointer after review invalidation', async () => {
    const input = await prepared();
    await initializeReview(input.taskDirectory);
    await acceptAllReviewChanges(input.taskDirectory, { confirmCount: 3, actor: 'user_via_cli' });
    const final = await finalizeReview(input.taskDirectory);
    const review = await readReview(input.taskDirectory);
    review.approved_artifact = null;
    review.status = 'in_progress';
    await writeFile(path.join(input.taskDirectory, 'review.json'), `${JSON.stringify(review, null, 2)}\n`, { mode: 0o600 });
    const task = await (await import('../src/tasks-v2.js')).readTaskRecordV2(input.taskDirectory);
    const before = await taskMachineView(path.join(input.root, 'mercury-workspace'), task);
    expect(before.artifacts.approved).toMatchObject({ exists: false, path: null, validation: 'unavailable' });
    await decideReviewChange(input.taskDirectory, { changeId: review.changes[0]!.change_id, decision: 'rejected', actor: 'user_via_cli' });
    await expect(readFile(path.join(input.taskDirectory, final.approved_artifact!.path), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = await (await import('../src/tasks-v2.js')).readTaskRecordV2(input.taskDirectory);
    expect(recovered.artifacts.subtitles?.approved).toBeNull();
    expect(recovered.artifacts.outputs).not.toContain(final.approved_artifact!.path);
  });

  it('recovers only a provably stale review lock and preserves a live/PID-reused lock boundary', async () => {
    const input = await prepared();
    const lockPath = path.join(input.taskDirectory, 'review.lock');
    const staleRecord = { version: 1, owner_token: 'a'.repeat(32), pid: 4242, process_started_at_ms: 100, acquired_at: new Date(0).toISOString() };
    await writeFile(lockPath, `${JSON.stringify(staleRecord)}\n`, { mode: 0o600 });
    const recovered = await acquireOwnedLock(lockPath, { processIdentity: async () => 5_000, waitMs: 30 });
    await recovered.release();
    const liveRecord = { ...staleRecord, owner_token: 'b'.repeat(32), process_started_at_ms: 300 };
    await writeFile(lockPath, `${JSON.stringify(liveRecord)}\n`, { mode: 0o600 });
    await expect(acquireOwnedLock(lockPath, {
      processIdentity: async () => 300,
      waitMs: 20,
      pollMs: 5,
      errorCode: 'REVIEW_CONFLICT',
    })).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ owner_token: 'b'.repeat(32) });
  });
});
