import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CalibrationResultV3, ReviewRecordV1 } from './contracts/index.js';
import { validateV3CalibrationResult } from './contracts/v3.js';
import { MercuryError } from './errors.js';
import { formatSrtTimestamp, validateSrtFile, wrapSubtitleText } from './output-report/index.js';
import {
  applyReviewDecisions,
  authoritativeReviewChanges,
  flatReviewText,
  readReview,
  reviewCounts,
  reviewStatusFor,
  writeReviewRecord,
  type ReviewActor,
  type ReviewDecision,
} from './review.js';
import { parseReferenceSrt, type CalibratedSubtitleSegment, type CalibratedTranscript } from './subtitle-core/index.js';
import { sha256File } from './tasks.js';
import { withOwnedLock } from './background/owned-lock.js';
import { persistV5Task, readV5Task, verifyV5CalibrationSources, writeV5Result } from './exchange/runtime.js';
import { deliverApprovedSrt, markDeliveryPendingReview } from './delivery.js';

function managed(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '审阅路径越界。');
  return target;
}

async function withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return withOwnedLock(managed(root, 'review.lock'), operation, { waitMs: 2_000, errorCode: 'REVIEW_CONFLICT', errorMessage: '另一项审阅操作正在写入；请重新读取后再试。' });
}

function calibrated(value: unknown, taskId: string): CalibratedTranscript {
  if (!value || typeof value !== 'object') throw new MercuryError('REVIEW_SOURCE_INVALID', '校验后 transcript 不是对象。');
  const candidate = value as Partial<CalibratedTranscript>;
  if (candidate.artifact_version !== '1.0.0' || candidate.task_id !== taskId || !Array.isArray(candidate.segments) || !Array.isArray(candidate.modifications)
    || candidate.segments.some((segment, index) => !segment || segment.index !== index || !Number.isSafeInteger(segment.start_ms) || !Number.isSafeInteger(segment.end_ms)
      || segment.end_ms <= segment.start_ms || typeof segment.text !== 'string' || !segment.text.trim() || !Array.isArray(segment.asr_segment_refs))) {
    throw new MercuryError('REVIEW_SOURCE_INVALID', '校验后 transcript 缺少合法、连续的片段映射。');
  }
  return candidate as CalibratedTranscript;
}

function checkedText(value: string): string {
  const text = value.trim();
  if (!text || /[\p{Cc}\p{Cf}]/u.test(text) || /<\/?[A-Za-z][^>]*>|\{\\[^}]+\}|```/u.test(text)) throw new MercuryError('REVIEW_TEXT_INVALID', '编辑文字不能为空，也不能包含控制字符、样式标签或模型残片。', { exitCode: 2 });
  return text;
}

async function writeText(target: string, value: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target); await chmod(target, 0o600);
}

function mappedStatus(review: ReviewRecordV1): 'pending' | 'in_progress' | 'not_required' | 'finalized' {
  if (review.status === 'approved') return 'finalized';
  if (review.status === 'not_required') return 'not_required';
  return review.counts.pending === review.counts.total ? 'pending' : 'in_progress';
}

async function persistReviewState(root: string, review: ReviewRecordV1): Promise<void> {
  const task = await readV5Task(root);
  task.review = { status: mappedStatus(review), pending_count: review.counts.pending };
  task.artifacts.approved = review.approved_artifact ? { path: review.approved_artifact.path, sha256: review.approved_artifact.sha256, validation: 'passed' } : null;
  if (!review.approved_artifact) markDeliveryPendingReview(task);
  await persistV5Task(root, task);
  await writeV5Result(root, task);
}

export async function initializeV5Review(taskDirectory: string, now = () => new Date()): Promise<ReviewRecordV1> {
  const root = path.resolve(taskDirectory);
  return withLock(root, async () => {
    const task = await readV5Task(root);
    if (task.status !== 'completed' || !task.artifacts.transcribed || !task.artifacts.calibrated) throw new MercuryError('REVIEW_NOT_READY', '只有已完成且具有两份字幕的任务可以进入人工审阅。');
    await verifyV5CalibrationSources(root, task);
    try { return await readReview(root); } catch (error) { if (!(error instanceof MercuryError) || error.code !== 'REVIEW_NOT_READY') throw error; }
    const transcribedPath = managed(root, task.artifacts.transcribed.path);
    const calibratedPath = managed(root, task.artifacts.calibrated.path);
    const parsedSrt = parseReferenceSrt(await readFile(calibratedPath, 'utf8'));
    if (!parseReferenceSrt(await readFile(transcribedPath, 'utf8')).ok || !parsedSrt.ok) throw new MercuryError('REVIEW_SOURCE_INVALID', '审阅来源字幕无法安全解析。');
    const calibrationPath = managed(root, 'work/calibration-result.json');
    const checked = validateV3CalibrationResult(JSON.parse(await readFile(calibrationPath, 'utf8')) as unknown);
    if (!checked.valid || checked.value.status !== 'completed') throw new MercuryError('REVIEW_SOURCE_INVALID', '校准结果缺少完整、已验证的 corrected_units。');
    const calibratedTranscriptPath = managed(root, 'work/transcript.calibrated.json');
    const transcript = calibrated(JSON.parse(await readFile(calibratedTranscriptPath, 'utf8')) as unknown, task.identity.task_id);
    if (transcript.segments.length !== parsedSrt.segments.length || transcript.segments.some((segment, index) => segment.start_ms !== parsedSrt.segments[index]!.start_ms || segment.end_ms !== parsedSrt.segments[index]!.end_ms || flatReviewText(segment.text) !== flatReviewText(parsedSrt.segments[index]!.text))) {
      throw new MercuryError('REVIEW_SOURCE_INVALID', '校验后 transcript 与 calibrated.srt 不一致。');
    }
    const changes = authoritativeReviewChanges(task.identity.task_id, checked.value, transcript);
    const at = now().toISOString();
    const review: ReviewRecordV1 = {
      contract_version: 'mercury-review-experimental-v1', task_id: task.identity.task_id, created_at: at, updated_at: at,
      status: changes.length ? 'pending' : 'not_required',
      sources: {
        calibration_result_ref: 'work/calibration-result.json', calibration_result_sha256: await sha256File(calibrationPath),
        calibrated_transcript: { path: 'work/transcript.calibrated.json', sha256: await sha256File(calibratedTranscriptPath) },
        transcribed_srt: { path: task.artifacts.transcribed.path, sha256: await sha256File(transcribedPath) },
        calibrated_srt: { path: task.artifacts.calibrated.path, sha256: await sha256File(calibratedPath) },
      }, counts: reviewCounts(changes), changes, batches: [], approved_artifact: null,
    };
    await writeReviewRecord(root, review); await persistReviewState(root, review); return review;
  });
}

export async function readVerifiedV5Review(root: string): Promise<ReviewRecordV1> {
  const task = await readV5Task(root);
  await verifyV5CalibrationSources(root, task);
  const review = await readReview(root);
  if (review.task_id !== task.identity.task_id) throw new MercuryError('REVIEW_RECORD_INVALID', '审阅记录 identity 与任务不一致。');
  const sources = [
    [review.sources.transcribed_srt.path, review.sources.transcribed_srt.sha256],
    [review.sources.calibrated_srt.path, review.sources.calibrated_srt.sha256],
    [review.sources.calibration_result_ref, review.sources.calibration_result_sha256],
    [review.sources.calibrated_transcript.path, review.sources.calibrated_transcript.sha256],
  ] as const;
  for (const [relative, expected] of sources) {
    const target = managed(root, relative); const entry = await lstat(target).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink() || await sha256File(target) !== expected) throw new MercuryError('REVIEW_SOURCE_CONFLICT', '审阅来源缺失或发生变化；未展示或覆盖任何决定。');
  }
  if (review.approved_artifact) {
    const target = managed(root, review.approved_artifact.path); const entry = await lstat(target).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink() || await sha256File(target) !== review.approved_artifact.sha256) throw new MercuryError('REVIEW_COMMIT_INCOMPLETE', '批准稿缺失或 hash 不一致；未展示陈旧结果。');
  }
  return review;
}

export async function deliverCurrentV5Review(rootInput: string): Promise<Awaited<ReturnType<typeof readV5Task>>> {
  const root = path.resolve(rootInput);
  return withLock(root, async () => deliverApprovedSrt(root, await readVerifiedV5Review(root)));
}

export async function decideV5ReviewChange(rootInput: string, input: { changeId: string; decision: ReviewDecision; text?: string; actor: ReviewActor; now?: () => Date }): Promise<ReviewRecordV1> {
  const root = path.resolve(rootInput);
  return withLock(root, async () => {
    const review = await readVerifiedV5Review(root); const change = review.changes.find((entry) => entry.change_id === input.changeId);
    if (!change) throw new MercuryError('REVIEW_CHANGE_NOT_FOUND', '未找到指定的字幕修改。', { exitCode: 2 });
    const finalText = input.decision === 'accepted' ? change.proposed_text : input.decision === 'rejected' ? change.original_text : checkedText(input.text ?? '');
    if (change.decision === input.decision && change.final_text === finalText) return review;
    const at = (input.now ?? (() => new Date()))().toISOString();
    change.decision = input.decision; change.final_text = finalText; change.decided_at = at; change.actor = input.actor;
    change.history.push({ decision: input.decision, final_text: finalText, decided_at: at, actor: input.actor });
    review.counts = reviewCounts(review.changes); review.approved_artifact = null; review.updated_at = at; review.status = reviewStatusFor(review);
    await rm(managed(root, approvedRelative(await readV5Task(root))), { force: true });
    await writeReviewRecord(root, review); await persistReviewState(root, review); return review;
  });
}

export async function acceptAllV5ReviewChanges(rootInput: string, input: { confirmCount: number; actor: ReviewActor; now?: () => Date }): Promise<ReviewRecordV1> {
  const root = path.resolve(rootInput);
  return withLock(root, async () => {
    const review = await readVerifiedV5Review(root);
    if (review.counts.pending !== input.confirmCount) throw new MercuryError('REVIEW_CONFIRM_COUNT_STALE', `当前仍有 ${review.counts.pending} 项待决定；确认数量已变化。`);
    const at = (input.now ?? (() => new Date()))().toISOString();
    for (const change of review.changes.filter((entry) => entry.decision === 'pending')) { change.decision = 'accepted'; change.final_text = change.proposed_text; change.decided_at = at; change.actor = input.actor; change.history.push({ decision: 'accepted', final_text: change.proposed_text, decided_at: at, actor: input.actor }); }
    review.batches.push({ batch_id: `batch-${randomBytes(8).toString('hex')}`, operation: 'accept_all', count: input.confirmCount, occurred_at: at, actor: input.actor });
    review.counts = reviewCounts(review.changes); review.updated_at = at; review.status = reviewStatusFor(review);
    await writeReviewRecord(root, review); await persistReviewState(root, review); return review;
  });
}

function approvedRelative(task: Awaited<ReturnType<typeof readV5Task>>): string {
  const calibrated = task.artifacts.calibrated?.path;
  if (!calibrated) throw new MercuryError('REVIEW_NOT_READY', '任务没有 AI 校验字幕。');
  return calibrated.replace(/\.calibrated\.srt$/u, '.approved.srt');
}

export async function finalizeV5Review(rootInput: string, now = () => new Date()): Promise<ReviewRecordV1> {
  const root = path.resolve(rootInput);
  return withLock(root, async () => {
    const task = await readV5Task(root); const review = await readVerifiedV5Review(root);
    if (review.approved_artifact) {
      const latest = await readV5Task(root);
      if (latest.delivery?.requested_directory) await deliverApprovedSrt(root, review, { throwOnFailure: false });
      return review;
    }
    if (review.counts.pending > 0) throw new MercuryError('REVIEW_PENDING_CHANGES', `还有 ${review.counts.pending} 项修改未决定，不能生成批准稿。`);
    const parsed = parseReferenceSrt(await readFile(managed(root, review.sources.calibrated_srt.path), 'utf8'));
    if (!parsed.ok) throw new MercuryError('REVIEW_SOURCE_INVALID', 'AI 校验字幕无法解析。');
    const decided = applyReviewDecisions(parsed.segments.map((segment, index) => ({ subtitle_segment_id: `approved-source-${index + 1}`, index, start_ms: segment.start_ms, end_ms: segment.end_ms, text: flatReviewText(segment.text), confidence: 'high' as const, asr_segment_refs: [], reference_segment_refs: [] })), review.changes);
    const expected: CalibratedSubtitleSegment[] = decided.map((segment, index) => ({ ...segment, subtitle_segment_id: `approved-${index + 1}`, index }));
    if (expected.length !== parsed.segments.length || expected.some((segment, index) => segment.start_ms !== parsed.segments[index]!.start_ms || segment.end_ms !== parsed.segments[index]!.end_ms)) throw new MercuryError('REVIEW_TIMELINE_CHANGED', '批准稿必须与 AI 校验稿保持完全相同的片段数、顺序和时间戳。');
    const source = `${expected.map((segment, index) => [String(index + 1), `${formatSrtTimestamp(segment.start_ms)} --> ${formatSrtTimestamp(segment.end_ms)}`, ...wrapSubtitleText(segment.text, task.input_config.calibration_mode)].join('\n')).join('\n\n')}\n`;
    const relative = approvedRelative(task); const target = managed(root, relative); await writeText(target, source);
    const transcript = JSON.parse(await readFile(managed(root, task.artifacts.transcript!.path), 'utf8')) as { duration_ms?: number; segments: Array<{ end_ms: number }> };
    const validation = await validateSrtFile(target, { audioDurationMs: transcript.duration_ms ?? transcript.segments.at(-1)!.end_ms, expectedSegments: expected, mode: null, referenceSegments: null });
    if (!validation.valid) { await rm(target, { force: true }); throw new MercuryError('APPROVED_OUTPUT_VALIDATION_FAILED', validation.checks.filter((entry) => entry.status === 'failed').map((entry) => entry.message).join('；')); }
    const at = now().toISOString(); review.approved_artifact = { path: relative, sha256: await sha256File(target), segment_count: expected.length, generated_at: at, validation: 'passed' }; review.updated_at = at; review.status = review.changes.length ? 'approved' : 'not_required';
    await writeReviewRecord(root, review); await persistReviewState(root, review);
    const latest = await readV5Task(root);
    if (latest.delivery?.requested_directory) await deliverApprovedSrt(root, review, { throwOnFailure: false });
    return review;
  });
}
