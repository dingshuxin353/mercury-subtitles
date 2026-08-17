import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import taskRecordSchema from '../../schemas/v5/task-record.schema.json' with { type: 'json' };
import commonSchema from '../../schemas/exchange/v1/common.schema.json' with { type: 'json' };
import errorSchema from '../../schemas/exchange/v1/error.schema.json' with { type: 'json' };
import type { TaskRecordV5 } from './generated/task-record-v5.js';
import { MercuryError } from '../errors.js';
import { sensitiveInformationIssues } from './validation/security.js';
import { exchangeJsonResourceIssues } from './exchange-v1.js';

export type V5ValidationIssue = { path: string; message: string };
export type V5ValidationResult =
  | { valid: true; value: TaskRecordV5; issues: [] }
  | { valid: false; value: null; issues: V5ValidationIssue[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(commonSchema);
ajv.addSchema(errorSchema);
ajv.addSchema(taskRecordSchema);

function semanticIssues(value: TaskRecordV5): V5ValidationIssue[] {
  const issues: V5ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  if (!value.identity.task_directory.startsWith(`${value.identity.task_id}-`)) add('/identity/task_directory', '必须与 task_id 一致');
  if (value.input_config.transcription_mode === 'provided') {
    if (!value.inputs.transcript_source || value.inputs.transcript_source.role !== 'transcript_source') add('/inputs/transcript_source', 'provided 模式必须有转写事实源');
    if (value.models.asr !== null) add('/models/asr', 'provided 模式不得选择 ASR');
    const asr = value.execution.provider_calls.asr;
    if (asr.state !== 'not_started' || asr.count !== 0 || asr.outcome !== 'not_dispatched') add('/execution/provider_calls/asr', 'provided 模式必须证明 ASR 零调用');
  } else {
    if (!value.inputs.media) add('/inputs/media', 'provider 模式必须有媒体输入');
    if (value.models.asr === null) add('/models/asr', 'provider 模式必须选择 ASR');
    if (value.inputs.transcript_source) add('/inputs/transcript_source', 'provider 模式不能同时使用外部转写事实源');
  }
  if (value.inputs.reference && value.inputs.reference.role !== 'reference') add('/inputs/reference/role', 'reference 输入必须声明 reference 角色');
  if ((value.inputs.reference === null) !== (value.inputs.reference_normalized === null)) add('/inputs/reference_normalized', 'reference 原件与规范化证据必须同时存在或同时为空');
  if (value.input_config.evidence_mode === 'audio_multimodal' && !value.inputs.media) add('/input_config/evidence_mode', '强校验必须具有媒体输入');
  const expectedReference = value.inputs.reference !== null;
  const legacyProvidedReference = value.input_config.transcription_mode === 'provided'
    && value.inputs.reference === null
    && value.calibration_sources.reference?.path === 'input/reference.srt';
  if (expectedReference !== (value.calibration_sources.reference !== null) && !legacyProvidedReference) {
    add('/calibration_sources/reference', '校准 reference 来源必须与任务模式一致');
  }
  if (value.input_config.transcription_mode === 'provided' && value.calibration_sources.transcript === null) add('/calibration_sources/transcript', 'provided 模式必须固定兼容 transcript 来源');
  if (value.execution.provider_calls.asr.outcome === 'response_persisted'
    && value.execution.provider_calls.asr.count > 0 && value.calibration_sources.transcript === null) {
    add('/calibration_sources/transcript', 'ASR 响应持久化后必须固定校准 transcript 来源');
  }

  const terminal = ['needs_input', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.status);
  if (terminal !== (value.execution.ended_at !== null)) add('/execution/ended_at', '必须与终态一致');
  if (value.status === 'queued' && (value.execution.started_at !== null || value.execution.worker_id !== null || value.execution.heartbeat_at !== null || value.execution.attempt_id !== null)) add('/status', 'queued 任务不能声明当前 Worker/attempt；历史 attempt_count 可以保留');
  if (value.status === 'running' && (value.execution.started_at === null || value.execution.worker_id === null || value.execution.heartbeat_at === null || value.execution.attempt_id === null || value.execution.attempt_count < 1)) add('/status', 'running 必须具有 Worker、心跳和 attempt');
  if (value.status === 'completed' && (value.execution.safe_checkpoint !== 'outputs_validated' || value.artifacts.calibrated === null || value.error !== null)) add('/status', 'completed 必须有已校验字幕、outputs_validated 且无错误');
  if (['failed', 'interrupted'].includes(value.status) && value.error === null) add('/error', `${value.status} 必须有稳定错误`);
  if (value.status === 'cancelled' && (value.artifacts.calibrated !== null || value.artifacts.approved !== null)) add('/artifacts', 'cancelled 不能发布 calibrated/approved');
  if (value.review.status === 'finalized' && value.artifacts.approved === null) add('/review/status', 'finalized 必须具有 approved 产物');
  if (value.delivery) {
    const delivery = value.delivery;
    const emptyCurrent = delivery.final_path === null && delivery.sha256 === null && delivery.delivered_at === null && delivery.review_revision === null;
    if (delivery.status === 'not_requested') {
      if (delivery.requested_directory !== null || !emptyCurrent || delivery.validation !== 'unavailable' || delivery.error !== null || delivery.history.length !== 0) add('/delivery', 'not_requested 不能声明目录、当前交付、错误或历史');
    } else if (delivery.requested_directory === null) add('/delivery/requested_directory', `${delivery.status} 必须声明请求目录`);
    if (delivery.status === 'pending_review' && (!emptyCurrent || delivery.validation !== 'unavailable' || delivery.error !== null)) add('/delivery', 'pending_review 不能把历史交付冒充当前 final');
    if (delivery.status === 'ready' && (delivery.final_path === null || delivery.sha256 === null || delivery.review_revision === null || delivery.delivered_at !== null || delivery.validation !== 'unavailable' || delivery.error !== null)) add('/delivery', 'ready 必须固定 approved 路径/hash/revision 且尚未交付');
    if (delivery.status === 'delivered' && (delivery.final_path === null || delivery.sha256 === null || delivery.review_revision === null || delivery.delivered_at === null || delivery.validation !== 'passed' || delivery.error !== null)) add('/delivery', 'delivered 必须具有通过验证的当前路径/hash/revision/time');
    if (delivery.status === 'failed' && (delivery.validation !== 'unavailable' || delivery.error === null)) add('/delivery', 'failed 必须保留稳定错误且不能声明 passed');
    const revisions = new Set<string>();
    for (const [index, entry] of delivery.history.entries()) {
      if (revisions.has(entry.review_revision)) add(`/delivery/history/${index}/review_revision`, '同一 review revision 只能记录一次');
      revisions.add(entry.review_revision);
    }
    if (delivery.status === 'delivered' && !delivery.history.some((entry) => entry.path === delivery.final_path && entry.sha256 === delivery.sha256 && entry.review_revision === delivery.review_revision && entry.delivered_at === delivery.delivered_at)) add('/delivery/history', '当前 delivered 指针必须对应 history 事实');
  }

  for (const [role, call] of Object.entries(value.execution.provider_calls)) {
    if (call.state === 'not_started' && (call.count !== 0 || call.outcome !== 'not_dispatched' || call.evidence_ref !== null || call.evidence_sha256 !== null)) add(`/execution/provider_calls/${role}`, 'not_started 必须是零调用且无证据');
    if (call.state === 'in_flight' && (call.count < 1 || call.outcome !== 'outcome_unknown')) add(`/execution/provider_calls/${role}`, 'in_flight 必须保留 outcome_unknown 调用事实');
    if (call.state === 'response_persisted' && (call.count < 1 || call.outcome !== 'response_persisted' || call.evidence_ref === null || call.evidence_sha256 === null)) add(`/execution/provider_calls/${role}`, 'response_persisted 必须具有路径与内容 hash 证据');
    if (call.state === 'terminal' && call.count > 0 && !['known_terminal', 'response_persisted'].includes(call.outcome)) add(`/execution/provider_calls/${role}`, 'terminal 调用必须有确定结果');
    if (call.state === 'terminal' && call.outcome === 'response_persisted' && (call.evidence_ref === null || call.evidence_sha256 === null)) add(`/execution/provider_calls/${role}`, 'response_persisted 终态必须保留路径与内容 hash 证据');
    if ((call.evidence_ref === null) !== (call.evidence_sha256 === null)) add(`/execution/provider_calls/${role}`, 'evidence_ref 与 evidence_sha256 必须同时存在或同时为空');
  }
  return issues;
}

export function validateV5TaskRecord(value: unknown): V5ValidationResult {
  const resourceIssues = exchangeJsonResourceIssues(value);
  if (resourceIssues.length > 0) return { valid: false, value: null, issues: resourceIssues };
  const securityIssues = sensitiveInformationIssues(value).map((entry) => ({ path: entry.path, message: entry.message }));
  if (securityIssues.length > 0) return { valid: false, value: null, issues: securityIssues };
  const validate = ajv.getSchema(taskRecordSchema.$id)!;
  if (!validate(value)) {
    return { valid: false, value: null, issues: (validate.errors ?? []).map((error: ErrorObject) => ({ path: error.instancePath || '/', message: error.message ?? error.keyword })) };
  }
  const typed = value as TaskRecordV5;
  const issues = semanticIssues(typed);
  return issues.length > 0 ? { valid: false, value: null, issues } : { valid: true, value: structuredClone(typed), issues: [] };
}

export function assertV5TaskRecord(value: unknown): TaskRecordV5 {
  const result = validateV5TaskRecord(value);
  if (!result.valid) throw new MercuryError('TASK_RECORD_INVALID', `task v5 invalid: ${result.issues.map((entry) => `${entry.path} ${entry.message}`).join('; ')}`);
  return result.value;
}
