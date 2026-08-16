import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import taskSchema from '../schemas/v4/background-task.schema.json' with { type: 'json' };
import jobSchema from '../schemas/v4/background-job.schema.json' with { type: 'json' };
import requestSchema from '../schemas/v4/background-request.schema.json' with { type: 'json' };
import eventSchema from '../schemas/v4/task-event.schema.json' with { type: 'json' };
import commonSchema from '../schemas/v1/common.schema.json' with { type: 'json' };
import { runCli } from '../src/cli.js';
import { cancelBackgroundTask, submitBackgroundTask } from '../src/background/runtime.js';
import { listJobs, readJob, readRequest, readTaskEvents, requestIdHash } from '../src/background/storage.js';
import { ensureWorkspace } from '../src/workspace.js';
import { validateV4Contract } from '../src/contracts/v4.js';
import { readTaskRecordV2 } from '../src/tasks-v2.js';

const roots: string[] = [];

async function fixture(): Promise<{ home: string; workspace: string; audio: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'mercury-background-'));
  roots.push(home);
  const workspace = path.join(home, 'mercury-workspace');
  await ensureWorkspace(workspace);
  await writeFile(
    path.join(workspace, 'config', 'model-config.json'),
    await readFile(new URL('./fixtures/valid/model-config.json', import.meta.url)),
  );
  const audio = path.join(home, 'sample.mp3');
  const frames = Buffer.alloc(834);
  frames.set([0xff, 0xfb, 0x90, 0x64], 0);
  frames.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(audio, frames);
  return { home, workspace, audio };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('V02-D001 background persistence contracts', () => {
  it('freezes valid v4 task, job, request and event documents with private permissions', async () => {
    const { workspace, audio } = await fixture();
    const result = await submitBackgroundTask({
      workspaceRoot: workspace,
      audioPath: audio,
      requestId: 'agent-session:test-001',
      now: () => new Date('2026-08-16T01:02:03.000Z'),
      randomHex: () => '1234abcd',
    });
    const directory = path.join(workspace, 'tasks', result.task.task_directory);
    const job = await readJob(workspace, result.task.task_id);
    const request = await readRequest(workspace, requestIdHash('agent-session:test-001'));
    const events = await readTaskEvents(directory);
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    ajv.addKeyword({ keyword: 'x-mercury-invariant-id', schemaType: 'string', valid: true });
    ajv.addKeyword({ keyword: 'x-mercury-semantic-checks', schemaType: 'array', valid: true });
    ajv.addSchema(commonSchema);
    expect(ajv.validate(taskSchema, result.task), ajv.errorsText()).toBe(true);
    expect(ajv.validate(jobSchema, job), ajv.errorsText()).toBe(true);
    expect(ajv.validate(requestSchema, request), ajv.errorsText()).toBe(true);
    expect(ajv.validate(eventSchema, events[0]), ajv.errorsText()).toBe(true);
    expect(result.task.execution).toMatchObject({
      status: 'queued',
      stage: null,
      attempt: 0,
      provider_call: {
        asr: { state: 'not_started' },
        chat: { state: 'not_started' },
      },
    });
    for (const target of [
      path.join(directory, 'task.json'),
      path.join(directory, 'events.jsonl'),
      path.join(workspace, 'runtime', 'jobs', `${result.task.task_id}.json`),
      path.join(workspace, 'runtime', 'requests', `${result.request_id_hash}.json`),
    ]) {
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it('replays the same request one hundred times and rejects a different fingerprint', async () => {
    const { workspace, audio } = await fixture();
    const options = {
      workspaceRoot: workspace,
      audioPath: audio,
      requestId: 'skill:stable-request-100',
      now: () => new Date('2026-08-16T02:03:04.000Z'),
      randomHex: () => '5678abcd',
    };
    const first = await submitBackgroundTask(options);
    const replays = await Promise.all(Array.from({ length: 100 }, () => submitBackgroundTask(options)));
    expect(new Set(replays.map((item) => item.task.task_id))).toEqual(new Set([first.task.task_id]));
    expect(replays.every((item) => item.replayed)).toBe(true);
    const changed = path.join(path.dirname(audio), 'changed.mp3');
    const bytes = Buffer.alloc(834, 1);
    bytes.set([0xff, 0xfb, 0x90, 0x64], 0);
    bytes.set([0xff, 0xfb, 0x90, 0x64], 417);
    await writeFile(changed, bytes);
    await expect(submitBackgroundTask({ ...options, audioPath: changed })).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
  });

  it('returns a parseable machine envelope with no human text and treats a cancelled task as query success', async () => {
    const { home, workspace, audio } = await fixture();
    const result = await submitBackgroundTask({ workspaceRoot: workspace, audioPath: audio, requestId: 'machine-json', now: () => new Date('2026-08-16T03:04:05.000Z'), randomHex: () => '90abcdef' });
    await cancelBackgroundTask(workspace, result.task);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await runCli(
      ['task', 'status', result.task.task_id, '--json'],
      { homeDirectory: home, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    );
    expect(exit).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const envelope = JSON.parse(stdout[0]!) as any;
    expect(envelope).toMatchObject({
      contract_version: 'mercury-cli-experimental-v1',
      ok: true,
      command: 'task.status',
      data: { task_id: result.task.task_id, execution: { status: 'cancelled' } },
    });
  });

  it('rejects request IDs and event paths that could traverse runtime storage', async () => {
    const { workspace, audio } = await fixture();
    await expect(submitBackgroundTask({ workspaceRoot: workspace, audioPath: audio, requestId: '../../bad id' })).rejects.toMatchObject({ code: 'REQUEST_ID_INVALID' });
  });

  it('rejects missing core task fields and impossible execution combinations before machine/Worker reads', async () => {
    const { workspace, audio } = await fixture();
    const submitted = await submitBackgroundTask({ workspaceRoot: workspace, audioPath: audio, requestId: 'strict-v4-shape' });
    for (const field of ['input_config', 'inputs', 'model_snapshot', 'artifacts', 'warnings', 'error'] as const) {
      const damaged = structuredClone(submitted.task) as any;
      delete damaged[field];
      expect(validateV4Contract('background-task', damaged).valid, field).toBe(false);
    }
    for (const mutation of [
      (task: any) => { task.execution.status = 'queued'; task.execution.worker_id = 'wrk-impossible'; },
      (task: any) => { task.execution.status = 'running'; task.execution.stage = 'preparing'; task.execution.worker_id = null; },
      (task: any) => { task.execution.status = 'completed'; task.execution.ended_at = new Date().toISOString(); },
      (task: any) => { task.adapter_failures = [{ failure_id: 'f-1', task_id: task.task_id, model_category: 'asr', capability: 'transcription', model_snapshot_ref: 'asr', occurred_at: new Date().toISOString(), provider_outcome_certainty: 'outcome_unknown', errors: [], warnings: [], call: null }]; },
    ]) {
      const damaged = structuredClone(submitted.task) as any;
      mutation(damaged);
      expect(validateV4Contract('background-task', damaged).valid).toBe(false);
    }
    const directory = path.join(workspace, 'tasks', submitted.task.task_directory);
    const onDisk = JSON.parse(await readFile(path.join(directory, 'task.json'), 'utf8')) as any;
    delete onDisk.inputs;
    await writeFile(path.join(directory, 'task.json'), JSON.stringify(onDisk));
    await expect(readTaskRecordV2(directory)).rejects.toThrow(/background-task v4 invalid/u);
  });

  it('rejects misplaced runtime identities, cross-task events, and symlinked task directories with stable codes', async () => {
    const { home, workspace, audio } = await fixture();
    const submitted = await submitBackgroundTask({ workspaceRoot: workspace, audioPath: audio, requestId: 'identity-negative' });
    const requestHash = requestIdHash('identity-negative');
    const requestPath = path.join(workspace, 'runtime/requests', `${requestHash}.json`);
    const request = JSON.parse(await readFile(requestPath, 'utf8')) as any;
    request.request_id_hash = 'f'.repeat(64);
    await writeFile(requestPath, JSON.stringify(request));
    await expect(readRequest(workspace, requestHash)).rejects.toMatchObject({ code: 'REQUEST_RECORD_INVALID' });

    const jobPath = path.join(workspace, 'runtime/jobs', `${submitted.task.task_id}.json`);
    const job = JSON.parse(await readFile(jobPath, 'utf8')) as any;
    job.task_id = 'tsk-20260816-000000-deadbeef';
    await writeFile(jobPath, JSON.stringify(job));
    await expect(readJob(workspace, submitted.task.task_id)).rejects.toMatchObject({ code: 'JOB_RECORD_INVALID' });

    const directory = path.join(workspace, 'tasks', submitted.task.task_directory);
    const eventsPath = path.join(directory, 'events.jsonl');
    const event = JSON.parse((await readFile(eventsPath, 'utf8')).trim()) as any;
    event.task_id = 'tsk-20260816-000000-deadbeef';
    await writeFile(eventsPath, `${JSON.stringify(event)}\n`);
    await expect(readTaskEvents(directory)).rejects.toMatchObject({ code: 'EVENT_LOG_INVALID' });

    const saved = path.join(home, 'saved-task-directory');
    await rename(directory, saved);
    await symlink(saved, directory, 'dir');
    await expect(readTaskRecordV2(directory)).rejects.toMatchObject({ code: 'TASK_PATH_UNSAFE' });
  });

  it('rejects a symlinked tasks ancestor and reports a symlinked job record', async () => {
    const first = await fixture();
    const submitted = await submitBackgroundTask({ workspaceRoot: first.workspace, audioPath: first.audio, requestId: 'ancestor-symlink' });
    const tasks = path.join(first.workspace, 'tasks');
    const savedTasks = path.join(first.home, 'saved-tasks');
    await rename(tasks, savedTasks);
    await symlink(savedTasks, tasks, 'dir');
    await expect(readTaskRecordV2(path.join(tasks, submitted.task.task_directory))).rejects.toMatchObject({ code: 'TASK_PATH_UNSAFE' });

    const second = await fixture();
    const secondTask = await submitBackgroundTask({ workspaceRoot: second.workspace, audioPath: second.audio, requestId: 'job-symlink' });
    const jobPath = path.join(second.workspace, 'runtime/jobs', `${secondTask.task.task_id}.json`);
    const savedJob = path.join(second.home, 'saved-job.json');
    await rename(jobPath, savedJob);
    await symlink(savedJob, jobPath, 'file');
    await expect(listJobs(second.workspace)).rejects.toMatchObject({ code: 'JOB_RECORD_INVALID' });
  });
});
