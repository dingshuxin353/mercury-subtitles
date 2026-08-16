import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureWorkspace } from '../src/workspace.js';
import { loadModelRegistryV2 } from '../src/models-v2.js';
import { runWorker } from '../src/background/worker.js';
import { appendV5Event, persistV5Task, readV5Events, readV5Task, submitExchangeRequest } from '../src/exchange/runtime.js';
import { findTaskReadOnly, stableTaskResult, stableTaskView } from '../src/stable-cli/tasks.js';
import { createDictionary, makeDictionaryEntry, mutateDictionary } from '../src/dictionary.js';
import { runCli } from '../src/cli.js';
import type { AsrAdapter, AsrHintsCapableAdapter } from '../src/contracts/index.js';
import { VolcengineAsrAdapter } from '../src/adapters/volcengine-asr.js';
import { VolcengineSubtitleAsrAdapter } from '../src/adapters/volcengine-subtitle-asr.js';

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

function fixtureAsr(calls: string[]): AsrAdapter {
  return {
    adapterId: 'volcengine_asr',
    async run(input) {
      await input.beforeProviderDispatch?.('volcengine_asr_recognize');
      calls.push('asr');
      const at = new Date().toISOString();
      return {
        kind: 'artifact',
        artifact: {
          schema_version: '1.0.0', task_id: input.taskId, created_at: at,
          audio: { path_ref: input.audio.pathRef, sha256: input.audio.sha256, duration_ms: input.audio.durationMs, language: 'zh-CN', mime_type: 'audio/mpeg' },
          full_text: '您好 Mercury 字幕测试',
          segments: [{ segment_id: 'seg-provider-1', index: 0, start_ms: 0, end_ms: input.audio.durationMs, text: '您好 Mercury 字幕测试', confidence: 0.99, words: [] }],
          model_snapshot_ref: input.modelSnapshotRef,
          call: { call_id: 'fixture-asr', model_snapshot_entry_ref: input.model.snapshot_entry_id, started_at: at, ended_at: at, outcome: 'completed', error_ref: null },
          raw_response_ref: null, warnings: [], errors: [],
        },
      };
    },
  };
}

function fixtureHintsAsr(calls: string[], captured: Array<NonNullable<Parameters<AsrAdapter['run']>[0]['asrHints']>>): AsrHintsCapableAdapter {
  const base = fixtureAsr(calls);
  return {
    ...base,
    adapterId: 'fixture_contract_asr',
    asrHintsCapability: { status: 'supported', maxEntries: 10, acceptedFields: ['canonical', 'variants'] },
    async run(input) {
      captured.push(structuredClone(input.asrHints));
      return base.run(input);
    },
  };
}

describe('Exchange v1 external transcript task', () => {
  it('runs provider plus reference through the same v5 request, dictionary, result, and review semantics', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provider.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const reference = path.join(input.home, 'reference.srt');
    const referenceText = '1\n00:00:00,000 --> 00:00:00,040\n您好 Mercury 字幕测试\n';
    await writeFile(reference, referenceText);
    const dictionary = await createDictionary(input.workspace, { name: 'Provider Terms', scope: 'global' });
    await mutateDictionary(input.workspace, dictionary.dictionary_id, dictionary.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: 'entry-provider-mercury', canonical: 'Mercury', variants: ['水星'], kind: 'product' })));
    const registry = await loadModelRegistryV2(input.workspace);
    const request = {
      ...input.request,
      request_id: 'request-provider-reference-v5',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: { path: reference, sha256: sha(referenceText), format: 'srt', role: 'reference' } },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat }, dictionaries: { project_key: null, selected: [dictionary.dictionary_id], task_overrides: [] },
    };
    const submitted = await submitExchangeRequest(input.workspace, request);
    expect(submitted.task.schema_version).toBe('5.0.0');
    expect(submitted.task.inputs.reference?.role).toBe('reference');
    expect(submitted.task.artifacts.transcript).toBeNull();
    const changed = structuredClone(request); changed.dictionaries.selected = [];
    await expect(submitExchangeRequest(input.workspace, changed)).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    const calls: string[] = []; const capturedHints: Array<NonNullable<Parameters<AsrAdapter['run']>[0]['asrHints']>> = [];
    await runWorker(input.workspace, { asrAdapter: fixtureHintsAsr(calls, capturedHints), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.input_config.transcription_mode).toBe('provider');
    expect(task.execution.provider_calls.asr).toMatchObject({ state: 'terminal', count: 1, outcome: 'response_persisted' });
    expect(task.execution.provider_calls.chat).toMatchObject({ state: 'terminal', count: 1, outcome: 'response_persisted' });
    expect(calls).toEqual(['asr', 'chat']);
    expect(capturedHints).toEqual([{ entries: [expect.objectContaining({ entryId: 'entry-provider-mercury', canonical: 'Mercury', variants: ['水星'] })] }]);
    const frozenDictionary = JSON.parse(await readFile(path.join(directory, task.dictionary_snapshot.path), 'utf8'));
    expect(frozenDictionary.asr_hints).toMatchObject({ status: 'used', adapter_id: 'fixture_contract_asr', entry_ids: ['entry-provider-mercury'], available_count: 1, input_count: 1, truncated: false });
    expect(frozenDictionary.asr_hints.input_hash).toMatch(/^[a-f0-9]{64}$/u);
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    expect(result.transcription).toMatchObject({ mode: 'provider', asr_call_count: 1 });
    expect(result.dictionaries).toMatchObject({ match_count: 1, snapshots: [expect.objectContaining({ dictionary_id: dictionary.dictionary_id })] });
    const attempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(attempts[0]).toMatchObject({ contract: 'mercury.attempt/v1', transcription_mode: 'provider', asr_call_count: 0 });
    expect(attempts[1]).toMatchObject({ contract: 'mercury.attempt-result/v1', asr_call_count: 1, chat_call_count: 1 });
    expect(task.review.status).toMatch(/pending|finalized|not_required/u);
  });

  it('declares both built-in Volcengine ASR adapters as not supporting per-task dynamic hints', () => {
    expect(new VolcengineAsrAdapter({ resolveCredential: async () => ({ mode: 'api_key', uid: 'fixture', value: 'fixture' }) }).asrHintsCapability.status).toBe('not_supported');
    expect(new VolcengineSubtitleAsrAdapter({ readCredential: async () => 'fixture' }).asrHintsCapability.status).toBe('not_supported');
  });

  it('recovers locally after a provider ASR response is persisted without dispatching ASR twice', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provider-recovery.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const request = {
      ...input.request, request_id: 'request-provider-asr-recovery',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    };
    const submitted = await submitExchangeRequest(input.workspace, request);
    const calls: string[] = []; let crashed = false;
    await expect(runWorker(
      input.workspace,
      { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      { v5Fault: async (point, task) => { if (!crashed && point === 'after_response_persisted' && task.execution.provider_calls.asr.state === 'response_persisted') { crashed = true; throw new Error('crash:after_asr_response_persisted'); } } },
    )).rejects.toThrow('crash:after_asr_response_persisted');
    await runWorker(input.workspace, { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory));
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(calls).toEqual(['asr', 'chat']);
    expect(task.execution.provider_calls.asr).toMatchObject({ state: 'terminal', count: 1, outcome: 'response_persisted' });
  });

  it('keeps a thrown post-dispatch ASR outcome interrupted and never automatically replays it', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provider-unknown.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const request = {
      ...input.request, request_id: 'request-provider-unknown',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    };
    const submitted = await submitExchangeRequest(input.workspace, request);
    const dispatches: string[] = [];
    const unknownAsr: AsrAdapter = {
      adapterId: 'fixture_unknown_asr',
      async run(adapterInput) {
        await adapterInput.beforeProviderDispatch?.('volcengine_asr_recognize');
        dispatches.push(adapterInput.taskId);
        throw new Error(`socket closed after dispatch; ${'Author'}ization: ${'Bear'}er ${'x'.repeat(40)}`);
      },
    };
    await runWorker(input.workspace, { asrAdapter: unknownAsr, fetch: fixtureFetch([]), readCredential: async () => 'fixture-secret' });
    await runWorker(input.workspace, { asrAdapter: fixtureAsr(dispatches), fetch: fixtureFetch([]), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory));
    expect(task.status).toBe('interrupted');
    expect(task.execution.provider_calls.asr).toMatchObject({ state: 'in_flight', count: 1, outcome: 'outcome_unknown' });
    expect(task.error).toMatchObject({ code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', retryability: 'unsafe' });
    expect(JSON.stringify(task.error)).not.toContain('Bearer');
    expect([null, '<redacted sensitive detail>']).toContain(task.error?.technical?.detail ?? null);
    expect(dispatches).toHaveLength(1);
  });

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

  it('does not treat a corrupted committed request as absent or overwrite it during replay', async () => {
    const input = await prepared();
    input.request.request_id = 'request-corrupt-replay';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const requestPath = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory, 'request.json');
    const corrupted = { ...input.request, request_id: 'request-different-but-valid' };
    await writeFile(requestPath, `${JSON.stringify(corrupted, null, 2)}\n`, { mode: 0o600 });
    const before = await readFile(requestPath, 'utf8');
    await expect(submitExchangeRequest(input.workspace, input.request)).rejects.toMatchObject({ code: 'REQUEST_RECORD_INVALID' });
    expect(await readFile(requestPath, 'utf8')).toBe(before);
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

  it('does not let stale heartbeat or event snapshots roll back a dispatched Provider checkpoint', async () => {
    const input = await prepared();
    input.request.request_id = 'request-provider-checkpoint-monotonic';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const running = await readV5Task(directory);
    const started = '2026-08-16T15:00:01.000Z';
    running.status = 'running'; running.stage = 'calibrating'; running.execution.started_at = started;
    running.execution.worker_id = 'worker-fixture'; running.execution.heartbeat_at = started;
    running.execution.attempt_id = 'att-fixture'; running.execution.attempt_count = 1;
    running.execution.safe_checkpoint = 'chat_not_started';
    await persistV5Task(directory, running);
    const stale = structuredClone(await readV5Task(directory));
    const dispatched = structuredClone(stale);
    dispatched.execution.provider_calls.chat = { state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null };
    await persistV5Task(directory, dispatched);
    stale.execution.heartbeat_at = '2026-08-16T15:00:02.000Z'; stale.updated_at = stale.execution.heartbeat_at;
    await persistV5Task(directory, stale);
    await appendV5Event(directory, structuredClone(stale), 'heartbeat_fixture', '旧事件快照不覆盖 dispatch。');
    expect((await readV5Task(directory)).execution.provider_calls.chat).toEqual({ state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null });
  });

  it('rejects a stale writer that tries to replace one terminal state with another', async () => {
    const input = await prepared();
    input.request.request_id = 'request-terminal-immutable';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const stale = await readV5Task(directory);
    const failed = structuredClone(stale);
    failed.status = 'failed'; failed.stage = null; failed.execution.ended_at = '2026-08-16T15:00:01.000Z';
    failed.error = {
      contract: 'mercury.error/v1', code: 'FIXTURE_FAILED', category: 'runtime', message: 'fixture failure',
      retryability: 'not_applicable', provider_outcome: 'not_dispatched', remediation: ['检查 fixture。'], technical: null, extensions: {},
    };
    await persistV5Task(directory, failed);
    stale.status = 'cancelled'; stale.stage = null; stale.execution.ended_at = '2026-08-16T15:00:02.000Z';
    await persistV5Task(directory, stale);
    expect((await readV5Task(directory)).status).toBe('failed');
  });

  it.each([
    ['after_claim', 1],
    ['after_response_persisted', 1],
    ['terminal_task_before_result', 1],
    ['after_execute', 1],
    ['after_review', 1],
    ['before_finish', 1],
  ] as const)('recovers the v5 %s crash window locally without repeating Chat', async (point, expectedCalls) => {
    const input = await prepared();
    input.request.request_id = `request-v5-crash-${point}`;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    let injected = false;
    await expect(runWorker(
      input.workspace,
      { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      { v5Fault: async (current) => { if (!injected && current === point) { injected = true; throw new Error(`crash:${point}`); } } },
    )).rejects.toThrow(`crash:${point}`);
    expect(await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' })).toBe('acquired');
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    expect(task.status, JSON.stringify(task)).toBe('completed');
    expect(calls).toHaveLength(expectedCalls);
    const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    expect(result.status).toBe('completed');
    expect((await readV5Events(directory)).some((event) => event.type === 'task_completed')).toBe(true);
    const attempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(attempts.filter((entry) => entry.contract === 'mercury.attempt-result/v1')).toHaveLength(1);
  });

  it('contains a crash after durable dispatch as Provider-unknown and never replays it', async () => {
    const input = await prepared();
    input.request.request_id = 'request-v5-crash-after-dispatch';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    await expect(runWorker(
      input.workspace,
      { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      { v5Fault: async (point) => { if (point === 'after_dispatch_persisted') throw new Error('crash:after_dispatch_persisted'); } },
    )).rejects.toThrow('crash:after_dispatch_persisted');
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    expect(task.status).toBe('interrupted');
    expect(task.execution.provider_calls.chat).toMatchObject({ state: 'in_flight', count: 1, outcome: 'outcome_unknown' });
    expect(task.error?.code).toBe('TASK_INTERRUPTED_PROVIDER_UNKNOWN');
    expect(calls).toHaveLength(0);
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
