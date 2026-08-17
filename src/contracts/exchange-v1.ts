import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import path from 'node:path';
import commonSchema from '../../schemas/exchange/v1/common.schema.json' with { type: 'json' };
import requestSchema from '../../schemas/exchange/v1/request.schema.json' with { type: 'json' };
import taskSchema from '../../schemas/exchange/v1/task.schema.json' with { type: 'json' };
import eventSchema from '../../schemas/exchange/v1/event.schema.json' with { type: 'json' };
import resultSchema from '../../schemas/exchange/v1/result.schema.json' with { type: 'json' };
import errorSchema from '../../schemas/exchange/v1/error.schema.json' with { type: 'json' };
import transcriptSchema from '../../schemas/exchange/v1/transcript.schema.json' with { type: 'json' };
import dictionarySchema from '../../schemas/exchange/v1/dictionary.schema.json' with { type: 'json' };
import retryPlanSchema from '../../schemas/exchange/v1/retry-plan.schema.json' with { type: 'json' };
import type { ExchangeRequestV1 } from './generated/exchange-request-v1.js';
import type { ExchangeTaskV1 } from './generated/exchange-task-v1.js';
import type { ExchangeEventV1 } from './generated/exchange-event-v1.js';
import type { ExchangeResultV1 } from './generated/exchange-result-v1.js';
import type { ExchangeErrorV1 } from './generated/exchange-error-v1.js';
import type { ExchangeTranscriptV1 } from './generated/exchange-transcript-v1.js';
import type { ExchangeDictionaryV1 } from './generated/exchange-dictionary-v1.js';
import type { ExchangeRetryPlanV1 } from './generated/exchange-retry-plan-v1.js';
import { MercuryError } from '../errors.js';
import { sensitiveInformationIssues } from './validation/security.js';

export const EXCHANGE_CONTRACTS = {
  request: 'mercury.exchange.request/v1',
  task: 'mercury.task/v1',
  event: 'mercury.event/v1',
  result: 'mercury.result/v1',
  error: 'mercury.error/v1',
  transcript: 'mercury.transcript/v1',
  dictionary: 'mercury.dictionary/v1',
  retryPlan: 'mercury.retry-plan/v1',
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
  retryPlan: ExchangeRetryPlanV1;
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
  retryPlan: retryPlanSchema,
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(commonSchema);
for (const schema of [dictionarySchema, errorSchema, transcriptSchema, requestSchema, taskSchema, eventSchema, resultSchema, retryPlanSchema]) {
  ajv.addSchema(schema);
}

function issue(path: string, message: string): ExchangeValidationIssue {
  return { path, message };
}

export function exchangeJsonResourceIssues(value: unknown): ExchangeValidationIssue[] {
  const issues: ExchangeValidationIssue[] = [];
  const queue: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: '/', depth: 0 }];
  let nodes = 0;
  let stringBytes = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    nodes += 1;
    if (nodes > 20_000) { issues.push(issue(current.path, '合同 JSON 节点总量超过 20,000')); break; }
    if (current.depth > 20) { issues.push(issue(current.path, '合同 JSON 递归深度超过 20')); continue; }
    if (typeof current.value === 'string') {
      stringBytes += Buffer.byteLength(current.value, 'utf8');
      if (Buffer.byteLength(current.value, 'utf8') > 256_000) issues.push(issue(current.path, '单个字符串超过 256,000 bytes'));
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 10_000) issues.push(issue(current.path, '数组元素超过 10,000'));
      current.value.forEach((entry, index) => queue.push({ value: entry, path: `${current.path}/${index}`, depth: current.depth + 1 }));
      continue;
    }
    if (typeof current.value === 'object' && current.value !== null) {
      const entries = Object.entries(current.value);
      if (entries.length > 1_000) issues.push(issue(current.path, '对象属性超过 1,000'));
      entries.forEach(([key, child]) => queue.push({ value: child, path: `${current.path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth: current.depth + 1 }));
    }
  }
  if (stringBytes > 2_000_000) issues.push(issue('/', '合同字符串总量超过 2,000,000 bytes'));
  return issues;
}

function semanticIssues(name: ExchangeContractName, value: any): ExchangeValidationIssue[] {
  const issues: ExchangeValidationIssue[] = [];
  if (name === 'request') {
    const transcriptSource = value.inputs.transcript?.role === 'transcript_source';
    if (value.inputs.media !== null && value.inputs.media.mime_type !== 'audio/mpeg') {
      issues.push(issue('/inputs/media/mime_type', '0.3.0-alpha.1 只支持 MP3（audio/mpeg）媒体'));
    }
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
    const deliveryDirectory = value.output.approved_srt_directory;
    if (deliveryDirectory !== undefined) {
      if (!path.isAbsolute(deliveryDirectory) || path.resolve(deliveryDirectory) !== deliveryDirectory || deliveryDirectory.split(path.sep).includes('~') || /[\u0000-\u001f\u007f]/u.test(deliveryDirectory)) {
        issues.push(issue('/output/approved_srt_directory', '业务输出目录必须是规范化绝对路径，不能使用相对路径、~、控制字符或路径逃逸'));
      }
      if (!value.output.formats.includes('srt')) issues.push(issue('/output/formats', '请求业务 SRT 交付时 formats 必须包含 srt'));
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
  } else if (name === 'retryPlan') {
    if (Date.parse(value.expires_at) <= Date.parse(value.created_at)) issues.push(issue('/expires_at', 'retry plan 有效期必须晚于创建时间'));
    const estimated = value.estimated_calls.asr + value.estimated_calls.chat;
    if (value.allowed && (value.reason !== null || estimated < 1 || value.risk !== 'new_provider_calls')) issues.push(issue('/', '允许执行的 retry plan 必须说明至少一次新增调用、无拒绝原因且风险为 new_provider_calls'));
    if (!value.allowed && (value.reason === null || estimated !== 0)) issues.push(issue('/', '拒绝执行的 retry plan 必须提供原因且不得预计新增调用'));
    if (value.provider_outcome === 'outcome_unknown' && (value.allowed || value.risk !== 'unsafe_provider_outcome' || !value.requires_user_action)) issues.push(issue('/provider_outcome', 'outcome_unknown 必须拒绝安全 retry，并标记 unsafe 与用户动作'));
    if (value.provider_outcome === 'response_persisted' && value.allowed) issues.push(issue('/provider_outcome', 'response_persisted 必须使用 resume，不能 retry'));
  } else if (name === 'task') {
    const terminal = ['needs_input', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status);
    if (value.status === 'completed' && value.error !== null) issues.push(issue('/error', 'completed 任务不能携带错误'));
    if (['failed', 'interrupted'].includes(value.status) && value.error === null) issues.push(issue('/error', `${value.status} 任务必须携带错误`));
    if (!terminal && value.worker.status === 'inactive' && value.status === 'running') issues.push(issue('/worker/status', 'running 任务不能确定声明 Worker inactive'));
    if (value.pause.allowed && !value.capabilities.pause.supported) issues.push(issue('/pause/allowed', '不支持 pause 时不能允许该动作'));
    if (value.retry.allowed && !value.capabilities.retry.supported) issues.push(issue('/retry/allowed', '不支持 retry 时不能允许该动作'));
    if (value.delivery) issues.push(...deliveryIssues('/delivery', value.delivery));
  } else if (name === 'result') {
    if (value.transcription.mode === 'provided' && value.transcription.asr_call_count !== 0) {
      issues.push(issue('/transcription/asr_call_count', 'provided 转录的 ASR 调用数必须为 0'));
    }
    if (value.review.status === 'finalized' && !value.review.approved) issues.push(issue('/review/approved', 'finalized 必须具有已批准产物'));
    for (const [index, artifact] of value.artifacts.entries()) {
      if (artifact.exists !== (artifact.path !== null)) issues.push(issue(`/artifacts/${index}/path`, 'exists 必须与 path 是否存在一致'));
      if (!artifact.exists && artifact.sha256 !== null) issues.push(issue(`/artifacts/${index}/sha256`, '不存在的产物不能声明 hash'));
    }
    if (value.delivery) issues.push(...deliveryIssues('/delivery', value.delivery));
  }
  return issues;
}

function deliveryIssues(base: string, delivery: any): ExchangeValidationIssue[] {
  const issues: ExchangeValidationIssue[] = [];
  const add = (suffix: string, message: string) => issues.push(issue(`${base}${suffix}`, message));
  const emptyCurrent = delivery.final_path === null && delivery.sha256 === null && delivery.delivered_at === null && delivery.review_revision === null;
  if (['not_requested', 'unsupported'].includes(delivery.status)) {
    if (delivery.requested_directory !== null || !emptyCurrent || delivery.validation !== 'unavailable' || delivery.error !== null || delivery.history.length !== 0) add('', `${delivery.status} 不能声明目录、当前交付、错误或历史`);
  } else if (delivery.requested_directory === null) add('/requested_directory', `${delivery.status} 必须声明请求目录`);
  if (delivery.status === 'pending_review' && (!emptyCurrent || delivery.validation !== 'unavailable' || delivery.error !== null)) add('', 'pending_review 不能把历史交付冒充当前 final');
  if (delivery.status === 'ready' && (delivery.final_path === null || delivery.sha256 === null || delivery.review_revision === null || delivery.delivered_at !== null || delivery.validation !== 'unavailable' || delivery.error !== null)) add('', 'ready 必须固定当前 approved 的路径/hash/revision，且尚未声明交付成功');
  if (delivery.status === 'delivered' && (delivery.final_path === null || delivery.sha256 === null || delivery.review_revision === null || delivery.delivered_at === null || delivery.validation !== 'passed' || delivery.error !== null)) add('', 'delivered 必须具有通过验证的当前路径/hash/revision/time 且无错误');
  if (delivery.status === 'failed' && (delivery.validation !== 'unavailable' || delivery.error === null)) add('', 'failed 必须保留稳定交付错误且不能声明 passed');
  const revisions = new Set<string>();
  for (const [index, entry] of delivery.history.entries()) {
    if (revisions.has(entry.review_revision)) add(`/history/${index}/review_revision`, '同一 review revision 只能记录一次交付事实');
    revisions.add(entry.review_revision);
  }
  if (delivery.status === 'delivered' && !delivery.history.some((entry: any) => entry.path === delivery.final_path && entry.sha256 === delivery.sha256 && entry.review_revision === delivery.review_revision && entry.delivered_at === delivery.delivered_at)) add('/history', 'delivered 当前指针必须对应一条 history 事实');
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
  const resources = exchangeJsonResourceIssues(value);
  if (resources.length > 0) return { valid: false, value: null, issues: resources };
  const security = sensitiveInformationIssues(value).map((entry) => issue(entry.path, entry.message));
  if (security.length > 0) return { valid: false, value: null, issues: security };
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
