import { describe, expect, it } from 'vitest';

type ReviewStatus = 'pending' | 'not_required' | 'finalized';
type TaskStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'needs_input';
type Fixture = {
  mode?: 'auto_finalize' | 'manual_review';
  taskStatus?: TaskStatus;
  review: ReviewStatus;
  pending: number;
  accepted?: number;
  rejected?: number;
  edited?: number;
  approved?: { exists: boolean; validation: 'passed' | 'unavailable'; path: string | null; sha256: string | null };
  delivery?: 'not_requested' | 'delivered' | 'failed_recoverable';
  stale?: number;
  refreshedPending?: number[];
  providerCalls?: { asr: number; chat: number };
};

type Trace = {
  commands: string[];
  stopped: string | null;
  finalPath: string | null;
  providerBefore: { asr: number; chat: number };
  providerAfter: { asr: number; chat: number };
  history: { accepted: number; rejected: number; edited: number };
};

function runSkillForwardFixture(input: Fixture): Trace {
  const mode = input.mode ?? 'auto_finalize';
  const calls = input.providerCalls ?? { asr: 0, chat: 0 };
  const trace: Trace = {
    commands: ['mercury task result <task-id> --json', 'mercury review status <task-id> --json'],
    stopped: null,
    finalPath: null,
    providerBefore: { ...calls },
    providerAfter: { ...calls },
    history: { accepted: input.accepted ?? 0, rejected: input.rejected ?? 0, edited: input.edited ?? 0 },
  };
  if ((input.taskStatus ?? 'completed') !== 'completed') {
    trace.stopped = 'task_not_completed';
    return trace;
  }
  if (mode === 'manual_review' && input.review === 'pending') {
    trace.commands.push('mercury review list <task-id> --limit 10 --json');
    trace.stopped = 'manual_review_waiting';
    return trace;
  }
  if (input.review === 'pending') {
    let pending = input.pending;
    let staleRemaining = input.stale ?? 0;
    let staleRetries = 0;
    while (pending > 0) {
      trace.commands.push(`mercury review accept-all <task-id> --confirm-count ${pending} --actor skill --json`);
      if (staleRemaining > 0) {
        staleRemaining -= 1;
        staleRetries += 1;
        trace.commands.push('mercury review status <task-id> --json');
        if (staleRetries > 1) {
          trace.stopped = 'concurrent_review_change';
          return trace;
        }
        pending = input.refreshedPending?.shift() ?? pending;
        continue;
      }
      trace.history.accepted += pending;
      pending = 0;
    }
    trace.commands.push('mercury review status <task-id> --json');
    trace.commands.push('mercury review finalize <task-id> --json');
    trace.commands.push('mercury task result <task-id> --json');
  }
  const approved = input.approved ?? {
    exists: true,
    validation: 'passed' as const,
    path: '/workspace/tasks/task/output/final.approved.srt',
    sha256: 'a'.repeat(64),
  };
  if (!approved.exists || approved.validation !== 'passed' || !approved.path || !approved.sha256) {
    trace.stopped = 'approved_not_verified';
    return trace;
  }
  if (input.delivery === 'failed_recoverable') {
    trace.commands.push('mercury task deliver <task-id> --json');
    trace.commands.push('mercury task result <task-id> --json');
  }
  trace.finalPath = approved.path;
  return trace;
}

describe('V03-D016 packaged Skill auto-finalize forward fixtures', () => {
  it('defaults to exact-count accept-all and finalize with zero Provider increment', () => {
    const trace = runSkillForwardFixture({ review: 'pending', pending: 3, providerCalls: { asr: 1, chat: 1 } });
    expect(trace.commands).toEqual([
      'mercury task result <task-id> --json',
      'mercury review status <task-id> --json',
      'mercury review accept-all <task-id> --confirm-count 3 --actor skill --json',
      'mercury review status <task-id> --json',
      'mercury review finalize <task-id> --json',
      'mercury task result <task-id> --json',
    ]);
    expect(trace.finalPath).toMatch(/\.approved\.srt$/u);
    expect(trace.providerAfter).toEqual(trace.providerBefore);
  });

  it('keeps explicit manual review pending and never auto accepts', () => {
    const trace = runSkillForwardFixture({ mode: 'manual_review', review: 'pending', pending: 3 });
    expect(trace.stopped).toBe('manual_review_waiting');
    expect(trace.commands).toContain('mercury review list <task-id> --limit 10 --json');
    expect(trace.commands.join('\n')).not.toContain('accept-all');
    expect(trace.commands.join('\n')).not.toContain('finalize');
  });

  it('preserves prior human decisions and accepts only remaining pending', () => {
    const trace = runSkillForwardFixture({ review: 'pending', pending: 2, accepted: 1, rejected: 1, edited: 1 });
    expect(trace.commands).toContain('mercury review accept-all <task-id> --confirm-count 2 --actor skill --json');
    expect(trace.history).toEqual({ accepted: 3, rejected: 1, edited: 1 });
  });

  it.each(['not_required', 'finalized'] as const)('keeps %s idempotent without review writes', (review) => {
    const trace = runSkillForwardFixture({ review, pending: 0 });
    expect(trace.finalPath).toMatch(/\.approved\.srt$/u);
    expect(trace.commands.join('\n')).not.toMatch(/accept-all|finalize|task deliver/u);
  });

  it('refreshes one stale count and stops on a second stale result', () => {
    const recovered = runSkillForwardFixture({ review: 'pending', pending: 3, stale: 1, refreshedPending: [2] });
    expect(recovered.commands).toContain('mercury review accept-all <task-id> --confirm-count 2 --actor skill --json');
    expect(recovered.finalPath).not.toBeNull();
    const stopped = runSkillForwardFixture({ review: 'pending', pending: 3, stale: 2, refreshedPending: [2, 1] });
    expect(stopped.stopped).toBe('concurrent_review_change');
    expect(stopped.commands.join('\n')).not.toContain('finalize');
  });

  it.each(['failed', 'cancelled', 'interrupted', 'needs_input'] as const)('never finalizes a %s task', (taskStatus) => {
    const trace = runSkillForwardFixture({ taskStatus, review: 'pending', pending: 1 });
    expect(trace.stopped).toBe('task_not_completed');
    expect(trace.finalPath).toBeNull();
    expect(trace.commands.join('\n')).not.toMatch(/accept-all|finalize|deliver/u);
  });

  it('rejects an unverified final path and performs at most one local delivery recovery', () => {
    const invalid = runSkillForwardFixture({ review: 'finalized', pending: 0, approved: { exists: true, validation: 'unavailable', path: '/guess.srt', sha256: null } });
    expect(invalid.stopped).toBe('approved_not_verified');
    expect(invalid.finalPath).toBeNull();
    const recovered = runSkillForwardFixture({ review: 'finalized', pending: 0, delivery: 'failed_recoverable', providerCalls: { asr: 0, chat: 1 } });
    expect(recovered.commands.filter((command) => command.includes('task deliver'))).toHaveLength(1);
    expect(recovered.providerAfter).toEqual(recovered.providerBefore);
  });
});
