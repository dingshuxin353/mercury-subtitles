import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, constants as fileConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import type { AdapterFailureRecord, ErrorRecord, ModelConfig, ModelConfigRegistry, ModelSnapshot, WarningRecord } from './contracts/index.js';
import { validateContract } from './contracts/index.js';
import { MercuryError } from './errors.js';
import {
  isPluginModelConfig,
  loadNormalizedModelRegistry,
  type PluginModelConfig
} from './model-center/index.js';
import { ensureWorkspace } from './workspace.js';

export type CalibrationMode = 'text-only' | 'text-and-segmentation';
export type TaskStatus =
  | 'created'
  | 'preparing'
  | 'analyzing_audio'
  | 'aligning'
  | 'calibrating'
  | 'verifying_audio'
  | 'segmenting'
  | 'validating'
  | 'completed'
  | 'needs_input'
  | 'failed'
  | 'queued'
  | 'running'
  | 'cancelled'
  | 'interrupted';

export interface TaskInputRecord {
  original_path: string;
  original_name: string;
  workspace_copy_path: string;
  bytes: number;
  modified_at: string;
  sha256: string;
  copy_verified: boolean;
}

export interface TaskRecord {
  schema_version: '1.0.0' | '2.0.0' | '3.0.0' | '4.0.0';
  task_id: string;
  task_type: 'subtitle_calibration';
  created_at: string;
  updated_at: string;
  task_directory: string;
  input_config: {
    has_reference_srt: boolean;
    mode: CalibrationMode | null;
    source_language: 'zh-CN';
  };
  inputs: {
    audio: TaskInputRecord & { duration_ms: number | null };
    reference_srt: TaskInputRecord | null;
  };
  model_snapshot: { path: string | null; sha256: string | null };
  audio_verification: { requested: boolean; artifact_path: string | null; sha256: string | null };
  execution: {
    status: TaskStatus;
    last_completed_stage: TaskStatus | null;
    started_at: string | null;
    ended_at: string | null;
    execution_interrupted: boolean;
  };
  artifacts: { work: string[]; outputs: string[]; report: string | null };
  adapter_failures: AdapterFailureRecord[];
  warnings: WarningRecord[];
  error: ErrorRecord | null;
  failure_stage: string | null;
}

export interface CreateTaskOptions {
  workspaceRoot: string;
  audioPath: string;
  srtPath?: string;
  mode?: CalibrationMode;
  verifyAudio?: boolean;
  now?: () => Date;
  randomHex?: () => string;
}

const TASK_ID_PATTERN = /^tsk-\d{8}-\d{6}-[0-9a-f]{8}$/;
const SRT_TIMESTAMP = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/;
const TERMINAL_STATUSES = new Set<TaskStatus>([
  'completed',
  'needs_input',
  'failed',
  'cancelled',
  'interrupted',
]);
const TASK_STATUSES = new Set<TaskStatus>([
  'created',
  'preparing',
  'analyzing_audio',
  'aligning',
  'calibrating',
  'verifying_audio',
  'segmenting',
  'validating',
  'queued',
  'running',
  ...TERMINAL_STATUSES
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function localDateParts(date: Date): string[] {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ];
}

export function createTaskId(date = new Date(), randomHex = () => randomBytes(4).toString('hex')): string {
  const [year, month, day, hour, minute, second] = localDateParts(date);
  const suffix = randomHex();
  if (!/^[0-9a-f]{8}$/.test(suffix)) throw new MercuryError('TASK_ID_RANDOM_INVALID', '任务 ID 随机后缀必须是 8 位小写十六进制。');
  return `tsk-${year}${month}${day}-${hour}${minute}${second}-${suffix}`;
}

export function safeAudioStem(fileName: string): string {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension).normalize('NFKC');
  const safe = stem.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return Array.from(safe || 'audio').slice(0, 40).join('');
}

async function assertReadableRegularFile(filePath: string, label: string): Promise<void> {
  try {
    const details = await stat(filePath);
    if (!details.isFile()) throw new MercuryError('INPUT_NOT_REGULAR_FILE', `${label}不是普通文件：${filePath}`);
    const handle = await open(filePath, 'r');
    await handle.close();
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('INPUT_NOT_READABLE', `${label}不可读：${filePath}（${errorMessage(error)}）`);
  }
}

function mp3FrameLength(buffer: Buffer, index: number): number | null {
  if (index + 3 >= buffer.length || buffer[index] !== 0xff || (buffer[index + 1]! & 0xe0) !== 0xe0) return null;
  const versionBits = (buffer[index + 1]! >> 3) & 0x03;
  const layerBits = (buffer[index + 1]! >> 1) & 0x03;
  const bitrateIndex = (buffer[index + 2]! >> 4) & 0x0f;
  const sampleRateIndex = (buffer[index + 2]! >> 2) & 0x03;
  if (versionBits === 0x01 || layerBits !== 0x01 || bitrateIndex === 0x00 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null;

  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const baseSampleRates = [44100, 48000, 32000];
  const isMpeg1 = versionBits === 0x03;
  const bitrate = (isMpeg1 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex];
  const baseSampleRate = baseSampleRates[sampleRateIndex];
  if (!bitrate || !baseSampleRate) return null;
  const sampleRate = versionBits === 0x00 ? baseSampleRate / 4 : isMpeg1 ? baseSampleRate : baseSampleRate / 2;
  const padding = (buffer[index + 2]! >> 1) & 0x01;
  return Math.floor((isMpeg1 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding;
}

function hasConsecutiveMp3Frames(buffer: Buffer): boolean {
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    const firstLength = mp3FrameLength(buffer, index);
    if (!firstLength || index + firstLength >= buffer.length) continue;
    const secondLength = mp3FrameLength(buffer, index + firstLength);
    if (secondLength && index + firstLength + secondLength <= buffer.length) return true;
  }
  return false;
}

async function validateMp3(filePath: string): Promise<void> {
  if (path.extname(filePath).toLowerCase() !== '.mp3') {
    throw new MercuryError('AUDIO_EXTENSION_INVALID', `音频扩展名必须是 .mp3：${filePath}`);
  }
  const handle = await open(filePath, 'r');
  try {
    const details = await handle.stat();
    const length = Math.min(details.size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    if (!hasConsecutiveMp3Frames(buffer)) throw new MercuryError('AUDIO_CONTENT_INVALID', `文件内容不是可识别的 MP3：${filePath}`);
  } finally {
    await handle.close();
  }
}

function timestampMilliseconds(match: RegExpMatchArray, offset: number): number {
  const hour = Number(match[offset]);
  const minute = Number(match[offset + 1]);
  const second = Number(match[offset + 2]);
  const millisecond = Number(match[offset + 3]);
  return ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
}

async function validateSrt(filePath: string): Promise<void> {
  if (path.extname(filePath).toLowerCase() !== '.srt') {
    throw new MercuryError('SRT_EXTENSION_INVALID', `参考字幕扩展名必须是 .srt：${filePath}`);
  }
  const bytes = await readFile(filePath);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new MercuryError('SRT_ENCODING_INVALID', `参考字幕必须使用 UTF-8 或 UTF-8 BOM：${filePath}`);
  }
  const blocks = text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  if (blocks.length === 0 || blocks.some((block) => {
    const lines = block.split('\n');
    const match = lines[1]?.match(SRT_TIMESTAMP);
    return !/^\d+$/.test(lines[0] ?? '') || !match || timestampMilliseconds(match, 1) >= timestampMilliseconds(match, 5) || lines.slice(2).join('\n').trim() === '';
  })) {
    throw new MercuryError('SRT_CONTENT_INVALID', `参考字幕无法解析为合法字幕块：${filePath}`);
  }
}

async function inspectInput(filePath: string, label: string): Promise<Omit<TaskInputRecord, 'workspace_copy_path' | 'copy_verified'>> {
  const absolutePath = path.resolve(filePath);
  await assertReadableRegularFile(absolutePath, label);
  const details = await stat(absolutePath);
  return {
    original_path: absolutePath,
    original_name: path.basename(absolutePath),
    bytes: details.size,
    modified_at: details.mtime.toISOString(),
    sha256: await sha256File(absolutePath)
  };
}

function modelById(registry: ModelConfigRegistry, configId: string): ModelConfig | undefined {
  return registry.models.find((model) => model.config_id === configId);
}

function requireReadyModel(registry: ModelConfigRegistry, role: 'asr' | 'calibration'): ModelConfig {
  const model = modelById(registry, registry.defaults[role]);
  if (!model || model.role !== role || !model.enabled) {
    throw new MercuryError('MODEL_NOT_CONFIGURED', `默认 ${role} 模型未配置或未启用。`, { remediation: '请运行 mercury 打开交互式 App，在“模型中心”完成模型配置；密钥请在隐藏输入中填写，不要在聊天中发送凭据。' });
  }
  if (!model.cloud_data_confirmation.confirmed) {
    throw new MercuryError('CLOUD_DATA_NOT_CONFIRMED', `默认 ${role} 模型尚未获得云端数据发送确认。`, { remediation: '请运行 mercury 打开交互式 App，在“模型中心”重新确认该模型会发送的数据。' });
  }
  if (model.last_check?.outcome !== 'passed') {
    throw new MercuryError('MODEL_CHECK_NOT_PASSED', `默认 ${role} 模型尚未通过能力检查。`, { remediation: `请执行 mercury model check --role ${role}。` });
  }
  if (!isPluginModelConfig(model) || model.last_check.verified_capabilities === null) {
    throw new MercuryError('MODEL_CAPABILITY_NOT_VERIFIED', `默认 ${role} 模型缺少模型中心能力检查。`);
  }
  return model;
}

async function loadModelRegistry(workspaceRoot: string): Promise<ModelConfigRegistry> {
  return loadNormalizedModelRegistry(workspaceRoot);
}

function snapshotEntry(model: ModelConfig, taskId: string): Record<string, unknown> {
  if (!model.last_check || model.last_check.outcome !== 'passed') {
    throw new MercuryError('MODEL_CHECK_NOT_PASSED', `${model.role} 模型尚未通过能力检查。`);
  }
  if (!isPluginModelConfig(model) && model.role === 'audio_verification') {
    const legacy = model as unknown as { adapter: string };
    return {
      snapshot_entry_id: `${taskId}-${model.role.replace('_', '-')}`,
      role: model.role,
      config_id: model.config_id,
      name: model.name,
      config_fingerprint: model.config_fingerprint,
      adapter: legacy.adapter,
      model: model.model,
      runtime: model.runtime,
      endpoint: model.endpoint,
      credential_ref: model.credential_ref,
      provider_config: structuredClone(model.provider_config),
      cloud_data_confirmation: structuredClone(model.cloud_data_confirmation),
      check_snapshot: structuredClone(model.last_check)
    };
  }
  if (!isPluginModelConfig(model) || model.last_check.verified_capabilities === null) {
    throw new MercuryError('MODEL_CAPABILITY_NOT_VERIFIED', `${model.role} 模型缺少已验证能力。`);
  }
  const pluginModel = model as unknown as PluginModelConfig;
  return {
    snapshot_entry_id: `${taskId}-${model.role.replace('_', '-')}`,
    role: model.role,
    config_id: model.config_id,
    name: model.name,
    config_fingerprint: model.config_fingerprint,
    plugin_id: pluginModel.plugin_id,
    connection_id: pluginModel.connection_id,
    connection_type: pluginModel.connection_type,
    model: model.model,
    runtime: model.runtime,
    endpoint: model.endpoint,
    credential_ref: model.credential_ref,
    provider_config: structuredClone(model.provider_config),
    declared_capabilities: structuredClone(pluginModel.declared_capabilities),
    cloud_data_confirmation: structuredClone(model.cloud_data_confirmation),
    check_snapshot: structuredClone(model.last_check)
  };
}

function prepareModelSnapshot(
  registry: ModelConfigRegistry,
  taskId: string,
  capturedAt: string,
  verifyAudio: boolean
): { snapshot: ModelSnapshot; audioSkipReason: 'not_configured' | 'cloud_confirmation_missing' | 'check_missing_or_stale' | null } {
  const asr = requireReadyModel(registry, 'asr');
  const calibration = requireReadyModel(registry, 'calibration');
  const models: Record<string, unknown> = {
    asr: snapshotEntry(asr, taskId),
    calibration: snapshotEntry(calibration, taskId)
  };
  let audioSkipReason: 'not_configured' | 'cloud_confirmation_missing' | 'check_missing_or_stale' | null = null;
  if (verifyAudio && registry.defaults.audio_verification) {
    const audioVerification = modelById(registry, registry.defaults.audio_verification);
    if (audioVerification?.enabled && audioVerification.cloud_data_confirmation.confirmed && audioVerification.last_check?.outcome === 'passed') {
      models.audio_verification = snapshotEntry(audioVerification, taskId);
    } else if (!audioVerification?.enabled) {
      audioSkipReason = 'not_configured';
    } else if (!audioVerification.cloud_data_confirmation.confirmed) {
      audioSkipReason = 'cloud_confirmation_missing';
    } else {
      audioSkipReason = 'check_missing_or_stale';
    }
  } else if (verifyAudio) {
    audioSkipReason = 'not_configured';
  }
  const snapshot = {
    schema_version: '1.0.0',
    snapshot_id: `${taskId}-models`,
    task_id: taskId,
    captured_at: capturedAt,
    models
  };
  const result = validateContract('model-snapshot', snapshot);
  if (!result.valid) {
    const summary = result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
    throw new MercuryError('MODEL_SNAPSHOT_INVALID', `任务模型快照不符合 D001 协议：${summary}`);
  }
  return { snapshot: result.value, audioSkipReason };
}

async function copyAndVerify(source: TaskInputRecord, destination: string): Promise<TaskInputRecord> {
  await copyFile(source.original_path, destination, fileConstants.COPYFILE_EXCL);
  const copyHash = await sha256File(destination);
  const currentSource = await inspectInput(source.original_path, '原始输入');
  if (
    copyHash !== source.sha256 ||
    currentSource.sha256 !== source.sha256 ||
    currentSource.bytes !== source.bytes ||
    currentSource.modified_at !== source.modified_at
  ) {
    throw new MercuryError('INPUT_COPY_MISMATCH', `输入复制校验失败：${source.original_path}`);
  }
  await chmod(destination, 0o444);
  return { ...source, copy_verified: true };
}

export async function createCalibrationTask(options: CreateTaskOptions): Promise<TaskRecord> {
  const workspaceRoot = await ensureWorkspace(options.workspaceRoot);
  if (!options.srtPath && options.mode) {
    throw new MercuryError('CALIBRATION_MODE_REQUIRES_SRT', '未提供参考 SRT 时不能指定 --mode。');
  }
  if (options.mode && options.mode !== 'text-only' && options.mode !== 'text-and-segmentation') {
    throw new MercuryError('CALIBRATION_MODE_INVALID', `不支持的校准模式：${options.mode}`);
  }

  const registry = await loadModelRegistry(workspaceRoot);
  requireReadyModel(registry, 'asr');
  requireReadyModel(registry, 'calibration');

  const absoluteAudioPath = path.resolve(options.audioPath);
  await assertReadableRegularFile(absoluteAudioPath, '音频输入');
  await validateMp3(absoluteAudioPath);
  const audioSource = await inspectInput(absoluteAudioPath, '音频输入');
  const srtSource = options.srtPath
    ? await (async () => {
        const absoluteSrtPath = path.resolve(options.srtPath!);
        await assertReadableRegularFile(absoluteSrtPath, '参考字幕');
        await validateSrt(absoluteSrtPath);
        return inspectInput(absoluteSrtPath, '参考字幕');
      })()
    : null;

  const now = options.now ?? (() => new Date());
  const created = now();
  const createdAt = created.toISOString();
  const taskId = createTaskId(created, options.randomHex);
  const audioStem = safeAudioStem(audioSource.original_name);
  const taskDirectoryName = `${taskId}-${audioStem}`;
  const taskDirectory = path.join(workspaceRoot, 'tasks', taskDirectoryName);
  const inputDirectory = path.join(taskDirectory, 'input');
  const audioCopyName = `${audioStem}.mp3`;
  const audioRelativePath = path.posix.join('input', audioCopyName);
  const srtRelativePath = srtSource ? 'input/reference.srt' : null;
  const preparedModels = prepareModelSnapshot(registry, taskId, createdAt, Boolean(options.verifyAudio));
  const modelSnapshot = preparedModels.snapshot;

  await mkdir(taskDirectory);
  await Promise.all([
    mkdir(inputDirectory),
    mkdir(path.join(taskDirectory, 'work')),
    mkdir(path.join(taskDirectory, 'output')),
    mkdir(path.join(taskDirectory, 'logs'))
  ]);

  const taskFile = path.join(taskDirectory, 'task.json');
  let task: TaskRecord = {
    schema_version: '1.0.0',
    task_id: taskId,
    task_type: 'subtitle_calibration',
    created_at: createdAt,
    updated_at: createdAt,
    task_directory: taskDirectoryName,
    input_config: {
      has_reference_srt: Boolean(srtSource),
      mode: srtSource ? options.mode ?? 'text-only' : null,
      source_language: 'zh-CN'
    },
    inputs: {
      audio: { ...audioSource, workspace_copy_path: audioRelativePath, copy_verified: false, duration_ms: null },
      reference_srt: srtSource && srtRelativePath ? { ...srtSource, workspace_copy_path: srtRelativePath, copy_verified: false } : null
    },
    model_snapshot: { path: null, sha256: null },
    audio_verification: { requested: Boolean(options.verifyAudio), artifact_path: null, sha256: null },
    execution: {
      status: 'created',
      last_completed_stage: null,
      started_at: null,
      ended_at: null,
      execution_interrupted: false
    },
    artifacts: { work: [], outputs: [], report: null },
    adapter_failures: [],
    warnings: preparedModels.audioSkipReason ? [{
      warning_id: `${taskId}-audio-verification-skip`,
      code: `AUDIO_VERIFICATION_${preparedModels.audioSkipReason.toUpperCase()}`,
      message: '音频强校验已请求，但任务创建时没有可冻结的已确认且已验证模型。',
      stage: preparedModels.audioSkipReason === 'cloud_confirmation_missing' ? 'confirmation' : 'capability',
      severity: 'medium'
    }] : [],
    error: null,
    failure_stage: null
  };
  await writeJsonAtomic(taskFile, task);

  try {
    const snapshotPath = path.join(taskDirectory, 'work', 'model-snapshot.json');
    await writeJsonAtomic(snapshotPath, modelSnapshot);
    task.model_snapshot = { path: 'work/model-snapshot.json', sha256: await sha256File(snapshotPath) };
    task.artifacts.work.push('work/model-snapshot.json');
    task.execution.status = 'preparing';
    task.execution.started_at = createdAt;
    task.updated_at = now().toISOString();
    await writeJsonAtomic(taskFile, task);

    task.inputs.audio = {
      ...(await copyAndVerify(task.inputs.audio, path.join(taskDirectory, audioRelativePath))),
      duration_ms: null
    };
    if (task.inputs.reference_srt && srtRelativePath) {
      task.inputs.reference_srt = await copyAndVerify(task.inputs.reference_srt, path.join(taskDirectory, srtRelativePath));
    }
    task.execution.last_completed_stage = 'preparing';
    task.execution.status = 'analyzing_audio';
    task.updated_at = now().toISOString();
    await writeJsonAtomic(taskFile, task);
    return task;
  } catch (error) {
    task.execution.status = 'failed';
    task.execution.ended_at = now().toISOString();
    task.updated_at = task.execution.ended_at;
    task.error = {
      error_id: `${taskId}-creation`,
      code: error instanceof MercuryError ? error.code : 'TASK_CREATION_FAILED',
      message: errorMessage(error),
      stage: 'artifact_write',
      retryable: false,
      remediation: '检查任务目录和输入文件后，使用新的 calibrate 命令创建任务。'
    };
    task.failure_stage = 'preparing';
    await writeJsonAtomic(taskFile, task);
    return task;
  }
}

function isTaskRecord(value: unknown, directoryName: string): value is TaskRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TaskRecord>;
  return (
    typeof candidate.task_id === 'string' &&
    TASK_ID_PATTERN.test(candidate.task_id) &&
    candidate.task_type === 'subtitle_calibration' &&
    candidate.task_directory === directoryName &&
    directoryName.startsWith(`${candidate.task_id}-`) &&
    typeof candidate.created_at === 'string' &&
    typeof candidate.execution?.status === 'string' &&
    TASK_STATUSES.has(candidate.execution.status)
  );
}

async function readTaskFile(taskDirectory: string): Promise<TaskRecord> {
  const taskFile = path.join(taskDirectory, 'task.json');
  try {
    const value = JSON.parse(await readFile(taskFile, 'utf8')) as unknown;
    if (!isTaskRecord(value, path.basename(taskDirectory))) throw new MercuryError('TASK_RECORD_INVALID', `任务记录格式无效：${taskFile}`);
    return value;
  } catch (error) {
    if (error instanceof MercuryError) throw error;
    throw new MercuryError('TASK_RECORD_READ_FAILED', `无法读取任务记录 ${taskFile}：${errorMessage(error)}`);
  }
}

export async function readTaskRecord(taskDirectory: string): Promise<TaskRecord> {
  return readTaskFile(path.resolve(taskDirectory));
}

export async function persistTaskRecord(taskDirectory: string, task: TaskRecord): Promise<void> {
  const resolvedDirectory = path.resolve(taskDirectory);
  if (!isTaskRecord(task, path.basename(resolvedDirectory))) {
    throw new MercuryError('TASK_RECORD_INVALID', `任务记录与目录不一致：${resolvedDirectory}`);
  }
  await writeJsonAtomic(path.join(resolvedDirectory, 'task.json'), task);
}

export async function listTasks(workspaceRoot: string): Promise<TaskRecord[]> {
  await ensureWorkspace(workspaceRoot);
  const tasksRoot = path.join(workspaceRoot, 'tasks');
  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const tasks = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readTaskFile(path.join(tasksRoot, entry.name))));
  return tasks.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.task_id.localeCompare(left.task_id));
}

export async function findTask(workspaceRoot: string, taskId: string): Promise<TaskRecord> {
  if (!TASK_ID_PATTERN.test(taskId)) throw new MercuryError('TASK_ID_INVALID', `任务 ID 格式无效：${taskId}`);
  await ensureWorkspace(workspaceRoot);
  const tasksRoot = path.join(workspaceRoot, 'tasks');
  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const matchingDirectories = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(`${taskId}-`));
  const matches = await Promise.all(matchingDirectories.map((entry) => readTaskFile(path.join(tasksRoot, entry.name))));
  if (matches.length === 0) throw new MercuryError('TASK_NOT_FOUND', `未找到任务：${taskId}`);
  if (matches.length > 1) throw new MercuryError('TASK_ID_CONFLICT', `检测到重复任务 ID：${taskId}`);
  return matches[0]!;
}

export function isTerminalTask(task: TaskRecord): boolean {
  return TERMINAL_STATUSES.has(task.execution.status);
}
