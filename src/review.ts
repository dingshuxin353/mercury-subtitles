import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewRecordV1 } from './contracts/index.js';
import type { CalibrationResultV3 } from './contracts/generated/calibration-result-v3.js';
import { assertV4Contract } from './contracts/v4.js';
import { validateV3CalibrationResult } from './contracts/v3.js';
import { MercuryError } from './errors.js';
import { formatSrtTimestamp, validateSrtFile, wrapSubtitleText } from './output-report/index.js';
import { parseReferenceSrt, type CalibratedSubtitleSegment, type CalibratedTranscript } from './subtitle-core/index.js';
import { safeAudioStem, sha256File, writeJsonAtomic } from './tasks.js';
import { persistTaskRecordV2, readTaskRecordV2, type TaskRecordV2 } from './tasks-v2.js';
import { withOwnedLock } from './background/owned-lock.js';

export type ReviewActor = 'user_via_cli' | 'user_via_skill';
export type ReviewDecision = 'accepted' | 'rejected' | 'edited';

function taskPath(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '审阅路径越界。');
  return target;
}

function flat(value: string): string {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.reduce((combined, line) => {
    if (!combined) return line;
    const separator = /[A-Za-z0-9]$/u.test(combined) && /^[A-Za-z0-9]/u.test(line) ? ' ' : '';
    return `${combined}${separator}${line}`;
  }, '').trim();
}

function counts(changes: ReviewRecordV1['changes']): ReviewRecordV1['counts'] {
  return {
    total: changes.length,
    pending: changes.filter((item) => item.decision === 'pending').length,
    accepted: changes.filter((item) => item.decision === 'accepted').length,
    rejected: changes.filter((item) => item.decision === 'rejected').length,
    edited: changes.filter((item) => item.decision === 'edited').length,
  };
}

function statusFor(record: ReviewRecordV1): ReviewRecordV1['status'] {
  if (record.changes.length === 0) return 'not_required';
  if (record.counts.pending === record.counts.total) return 'pending';
  if (record.counts.pending > 0) return 'in_progress';
  return record.approved_artifact ? 'approved' : 'in_progress';
}

async function withReviewLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = taskPath(root, 'review.lock');
  return withOwnedLock(lock, operation, {
    waitMs: 2_000,
    errorCode: 'REVIEW_CONFLICT',
    errorMessage: '另一项审阅操作正在写入；请重新读取后再试。',
  });
}

export async function readReview(taskDirectory: string): Promise<ReviewRecordV1> {
  try {
    const review = assertV4Contract('review', JSON.parse(await readFile(taskPath(taskDirectory, 'review.json'), 'utf8')));
    const expectedTaskId = path.basename(path.resolve(taskDirectory)).match(/^(tsk-[0-9]{8}-[0-9]{6}-[a-f0-9]{8})-/)?.[1] ?? null;
    if (!expectedTaskId || review.task_id !== expectedTaskId) {
      throw new MercuryError('REVIEW_RECORD_INVALID', '审阅记录 identity 与任务目录不一致。');
    }
    return review;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MercuryError('REVIEW_NOT_READY', '此任务尚无可审阅的 AI 校验稿。');
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('REVIEW_RECORD_INVALID', '审阅记录无效。');
  }
}

async function writeReview(taskDirectory: string, record: ReviewRecordV1): Promise<void> {
  assertV4Contract('review', record);
  const target = taskPath(taskDirectory, 'review.json');
  await writeJsonAtomic(target, record);
  await chmod(target, 0o600);
}

function calibratedTranscript(value: unknown, taskId: string): CalibratedTranscript {
  if (!value || typeof value !== 'object') throw new MercuryError('REVIEW_SOURCE_INVALID', '校验后 transcript 不是对象。');
  const candidate = value as Partial<CalibratedTranscript>;
  if (
    candidate.artifact_version !== '1.0.0'
    || candidate.task_id !== taskId
    || !Array.isArray(candidate.segments)
    || !Array.isArray(candidate.modifications)
    || candidate.segments.some((segment, index) =>
      !segment
      || segment.index !== index
      || typeof segment.subtitle_segment_id !== 'string'
      || !Number.isInteger(segment.start_ms)
      || !Number.isInteger(segment.end_ms)
      || segment.end_ms <= segment.start_ms
      || typeof segment.text !== 'string'
      || !segment.text.trim()
      || !Array.isArray(segment.asr_segment_refs),
    )
  ) throw new MercuryError('REVIEW_SOURCE_INVALID', '校验后 transcript 缺少合法、连续的片段映射。');
  return candidate as CalibratedTranscript;
}

function occurrences(source: string, needle: string): number[] {
  const result: number[] = [];
  for (let offset = source.indexOf(needle); offset >= 0; offset = source.indexOf(needle, offset + Math.max(needle.length, 1))) result.push(offset);
  return result;
}

function authoritativeChanges(
  task: TaskRecordV2,
  calibration: CalibrationResultV3,
  calibrated: CalibratedTranscript,
): ReviewRecordV1['changes'] {
  const segmentIndex = new Map(calibrated.segments.map((segment) => [segment.subtitle_segment_id, segment.index]));
  const modificationById = new Map(calibrated.modifications.map((item) => [item.modification_id, item]));
  const suggestionByText = new Map(
    calibration.suggestions.map((item) => [`${item.start_ms}:${item.end_ms}:${flat(item.original_text)}:${flat(item.suggested_text ?? '')}`, item]),
  );
  const occupied = new Map<string, Array<{ start: number; end: number }>>();
  const changes: ReviewRecordV1['changes'] = [];
  for (const unit of calibration.corrected_units.filter((item) => item.changed)) {
    const originalText = flat(unit.original_text);
    const proposedText = flat(unit.corrected_text);
    const suggestion = suggestionByText.get(`${unit.start_ms}:${unit.end_ms}:${originalText}:${proposedText}`);
    if (!suggestion || suggestion.disposition !== 'applied' || suggestion.modification_refs.length === 0) {
      throw new MercuryError('REVIEW_MAPPING_INVALID', `校验单元 ${unit.unit_id} 缺少已验证的应用映射。`);
    }
    const modifications = suggestion.modification_refs.map((id) => modificationById.get(id));
    if (modifications.some((item) => !item || !item.applied)) {
      throw new MercuryError('REVIEW_MAPPING_INVALID', `校验单元 ${unit.unit_id} 的修改映射无效。`);
    }
    const indexes = [...new Set(modifications.flatMap((item) => item!.result_segment_refs).map((id) => segmentIndex.get(id)))];
    if (indexes.some((index) => index === undefined) || indexes.length === 0) {
      throw new MercuryError('REVIEW_MAPPING_INVALID', `校验单元 ${unit.unit_id} 无法定位校验后字幕片段。`);
    }
    const targetIndexes = (indexes as [number, ...number[]]).sort((a, b) => a - b) as [number, ...number[]];
    const key = targetIndexes.join(',');
    const targetText = flat(targetIndexes.map((index) => calibrated.segments[index]!.text).join(''));
    const used = occupied.get(key) ?? [];
    const start = occurrences(targetText, proposedText).find((candidate) =>
      !used.some((range) => candidate < range.end && candidate + proposedText.length > range.start),
    );
    if (start === undefined) {
      throw new MercuryError('REVIEW_MAPPING_INVALID', `校验单元 ${unit.unit_id} 的权威正文无法唯一定位到输出。`);
    }
    used.push({ start, end: start + proposedText.length });
    occupied.set(key, used);
    const digest = createHash('sha256')
      .update(`${task.task_id}:${unit.unit_id}:${targetIndexes.join(',')}:${start}:${originalText}:${proposedText}`)
      .digest('hex')
      .slice(0, 16);
    changes.push({
      change_id: `chg-${digest}`,
      unit_id: unit.unit_id,
      segment_index: targetIndexes[0]!,
      target_segment_indexes: targetIndexes,
      target_text_start: start,
      target_text_end: start + proposedText.length,
      source_refs: [...new Set([...unit.asr_segment_refs, ...unit.reference_segment_refs])],
      start_ms: unit.start_ms,
      end_ms: unit.end_ms,
      original_text: originalText,
      proposed_text: proposedText,
      reason: unit.rationale?.trim() || suggestion.rationale.trim() || 'AI 校验文字与纯转写不同。',
      decision: 'pending',
      final_text: null,
      decided_at: null,
      actor: null,
      history: [],
    });
  }
  return changes;
}

export async function initializeReview(taskDirectory: string, now = () => new Date()): Promise<ReviewRecordV1> {
  const root = path.resolve(taskDirectory);
  return withReviewLock(root, async () => {
    const task = await readTaskRecordV2(root);
    if (task.schema_version !== '4.0.0' || task.execution.status !== 'completed') throw new MercuryError('REVIEW_NOT_READY', '只有新的已完成后台任务可以进入人工审阅。');
    try { return await readReview(root); } catch (error) { if (!(error instanceof MercuryError) || error.code !== 'REVIEW_NOT_READY') throw error; }
    const transcribedRelative = task.artifacts.subtitles?.transcribed?.path;
    const calibratedRelative = task.artifacts.subtitles?.calibrated?.path;
    if (!transcribedRelative || !calibratedRelative) throw new MercuryError('REVIEW_NOT_READY', '任务缺少纯转写或 AI 校验字幕。');
    const transcribedPath = taskPath(root, transcribedRelative);
    const calibratedPath = taskPath(root, calibratedRelative);
    const transcribed = parseReferenceSrt(await readFile(transcribedPath, 'utf8'));
    const calibrated = parseReferenceSrt(await readFile(calibratedPath, 'utf8'));
    if (!transcribed.ok || !calibrated.ok) throw new MercuryError('REVIEW_SOURCE_INVALID', '审阅来源字幕无法安全解析。');
    const calibrationPath = taskPath(root, 'work/calibration-result.json');
    const calibrationValue = JSON.parse(await readFile(calibrationPath, 'utf8')) as unknown;
    const calibrationValidation = validateV3CalibrationResult(calibrationValue);
    if (!calibrationValidation.valid || calibrationValidation.value.status !== 'completed') {
      throw new MercuryError('REVIEW_SOURCE_INVALID', '校准结果缺少完整、已验证的 corrected_units。');
    }
    const calibratedTranscriptPath = taskPath(root, 'work/transcript.calibrated.json');
    const calibratedArtifact = calibratedTranscript(
      JSON.parse(await readFile(calibratedTranscriptPath, 'utf8')) as unknown,
      task.task_id,
    );
    if (
      calibratedArtifact.segments.length !== calibrated.segments.length
      || calibratedArtifact.segments.some((segment, index) =>
        segment.start_ms !== calibrated.segments[index]!.start_ms
        || segment.end_ms !== calibrated.segments[index]!.end_ms
        || flat(segment.text) !== flat(calibrated.segments[index]!.text),
      )
    ) throw new MercuryError('REVIEW_SOURCE_INVALID', '校验后 transcript 与 calibrated.srt 不一致。');
    const changes = authoritativeChanges(task, calibrationValidation.value, calibratedArtifact);
    const at = now().toISOString();
    const record: ReviewRecordV1 = {
      contract_version: 'mercury-review-experimental-v1',
      task_id: task.task_id,
      created_at: at,
      updated_at: at,
      status: changes.length ? 'pending' : 'not_required',
      sources: {
        calibration_result_ref: 'work/calibration-result.json',
        calibration_result_sha256: await sha256File(calibrationPath),
        calibrated_transcript: { path: 'work/transcript.calibrated.json', sha256: await sha256File(calibratedTranscriptPath) },
        transcribed_srt: { path: transcribedRelative, sha256: await sha256File(transcribedPath) },
        calibrated_srt: { path: calibratedRelative, sha256: await sha256File(calibratedPath) },
      },
      counts: counts(changes),
      changes,
      batches: [],
      approved_artifact: null,
    };
    await writeReview(root, record);
    task.artifacts.review = { path: 'review.json', status: record.status, pending_count: record.counts.pending };
    await persistTaskRecordV2(root, task);
    return record;
  });
}

export async function readVerifiedReview(root: string): Promise<{ task: TaskRecordV2; review: ReviewRecordV1 }> {
  const task = await readTaskRecordV2(root);
  if (task.schema_version !== '4.0.0') throw new MercuryError('MACHINE_CONTRACT_UNAVAILABLE', '历史任务不支持人工审阅。');
  const review = await readReview(root);
  const transcribed = taskPath(root, review.sources.transcribed_srt.path);
  const calibrated = taskPath(root, review.sources.calibrated_srt.path);
  const calibration = taskPath(root, review.sources.calibration_result_ref);
  const calibratedTranscriptPath = taskPath(root, review.sources.calibrated_transcript.path);
  try {
    for (const source of [transcribed, calibrated, calibration, calibratedTranscriptPath]) {
      const entry = await lstat(source);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new MercuryError('REVIEW_SOURCE_CONFLICT', '审阅来源必须是任务目录内的普通文件。');
      }
    }
    if (
      (await sha256File(transcribed)) !== review.sources.transcribed_srt.sha256
      || (await sha256File(calibrated)) !== review.sources.calibrated_srt.sha256
      || (await sha256File(calibration)) !== review.sources.calibration_result_sha256
      || (await sha256File(calibratedTranscriptPath)) !== review.sources.calibrated_transcript.sha256
    ) {
      throw new MercuryError('REVIEW_SOURCE_CONFLICT', '审阅来源字幕已变化；已停止，未覆盖任何决定。');
    }
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('REVIEW_SOURCE_CONFLICT', '审阅来源缺失或不可读；已停止，未覆盖任何决定。');
  }
  if (review.approved_artifact) {
    const approvedPath = taskPath(root, review.approved_artifact.path);
    let approvedHash: string;
    try {
      const entry = await lstat(approvedPath);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('not a regular file');
      approvedHash = await sha256File(approvedPath);
    } catch {
      throw new MercuryError('REVIEW_COMMIT_INCOMPLETE', '批准稿缺失；审阅记录保持不变，未展示陈旧结果。');
    }
    if (approvedHash !== review.approved_artifact.sha256) {
      throw new MercuryError('REVIEW_COMMIT_INCOMPLETE', '批准稿与审阅记录哈希不一致；未展示陈旧结果。');
    }
  }
  return { task, review };
}

async function verifiedReview(root: string): Promise<{ task: TaskRecordV2; review: ReviewRecordV1 }> {
  const { task, review } = await readVerifiedReview(root);
  const approvedRelative = `output/${safeAudioStem(task.inputs.audio.original_name)}.approved.srt`;
  if (review.approved_artifact) {
    const expected = review.approved_artifact;
    const current = task.artifacts.subtitles?.approved;
    if (
      !current
      || current.path !== expected.path
      || current.sha256 !== expected.sha256
      || !task.artifacts.outputs.includes(expected.path)
      || task.artifacts.review?.status !== review.status
    ) {
      task.artifacts.outputs = [...new Set([...task.artifacts.outputs, expected.path])];
      task.artifacts.review = { path: 'review.json', status: review.status, pending_count: review.counts.pending };
      if (task.artifacts.subtitles) task.artifacts.subtitles.approved = {
        path: expected.path,
        purpose: 'approved_result',
        sha256: expected.sha256,
        segment_count: expected.segment_count,
        validation: 'passed',
      };
      await persistTaskRecordV2(root, task);
    }
  } else {
    // review.json is the commit marker. If it does not name an approved artifact,
    // any stable approved file/task pointer is an orphan from a crashed write.
    await rm(taskPath(root, approvedRelative), { force: true });
    const hadStalePointer = Boolean(task.artifacts.subtitles?.approved)
      || task.artifacts.outputs.includes(approvedRelative)
      || task.artifacts.review?.status === 'approved';
    if (hadStalePointer) {
      task.artifacts.outputs = task.artifacts.outputs.filter((item) => item !== approvedRelative);
      if (task.artifacts.subtitles) task.artifacts.subtitles.approved = null;
      task.artifacts.review = { path: 'review.json', status: review.status, pending_count: review.counts.pending };
      await persistTaskRecordV2(root, task);
    }
  }
  return { task, review };
}

function checkedText(value: string): string {
  const text = value.trim();
  if (!text || /[\p{Cc}\p{Cf}]/u.test(text) || /<\/?[A-Za-z][^>]*>|\{\\[^}]+\}|```/u.test(text)) {
    throw new MercuryError('REVIEW_TEXT_INVALID', '编辑文字不能为空，也不能包含控制字符、样式标签或模型残片。', { exitCode: 2 });
  }
  return text;
}

export async function decideReviewChange(
  taskDirectory: string,
  input: { changeId: string; decision: ReviewDecision; text?: string; actor: ReviewActor; now?: () => Date },
): Promise<ReviewRecordV1> {
  const root = path.resolve(taskDirectory);
  return withReviewLock(root, async () => {
    const { task, review } = await verifiedReview(root);
    const change = review.changes.find((item) => item.change_id === input.changeId);
    if (!change) throw new MercuryError('REVIEW_CHANGE_NOT_FOUND', '未找到指定的字幕修改。', { exitCode: 2 });
    const finalText = input.decision === 'accepted' ? change.proposed_text : input.decision === 'rejected' ? change.original_text : checkedText(input.text ?? '');
    if (change.decision === input.decision && change.final_text === finalText) return review;
    const at = (input.now ?? (() => new Date()))().toISOString();
    change.decision = input.decision;
    change.final_text = finalText;
    change.decided_at = at;
    change.actor = input.actor;
    change.history.push({ decision: input.decision, final_text: finalText, decided_at: at, actor: input.actor });
    review.counts = counts(review.changes);
    review.approved_artifact = null;
    review.updated_at = at;
    review.status = statusFor(review);
    await writeReview(root, review);
    task.artifacts.review = { path: 'review.json', status: review.status, pending_count: review.counts.pending };
    if (task.artifacts.subtitles) task.artifacts.subtitles.approved = null;
    const approvedRelative = `output/${safeAudioStem(task.inputs.audio.original_name)}.approved.srt`;
    task.artifacts.outputs = task.artifacts.outputs.filter((item) => item !== approvedRelative);
    await rm(taskPath(root, approvedRelative), { force: true });
    await persistTaskRecordV2(root, task);
    return review;
  });
}

export async function acceptAllReviewChanges(
  taskDirectory: string,
  input: { confirmCount: number; actor: ReviewActor; now?: () => Date },
): Promise<ReviewRecordV1> {
  const root = path.resolve(taskDirectory);
  return withReviewLock(root, async () => {
    const { task, review } = await verifiedReview(root);
    if (review.counts.pending !== input.confirmCount) throw new MercuryError('REVIEW_CONFIRM_COUNT_STALE', `当前仍有 ${review.counts.pending} 项待决定；确认数量已变化。`);
    const at = (input.now ?? (() => new Date()))().toISOString();
    for (const change of review.changes.filter((item) => item.decision === 'pending')) {
      change.decision = 'accepted';
      change.final_text = change.proposed_text;
      change.decided_at = at;
      change.actor = input.actor;
      change.history.push({ decision: 'accepted', final_text: change.proposed_text, decided_at: at, actor: input.actor });
    }
    review.batches.push({ batch_id: `batch-${randomBytes(8).toString('hex')}`, operation: 'accept_all', count: input.confirmCount, occurred_at: at, actor: input.actor });
    review.counts = counts(review.changes);
    review.updated_at = at;
    review.status = statusFor(review);
    await writeReview(root, review);
    task.artifacts.review = { path: 'review.json', status: review.status, pending_count: review.counts.pending };
    await persistTaskRecordV2(root, task);
    return review;
  });
}

async function writeTextAtomic(target: string, value: string): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function remapBoundary(
  boundary: number,
  patches: Array<{ start: number; end: number; replacement: string }>,
): number {
  let delta = 0;
  for (const patch of patches) {
    if (boundary <= patch.start) break;
    if (boundary >= patch.end) {
      delta += patch.replacement.length - (patch.end - patch.start);
      continue;
    }
    const ratio = (boundary - patch.start) / (patch.end - patch.start);
    return patch.start + delta + Math.round(ratio * patch.replacement.length);
  }
  return boundary + delta;
}

function applyReviewDecisions(
  segments: CalibratedSubtitleSegment[],
  changes: ReviewRecordV1['changes'],
): CalibratedSubtitleSegment[] {
  const result = segments.map((segment) => ({ ...segment, text: flat(segment.text) }));
  const groups: Array<{
    indexes: Set<number>;
    changes: ReviewRecordV1['changes'];
  }> = [];
  for (const change of changes) {
    if (!change.final_text) throw new MercuryError('REVIEW_PENDING_CHANGES', '存在尚未决定的修改。');
    const overlapping = groups.filter((group) =>
      change.target_segment_indexes.some((index) => group.indexes.has(index)),
    );
    if (overlapping.length === 0) {
      groups.push({
        indexes: new Set(change.target_segment_indexes),
        changes: [change],
      });
      continue;
    }
    const primary = overlapping[0]!;
    for (const index of change.target_segment_indexes) primary.indexes.add(index);
    primary.changes.push(change);
    for (const merged of overlapping.slice(1)) {
      for (const index of merged.indexes) primary.indexes.add(index);
      primary.changes.push(...merged.changes);
      groups.splice(groups.indexOf(merged), 1);
    }
  }
  for (const group of groups) {
    const indexes = [...group.indexes].sort((a, b) => a - b);
    if (indexes.some((index) => !Number.isSafeInteger(index) || !result[index])) {
      throw new MercuryError('REVIEW_MAPPING_INVALID', '审阅修改引用了不存在的输出片段。');
    }
    const pieces = indexes.map((index) => flat(result[index]!.text));
    const original = pieces.join('');
    const componentPosition = new Map(indexes.map((index, position) => [index, position]));
    const componentOffsets: number[] = [];
    let componentLength = 0;
    for (const piece of pieces) {
      componentOffsets.push(componentLength);
      componentLength += piece.length;
    }
    const patches = group.changes
      .map((change) => {
        const targetPositions = change.target_segment_indexes.map((index) => componentPosition.get(index));
        if (
          targetPositions.some((position) => position === undefined)
          || change.target_segment_indexes.some((index, position) =>
            position > 0 && index !== change.target_segment_indexes[position - 1]! + 1,
          )
          || targetPositions.some((position, index) =>
            index > 0 && position !== targetPositions[index - 1]! + 1,
          )
        ) {
          throw new MercuryError('REVIEW_MAPPING_INVALID', '审阅修改引用了不连续的输出片段。');
        }
        const offset = componentOffsets[targetPositions[0]!]!;
        return {
          start: offset + change.target_text_start,
          end: offset + change.target_text_end,
          replacement: change.final_text!,
          expected: change.proposed_text,
        };
      })
      .sort((a, b) => a.start - b.start);
    for (const [index, patch] of patches.entries()) {
      if (patch.end > original.length || original.slice(patch.start, patch.end) !== patch.expected || (index > 0 && patch.start < patches[index - 1]!.end)) {
        throw new MercuryError('REVIEW_MAPPING_INVALID', '审阅修改与权威校验后正文不一致。');
      }
    }
    let cursor = 0;
    let combined = '';
    for (const patch of patches) {
      combined += original.slice(cursor, patch.start) + patch.replacement;
      cursor = patch.end;
    }
    combined += original.slice(cursor);
    const originalBoundaries: number[] = [];
    let length = 0;
    for (const piece of pieces.slice(0, -1)) { length += piece.length; originalBoundaries.push(length); }
    if (combined.length < indexes.length) {
      throw new MercuryError(
        'REVIEW_TEXT_DISTRIBUTION_UNSAFE',
        `审阅文字不足以安全分配到 ${indexes.length} 个既有字幕片段；请保留至少 ${indexes.length} 个可见字符，或修改为更完整的文字。时间轴未改变。`,
      );
    }
    const boundaries: number[] = [];
    let prior = 0;
    originalBoundaries.forEach((boundary, position) => {
      const remainingSegments = indexes.length - position - 1;
      const desired = remapBoundary(boundary, patches);
      const next = Math.max(prior + 1, Math.min(desired, combined.length - remainingSegments));
      boundaries.push(next);
      prior = next;
    });
    let start = 0;
    indexes.forEach((segmentIndex, position) => {
      const end = boundaries[position] ?? combined.length;
      const text = combined.slice(start, end).trim();
      if (!text) throw new MercuryError('REVIEW_TEXT_INVALID', '审阅决定无法确定性分配到非空字幕片段。');
      result[segmentIndex] = { ...result[segmentIndex]!, text };
      start = end;
    });
  }
  return result;
}

export async function finalizeReview(taskDirectory: string, now = () => new Date()): Promise<ReviewRecordV1> {
  const root = path.resolve(taskDirectory);
  return withReviewLock(root, async () => {
    const { task, review } = await verifiedReview(root);
    if (review.approved_artifact) {
      if ((await sha256File(taskPath(root, review.approved_artifact.path))) !== review.approved_artifact.sha256) throw new MercuryError('REVIEW_SOURCE_CONFLICT', '批准后字幕与审阅记录不一致。');
      task.artifacts.outputs = [...new Set([...task.artifacts.outputs, review.approved_artifact.path])];
      task.artifacts.review = { path: 'review.json', status: review.status, pending_count: review.counts.pending };
      if (task.artifacts.subtitles) task.artifacts.subtitles.approved = {
        path: review.approved_artifact.path,
        purpose: 'approved_result',
        sha256: review.approved_artifact.sha256,
        segment_count: review.approved_artifact.segment_count,
        validation: 'passed',
      };
      await persistTaskRecordV2(root, task);
      return review;
    }
    if (review.counts.pending > 0) throw new MercuryError('REVIEW_PENDING_CHANGES', `还有 ${review.counts.pending} 项修改未决定，不能生成批准稿。`);
    const calibrated = parseReferenceSrt(await readFile(taskPath(root, review.sources.calibrated_srt.path), 'utf8'));
    if (!calibrated.ok) throw new MercuryError('REVIEW_SOURCE_INVALID', 'AI 校验字幕无法解析。');
    const decided = applyReviewDecisions(
      calibrated.segments.map((segment, index) => ({
        subtitle_segment_id: `approved-source-${String(index + 1).padStart(4, '0')}`,
        index,
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        text: flat(segment.text),
        confidence: 'high' as const,
        asr_segment_refs: [],
        reference_segment_refs: [],
      })),
      review.changes,
    );
    const expected: CalibratedSubtitleSegment[] = decided.map((segment, index) => ({
      subtitle_segment_id: `approved-${String(index + 1).padStart(4, '0')}`,
      index,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      text: segment.text,
      confidence: 'high',
      asr_segment_refs: [],
      reference_segment_refs: [],
    }));
    if (
      expected.length !== calibrated.segments.length
      || expected.some((segment, index) =>
        segment.index !== index
        || segment.start_ms !== calibrated.segments[index]?.start_ms
        || segment.end_ms !== calibrated.segments[index]?.end_ms)
    ) {
      throw new MercuryError(
        'REVIEW_TIMELINE_CHANGED',
        '批准稿必须与 AI 校验稿保持完全相同的片段数、顺序和时间戳。',
      );
    }
    const source = `${expected.map((segment, index) => [String(index + 1), `${formatSrtTimestamp(segment.start_ms)} --> ${formatSrtTimestamp(segment.end_ms)}`, ...wrapSubtitleText(segment.text, task.input_config.mode)].join('\n')).join('\n\n')}\n`;
    const relative = `output/${safeAudioStem(task.inputs.audio.original_name)}.approved.srt`;
    const target = taskPath(root, relative);
    await writeTextAtomic(target, source);
    const validation = await validateSrtFile(target, {
      audioDurationMs: task.inputs.audio.duration_ms!,
      expectedSegments: expected,
      mode: task.input_config.mode,
      referenceSegments: null,
    });
    if (!validation.valid) {
      await rm(target, { force: true });
      throw new MercuryError('APPROVED_OUTPUT_VALIDATION_FAILED', validation.checks.filter((item) => item.status === 'failed').map((item) => item.message).join('；'));
    }
    const at = now().toISOString();
    review.approved_artifact = { path: relative, sha256: await sha256File(target), segment_count: expected.length, generated_at: at, validation: 'passed' };
    review.updated_at = at;
    review.status = review.changes.length ? 'approved' : 'not_required';
    await writeReview(root, review);
    task.artifacts.outputs = [...new Set([...task.artifacts.outputs, relative])];
    task.artifacts.review = { path: 'review.json', status: review.status, pending_count: 0 };
    if (task.artifacts.subtitles) task.artifacts.subtitles.approved = { path: relative, purpose: 'approved_result', sha256: review.approved_artifact.sha256, segment_count: expected.length, validation: 'passed' };
    await persistTaskRecordV2(root, task);
    return review;
  });
}
