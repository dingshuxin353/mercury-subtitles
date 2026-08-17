import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { appendTaskEvent, readJob, readRequest, readTaskEvents, requestIdHash } from '../src/background/storage.js';
import { cancelBackgroundTask, submitBackgroundTask, taskMachineView } from '../src/background/runtime.js';
import { createCalibrationTaskV2, readTaskRecordV2 } from '../src/tasks-v2.js';
import { ensureWorkspace } from '../src/workspace.js';
import { startDetachedWorker } from '../src/background/worker.js';

const roots: string[] = [];

async function prepared() {
  const home = await mkdtemp(path.join(tmpdir(), 'mercury-reliability-'));
  roots.push(home);
  const workspace = path.join(home, 'mercury-workspace');
  await ensureWorkspace(workspace);
  await writeFile(path.join(workspace, 'config/model-config.json'), await readFile(new URL('./fixtures/valid/model-config.json', import.meta.url)));
  const audio = path.join(home, 'source.mp3');
  const bytes = Buffer.alloc(834);
  bytes.set([0xff, 0xfb, 0x90, 0x64], 0);
  bytes.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(audio, bytes);
  return { home, workspace, audio };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('V02-D002 crash recovery and query safety', () => {
  for (const point of ['task_created', 'task_promoted', 'queued_event_written', 'job_written', 'request_committed'] as const) {
    it(`repairs the request reservation after a crash at ${point}`, async () => {
      const input = await prepared();
      const requestId = `crash:${point}`;
      await expect(submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId }, {
        fault: async (current) => { if (current === point) throw new Error(`crash:${point}`); },
      })).rejects.toThrow(`crash:${point}`);
      const replay = await submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId });
      const taskDirectories = (await readdir(path.join(input.workspace, 'tasks'), { withFileTypes: true })).filter((entry) => entry.isDirectory());
      expect(taskDirectories).toHaveLength(1);
      expect(replay.replayed).toBe(true);
      expect(replay.task.schema_version).toBe('4.0.0');
      expect((await readJob(input.workspace, replay.task.task_id)).state).toBe('queued');
      expect((await readRequest(input.workspace, requestIdHash(requestId))).state).toBe('committed');
      expect((await readTaskEvents(path.join(input.workspace, 'tasks', replay.task.task_directory))).map((event) => event.sequence)).toEqual([1]);
    });
  }

  it('does not delete a live slow reservation after five seconds and creates one task/job', async () => {
    const input = await prepared();
    const requestId = 'slow-live-reservation';
    const createTask = vi.fn(async (...args: Parameters<typeof createCalibrationTaskV2>) => {
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      return createCalibrationTaskV2(...args);
    });
    const first = submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId }, { createTask });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId }, { createTask });
    const [created, replayed] = await Promise.all([first, second]);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(created.task.task_id).toBe(replayed.task.task_id);
    expect(replayed.replayed).toBe(true);
    expect((await readdir(path.join(input.workspace, 'runtime/jobs'))).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect((await readdir(path.join(input.workspace, 'tasks'))).filter((name) => name.startsWith('tsk-'))).toHaveLength(1);
  }, 10_000);

  it('repairs only a trailing partial event, preserves sequence, and rejects middle corruption', async () => {
    const input = await prepared();
    const submitted = await submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId: 'event-tail' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.task_directory);
    await writeFile(path.join(directory, 'events.jsonl'), '{"partial":', { flag: 'a' });
    expect((await readTaskEvents(directory)).map((event) => event.sequence)).toEqual([1]);
    await appendTaskEvent(directory, { taskId: submitted.task.task_id, sequence: 99, type: 'stage_started', message: 'recovered' });
    expect((await readTaskEvents(directory)).map((event) => event.sequence)).toEqual([1, 2]);
    const source = await readFile(path.join(directory, 'events.jsonl'), 'utf8');
    await writeFile(path.join(directory, 'events.jsonl'), `${source.split('\n')[0]}\nnot-json\n${source.split('\n')[1]}\n`);
    await expect(readTaskEvents(directory)).rejects.toMatchObject({ code: 'EVENT_LOG_INVALID' });
  });

  it('uses the durable event tail even when task.json was not updated after append', async () => {
    const input = await prepared();
    const submitted = await submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId: 'event-sequence-source' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.task_directory);
    await appendTaskEvent(directory, { taskId: submitted.task.task_id, sequence: 2, type: 'stage_started', message: 'durable event' });
    const stale = await readTaskRecordV2(directory);
    expect(stale.execution.last_event_sequence).toBe(1);
    expect((await taskMachineView(input.workspace, stale)).last_event_sequence).toBe(2);
  });

  it('requires an explicit request ID in machine background mode before creating any state', async () => {
    const input = await prepared();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await runCli(
      ['calibrate', '--audio', input.audio, '--background', '--json'],
      { homeDirectory: input.home, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    );
    expect(exit).toBe(2);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, error: { code: 'REQUEST_ID_REQUIRED' } });
    expect(stderr).toEqual([]);
    expect(await readdir(path.join(input.workspace, 'tasks'))).toEqual([]);
    await expect(readdir(path.join(input.workspace, 'runtime/jobs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('derives the same request ID after output loss without creating task/job state', async () => {
    const input = await prepared();
    const derive = async () => {
      const stdout: string[] = [];
      expect(await runCli(
        ['request', 'id', '--audio', input.audio, '--intent', 'skill:background-subtitles:v1', '--json'],
        { homeDirectory: input.home, stdout: (value) => stdout.push(value), stderr: () => {} },
      )).toBe(0);
      return JSON.parse(stdout[0]!) as any;
    };
    const first = await derive();
    const afterLostOutput = await derive();
    expect(afterLostOutput).toEqual(first);
    expect(first).toMatchObject({ ok: true, command: 'request.id', data: { request_id: expect.stringMatching(/^req-[a-f0-9]{40}$/u), input_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    expect(await readdir(path.join(input.workspace, 'tasks'))).toEqual([]);
    await expect(readdir(path.join(input.workspace, 'runtime/jobs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps status/list/result/worker status and watch reconnect read-only for a queued task', async () => {
    const input = await prepared();
    const submitted = await submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId: 'read-only-query' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.task_directory);
    const beforeTask = await readFile(path.join(directory, 'task.json'), 'utf8');
    const beforeJob = JSON.stringify(await readJob(input.workspace, submitted.task.task_id));
    for (const args of [
      ['task', 'status', submitted.task.task_id, '--json'],
      ['task', 'list', '--json'],
      ['task', 'result', submitted.task.task_id, '--json'],
      ['worker', 'status', '--json'],
    ]) {
      const stdout: string[] = [];
      expect(await runCli(args, { homeDirectory: input.home, stdout: (value) => stdout.push(value), stderr: () => {} })).toBe(0);
      expect(JSON.parse(stdout[0]!).contract).toBe('mercury.cli/v1');
    }
    const watch = runCli(
      ['task', 'watch', submitted.task.task_id, '--after', '1', '--jsonl'],
      { homeDirectory: input.home, stdout: () => {}, stderr: () => {} },
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await readFile(path.join(directory, 'task.json'), 'utf8')).toBe(beforeTask);
    expect(JSON.stringify(await readJob(input.workspace, submitted.task.task_id))).toBe(beforeJob);
    await cancelBackgroundTask(input.workspace, submitted.task);
    expect(await watch).toBe(0);
  });

  it('starts the Worker for a valid queued job even when another job record is invalid', async () => {
    const input = await prepared();
    const submitted = await submitBackgroundTask({ workspaceRoot: input.workspace, audioPath: input.audio, requestId: 'worker-start-isolated-scan' });
    const validJob = await readJob(input.workspace, submitted.task.task_id);
    await writeFile(
      path.join(input.workspace, 'runtime/jobs/tsk-20260816-235959-deadbeef.json'),
      JSON.stringify(validJob),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const start = vi.fn(async () => ({ pid: 4242, ready: true as const }));
    expect(await runCli(
      ['worker', 'start', '--json'],
      { homeDirectory: input.home, stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      {},
      {},
      { startDetachedWorker: start },
    )).toBe(0);
    expect(start).toHaveBeenCalledWith(input.workspace);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      contract: 'mercury.cli/v1',
      ok: true,
      command: 'worker.start',
      data: { queued: true, running: true, started: true, pid: 4242 },
    });
    expect(await readJob(input.workspace, submitted.task.task_id)).toMatchObject({ state: 'queued' });
  });

  it('waits for an observable detached Worker ready record and reports early exit', async () => {
    const input = await prepared();
    const readyScript = path.join(input.home, 'ready-worker.mjs');
    await writeFile(readyScript, [
      "import {mkdir,writeFile} from 'node:fs/promises';",
      "import path from 'node:path';",
      "const args=process.argv.slice(2); const root=args[args.indexOf('--workspace')+1];",
      "await mkdir(path.join(root,'runtime'),{recursive:true});",
      "const at=new Date().toISOString();",
      "await writeFile(path.join(root,'runtime','worker.json'),JSON.stringify({contract_version:'mercury-worker-experimental-v1',worker_id:'fixture-ready',pid:process.pid,started_at:at,heartbeat_at:at,state:'idle',task_id:null}));",
      "await new Promise(r=>setTimeout(r,500));",
    ].join('\n'));
    const started = await startDetachedWorker(input.workspace, readyScript, { readyTimeoutMs: 1_000 });
    expect(started).toMatchObject({ pid: expect.any(Number), ready: true });
    await new Promise((resolve) => setTimeout(resolve, 550));
    const exitScript = path.join(input.home, 'exit-worker.mjs');
    await writeFile(exitScript, 'process.exit(7);\n');
    await expect(startDetachedWorker(input.workspace, exitScript, { readyTimeoutMs: 500 })).rejects.toMatchObject({ code: 'WORKER_START_FAILED' });

    const slowScript = path.join(input.home, 'slow-worker.mjs');
    await writeFile(slowScript, 'await new Promise(r=>setTimeout(r,500));\n');
    const startedAt = Date.now();
    await expect(startDetachedWorker(input.workspace, slowScript, { readyTimeoutMs: 30 })).rejects.toMatchObject({ code: 'WORKER_START_FAILED' });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});
