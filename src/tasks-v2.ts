import { randomBytes } from 'node:crypto';
import { constants as fileConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  ErrorRecord,
  ModelSnapshotV2,
  WarningRecord,
} from './contracts/index.js';
import { loadModelRegistryV2, prepareModelSnapshotV2 } from './models-v2.js';
import { MercuryError } from './errors.js';
import {
  createTaskId,
  safeAudioStem,
  sha256File,
  writeJsonAtomic,
  type CalibrationMode,
  type TaskInputRecord,
} from './tasks.js';
import { ensureWorkspace } from './workspace.js';
import {
  CHAT_INLINE_AUDIO_LIMIT_BYTES,
  type NonStrongReason,
} from './adapters/chat-calibration-v2.js';
import { assertV4Contract } from './contracts/v4.js';
import { withOwnedLock } from './background/owned-lock.js';

export type TaskStatusV2 =
  | 'created'
  | 'preparing'
  | 'analyzing_audio'
  | 'aligning'
  | 'calibrating'
  | 'segmenting'
  | 'validating'
  | 'completed'
  | 'needs_input'
  | 'failed'
  | 'queued'
  | 'running'
  | 'cancelled'
  | 'interrupted';
export type TaskStageV4 =
  | 'preparing'
  | 'analyzing_audio'
  | 'aligning'
  | 'calibrating'
  | 'segmenting'
  | 'validating';
export interface ProviderCallCheckpointV4 {
  state: 'not_started' | 'in_flight' | 'response_persisted' | 'terminal';
  evidence_ref: string | null;
}
export interface AdapterFailureRecordV2 {
  failure_id: string;
  task_id: string;
  model_category: 'asr' | 'chat';
  capability: 'transcription' | 'calibration';
  model_snapshot_ref: string;
  occurred_at: string;
  provider_outcome_certainty: 'not_dispatched' | 'known_terminal' | 'outcome_unknown';
  errors: ErrorRecord[];
  warnings: WarningRecord[];
  call: unknown | null;
}
export interface TaskRecordV2 {
  schema_version: '2.0.0' | '3.0.0' | '4.0.0';
  task_id: string;
  task_type: 'subtitle_calibration';
  created_at: string;
  updated_at: string;
  task_directory: string;
  input_config: {
    has_reference_srt: boolean;
    mode: CalibrationMode | null;
    source_language: 'zh-CN';
    evidence_mode: 'text' | 'audio_multimodal';
    non_strong_reason: NonStrongReason | null;
  };
  inputs: {
    audio: TaskInputRecord & { duration_ms: number | null };
    reference_srt: TaskInputRecord | null;
  };
  model_snapshot: {
    path: 'work/model-snapshot.json' | null;
    sha256: string | null;
  };
  execution: {
    status: TaskStatusV2;
    last_completed_stage: TaskStatusV2 | null;
    started_at: string | null;
    ended_at: string | null;
    execution_interrupted: boolean;
    stage?: TaskStageV4 | null;
    queued_at?: string;
    claimed_at?: string | null;
    heartbeat_at?: string | null;
    worker_id?: string | null;
    attempt?: number;
    cancellation_requested_at?: string | null;
    last_event_sequence?: number;
    safe_checkpoint?:
      | 'queued'
      | 'claimed'
      | 'asr_not_started'
      | 'asr_response_persisted'
      | 'chat_not_started'
      | 'chat_response_persisted'
      | 'outputs_validated'
      | null;
    provider_call?: {
      asr: ProviderCallCheckpointV4;
      chat: ProviderCallCheckpointV4;
    };
  };
  artifacts: {
    work: string[];
    outputs: string[];
    report: string | null;
    subtitles?: {
      transcribed: SubtitleOutputRecordV3 | null;
      calibrated: SubtitleOutputRecordV3 | null;
      approved?: SubtitleOutputRecordV3 | null;
    };
    review?: {
      path: 'review.json';
      status: 'not_ready' | 'pending' | 'in_progress' | 'approved' | 'not_required';
      pending_count: number;
    };
  };
  adapter_failures: AdapterFailureRecordV2[];
  warnings: WarningRecord[];
  error: ErrorRecord | null;
  failure_stage: string | null;
}
export interface SubtitleOutputRecordV3 {
  path: string;
  purpose: 'unverified_transcription' | 'calibrated_result' | 'approved_result';
  sha256: string;
  segment_count: number;
  validation: 'passed';
}
export interface CreateTaskOptionsV2 {
  workspaceRoot: string;
  audioPath: string;
  srtPath?: string;
  mode?: CalibrationMode;
  asrModelId?: string;
  chatModelId?: string;
  now?: () => Date;
  randomHex?: () => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function regular(filePath: string, label: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not regular');
    const handle = await open(filePath, 'r');
    await handle.close();
  } catch (error) {
    throw new MercuryError(
      'INPUT_NOT_READABLE',
      `${label}不可读：${filePath}（${errorMessage(error)}）`,
    );
  }
}
function frameLength(buffer: Buffer, index: number): number | null {
  if (
    index + 3 >= buffer.length ||
    buffer[index] !== 0xff ||
    (buffer[index + 1]! & 0xe0) !== 0xe0
  )
    return null;
  const version = (buffer[index + 1]! >> 3) & 3;
  const layer = (buffer[index + 1]! >> 1) & 3;
  const bitrateIndex = buffer[index + 2]! >> 4;
  const sampleIndex = (buffer[index + 2]! >> 2) & 3;
  if (
    version === 1 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    sampleIndex === 3
  )
    return null;
  const rates =
    version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bases = [44100, 48000, 32000];
  const sample =
    version === 0
      ? bases[sampleIndex]! / 4
      : version === 3
        ? bases[sampleIndex]!
        : bases[sampleIndex]! / 2;
  return (
    Math.floor(
      ((version === 3 ? 144 : 72) * rates[bitrateIndex]! * 1000) / sample,
    ) +
    ((buffer[index + 2]! >> 1) & 1)
  );
}
async function validateMp3(filePath: string): Promise<void> {
  if (path.extname(filePath).toLowerCase() !== '.mp3')
    throw new MercuryError(
      'AUDIO_EXTENSION_INVALID',
      '音频扩展名必须是 .mp3。',
    );
  const handle = await open(filePath, 'r');
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(Math.min(info.size, 1024 * 1024));
    await handle.read(buffer, 0, buffer.length, 0);
    let valid = false;
    for (let i = 0; i + 3 < buffer.length; i++) {
      const first = frameLength(buffer, i);
      if (first && frameLength(buffer, i + first)) {
        valid = true;
        break;
      }
    }
    if (!valid)
      throw new MercuryError(
        'AUDIO_CONTENT_INVALID',
        '文件内容不是可识别的 MP3。',
      );
  } finally {
    await handle.close();
  }
}
async function validateSrt(filePath: string): Promise<void> {
  if (path.extname(filePath).toLowerCase() !== '.srt')
    throw new MercuryError(
      'SRT_EXTENSION_INVALID',
      '参考字幕扩展名必须是 .srt。',
    );
  const source = new TextDecoder('utf-8', { fatal: true })
    .decode(await readFile(filePath))
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (
    !source ||
    source.split(/\n{2,}/).some((block) => {
      const lines = block.split('\n');
      return (
        !/^\d+$/.test(lines[0] ?? '') ||
        !/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/.test(
          lines[1] ?? '',
        ) ||
        !lines.slice(2).join('').trim()
      );
    })
  )
    throw new MercuryError('SRT_CONTENT_INVALID', '参考字幕无法解析。');
}
async function inspect(filePath: string, label: string) {
  const absolute = path.resolve(filePath);
  await regular(absolute, label);
  const info = await stat(absolute);
  return {
    original_path: absolute,
    original_name: path.basename(absolute),
    bytes: info.size,
    modified_at: info.mtime.toISOString(),
    sha256: await sha256File(absolute),
  };
}
async function copy(
  source: Omit<TaskInputRecord, 'workspace_copy_path' | 'copy_verified'>,
  destination: string,
  relative: string,
): Promise<TaskInputRecord> {
  await copyFile(
    source.original_path,
    destination,
    fileConstants.COPYFILE_EXCL,
  );
  if (
    (await sha256File(destination)) !== source.sha256 ||
    (await sha256File(source.original_path)) !== source.sha256
  )
    throw new MercuryError('INPUT_COPY_MISMATCH', '输入复制校验失败。');
  await chmod(destination, 0o444);
  return { ...source, workspace_copy_path: relative, copy_verified: true };
}

function evidence(
  snapshot: ModelSnapshotV2,
  bytes: number,
): {
  mode: 'text' | 'audio_multimodal';
  reason: NonStrongReason | null;
  warning: WarningRecord | null;
} {
  const chat = snapshot.models.chat;
  let reason: NonStrongReason | null = null;
  if (!chat.declared_capabilities.input_modalities.includes('audio'))
    reason = 'audio_not_supported';
  else if (!chat.verified_capabilities.input_modalities.includes('audio'))
    reason = 'audio_check_missing_or_stale';
  else if (!chat.cloud_data_confirmation.data_categories.includes('audio'))
    reason = 'audio_data_confirmation_missing';
  else if (
    chat.plugin_id !== 'gemini' ||
    !['vertex_ai', 'developer_api'].includes(chat.connection_type)
  )
    reason = 'audio_inline_unsupported';
  else if (bytes > CHAT_INLINE_AUDIO_LIMIT_BYTES)
    reason = 'audio_input_limit_exceeded';
  if (!reason) return { mode: 'audio_multimodal', reason: null, warning: null };
  return {
    mode: 'text',
    reason,
    warning:
      reason === 'audio_input_limit_exceeded'
        ? {
            warning_id: `${snapshot.task_id}-audio-limit`,
            code: 'AUDIO_INPUT_LIMIT_EXCEEDED',
            message:
              'MP3 超过 15,000,000 bytes；音频零发送，由同一 Chat 执行一次纯文本校准。',
            stage: 'input_validation',
            severity: 'medium',
          }
        : null,
  };
}

export async function createCalibrationTaskV2(
  options: CreateTaskOptionsV2,
): Promise<TaskRecordV2> {
  const workspaceRoot = await ensureWorkspace(options.workspaceRoot);
  if (!options.srtPath && options.mode)
    throw new MercuryError(
      'CALIBRATION_MODE_REQUIRES_SRT',
      '未提供参考 SRT 时不能指定 --mode。',
    );
  const audioPath = path.resolve(options.audioPath);
  await regular(audioPath, '音频输入');
  await validateMp3(audioPath);
  const audioSource = await inspect(audioPath, '音频输入');
  const srtSource = options.srtPath
    ? await (async () => {
        const value = path.resolve(options.srtPath!);
        await regular(value, '参考字幕');
        await validateSrt(value);
        return inspect(value, '参考字幕');
      })()
    : null;
  const now = options.now ?? (() => new Date());
  const created = now();
  const at = created.toISOString();
  const taskId = createTaskId(
    created,
    options.randomHex ?? (() => randomBytes(4).toString('hex')),
  );
  const registry = await loadModelRegistryV2(workspaceRoot);
  const snapshot = prepareModelSnapshotV2(
    registry,
    taskId,
    at,
    options.asrModelId,
    options.chatModelId,
  );
  const requiredText = [
    'transcript',
    'context',
    ...(srtSource ? ['reference_srt'] : []),
  ] as string[];
  if (
    !requiredText.every((value) =>
      snapshot.models.chat.cloud_data_confirmation.data_categories.includes(
        value as any,
      ),
    )
  )
    throw new MercuryError(
      'CLOUD_DATA_NOT_CONFIRMED',
      '所选 Chat 的云端确认未覆盖本次文本输入。',
    );
  const decision = evidence(snapshot, audioSource.bytes);
  const stem = safeAudioStem(audioSource.original_name);
  const directoryName = `${taskId}-${stem}`;
  const directory = path.join(workspaceRoot, 'tasks', directoryName);
  await mkdir(directory);
  await Promise.all(
    ['input', 'work', 'output', 'logs'].map((name) =>
      mkdir(path.join(directory, name)),
    ),
  );
  const audioRelative = `input/${stem}.mp3`;
  const snapshotPath = path.join(directory, 'work/model-snapshot.json');
  await writeJsonAtomic(snapshotPath, snapshot);
  const task: TaskRecordV2 = {
    schema_version: '3.0.0',
    task_id: taskId,
    task_type: 'subtitle_calibration',
    created_at: at,
    updated_at: at,
    task_directory: directoryName,
    input_config: {
      has_reference_srt: Boolean(srtSource),
      mode: srtSource ? (options.mode ?? 'text-only') : null,
      source_language: 'zh-CN',
      evidence_mode: decision.mode,
      non_strong_reason: decision.reason,
    },
    inputs: {
      audio: {
        ...(await copy(
          audioSource,
          path.join(directory, audioRelative),
          audioRelative,
        )),
        duration_ms: null,
      },
      reference_srt: srtSource
        ? await copy(
            srtSource,
            path.join(directory, 'input/reference.srt'),
            'input/reference.srt',
          )
        : null,
    },
    model_snapshot: {
      path: 'work/model-snapshot.json',
      sha256: await sha256File(snapshotPath),
    },
    execution: {
      status: 'analyzing_audio',
      last_completed_stage: 'preparing',
      started_at: at,
      ended_at: null,
      execution_interrupted: false,
    },
    artifacts: {
      work: ['work/model-snapshot.json'],
      outputs: [],
      report: null,
      subtitles: { transcribed: null, calibrated: null },
    },
    adapter_failures: [],
    warnings: decision.warning ? [decision.warning] : [],
    error: null,
    failure_stage: null,
  };
  await writeJsonAtomic(path.join(directory, 'task.json'), task);
  return task;
}

export function isTaskRecordV2(value: unknown): value is TaskRecordV2 {
  return (
    typeof value === 'object' &&
    value !== null &&
    ['2.0.0', '3.0.0', '4.0.0'].includes((value as TaskRecordV2).schema_version) &&
    (value as TaskRecordV2).task_type === 'subtitle_calibration'
  );
}
export async function readTaskRecordV2(
  directory: string,
): Promise<TaskRecordV2> {
  const resolvedDirectory = path.resolve(directory);
  try {
    const tasksRoot = await lstat(path.dirname(resolvedDirectory));
    if (!tasksRoot.isDirectory() || tasksRoot.isSymbolicLink()) {
      throw new MercuryError('TASK_PATH_UNSAFE', 'tasks 目录不能是符号链接或非目录。');
    }
    const entry = await lstat(resolvedDirectory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new MercuryError('TASK_PATH_UNSAFE', '任务目录不是普通目录。');
    }
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('TASK_PATH_UNSAFE', '任务目录不可安全读取。');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.join(resolvedDirectory, 'task.json'), 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('TASK_RECORD_INVALID', '任务记录不是可读的 JSON。');
  }
  if (!isTaskRecordV2(value))
    throw new MercuryError(
      'TASK_RECORD_INVALID',
      '任务不是合法的 v2 任务记录。',
    );
  if (
    value.task_directory !== path.basename(resolvedDirectory)
    || !value.task_directory.startsWith(`${value.task_id}-`)
  ) {
    throw new MercuryError('TASK_RECORD_INVALID', '任务记录 identity 与目录不一致。');
  }
  if (value.schema_version === '4.0.0') assertV4Contract('background-task', value);
  return value;
}
export async function persistTaskRecordV2(
  directory: string,
  task: TaskRecordV2,
): Promise<void> {
  if (!isTaskRecordV2(task))
    throw new MercuryError('TASK_RECORD_INVALID', 'v2 任务记录无效。');
  const tasksRootEntry = await lstat(path.dirname(path.resolve(directory))).catch(() => null);
  if (!tasksRootEntry?.isDirectory() || tasksRootEntry.isSymbolicLink()) {
    throw new MercuryError('TASK_PATH_UNSAFE', 'tasks 目录不能是符号链接或非目录。');
  }
  const directoryEntry = await lstat(path.resolve(directory)).catch(() => null);
  if (!directoryEntry?.isDirectory() || directoryEntry.isSymbolicLink()) {
    throw new MercuryError('TASK_PATH_UNSAFE', '任务目录不是普通目录。');
  }
  const target = path.join(path.resolve(directory), 'task.json');
  if (task.schema_version === '4.0.0') {
    const lockPath = `${target}.lock`;
    await withOwnedLock(lockPath, async () => {
      try {
        const current = JSON.parse(await readFile(target, 'utf8')) as TaskRecordV2;
        if (current.schema_version === '4.0.0') {
          const candidateSequence = task.execution.last_event_sequence ?? 0;
          const candidateCancellation =
            task.execution.cancellation_requested_at ?? null;
          if (
            ['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(
              current.execution.status,
            ) &&
            !['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(
              task.execution.status,
            )
          ) {
            Object.assign(task, current);
          }
          task.execution.cancellation_requested_at ??=
            current.execution.cancellation_requested_at ??
            candidateCancellation;
          task.execution.last_event_sequence = Math.max(
            candidateSequence,
            task.execution.last_event_sequence ?? 0,
            current.execution.last_event_sequence ?? 0,
          );
          const candidateHeartbeat = task.execution.heartbeat_at;
          const currentHeartbeat = current.execution.heartbeat_at;
          if (
            task.execution.status === 'running'
            && current.execution.status === 'running'
            && task.execution.worker_id === current.execution.worker_id
            && currentHeartbeat
            && (!candidateHeartbeat || currentHeartbeat.localeCompare(candidateHeartbeat) > 0)
          ) task.execution.heartbeat_at = currentHeartbeat;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      assertV4Contract('background-task', task);
      await writeJsonAtomic(target, task);
    }, {
      waitMs: 5_000,
      errorCode: 'TASK_RECORD_LOCKED',
      errorMessage: '任务记录正在更新，请稍后重试。',
    });
    return;
  }
  await writeJsonAtomic(target, task);
}

export async function updateTaskRecordV2(
  directory: string,
  update: (current: TaskRecordV2) => void | Promise<void>,
): Promise<TaskRecordV2> {
  const root = path.resolve(directory);
  const target = path.join(root, 'task.json');
  return withOwnedLock(`${target}.lock`, async () => {
    const current = await readTaskRecordV2(root);
    await update(current);
    if (current.schema_version === '4.0.0') assertV4Contract('background-task', current);
    await writeJsonAtomic(target, current);
    return current;
  }, {
    waitMs: 5_000,
    errorCode: 'TASK_RECORD_LOCKED',
    errorMessage: '任务记录正在更新，请稍后重试。',
  });
}
