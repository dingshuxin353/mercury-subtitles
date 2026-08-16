import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureWorkspace } from '../src/workspace.js';
import { loadModelRegistryV2 } from '../src/models-v2.js';
import { runWorker } from '../src/background/worker.js';
import { appendV5Event, cancelV5Task, persistV5Task, readV5Events, readV5Task, submitExchangeRequest } from '../src/exchange/runtime.js';
import { findTaskReadOnly, stableTaskResult, stableTaskView } from '../src/stable-cli/tasks.js';
import { createDictionary, makeDictionaryEntry, mutateDictionary } from '../src/dictionary.js';
import { runCli } from '../src/cli.js';
import type { AsrAdapter, AsrHintsCapableAdapter } from '../src/contracts/index.js';
import { VolcengineAsrAdapter } from '../src/adapters/volcengine-asr.js';
import { VolcengineSubtitleAsrAdapter } from '../src/adapters/volcengine-subtitle-asr.js';
import { canonicalJson } from '../src/exchange/storage.js';
import { readJob } from '../src/background/storage.js';
import { createChatCalibrationRuntimeV2 } from '../src/adapters/chat-calibration-v2.js';
import { readVerifiedV5Review } from '../src/review-v5.js';

function sha(value: Buffer | string) { return createHash('sha256').update(value).digest('hex'); }

async function directoryManifest(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) output.push(`${relative}:link:${await readlink(absolute)}`);
      else if (entry.isDirectory()) { output.push(`${relative}:directory:${entry.mode & 0o777}`); await visit(absolute); }
      else output.push(`${relative}:file:${entry.mode & 0o777}:${entry.size}:${sha(await readFile(absolute))}`);
    }
  };
  await visit(root);
  return output;
}

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
      const originalDispatch = input.beforeProviderDispatch;
      return base.run({
        ...input,
        beforeProviderDispatch: async (operation) => originalDispatch?.(operation, {
          asrHints: { status: 'used', entryIds: input.asrHints.entries.map((entry) => entry.entryId), inputHash: sha(canonicalJson(input.asrHints.entries)) },
        }),
      });
    },
  };
}

async function forceStrongEvidence(directory: string, useGemini = false) {
  const task = await readV5Task(directory);
  const snapshotPath = path.join(directory, task.models.snapshot_path);
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  snapshot.evidence_mode = 'audio_multimodal';
  snapshot.non_strong_reason = null;
  if (useGemini) {
    snapshot.models.chat.plugin_id = 'gemini';
    snapshot.models.chat.connection_type = 'vertex_ai';
    snapshot.models.chat.endpoint = null;
    snapshot.models.chat.credential_ref = 'adc:fixture';
    snapshot.models.chat.provider_config = { project: 'fixture-project', location: 'us-central1' };
    snapshot.models.chat.declared_capabilities.input_modalities = ['text', 'audio'];
    snapshot.models.chat.verified_capabilities.input_modalities = ['text', 'audio'];
    snapshot.models.chat.cloud_data_confirmation.data_categories = ['audio', 'transcript', 'reference_srt', 'context'];
  }
  const source = canonicalJson(snapshot);
  await writeFile(snapshotPath, source, { mode: 0o600 });
  task.models.snapshot_sha256 = sha(source);
  task.input_config.evidence_mode = 'audio_multimodal';
  await persistV5Task(directory, task);
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
    expect(task.calibration_sources).toMatchObject({
      transcript: { path: 'work/transcript.raw.json', validation: 'passed' },
      reference: { path: 'input/reference.srt', validation: 'passed' },
    });
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

  it('cancels a queued provider task with no transcript as a zero-call terminal result', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'queued-cancel.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: 'request-provider-queued-cancel',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const cancelled = await cancelV5Task(input.workspace, submitted.task);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    expect(cancelled.pending).toBe(false);
    expect(cancelled.task).toMatchObject({ status: 'cancelled', artifacts: { transcript: null, transcribed: null, calibrated: null, approved: null } });
    expect(cancelled.task.execution.provider_calls).toMatchObject({ asr: { state: 'not_started', count: 0 }, chat: { state: 'not_started', count: 0 } });
    expect(await readJob(input.workspace, submitted.task.identity.task_id)).toMatchObject({ state: 'terminal' });
    expect((await readV5Events(directory)).filter((event) => event.type === 'task_cancelled')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ asr_call_count: 0, chat_call_count: 0, transcribed_available: false }) }),
    ]);
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, submitted.task.identity.task_id));
    expect(result).toMatchObject({ status: 'cancelled', next_action: '任务已取消；尚未产生字幕文件。' });
  });

  it('reports an existing verified provided transcript consistently when cancelled while queued', async () => {
    const input = await prepared();
    input.request.request_id = 'request-provided-queued-cancel';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const cancelled = await cancelV5Task(input.workspace, submitted.task);
    expect(cancelled.pending).toBe(false);
    expect(cancelled.task).toMatchObject({
      status: 'cancelled',
      artifacts: { transcribed: { validation: 'passed' }, calibrated: null, approved: null },
      execution: { provider_calls: { asr: { count: 0 }, chat: { count: 0 } } },
    });
    const event = (await readV5Events(directory)).findLast((entry) => entry.type === 'task_cancelled');
    expect(event).toMatchObject({
      message: '任务已取消；纯转写字幕仍可使用。',
      data: { asr_call_count: 0, chat_call_count: 0, transcribed_available: true },
    });
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, submitted.task.identity.task_id));
    expect(result.next_action).toBe('任务已取消；纯转写字幕仍可使用。');
    expect(result.artifacts.find((entry) => entry.identity === 'transcribed_srt')).toMatchObject({ exists: true, validation: 'passed' });
  });

  it('cancels a running provided task before Chat dispatch while preserving the verified transcript', async () => {
    const input = await prepared();
    input.request.request_id = 'request-provided-running-pre-chat-cancel';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    let entered!: () => void; let release!: () => void;
    const atChat = new Promise<void>((resolve) => { entered = resolve; });
    const continueChat = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const chatRuntime = {
      capability: 'calibration' as const,
      async run(runtimeInput: Parameters<ReturnType<typeof createChatCalibrationRuntimeV2>['run']>[0]) {
        entered();
        await continueChat;
        return createChatCalibrationRuntimeV2(runtimeInput.model, {
          fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret',
        }).run(runtimeInput);
      },
    };
    const worker = runWorker(input.workspace, { chatRuntime, readCredential: async () => 'fixture-secret' });
    await atChat;
    expect((await cancelV5Task(input.workspace, await readV5Task(directory))).pending).toBe(true);
    release();
    await worker;
    const task = await readV5Task(directory);
    expect(task).toMatchObject({
      status: 'cancelled',
      artifacts: { transcribed: { validation: 'passed' }, calibrated: null, approved: null },
      execution: { provider_calls: { asr: { count: 0 }, chat: { state: 'not_started', count: 0 } } },
    });
    expect(calls).toEqual([]);
    expect((await readV5Events(directory)).findLast((entry) => entry.type === 'task_cancelled')).toMatchObject({
      data: { asr_call_count: 0, chat_call_count: 0, transcribed_available: true },
    });
    expect((await stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id))).next_action).toBe('任务已取消；纯转写字幕仍可使用。');
  });

  it('cancels a running provider task at the pre-ASR boundary without dispatching ASR or Chat', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'running-cancel.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: 'request-provider-running-cancel',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    let entered!: () => void; let release!: () => void;
    const atAdapter = new Promise<void>((resolve) => { entered = resolve; });
    const continueAdapter = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const blocked: AsrAdapter = {
      adapterId: 'fixture_pre_dispatch_cancel',
      async run(adapterInput) {
        entered();
        await continueAdapter;
        await adapterInput.beforeProviderDispatch?.('volcengine_asr_recognize');
        calls.push('asr');
        return fixtureAsr([]).run(adapterInput);
      },
    };
    const worker = runWorker(input.workspace, { asrAdapter: blocked, fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    await atAdapter;
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const pending = await cancelV5Task(input.workspace, await readV5Task(directory));
    expect(pending.pending).toBe(true);
    release();
    await worker;
    const task = await readV5Task(directory);
    expect(task.status).toBe('cancelled');
    expect(task.execution.provider_calls).toMatchObject({ asr: { state: 'not_started', count: 0 }, chat: { state: 'not_started', count: 0 } });
    expect(task.artifacts.transcribed).toBeNull();
    expect(calls).toEqual([]);
    expect(await readJob(input.workspace, task.identity.task_id)).toMatchObject({ state: 'terminal' });
    expect((await stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id))).next_action).toBe('任务已取消；尚未产生字幕文件。');
  });

  it('keeps supported ASR hints pending when the adapter fails before the dispatch boundary', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'hints-before-dispatch.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const dictionary = await createDictionary(input.workspace, { name: 'Hints Pending', scope: 'global' });
    await mutateDictionary(input.workspace, dictionary.dictionary_id, dictionary.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: 'entry-hints-pending', canonical: 'Mercury', variants: ['水星'], kind: 'product' })));
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: 'request-hints-before-dispatch',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat }, dictionaries: { project_key: null, selected: [dictionary.dictionary_id], task_overrides: [] },
    });
    const adapter: AsrHintsCapableAdapter = {
      adapterId: 'fixture_hints_pre_dispatch_failure', asrHintsCapability: { status: 'supported', maxEntries: 10, acceptedFields: ['canonical', 'variants'] },
      async run() { throw new Error('credential/input construction failed before dispatch'); },
    };
    await runWorker(input.workspace, { asrAdapter: adapter, fetch: fixtureFetch([]), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    const snapshot = JSON.parse(await readFile(path.join(directory, task.dictionary_snapshot.path), 'utf8'));
    expect(task).toMatchObject({ status: 'failed', execution: { provider_calls: { asr: { state: 'not_started', count: 0, outcome: 'not_dispatched' } } } });
    expect(snapshot.asr_hints).toMatchObject({ status: 'pending', adapter_id: adapter.adapterId, input_count: 0, input_hash: null });
  });

  it.each(['known_terminal', 'outcome_unknown'] as const)('commits ASR hints as used only at a real dispatch boundary for %s outcomes', async (certainty) => {
    const input = await prepared();
    const audio = path.join(input.home, `hints-${certainty}.mp3`);
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const dictionary = await createDictionary(input.workspace, { name: `Hints ${certainty}`, scope: 'global' });
    await mutateDictionary(input.workspace, dictionary.dictionary_id, dictionary.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: `entry-hints-${certainty.replace('_', '-')}`, canonical: 'Mercury', variants: ['水星'], kind: 'product' })));
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: `request-hints-${certainty}`,
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat }, dictionaries: { project_key: null, selected: [dictionary.dictionary_id], task_overrides: [] },
    });
    const adapter: AsrHintsCapableAdapter = {
      adapterId: `fixture_hints_${certainty}`, asrHintsCapability: { status: 'supported', maxEntries: 10, acceptedFields: ['canonical', 'variants'] },
      async run(adapterInput) {
        await adapterInput.beforeProviderDispatch?.('volcengine_asr_recognize', { asrHints: { status: 'used', entryIds: adapterInput.asrHints.entries.map((entry) => entry.entryId), inputHash: sha(canonicalJson(adapterInput.asrHints.entries)) } });
        const at = new Date().toISOString();
        const error = { error_id: `error-${certainty}`, code: 'FIXTURE_PROVIDER_FAILURE', message: 'Provider returned fixture failure.', stage: certainty === 'outcome_unknown' ? 'connectivity' as const : 'model_call' as const, retryable: false };
        return { kind: 'failure' as const, failure: { failure_id: `failure-${certainty}`, task_id: adapterInput.taskId, role: 'asr' as const, model_snapshot_ref: adapterInput.modelSnapshotRef, occurred_at: at, provider_outcome_certainty: certainty, errors: [error], warnings: [], call: certainty === 'known_terminal' ? { call_id: `call-${certainty}`, model_snapshot_entry_ref: adapterInput.model.snapshot_entry_id, started_at: at, ended_at: at, provider_request_id: 'fixture-provider-id', outcome: 'failed' as const, error_ref: error.error_id } : null, staging: [] } };
      },
    };
    await runWorker(input.workspace, { asrAdapter: adapter, fetch: fixtureFetch([]), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    const snapshot = JSON.parse(await readFile(path.join(directory, task.dictionary_snapshot.path), 'utf8'));
    expect(task.status).toBe(certainty === 'known_terminal' ? 'failed' : 'interrupted');
    expect(task.execution.provider_calls.asr).toMatchObject({ state: certainty === 'known_terminal' ? 'terminal' : 'in_flight', count: 1, outcome: certainty });
    expect(snapshot.asr_hints).toMatchObject({ status: 'used', adapter_id: adapter.adapterId, input_count: 1 });
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
    expect(task.calibration_sources).toMatchObject({ transcript: { path: 'work/transcript.raw.json', validation: 'passed' }, reference: null });
  });

  it('rejects non-MP3 media at stable request preflight without creating a task or Provider call', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'declared-wav.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    await expect(submitExchangeRequest(input.workspace, {
      ...input.request, request_id: 'request-media-mime-rejected',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/wav' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    })).rejects.toMatchObject({ code: 'CONTRACT_INVALID' });
    expect(await (await import('node:fs/promises')).readdir(path.join(input.workspace, 'tasks'))).toEqual([]);
  });

  it('rejects a tampered provided media copy before strong Chat dispatch', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provided-strong.mp3');
    const bytes = Buffer.alloc(417 * 80);
    for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
    await writeFile(audio, bytes);
    input.request.request_id = 'request-provided-strong-media-tamper';
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      inputs: { ...input.request.inputs, media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' } },
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await forceStrongEvidence(directory);
    const copied = (await readV5Task(directory)).inputs.media!;
    const changed = Buffer.from(await readFile(path.join(directory, copied.workspace_path))); changed[20] = changed[20]! ^ 0xff;
    await writeFile(path.join(directory, copied.workspace_path), changed, { mode: 0o600 });
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(directory);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('INPUT_COPY_HASH_MISMATCH');
    expect(task.execution.provider_calls).toMatchObject({ asr: { count: 0 }, chat: { count: 0, state: 'not_started' } });
    expect(calls).toEqual([]);
  });

  it('rejects provider media changed after ASR and before strong Chat dispatch', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provider-strong.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: 'request-provider-strong-media-tamper',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await forceStrongEvidence(directory);
    const calls: string[] = [];
    const mutatingAsr: AsrAdapter = {
      adapterId: 'fixture_mutating_asr',
      async run(adapterInput) {
        const result = await fixtureAsr(calls).run(adapterInput);
        const changed = Buffer.from(await readFile(adapterInput.audio.sourcePath)); changed[24] = changed[24]! ^ 0xff;
        await writeFile(adapterInput.audio.sourcePath, changed, { mode: 0o600 });
        return result;
      },
    };
    await runWorker(input.workspace, { asrAdapter: mutatingAsr, fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(directory);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('INPUT_COPY_HASH_MISMATCH');
    expect(task.execution.provider_calls).toMatchObject({ asr: { count: 1, state: 'terminal' }, chat: { count: 0, state: 'not_started' } });
    expect(calls).toEqual(['asr']);
  });

  it('builds a strong Gemini request from the same verified media buffer', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provided-strong-pinned.mp3');
    const bytes = Buffer.alloc(417 * 80);
    for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
    await writeFile(audio, bytes);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: 'request-provided-strong-pinned',
      inputs: { ...input.request.inputs, media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' } },
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await forceStrongEvidence(directory, true);
    let sent: Buffer | null = null; let providerCalls = 0;
    const generateContent = vi.fn(async (request: Record<string, any>) => {
      providerCalls += 1;
      const parts = request.contents[0].parts as Array<Record<string, any>>;
      sent = Buffer.from(parts.find((part) => part.inlineData)!.inlineData.data, 'base64');
      const prompt = parts.find((part) => typeof part.text === 'string')!.text as string;
      const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { calibration_units: Array<{ unit_id: string; original_text: string }> };
      return { text: JSON.stringify({ corrected_units: payload.calibration_units.map((unit) => ({ unit_id: unit.unit_id, corrected_text: unit.original_text, rationale: null })) }), responseId: 'fixture-gemini', finishReason: 'STOP' };
    });
    await runWorker(input.workspace, {
      createVertexClient: () => ({ interactions: { create: async () => { throw new Error('unexpected'); } }, models: { generateContent } }),
    });
    const task = await readV5Task(directory);
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(providerCalls).toBe(1);
    expect(sha(sent!)).toBe(task.inputs.media!.sha256);
    expect(sent).toEqual(bytes);
  });

  it.each(['transcript', 'reference'] as const)('rejects a tampered provided calibration %s bridge before Chat dispatch', async (source) => {
    const input = await prepared();
    input.request.request_id = `request-provided-bridge-${source}-tamper`;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const pointer = submitted.task.calibration_sources[source]!;
    await writeFile(path.join(directory, pointer.path), source === 'transcript' ? canonicalJson({ tampered: true }) : '1\n00:00:00,000 --> 00:00:01,000\nTAMPERED\n', { mode: 0o600 });
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(directory);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('CALIBRATION_SOURCE_INVALID');
    expect(task.execution.provider_calls).toMatchObject({ asr: { count: 0 }, chat: { count: 0, state: 'not_started' } });
    expect(calls).toEqual([]);
  });

  it.each([
    ['content', (raw: any) => { raw.full_text = 'TAMPERED TEXT'; raw.segments[0].text = 'TAMPERED TEXT'; }, false],
    ['task', (raw: any) => { raw.task_id = 'tsk-20260816-000000-deadbeef'; }, true],
    ['model', (raw: any) => { raw.model_snapshot_ref = 'tsk-20260816-000000-deadbeef-models'; }, true],
    ['call', (raw: any) => { raw.call.model_snapshot_entry_ref = 'snapshot-entry-wrong'; }, true],
    ['audio', (raw: any) => { raw.audio.sha256 = '0'.repeat(64); }, true],
  ] as const)('rejects %s-tampered persisted ASR evidence without Provider replay', async (_case, mutate, alignPinnedHash) => {
    const input = await prepared();
    const audio = path.join(input.home, `asr-evidence-${_case}.mp3`);
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: `request-asr-evidence-${_case}`,
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const calls: string[] = []; let crashed = false;
    await expect(runWorker(input.workspace, { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' }, {
      v5Fault: async (point, task) => { if (!crashed && point === 'after_response_persisted' && task.execution.provider_calls.asr.state === 'response_persisted') { crashed = true; throw new Error(`crash:asr-evidence-${_case}`); } },
    })).rejects.toThrow(`crash:asr-evidence-${_case}`);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    const evidencePath = path.join(directory, task.execution.provider_calls.asr.evidence_ref!);
    const raw = JSON.parse(await readFile(evidencePath, 'utf8'));
    mutate(raw);
    await writeFile(evidencePath, canonicalJson(raw), { mode: 0o600 });
    if (alignPinnedHash) {
      const alteredTask = JSON.parse(await readFile(path.join(directory, 'task.json'), 'utf8'));
      alteredTask.execution.provider_calls.asr.evidence_sha256 = sha(canonicalJson(raw));
      await writeFile(path.join(directory, 'task.json'), canonicalJson(alteredTask), { mode: 0o600 });
    }
    await runWorker(input.workspace, { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const failed = await readV5Task(directory);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('ASR_ARTIFACT_INVALID');
    expect(calls).toEqual(['asr']);
    expect(await readJob(input.workspace, failed.identity.task_id)).toMatchObject({ state: 'terminal' });
  });

  it.each(['task', 'model', 'call', 'audio'] as const)('settles a fresh ASR artifact with wrong %s identity as known terminal', async (_case) => {
    const input = await prepared();
    const audio = path.join(input.home, `fresh-asr-${_case}.mp3`);
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: `request-fresh-asr-${_case}`,
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const calls: string[] = [];
    const invalidAsr: AsrAdapter = {
      adapterId: `fixture_fresh_asr_${_case}`,
      async run(adapterInput) {
        const result = await fixtureAsr(calls).run(adapterInput);
        if (result.kind !== 'artifact') return result;
        if (_case === 'task') result.artifact.task_id = 'tsk-20260816-000000-deadbeef';
        if (_case === 'model') result.artifact.model_snapshot_ref = 'snapshot-wrong';
        if (_case === 'call') result.artifact.call.model_snapshot_entry_ref = 'entry-wrong';
        if (_case === 'audio') result.artifact.audio.sha256 = '0'.repeat(64);
        return result;
      },
    };
    await runWorker(input.workspace, { asrAdapter: invalidAsr, fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory));
    expect(task.status).toBe('failed');
    expect(task.error).toMatchObject({ code: 'ASR_ARTIFACT_INVALID', provider_outcome: 'known_terminal' });
    expect(task.error?.message).not.toContain('结果无法确认');
    expect(task.execution.provider_calls.asr).toMatchObject({ state: 'terminal', count: 1, outcome: 'known_terminal', evidence_ref: null });
    expect(calls).toEqual(['asr']);
  });

  it.each(['content', 'task', 'model', 'call'] as const)('rejects %s-tampered persisted Chat evidence without Provider replay', async (_case) => {
    const input = await prepared();
    input.request.request_id = `request-chat-evidence-${_case}`;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = []; let crashed = false;
    await expect(runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' }, {
      v5Fault: async (point, task) => { if (!crashed && point === 'after_response_persisted' && task.execution.provider_calls.chat.state === 'response_persisted') { crashed = true; throw new Error(`crash:chat-evidence-${_case}`); } },
    })).rejects.toThrow(`crash:chat-evidence-${_case}`);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    const evidencePath = path.join(directory, task.execution.provider_calls.chat.evidence_ref!);
    const raw = JSON.parse(await readFile(evidencePath, 'utf8'));
    if (_case === 'content') raw.corrected_units[0].corrected_text = 'TAMPERED CHAT TEXT';
    if (_case === 'task') raw.task_id = 'tsk-20260816-000000-deadbeef';
    if (_case === 'model') raw.model_snapshot_ref = 'tsk-20260816-000000-deadbeef-models';
    if (_case === 'call') raw.call.model_snapshot_entry_ref = 'snapshot-entry-wrong';
    await writeFile(evidencePath, canonicalJson(raw), { mode: 0o600 });
    if (_case !== 'content') {
      const alteredTask = JSON.parse(await readFile(path.join(directory, 'task.json'), 'utf8'));
      alteredTask.execution.provider_calls.chat.evidence_sha256 = sha(canonicalJson(raw));
      await writeFile(path.join(directory, 'task.json'), canonicalJson(alteredTask), { mode: 0o600 });
    }
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const failed = await readV5Task(directory);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('CALIBRATION_RESULT_INVALID');
    expect(calls).toEqual(['chat']);
  });

  it.each(['task', 'model', 'call', 'input'] as const)('settles a fresh Chat artifact with wrong %s identity as known terminal', async (_case) => {
    const input = await prepared();
    input.request.request_id = `request-fresh-chat-${_case}`;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    const chatRuntime = {
      capability: 'calibration' as const,
      async run(runtimeInput: Parameters<ReturnType<typeof createChatCalibrationRuntimeV2>['run']>[0]) {
        const base = createChatCalibrationRuntimeV2(runtimeInput.model, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
        const result = await base.run(runtimeInput);
        if (result.kind !== 'artifact') return result;
        if (_case === 'task') result.artifact.task_id = 'tsk-20260816-000000-deadbeef';
        if (_case === 'model') result.artifact.model_snapshot_ref = 'snapshot-wrong';
        if (_case === 'call') result.artifact.call.model_snapshot_entry_ref = 'entry-wrong';
        if (_case === 'input') result.artifact.request.transcript_ref = 'work/transcript.wrong.json' as 'work/transcript.raw.json';
        return result;
      },
    };
    await runWorker(input.workspace, { chatRuntime, readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory));
    expect(task.status).toBe('failed');
    expect(task.error).toMatchObject({ code: 'CALIBRATION_RESULT_INVALID', provider_outcome: 'known_terminal' });
    expect(task.error?.message).not.toContain('结果无法确认');
    expect(task.execution.provider_calls.chat).toMatchObject({ state: 'terminal', count: 1, outcome: 'known_terminal', evidence_ref: null });
    expect(calls).toEqual(['chat']);
  });

  it.each(['content', 'task', 'entry', 'missing', 'symlink'] as const)('makes status, result, and review reject the same %s-invalid pinned model snapshot without writes', async (_case) => {
    const input = await prepared();
    input.request.request_id = `request-model-snapshot-read-${_case}`;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    await runWorker(input.workspace, { fetch: fixtureFetch([]), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    const snapshotPath = path.join(directory, task.models.snapshot_path);
    const original = await readFile(snapshotPath, 'utf8');
    if (_case === 'missing') {
      await rm(snapshotPath);
    } else if (_case === 'symlink') {
      const outside = path.join(input.home, 'outside-model-snapshot.json');
      await writeFile(outside, original, { mode: 0o600 });
      await rm(snapshotPath);
      await symlink(outside, snapshotPath);
    } else {
      const snapshot = JSON.parse(original);
      if (_case === 'content') snapshot.models.chat.name = 'tampered display name';
      if (_case === 'task') snapshot.task_id = 'tsk-20260816-000000-deadbeef';
      if (_case === 'entry') snapshot.models.chat.snapshot_entry_id = 'entry-wrong';
      const serialized = canonicalJson(snapshot);
      await writeFile(snapshotPath, serialized, { mode: 0o600 });
      if (_case !== 'content') {
        task.models.snapshot_sha256 = sha(serialized);
        await persistV5Task(directory, task);
      }
    }
    const before = await directoryManifest(directory);
    const found = await findTaskReadOnly(input.workspace, task.identity.task_id);
    await expect(stableTaskView(input.workspace, found)).rejects.toMatchObject({ code: 'MODEL_SNAPSHOT_INVALID' });
    await expect(stableTaskResult(input.workspace, found)).rejects.toMatchObject({ code: 'MODEL_SNAPSHOT_INVALID' });
    await expect(readVerifiedV5Review(directory)).rejects.toMatchObject({ code: 'MODEL_SNAPSHOT_INVALID' });
    expect(await directoryManifest(directory)).toEqual(before);
  });

  it.each(['asr_invalid', 'asr_known_failure', 'chat_invalid', 'chat_known_failure'] as const)('commits %s as known terminal before recoverable result/report derivation', async (_case) => {
    const input = await prepared();
    const calls: string[] = [];
    let dependencies: Parameters<typeof runWorker>[1];
    let request: any = { ...input.request };
    if (_case.startsWith('asr')) {
      const audio = path.join(input.home, `${_case}.mp3`);
      const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
      const registry = await loadModelRegistryV2(input.workspace);
      request = {
        ...input.request, request_id: `request-terminal-first-${_case}`,
        inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
        transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
      };
      const asrAdapter: AsrAdapter = _case === 'asr_invalid' ? {
        adapterId: 'fixture_terminal_first_invalid_asr',
        async run(adapterInput) {
          const returned = await fixtureAsr(calls).run(adapterInput);
          if (returned.kind === 'artifact') returned.artifact.task_id = 'tsk-20260816-000000-deadbeef';
          return returned;
        },
      } : {
        adapterId: 'fixture_terminal_first_known_asr',
        async run(adapterInput) {
          await adapterInput.beforeProviderDispatch?.('volcengine_asr_recognize');
          calls.push('asr');
          const at = new Date().toISOString();
          const error = { error_id: 'error-known-asr', code: 'FIXTURE_KNOWN_ASR', message: 'Known ASR response.', stage: 'model_call' as const, retryable: false };
          return { kind: 'failure', failure: { failure_id: 'failure-known-asr', task_id: adapterInput.taskId, role: 'asr', model_snapshot_ref: adapterInput.modelSnapshotRef, occurred_at: at, provider_outcome_certainty: 'known_terminal', errors: [error], warnings: [], call: { call_id: 'call-known-asr', model_snapshot_entry_ref: adapterInput.model.snapshot_entry_id, started_at: at, ended_at: at, provider_request_id: 'provider-known-asr', outcome: 'failed', error_ref: error.error_id }, staging: [] } };
        },
      };
      dependencies = { asrAdapter, fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' };
    } else {
      request.request_id = `request-terminal-first-${_case}`;
      const chatRuntime = _case === 'chat_invalid' ? {
        capability: 'calibration' as const,
        async run(runtimeInput: Parameters<ReturnType<typeof createChatCalibrationRuntimeV2>['run']>[0]) {
          const returned = await createChatCalibrationRuntimeV2(runtimeInput.model, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' }).run(runtimeInput);
          if (returned.kind === 'artifact') returned.artifact.task_id = 'tsk-20260816-000000-deadbeef';
          return returned;
        },
      } : {
        capability: 'calibration' as const,
        async run(runtimeInput: Parameters<ReturnType<typeof createChatCalibrationRuntimeV2>['run']>[0]) {
          await runtimeInput.beforeProviderDispatch?.('openai_chat_calibration');
          calls.push('chat');
          const at = new Date().toISOString();
          const error = { error_id: 'error-known-chat', code: 'FIXTURE_KNOWN_CHAT', message: 'Known Chat response.', stage: 'model_call' as const, retryable: false };
          return { kind: 'failure' as const, failure: { failure_id: 'failure-known-chat', task_id: runtimeInput.taskId, role: 'calibration' as const, model_snapshot_ref: runtimeInput.modelSnapshotRef, occurred_at: at, provider_outcome_certainty: 'known_terminal' as const, errors: [error] as [typeof error], warnings: [], call: { call_id: 'call-known-chat', model_snapshot_entry_ref: runtimeInput.model.snapshot_entry_id, started_at: at, ended_at: at, provider_request_id: 'provider-known-chat', outcome: 'failed' as const, error_ref: error.error_id }, staging: [] as [] } };
        },
      };
      dependencies = { chatRuntime, readCredential: async () => 'fixture-secret' };
    }
    const submitted = await submitExchangeRequest(input.workspace, request);
    let crashed = false;
    await expect(runWorker(input.workspace, dependencies, {
      v5Fault: async (point, task) => {
        if (!crashed && point === 'terminal_task_before_result' && task.error?.provider_outcome === 'known_terminal') {
          crashed = true;
          throw new Error(`crash:terminal-first-${_case}`);
        }
      },
    })).rejects.toThrow(`crash:terminal-first-${_case}`);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const durable = await readV5Task(directory);
    const role = _case.startsWith('asr') ? 'asr' : 'chat';
    expect(durable).toMatchObject({ status: 'failed', error: { provider_outcome: 'known_terminal' } });
    expect(durable.execution.provider_calls[role]).toMatchObject({ state: 'terminal', count: 1, outcome: 'known_terminal' });
    const callsBeforeRecovery = [...calls];
    await runWorker(input.workspace, dependencies);
    expect(calls).toEqual(callsBeforeRecovery);
    const recovered = await readV5Task(directory);
    expect(recovered).toMatchObject({ status: 'failed', error: { provider_outcome: 'known_terminal' } });
    expect(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'))).toMatchObject({ status: 'failed', error: { provider_outcome: 'known_terminal' } });
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
    expect(first.task.calibration_sources).toMatchObject({
      transcript: { path: 'work/transcript.raw.json', validation: 'passed' },
      reference: { path: 'input/reference.srt', validation: 'passed' },
    });
    for (const relative of ['request.json', 'task.json', 'events.jsonl', 'attempts.jsonl', 'input/transcript-source.srt', 'input/reference.srt', 'work/transcript.normalized.json', 'work/transcript.raw.json', first.task.artifacts.transcribed!.path]) {
      if (relative === 'attempts.jsonl') continue;
      expect((await stat(path.join(directory, relative))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path.join(directory, 'input/transcript-source.srt'), 'utf8')).toBe(await readFile(input.source, 'utf8'));
    expect(first.task.execution.provider_calls.asr).toEqual({ state: 'not_started', count: 0, outcome: 'not_dispatched', evidence_ref: null, evidence_sha256: null });

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
    const bridgeBefore = {
      transcript: sha(await readFile(path.join(directory, completed.calibration_sources.transcript!.path))),
      reference: sha(await readFile(path.join(directory, completed.calibration_sources.reference!.path))),
    };
    const view = await stableTaskView(input.workspace, found);
    const result = await stableTaskResult(input.workspace, found);
    const response = JSON.parse(await readFile(path.join(directory, 'work/calibration-response.json'), 'utf8'));
    const calibratedTranscript = JSON.parse(await readFile(path.join(directory, 'work/transcript.calibrated.json'), 'utf8'));
    expect(response.request).toMatchObject({ transcript_ref: 'work/transcript.raw.json', reference_srt_ref: 'input/reference.srt' });
    expect(calibratedTranscript.source_refs).toMatchObject({ transcript_ref: 'work/transcript.raw.json', reference_srt_ref: 'input/reference.srt' });
    expect(sha(await readFile(path.join(directory, completed.calibration_sources.transcript!.path)))).toBe(completed.calibration_sources.transcript!.sha256);
    expect(sha(await readFile(path.join(directory, completed.calibration_sources.reference!.path)))).toBe(completed.calibration_sources.reference!.sha256);
    expect(view.source_schema_version).toBe('5.0.0');
    expect(view.capabilities.provided_transcript.supported).toBe(true);
    expect(result.transcription).toMatchObject({ mode: 'provided', asr_call_count: 0 });
    expect(result.dictionaries).toMatchObject({ match_count: 1, conflict_count: 0, snapshots: [expect.objectContaining({ revision: dictionaryV2.revision })] });
    expect(result.artifacts.find((entry) => entry.identity === 'transcribed_srt')).toMatchObject({ exists: true, validation: 'passed' });
    expect(result.artifacts.find((entry) => entry.identity === 'calibrated_srt')).toMatchObject({ exists: true, validation: 'passed' });
    expect({
      transcript: sha(await readFile(path.join(directory, completed.calibration_sources.transcript!.path))),
      reference: sha(await readFile(path.join(directory, completed.calibration_sources.reference!.path))),
    }).toEqual(bridgeBefore);
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

  it('rejects a tampered normalized provider reference before ASR or Chat dispatch', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'reference-tamper.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const reference = path.join(input.home, 'reference-tamper.srt');
    const referenceText = '1\n00:00:00,000 --> 00:00:00,040\nORIGINAL REFERENCE\n';
    await writeFile(reference, referenceText);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: 'request-reference-normalized-tamper',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: { path: reference, sha256: sha(referenceText), format: 'srt', role: 'reference' } },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    expect(submitted.task.inputs.reference_normalized).toMatchObject({ path: 'input/reference.srt', validation: 'passed' });
    await writeFile(path.join(directory, submitted.task.inputs.reference_normalized!.path), '1\n00:00:00,000 --> 00:00:00,040\nTAMPERED REFERENCE\n', { mode: 0o600 });
    const calls: string[] = [];
    await runWorker(input.workspace, { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(directory);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('REFERENCE_INPUT_INVALID');
    expect(task.execution.provider_calls).toMatchObject({ asr: { count: 0 }, chat: { count: 0 } });
    expect(calls).toEqual([]);
  });

  it.each([
    ['after_hints_snapshot_written', 1],
    ['after_dictionary_matches_snapshot_written', 1],
  ] as const)('recovers the provider dictionary %s commit window with one ASR dispatch', async (point, expectedAsrCalls) => {
    const input = await prepared();
    const audio = path.join(input.home, `dictionary-window-${point}.mp3`);
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const dictionary = await createDictionary(input.workspace, { name: `Dictionary ${point}`, scope: 'global' });
    await mutateDictionary(input.workspace, dictionary.dictionary_id, dictionary.revision, (current) => current.entries.push(makeDictionaryEntry({ entry_id: `entry-${point.replaceAll('_', '-')}`, canonical: 'Mercury', variants: ['水星'], kind: 'product' })));
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: `request-dictionary-window-${point}`,
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat }, dictionaries: { project_key: null, selected: [dictionary.dictionary_id], task_overrides: [] },
    });
    const calls: string[] = []; const hints: Array<NonNullable<Parameters<AsrAdapter['run']>[0]['asrHints']>> = []; let injected = false;
    await expect(runWorker(input.workspace, { asrAdapter: fixtureHintsAsr(calls, hints), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' }, {
      v5Fault: async (current) => { if (!injected && current === point) { injected = true; throw new Error(`crash:${point}`); } },
    })).rejects.toThrow(`crash:${point}`);
    await runWorker(input.workspace, { asrAdapter: fixtureHintsAsr(calls, hints), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(calls.filter((entry) => entry === 'asr')).toHaveLength(expectedAsrCalls);
    expect(calls.filter((entry) => entry === 'chat')).toHaveLength(1);
    expect(sha(await readFile(path.join(directory, task.dictionary_snapshot.path)))).toBe(task.dictionary_snapshot.sha256);
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    expect(result.dictionaries.snapshots).toEqual(task.dictionary_snapshot.resolved);
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
    dispatched.execution.provider_calls.chat = { state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null, evidence_sha256: null };
    await persistV5Task(directory, dispatched);
    stale.execution.heartbeat_at = '2026-08-16T15:00:02.000Z'; stale.updated_at = stale.execution.heartbeat_at;
    await persistV5Task(directory, stale);
    await appendV5Event(directory, structuredClone(stale), 'heartbeat_fixture', '旧事件快照不覆盖 dispatch。');
    expect((await readV5Task(directory)).execution.provider_calls.chat).toEqual({ state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null, evidence_sha256: null });
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
