import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fileConstants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  VOLCENGINE_ASR_MAX_DURATION_MS,
  VOLCENGINE_ASR_MAX_INPUT_BYTES,
  type ResolvedVolcengineCredential
} from './adapters/volcengine-asr.js';
import {
  GEMINI_INLINE_REQUEST_LIMIT_BYTES,
  type GeminiAdapterDependencies
} from './adapters/gemini-audio-verification.js';
import type {
  AdapterExecutionResult,
  AsrCapabilities,
  AudioVerification,
  AudioVerificationCapabilities,
  CalibrationCapabilities,
  CalibrationResult,
  ErrorRecord,
  ModelCheckRecord,
  ModelConfig,
  ModelConfigRegistry,
  ModelRole,
  ModelSnapshotEntry,
  TranscriptRaw
} from './contracts/index.js';
import { validateContract } from './contracts/index.js';
import { computeModelConfigFingerprint } from './contracts/validation/semantic.js';
import { MercuryError } from './errors.js';
import {
  AUDIO_VERIFICATION_PROFILE,
  CHAT_PROOFREADING_PROFILE,
  VOLCENGINE_TRANSCRIPTION_PROFILE,
  createBuiltinPluginRegistry,
  isPluginModelConfig,
  loadNormalizedModelRegistry,
  normalizeModelRegistry,
  type PluginModelConfig,
  type PluginModelSnapshotEntry
} from './model-center/index.js';
import { sha256File } from './tasks.js';
import type { CalibratedTranscript } from './subtitle-core/index.js';
import { ensureWorkspace } from './workspace.js';

type FetchLike = typeof globalThis.fetch;
type SetupMethod = 'interactive_cli' | 'non_interactive_flag';
type RawRecord = Record<string, unknown>;
type DataCategory = 'audio' | 'transcript' | 'reference_srt' | 'calibration_candidate' | 'timed_text' | 'context';

export interface ModelRuntimeDependencies extends GeminiAdapterDependencies {
  fetch?: FetchLike;
  readCredential?: (reference: string) => Promise<string>;
  now?: () => Date;
  createId?: () => string;
}

export interface ModelCheckResult {
  role: ModelRole;
  outcome: 'passed' | 'failed';
  error: ErrorRecord | null;
}

const execFileAsync = promisify(execFile);
const MODEL_CONFIG_FILE = 'model-config.json';
const ASR_RESOURCE_ID = 'volc.bigasr.auc_turbo';
const ASR_MODEL = 'bigmodel';
const ROLE_ORDER: ModelRole[] = ['asr', 'calibration', 'audio_verification'];
const ROLE_CATEGORIES: Record<ModelRole, readonly DataCategory[]> = {
  asr: ['audio'],
  calibration: ['transcript', 'reference_srt', 'context'],
  audio_verification: ['audio', 'reference_srt', 'calibration_candidate', 'timed_text', 'context']
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: RawRecord, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new MercuryError('MODEL_SETUP_INVALID', `${label} 包含不支持的字段：${unexpected.join(', ')}`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MercuryError('MODEL_SETUP_INVALID', `${label} 必须是非空字符串。`);
  }
  return value.trim().normalize('NFC');
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function setupId(createId: () => string, prefix: string): string {
  const value = createId();
  return `${prefix}-${value}`;
}

function confirmation(role: ModelRole, confirmed: boolean, method: SetupMethod, timestamp: string, createId: () => string) {
  return confirmed
    ? {
        confirmation_id: setupId(createId, 'confirm'),
        confirmed: true as const,
        confirmed_at: timestamp,
        method,
        data_categories: [...ROLE_CATEGORIES[role]]
      }
    : {
        confirmation_id: setupId(createId, 'confirm'),
        confirmed: false as const,
        confirmed_at: null,
        method: null,
        data_categories: []
      };
}

function inputModel(
  value: unknown,
  confirmed: boolean,
  method: SetupMethod,
  timestamp: string,
  createId: () => string
): ModelConfig {
  if (!isRecord(value)) throw new MercuryError('MODEL_SETUP_INVALID', 'models 中的每一项都必须是对象。');
  assertKeys(value, [
    'config_id', 'name', 'role', 'runtime', 'adapter', 'plugin_id', 'connection_type', 'model', 'endpoint',
    'credential_ref', 'provider_config', 'default'
  ], '模型配置');
  if (value.default !== true) throw new MercuryError('MODEL_SETUP_INVALID', '每个导入模型都必须明确设置 default=true。');

  const role = text(value.role, 'role') as ModelRole;
  if (!ROLE_ORDER.includes(role)) throw new MercuryError('MODEL_SETUP_INVALID', `不支持的模型角色：${role}`);
  if (value.runtime !== 'cloud') {
    throw new MercuryError('MODEL_SETUP_INVALID', 'V0.1 setup 只接受 runtime=cloud；本地 ASR 尚未进入本版本。');
  }
  if (!isRecord(value.provider_config)) throw new MercuryError('MODEL_SETUP_INVALID', 'provider_config 必须是对象。');

  const base = {
    config_id: text(value.config_id, 'config_id'),
    name: text(value.name, 'name'),
    role,
    runtime: 'cloud' as const,
    enabled: true,
    cloud_data_confirmation: confirmation(role, confirmed, method, timestamp, createId),
    config_fingerprint: '',
    last_check: null
  };

  const pluginId = value.plugin_id ?? value.adapter;

  let candidate: RawRecord;
  if (role === 'asr') {
    assertKeys(value.provider_config, ['resource_id'], 'ASR provider_config');
    if (pluginId !== 'volcengine_asr'
      || (value.connection_type !== undefined && value.connection_type !== 'volcengine_cloud')
      || value.endpoint !== null
      || value.provider_config.resource_id !== ASR_RESOURCE_ID) {
      throw new MercuryError('MODEL_SETUP_INVALID', 'ASR 必须使用内置 volcengine_asr 插件、volcengine_cloud 连接和极速版资源 ID。');
    }
    const importedModel = text(value.model, 'ASR model');
    if (importedModel !== ASR_MODEL && importedModel !== ASR_RESOURCE_ID) {
      throw new MercuryError('MODEL_SETUP_INVALID', `ASR model 必须是 ${ASR_MODEL}。`);
    }
    candidate = {
      ...base,
      plugin_id: 'volcengine_asr',
      connection_id: base.config_id,
      connection_type: 'volcengine_cloud',
      model: ASR_MODEL,
      endpoint: null,
      credential_ref: text(value.credential_ref, 'ASR credential_ref'),
      provider_config: { resource_id: ASR_RESOURCE_ID },
      declared_capabilities: structuredClone(VOLCENGINE_TRANSCRIPTION_PROFILE)
    };
  } else if (role === 'calibration') {
    assertKeys(value.provider_config, [], '校准 provider_config');
    if (pluginId !== 'openai_chat_completions'
      || (value.connection_type !== undefined && value.connection_type !== 'compatible_endpoint')) {
      throw new MercuryError('MODEL_SETUP_INVALID', '校准模型必须使用内置 openai_chat_completions 插件和 compatible_endpoint 连接。');
    }
    candidate = {
      ...base,
      plugin_id: 'openai_chat_completions',
      connection_id: base.config_id,
      connection_type: 'compatible_endpoint',
      model: text(value.model, '校准 model'),
      endpoint: text(value.endpoint, '校准 endpoint'),
      credential_ref: nullableText(value.credential_ref, '校准 credential_ref'),
      provider_config: {},
      declared_capabilities: structuredClone(CHAT_PROOFREADING_PROFILE)
    };
  } else {
    const connectionType = value.connection_type ?? (value.adapter === 'vertex_gemini_audio_verifier' ? 'vertex_ai' : undefined);
    if ((pluginId !== 'gemini' && value.adapter !== 'vertex_gemini_audio_verifier')
      || !['developer_api', 'vertex_ai'].includes(String(connectionType))
      || value.endpoint !== null) {
      throw new MercuryError('MODEL_SETUP_INVALID', '音频强校验必须使用内置 gemini 插件、developer_api 或 vertex_ai 连接和空 endpoint。');
    }
    if (connectionType === 'developer_api') {
      assertKeys(value.provider_config, [], 'Gemini Developer API provider_config');
    } else {
      assertKeys(value.provider_config, ['project', 'location'], 'Vertex AI provider_config');
    }
    candidate = {
      ...base,
      plugin_id: 'gemini',
      connection_id: base.config_id,
      connection_type: connectionType,
      model: text(value.model, '音频强校验 model'),
      endpoint: null,
      credential_ref: text(value.credential_ref, '音频强校验 credential_ref'),
      provider_config: connectionType === 'developer_api' ? {} : {
        project: text(value.provider_config.project, 'Vertex project'),
        location: text(value.provider_config.location, 'Vertex location')
      },
      declared_capabilities: structuredClone(AUDIO_VERIFICATION_PROFILE)
    };
  }

  candidate.config_fingerprint = computeModelConfigFingerprint(candidate);
  return candidate as unknown as ModelConfig;
}

function registryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'config', MODEL_CONFIG_FILE);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function validatedRegistry(value: unknown): ModelConfigRegistry {
  try {
    return normalizeModelRegistry(value);
  } catch (error) {
    if (error instanceof MercuryError) {
      throw new MercuryError('MODEL_SETUP_INVALID', error.message);
    }
    throw error;
  }
}

export async function loadModelRegistry(workspaceRoot: string): Promise<ModelConfigRegistry> {
  return loadNormalizedModelRegistry(workspaceRoot);
}

async function optionalRegistry(workspaceRoot: string): Promise<ModelConfigRegistry | null> {
  try {
    return await loadModelRegistry(workspaceRoot);
  } catch (error) {
    if (error instanceof MercuryError && error.code === 'MODEL_NOT_CONFIGURED') return null;
    throw error;
  }
}

async function saveRegistry(workspaceRoot: string, value: unknown): Promise<ModelConfigRegistry> {
  const registry = validatedRegistry(value);
  await writeJsonAtomic(registryPath(workspaceRoot), registry);
  return registry;
}

async function configureValues(
  workspaceRoot: string,
  values: unknown[],
  confirmed: boolean,
  method: SetupMethod,
  dependencies: ModelRuntimeDependencies = {},
  retainedModels: ModelConfig[] = []
): Promise<ModelConfigRegistry> {
  await ensureWorkspace(workspaceRoot);
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const timestamp = now().toISOString();
  const replacements = values.map((value) => inputModel(value, confirmed, method, timestamp, createId));
  const byRole = new Map<ModelRole, ModelConfig>();
  for (const model of retainedModels) byRole.set(model.role, structuredClone(model));
  for (const model of replacements) {
    if (byRole.has(model.role) && !retainedModels.some((retained) => retained.role === model.role)) {
      throw new MercuryError('MODEL_SETUP_INVALID', `角色 ${model.role} 不能出现多个默认模型。`);
    }
    byRole.set(model.role, model);
  }
  if (!byRole.has('asr') || !byRole.has('calibration')) {
    throw new MercuryError('MODEL_SETUP_INVALID', 'setup 文件必须各包含一个默认 ASR 和校准模型。');
  }

  const existing = await optionalRegistry(workspaceRoot);
  if (!byRole.has('audio_verification')) {
    const retained = existing?.models.find((model) => model.role === 'audio_verification');
    if (retained) byRole.set('audio_verification', retained);
  }
  const models = ROLE_ORDER.flatMap((role) => byRole.get(role) ? [byRole.get(role)!] : []);
  const audioVerification = byRole.get('audio_verification');
  return saveRegistry(workspaceRoot, {
    schema_version: '1.0.0',
    updated_at: timestamp,
    models,
    defaults: {
      asr: byRole.get('asr')!.config_id,
      calibration: byRole.get('calibration')!.config_id,
      ...(audioVerification ? { audio_verification: audioVerification.config_id } : {})
    }
  });
}

export async function setupFromFile(
  workspaceRoot: string,
  configPath: string,
  confirmCloudData: boolean,
  dependencies: ModelRuntimeDependencies = {}
): Promise<ModelConfigRegistry> {
  let parsed: unknown;
  try {
    const bytes = await readFile(path.resolve(configPath));
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new MercuryError('MODEL_SETUP_READ_FAILED', `无法读取 setup JSON：${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new MercuryError('MODEL_SETUP_INVALID', 'setup JSON 顶层必须是对象。');
  assertKeys(parsed, ['models'], 'setup JSON');
  if (!Array.isArray(parsed.models)) throw new MercuryError('MODEL_SETUP_INVALID', 'setup JSON 必须包含 models 数组。');
  return configureValues(workspaceRoot, parsed.models, confirmCloudData, 'non_interactive_flag', dependencies);
}

function answerOrDefault(answer: string, fallback: string): string {
  return answer.trim() || fallback;
}

function yes(answer: string, defaultValue = false): boolean {
  const normalized = answer.trim().toLowerCase();
  if (normalized === '') return defaultValue;
  return normalized === 'y' || normalized === 'yes' || normalized === '是';
}

function importShape(model: ModelConfig): RawRecord {
  const plugin = isPluginModelConfig(model)
    ? {
        plugin_id: model.plugin_id,
        connection_type: model.connection_type
      }
    : { adapter: (model as unknown as { adapter: string }).adapter };
  return {
    config_id: model.config_id,
    name: model.name,
    role: model.role,
    runtime: model.runtime,
    ...plugin,
    model: model.model,
    endpoint: model.endpoint,
    credential_ref: model.credential_ref,
    provider_config: structuredClone(model.provider_config),
    default: true
  };
}

export async function setupInteractive(
  workspaceRoot: string,
  prompt: (question: string) => Promise<string>,
  dependencies: ModelRuntimeDependencies = {}
): Promise<ModelConfigRegistry> {
  await ensureWorkspace(workspaceRoot);
  const existing = await optionalRegistry(workspaceRoot);
  const existingRole = (role: ModelRole) => existing?.models.find((model) => model.role === role);
  const values: RawRecord[] = [];
  const retainedModels: ModelConfig[] = [];
  const retainOrReconfirm = (model: ModelConfig) => {
    if (model.cloud_data_confirmation.confirmed) retainedModels.push(model);
    else values.push(importShape(model));
  };

  const oldAsr = existingRole('asr');
  if (oldAsr && yes(await prompt(`保留现有 ASR「${oldAsr.name}」？[Y/n] `), true)) {
    retainOrReconfirm(oldAsr);
  } else {
    values.push({
      config_id: 'asr-default',
      name: answerOrDefault(await prompt('ASR 名称 [火山极速版]：'), '火山极速版'),
      role: 'asr', runtime: 'cloud', plugin_id: 'volcengine_asr', connection_type: 'volcengine_cloud', model: ASR_MODEL,
      endpoint: null,
      credential_ref: await prompt('ASR 凭证引用（env:/keychain:/file:）：'),
      provider_config: { resource_id: ASR_RESOURCE_ID },
      default: true
    });
  }

  const oldCalibration = existingRole('calibration');
  if (oldCalibration && yes(await prompt(`保留现有校准模型「${oldCalibration.name}」？[Y/n] `), true)) {
    retainOrReconfirm(oldCalibration);
  } else {
    const name = answerOrDefault(await prompt('校准模型名称 [校准模型]：'), '校准模型');
    const model = await prompt('校准模型标识：');
    const endpoint = await prompt('Chat Completions HTTPS base URL：');
    const credential = (await prompt('校准凭证引用（无需凭证可留空）：')).trim();
    values.push({
      config_id: 'calibration-default',
      name,
      role: 'calibration', runtime: 'cloud', plugin_id: 'openai_chat_completions', connection_type: 'compatible_endpoint',
      model,
      endpoint,
      credential_ref: credential || null,
      provider_config: {},
      default: true
    });
  }

  const oldAudioVerification = existingRole('audio_verification');
  if (oldAudioVerification) {
    if (yes(await prompt(`保留现有音频强校验「${oldAudioVerification.name}」？[Y/n] `), true)) {
      retainOrReconfirm(oldAudioVerification);
    }
  } else if (yes(await prompt('配置可选 Gemini 音频强校验？[y/N] '))) {
    const connection = answerOrDefault(await prompt('连接方式 developer_api / vertex_ai [developer_api]：'), 'developer_api');
    if (connection !== 'developer_api' && connection !== 'vertex_ai') {
      throw new MercuryError('MODEL_SETUP_INVALID', `不支持的 Gemini 连接方式：${connection}`);
    }
    const providerConfig: RawRecord = {};
    if (connection === 'vertex_ai') {
      providerConfig.project = await prompt('Google Cloud project：');
      providerConfig.location = await prompt('Vertex AI location：');
    }
    values.push({
      config_id: 'audio-verification-default',
      name: answerOrDefault(await prompt('音频强校验名称 [Gemini]：'), 'Gemini'),
      role: 'audio_verification', runtime: 'cloud', plugin_id: 'gemini', connection_type: connection,
      model: await prompt('Gemini 模型标识：'), endpoint: null,
      credential_ref: await prompt(connection === 'developer_api'
        ? 'Developer API Key 引用（env:/keychain:/file:）：'
        : 'Vertex 凭证引用（adc:/keychain:/file:）：'),
      provider_config: providerConfig,
      default: true
    });
  }

  if (!yes(await prompt('确认保存以上配置并允许对应数据发送到云端？[y/N] '))) {
    throw new MercuryError('MODEL_SETUP_CANCELLED', '已取消 setup，未写入模型配置。');
  }
  return configureValues(workspaceRoot, values, true, 'interactive_cli', dependencies, retainedModels);
}

function mp3Frame(buffer: Buffer, index: number): { length: number; durationMs: number } | null {
  if (index + 3 >= buffer.length || buffer[index] !== 0xff || (buffer[index + 1]! & 0xe0) !== 0xe0) return null;
  const versionBits = (buffer[index + 1]! >> 3) & 0x03;
  const layerBits = (buffer[index + 1]! >> 1) & 0x03;
  const bitrateIndex = (buffer[index + 2]! >> 4) & 0x0f;
  const sampleRateIndex = (buffer[index + 2]! >> 2) & 0x03;
  if (versionBits === 0x01 || layerBits !== 0x01 || bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null;
  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const baseSampleRates = [44100, 48000, 32000];
  const isMpeg1 = versionBits === 0x03;
  const bitrate = (isMpeg1 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex]!;
  const baseSampleRate = baseSampleRates[sampleRateIndex]!;
  const sampleRate = versionBits === 0 ? baseSampleRate / 4 : isMpeg1 ? baseSampleRate : baseSampleRate / 2;
  const padding = (buffer[index + 2]! >> 1) & 1;
  return {
    length: Math.floor((isMpeg1 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding,
    durationMs: (isMpeg1 ? 1152 : 576) / sampleRate * 1000
  };
}

function mp3Duration(buffer: Buffer): number {
  let start = -1;
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    const first = mp3Frame(buffer, index);
    if (first && mp3Frame(buffer, index + first.length)) {
      start = index;
      break;
    }
  }
  if (start < 0) throw new MercuryError('AUDIO_CONTENT_INVALID', '检查样本不是可识别的 MP3。');
  let total = 0;
  let frames = 0;
  for (let index = start; index + 3 < buffer.length;) {
    const frame = mp3Frame(buffer, index);
    if (!frame || index + frame.length > buffer.length) break;
    total += frame.durationMs;
    frames += 1;
    index += frame.length;
  }
  if (frames < 2) throw new MercuryError('AUDIO_CONTENT_INVALID', '检查样本不是可识别的 MP3。');
  return Math.max(1, Math.round(total));
}

export async function readMp3DurationMs(filePath: string): Promise<number> {
  return mp3Duration(await readFile(filePath));
}

async function prepareCheckAudio(workspaceRoot: string, audioPath: string, checkId: string) {
  const absolute = path.resolve(audioPath);
  if (path.extname(absolute).toLowerCase() !== '.mp3') throw new MercuryError('AUDIO_EXTENSION_INVALID', '模型检查样本必须是 .mp3。');
  const beforeStat = await stat(absolute);
  if (!beforeStat.isFile()) throw new MercuryError('INPUT_NOT_REGULAR_FILE', `音频检查样本不是普通文件：${absolute}`);
  if (beforeStat.size > VOLCENGINE_ASR_MAX_INPUT_BYTES) {
    throw new MercuryError('ASR_INPUT_SIZE_EXCEEDED', '模型检查 MP3 超过火山极速版 100 MiB 限制。');
  }
  const bytes = await readFile(absolute);
  const durationMs = mp3Duration(bytes);
  const beforeHash = await sha256File(absolute);
  const checkRoot = path.join(workspaceRoot, 'models', 'checks', checkId);
  const inputDirectory = path.join(checkRoot, 'input');
  await mkdir(path.join(checkRoot, 'work'), { recursive: true });
  await mkdir(inputDirectory, { recursive: true });
  const copyPath = path.join(inputDirectory, 'check.mp3');
  await copyFile(absolute, copyPath, fileConstants.COPYFILE_EXCL);
  if (await sha256File(copyPath) !== beforeHash || await sha256File(absolute) !== beforeHash) {
    throw new MercuryError('INPUT_COPY_MISMATCH', '模型检查音频复制校验失败。');
  }
  const afterStat = await stat(absolute);
  if (afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs) {
    throw new MercuryError('INPUT_COPY_MISMATCH', '模型检查期间原始音频发生变化。');
  }
  await chmod(copyPath, 0o444);
  return { sourcePath: copyPath, sha256: beforeHash, durationMs };
}

export async function readCredentialReference(reference: string): Promise<string> {
  if (reference.startsWith('env:')) {
    const value = process.env[reference.slice(4)];
    if (!value) throw new Error('credential environment variable is unavailable');
    return value;
  }
  if (reference.startsWith('file:')) return (await readFile(reference.slice(5), 'utf8')).trim();
  if (reference.startsWith('keychain:')) {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', reference.slice(9), '-w'], { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  }
  throw new Error('unsupported credential reference');
}

export function parseVolcengineCredential(value: string): ResolvedVolcengineCredential {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed) && parsed.mode === 'api_key' && typeof parsed.uid === 'string' && typeof parsed.value === 'string') {
      return { mode: 'api_key', uid: parsed.uid, value: parsed.value };
    }
    if (isRecord(parsed) && parsed.mode === 'legacy' && typeof parsed.uid === 'string' && typeof parsed.appKey === 'string' && typeof parsed.accessKey === 'string') {
      return { mode: 'legacy', uid: parsed.uid, appKey: parsed.appKey, accessKey: parsed.accessKey };
    }
  } catch {
    // A raw environment or keychain value is the official API key form.
  }
  return { mode: 'api_key', uid: value, value };
}

export async function resolveVolcengineCredentialReference(
  reference: string
): Promise<ResolvedVolcengineCredential> {
  return parseVolcengineCredential(await readCredentialReference(reference));
}

function provisionalCheck(model: PluginModelConfig, timestamp: string): ModelCheckRecord {
  // D003/D004 consume frozen task snapshots and therefore require a passed snapshot check.
  // This bootstrap record exists only in memory while executing the check adapter; the
  // actual adapter outcome below is the only record persisted to model-config.json.
  const capabilities = model.role === 'asr'
    ? {
        role: 'asr', sample_sha256: '0'.repeat(64), language: 'zh-CN', mime_type: 'audio/mpeg',
        audio_input: 'audio_data_base64', max_input_bytes: VOLCENGINE_ASR_MAX_INPUT_BYTES,
        max_audio_duration_ms: VOLCENGINE_ASR_MAX_DURATION_MS, transcript_chars: 1, segment_count: 1,
        timing_granularity: 'segment'
      }
    : model.role === 'calibration' ? {
        role: 'calibration', fixture_id: 'model-check-calibration-v1', language: 'zh-CN',
        request_profile: 'chat_completions_minimal', parsed_suggestion_count: 0, result_schema_version: '1.0.0'
      } : {
        role: 'audio_verification', sample_sha256: '0'.repeat(64), mime_type: 'audio/mpeg',
        timed_text_fixture_id: 'model-check-audio-v1', result_schema_version: '1.0.0',
        inline_audio: { max_inline_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES, max_audio_duration_ms: 7_200_000, parsed_finding_count: 0 },
        private_gcs: null,
        local_chunking: {
          threshold_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES,
          source_bytes: 1,
          part_count: 1,
          largest_part_bytes: 1,
          model_request_count: 1,
          parts: [{
            chunk_id: 'chunk-bootstrap', bytes: 1, start_ms: 0, end_ms: 1,
            call_ref: 'call-bootstrap', outcome: 'completed', error_ref: null
          }]
        }
      };
  return {
    check_id: 'check-bootstrap',
    config_id: model.config_id,
    config_fingerprint: model.config_fingerprint,
    role: model.role,
    confirmation_ref: model.cloud_data_confirmation.confirmation_id,
    started_at: timestamp,
    ended_at: timestamp,
    outcome: 'passed',
    actual_model: model.model,
    capabilities: capabilities as AsrCapabilities | CalibrationCapabilities | AudioVerificationCapabilities,
    verified_capabilities: structuredClone(model.declared_capabilities),
    error: null
  } as unknown as ModelCheckRecord;
}

function snapshotEntry(model: ModelConfig, timestamp: string, entryId: string): PluginModelSnapshotEntry {
  if (!isPluginModelConfig(model)) {
    throw new MercuryError('MODEL_PLUGIN_NOT_MIGRATED', `${model.role} 模型未迁入内置插件。`);
  }
  return {
    snapshot_entry_id: entryId,
    role: model.role,
    config_id: model.config_id,
    name: model.name,
    config_fingerprint: model.config_fingerprint,
    plugin_id: model.plugin_id,
    connection_id: model.connection_id,
    connection_type: model.connection_type,
    model: model.model,
    runtime: model.runtime,
    endpoint: model.endpoint,
    credential_ref: model.credential_ref,
    provider_config: structuredClone(model.provider_config),
    declared_capabilities: structuredClone(model.declared_capabilities),
    cloud_data_confirmation: structuredClone(model.cloud_data_confirmation),
    check_snapshot: provisionalCheck(model, timestamp)
  } as PluginModelSnapshotEntry;
}

function fixedTranscript(taskId: string, snapshotId: string, entryId: string, timestamp: string, durationMs = 1000): TranscriptRaw {
  return {
    schema_version: '1.0.0', task_id: taskId, created_at: timestamp,
    audio: { path_ref: 'input/model-check.mp3', sha256: '0'.repeat(64), duration_ms: durationMs, language: 'zh-CN', mime_type: 'audio/mpeg' },
    full_text: '你好，Mercury。',
    segments: [{ segment_id: 'seg-check-1', index: 0, start_ms: 0, end_ms: durationMs, text: '你好，Mercury。', confidence: null, words: [] }],
    model_snapshot_ref: snapshotId,
    call: { call_id: 'call-check-fixture', model_snapshot_entry_ref: entryId, started_at: timestamp, ended_at: timestamp, outcome: 'completed', error_ref: null },
    raw_response_ref: null, warnings: [], errors: []
  };
}

function fixedCalibration(taskId: string, snapshotId: string, entryId: string, timestamp: string): CalibrationResult & { status: 'completed' } {
  return {
    schema_version: '1.0.0', task_id: taskId, created_at: timestamp, status: 'completed',
    request: { transcript_ref: 'work/transcript.raw.json', reference_srt_ref: null, mode: null },
    model_snapshot_ref: snapshotId,
    call: { call_id: 'call-check-calibration', model_snapshot_entry_ref: entryId, started_at: timestamp, ended_at: timestamp, outcome: 'completed', error_ref: null },
    suggestions: [], warnings: [], errors: []
  };
}

function fixedCalibrated(taskId: string, durationMs = 1000): CalibratedTranscript {
  return {
    artifact_version: '1.0.0', task_id: taskId, mode: null, thresholds_version: 'v0.1',
    source_refs: { transcript_ref: 'work/transcript.raw.json', calibration_ref: 'work/calibration-result.json', reference_srt_ref: null },
    segments: [{
      subtitle_segment_id: 'sub-check-1', index: 0, start_ms: 0, end_ms: durationMs,
      text: '你好，Mercury。', confidence: 'high', asr_segment_refs: ['seg-check-1'], reference_segment_refs: []
    }],
    modifications: [], warnings: []
  };
}

function resultError<T>(result: AdapterExecutionResult<T>): ErrorRecord | null {
  if (result.kind === 'failure') return result.failure.errors[0] ?? null;
  const artifact = result.artifact as { status?: string; errors?: ErrorRecord[] };
  if (artifact.status === 'failed') return artifact.errors?.[0] ?? null;
  return artifact.status === 'skipped' ? {
    error_id: 'error-model-check-no-provider-call',
    code: 'MODEL_CHECK_NO_PROVIDER_CALL',
    message: 'The model check did not complete a real provider request.',
    stage: 'capability',
    retryable: false
  } : null;
}

function failedCheck(model: ModelConfig, checkId: string, startedAt: string, endedAt: string, error: ErrorRecord): ModelCheckRecord {
  return {
    check_id: checkId, config_id: model.config_id, config_fingerprint: model.config_fingerprint,
    role: model.role, confirmation_ref: model.cloud_data_confirmation.confirmation_id,
    started_at: startedAt, ended_at: endedAt, outcome: 'failed', actual_model: null, capabilities: null,
    verified_capabilities: null,
    error
  } as unknown as ModelCheckRecord;
}

async function persistCheck(workspaceRoot: string, registry: ModelConfigRegistry, model: ModelConfig, check: ModelCheckRecord): Promise<void> {
  model.last_check = check;
  registry.updated_at = check.ended_at;
  await saveRegistry(workspaceRoot, registry);
}

export async function checkModels(
  workspaceRoot: string,
  roles: ModelRole[],
  audioPath: string | undefined,
  dependencies: ModelRuntimeDependencies = {}
): Promise<ModelCheckResult[]> {
  await ensureWorkspace(workspaceRoot);
  const registry = await loadModelRegistry(workspaceRoot);
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const readCredential = dependencies.readCredential ?? readCredentialReference;
  const results: ModelCheckResult[] = [];

  for (const role of roles) {
    const configId = registry.defaults[role];
    const model = configId ? registry.models.find((entry) => entry.config_id === configId && entry.role === role) : undefined;
    if (!model || !model.enabled) throw new MercuryError('MODEL_NOT_CONFIGURED', `默认 ${role} 模型未配置或未启用。`);
    if (!model.cloud_data_confirmation.confirmed) {
      throw new MercuryError('CLOUD_DATA_NOT_CONFIRMED', `${role} 模型尚未确认云端数据发送，未发起检查。`);
    }
    const checkId = setupId(createId, 'check');
    const taskId = setupId(createId, 'model-check');
    const snapshotId = setupId(createId, 'snapshot');
    const entryId = setupId(createId, 'entry');
    const startedAt = now().toISOString();
    const entry = snapshotEntry(model, startedAt, entryId);
    const pluginRegistry = createBuiltinPluginRegistry();
    let adapterResult: AdapterExecutionResult<unknown>;
    let actualModel = model.model;

    if (role === 'asr') {
      if (!audioPath) throw new MercuryError('MODEL_CHECK_AUDIO_REQUIRED', '检查 ASR 必须提供 --audio。');
      const audio = await prepareCheckAudio(workspaceRoot, audioPath, checkId);
      const resolved = pluginRegistry.resolveTranscription(entry as unknown as ModelSnapshotEntry, {
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        resolveAsrCredential: async (reference) => parseVolcengineCredential(await readCredential(reference))
      });
      adapterResult = await resolved.runtime.run({
        taskId, modelSnapshotRef: snapshotId,
        model: resolved.entry,
        audio: { sourcePath: audio.sourcePath, pathRef: 'input/check.mp3', sha256: audio.sha256, durationMs: audio.durationMs, mimeType: 'audio/mpeg', language: 'zh-CN' }
      });
    } else if (role === 'calibration') {
      const checkRoot = path.join(workspaceRoot, 'models', 'checks', checkId);
      await mkdir(path.join(checkRoot, 'work'), { recursive: true });
      const resolved = pluginRegistry.resolveProofreading(entry as unknown as ModelSnapshotEntry, {
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(model.credential_ref === null ? {} : { readCredential }),
        captureCalibrationResponseBody: async (body) => writeFile(path.join(checkRoot, 'work', 'provider-response.calibration.json'), body, { encoding: 'utf8', mode: 0o600 })
      });
      adapterResult = await resolved.runtime.run({
        taskId, modelSnapshotRef: snapshotId,
        model: resolved.entry,
        transcript: fixedTranscript(taskId, snapshotId, entryId, startedAt), referenceSrt: null, mode: null
      });
    } else {
      if (!audioPath) throw new MercuryError('MODEL_CHECK_AUDIO_REQUIRED', '检查音频强校验必须提供 --audio。');
      const audio = await prepareCheckAudio(workspaceRoot, audioPath, checkId);
      const commonDependencies = {
        ...dependencies,
        readCredential,
        captureActualModel: (value: string) => { actualModel = value; }
      };
      const inline = pluginRegistry.resolveAudioVerification(entry as unknown as ModelSnapshotEntry, commonDependencies);
      const transcript = fixedTranscript(taskId, snapshotId, entryId, startedAt, audio.durationMs);
      transcript.audio.path_ref = 'input/check.mp3';
      transcript.audio.sha256 = audio.sha256;
      const input = {
        taskId, modelSnapshotRef: snapshotId, model: inline.entry,
        audio: { sourcePath: audio.sourcePath, pathRef: 'input/check.mp3', sha256: audio.sha256, durationMs: audio.durationMs, mimeType: 'audio/mpeg' as const, language: 'zh-CN' as const },
        transcript,
        calibrationResult: fixedCalibration(taskId, snapshotId, entryId, startedAt),
        calibratedTranscript: fixedCalibrated(taskId, audio.durationMs), referenceSrt: null
      };
      adapterResult = await inline.runtime.run(input);
    }

    const endedAt = now().toISOString();
    const error = resultError(adapterResult);
    let check: ModelCheckRecord;
    if (error) {
      check = failedCheck(model, checkId, startedAt, endedAt, error);
    } else if (role === 'asr' && adapterResult.kind === 'artifact') {
      const transcript = adapterResult.artifact as TranscriptRaw;
      check = {
        check_id: checkId, config_id: model.config_id, config_fingerprint: model.config_fingerprint,
        role, confirmation_ref: model.cloud_data_confirmation.confirmation_id,
        started_at: startedAt, ended_at: endedAt, outcome: 'passed', actual_model: model.model,
        capabilities: {
          role: 'asr', sample_sha256: transcript.audio.sha256, language: 'zh-CN', mime_type: 'audio/mpeg',
          audio_input: 'audio_data_base64', max_input_bytes: VOLCENGINE_ASR_MAX_INPUT_BYTES,
          max_audio_duration_ms: VOLCENGINE_ASR_MAX_DURATION_MS,
          transcript_chars: Array.from(transcript.full_text).length,
          segment_count: transcript.segments.length,
          timing_granularity: transcript.segments.some((segment) => segment.words.length > 0) ? 'word' : 'segment'
        },
        verified_capabilities: structuredClone(VOLCENGINE_TRANSCRIPTION_PROFILE),
        error: null
      } as unknown as ModelCheckRecord;
    } else if (role === 'calibration' && adapterResult.kind === 'artifact') {
      const artifact = adapterResult.artifact as { suggestions: unknown[] };
      check = {
        check_id: checkId, config_id: model.config_id, config_fingerprint: model.config_fingerprint,
        role, confirmation_ref: model.cloud_data_confirmation.confirmation_id,
        started_at: startedAt, ended_at: endedAt, outcome: 'passed', actual_model: model.model,
        capabilities: {
          role: 'calibration', fixture_id: 'model-check-calibration-v1', language: 'zh-CN',
          request_profile: 'chat_completions_minimal', parsed_suggestion_count: artifact.suggestions.length,
          result_schema_version: '1.0.0'
        },
        verified_capabilities: structuredClone(CHAT_PROOFREADING_PROFILE),
        error: null
      } as unknown as ModelCheckRecord;
    } else if (role === 'audio_verification' && adapterResult.kind === 'artifact') {
      const inlineArtifact = adapterResult.artifact as AudioVerification;
      const evidence = inlineArtifact.local_chunking;
      if (!evidence || inlineArtifact.calls.length === 0 || evidence.parts.length === 0) {
        throw new MercuryError('MODEL_CHECK_NO_PROVIDER_CALL', '音频强校验没有形成可回读的真实模型请求证据。');
      }
      const capabilities: AudioVerificationCapabilities = {
        role: 'audio_verification', sample_sha256: inlineArtifact.input!.audio_sha256, mime_type: 'audio/mpeg',
        timed_text_fixture_id: 'model-check-audio-v1', result_schema_version: '1.0.0',
        inline_audio: {
          max_inline_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES,
          max_audio_duration_ms: 7_200_000,
          parsed_finding_count: inlineArtifact.findings.length
        },
        private_gcs: null,
        local_chunking: {
          threshold_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES,
          source_bytes: evidence.source_bytes,
          part_count: evidence.parts.length,
          largest_part_bytes: Math.max(...evidence.parts.map((part) => part.bytes)),
          model_request_count: inlineArtifact.calls.length,
          parts: structuredClone(evidence.parts)
        }
      };
      check = {
        check_id: checkId, config_id: model.config_id, config_fingerprint: model.config_fingerprint,
        role, confirmation_ref: model.cloud_data_confirmation.confirmation_id,
        started_at: startedAt, ended_at: endedAt, outcome: 'passed', actual_model: actualModel,
        capabilities, verified_capabilities: structuredClone(AUDIO_VERIFICATION_PROFILE), error: null
      } as unknown as ModelCheckRecord;
    } else {
      throw new MercuryError('MODEL_CHECK_RESULT_INVALID', `${role} 适配器没有返回可持久化的检查结果。`);
    }
    await persistCheck(workspaceRoot, registry, model, check);
    results.push({ role, outcome: check.outcome, error: check.error });
  }
  return results;
}
