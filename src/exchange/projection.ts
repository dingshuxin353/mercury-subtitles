import type { ExchangeErrorV1, ExchangeResultV1, ExchangeTaskV1 } from '../contracts/index.js';
import type { Artifact } from '../contracts/generated/exchange-task-v1.js';
import type { MachineTaskView } from '../background/types.js';

function stableStatus(status: string): ExchangeTaskV1['status'] {
  if (['queued', 'running', 'pausing', 'paused', 'needs_input', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
    return status as ExchangeTaskV1['status'];
  }
  return ['created'].includes(status) ? 'queued' : 'running';
}

function stableError(view: MachineTaskView): ExchangeErrorV1 | null {
  if (!view.error) return null;
  const providerUnknown = view.execution.status === 'interrupted';
  return {
    contract: 'mercury.error/v1',
    code: view.error.code.replace(/[^A-Z0-9_]/gu, '_').toUpperCase() || 'TASK_FAILED',
    category: providerUnknown ? 'provider' : 'runtime',
    message: view.error.message,
    retryability: providerUnknown ? 'unsafe' : 'after_user_action',
    provider_outcome: providerUnknown ? 'outcome_unknown' : 'not_applicable',
    remediation: [view.error.remediation],
    technical: null,
    extensions: {},
  };
}

function artifacts(view: MachineTaskView): ExchangeTaskV1['artifacts'] {
  const sources = [
    { identity: 'transcribed_srt', artifact: view.artifacts.transcribed },
    { identity: 'calibrated_srt', artifact: view.artifacts.calibrated },
    { identity: 'approved_srt', artifact: view.artifacts.approved },
    { identity: 'calibration_report', artifact: view.artifacts.report },
  ] as const;
  return sources.map(({ identity, artifact }) => ({
    identity,
    exists: artifact.exists,
    path: artifact.exists ? artifact.path : null,
    sha256: null,
    validation: artifact.validation,
  } satisfies Artifact)) as ExchangeTaskV1['artifacts'];
}

export function projectMachineTaskToExchangeTask(
  view: MachineTaskView,
  options: { requestId?: string | null; sourceSchemaVersion?: string; updatedAt?: string } = {},
): ExchangeTaskV1 {
  const status = stableStatus(view.execution.status);
  const historical = view.historical;
  const unsupported = (reason: string) => ({ supported: false, reason });
  return {
    contract: 'mercury.task/v1',
    task_id: view.task_id,
    request_id: options.requestId ?? null,
    revision: view.last_event_sequence,
    created_at: view.created_at,
    updated_at: options.updatedAt ?? view.created_at,
    status,
    stage: view.execution.stage,
    progress: null,
    worker: { status: status === 'running' ? 'unknown' : 'inactive', heartbeat_at: null },
    pause: { allowed: false, reason: '0.3.0-alpha.1 尚未提供暂停；能力发现会明确返回 unsupported。' },
    resume: { allowed: false, reason: '此历史任务没有 Alpha.2 安全检查点，不能恢复。' },
    cancel: { allowed: ['queued', 'running'].includes(status), reason: ['queued', 'running'].includes(status) ? null : '当前状态不能取消。' },
    retry: { allowed: false, reason: '0.3.0-alpha.1 尚未提供安全重试。' },
    attempt: { attempt_id: null, count: status === 'queued' ? 0 : 1 },
    artifacts: artifacts(view),
    review: { status: view.review.status, pending_count: view.review.pending_count },
    delivery: { requested_directory: null, status: 'unsupported', final_path: null, sha256: null, validation: 'unavailable', delivered_at: null, review_revision: null, history: [], error: null, next_action: '此历史任务不支持业务目录交付；查询不会补写。' },
    error: stableError(view),
    next_action: view.next_action,
    source_schema_version: options.sourceSchemaVersion ?? (historical ? 'historical/unknown' : '4.0.0'),
    capabilities: {
      pause: unsupported('Alpha.2 capability'),
      resume: unsupported('Alpha.2 capability'),
      retry: unsupported('Alpha.2 capability'),
      review: { supported: view.review.status !== 'unsupported', reason: view.review.status === 'unsupported' ? '历史任务没有审阅合同' : null },
      dictionary_snapshot: unsupported(historical ? '历史任务没有词典快照' : '任务创建时未使用 V0.3 词典合同'),
      provided_transcript: unsupported(historical ? '历史任务没有稳定外部转录来源字段' : '任务创建时未使用 V0.3 外部输入合同'),
    },
    extensions: {},
  };
}

export function projectMachineTaskToExchangeResult(
  view: MachineTaskView,
  options: { producedAt?: string } = {},
): ExchangeResultV1 {
  const task = projectMachineTaskToExchangeTask(view);
  return {
    contract: 'mercury.result/v1',
    task_id: task.task_id,
    status: task.status,
    attempt_id: task.attempt.attempt_id,
    produced_at: options.producedAt ?? task.updated_at,
    inputs: [],
    transcription: { mode: 'unknown', asr_call_count: null, transcript_path: null, transcript_sha256: null },
    dictionaries: { snapshots: [], conflict_count: null, match_count: null },
    artifacts: task.artifacts,
    review: { status: task.review.status, pending_count: task.review.pending_count, approved: task.review.status === 'finalized' || task.review.status === 'not_required' },
    delivery: task.delivery!,
    calls: [],
    warnings: ['历史任务只读投影：无法可靠推导的调用数、词典和转录来源保持 unknown/null。'],
    error: task.error,
    next_action: task.next_action,
    extensions: {},
  };
}
