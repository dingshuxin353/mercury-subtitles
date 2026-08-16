import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureWorkspace } from '../src/workspace.js';
import { loadModelRegistryV2 } from '../src/models-v2.js';
import { runWorker } from '../src/background/worker.js';
import { readV5Task, submitExchangeRequest } from '../src/exchange/runtime.js';
import { findTaskReadOnly, stableTaskResult, stableTaskView } from '../src/stable-cli/tasks.js';

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
    models: { asr: null, chat: registry.defaults.chat }, dictionaries: { project_key: null, selected: [], task_overrides: [] },
    output: { formats: ['srt', 'report'], workspace_policy: 'managed' }, extensions: {},
  };
  return { home, workspace, source, request };
}

function fixtureFetch(calls: string[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push('chat');
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const prompt = request.messages.find((message) => message.role === 'user')!.content;
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { calibration_units: Array<{ unit_id: string; original_text: string }> };
    const content = JSON.stringify({ corrected_units: payload.calibration_units.map((unit) => ({ unit_id: unit.unit_id, corrected_text: unit.original_text, rationale: null })) });
    return new Response(`data: ${JSON.stringify({ id: 'fixture-chat', choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture-chat', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
}

describe('Exchange v1 external transcript task', () => {
  it('persists the stable task directory, replays idempotently, and completes with zero ASR', async () => {
    const input = await prepared();
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

    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const completed = await readV5Task(directory);
    expect(completed.status, JSON.stringify(completed.error)).toBe('completed');
    expect(completed.execution.provider_calls.asr.count).toBe(0);
    expect(completed.execution.provider_calls.chat.count).toBe(1);
    expect(calls).toEqual(['chat']);
    const found = await findTaskReadOnly(input.workspace, completed.identity.task_id);
    const view = await stableTaskView(input.workspace, found);
    const result = await stableTaskResult(input.workspace, found);
    expect(view.source_schema_version).toBe('5.0.0');
    expect(view.capabilities.provided_transcript.supported).toBe(true);
    expect(result.transcription).toMatchObject({ mode: 'provided', asr_call_count: 0 });
    expect(result.artifacts.find((entry) => entry.identity === 'transcribed_srt')).toMatchObject({ exists: true, validation: 'passed' });
    expect(result.artifacts.find((entry) => entry.identity === 'calibrated_srt')).toMatchObject({ exists: true, validation: 'passed' });
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
  });

  it('rejects request hash mismatch before creating a task or dispatching a provider', async () => {
    const input = await prepared();
    input.request.inputs.transcript.sha256 = '0'.repeat(64);
    await expect(submitExchangeRequest(input.workspace, input.request)).rejects.toMatchObject({ code: 'INPUT_HASH_MISMATCH' });
    const tasks = await (await import('node:fs/promises')).readdir(path.join(input.workspace, 'tasks'));
    expect(tasks).toHaveLength(0);
  });
});
