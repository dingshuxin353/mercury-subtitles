import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureWorkspace } from '../src/workspace.js';
import { loadModelRegistryV2 } from '../src/models-v2.js';
import { runWorker } from '../src/background/worker.js';
import { appendV5Event, readV5Events, readV5Task, submitExchangeRequest } from '../src/exchange/runtime.js';
import { findTaskReadOnly, stableTaskResult, stableTaskView } from '../src/stable-cli/tasks.js';
import { createDictionary, makeDictionaryEntry, mutateDictionary } from '../src/dictionary.js';
import { runCli } from '../src/cli.js';

function sha(value: Buffer | string) { return createHash('sha256').update(value).digest('hex'); }

async function prepared() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mercury-exchange-task-'));
  const workspace = path.join(home, 'mercury-workspace');
  await ensureWorkspace(workspace);
  await writeFile(path.join(workspace, 'config/model-config.json'), await readFile(new URL('./fixtures/valid/model-config.json', import.meta.url)));
  const registry = await loadModelRegistryV2(workspace);
  const source = path.join(home, 'provided.srt');
  const sourceText = '1\n00:00:00,000 --> 00:00:01,000\n您好 Mercury\n\n2\n00:00:01,000 --> 00:00:02,000\n字幕测试\n';
  await writeFile(source, sourceText);
  const request = {
    contract: 'mercury.exchange.request/v1', request_id: 'request-external-test', created_at: '2026-08-16T15:00:00.000Z', operation: 'subtitle_calibration',
    inputs: { media: null, transcript: { path: source, sha256: sha(sourceText), format: 'srt', role: 'transcript_source' } },
    transcription_mode: 'provided', calibration: { mode: 'text-only', source_language: 'zh-CN' },
    models: { asr: null, chat: registry.defaults.chat }, dictionaries: { project_key: null, selected: [] as string[], task_overrides: [] },
    output: { formats: ['srt', 'report'], workspace_policy: 'managed' }, extensions: {},
  };
  return { home, workspace, source, request };
}

function fixtureFetch(calls: string[], captured: Array<Record<string, any>> = [], correct?: (text: string, index: number) => string) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push('chat');
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    captured.push(request as unknown as Record<string, any>);
    const prompt = request.messages.find((message) => message.role === 'user')!.content;
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { calibration_units: Array<{ unit_id: string; original_text: string }> };
    const content = JSON.stringify({ corrected_units: payload.calibration_units.map((unit, index) => ({ unit_id: unit.unit_id, corrected_text: correct?.(unit.original_text, index) ?? unit.original_text, rationale: correct && index === 0 ? 'fixture correction' : null })) });
    return new Response(`data: ${JSON.stringify({ id: 'fixture-chat', choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture-chat', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
}

describe('Exchange v1 external transcript task', () => {
  it('persists the stable task directory, replays idempotently, and completes with zero ASR', async () => {
    const input = await prepared();
    const dictionary = await createDictionary(input.workspace, { name: 'Task Terms', scope: 'global' });
    const dictionaryV2 = (await mutateDictionary(input.workspace, dictionary.dictionary_id, dictionary.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: 'entry-mercury-name', canonical: 'Mercury', variants: ['水星'], kind: 'product' })))).dictionary;
    input.request.dictionaries.selected = [dictionary.dictionary_id];
    const first = await submitExchangeRequest(input.workspace, input.request);
    const second = await submitExchangeRequest(input.workspace, input.request);
    expect(second.replayed).toBe(true);
    expect(second.task.identity.task_id).toBe(first.task.identity.task_id);
    const directory = path.join(input.workspace, 'tasks', first.task.identity.task_directory);
    for (const relative of ['request.json', 'task.json', 'events.jsonl', 'attempts.jsonl', 'input/transcript-source.srt', 'work/transcript.normalized.json', first.task.artifacts.transcribed!.path]) {
      if (relative === 'attempts.jsonl') continue;
      expect((await stat(path.join(directory, relative))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path.join(directory, 'input/transcript-source.srt'), 'utf8')).toBe(await readFile(input.source, 'utf8'));
    expect(first.task.execution.provider_calls.asr).toEqual({ state: 'not_started', count: 0, outcome: 'not_dispatched', evidence_ref: null });

    await mutateDictionary(input.workspace, dictionary.dictionary_id, dictionaryV2.revision, (current) => { current.entries[0]!.canonical = 'Changed Later'; });
    const calls: string[] = []; const captured: Array<Record<string, any>> = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls, captured), readCredential: async () => 'fixture-secret' });
    const completed = await readV5Task(directory);
    expect(completed.status, JSON.stringify(completed.error)).toBe('completed');
    expect(completed.execution.provider_calls.asr.count).toBe(0);
    expect(completed.execution.provider_calls.chat.count).toBe(1);
    expect(calls).toEqual(['chat']);
    const prompt = (captured[0]!.messages as Array<{ role: string; content: string }>).find((entry) => entry.role === 'user')!.content;
    const promptData = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    expect(promptData.dictionary_context.entries).toEqual([expect.objectContaining({ entry_id: 'entry-mercury-name', canonical: 'Mercury' })]);
    const found = await findTaskReadOnly(input.workspace, completed.identity.task_id);
    const view = await stableTaskView(input.workspace, found);
    const result = await stableTaskResult(input.workspace, found);
    expect(view.source_schema_version).toBe('5.0.0');
    expect(view.capabilities.provided_transcript.supported).toBe(true);
    expect(result.transcription).toMatchObject({ mode: 'provided', asr_call_count: 0 });
    expect(result.dictionaries).toMatchObject({ match_count: 1, conflict_count: 0, snapshots: [expect.objectContaining({ revision: dictionaryV2.revision })] });
    expect(result.artifacts.find((entry) => entry.identity === 'transcribed_srt')).toMatchObject({ exists: true, validation: 'passed' });
    expect(result.artifacts.find((entry) => entry.identity === 'calibrated_srt')).toMatchObject({ exists: true, validation: 'passed' });
    const attempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(attempts).toEqual([
      expect.objectContaining({ contract: 'mercury.attempt/v1', asr_call_count: 0 }),
      expect.objectContaining({ contract: 'mercury.attempt-result/v1', status: 'completed', asr_call_count: 0, chat_call_count: 1 }),
    ]);

    await writeFile(path.join(directory, completed.artifacts.report!.path), 'tampered\n');
    const tampered = await stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, completed.identity.task_id));
    expect(tampered.artifacts.find((entry) => entry.identity === 'calibration_report')).toMatchObject({ exists: true, validation: 'unavailable' });
  });

  it('retains transcribed output and never publishes calibrated output when Chat fails deterministically', async () => {
    const input = await prepared();
    input.request.request_id = 'request-external-failure';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    await runWorker(input.workspace, { fetch: vi.fn(async () => new Response('{"error":"bad"}', { status: 400 })), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory));
    expect(task.status).toBe('failed');
    expect(task.artifacts.transcribed?.validation).toBe('passed');
    expect(task.artifacts.calibrated).toBeNull();
    expect(task.execution.provider_calls.asr.count).toBe(0);
    expect(task.execution.provider_calls.chat.count).toBe(1);
    const result = JSON.parse(await readFile(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory, 'result.json'), 'utf8'));
    expect(result.status).toBe('failed');
    expect(result.artifacts.find((entry: { identity: string }) => entry.identity === 'transcribed_srt')).toMatchObject({ exists: true, validation: 'passed' });
  });

  it('serializes concurrent event appends with continuous sequence and task revision', async () => {
    const input = await prepared();
    input.request.request_id = 'request-event-concurrency';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendV5Event(directory, structuredClone(submitted.task), 'fixture_event', `fixture ${index}`)));
    const events = await readV5Events(directory);
    expect(events.map((event) => event.sequence)).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
    expect(new Set(events.map((event) => event.task_revision)).size).toBe(21);
    expect((await readV5Task(directory)).identity.revision).toBe(events.at(-1)!.task_revision);
  });

  it('keeps v5 tasks on the existing review flow and finalizes an approved SRT without changing time', async () => {
    const input = await prepared();
    input.request.request_id = 'request-v5-review';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    await runWorker(input.workspace, { fetch: fixtureFetch([], [], (text, index) => index === 0 ? text.replace('您好', '你好') : text), readCredential: async () => 'fixture-secret' });
    const taskId = submitted.task.identity.task_id;
    const statusOut: string[] = [];
    const io = { homeDirectory: input.home, stdout: (value: string) => statusOut.push(value), stderr: () => undefined };
    expect(await runCli(['review', 'status', taskId, '--json'], io), statusOut.join('')).toBe(0);
    const status = JSON.parse(statusOut.at(-1)!);
    expect(status.data).toMatchObject({ task_id: taskId, status: 'pending', counts: { pending: 1 } });
    const listOut: string[] = [];
    expect(await runCli(['review', 'list', taskId, '--limit', '10', '--json'], { ...io, stdout: (value) => listOut.push(value) })).toBe(0);
    const change = JSON.parse(listOut[0]!).data.changes[0];
    const before = parseSrt(await readFile(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory, submitted.task.artifacts.transcribed!.path), 'utf8'));
    expect(await runCli(['review', 'decide', taskId, '--change', change.change_id, '--accept', '--json'], { ...io, stdout: () => undefined })).toBe(0);
    const finalized: string[] = [];
    expect(await runCli(['review', 'finalize', taskId, '--json'], { ...io, stdout: (value) => finalized.push(value) })).toBe(0);
    const approvedPath = JSON.parse(finalized[0]!).data.approved_artifact.absolute_path;
    const after = parseSrt(await readFile(approvedPath, 'utf8'));
    expect(after.map(({ start, end }) => ({ start, end }))).toEqual(before.map(({ start, end }) => ({ start, end })));
    expect((await readV5Task(path.dirname(path.dirname(approvedPath)))).review.status).toBe('finalized');
  });

  it('rejects request hash mismatch before creating a task or dispatching a provider', async () => {
    const input = await prepared();
    input.request.inputs.transcript.sha256 = '0'.repeat(64);
    await expect(submitExchangeRequest(input.workspace, input.request)).rejects.toMatchObject({ code: 'INPUT_HASH_MISMATCH' });
    const tasks = await (await import('node:fs/promises')).readdir(path.join(input.workspace, 'tasks'));
    expect(tasks).toHaveLength(0);
  });
});

function parseSrt(source: string): Array<{ start: string; end: string }> {
  return [...source.matchAll(/^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/gmu)].map((match) => ({ start: match[1]!, end: match[2]! }));
}
