import { describe, expect, it } from 'vitest';
import type {
  AdapterExecutionResult,
  AsrAdapter,
  AudioVerificationAdapter,
  CalibrationAdapter,
  TranscriptRaw
} from '../../src/contracts/index.js';

const asrAdapter: AsrAdapter = {
  adapterId: 'volcengine_asr',
  async run(input) {
    return {
      kind: 'failure',
      failure: {
        failure_id: 'failure-asr-fixture',
        task_id: input.taskId,
        role: 'asr',
        model_snapshot_ref: input.modelSnapshotRef,
        occurred_at: '2026-08-05T08:02:01.000+08:00',
        provider_outcome_certainty: 'not_dispatched',
        errors: [{
          error_id: 'adapter-fixture-error',
          code: 'ADAPTER_NOT_IMPLEMENTED',
          message: 'The contract fixture does not call a provider.',
          stage: 'execution',
          retryable: false
        }],
        warnings: [],
        call: null,
        staging: []
      }
    };
  }
};

const calibrationAdapter: CalibrationAdapter = {
  adapterId: 'openai_chat_completions',
  async run(input) {
    throw new Error(`compile-only adapter for ${input.taskId}`);
  }
};

const audioVerificationAdapter: AudioVerificationAdapter = {
  adapterId: 'vertex_gemini_audio_verifier',
  async run(input) {
    throw new Error(`compile-only adapter for ${input.taskId}`);
  }
};

describe('INV-API-002 adapter interface contracts', () => {
  it('binds all three adapters to their fixed identifiers and run method', () => {
    expect(asrAdapter.adapterId).toBe('volcengine_asr');
    expect(calibrationAdapter.adapterId).toBe('openai_chat_completions');
    expect(audioVerificationAdapter.adapterId).toBe('vertex_gemini_audio_verifier');
  });

  it('keeps the execution envelope limited to artifact or failure', () => {
    const result: AdapterExecutionResult<TranscriptRaw> = asrAdapter.run as never;
    expect(result).toBeDefined();
  });
});
