import type { AsrAdapter } from '../src/contracts/index.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelBackgroundTask, submitBackgroundTask, taskMachineView } from '../src/background/runtime.js';
import { jobRecordPath, readJob, readTaskEvents, writeJob } from '../src/background/storage.js';
import { auditInterruptedTasks, runWorker, workerStatus } from '../src/background/worker.js';
import { findTask } from '../src/tasks.js';
import { persistTaskRecordV2, readTaskRecordV2, type TaskRecordV2 } from '../src/tasks-v2.js';
import { ensureWorkspace } from '../src/workspace.js';

const roots: string[] = [];
async function prepared(requestId = 'worker-fixture') {
  const home = await mkdtemp(path.join(tmpdir(), 'mercury-worker-'));
  roots.push(home);
  const workspace = path.join(home, 'mercury-workspace');
  await ensureWorkspace(workspace);
  await writeFile(path.join(workspace, 'config/model-config.json'), await readFile(new URL('./fixtures/valid/model-config.json', import.meta.url)));
  const audio = path.join(home, 'source.mp3');
  const bytes = Buffer.alloc(834);
  bytes.set([0xff, 0xfb, 0x90, 0x64], 0);
  bytes.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(audio, bytes);
  const submitted = await submitBackgroundTask({ workspaceRoot: workspace, audioPath: audio, requestId });
  return { home, workspace, audio, submitted };
}

function fixtureAsr(calls: string[]): AsrAdapter {
  return {
    adapterId: 'volcengine_asr',
    async run(input) {
      calls.push(input.taskId);
      const completedAt = new Date().toISOString();
      return {
        kind: 'artifact',
        artifact: {
          schema_version: '1.0.0', task_id: input.taskId, created_at: completedAt,
          audio: { path_ref: input.audio.pathRef, sha256: input.audio.sha256, duration_ms: input.audio.durationMs, language: 'zh-CN', mime_type: 'audio/mpeg' },
          full_text: '您好世界和平',
          segments: [{ segment_id: 'seg-1', index: 0, start_ms: 0, end_ms: input.audio.durationMs, text: '您好世界和平', confidence: 0.99, words: [] }],
          model_snapshot_ref: input.modelSnapshotRef,
          call: { call_id: 'fixture-asr', model_snapshot_entry_ref: input.model.snapshot_entry_id, started_at: completedAt, ended_at: completedAt, outcome: 'completed', error_ref: null },
          raw_response_ref: null, warnings: [], errors: [],
        },
      };
    },
  };
}

function failureAsr(certainty: 'not_dispatched' | 'known_terminal' | 'outcome_unknown', calls: string[]): AsrAdapter {
  return {
    adapterId: 'volcengine_asr',
    async run(input) {
      calls.push(input.taskId);
      const at = new Date().toISOString();
      const error = {
        error_id: `error-${certainty}`,
        code: certainty === 'outcome_unknown' ? 'VOLCENGINE_NETWORK_ERROR' : certainty === 'not_dispatched' ? 'ASR_CONFIGURATION_INVALID' : 'VOLCENGINE_HTTP_ERROR',
        message: certainty === 'outcome_unknown' ? '请求未获得 HTTP 响应，结果无法确认。' : 'Provider 已返回确定失败。',
        stage: certainty === 'not_dispatched' ? 'configuration' as const : certainty === 'outcome_unknown' ? 'connectivity' as const : 'model_call' as const,
        retryable: false,
      };
      return {
        kind: 'failure' as const,
        failure: {
          failure_id: `failure-${certainty}`,
          task_id: input.taskId,
          role: 'asr' as const,
          model_snapshot_ref: input.modelSnapshotRef,
          occurred_at: at,
          provider_outcome_certainty: certainty,
          errors: [error],
          warnings: [],
          call: certainty === 'not_dispatched' ? null : {
            call_id: `call-${certainty}`,
            model_snapshot_entry_ref: input.model.snapshot_entry_id,
            started_at: at,
            ended_at: at,
            provider_request_id: `provider-${certainty}`,
            outcome: 'failed' as const,
            error_ref: error.error_id,
          },
          staging: [],
        },
      };
    },
  };
}

function fixtureFetch(calls: string[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push('chat');
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const prompt = request.messages.find((message) => message.role === 'user')!.content;
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { calibration_units: Array<{ unit_id: string; original_text: string }> };
    return Response.json({ id: 'fixture-chat', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ corrected_units: payload.calibration_units.map((unit) => ({ unit_id: unit.unit_id, corrected_text: unit.original_text, rationale: null })) }) } }] });
  });
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('V02-D002 single background worker', () => {
  it('allows one of ten concurrent workers to claim and executes each Provider fixture once', async () => {
    const input = await prepared();
    const asrCalls: string[] = [];
    const chatCalls: string[] = [];
    const runs = await Promise.all(Array.from({ length: 10 }, () => runWorker(input.workspace, { asrAdapter: fixtureAsr(asrCalls), fetch: fixtureFetch(chatCalls), readCredential: async () => 'fixture-secret' }, { idleExitMs: 50 })));
    expect(runs.filter((value) => value === 'acquired')).toHaveLength(1);
    expect(asrCalls).toHaveLength(1);
    expect(chatCalls).toHaveLength(1);
    const task = (await findTask(input.workspace, input.submitted.task.task_id)) as unknown as TaskRecordV2;
    expect(task.execution.status).toBe('completed');
    expect(task.artifacts.subtitles).toMatchObject({ transcribed: { validation: 'passed' }, calibrated: { validation: 'passed' }, approved: { validation: 'passed' } });
    expect(task.artifacts.review).toMatchObject({ status: 'not_required', pending_count: 0 });
    expect((await readJob(input.workspace, task.task_id)).state).toBe('terminal');
    const events = await readTaskEvents(path.join(input.workspace, 'tasks', task.task_directory));
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['task_queued', 'worker_claimed', 'stage_started', 'task_completed', 'review_ready', 'artifact_ready']));
  });

  it('cancels a queued task without running either Provider', async () => {
    const input = await prepared('cancel-queued');
    const cancelled = await cancelBackgroundTask(input.workspace, input.submitted.task);
    const calls: string[] = [];
    await runWorker(input.workspace, { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    expect(cancelled).toMatchObject({ pending: false, task: { execution: { status: 'cancelled' } } });
    expect(calls).toEqual([]);
  });

  it('audits an in-flight Provider call as interrupted and never requeues it', async () => {
    const input = await prepared('unknown-provider');
    const task = input.submitted.task;
    task.execution.status = 'running';
    task.execution.stage = 'analyzing_audio';
    task.execution.provider_call!.asr.state = 'in_flight';
    task.execution.worker_id = 'wrk-dead';
    task.execution.started_at = task.execution.claimed_at = task.execution.heartbeat_at = new Date().toISOString();
    task.execution.attempt = 1;
    task.execution.safe_checkpoint = 'asr_not_started';
    const directory = path.join(input.workspace, 'tasks', task.task_directory);
    await persistTaskRecordV2(directory, task);
    const job = await readJob(input.workspace, task.task_id);
    job.state = 'claimed'; job.worker_id = 'wrk-dead'; job.claim_token = 'a'.repeat(32);
    await writeJob(input.workspace, job);
    await auditInterruptedTasks(input.workspace);
    const audited = (await findTask(input.workspace, task.task_id)) as unknown as TaskRecordV2;
    expect(audited.execution.status).toBe('interrupted');
    expect(audited.error?.code).toBe('TASK_INTERRUPTED_PROVIDER_UNKNOWN');
    expect((await readJob(input.workspace, task.task_id)).state).toBe('terminal');
  });

  it('requeues persisted Provider responses and rebuilds locally without another Provider call', async () => {
    const input = await prepared('persisted-resume');
    const firstCalls: string[] = [];
    await runWorker(input.workspace, { asrAdapter: fixtureAsr(firstCalls), fetch: fixtureFetch(firstCalls), readCredential: async () => 'fixture-secret' });
    const task = (await findTask(input.workspace, input.submitted.task.task_id)) as unknown as TaskRecordV2;
    expect(firstCalls, JSON.stringify({ status: task.execution.status, error: task.error, failures: task.adapter_failures })).toHaveLength(2);
    const directory = path.join(input.workspace, 'tasks', task.task_directory);
    task.execution.status = 'running';
    task.execution.stage = 'validating';
    task.execution.provider_call!.asr = { state: 'terminal', evidence_ref: 'work/transcript.raw.json' };
    task.execution.provider_call!.chat = { state: 'response_persisted', evidence_ref: 'work/calibration-result.json' };
    task.execution.worker_id = 'wrk-dead-local';
    task.execution.ended_at = null;
    task.execution.execution_interrupted = false;
    task.execution.started_at = task.execution.claimed_at = task.execution.heartbeat_at = new Date().toISOString();
    task.execution.attempt = Math.max(task.execution.attempt ?? 0, 1);
    task.execution.safe_checkpoint = 'chat_response_persisted';
    delete task.artifacts.review;
    if (task.artifacts.subtitles) task.artifacts.subtitles.approved = null;
    await persistTaskRecordV2(directory, task);
    const job = await readJob(input.workspace, task.task_id);
    job.state = 'claimed'; job.worker_id = 'wrk-dead-local'; job.claim_token = 'b'.repeat(32);
    await writeJob(input.workspace, job);
    await auditInterruptedTasks(input.workspace);
    const forbidden: string[] = [];
    await runWorker(input.workspace, { asrAdapter: fixtureAsr(forbidden), fetch: fixtureFetch(forbidden), readCredential: async () => 'fixture-secret' });
    expect(forbidden).toEqual([]);
    const completed = (await findTask(input.workspace, task.task_id)) as unknown as TaskRecordV2;
    expect(completed.execution.status).toBe('completed');
  });

  for (const crashPoint of ['after_task_claim_persisted', 'after_job_claim_persisted'] as const) {
    it(`recovers an exact claim crash at ${crashPoint} without a Provider call`, async () => {
      const input = await prepared(`claim-crash-${crashPoint}`);
      const calls: string[] = [];
      await expect(runWorker(
        input.workspace,
        { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
        { fault: async (point) => { if (point === crashPoint) throw new Error(crashPoint); } },
      )).rejects.toThrow(crashPoint);
      expect(calls).toEqual([]);
      await auditInterruptedTasks(input.workspace);
      const task = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
      expect(task.execution).toMatchObject({ status: 'queued', worker_id: null, claimed_at: null, heartbeat_at: null });
      expect(await readJob(input.workspace, task.task_id)).toMatchObject({ state: 'queued', worker_id: null, claim_token: null });
    });
  }

  it('serializes claim and cancel, then applies cancellation at recovery with zero Provider calls', async () => {
    const input = await prepared('claim-cancel-barrier');
    const calls: string[] = [];
    let release!: () => void;
    let claimed!: () => void;
    const claimedSignal = new Promise<void>((resolve) => { claimed = resolve; });
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const worker = runWorker(
      input.workspace,
      { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      { fault: async (point) => {
        if (point === 'after_task_claim_persisted') {
          claimed();
          await releaseSignal;
          throw new Error('claim crash after cancellation barrier');
        }
      } },
    );
    await claimedSignal;
    const cancellation = cancelBackgroundTask(input.workspace, input.submitted.task);
    release();
    await expect(worker).rejects.toThrow('claim crash after cancellation barrier');
    expect((await cancellation).pending).toBe(true);
    await auditInterruptedTasks(input.workspace);
    const task = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
    expect(calls).toEqual([]);
    expect(task.execution.status).toBe('cancelled');
    expect((await readJob(input.workspace, task.task_id)).state).toBe('terminal');
    expect((await readTaskEvents(path.join(input.workspace, 'tasks', task.task_directory))).map((event) => event.type)).toContain('task_cancelled');
  });

  it('contains a first-job pre-Provider exception and continues with the second job', async () => {
    const first = await prepared('contained-first');
    const second = await submitBackgroundTask({ workspaceRoot: first.workspace, audioPath: first.audio, requestId: 'contained-second' });
    const calls: string[] = [];
    await runWorker(
      first.workspace,
      { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      { fault: async (point, task) => { if (point === 'after_claim' && task.task_id === first.submitted.task.task_id) throw new Error('first job failure'); } },
    );
    const firstTask = await readTaskRecordV2(path.join(first.workspace, 'tasks', first.submitted.task.task_directory));
    const secondTask = await readTaskRecordV2(path.join(first.workspace, 'tasks', second.task.task_directory));
    expect(firstTask).toMatchObject({ execution: { status: 'failed' }, error: { code: 'WORKER_JOB_FAILED_BEFORE_PROVIDER' } });
    expect(secondTask.execution.status).toBe('completed');
    expect(calls).toHaveLength(2);
  });

  it('contains an ordinary claim/event persistence error and continues with the second job', async () => {
    const first = await prepared('claim-storage-first');
    const second = await submitBackgroundTask({ workspaceRoot: first.workspace, audioPath: first.audio, requestId: 'claim-storage-second' });
    const firstDirectory = path.join(first.workspace, 'tasks', first.submitted.task.task_directory);
    const existingEvents = await readFile(path.join(firstDirectory, 'events.jsonl'), 'utf8');
    await writeFile(path.join(firstDirectory, 'events.jsonl'), `${existingEvents}middle-corruption\n`);
    const calls: string[] = [];
    await runWorker(first.workspace, { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const failed = await readTaskRecordV2(firstDirectory);
    const completed = await readTaskRecordV2(path.join(first.workspace, 'tasks', second.task.task_directory));
    expect(failed).toMatchObject({ execution: { status: 'failed' }, error: { code: 'WORKER_JOB_FAILED_BEFORE_PROVIDER' } });
    expect((await readJob(first.workspace, failed.task_id)).state).toBe('terminal');
    expect(completed.execution.status).toBe('completed');
    expect(calls).toHaveLength(2);
  });

  it('rechecks the queue at the idle-exit boundary and does not lose a concurrent submit wakeup', async () => {
    const input = await prepared('idle-boundary-seed');
    await cancelBackgroundTask(input.workspace, input.submitted.task);
    const calls: string[] = [];
    let reached!: () => void;
    let release!: () => void;
    let paused = false;
    const reachedSignal = new Promise<void>((resolve) => { reached = resolve; });
    const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
    const worker = runWorker(
      input.workspace,
      { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      { lifecycleFault: async (point) => {
        if (point === 'after_empty_scan' && !paused) {
          paused = true;
          reached();
          await releaseSignal;
        }
      } },
    );
    await reachedSignal;
    expect((await workerStatus(input.workspace)).running).toBe(true);
    const submitted = await submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId: 'idle-boundary-concurrent' });
    release();
    await worker;
    const completed = await readTaskRecordV2(path.join(input.workspace, 'tasks', submitted.task.task_directory));
    expect(completed.execution.status, JSON.stringify(completed.error)).toBe('completed');
    expect(calls).toHaveLength(2);
  });

  it('quarantines a misplaced job identity and continues processing a valid queued task', async () => {
    const first = await prepared('misplaced-job-first');
    const second = await submitBackgroundTask({ workspaceRoot: first.workspace, audioPath: first.audio, requestId: 'misplaced-job-second' });
    const firstJobPath = jobRecordPath(first.workspace, first.submitted.task.task_id);
    const damaged = JSON.parse(await readFile(firstJobPath, 'utf8')) as any;
    damaged.task_id = second.task.task_id;
    await writeFile(firstJobPath, JSON.stringify(damaged));
    const calls: string[] = [];
    await runWorker(first.workspace, { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const completed = await readTaskRecordV2(path.join(first.workspace, 'tasks', second.task.task_directory));
    expect(completed.execution.status).toBe('completed');
    expect(calls).toHaveLength(2);
    const diagnostics = JSON.parse(await readFile(path.join(first.workspace, 'runtime/worker-diagnostics.json'), 'utf8')) as any;
    expect(diagnostics.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'JOB_RECORD_INVALID' })]));
  });

  it('contains an unrecoverable synthetic persisted-response fixture and still processes the next job', async () => {
    const first = await prepared('persisted-fault-first');
    const second = await submitBackgroundTask({ workspaceRoot: first.workspace, audioPath: first.audio, requestId: 'persisted-fault-second' });
    const calls: string[] = [];
    await runWorker(
      first.workspace,
      { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      { fault: async (point, task) => {
        if (point !== 'after_claim' || task.task_id !== first.submitted.task.task_id) return;
        task.execution.provider_call!.asr = { state: 'terminal', evidence_ref: 'work/transcript.raw.json' };
        task.execution.provider_call!.chat = { state: 'response_persisted', evidence_ref: 'work/calibration-result.json' };
        task.execution.safe_checkpoint = 'chat_response_persisted';
        await persistTaskRecordV2(path.join(first.workspace, 'tasks', task.task_directory), task);
        throw new Error('local work crashed after response persistence');
      } },
    );
    const recovered = await readTaskRecordV2(path.join(first.workspace, 'tasks', first.submitted.task.task_directory));
    const completed = await readTaskRecordV2(path.join(first.workspace, 'tasks', second.task.task_directory));
    expect(recovered.execution).toMatchObject({ status: 'failed', safe_checkpoint: 'chat_response_persisted' });
    expect(recovered.error?.code).toBe('WORKER_LOCAL_RECOVERY_FAILED');
    expect(await readJob(first.workspace, recovered.task_id)).toMatchObject({ state: 'terminal' });
    expect(completed.execution.status).toBe('completed');
    expect(calls).toHaveLength(2);
  });

  for (const corePoint of ['after_chat_response_persisted', 'before_completed_commit'] as const) {
    it(`recovers the real core ${corePoint} fault locally with zero repeated Provider calls`, async () => {
      const input = await prepared(`core-local-recovery-${corePoint}`);
      const calls: string[] = [];
      let injected = false;
      await runWorker(input.workspace, {
        asrAdapter: fixtureAsr(calls),
        fetch: fixtureFetch(calls),
        readCredential: async () => 'fixture-secret',
        fault: async (point) => {
          if (!injected && point === corePoint) {
            injected = true;
            throw new Error(`core local fault:${corePoint}`);
          }
        },
      });
      const completed = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
      expect(completed.execution.status).toBe('completed');
      expect(completed.execution.safe_checkpoint).toBe('outputs_validated');
      expect(calls).toHaveLength(2);
      expect(await readJob(input.workspace, completed.task_id)).toMatchObject({ state: 'terminal' });
    });
  }

  it('terminalizes a completed first task when event emission fails and continues the queue', async () => {
    const first = await prepared('event-fault-first');
    const second = await submitBackgroundTask({ workspaceRoot: first.workspace, audioPath: first.audio, requestId: 'event-fault-second' });
    const calls: string[] = [];
    await runWorker(
      first.workspace,
      { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      { fault: async (point, task) => { if (point === 'after_review' && task.task_id === first.submitted.task.task_id) throw new Error('event append unavailable'); } },
    );
    expect((await readTaskRecordV2(path.join(first.workspace, 'tasks', first.submitted.task.task_directory))).execution.status).toBe('completed');
    expect((await readJob(first.workspace, first.submitted.task.task_id)).state).toBe('terminal');
    expect((await readTaskRecordV2(path.join(first.workspace, 'tasks', second.task.task_directory))).execution.status).toBe('completed');
    expect(calls).toHaveLength(4);
  });

  for (const safePoint of ['after_chat_response_persisted', 'before_completed_commit'] as const) {
    it(`applies cancellation at ${safePoint} without publishing calibrated/approved output`, async () => {
      const input = await prepared(`cancel-${safePoint}`);
      const calls: string[] = [];
      let reached!: () => void;
      let release!: () => void;
      const reachedSignal = new Promise<void>((resolve) => { reached = resolve; });
      const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
      const worker = runWorker(input.workspace, {
        asrAdapter: fixtureAsr(calls),
        fetch: fixtureFetch(calls),
        readCredential: async () => 'fixture-secret',
        fault: async (point) => {
          if (point === safePoint) {
            reached();
            await releaseSignal;
          }
        },
      }, { heartbeatIntervalMs: 10 });
      await reachedSignal;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const current = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
      expect(current.execution.heartbeat_at).not.toBeNull();
      const cancellation = await cancelBackgroundTask(input.workspace, current);
      expect(cancellation.pending).toBe(true);
      release();
      await worker;
      const cancelled = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
      expect(cancelled.execution.status).toBe('cancelled');
      expect(cancelled.artifacts.subtitles?.transcribed?.validation).toBe('passed');
      expect(cancelled.artifacts.subtitles?.calibrated).toBeNull();
      expect(cancelled.artifacts.subtitles?.approved).toBeNull();
      expect(cancelled.artifacts.outputs).toEqual(['output/source.transcribed.srt']);
      expect(calls).toHaveLength(2);
    });
  }

  it('treats cancellation after the atomic completed transition as a no-op', async () => {
    const input = await prepared('cancel-after-completed');
    await runWorker(input.workspace, { asrAdapter: fixtureAsr([]), fetch: fixtureFetch([]), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', input.submitted.task.task_directory);
    const completed = await readTaskRecordV2(directory);
    const beforeEvents = await readTaskEvents(directory);
    const cancelled = await cancelBackgroundTask(input.workspace, completed);
    expect(cancelled).toMatchObject({ pending: false, task: { execution: { status: 'completed', cancellation_requested_at: null } } });
    expect(await readTaskEvents(directory)).toEqual(beforeEvents);
  });

  for (const certainty of ['not_dispatched', 'known_terminal', 'outcome_unknown'] as const) {
    it(`maps adapter side-effect certainty ${certainty} without automatic replay`, async () => {
      const input = await prepared(`certainty-${certainty}`);
      const asrCalls: string[] = [];
      const chatCalls: string[] = [];
      await runWorker(input.workspace, {
        asrAdapter: failureAsr(certainty, asrCalls),
        fetch: fixtureFetch(chatCalls),
        readCredential: async () => 'fixture-secret',
      });
      const task = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
      expect(asrCalls).toHaveLength(1);
      expect(chatCalls).toEqual([]);
      expect(task.execution.status).toBe(certainty === 'outcome_unknown' ? 'interrupted' : 'failed');
      expect(task.execution.provider_call?.asr.state).toBe(certainty === 'outcome_unknown' ? 'in_flight' : 'terminal');
      expect(task.adapter_failures[0]?.provider_outcome_certainty).toBe(certainty);
      if (certainty === 'outcome_unknown') {
        expect(task.error).toMatchObject({ code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', retryable: false });
        expect((await taskMachineView(input.workspace, task)).next_action).toContain('不要自动重试');
      }
      expect((await readJob(input.workspace, task.task_id)).state).toBe('terminal');
    });
  }

  it('persists in_flight only from the adapter dispatch hook immediately before each real call', async () => {
    const input = await prepared('dispatch-checkpoint');
    const calls: string[] = [];
    const delegate = fixtureAsr(calls);
    const states: Array<{ role: string; state: string }> = [];
    const dispatchingAsr: AsrAdapter = {
      adapterId: 'volcengine_asr',
      async run(adapterInput) {
        const before = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
        states.push({ role: 'asr-before', state: before.execution.provider_call!.asr.state });
        await adapterInput.beforeProviderDispatch?.('volcengine_asr_recognize');
        const current = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
        states.push({ role: 'asr', state: current.execution.provider_call!.asr.state });
        return delegate.run(adapterInput);
      },
    };
    await runWorker(input.workspace, {
      asrAdapter: dispatchingAsr,
      fetch: fixtureFetch(calls),
      readCredential: async () => 'fixture-secret',
      captureRequest: async () => {
        const current = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
        states.push({ role: 'chat-before', state: current.execution.provider_call!.chat.state });
      },
      beforeProviderDispatch: async (operation) => {
        if (operation !== 'openai_chat_calibration') return;
        const current = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
        states.push({ role: 'chat', state: current.execution.provider_call!.chat.state });
      },
    });
    expect(states).toEqual([
      { role: 'asr-before', state: 'not_started' },
      { role: 'asr', state: 'in_flight' },
      { role: 'chat-before', state: 'not_started' },
      { role: 'chat', state: 'in_flight' },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('keeps a dispatch-boundary cancellation terminal when the adapter reports not_dispatched', async () => {
    const input = await prepared('cancel-at-dispatch');
    const calls: string[] = [];
    const adapterInvocations: string[] = [];
    const adapter: AsrAdapter = {
      adapterId: 'volcengine_asr',
      async run(adapterInput) {
        await cancelBackgroundTask(input.workspace, input.submitted.task);
        try {
          await adapterInput.beforeProviderDispatch?.('volcengine_asr_recognize');
        } catch {
          return failureAsr('not_dispatched', adapterInvocations).run(adapterInput);
        }
        throw new Error('Provider must not be dispatched after cancellation');
      },
    };
    await runWorker(input.workspace, {
      asrAdapter: adapter,
      fetch: fixtureFetch(calls),
      readCredential: async () => 'fixture-secret',
    });
    const cancelled = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
    expect(cancelled.execution.status).toBe('cancelled');
    expect(cancelled.adapter_failures).toEqual([]);
    expect(calls).toEqual([]);
    expect(adapterInvocations).toHaveLength(1);
    expect(await readJob(input.workspace, cancelled.task_id)).toMatchObject({ state: 'terminal' });
  });

  it('interrupts without replay when an adapter throws after the durable dispatch hook', async () => {
    const input = await prepared('throw-after-dispatch');
    const dispatches: string[] = [];
    const adapter: AsrAdapter = {
      adapterId: 'volcengine_asr',
      async run(adapterInput) {
        await adapterInput.beforeProviderDispatch?.('volcengine_asr_recognize');
        dispatches.push(adapterInput.taskId);
        throw new Error('socket aborted after dispatch');
      },
    };
    await runWorker(input.workspace, {
      asrAdapter: adapter,
      fetch: fixtureFetch([]),
      readCredential: async () => 'fixture-secret',
    });
    const interrupted = await readTaskRecordV2(path.join(input.workspace, 'tasks', input.submitted.task.task_directory));
    expect(dispatches).toHaveLength(1);
    expect(interrupted.execution.status).toBe('interrupted');
    expect(interrupted.execution.provider_call?.asr.state).toBe('in_flight');
    expect(interrupted.error).toMatchObject({ code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', retryable: false });
    expect((await taskMachineView(input.workspace, interrupted)).next_action).toContain('不要自动重试');
    expect(await readJob(input.workspace, interrupted.task_id)).toMatchObject({ state: 'terminal' });
  });

  it('stops before claiming another job after the serialized heartbeat write fails', async () => {
    const first = await prepared('heartbeat-first');
    const second = await submitBackgroundTask({ workspaceRoot: first.workspace, audioPath: first.audio, requestId: 'heartbeat-second' });
    const calls: string[] = [];
    const delegate = fixtureAsr(calls);
    const slowDispatch: AsrAdapter = {
      adapterId: 'volcengine_asr',
      async run(adapterInput) {
        await adapterInput.beforeProviderDispatch?.('volcengine_asr_recognize');
        await new Promise((resolve) => setTimeout(resolve, 20));
        return delegate.run(adapterInput);
      },
    };
    await expect(runWorker(
      first.workspace,
      { asrAdapter: slowDispatch, fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      {
        heartbeatIntervalMs: 1,
        heartbeatFault: async () => {
          throw new Error('heartbeat storage unavailable');
        },
      },
    )).rejects.toThrow('heartbeat storage unavailable');
    expect(calls).toHaveLength(2);
    expect((await readTaskRecordV2(path.join(first.workspace, 'tasks', first.submitted.task.task_directory))).execution.status).toBe('completed');
    expect((await readTaskRecordV2(path.join(first.workspace, 'tasks', second.task.task_directory))).execution.status).toBe('queued');
    expect(await readJob(first.workspace, second.task.task_id)).toMatchObject({ state: 'queued' });
  });
});
