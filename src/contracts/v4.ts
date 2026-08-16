import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import backgroundTaskSchema from '../../schemas/v4/background-task.schema.json' with { type: 'json' };
import backgroundJobSchema from '../../schemas/v4/background-job.schema.json' with { type: 'json' };
import backgroundRequestSchema from '../../schemas/v4/background-request.schema.json' with { type: 'json' };
import taskEventSchema from '../../schemas/v4/task-event.schema.json' with { type: 'json' };
import reviewSchema from '../../schemas/v4/review.schema.json' with { type: 'json' };
import commonSchema from '../../schemas/v1/common.schema.json' with { type: 'json' };
import type { BackgroundTaskV4 } from './generated/background-task-v4.js';
import type { BackgroundJobV1 } from './generated/background-job-v1.js';
import type { BackgroundRequestV1 } from './generated/background-request-v1.js';
import type { TaskEventV1 } from './generated/task-event-v1.js';
import type { ReviewRecordV1 } from './generated/review-v1.js';
import { MercuryError } from '../errors.js';

export type V4ContractName = 'background-task' | 'background-job' | 'background-request' | 'task-event' | 'review';
export interface V4ContractTypeMap {
  'background-task': BackgroundTaskV4;
  'background-job': BackgroundJobV1;
  'background-request': BackgroundRequestV1;
  'task-event': TaskEventV1;
  review: ReviewRecordV1;
}
export type V4ValidationResult<T> =
  | { valid: true; value: T; issues: [] }
  | { valid: false; value: null; issues: Array<{ path: string; message: string }> };

const schemas = {
  'background-task': backgroundTaskSchema,
  'background-job': backgroundJobSchema,
  'background-request': backgroundRequestSchema,
  'task-event': taskEventSchema,
  review: reviewSchema,
} as const;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addKeyword({
  keyword: 'x-mercury-invariant-id',
  schemaType: 'string',
  valid: true,
});
ajv.addKeyword({
  keyword: 'x-mercury-semantic-checks',
  schemaType: 'array',
  valid: true,
});
ajv.addSchema(commonSchema);
Object.values(schemas).forEach((schema) => ajv.addSchema(schema));

type Issue = { path: string; message: string };

function semanticIssues(name: V4ContractName, value: any): Issue[] {
  const issues: Issue[] = [];
  if (name === 'background-task') {
    if (!value.task_directory.startsWith(`${value.task_id}-`)) {
      issues.push({ path: '/task_directory', message: '必须与 task_id identity 一致' });
    }
    if (value.input_config.has_reference_srt !== Boolean(value.inputs.reference_srt)) {
      issues.push({ path: '/input_config/has_reference_srt', message: '必须与 reference_srt 是否存在一致' });
    }
    if (value.input_config.has_reference_srt !== (value.input_config.mode !== null)) {
      issues.push({ path: '/input_config/mode', message: '参考字幕与 mode 必须同时存在或同时缺失' });
    }
    if ((value.input_config.evidence_mode === 'audio_multimodal') !== (value.input_config.non_strong_reason === null)) {
      issues.push({ path: '/input_config/non_strong_reason', message: '必须与 evidence_mode 一致' });
    }
    for (const [role, call] of Object.entries(value.execution.provider_call) as Array<[string, any]>) {
      if (call.state === 'not_started' && call.evidence_ref !== null) {
        issues.push({ path: `/execution/provider_call/${role}/evidence_ref`, message: `${call.state} 不能声明已持久化证据` });
      }
      if (call.state === 'response_persisted' && !call.evidence_ref) {
        issues.push({ path: `/execution/provider_call/${role}/evidence_ref`, message: 'response_persisted 必须有证据引用' });
      }
    }
    for (const [index, failure] of value.adapter_failures.entries()) {
      if (failure.provider_outcome_certainty === 'not_dispatched' && failure.call !== null) {
        issues.push({ path: `/adapter_failures/${index}/call`, message: 'not_dispatched 不能声明 Provider call' });
      }
      if (failure.provider_outcome_certainty === 'outcome_unknown' && failure.call === null) {
        issues.push({ path: `/adapter_failures/${index}/call`, message: '结果不确定时必须保留可审计 call' });
      }
    }
    const terminal = ['completed', 'needs_input', 'failed', 'cancelled', 'interrupted'].includes(value.execution.status);
    if (terminal !== (value.execution.ended_at !== null)) {
      issues.push({ path: '/execution/ended_at', message: '必须与执行终态一致' });
    }
    if (value.execution.status === 'completed') {
      if (value.error !== null || value.failure_stage !== null || !value.artifacts.subtitles.calibrated || value.execution.safe_checkpoint !== 'outputs_validated') {
        issues.push({ path: '/execution/status', message: 'completed 必须具有已验证校验字幕、无错误且位于 outputs_validated' });
      }
    }
    if (['failed', 'interrupted'].includes(value.execution.status) && value.error === null) {
      issues.push({ path: '/error', message: `${value.execution.status} 必须有错误记录` });
    }
    if (value.execution.status === 'cancelled' && (value.artifacts.subtitles.calibrated || value.artifacts.subtitles.approved)) {
      issues.push({ path: '/artifacts/subtitles', message: 'cancelled 不能发布 calibrated/approved 字幕' });
    }
    const purposes = [
      ['transcribed', 'unverified_transcription'],
      ['calibrated', 'calibrated_result'],
      ['approved', 'approved_result'],
    ] as const;
    for (const [key, expected] of purposes) {
      const artifact = value.artifacts.subtitles[key];
      if (artifact && artifact.purpose !== expected) issues.push({ path: `/artifacts/subtitles/${key}/purpose`, message: `必须为 ${expected}` });
    }
  } else if (name === 'background-job') {
    const paired = value.claim_token !== null && value.worker_id !== null;
    if (value.state === 'queued' && (value.claim_token !== null || value.worker_id !== null)) {
      issues.push({ path: '/state', message: 'queued job 不能带 claim token 或 worker' });
    }
    if (value.state === 'claimed' && !paired) {
      issues.push({ path: '/state', message: 'claimed job 必须同时带 claim token 和 worker' });
    }
  } else if (name === 'background-request') {
    if (!value.task_directory.startsWith(`${value.task_id}-`)) {
      issues.push({ path: '/task_directory', message: '必须与预绑定 task_id 一致' });
    }
    if ((value.state === 'reserved') !== (value.owner !== null)) {
      issues.push({ path: '/owner', message: 'owner/lease 必须与 reserved 状态一致' });
    }
  } else if (name === 'review') {
    const decisions = { pending: 0, accepted: 0, rejected: 0, edited: 0 };
    const unitIds = new Set<string>();
    for (const [index, change] of value.changes.entries()) {
      decisions[change.decision as keyof typeof decisions] += 1;
      const decided = change.decision !== 'pending';
      if (decided !== (change.final_text !== null && change.decided_at !== null && change.actor !== null)) {
        issues.push({ path: `/changes/${index}`, message: '决定状态与 final_text/decided_at/actor 不一致' });
      }
      if (unitIds.has(change.unit_id)) issues.push({ path: `/changes/${index}/unit_id`, message: '校验单元必须唯一' });
      unitIds.add(change.unit_id);
      if (change.segment_index !== change.target_segment_indexes[0]) {
        issues.push({ path: `/changes/${index}/segment_index`, message: '必须等于第一个目标片段' });
      }
      if (change.target_text_end <= change.target_text_start) {
        issues.push({ path: `/changes/${index}/target_text_end`, message: '目标文字范围必须为正' });
      }
    }
    const expected = { total: value.changes.length, ...decisions };
    for (const [key, count] of Object.entries(expected)) {
      if (value.counts[key] !== count) issues.push({ path: `/counts/${key}`, message: `应为 ${count}` });
    }
    if (value.status === 'approved' && (value.counts.pending !== 0 || value.approved_artifact === null)) {
      issues.push({ path: '/status', message: 'approved 必须无待决定项并具有批准稿' });
    }
    if (value.approved_artifact !== null && !['approved', 'not_required'].includes(value.status)) {
      issues.push({ path: '/approved_artifact', message: '非终结审阅不能声明批准稿' });
    }
    if (value.status === 'not_required' && value.changes.length !== 0) {
      issues.push({ path: '/status', message: 'not_required 不能包含 change' });
    }
  }
  return issues;
}

export function validateV4Contract<N extends V4ContractName>(
  name: N,
  value: unknown,
): V4ValidationResult<V4ContractTypeMap[N]> {
  const validate = ajv.getSchema(schemas[name].$id)!;
  if (!validate(value)) return {
    valid: false, value: null,
    issues: (validate.errors ?? []).map((error: ErrorObject) => ({
      path: error.instancePath || '/',
      message: error.message ?? error.keyword,
    })),
  };
  const issues = semanticIssues(name, value);
  if (issues.length > 0) return { valid: false, value: null, issues };
  return { valid: true, value: structuredClone(value) as V4ContractTypeMap[N], issues: [] };
}

export function assertV4Contract<N extends V4ContractName>(name: N, value: unknown): V4ContractTypeMap[N] {
  const result = validateV4Contract(name, value);
  if (!result.valid) {
    const code = name === 'background-task'
      ? 'TASK_RECORD_INVALID'
      : name === 'background-job'
        ? 'JOB_RECORD_INVALID'
        : name === 'background-request'
          ? 'REQUEST_RECORD_INVALID'
          : name === 'task-event'
            ? 'EVENT_LOG_INVALID'
            : 'REVIEW_RECORD_INVALID';
    throw new MercuryError(code, `${name} v4 invalid: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  return result.value;
}
