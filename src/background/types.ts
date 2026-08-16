import type { BackgroundJobV1 } from '../contracts/generated/background-job-v1.js';
import type { BackgroundRequestV1 } from '../contracts/generated/background-request-v1.js';
import type { BackgroundTaskV4 } from '../contracts/generated/background-task-v4.js';
import type { TaskEventV1 } from '../contracts/generated/task-event-v1.js';

export type { BackgroundJobV1, BackgroundRequestV1, BackgroundTaskV4, TaskEventV1 };

export const CLI_CONTRACT_VERSION = 'mercury-cli-experimental-v1' as const;
export const EVENT_CONTRACT_VERSION = 'mercury-event-experimental-v1' as const;
export const JOB_CONTRACT_VERSION = 'mercury-job-experimental-v1' as const;
export const REQUEST_CONTRACT_VERSION = 'mercury-request-experimental-v1' as const;

export type BackgroundExecutionStatus = BackgroundTaskV4['execution']['status'];
export type BackgroundStage = BackgroundTaskV4['execution']['stage'];
export type TaskEventType = TaskEventV1['type'];

export interface MachineError {
  code: string;
  message: string;
  remediation: string;
}

export type MachineEnvelope<T> =
  | {
      contract_version: typeof CLI_CONTRACT_VERSION;
      ok: true;
      command: string;
      data: T;
    }
  | {
      contract_version: typeof CLI_CONTRACT_VERSION;
      ok: false;
      command: string;
      error: MachineError;
    };

export interface ArtifactView {
  exists: boolean;
  path: string | null;
  purpose: 'unverified_transcription' | 'calibrated_result' | 'approved_result' | 'calibration_report';
  validation: 'passed' | 'pending' | 'unavailable';
}

export interface MachineTaskView {
  task_id: string;
  display_name: string;
  created_at: string;
  execution: {
    status: string;
    stage: string | null;
    summary: string;
  };
  review: {
    status: 'unsupported' | 'not_ready' | 'pending' | 'in_progress' | 'ready' | 'not_required' | 'finalized' | 'invalid';
    pending_count: number | null;
    problem: null | { code: string; message: string };
  };
  models: {
    asr: string;
    chat: string;
    evidence_mode: string | null;
  };
  artifacts: {
    transcribed: ArtifactView;
    calibrated: ArtifactView;
    approved: ArtifactView;
    report: ArtifactView;
  };
  error: null | {
    code: string;
    message: string;
    remediation: string;
  };
  next_action: string;
  last_event_sequence: number;
  historical: boolean;
}

export function machineSuccess<T>(command: string, data: T): MachineEnvelope<T> {
  return { contract_version: CLI_CONTRACT_VERSION, ok: true, command, data };
}

export function machineFailure(
  command: string,
  error: MachineError,
): MachineEnvelope<never> {
  return { contract_version: CLI_CONTRACT_VERSION, ok: false, command, error };
}
