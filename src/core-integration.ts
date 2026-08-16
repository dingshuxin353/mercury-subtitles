import { randomBytes } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedVolcengineCredential } from './adapters/volcengine-asr.js';
import type { GeminiAdapterDependencies } from './adapters/gemini-audio-verification.js';
import type {
  AdapterFailureRecord,
  AsrAdapter,
  AudioVerification,
  CalibrationAdapter,
  CalibrationResult,
  CallRecord,
  ErrorRecord,
  ModelSnapshot,
  TranscriptRaw
} from './contracts/index.js';
import { validateContract, validateContractGraph, validateV2Contract } from './contracts/index.js';
import { MercuryError } from './errors.js';
import {
  BuiltinPluginRegistry,
  createBuiltinPluginRegistry,
  type ProofreadingRuntime,
  type TranscriptionRuntime
} from './model-center/index.js';
import {
  readCredentialReference,
  readMp3DurationMs,
  resolveVolcengineCredentialReference
} from './models.js';
import { generateTaskOutputs } from './output-report/index.js';
import {
  alignTranscriptToReference,
  applyAudioVerificationFindings,
  audioOnlyAlignment,
  parseReferenceSrt,
  runSubtitleCore,
  textOnlyTimelineIssue,
  type AlignmentArtifact,
  type CalibratedTranscript,
  type SubtitleCoreIssue
} from './subtitle-core/index.js';
import {
  isTerminalTask,
  persistTaskRecord,
  readTaskRecord,
  sha256File,
  writeJsonAtomic,
  type TaskRecord,
  type TaskStatus
} from './tasks.js';

const MODEL_SNAPSHOT_PATH = 'work/model-snapshot.json';
const TRANSCRIPT_PATH = 'work/transcript.raw.json';
const ALIGNMENT_PATH = 'work/alignment.json';
const CALIBRATION_PATH = 'work/calibration-result.json';
const CALIBRATED_PATH = 'work/transcript.calibrated.json';
const AUDIO_VERIFICATION_PATH = 'work/audio-verification.json';
const EXECUTION_MARKER_PATH = 'logs/execution.json';

export interface CoreIntegrationDependencies extends GeminiAdapterDependencies {
  asrAdapter?: AsrAdapter;
  calibrationAdapter?: CalibrationAdapter;
  modelCenter?: BuiltinPluginRegistry;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  processId?: number;
  processExists?: (processId: number) => boolean;
  readCredential?: (reference: string) => Promise<string>;
  resolveAsrCredential?: (reference: string) => Promise<ResolvedVolcengineCredential>;
}

function injectedTranscriptionRuntime(adapter: AsrAdapter): TranscriptionRuntime {
  return {
    capability: 'transcription',
    run: (input) => adapter.run({
      ...input,
      model: { ...input.model, adapter: 'volcengine_asr' }
    } as unknown as Parameters<AsrAdapter['run']>[0])
  };
}

function injectedProofreadingRuntime(adapter: CalibrationAdapter): ProofreadingRuntime {
  return {
    capability: 'proofreading',
    run: (input) => adapter.run({
      ...input,
      model: { ...input.model, adapter: 'openai_chat_completions' }
    } as unknown as Parameters<CalibrationAdapter['run']>[0])
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function taskPath(taskDirectory: string, relativePath: string): string {
  const root = path.resolve(taskDirectory);
  const resolved = path.resolve(root, ...relativePath.split('/'));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new MercuryError('TASK_PATH_OUTSIDE_DIRECTORY', `任务相对路径越界：${relativePath}`);
  }
  return resolved;
}

function registerWorkArtifact(task: TaskRecord, relativePath: string): void {
  if (!task.artifacts.work.includes(relativePath)) task.artifacts.work.push(relativePath);
}

async function persistStage(
  taskDirectory: string,
  task: TaskRecord,
  status: TaskStatus,
  lastCompletedStage: TaskStatus,
  now: () => Date
): Promise<void> {
  task.execution.status = status;
  task.execution.last_completed_stage = lastCompletedStage;
  task.updated_at = timestamp(now);
  await persistTaskRecord(taskDirectory, task);
}

function taskError(
  task: TaskRecord,
  code: string,
  message: string,
  stage: ErrorRecord['stage'],
  retryable: boolean,
  remediation?: string
): ErrorRecord {
  return {
    error_id: `${task.task_id}-${stage}-${randomBytes(4).toString('hex')}`,
    code,
    message,
    stage,
    retryable,
    ...(remediation ? { remediation } : {})
  };
}

async function concludeAbnormally(
  taskDirectory: string,
  task: TaskRecord,
  status: 'failed' | 'needs_input',
  error: ErrorRecord,
  now: () => Date
): Promise<TaskRecord> {
  const endedAt = timestamp(now);
  task.execution.status = status;
  task.execution.ended_at = endedAt;
  task.updated_at = endedAt;
  task.error = error;
  task.failure_stage = error.stage;
  await persistTaskRecord(taskDirectory, task);
  return (await generateTaskOutputs(taskDirectory, { now })).task;
}

async function loadModelSnapshot(taskDirectory: string, task: TaskRecord): Promise<ModelSnapshot> {
  if (task.model_snapshot.path !== MODEL_SNAPSHOT_PATH || task.model_snapshot.sha256 === null) {
    throw new MercuryError('MODEL_SNAPSHOT_REFERENCE_INVALID', 'task.json 缺少有效的模型快照引用。');
  }
  const snapshotPath = taskPath(taskDirectory, task.model_snapshot.path);
  if (await sha256File(snapshotPath) !== task.model_snapshot.sha256) {
    throw new MercuryError('MODEL_SNAPSHOT_HASH_MISMATCH', '模型快照 SHA-256 与 task.json 不一致。');
  }
  const value = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
  const validation = validateContract('model-snapshot', value);
  if (!validation.valid || validation.value.task_id !== task.task_id) {
    throw new MercuryError('MODEL_SNAPSHOT_INVALID', '任务模型快照不符合 D001 协议或 task_id 不一致。');
  }
  return validation.value;
}

function notRequestedAudioVerification(task: TaskRecord, now: () => Date): AudioVerification {
  return {
    schema_version: '1.0.0',
    task_id: task.task_id,
    created_at: timestamp(now),
    status: 'not_requested',
    model_snapshot_ref: null,
    input: null,
    calls: [],
    staging: [],
    findings: [],
    application_results: [],
    skip_reason: null,
    warnings: [],
    errors: []
  };
}

async function persistNotRequestedAudioVerification(
  taskDirectory: string,
  task: TaskRecord,
  now: () => Date
): Promise<void> {
  const artifact = notRequestedAudioVerification(task, now);
  const validation = validateContract('audio-verification', artifact);
  if (!validation.valid) throw new MercuryError('AUDIO_VERIFICATION_CONTRACT_INVALID', 'not_requested 强校验产物不符合 D001 协议。');
  const artifactPath = taskPath(taskDirectory, AUDIO_VERIFICATION_PATH);
  await writeJsonAtomic(artifactPath, validation.value);
  task.audio_verification.artifact_path = AUDIO_VERIFICATION_PATH;
  task.audio_verification.sha256 = await sha256File(artifactPath);
  registerWorkArtifact(task, AUDIO_VERIFICATION_PATH);
  task.updated_at = timestamp(now);
  await persistTaskRecord(taskDirectory, task);
}

function verificationInput(task: TaskRecord) {
  return {
    audio_ref: task.inputs.audio.workspace_copy_path,
    audio_sha256: task.inputs.audio.sha256,
    transcript_ref: 'work/transcript.raw.json' as const,
    calibration_ref: 'work/calibration-result.json' as const,
    reference_srt_ref: task.inputs.reference_srt ? 'input/reference.srt' as const : null
  };
}

function skippedAudioVerification(
  task: TaskRecord,
  now: () => Date,
  reason: 'not_configured' | 'cloud_confirmation_missing' | 'check_missing_or_stale'
): AudioVerification {
  return {
    schema_version: '1.0.0', task_id: task.task_id, created_at: timestamp(now), status: 'skipped',
    model_snapshot_ref: null, input: verificationInput(task), calls: [], staging: [], findings: [],
    application_results: [], skip_reason: reason, warnings: [], errors: []
  };
}

async function persistAudioVerification(
  taskDirectory: string,
  task: TaskRecord,
  artifact: AudioVerification,
  now: () => Date
): Promise<void> {
  const validation = validateContract('audio-verification', artifact);
  if (!validation.valid || validation.value.task_id !== task.task_id) {
    throw new MercuryError('AUDIO_VERIFICATION_ARTIFACT_INVALID', '强校验 Adapter 返回的产物不符合 D001 协议。');
  }
  const artifactPath = taskPath(taskDirectory, AUDIO_VERIFICATION_PATH);
  await writeJsonAtomic(artifactPath, validation.value);
  task.audio_verification.artifact_path = AUDIO_VERIFICATION_PATH;
  task.audio_verification.sha256 = await sha256File(artifactPath);
  registerWorkArtifact(task, AUDIO_VERIFICATION_PATH);
  task.updated_at = timestamp(now);
  await persistTaskRecord(taskDirectory, task);
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function writeExecutionMarker(
  taskDirectory: string,
  task: TaskRecord,
  processId: number,
  now: () => Date
): Promise<void> {
  await writeJsonAtomic(taskPath(taskDirectory, EXECUTION_MARKER_PATH), {
    schema_version: '1.0.0',
    task_id: task.task_id,
    process_id: processId,
    started_at: timestamp(now)
  });
}

async function markerProcessId(taskDirectory: string, taskId: string): Promise<number | null> {
  try {
    const marker = JSON.parse(await readFile(taskPath(taskDirectory, EXECUTION_MARKER_PATH), 'utf8')) as Record<string, unknown>;
    return marker.task_id === taskId && Number.isSafeInteger(marker.process_id) && Number(marker.process_id) > 0
      ? Number(marker.process_id)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export async function reconcileInterruptedTask(
  taskDirectory: string,
  dependencies: Pick<CoreIntegrationDependencies, 'now' | 'processExists'> = {}
): Promise<TaskRecord> {
  const resolvedDirectory = path.resolve(taskDirectory);
  const task = await readTaskRecord(resolvedDirectory);
  if (isTerminalTask(task)) return task;
  if (task.execution.execution_interrupted) {
    if (task.artifacts.report) return task;
    return (await generateTaskOutputs(
      resolvedDirectory,
      dependencies.now ? { now: dependencies.now } : {}
    )).task;
  }
  const markerPid = await markerProcessId(resolvedDirectory, task.task_id);
  if (markerPid !== null && (dependencies.processExists ?? processIsAlive)(markerPid)) return task;

  const now = dependencies.now ?? (() => new Date());
  task.execution.execution_interrupted = true;
  task.updated_at = timestamp(now);
  if (!task.warnings.some((warning) => warning.code === 'TASK_EXECUTION_INTERRUPTED')) {
    task.warnings.push({
      warning_id: `${task.task_id}-execution-interrupted`,
      code: 'TASK_EXECUTION_INTERRUPTED',
      message: '执行进程已不存在；任务保留最后持久化的非终态，未自动恢复或改写为终态。',
      stage: 'execution',
      severity: 'high'
    });
  }
  await persistTaskRecord(resolvedDirectory, task);
  await rm(taskPath(resolvedDirectory, EXECUTION_MARKER_PATH), { force: true });
  return (await generateTaskOutputs(resolvedDirectory, { now })).task;
}

function syntheticAdapterFailure(
  task: TaskRecord,
  snapshot: ModelSnapshot,
  role: 'asr' | 'calibration',
  error: ErrorRecord,
  now: () => Date,
  call: CallRecord | null = null
): AdapterFailureRecord {
  return {
    failure_id: `${task.task_id}-${role}-failure-${randomBytes(3).toString('hex')}`,
    task_id: task.task_id,
    role,
    model_snapshot_ref: snapshot.snapshot_id,
    occurred_at: timestamp(now),
    provider_outcome_certainty: call === null ? 'not_dispatched' : 'known_terminal',
    errors: [error],
    warnings: [],
    call,
    staging: []
  };
}

function validAdapterFailure(
  value: unknown,
  snapshot: ModelSnapshot,
  role: 'asr' | 'calibration'
): value is AdapterFailureRecord {
  if (!value || typeof value !== 'object' || (value as AdapterFailureRecord).role !== role) return false;
  const validation = validateContractGraph({ modelSnapshot: snapshot, adapterFailures: [value as AdapterFailureRecord] });
  return validation.valid;
}

function transcriptGraphIsValid(
  task: TaskRecord,
  snapshot: ModelSnapshot,
  transcript: TranscriptRaw
): boolean {
  const availableTaskFiles = [
    task.inputs.audio.workspace_copy_path,
    ...(transcript.raw_response_ref === null ? [] : [transcript.raw_response_ref])
  ];
  return validateContractGraph({
    modelSnapshot: snapshot,
    transcriptRaw: transcript,
    availableTaskFiles
  }).valid;
}

function calibrationGraphIsValid(
  task: TaskRecord,
  snapshot: ModelSnapshot,
  transcript: TranscriptRaw,
  calibrationResult: CalibrationResult
): boolean {
  const availableTaskFiles = [
    task.inputs.audio.workspace_copy_path,
    TRANSCRIPT_PATH,
    ...(task.inputs.reference_srt ? [task.inputs.reference_srt.workspace_copy_path] : []),
    ...(transcript.raw_response_ref === null ? [] : [transcript.raw_response_ref])
  ];
  return validateContractGraph({
    modelSnapshot: snapshot,
    transcriptRaw: transcript,
    calibrationResult,
    availableTaskFiles
  }).valid;
}

function audioVerificationGraphIsValid(
  task: TaskRecord,
  snapshot: ModelSnapshot,
  transcript: TranscriptRaw,
  calibrationResult: CalibrationResult,
  calibrated: CalibratedTranscript,
  audioVerification: AudioVerification
): boolean {
  return validateContractGraph({
    modelSnapshot: snapshot,
    transcriptRaw: transcript,
    calibrationResult,
    audioVerification,
    availableTaskFiles: [
      task.inputs.audio.workspace_copy_path,
      TRANSCRIPT_PATH,
      CALIBRATION_PATH,
      ...(task.inputs.reference_srt ? [task.inputs.reference_srt.workspace_copy_path] : []),
      ...(transcript.raw_response_ref === null ? [] : [transcript.raw_response_ref])
    ],
    availableModificationIds: calibrated.modifications.map((entry) => entry.modification_id),
    availableReferenceSegmentIds: [...new Set(
      calibrated.segments.flatMap((segment) => segment.reference_segment_refs)
    )]
  }).valid;
}

async function persistAdapterFailure(
  taskDirectory: string,
  task: TaskRecord,
  failure: AdapterFailureRecord,
  now: () => Date
): Promise<void> {
  task.adapter_failures.push(failure);
  task.updated_at = timestamp(now);
  await persistTaskRecord(taskDirectory, task);
}

async function failForAdapter(
  taskDirectory: string,
  task: TaskRecord,
  failure: AdapterFailureRecord,
  now: () => Date
): Promise<TaskRecord> {
  await persistAdapterFailure(taskDirectory, task, failure, now);
  return concludeAbnormally(taskDirectory, task, 'failed', failure.errors[0], now);
}

async function persistTranscript(
  taskDirectory: string,
  task: TaskRecord,
  transcript: TranscriptRaw,
  snapshot: ModelSnapshot,
  now: () => Date
): Promise<TaskRecord | null> {
  if (transcript.raw_response_ref !== null) {
    try {
      const responseFile = taskPath(taskDirectory, transcript.raw_response_ref);
      const details = await stat(responseFile);
      if (!details.isFile()) throw new Error('not a regular file');
    } catch {
      const error = taskError(task, 'ASR_RAW_RESPONSE_MISSING', 'ASR 产物引用的脱敏供应商响应不存在。', 'artifact_write', false);
      const failure = syntheticAdapterFailure(task, snapshot, 'asr', error, now, transcript.call);
      await failForAdapter(taskDirectory, task, failure, now);
      return null;
    }
  }
  try {
    await writeJsonAtomic(taskPath(taskDirectory, TRANSCRIPT_PATH), transcript);
  } catch {
    const error = taskError(task, 'ASR_ARTIFACT_WRITE_FAILED', '无法原子写入 transcript.raw.json。', 'artifact_write', false);
    const failure = syntheticAdapterFailure(task, snapshot, 'asr', error, now, transcript.call);
    await failForAdapter(taskDirectory, task, failure, now);
    return null;
  }
  registerWorkArtifact(task, TRANSCRIPT_PATH);
  if (transcript.raw_response_ref !== null) registerWorkArtifact(task, transcript.raw_response_ref);
  await persistStage(taskDirectory, task, 'aligning', 'analyzing_audio', now);
  return task;
}

function alignmentPreflight(
  transcript: TranscriptRaw,
  referenceSrtText: string | null,
  mode: 'text-only' | 'text-and-segmentation' | null
): { alignment: AlignmentArtifact | null; issue: SubtitleCoreIssue | null } {
  if (referenceSrtText === null) return { alignment: audioOnlyAlignment(transcript), issue: null };
  const parsed = parseReferenceSrt(referenceSrtText);
  if (!parsed.ok) return { alignment: null, issue: parsed.issue };
  if (mode === 'text-only') {
    const issue = textOnlyTimelineIssue(parsed.segments, transcript.audio.duration_ms);
    if (issue) return { alignment: null, issue };
  }
  const alignment = alignTranscriptToReference(transcript, parsed.segments);
  return alignment.conclusion === 'matched'
    ? { alignment, issue: null }
    : {
        alignment,
        issue: {
          code: 'REFERENCE_AUDIO_MISMATCH',
          message: '参考 SRT 与 ASR 的双向文字覆盖率未同时达到 80%。',
          remediation: '确认参考 SRT 属于当前音频后，创建新任务重试。'
        }
      };
}

async function writeAlignment(taskDirectory: string, task: TaskRecord, alignment: AlignmentArtifact, now: () => Date): Promise<void> {
  await writeJsonAtomic(taskPath(taskDirectory, ALIGNMENT_PATH), alignment);
  registerWorkArtifact(task, ALIGNMENT_PATH);
  task.updated_at = timestamp(now);
  await persistTaskRecord(taskDirectory, task);
}

function issueError(task: TaskRecord, issue: SubtitleCoreIssue, stage: ErrorRecord['stage']): ErrorRecord {
  return taskError(task, issue.code, issue.message, stage, false, issue.remediation);
}

async function executePreparedTask(
  taskDirectory: string,
  task: TaskRecord,
  snapshot: ModelSnapshot,
  dependencies: CoreIntegrationDependencies,
  now: () => Date
): Promise<TaskRecord> {
  if (!task.audio_verification.requested) await persistNotRequestedAudioVerification(taskDirectory, task, now);

  const audioPath = taskPath(taskDirectory, task.inputs.audio.workspace_copy_path);
  if (await sha256File(audioPath) !== task.inputs.audio.sha256) {
    throw new MercuryError('INPUT_COPY_HASH_MISMATCH', '任务内 MP3 副本的 SHA-256 与 task.json 不一致。');
  }
  task.inputs.audio.duration_ms = await readMp3DurationMs(audioPath);
  task.updated_at = timestamp(now);
  await persistTaskRecord(taskDirectory, task);

  const modelCenter = dependencies.modelCenter ?? createBuiltinPluginRegistry();
  const transcription = dependencies.asrAdapter
    ? {
        entry: snapshot.models.asr as unknown as Parameters<TranscriptionRuntime['run']>[0]['model'],
        runtime: injectedTranscriptionRuntime(dependencies.asrAdapter)
      }
    : modelCenter.resolveTranscription(snapshot.models.asr, {
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        resolveAsrCredential: dependencies.resolveAsrCredential ?? resolveVolcengineCredentialReference
      });
  let asrResult: Awaited<ReturnType<TranscriptionRuntime['run']>>;
  try {
    asrResult = await transcription.runtime.run({
      taskId: task.task_id,
      modelSnapshotRef: snapshot.snapshot_id,
      model: transcription.entry,
      audio: {
        sourcePath: audioPath,
        pathRef: task.inputs.audio.workspace_copy_path,
        sha256: task.inputs.audio.sha256,
        durationMs: task.inputs.audio.duration_ms,
        mimeType: 'audio/mpeg',
        language: 'zh-CN'
      }
    });
  } catch {
    const error = taskError(task, 'ASR_ADAPTER_EXECUTION_FAILED', 'ASR Adapter 未能返回合法终态结果。', 'artifact_write', true);
    return failForAdapter(taskDirectory, task, syntheticAdapterFailure(task, snapshot, 'asr', error, now), now);
  }
  if (asrResult.kind === 'failure') {
    const failure = validAdapterFailure(asrResult.failure, snapshot, 'asr')
      ? asrResult.failure
      : syntheticAdapterFailure(
          task,
          snapshot,
          'asr',
          taskError(task, 'ASR_ADAPTER_FAILURE_INVALID', 'ASR Adapter 返回的失败记录不符合 D001 协议。', 'artifact_write', false),
          now
        );
    return failForAdapter(taskDirectory, task, failure, now);
  }
  const transcriptValidation = validateContract('transcript.raw', asrResult.artifact);
  if (
    !transcriptValidation.valid ||
    transcriptValidation.value.task_id !== task.task_id ||
    !transcriptGraphIsValid(task, snapshot, transcriptValidation.value)
  ) {
    const error = taskError(task, 'ASR_ARTIFACT_INVALID', 'ASR Adapter 返回的 transcript.raw 不符合 D001 或任务身份不一致。', 'artifact_write', false);
    return failForAdapter(taskDirectory, task, syntheticAdapterFailure(task, snapshot, 'asr', error, now), now);
  }
  const transcript = transcriptValidation.value;
  if (await persistTranscript(taskDirectory, task, transcript, snapshot, now) === null) return readTaskRecord(taskDirectory);

  if (!/\p{Script=Han}/u.test(transcript.full_text)) {
    return concludeAbnormally(
      taskDirectory,
      task,
      'needs_input',
      taskError(
        task,
        'TRANSCRIPT_LANGUAGE_UNSUPPORTED',
        'ASR 转录没有可确认的中文内容，无法进入字幕校准。',
        'alignment',
        false,
        '确认音频包含清晰中文人声后创建新任务。'
      ),
      now
    );
  }

  const referenceSrtText = task.inputs.reference_srt
    ? await (async () => {
        const referencePath = taskPath(taskDirectory, task.inputs.reference_srt!.workspace_copy_path);
        if (await sha256File(referencePath) !== task.inputs.reference_srt!.sha256) {
          throw new MercuryError('INPUT_COPY_HASH_MISMATCH', '任务内参考 SRT 副本的 SHA-256 与 task.json 不一致。');
        }
        return readFile(referencePath, 'utf8');
      })()
    : null;
  const alignmentResult = alignmentPreflight(transcript, referenceSrtText, task.input_config.mode);
  if (alignmentResult.alignment) await writeAlignment(taskDirectory, task, alignmentResult.alignment, now);
  if (alignmentResult.issue) {
    task.execution.last_completed_stage = 'aligning';
    return concludeAbnormally(taskDirectory, task, 'needs_input', issueError(task, alignmentResult.issue, 'alignment'), now);
  }
  await persistStage(taskDirectory, task, 'calibrating', 'aligning', now);

  const proofreading = dependencies.calibrationAdapter
    ? {
        entry: snapshot.models.calibration as unknown as Parameters<ProofreadingRuntime['run']>[0]['model'],
        runtime: injectedProofreadingRuntime(dependencies.calibrationAdapter)
      }
    : modelCenter.resolveProofreading(snapshot.models.calibration, {
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        readCredential: dependencies.readCredential ?? readCredentialReference
      });
  let calibrationResult: Awaited<ReturnType<ProofreadingRuntime['run']>>;
  try {
    calibrationResult = await proofreading.runtime.run({
      taskId: task.task_id,
      modelSnapshotRef: snapshot.snapshot_id,
      model: proofreading.entry,
      transcript,
      referenceSrt: referenceSrtText === null ? null : { pathRef: 'input/reference.srt', text: referenceSrtText },
      mode: task.input_config.mode
    });
  } catch {
    const error = taskError(task, 'CALIBRATION_ADAPTER_EXECUTION_FAILED', '校准 Adapter 未能返回合法终态结果。', 'artifact_write', true);
    return failForAdapter(taskDirectory, task, syntheticAdapterFailure(task, snapshot, 'calibration', error, now), now);
  }
  if (calibrationResult.kind === 'failure') {
    const failure = validAdapterFailure(calibrationResult.failure, snapshot, 'calibration')
      ? calibrationResult.failure
      : syntheticAdapterFailure(
          task,
          snapshot,
          'calibration',
          taskError(task, 'CALIBRATION_ADAPTER_FAILURE_INVALID', '校准 Adapter 返回的失败记录不符合 D001 协议。', 'artifact_write', false),
          now
        );
    return failForAdapter(taskDirectory, task, failure, now);
  }
  const calibrationValidation = validateContract('calibration-result', calibrationResult.artifact);
  if (
    !calibrationValidation.valid ||
    calibrationValidation.value.task_id !== task.task_id ||
    !calibrationGraphIsValid(task, snapshot, transcript, calibrationValidation.value)
  ) {
    const error = taskError(task, 'CALIBRATION_ARTIFACT_INVALID', '校准 Adapter 返回的结果不符合 D001 或任务身份不一致。', 'artifact_write', false);
    return failForAdapter(taskDirectory, task, syntheticAdapterFailure(task, snapshot, 'calibration', error, now), now);
  }
  const calibrationArtifact = calibrationValidation.value;
  try {
    await writeJsonAtomic(taskPath(taskDirectory, CALIBRATION_PATH), calibrationArtifact);
  } catch {
    const error = taskError(task, 'CALIBRATION_ARTIFACT_WRITE_FAILED', '无法原子写入 calibration-result.json。', 'artifact_write', false);
    return failForAdapter(
      taskDirectory,
      task,
      syntheticAdapterFailure(task, snapshot, 'calibration', error, now, calibrationArtifact.call),
      now
    );
  }
  registerWorkArtifact(task, CALIBRATION_PATH);
  task.updated_at = timestamp(now);
  await persistTaskRecord(taskDirectory, task);
  if (calibrationArtifact.status === 'failed') {
    return concludeAbnormally(taskDirectory, task, 'failed', calibrationArtifact.errors[0] as ErrorRecord, now);
  }

  const subtitleResult = runSubtitleCore({
    transcript,
    calibrationResult: calibrationArtifact as CalibrationResult,
    referenceSrtText,
    requestedMode: task.input_config.mode
  });
  if (subtitleResult.alignment) await writeAlignment(taskDirectory, task, subtitleResult.alignment, now);
  if (subtitleResult.status !== 'completed') {
    const issue = subtitleResult.issues[0] ?? { code: 'SUBTITLE_CORE_FAILED', message: '字幕核心未形成合法结果。' };
    return concludeAbnormally(
      taskDirectory,
      task,
      subtitleResult.status === 'needs_input' || subtitleResult.status === 'rejected' ? 'needs_input' : 'failed',
      issueError(task, issue, subtitleResult.status === 'needs_input' ? 'alignment' : 'response_validation'),
      now
    );
  }

  if (task.input_config.mode !== 'text-only') {
    await persistStage(taskDirectory, task, 'segmenting', 'calibrating', now);
  }
  let calibratedArtifact = subtitleResult.artifact;
  if (task.audio_verification.requested) {
    await persistStage(
      taskDirectory,
      task,
      'verifying_audio',
      task.input_config.mode === 'text-only' ? 'calibrating' : 'segmenting',
      now
    );
    const audioModel = snapshot.models.audio_verification;
    if (!audioModel) {
      const warningCode = task.warnings.find((warning) => warning.code.startsWith('AUDIO_VERIFICATION_'))?.code;
      const reason = warningCode?.endsWith('CLOUD_CONFIRMATION_MISSING')
        ? 'cloud_confirmation_missing'
        : warningCode?.endsWith('CHECK_MISSING_OR_STALE')
          ? 'check_missing_or_stale'
          : 'not_configured';
      await persistAudioVerification(taskDirectory, task, skippedAudioVerification(task, now, reason), now);
    } else {
      try {
        const verification = modelCenter.resolveAudioVerification(audioModel, {
          readCredential: dependencies.readCredential ?? readCredentialReference,
          ...(dependencies.createDeveloperClient ? { createDeveloperClient: dependencies.createDeveloperClient } : {}),
          ...(dependencies.createVertexClient ? { createVertexClient: dependencies.createVertexClient } : {}),
          ...(dependencies.now ? { now: dependencies.now } : {}),
          ...(dependencies.createId ? { createId: dependencies.createId } : {})
        });
        const verificationResult = await verification.runtime.run({
          taskId: task.task_id,
          modelSnapshotRef: snapshot.snapshot_id,
          model: verification.entry,
          audio: {
            sourcePath: audioPath, pathRef: task.inputs.audio.workspace_copy_path,
            sha256: task.inputs.audio.sha256, durationMs: task.inputs.audio.duration_ms!,
            mimeType: 'audio/mpeg', language: 'zh-CN'
          },
          transcript,
          calibrationResult: calibrationArtifact as CalibrationResult & { status: 'completed' },
          calibratedTranscript: calibratedArtifact,
          referenceSrt: referenceSrtText === null ? null : { pathRef: 'input/reference.srt', text: referenceSrtText }
        });
        if (verificationResult.kind === 'failure') {
          throw new MercuryError('AUDIO_VERIFICATION_ADAPTER_FAILURE_INVALID', 'Gemini 插件未返回权威 audio-verification.json。');
        }
        if (!audioVerificationGraphIsValid(
          task,
          snapshot,
          transcript,
          calibrationArtifact as CalibrationResult,
          calibratedArtifact,
          verificationResult.artifact
        )) {
          throw new MercuryError('AUDIO_VERIFICATION_ARTIFACT_INVALID', 'Gemini 插件返回的原始证据引用未通过 D001 图校验。');
        }
        const applied = applyAudioVerificationFindings(calibratedArtifact, verificationResult.artifact);
        calibratedArtifact = applied.calibrated;
        await persistAudioVerification(taskDirectory, task, applied.verification, now);
      } catch {
        const failure = taskError(
          task,
          'AUDIO_VERIFICATION_EXECUTION_FAILED',
          '音频强校验未能形成权威终态产物；基础字幕结果保持可用。',
          'execution',
          true,
          '检查模型连接和任务报告后重试；基础字幕结果不受影响。'
        );
        const createdAt = timestamp(now);
        await persistAudioVerification(taskDirectory, task, {
          schema_version: '1.0.0', task_id: task.task_id, created_at: createdAt, status: 'failed',
          model_snapshot_ref: snapshot.snapshot_id, input: verificationInput(task),
          calls: [{
            call_id: `${task.task_id}-audio-verification-fallback`,
            model_snapshot_entry_ref: audioModel.snapshot_entry_id,
            started_at: createdAt, ended_at: createdAt, outcome: 'failed', error_ref: failure.error_id
          }],
          staging: [], findings: [], application_results: [], skip_reason: null,
          warnings: [], errors: [failure]
        }, now);
      }
    }
  }

  await writeJsonAtomic(taskPath(taskDirectory, CALIBRATED_PATH), calibratedArtifact);
  registerWorkArtifact(task, CALIBRATED_PATH);
  await persistStage(
    taskDirectory,
    task,
    'validating',
    task.audio_verification.requested
      ? 'verifying_audio'
      : task.input_config.mode === 'text-only' ? 'calibrating' : 'segmenting',
    now
  );
  return (await generateTaskOutputs(taskDirectory, { now })).task;
}

export async function executeCalibrationTask(
  taskDirectory: string,
  dependencies: CoreIntegrationDependencies = {}
): Promise<TaskRecord> {
  const resolvedDirectory = path.resolve(taskDirectory);
  let task = await readTaskRecord(resolvedDirectory);
  if (isTerminalTask(task) || task.execution.execution_interrupted || task.execution.status !== 'analyzing_audio') {
    throw new MercuryError('TASK_EXECUTION_STATE_INVALID', `任务 ${task.task_id} 当前状态不能开始执行：${task.execution.status}`);
  }
  const now = dependencies.now ?? (() => new Date());
  const processId = dependencies.processId ?? process.pid;
  try {
    await writeExecutionMarker(resolvedDirectory, task, processId, now);
    const snapshot = await loadModelSnapshot(resolvedDirectory, task);
    return await executePreparedTask(resolvedDirectory, task, snapshot, dependencies, now);
  } catch (error) {
    task = await readTaskRecord(resolvedDirectory);
    if (isTerminalTask(task)) return task;
    return concludeAbnormally(
      resolvedDirectory,
      task,
      'failed',
      taskError(
        task,
        error instanceof MercuryError ? error.code : 'TASK_PIPELINE_FAILED',
        errorMessage(error),
        'execution',
        false,
        '检查任务报告和已登记产物后，创建新任务重试。'
      ),
      now
    );
  } finally {
    await rm(taskPath(resolvedDirectory, EXECUTION_MARKER_PATH), { force: true }).catch(() => undefined);
  }
}

export async function readAudioVerificationStatus(taskDirectory: string, task: TaskRecord): Promise<string> {
  if (!task.audio_verification.artifact_path) return '-';
  try {
    const value = JSON.parse(await readFile(taskPath(taskDirectory, task.audio_verification.artifact_path), 'utf8')) as unknown;
    const validation = validateContract('audio-verification', value);
    return validation.valid && validation.value.task_id === task.task_id ? validation.value.status : 'invalid';
  } catch {
    return 'unavailable';
  }
}

export async function readTaskModelSummary(taskDirectory: string, task: TaskRecord): Promise<string> {
  if (!task.model_snapshot.path) return '-';
  try {
    const value = JSON.parse(await readFile(taskPath(taskDirectory, task.model_snapshot.path), 'utf8')) as unknown;
    if (typeof value === 'object' && value !== null && (value as { schema_version?: unknown }).schema_version === '2.0.0') {
      const modern = validateV2Contract('model-snapshot', value);
      if (!modern.valid || modern.value.task_id !== task.task_id) return 'invalid';
      return [modern.value.models.asr, modern.value.models.chat]
        .map((model) => `${model.category}:${model.plugin_id}/${model.connection_type}/${model.provider_model}`)
        .join('；');
    }
    const validation = validateContract('model-snapshot', value);
    if (!validation.valid || validation.value.task_id !== task.task_id) return 'invalid';
    return [validation.value.models.asr, validation.value.models.calibration]
      .map((model) => {
        const identity = model as unknown as { adapter?: string; plugin_id?: string; connection_type?: string };
        const plugin = identity.plugin_id ?? identity.adapter ?? 'unknown';
        return `${model.role}:${plugin}${identity.connection_type ? `/${identity.connection_type}` : ''}/${model.model}`;
      })
      .join('；');
  } catch {
    return 'unavailable';
  }
}
