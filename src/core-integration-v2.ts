import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AsrAdapter,
  CalibrationResult,
  CalibrationResultV3,
  ErrorRecord,
  ModelSnapshotEntry,
  ModelSnapshotV2,
  TranscriptRaw,
} from './contracts/index.js';
import {
  validateContract,
  validateV2Contract,
  validateV3CalibrationResult,
} from './contracts/index.js';
import {
  VolcengineAsrAdapter,
  type ResolvedVolcengineCredential,
} from './adapters/volcengine-asr.js';
import { VolcengineSubtitleAsrAdapter } from './adapters/volcengine-subtitle-asr.js';
import {
  createChatCalibrationRuntimeV2,
  type ChatCalibrationV2Dependencies,
} from './adapters/chat-calibration-v2.js';
import { MercuryError } from './errors.js';
import {
  readCredentialReference,
  readMp3DurationMs,
  resolveVolcengineCredentialReference,
} from './models.js';
import {
  normalizeReferenceSrtForCalibration,
  normalizeVisibleSubtitleText,
  parseReferenceSrt,
  runSubtitleCore,
  type CalibratedTranscript,
} from './subtitle-core/index.js';
import {
  serializeCalibratedSrt,
  validateSrtFile,
} from './output-report/srt.js';
import { safeAudioStem, sha256File, writeJsonAtomic } from './tasks.js';
import {
  persistTaskRecordV2,
  readTaskRecordV2,
  type TaskRecordV2,
  type TaskStatusV2,
} from './tasks-v2.js';
import { appendTaskEvent, withTaskTransitionLock } from './background/storage.js';

export interface CoreIntegrationV2Dependencies
  extends ChatCalibrationV2Dependencies {
  asrAdapter?: AsrAdapter;
  resolveAsrCredential?: (
    reference: string,
  ) => Promise<ResolvedVolcengineCredential>;
  fault?: (
    point: 'after_chat_response_persisted' | 'before_completed_commit',
    task: TaskRecordV2,
  ) => Promise<void> | void;
}
class LocalRecoveryRequired extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'LocalRecoveryRequired';
  }
}
const MODEL = 'work/model-snapshot.json',
  TRANSCRIPT = 'work/transcript.raw.json',
  ALIGNMENT = 'work/alignment.json',
  CALIBRATION = 'work/calibration-result.json',
  CALIBRATED = 'work/transcript.calibrated.json',
  REPORT = 'output/calibration-report.md';
function at(now: () => Date) {
  return now().toISOString();
}
function file(root: string, relative: string) {
  const value = path.resolve(root, ...relative.split('/'));
  if (!value.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', '任务路径越界。');
  return value;
}
function add(task: TaskRecordV2, p: string) {
  if (!task.artifacts.work.includes(p)) task.artifacts.work.push(p);
}
async function stage(
  root: string,
  task: TaskRecordV2,
  status: TaskStatusV2,
  last: TaskStatusV2,
  now: () => Date,
) {
  const background = task.schema_version === '4.0.0';
  task.execution.status = background ? 'running' : status;
  if (background)
    task.execution.stage = status as NonNullable<
      TaskRecordV2['execution']['stage']
    >;
  task.execution.last_completed_stage = last;
  task.updated_at = at(now);
  await persistTaskRecordV2(root, task);
  if (background) {
    const completedEvent = await appendTaskEvent(root, {
      taskId: task.task_id,
      sequence: (task.execution.last_event_sequence ?? 0) + 1,
      type: 'stage_completed',
      message: `处理阶段已完成：${last}。`,
      data: { stage: last },
      occurredAt: task.updated_at,
    });
    const event = await appendTaskEvent(root, {
      taskId: task.task_id,
      sequence: completedEvent.sequence + 1,
      type: 'stage_started',
      message: `任务进入处理阶段：${status}。`,
      data: { stage: status, last_completed_stage: last },
      occurredAt: task.updated_at,
    });
    task.execution.last_event_sequence = event.sequence;
    await persistTaskRecordV2(root, task);
  }
}

async function cancelAtSafeBoundary(
  root: string,
  task: TaskRecordV2,
  now: () => Date,
): Promise<TaskRecordV2 | null> {
  if (task.schema_version !== '4.0.0') return null;
  return withTaskTransitionLock(root, async () => {
    const latest = await readTaskRecordV2(root);
    if (!latest.execution.cancellation_requested_at || ['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(latest.execution.status)) return null;
    return markCancelled(root, latest, now);
  });
}

async function markProviderDispatch(
  root: string,
  task: TaskRecordV2,
  role: 'asr' | 'chat',
  now: () => Date,
): Promise<void> {
  if (task.schema_version !== '4.0.0') return;
  const latest = await withTaskTransitionLock(root, async () => {
    const current = await readTaskRecordV2(root);
    if (current.execution.cancellation_requested_at) {
      return markCancelled(root, current, now);
    }
    if (current.execution.status !== 'running') {
      throw new MercuryError(
        'TASK_EXECUTION_STATE_INVALID',
        `Provider dispatch 前任务状态已变为 ${current.execution.status}。`,
      );
    }
    if (role === 'chat') current.execution.provider_call!.asr.state = 'terminal';
    current.execution.provider_call![role].state = 'in_flight';
    current.execution.provider_call![role].evidence_ref = null;
    current.updated_at = at(now);
    await persistTaskRecordV2(root, current);
    return current;
  });
  task.execution = latest.execution;
  task.updated_at = latest.updated_at;
  if (latest.execution.status === 'cancelled') {
    throw new MercuryError(
      'TASK_CANCELLED_BEFORE_PROVIDER_DISPATCH',
      '取消已在 Provider 请求发出前生效。',
    );
  }
}

async function runRecoverableFault(
  fault: CoreIntegrationV2Dependencies['fault'],
  point: 'after_chat_response_persisted' | 'before_completed_commit',
  task: TaskRecordV2,
): Promise<void> {
  try {
    await fault?.(point, task);
  } catch (error) {
    throw new LocalRecoveryRequired(error);
  }
}

async function markCancelled(root: string, task: TaskRecordV2, now: () => Date): Promise<TaskRecordV2> {
  task.execution.status = 'cancelled';
  task.execution.stage = null;
  task.execution.ended_at = at(now);
  task.updated_at = task.execution.ended_at;
  task.error = null;
  task.failure_stage = null;
  const calibratedPath = `output/${safeAudioStem(task.inputs.audio.original_name)}.calibrated.srt`;
  const approvedPath = `output/${safeAudioStem(task.inputs.audio.original_name)}.approved.srt`;
  task.artifacts.outputs = task.artifacts.outputs.filter((item) => item !== calibratedPath && item !== approvedPath);
  if (task.artifacts.subtitles) {
    task.artifacts.subtitles.calibrated = null;
    task.artifacts.subtitles.approved = null;
  }
  await rm(file(root, calibratedPath), { force: true });
  await rm(file(root, approvedPath), { force: true });
  await persistTaskRecordV2(root, task);
  return task;
}

async function commitCompletedAtSafeBoundary(
  root: string,
  candidate: TaskRecordV2,
  now: () => Date,
): Promise<TaskRecordV2> {
  if (candidate.schema_version !== '4.0.0') {
    await persistTaskRecordV2(root, candidate);
    return candidate;
  }
  return withTaskTransitionLock(root, async () => {
    const latest = await readTaskRecordV2(root);
    if (latest.execution.cancellation_requested_at) return markCancelled(root, latest, now);
    if (latest.execution.status !== 'running') {
      throw new MercuryError('TASK_EXECUTION_STATE_INVALID', `完成提交前任务状态已变为 ${latest.execution.status}。`);
    }
    candidate.execution.cancellation_requested_at = null;
    candidate.execution.heartbeat_at = latest.execution.heartbeat_at ?? null;
    candidate.execution.last_event_sequence = Math.max(candidate.execution.last_event_sequence ?? 0, latest.execution.last_event_sequence ?? 0);
    await persistTaskRecordV2(root, candidate);
    return candidate;
  });
}
function taskError(
  task: TaskRecordV2,
  code: string,
  message: string,
  stageName: ErrorRecord['stage'],
  retryable = false,
): ErrorRecord {
  return {
    error_id: `${task.task_id}-${stageName}-${randomBytes(3).toString('hex')}`,
    code,
    message,
    stage: stageName,
    retryable,
  };
}
function recordAdapterFailure(
  task: TaskRecordV2,
  input: {
    failureId: string;
    category: 'asr' | 'chat';
    capability: 'transcription' | 'calibration';
    modelSnapshotRef: string;
    occurredAt: string;
    providerOutcomeCertainty: 'not_dispatched' | 'known_terminal' | 'outcome_unknown';
    errors: ErrorRecord[];
    warnings: TaskRecordV2['warnings'];
    call: unknown | null;
  },
) {
  task.adapter_failures.push({
    failure_id: input.failureId,
    task_id: task.task_id,
    model_category: input.category,
    capability: input.capability,
    model_snapshot_ref: input.modelSnapshotRef,
    occurred_at: input.occurredAt,
    provider_outcome_certainty: input.providerOutcomeCertainty,
    errors: input.errors,
    warnings: input.warnings,
    call: input.call,
  });
}

async function interruptProviderUnknown(
  root: string,
  task: TaskRecordV2,
  original: ErrorRecord,
  now: () => Date,
  snapshot: ModelSnapshotV2 | null = null,
  calibration: CalibrationResultV3 | null = null,
): Promise<TaskRecordV2> {
  const ended = at(now);
  task.execution.status = 'interrupted';
  task.execution.stage = null;
  task.execution.execution_interrupted = true;
  task.execution.ended_at = ended;
  task.updated_at = ended;
  task.error = {
    error_id: `${task.task_id}-provider-unknown`,
    code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN',
    message: `${original.message} Provider 结果无法确认；Mercury 不会自动重放或建议直接重试。`,
    stage: 'model_call',
    retryable: false,
  };
  task.failure_stage = 'model_call';
  const calibratedPath = `output/${safeAudioStem(task.inputs.audio.original_name)}.calibrated.srt`;
  const approvedPath = `output/${safeAudioStem(task.inputs.audio.original_name)}.approved.srt`;
  task.artifacts.outputs = task.artifacts.outputs.filter((item) => item !== calibratedPath && item !== approvedPath);
  if (task.artifacts.subtitles) {
    task.artifacts.subtitles.calibrated = null;
    task.artifacts.subtitles.approved = null;
  }
  await rm(file(root, calibratedPath), { force: true });
  await rm(file(root, approvedPath), { force: true });
  await persistTaskRecordV2(root, task);
  await finishReport(root, task, snapshot, calibration, null);
  return task;
}
export function legacyAsrEntry(
  entry: ModelSnapshotV2['models']['asr'],
): ModelSnapshotEntry {
  return {
    snapshot_entry_id: entry.snapshot_entry_id,
    role: 'asr',
    config_id: entry.model_id,
    name: entry.name,
    config_fingerprint: entry.config_fingerprint,
    adapter: 'volcengine_asr',
    model: entry.provider_model,
    runtime: 'cloud',
    endpoint: null,
    credential_ref: entry.credential_ref,
    provider_config: entry.provider_config,
    cloud_data_confirmation: entry.cloud_data_confirmation,
    check_snapshot: {
      check_id: entry.check_snapshot.check_id,
      config_id: entry.model_id,
      config_fingerprint: entry.config_fingerprint,
      role: 'asr',
      confirmation_ref: entry.check_snapshot.confirmation_ref,
      started_at: entry.check_snapshot.started_at,
      ended_at: entry.check_snapshot.ended_at,
      outcome: 'passed',
      actual_model: entry.check_snapshot.actual_model,
      capabilities: {
        role: 'asr',
        sample_sha256: '0'.repeat(64),
        language: 'zh-CN',
        mime_type: 'audio/mpeg',
        audio_input: 'audio_data_base64',
        max_input_bytes: 104857600,
        max_audio_duration_ms: 7200000,
        transcript_chars: 1,
        segment_count: 1,
        timing_granularity: 'segment',
      },
      error: null,
    },
  } as unknown as ModelSnapshotEntry;
}
function toLegacyCalibration(value: CalibrationResultV3): CalibrationResult {
  return {
    schema_version: '1.0.0',
    task_id: value.task_id,
    created_at: value.created_at,
    status: value.status,
    request: {
      transcript_ref: 'work/transcript.raw.json',
      reference_srt_ref: value.request.reference_srt_ref,
      mode: value.request.mode,
    },
    model_snapshot_ref: value.model_snapshot_ref,
    call: value.call,
    suggestions: value.suggestions
      .filter(
        (item) => item.kind !== 'uncertain' && item.suggested_text !== null,
      )
      .map((item) => ({
        suggestion_id: item.suggestion_id,
        kind: item.kind as 'text_correction' | 'segmentation' | 'timing',
        source_segment_refs: item.source_segment_refs,
        start_ms: item.start_ms,
        end_ms: item.end_ms,
        original_text: item.original_text,
        suggested_text: item.suggested_text!,
        rationale: item.rationale,
        confidence: item.confidence,
        disposition: 'not_applied',
        disposition_reason:
          item.disposition_reason === 'mode_disallows_change'
            ? 'mode_disallows_change'
            : 'insufficient_evidence',
      })),
    warnings: value.warnings,
    errors: value.errors,
  } as unknown as CalibrationResult;
}
function applyResults(
  result: CalibrationResultV3,
  calibrated: CalibratedTranscript,
): CalibrationResultV3 {
  const copy = structuredClone(result);
  for (const suggestion of copy.suggestions) {
    const modifications = calibrated.modifications.filter(
      (item) =>
        item.evidence.calibration_suggestion_ref === suggestion.suggestion_id,
    );
    suggestion.modification_refs = modifications.map(
      (item) => item.modification_id,
    );
    const applied = modifications.some((item) => item.applied);
    suggestion.disposition = applied ? 'applied' : 'not_applied';
    suggestion.disposition_reason = applied
      ? 'accepted_by_rules'
      : suggestion.kind === 'uncertain' || suggestion.suggested_text === null
        ? 'suggestion_incomplete'
        : modifications[0]?.reason.includes('mode')
          ? 'mode_disallows_change'
          : 'insufficient_evidence';
  }
  return copy;
}

function transcribedProjection(transcript: TranscriptRaw): CalibratedTranscript {
  return {
    artifact_version: '1.0.0',
    task_id: transcript.task_id,
    mode: null,
    thresholds_version: 'v0.1',
    source_refs: {
      transcript_ref: 'work/transcript.raw.json',
      calibration_ref: 'work/calibration-result.json',
      reference_srt_ref: null,
    },
    segments: transcript.segments.map((segment, index) => ({
      subtitle_segment_id: segment.segment_id,
      index,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      text: normalizeVisibleSubtitleText(segment.text).text,
      confidence: 'medium',
      asr_segment_refs: [segment.segment_id],
      reference_segment_refs: [],
    })),
    modifications: [],
    warnings: [],
  };
}
async function textAtomic(target: string, content: string) {
  const temp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  try {
    await writeFile(temp, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
function report(
  task: TaskRecordV2,
  snapshot: ModelSnapshotV2 | null,
  calibration: CalibrationResultV3 | null,
  calibrated: CalibratedTranscript | null,
): string {
  const chat = snapshot?.models.chat;
  const evidence =
    calibration?.request.evidence_mode ?? task.input_config.evidence_mode;
  const reason =
    calibration?.request.non_strong_reason ??
    task.input_config.non_strong_reason;
  const audio = calibration?.request.audio;
  return [
    '# Mercury 字幕校准工作报告',
    '',
    `- 任务 ID：\`${task.task_id}\``,
    `- 状态：\`${task.execution.status}\``,
    `- 校准范围：\`${task.input_config.mode ?? '仅 MP3'}\``,
    `- 证据模式：\`${evidence}\`（${evidence === 'audio_multimodal' ? '强校验' : '非强校验'}）`,
    `- 非强校验原因：${reason ?? '—'}`,
    `- 实际输入模态：${calibration?.request.input_modalities.join(', ') ?? (evidence === 'audio_multimodal' ? 'text, audio' : 'text')}`,
    `- ASR：${snapshot ? `${snapshot.models.asr.plugin_id}/${snapshot.models.asr.connection_type}/${snapshot.models.asr.provider_model}` : '—'}`,
    `- Chat：${chat ? `${chat.plugin_id}/${chat.connection_type}/${chat.provider_model}` : '—'}`,
    `- Chat 调用：${calibration ? `${calibration.call.call_id} / ${calibration.call.outcome}` : '未形成'}`,
    `- 强校验音频：${audio ? `${audio.bytes} bytes / ${audio.sha256}` : '未发送'}`,
    `- 校验策略：${calibration?.strategy.prompt_version ?? '—'} / ${calibration?.strategy.response_contract_version ?? '—'}`,
    `- 完整覆盖：${calibration ? `${calibration.strategy.input_unit_count} 输入 / ${calibration.strategy.returned_unit_count} 返回 / ${calibration.strategy.coverage_complete ? '通过' : '失败'}` : '未形成'}`,
    `- 输出预算与结束：${calibration ? `${calibration.strategy.output_budget_tokens} tokens / ${calibration.strategy.provider_finish_reason ?? 'Provider 未提供'}` : '—'}`,
    `- 文字修改：${calibration?.corrected_units.filter((item) => item.changed).length ?? 0}；已采用：${calibration?.suggestions.filter((item) => item.disposition === 'applied').length ?? 0}`,
    `- 结构与时间调整：${calibrated?.modifications.filter((item) => item.type !== 'text_correction').length ?? 0}`,
    `- 纯转写字幕：${task.artifacts.subtitles?.transcribed ? `${task.artifacts.subtitles.transcribed.path} / ${task.artifacts.subtitles.transcribed.sha256} / ${task.artifacts.subtitles.transcribed.segment_count} 段（未校验）` : '未生成'}`,
    `- 校验后字幕：${task.artifacts.subtitles?.calibrated ? `${task.artifacts.subtitles.calibrated.path} / ${task.artifacts.subtitles.calibrated.sha256} / ${task.artifacts.subtitles.calibrated.segment_count} 段` : '未生成'}`,
    `- 警告：${task.warnings.map((item) => `${item.code}: ${item.message}`).join('；') || '无'}`,
    `- 错误：${task.error ? `${task.error.code}: ${task.error.message}` : '无'}`,
    '',
    '> 强校验是本任务唯一一次 Chat 校准的证据模式，不是独立处理步骤。',
    '',
  ].join('\n');
}
async function finishReport(
  root: string,
  task: TaskRecordV2,
  snapshot: ModelSnapshotV2 | null,
  calibration: CalibrationResultV3 | null,
  calibrated: CalibratedTranscript | null,
  persist = true,
) {
  await textAtomic(
    file(root, REPORT),
    report(task, snapshot, calibration, calibrated),
  );
  task.artifacts.report = REPORT;
  if (persist) await persistTaskRecordV2(root, task);
}
async function fail(
  root: string,
  task: TaskRecordV2,
  error: ErrorRecord,
  now: () => Date,
  snapshot: ModelSnapshotV2 | null = null,
  calibration: CalibrationResultV3 | null = null,
) {
  task.execution.status = 'failed';
  if (task.schema_version === '4.0.0') task.execution.stage = null;
  task.execution.execution_interrupted = false;
  task.execution.ended_at = at(now);
  task.updated_at = task.execution.ended_at;
  task.error = error;
  task.failure_stage = error.stage;
  task.artifacts.outputs = task.artifacts.outputs.filter(
    (item) => !item.endsWith('.calibrated.srt'),
  );
  if (task.artifacts.subtitles) task.artifacts.subtitles.calibrated = null;
  const calibratedPath = `output/${safeAudioStem(task.inputs.audio.original_name)}.calibrated.srt`;
  await rm(file(root, calibratedPath), { force: true });
  await persistTaskRecordV2(root, task);
  await finishReport(root, task, snapshot, calibration, null);
  return task;
}

export async function executeCalibrationTaskV2(
  directory: string,
  dependencies: CoreIntegrationV2Dependencies = {},
): Promise<TaskRecordV2> {
  const root = path.resolve(directory);
  const task = await readTaskRecordV2(root);
  if (
    task.execution.status !== 'analyzing_audio' &&
    !(task.schema_version === '4.0.0' && task.execution.status === 'running')
  )
    throw new MercuryError(
      'TASK_EXECUTION_STATE_INVALID',
      `任务状态不能执行：${task.execution.status}`,
    );
  const now = dependencies.now ?? (() => new Date());
  let snapshot: ModelSnapshotV2 | null = null;
  let calibration: CalibrationResultV3 | null = null;
  try {
    const snapshotRaw = JSON.parse(
      await readFile(file(root, MODEL), 'utf8'),
    ) as unknown;
    const checkedSnapshot = validateV2Contract('model-snapshot', snapshotRaw);
    if (
      !checkedSnapshot.valid ||
      checkedSnapshot.value.task_id !== task.task_id
    )
      throw new MercuryError('MODEL_SNAPSHOT_INVALID', 'v2 模型快照无效。');
    snapshot = checkedSnapshot.value;
    if ((await sha256File(file(root, MODEL))) !== task.model_snapshot.sha256)
      throw new MercuryError(
        'MODEL_SNAPSHOT_HASH_MISMATCH',
        '模型快照哈希不匹配。',
      );
    const audioPath = file(root, task.inputs.audio.workspace_copy_path);
    if ((await sha256File(audioPath)) !== task.inputs.audio.sha256)
      throw new MercuryError(
        'INPUT_COPY_HASH_MISMATCH',
        '任务音频副本哈希不匹配。',
      );
    task.inputs.audio.duration_ms = await readMp3DurationMs(audioPath);
    if (task.schema_version === '4.0.0') {
      task.execution.stage = 'analyzing_audio';
      task.execution.safe_checkpoint = 'asr_not_started';
    }
    await persistTaskRecordV2(root, task);
    const cancelledBeforeAsr = await cancelAtSafeBoundary(root, task, now);
    if (cancelledBeforeAsr) return cancelledBeforeAsr;
    const persistedTranscript =
      task.schema_version === '4.0.0' &&
      task.execution.provider_call?.asr.evidence_ref === TRANSCRIPT &&
      ['response_persisted', 'terminal'].includes(
        task.execution.provider_call.asr.state,
      )
        ? (JSON.parse(await readFile(file(root, TRANSCRIPT), 'utf8')) as unknown)
        : null;
    let transcriptCandidate: unknown = persistedTranscript;
    if (transcriptCandidate === null) {
      const entry = legacyAsrEntry(snapshot.models.asr);
      const asr =
        dependencies.asrAdapter ??
        (snapshot.models.asr.plugin_id === 'volcengine_subtitle_asr'
          ? new VolcengineSubtitleAsrAdapter({
              readCredential:
                dependencies.readCredential ?? readCredentialReference,
              ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
            })
          : new VolcengineAsrAdapter({
              resolveCredential:
                dependencies.resolveAsrCredential ??
                resolveVolcengineCredentialReference,
              ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
            }));
      const beforeAsrDispatch = async () => {
        await markProviderDispatch(root, task, 'asr', now);
      };
      const asrResult = await asr.run({
        taskId: task.task_id,
        modelSnapshotRef: snapshot.snapshot_id,
        model: entry as any,
        audio: {
          sourcePath: audioPath,
          pathRef: task.inputs.audio.workspace_copy_path,
          sha256: task.inputs.audio.sha256,
          durationMs: task.inputs.audio.duration_ms,
          mimeType: 'audio/mpeg',
          language: 'zh-CN',
        },
        beforeProviderDispatch: beforeAsrDispatch,
      });
      if (asrResult.kind === 'failure') {
        if (task.schema_version === '4.0.0') {
          const current = await readTaskRecordV2(root);
          if (current.execution.status === 'cancelled') return current;
        }
        const certainty = asrResult.failure.provider_outcome_certainty
          ?? (asrResult.failure.call === null ? 'not_dispatched' : 'known_terminal');
        if (task.schema_version === '4.0.0' && task.execution.provider_call) {
          task.execution.provider_call.asr.state = certainty === 'outcome_unknown' ? 'in_flight' : 'terminal';
          task.execution.provider_call.asr.evidence_ref = `adapter_failure:${asrResult.failure.failure_id}`;
        }
        recordAdapterFailure(task, {
          failureId: asrResult.failure.failure_id,
          category: 'asr',
          capability: 'transcription',
          modelSnapshotRef: asrResult.failure.model_snapshot_ref,
          occurredAt: asrResult.failure.occurred_at,
          providerOutcomeCertainty: certainty,
          errors: asrResult.failure.errors,
          warnings: asrResult.failure.warnings,
          call: asrResult.failure.call,
        });
        if (certainty === 'outcome_unknown') {
          return interruptProviderUnknown(root, task, asrResult.failure.errors[0]!, now, snapshot);
        }
        return fail(root, task, asrResult.failure.errors[0]!, now, snapshot);
      }
      transcriptCandidate = asrResult.artifact;
    }
    const transcriptCheck = validateContract(
      'transcript.raw',
      transcriptCandidate,
    );
    if (!transcriptCheck.valid)
      throw new MercuryError(
        'ASR_ARTIFACT_INVALID',
        `ASR 产物无效：${transcriptCheck.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
      );
    const transcript = transcriptCheck.value;
    if (
      transcript.task_id !== task.task_id ||
      transcript.model_snapshot_ref !== snapshot.snapshot_id ||
      transcript.call.model_snapshot_entry_ref !==
        snapshot.models.asr.snapshot_entry_id ||
      transcript.audio.path_ref !== task.inputs.audio.workspace_copy_path ||
      transcript.audio.sha256 !== task.inputs.audio.sha256
    )
      throw new MercuryError(
        'ASR_ARTIFACT_MISMATCH',
        'ASR 产物与任务、模型快照或音频证据不匹配。',
      );
    await writeJsonAtomic(file(root, TRANSCRIPT), transcript);
    add(task, TRANSCRIPT);
    if (task.schema_version === '4.0.0' && task.execution.provider_call) {
      task.execution.provider_call.asr.state = 'response_persisted';
      task.execution.provider_call.asr.evidence_ref = TRANSCRIPT;
      task.execution.safe_checkpoint = 'asr_response_persisted';
    }
    if (!/\p{Script=Han}/u.test(transcript.full_text)) {
      task.execution.status = 'needs_input';
      task.execution.ended_at = at(now);
      task.error = taskError(
        task,
        'TRANSCRIPT_LANGUAGE_UNSUPPORTED',
        'ASR 转录没有中文内容。',
        'alignment',
      );
      await persistTaskRecordV2(root, task);
      await finishReport(root, task, snapshot, null, null);
      return task;
    }
    const transcribed = transcribedProjection(transcript);
    const transcribedRelative = `output/${safeAudioStem(task.inputs.audio.original_name)}.transcribed.srt`;
    await textAtomic(
      file(root, transcribedRelative),
      serializeCalibratedSrt(transcribed),
    );
    const transcribedValidation = await validateSrtFile(
      file(root, transcribedRelative),
      {
        audioDurationMs: task.inputs.audio.duration_ms,
        expectedSegments: transcribed.segments,
        mode: null,
        referenceSegments: null,
        purpose: 'transcribed',
      },
    );
    if (!transcribedValidation.valid) {
      await rm(file(root, transcribedRelative), { force: true });
      throw new MercuryError(
        'TRANSCRIBED_OUTPUT_VALIDATION_FAILED',
        transcribedValidation.checks
          .filter((item) => item.status === 'failed')
          .map((item) => item.message)
          .join('; '),
      );
    }
    task.artifacts.outputs = [transcribedRelative];
    if (task.artifacts.subtitles) {
      task.artifacts.subtitles.transcribed = {
        path: transcribedRelative,
        purpose: 'unverified_transcription',
        sha256: await sha256File(file(root, transcribedRelative)),
        segment_count: transcript.segments.length,
        validation: 'passed',
      };
    }
    await persistTaskRecordV2(root, task);
    const cancelledAfterAsr = await cancelAtSafeBoundary(root, task, now);
    if (cancelledAfterAsr) {
      await finishReport(root, task, snapshot, null, null);
      return cancelledAfterAsr;
    }
    const referenceEvidence = task.inputs.reference_srt
      ? await readFile(
          file(root, task.inputs.reference_srt.workspace_copy_path),
          'utf8',
        )
      : null;
    const reference = referenceEvidence === null
      ? null
      : normalizeReferenceSrtForCalibration(referenceEvidence);
    const preflightAt = at(now);
    const initial = runSubtitleCore({
      transcript,
      calibrationResult: {
        schema_version: '1.0.0',
        task_id: task.task_id,
        created_at: preflightAt,
        status: 'completed',
        request: {
          transcript_ref: TRANSCRIPT,
          reference_srt_ref: reference ? 'input/reference.srt' : null,
          mode: task.input_config.mode,
        },
        model_snapshot_ref: snapshot.snapshot_id,
        call: {
          call_id: 'preflight',
          model_snapshot_entry_ref: snapshot.models.chat.snapshot_entry_id,
          started_at: preflightAt,
          ended_at: preflightAt,
          outcome: 'completed',
          error_ref: null,
        },
        suggestions: [],
        warnings: [],
        errors: [],
      },
      referenceSrtText: reference,
      requestedMode: task.input_config.mode,
    });
    if (initial.alignment) {
      await writeJsonAtomic(file(root, ALIGNMENT), initial.alignment);
      add(task, ALIGNMENT);
    }
    if (initial.status === 'needs_input' || initial.status === 'rejected') {
      task.execution.status = 'needs_input';
      task.error = taskError(
        task,
        initial.issues[0]?.code ?? 'ALIGNMENT_FAILED',
        initial.issues[0]?.message ?? '对齐失败。',
        'alignment',
      );
      task.execution.ended_at = at(now);
      await persistTaskRecordV2(root, task);
      await finishReport(root, task, snapshot, null, null);
      return task;
    }
    if (initial.status !== 'completed' || initial.alignment === null) {
      task.execution.status = 'failed';
      task.error = taskError(
        task,
        initial.issues[0]?.code ?? 'ALIGNMENT_PREFLIGHT_FAILED',
        initial.issues[0]?.message ?? '对齐预检未形成可用时间证据。',
        'alignment',
      );
      task.execution.ended_at = at(now);
      await persistTaskRecordV2(root, task);
      await finishReport(root, task, snapshot, null, null);
      return task;
    }
    await stage(root, task, 'calibrating', 'aligning', now);
    if (task.schema_version === '4.0.0') task.execution.safe_checkpoint = 'chat_not_started';
    const cancelledBeforeChat = await cancelAtSafeBoundary(root, task, now);
    if (cancelledBeforeChat) {
      await finishReport(root, task, snapshot, null, null);
      return cancelledBeforeChat;
    }
    const audio =
      task.input_config.evidence_mode === 'audio_multimodal'
        ? {
            sourcePath: audioPath,
            pathRef: task.inputs.audio.workspace_copy_path,
            sha256: task.inputs.audio.sha256,
            bytes: task.inputs.audio.bytes,
            durationMs: task.inputs.audio.duration_ms,
            mimeType: 'audio/mpeg' as const,
          }
        : null;
    const persistedCalibration =
      task.schema_version === '4.0.0' &&
      task.execution.provider_call?.chat.evidence_ref === CALIBRATION &&
      ['response_persisted', 'terminal'].includes(
        task.execution.provider_call.chat.state,
      )
        ? (JSON.parse(
            await readFile(file(root, CALIBRATION), 'utf8'),
          ) as CalibrationResultV3)
        : null;
    if (persistedCalibration) {
      calibration = persistedCalibration;
    } else {
      const runtime = createChatCalibrationRuntimeV2(snapshot.models.chat, {
        ...dependencies,
        readCredential:
          dependencies.readCredential ?? readCredentialReference,
      });
      const chatResult = await runtime.run({
        taskId: task.task_id,
        modelSnapshotRef: snapshot.snapshot_id,
        model: snapshot.models.chat,
        transcript,
        alignment: initial.alignment,
        referenceSrt:
          reference === null
            ? null
            : { pathRef: 'input/reference.srt', text: reference },
        mode: task.input_config.mode,
        evidenceMode: task.input_config.evidence_mode,
        nonStrongReason: task.input_config.non_strong_reason,
        audio,
        beforeProviderDispatch: async () => {
          await markProviderDispatch(root, task, 'chat', now);
        },
      });
      if (chatResult.kind === 'failure') {
        if (task.schema_version === '4.0.0') {
          const current = await readTaskRecordV2(root);
          if (current.execution.status === 'cancelled') return current;
        }
        const certainty = chatResult.failure.provider_outcome_certainty
          ?? (chatResult.failure.call === null ? 'not_dispatched' : 'known_terminal');
        if (task.schema_version === '4.0.0' && task.execution.provider_call) {
          task.execution.provider_call.chat.state = certainty === 'outcome_unknown' ? 'in_flight' : 'terminal';
          task.execution.provider_call.chat.evidence_ref = `adapter_failure:${chatResult.failure.failure_id}`;
        }
        recordAdapterFailure(task, {
          failureId: chatResult.failure.failure_id,
          category: 'chat',
          capability: 'calibration',
          modelSnapshotRef: chatResult.failure.model_snapshot_ref,
          occurredAt: chatResult.failure.occurred_at,
          providerOutcomeCertainty: certainty,
          errors: chatResult.failure.errors,
          warnings: chatResult.failure.warnings,
          call: chatResult.failure.call,
        });
        if (certainty === 'outcome_unknown') {
          return interruptProviderUnknown(root, task, chatResult.failure.errors[0]!, now, snapshot);
        }
        return fail(root, task, chatResult.failure.errors[0]!, now, snapshot);
      }
      calibration = chatResult.artifact;
    }
    if (
      calibration.task_id !== task.task_id ||
      calibration.model_snapshot_ref !== snapshot.snapshot_id ||
      calibration.call.model_snapshot_entry_ref !==
        snapshot.models.chat.snapshot_entry_id ||
      calibration.request.evidence_mode !== task.input_config.evidence_mode ||
      calibration.request.non_strong_reason !==
        task.input_config.non_strong_reason
    )
      throw new MercuryError(
        'CALIBRATION_ARTIFACT_MISMATCH',
        '校准产物与任务、Chat 快照或证据决策不匹配。',
      );
    await writeJsonAtomic(file(root, CALIBRATION), calibration);
    add(task, CALIBRATION);
    if (task.schema_version === '4.0.0' && task.execution.provider_call && calibration.status === 'completed') {
      task.execution.provider_call.chat.state = 'response_persisted';
      task.execution.provider_call.chat.evidence_ref = CALIBRATION;
      task.execution.safe_checkpoint = 'chat_response_persisted';
    }
    if (calibration.status === 'failed') {
      const calibrationError = calibration.errors[0] as ErrorRecord | undefined;
      if (!calibrationError)
        throw new MercuryError(
          'CALIBRATION_RESULT_INVALID',
          '失败校准产物缺少错误记录。',
        );
      recordAdapterFailure(task, {
        failureId: `failure-${calibration.call.call_id}`,
        category: 'chat',
        capability: 'calibration',
        modelSnapshotRef: calibration.model_snapshot_ref,
        occurredAt: calibration.created_at,
        providerOutcomeCertainty: calibration.provider_outcome_certainty ?? 'known_terminal',
        errors: [calibrationError],
        warnings: calibration.warnings,
        call: calibration.call,
      });
      await persistTaskRecordV2(root, task);
      if (calibration.provider_outcome_certainty === 'outcome_unknown') {
        if (task.schema_version === '4.0.0' && task.execution.provider_call) {
          task.execution.provider_call.chat.state = 'in_flight';
          task.execution.provider_call.chat.evidence_ref = CALIBRATION;
        }
        return interruptProviderUnknown(root, task, calibrationError, now, snapshot, calibration);
      }
      if (task.schema_version === '4.0.0' && task.execution.provider_call) {
        task.execution.provider_call.chat.state = 'terminal';
        task.execution.provider_call.chat.evidence_ref = CALIBRATION;
      }
      return fail(root, task, calibrationError, now, snapshot, calibration);
    }
    await persistTaskRecordV2(root, task);
    await runRecoverableFault(
      dependencies.fault,
      'after_chat_response_persisted',
      task,
    );
    const cancelledAfterChat = await cancelAtSafeBoundary(root, task, now);
    if (cancelledAfterChat) return cancelledAfterChat;
    const subtitle = runSubtitleCore({
      transcript,
      calibrationResult: toLegacyCalibration(calibration),
      referenceSrtText: reference,
      requestedMode: task.input_config.mode,
    });
    if (subtitle.status !== 'completed')
      return fail(
        root,
        task,
        taskError(
          task,
          subtitle.issues[0]?.code ?? 'SUBTITLE_CORE_FAILED',
          subtitle.issues[0]?.message ?? '字幕规则应用失败。',
          'response_validation',
        ),
        now,
        snapshot,
        calibration,
      );
    if (task.input_config.mode !== 'text-only')
      await stage(root, task, 'segmenting', 'calibrating', now);
    calibration = applyResults(calibration, subtitle.artifact);
    const finalCheck = validateV3CalibrationResult(calibration);
    if (!finalCheck.valid)
      throw new MercuryError(
        'CALIBRATION_RESULT_INVALID',
        finalCheck.issues.map((item) => item.message).join('; '),
      );
    await writeJsonAtomic(file(root, CALIBRATION), calibration);
    await writeJsonAtomic(file(root, CALIBRATED), subtitle.artifact);
    add(task, CALIBRATED);
    await stage(
      root,
      task,
      'validating',
      task.input_config.mode === 'text-only' ? 'calibrating' : 'segmenting',
      now,
    );
    const srtRelative = `output/${safeAudioStem(task.inputs.audio.original_name)}.calibrated.srt`;
    await textAtomic(
      file(root, srtRelative),
      serializeCalibratedSrt(subtitle.artifact),
    );
    const parsedReference =
      reference === null ? null : parseReferenceSrt(reference);
    const validation = await validateSrtFile(file(root, srtRelative), {
      audioDurationMs: task.inputs.audio.duration_ms,
      expectedSegments: subtitle.artifact.segments,
      mode: subtitle.artifact.mode,
      referenceSegments:
        parsedReference && parsedReference.ok ? parsedReference.segments : null,
    });
    if (!validation.valid)
      throw new MercuryError(
        'OUTPUT_VALIDATION_FAILED',
        validation.checks
          .filter((item) => item.status === 'failed')
          .map((item) => item.message)
          .join('; '),
      );
    task.execution.status = 'completed';
    if (task.schema_version === '4.0.0') {
      task.execution.stage = null;
      task.execution.safe_checkpoint = 'outputs_validated';
      if (task.execution.provider_call) task.execution.provider_call.chat.state = 'terminal';
    }
    task.execution.last_completed_stage = 'validating';
    task.execution.ended_at = at(now);
    task.updated_at = task.execution.ended_at;
    task.artifacts.outputs = [
      ...(task.artifacts.subtitles?.transcribed
        ? [task.artifacts.subtitles.transcribed.path]
        : []),
      srtRelative,
    ];
    if (task.artifacts.subtitles) {
      task.artifacts.subtitles.calibrated = {
        path: srtRelative,
        purpose: 'calibrated_result',
        sha256: await sha256File(file(root, srtRelative)),
        segment_count: subtitle.artifact.segments.length,
        validation: 'passed',
      };
    }
    task.error = null;
    task.failure_stage = null;
    await finishReport(root, task, snapshot, calibration, subtitle.artifact, false);
    await runRecoverableFault(
      dependencies.fault,
      'before_completed_commit',
      task,
    );
    return commitCompletedAtSafeBoundary(root, task, now);
  } catch (error) {
    if (error instanceof LocalRecoveryRequired) throw error.cause;
    if (task.schema_version === '4.0.0') {
      const durable = await readTaskRecordV2(root);
      if (['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(durable.execution.status)) {
        return durable;
      }
      const calls = durable.execution.provider_call!;
      const responsePersisted = calls.asr.state === 'response_persisted'
        || calls.chat.state === 'response_persisted';
      const providerUnknown = calls.asr.state === 'in_flight'
        || calls.chat.state === 'in_flight';
      if (responsePersisted && !providerUnknown) {
        // The Worker owns local-only recovery after a durable Provider response.
        // Do not collapse a recoverable mapping/output fault into terminal failed.
        throw error;
      }
      if (providerUnknown) {
        // Once the durable dispatch checkpoint is in_flight, an escaping
        // adapter/plugin exception cannot prove that the Provider did not
        // receive the request. Preserve the checkpoint and stop all replay.
        return interruptProviderUnknown(
          root,
          durable,
          taskError(
            durable,
            'PROVIDER_OUTCOME_UNKNOWN_AFTER_DISPATCH',
            'Provider 请求发出后执行通道中断。',
            'model_call',
          ),
          now,
          snapshot,
          calibration,
        );
      }
    }
    return fail(
      root,
      task,
      taskError(
        task,
        error instanceof MercuryError ? error.code : 'TASK_PIPELINE_FAILED',
        error instanceof Error ? error.message : String(error),
        'execution',
      ),
      now,
      snapshot,
      calibration,
    );
  }
}
