import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import commonSchema from '../../schemas/exchange/v1/common.schema.json' with { type: 'json' };
import requestSchema from '../../schemas/exchange/v1/request.schema.json' with { type: 'json' };
import taskSchema from '../../schemas/exchange/v1/task.schema.json' with { type: 'json' };
import eventSchema from '../../schemas/exchange/v1/event.schema.json' with { type: 'json' };
import resultSchema from '../../schemas/exchange/v1/result.schema.json' with { type: 'json' };
import errorSchema from '../../schemas/exchange/v1/error.schema.json' with { type: 'json' };
import transcriptSchema from '../../schemas/exchange/v1/transcript.schema.json' with { type: 'json' };
import dictionarySchema from '../../schemas/exchange/v1/dictionary.schema.json' with { type: 'json' };
import type { ExchangeRequestV1 } from './generated/exchange-request-v1.js';
import type { ExchangeTaskV1 } from './generated/exchange-task-v1.js';
import type { ExchangeEventV1 } from './generated/exchange-event-v1.js';
import type { ExchangeResultV1 } from './generated/exchange-result-v1.js';
import type { ExchangeErrorV1 } from './generated/exchange-error-v1.js';
import type { ExchangeTranscriptV1 } from './generated/exchange-transcript-v1.js';
import type { ExchangeDictionaryV1 } from './generated/exchange-dictionary-v1.js';
import { MercuryError } from '../errors.js';

export const EXCHANGE_CONTRACTS = {
  request: 'mercury.exchange.request/v1',
  task: 'mercury.task/v1',
  event: 'mercury.event/v1',
  result: 'mercury.result/v1',
  error: 'mercury.error/v1',
  transcript: 'mercury.transcript/v1',
  dictionary: 'mercury.dictionary/v1',
} as const;

export type ExchangeContractName = keyof typeof EXCHANGE_CONTRACTS;
export interface ExchangeContractTypeMap {
  request: ExchangeRequestV1;
  task: ExchangeTaskV1;
  event: ExchangeEventV1;
  result: ExchangeResultV1;
  error: ExchangeErrorV1;
  transcript: ExchangeTranscriptV1;
  dictionary: ExchangeDictionaryV1;
}
export type ExchangeValidationIssue = { path: string; message: string };
export type ExchangeValidationResult<T> =
  | { valid: true; value: T; issues: [] }
  | { valid: false; value: null; issues: ExchangeValidationIssue[] };

const schemas = {
  request: requestSchema,
  task: taskSchema,
  event: eventSchema,
  result: resultSchema,
  error: errorSchema,
  transcript: transcriptSchema,
  dictionary: dictionarySchema,
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(commonSchema);
for (const schema of [dictionarySchema, errorSchema, transcriptSchema, requestSchema, taskSchema, eventSchema, resultSchema]) {
  ajv.addSchema(schema);
}

function issue(path: string, message: string): ExchangeValidationIssue {
  return { path, message };
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) =>
    /^(?:authorization|api[_-]?key|access[_-]?token|secret|credential)$/iu.test(key)
    || containsSensitiveKey(child));
}

function semanticIssues(name: ExchangeContractName, value: any): ExchangeValidationIssue[] {
  const issues: ExchangeValidationIssue[] = [];
  if (containsSensitiveKey(value.extensions)) {
    issues.push(issue('/extensions', '扩展字段不得携带凭据或授权头'));
  }
  if (name === 'request') {
    const transcriptSource = value.inputs.transcript?.role === 'transcript_source';
    if (value.transcription_mode === 'provided') {
      if (!transcriptSource) issues.push(issue('/inputs/transcript/role', 'provided 模式必须显式使用 transcript_source'));
      if (value.models.asr !== null) issues.push(issue('/models/asr', 'provided 模式不得选择 ASR'));
    } else {
      if (value.inputs.media === null) issues.push(issue('/inputs/media', 'provider 模式必须提供媒体'));
      if (value.models.asr === null) issues.push(issue('/models/asr', 'provider 模式必须选择 ASR'));
      if (transcriptSource) issues.push(issue('/inputs/transcript/role', 'provider 模式不能同时声明 transcript_source'));
    }
    if (value.inputs.media === null && value.calibration.mode === 'text-and-segmentation') {
      issues.push(issue('/calibration/mode', '无媒体时只能使用 text-only'));
    }
  } else if (name === 'transcript') {
    let previousEnd = -1;
    const ids = new Set<string>();
    for (const [index, segment] of value.segments.entries()) {
      if (segment.index !== index) issues.push(issue(`/segments/${index}/index`, `应为 ${index}`));
      if (ids.has(segment.segment_id)) issues.push(issue(`/segments/${index}/segment_id`, 'segment_id 必须唯一'));
      ids.add(segment.segment_id);
      if (segment.end_ms <= segment.start_ms) issues.push(issue(`/segments/${index}/end_ms`, '片段结束时间必须晚于开始时间'));
      if (segment.start_ms < previousEnd) issues.push(issue(`/segments/${index}/start_ms`, '片段必须有序且不重叠'));
      previousEnd = segment.end_ms;
      let wordEnd = segment.start_ms;
      for (const [wordIndex, word] of segment.words.entries()) {
        if (word.end_ms <= word.start_ms || word.start_ms < segment.start_ms || word.end_ms > segment.end_ms || word.start_ms < wordEnd) {
          issues.push(issue(`/segments/${index}/words/${wordIndex}`, '词级时间必须在片段内有序且为正区间'));
        }
        wordEnd = Math.max(wordEnd, word.end_ms);
      }
    }
    if (value.text !== value.segments.map((segment: any) => segment.text).join('\n')) {
      issues.push(issue('/text', '完整正文必须与规范化片段逐行连接完全一致'));
    }
    if (value.duration_ms !== null && previousEnd > value.duration_ms) {
      issues.push(issue('/duration_ms', '片段不能超出声明时长'));
    }
  } else if (name === 'dictionary') {
    if ((value.scope === 'project') !== (value.project_key !== null)) {
      issues.push(issue('/project_key', 'project_key 必须且只能用于 project 词典'));
    }
    const entryIds = new Set<string>();
    const variantOwners = new Map<string, string>();
    for (const [index, entry] of value.entries.entries()) {
      if (entryIds.has(entry.entry_id)) issues.push(issue(`/entries/${index}/entry_id`, 'entry_id 必须唯一'));
      entryIds.add(entry.entry_id);
      if (entry.variants.includes(entry.canonical)) issues.push(issue(`/entries/${index}/variants`, 'variants 不应重复 canonical'));
      if (!entry.enabled) continue;
      for (const variant of [entry.canonical, ...entry.variants]) {
        const normalized = entry.case_sensitive ? variant.normalize('NFC') : variant.normalize('NFC').toLocaleLowerCase('und');
        const owner = variantOwners.get(normalized);
        if (owner && owner !== entry.canonical) issues.push(issue(`/entries/${index}`, '同一有效写法不能指向不同 canonical'));
        variantOwners.set(normalized, entry.canonical);
      }
    }
  } else if (name === 'task') {
    const terminal = ['needs_input', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status);
    if (value.status === 'completed' && value.error !== null) issues.push(issue('/error', 'completed 任务不能携带错误'));
    if (['failed', 'interrupted'].includes(value.status) && value.error === null) issues.push(issue('/error', `${value.status} 任务必须携带错误`));
    if (!terminal && value.worker.status === 'inactive' && value.status === 'running') issues.push(issue('/worker/status', 'running 任务不能确定声明 Worker inactive'));
    if (value.pause.allowed && !value.capabilities.pause.supported) issues.push(issue('/pause/allowed', '不支持 pause 时不能允许该动作'));
    if (value.retry.allowed && !value.capabilities.retry.supported) issues.push(issue('/retry/allowed', '不支持 retry 时不能允许该动作'));
  } else if (name === 'result') {
    if (value.transcription.mode === 'provided' && value.transcription.asr_call_count !== 0) {
      issues.push(issue('/transcription/asr_call_count', 'provided 转录的 ASR 调用数必须为 0'));
    }
    if (value.review.status === 'finalized' && !value.review.approved) issues.push(issue('/review/approved', 'finalized 必须具有已批准产物'));
    for (const [index, artifact] of value.artifacts.entries()) {
      if (artifact.exists !== (artifact.path !== null)) issues.push(issue(`/artifacts/${index}/path`, 'exists 必须与 path 是否存在一致'));
      if (!artifact.exists && artifact.sha256 !== null) issues.push(issue(`/artifacts/${index}/sha256`, '不存在的产物不能声明 hash'));
    }
  }
  return issues;
}

function schemaIssues(errors: ErrorObject[] | null | undefined): ExchangeValidationIssue[] {
  return (errors ?? []).map((entry) => ({
    path: entry.instancePath || '/',
    message: entry.message ?? entry.keyword,
  }));
}

export function exchangeSchemaDocuments(): Readonly<Record<ExchangeContractName | 'common', unknown>> {
  return { common: commonSchema, ...schemas };
}

export function validateExchangeContract<N extends ExchangeContractName>(
  name: N,
  value: unknown,
): ExchangeValidationResult<ExchangeContractTypeMap[N]> {
  const validate = ajv.getSchema(schemas[name].$id) as ValidateFunction;
  if (!validate(value)) return { valid: false, value: null, issues: schemaIssues(validate.errors) };
  const issues = semanticIssues(name, value);
  if (issues.length > 0) return { valid: false, value: null, issues };
  return { valid: true, value: structuredClone(value) as ExchangeContractTypeMap[N], issues: [] };
}

export function assertExchangeContract<N extends ExchangeContractName>(
  name: N,
  value: unknown,
): ExchangeContractTypeMap[N] {
  const result = validateExchangeContract(name, value);
  if (!result.valid) {
    throw new MercuryError(
      'CONTRACT_INVALID',
      `${EXCHANGE_CONTRACTS[name]} 无效：${result.issues.map((entry) => `${entry.path} ${entry.message}`).join('; ')}`,
      { exitCode: 2, remediation: '检查合同版本和字段后重新提交；不要直接修改任务内部文件。' },
    );
  }
  return result.value;
}
