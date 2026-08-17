import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureWorkspace } from '../src/workspace.js';
import { loadModelRegistryV2 } from '../src/models-v2.js';
import { runWorker } from '../src/background/worker.js';
import { appendV5Event, auditV5Job, cancelV5Task, claimV5Job, executeV5Retry, pauseV5Task, persistV5Task, planV5Retry, readV5Events, readV5Task, resumeV5Task, submitExchangeRequest } from '../src/exchange/runtime.js';
import { assertStableReviewReady, findTaskReadOnly, stablePauseTask, stableTaskResult, stableTaskView } from '../src/stable-cli/tasks.js';
import { createDictionary, makeDictionaryEntry, mutateDictionary } from '../src/dictionary.js';
import { runCli } from '../src/cli.js';
import type { AsrAdapter, AsrHintsCapableAdapter, ExchangeRequestV1 } from '../src/contracts/index.js';
import { VolcengineAsrAdapter } from '../src/adapters/volcengine-asr.js';
import { VolcengineSubtitleAsrAdapter } from '../src/adapters/volcengine-subtitle-asr.js';
import { canonicalJson } from '../src/exchange/storage.js';
import { readJob } from '../src/background/storage.js';
import { createChatCalibrationRuntimeV2, type ChatCalibrationRuntimeV2 } from '../src/adapters/chat-calibration-v2.js';
import { decideV5ReviewChange, finalizeV5Review, readVerifiedV5Review } from '../src/review-v5.js';
import { inspectTranscriptInput } from '../src/external-input.js';
import { validateContract } from '../src/contracts/index.js';
import { deliverApprovedSrt, SimulatedDeliveryCrash } from '../src/delivery.js';

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
  const request: ExchangeRequestV1 = {
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

function knownFailureChat(calls: string[]): ChatCalibrationRuntimeV2 {
  return {
    capability: 'calibration',
    async run(runtimeInput) {
      await runtimeInput.beforeProviderDispatch?.('openai_chat_calibration');
      calls.push('chat');
      const at = new Date().toISOString();
      const error = { error_id: 'error-known-chat', code: 'FIXTURE_KNOWN_CHAT', message: 'Known Chat response.', stage: 'model_call' as const, retryable: false };
      return { kind: 'failure', failure: { failure_id: 'failure-known-chat', task_id: runtimeInput.taskId, role: 'calibration', model_snapshot_ref: runtimeInput.modelSnapshotRef, occurred_at: at, provider_outcome_certainty: 'known_terminal', errors: [error], warnings: [], call: { call_id: 'call-known-chat', model_snapshot_entry_ref: runtimeInput.model.snapshot_entry_id, started_at: at, ended_at: at, provider_request_id: 'provider-known-chat', outcome: 'failed', error_ref: error.error_id }, staging: [] } };
    },
  };
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
  it('sends equivalent SRT and transcript JSON units through the same Gemini request shape', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'same-shape.mp3');
    const bytes = Buffer.alloc(417 * 80);
    for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
    await writeFile(audio, bytes);
    const inspected = await inspectTranscriptInput({ filePath: input.source, format: 'srt', role: 'transcript_source' });
    const jsonSource = path.join(input.home, 'same-shape.transcript.json');
    const jsonText = `${JSON.stringify(inspected.transcript, null, 2)}\n`;
    await writeFile(jsonSource, jsonText);
    const commonMedia = { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' as const };
    const srtSubmitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-same-shape-srt',
      inputs: { media: commonMedia, transcript: input.request.inputs.transcript },
    });
    const jsonSubmitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-same-shape-json',
      inputs: {
        media: commonMedia,
        transcript: { path: jsonSource, sha256: sha(jsonText), format: 'transcript_json', role: 'transcript_source' },
      },
    });
    const srtDirectory = path.join(input.workspace, 'tasks', srtSubmitted.task.identity.task_directory);
    const jsonDirectory = path.join(input.workspace, 'tasks', jsonSubmitted.task.identity.task_directory);
    await forceStrongEvidence(srtDirectory, true);
    await forceStrongEvidence(jsonDirectory, true);
    const requests: any[] = [];
    let providerCalls = 0;
    await runWorker(input.workspace, {
      captureRequest: (request) => { requests.push(request); },
      createVertexClient: () => ({
        interactions: { create: async () => { throw new Error('unexpected'); } },
        models: {
          generateContent: async (request: any) => {
            providerCalls += 1;
            const prompt = request.contents[0].parts[0].text;
            const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
            return {
              responseId: `same-shape-${providerCalls}`,
              finishReason: 'STOP',
              text: JSON.stringify({
                corrected_units: payload.calibration_units.map((unit: any) => ({
                  unit_id: unit.unit_id,
                  corrected_text: unit.original_text,
                  rationale: null,
                })),
              }),
            };
          },
        },
      }),
    });

    expect(providerCalls).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[0].model).toBe(requests[1].model);
    expect(requests[0].contents).toEqual(requests[1].contents);
    expect(requests[0].config).toEqual(requests[1].config);
    for (const directory of [srtDirectory, jsonDirectory]) {
      const task = await readV5Task(directory);
      expect(task.status, JSON.stringify(task.error)).toBe('completed');
      expect(task.execution.provider_calls).toMatchObject({
        asr: { count: 0, outcome: 'not_dispatched' },
        chat: { count: 1, outcome: 'response_persisted' },
      });
      const response = JSON.parse(await readFile(path.join(directory, 'work/calibration-response.json'), 'utf8'));
      expect(response.strategy.output_budget_tokens).toBe(12_288);
    }
  });

  it.each(['srt', 'vtt', 'transcript_json'] as const)('normalizes multiline %s cues only in the frozen v1 bridge and completes with zero ASR', async (format) => {
    const input = await prepared();
    const source = path.join(input.home, `multiline.${format === 'transcript_json' ? 'json' : format}`);
    const multilineText = '第一行，内容\n第二行内容！';
    const visibleMultilineText = '第一行内容\n第二行内容';
    let sourceText: string;
    if (format === 'srt') {
      sourceText = `1\n00:00:00,000 --> 00:00:01,000\n${multilineText}\n`;
    } else if (format === 'vtt') {
      sourceText = `WEBVTT\n\n1\n00:00.000 --> 00:01.000\n${multilineText}\n`;
    } else {
      const inspected = await inspectTranscriptInput({ filePath: input.source, format: 'srt', role: 'transcript_source' });
      inspected.transcript.segments[0]!.text = multilineText;
      inspected.transcript.text = inspected.transcript.segments.map((segment) => segment.text).join('\n');
      sourceText = `${JSON.stringify(inspected.transcript, null, 2)}\n`;
    }
    await writeFile(source, sourceText);
    input.request.request_id = `request-multiline-${format}`;
    input.request.inputs.transcript = { path: source, sha256: sha(sourceText), format, role: 'transcript_source' };

    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    const normalized = JSON.parse(await readFile(path.join(directory, 'work/transcript.normalized.json'), 'utf8'));
    const bridge = JSON.parse(await readFile(path.join(directory, 'work/transcript.raw.json'), 'utf8'));
    const transcribed = await readFile(path.join(directory, task.artifacts.transcribed!.path), 'utf8');

    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.execution.provider_calls.asr).toMatchObject({ count: 0, outcome: 'not_dispatched' });
    expect(task.execution.provider_calls.chat.count).toBe(1);
    expect(calls).toEqual(['chat']);
    expect(task.calibration_sources.reference).toBeNull();
    expect(normalized.segments[0].text).toBe(multilineText);
    expect(bridge.segments[0].text).toBe(multilineText.replace('\n', ' '));
    expect(bridge.full_text).toBe(bridge.segments.map((segment: { text: string }) => segment.text).join('\n'));
    expect(validateContract('transcript.raw', bridge).valid).toBe(true);
    expect(transcribed).toContain(visibleMultilineText);
    expect(transcribed).not.toMatch(/[，！]/u);
  });

  it('reports the transcript timing hard limit instead of a fabricated reference limit and dispatches no Provider', async () => {
    const input = await prepared();
    const sourceText = 'WEBVTT\n\n00:00.000 --> 00:01.000\n这是一个超过二十四字符且没有词粒度时间证据的合法外部转录片段\n';
    const source = path.join(input.home, 'long-provided.vtt');
    await writeFile(source, sourceText);
    input.request.request_id = 'request-long-provided-without-reference';
    input.request.output.approved_srt_directory = path.join(input.home, 'business-final');
    input.request.inputs.transcript = { path: source, sha256: sha(sourceText), format: 'vtt', role: 'transcript_source' };
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const task = await readV5Task(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory));
    expect(task.status).toBe('failed');
    expect(task.error).toMatchObject({
      code: 'CALIBRATED_HARD_LIMIT_INVALID_FOR_TEXT_ONLY',
      category: 'input',
      message: '校验后的字幕片段 subtitle-0001 超过 24 字或两行限制，且当前没有可安全拆分的真实时间边界。',
      retryability: 'after_user_action',
      remediation: ['请依据真实时间边界把该 cue/segment 拆成不超过 24 字且不超过两行的合规片段，并使用新的 request ID 创建任务；不要重放当前任务。'],
    });
    expect(task.error?.technical?.detail).toBe('Calibrated segment subtitle-0001 exceeds the 24-character or two-line hard limit.');
    expect(task.error?.code).not.toContain('REFERENCE');
    expect(task.calibration_sources.reference).toBeNull();
    expect(task.execution.provider_calls).toMatchObject({ asr: { count: 0, state: 'not_started', outcome: 'not_dispatched' }, chat: { count: 0, state: 'not_started', outcome: 'not_dispatched' } });
    expect(task.artifacts.transcribed?.validation).toBe('passed');
    expect(calls).toEqual([]);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const before = await directoryManifest(directory);
    const view = await stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    const watchOutput: string[] = [];
    expect(await runCli(['task', 'watch', task.identity.task_id, '--jsonl'], {
      homeDirectory: input.home,
      stdout: (value) => watchOutput.push(value),
      stderr: () => undefined,
    })).toBe(0);
    const watchSnapshot = JSON.parse(watchOutput[0]!).data.task;
    for (const projected of [view, result, watchSnapshot]) {
      expect(projected.error).toMatchObject({
        code: 'CALIBRATED_HARD_LIMIT_INVALID_FOR_TEXT_ONLY',
        category: 'input',
        retryability: 'after_user_action',
      });
      expect(projected.error?.message).toContain('subtitle-0001');
      expect(projected.error?.message).toContain('24 字或两行');
      expect(projected.next_action).toBe('请依据真实时间边界把该 cue/segment 拆成不超过 24 字且不超过两行的合规片段，并使用新的 request ID 创建任务；不要重放当前任务。');
      expect(projected.next_action).not.toContain('模型配置');
      if ('capabilities' in projected) {
        expect(projected).toMatchObject({
          capabilities: { pause: { supported: true }, resume: { supported: true }, retry: { supported: true } },
          pause: { allowed: false, reason: '任务状态 failed 不能暂停。' },
          resume: { allowed: false, reason: '任务状态 failed 不能恢复。' },
          retry: { allowed: false, reason: expect.stringContaining('输入、配置或安全问题') },
          delivery: {
            status: 'failed', final_path: null,
            error: {
              code: 'DELIVERY_NOT_READY',
              remediation: ['当前任务没有可交付的最终批准字幕。请按任务主错误处理；不要执行 task deliver，也不要重放当前任务。'],
            },
            next_action: expect.stringContaining('不能用 task deliver'),
          },
        });
      }
    }
    const deliverOutput: string[] = [];
    expect(await runCli(['task', 'deliver', task.identity.task_id, '--json'], {
      homeDirectory: input.home,
      stdout: (value) => deliverOutput.push(value),
      stderr: () => undefined,
    })).toBe(3);
    expect(JSON.parse(deliverOutput[0]!)).toMatchObject({
      contract: 'mercury.cli/v1', command: 'task.deliver', ok: false,
      error: {
        code: 'DELIVERY_NOT_READY', category: 'conflict', retryability: 'after_user_action',
        message: '当前任务没有可交付的最终批准字幕；业务目录不会产生新文件。',
        remediation: ['请按任务主错误处理，或在 completed 任务中先完成审阅并 finalize；不要执行 task deliver，也不要重放当前任务。'],
      },
    });
    await expect(lstat(path.join(input.home, 'business-final'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await directoryManifest(directory)).toEqual(before);
  });

  it('runs provider plus reference through the same v5 request, dictionary, result, and review semantics', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provider.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const reference = path.join(input.home, 'reference.srt');
    const referenceText = '1\n00:00:00,000 --> 00:00:00,040\n您好 Mercury\n字幕测试\n';
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
    const calls: string[] = []; const capturedHints: Array<NonNullable<Parameters<AsrAdapter['run']>[0]['asrHints']>> = []; const capturedChat: Array<Record<string, any>> = [];
    await runWorker(input.workspace, { asrAdapter: fixtureHintsAsr(calls, capturedHints), fetch: fixtureFetch(calls, capturedChat), readCredential: async () => 'fixture-secret' });
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
    const prompt = capturedChat[0]!.messages.find((message: any) => message.role === 'user').content as string;
    const promptPayload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    expect(promptPayload.calibration_units[0].original_text).toBe('您好 Mercury 字幕测试');
    expect(promptPayload.calibration_units[0].original_text).not.toMatch(/[\r\n]/u);
    expect(await readFile(path.join(directory, task.inputs.reference_normalized!.path), 'utf8')).toContain('您好 Mercury\n字幕测试');
    expect(capturedHints).toEqual([{ entries: [expect.objectContaining({ entryId: 'entry-provider-mercury', canonical: 'Mercury', variants: ['水星'] })] }]);
    const frozenDictionary = JSON.parse(await readFile(path.join(directory, task.dictionary_snapshot.path), 'utf8'));
    expect(frozenDictionary.asr_hints).toMatchObject({ status: 'used', adapter_id: 'fixture_contract_asr', entry_ids: ['entry-provider-mercury'], available_count: 1, input_count: 1, truncated: false });
    expect(frozenDictionary.asr_hints.input_hash).toMatch(/^[a-f0-9]{64}$/u);
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    expect(result.transcription).toMatchObject({ mode: 'provider', asr_call_count: 1 });
    expect(result.dictionaries).toMatchObject({ match_count: 1, snapshots: [expect.objectContaining({ dictionary_id: dictionary.dictionary_id })] });
    const attempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(attempts[0]).toMatchObject({ contract: 'mercury.attempt/v1', transcription_mode: 'provider', asr_call_count: 0 });
    expect(attempts.find((entry) => entry.contract === 'mercury.attempt-result/v1')).toMatchObject({ asr_call_count: 1, chat_call_count: 1 });
    expect(task.review.status).toMatch(/pending|finalized|not_required/u);
  });

  it('localizes a provider reference coverage mismatch and keeps stable status/result read-only', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provider-reference-mismatch.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const reference = path.join(input.home, 'incomplete-reference.srt');
    const referenceText = '1\n00:00:00,000 --> 00:00:00,040\n您好\n';
    await writeFile(reference, referenceText);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-provider-reference-mismatch',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: { path: reference, sha256: sha(referenceText), format: 'srt', role: 'reference' } },
      transcription_mode: 'provider',
      calibration: { mode: 'text-and-segmentation', source_language: 'zh-CN' },
      models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const calls: string[] = [];
    await runWorker(input.workspace, { asrAdapter: fixtureAsr(calls), fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    expect(calls).toEqual(['asr']);
    expect(task.status).toBe('failed');
    expect(task.execution.provider_calls).toMatchObject({
      asr: { state: 'terminal', count: 1, outcome: 'response_persisted' },
      chat: { state: 'not_started', count: 0, outcome: 'not_dispatched' },
    });
    expect(task.error).toMatchObject({
      code: 'REFERENCE_AUDIO_MISMATCH',
      category: 'input',
      message: expect.stringMatching(/^参考字幕与音频正文不完整对齐：ASR 转录覆盖率 [0-9.]+%，参考字幕覆盖率 [0-9.]+%，两者都需要达到 80%。$/u),
      remediation: ['参考字幕与音频正文不完整对齐；请换用覆盖同一音频范围的完整参考字幕，并使用新的 request ID 创建任务；不要重放当前任务。'],
    });
    expect(task.error?.technical?.detail).toMatch(/^ASR coverage [0-9.]+% and reference coverage [0-9.]+% must both reach 80%\.$/u);
    const before = await directoryManifest(directory);
    const view = await stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    for (const projected of [view, result]) {
      expect(projected.error).toMatchObject({ code: 'REFERENCE_AUDIO_MISMATCH', category: 'input' });
      expect(projected.error?.message).toContain('ASR 转录覆盖率');
      expect(projected.error?.message).toContain('参考字幕覆盖率');
      expect(projected.error?.message).toContain('80%');
      expect(projected.next_action).toBe('参考字幕与音频正文不完整对齐；请换用覆盖同一音频范围的完整参考字幕，并使用新的 request ID 创建任务；不要重放当前任务。');
      expect(projected.next_action).not.toContain('模型配置');
    }
    expect(await directoryManifest(directory)).toEqual(before);
  });

  it('declares both built-in Volcengine ASR adapters as not supporting per-task dynamic hints', () => {
    expect(new VolcengineAsrAdapter({ resolveCredential: async () => ({ mode: 'api_key', uid: 'fixture', value: 'fixture' }) }).asrHintsCapability.status).toBe('not_supported');
    expect(new VolcengineSubtitleAsrAdapter({ readCredential: async () => 'fixture' }).asrHintsCapability.status).toBe('not_supported');
  });

  it('reads historical provider transcripts whose structured warning JSON differs only by key order', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provider-warning-order.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-provider-warning-order',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider',
      models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const warningAsr: AsrAdapter = {
      ...fixtureAsr([]),
      async run(adapterInput) {
        const result = await fixtureAsr([]).run(adapterInput);
        if (result.kind === 'artifact') result.artifact.warnings = [{
          warning_id: 'warning-words-dropped',
          code: 'WORDS_DROPPED',
          message: '3 word timings were dropped.',
          stage: 'response_validation',
          severity: 'low',
        }];
        return result;
      },
    };
    await runWorker(input.workspace, { asrAdapter: warningAsr, fetch: fixtureFetch([]), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const transcriptPath = path.join(directory, 'work/transcript.normalized.json');
    const transcript = JSON.parse(await readFile(transcriptPath, 'utf8'));
    expect(JSON.parse(transcript.warnings[0])).toEqual({
      code: 'WORDS_DROPPED',
      message: '3 word timings were dropped.',
      severity: 'low',
      stage: 'response_validation',
      warning_id: 'warning-words-dropped',
    });

    // Simulate the already-persisted Alpha.1 development shape: identical JSON
    // value, insertion-order serialization, and its historical derived hash.
    transcript.warnings = ['{"warning_id":"warning-words-dropped","severity":"low","stage":"response_validation","message":"3 word timings were dropped.","code":"WORDS_DROPPED"}'];
    const hashMaterial = structuredClone(transcript);
    hashMaterial.source.normalized_sha256 = '0'.repeat(64);
    transcript.source.normalized_sha256 = sha(canonicalJson(hashMaterial));
    await writeFile(transcriptPath, canonicalJson(transcript), { mode: 0o600 });
    const task = await readV5Task(directory);
    task.artifacts.transcript!.sha256 = sha(canonicalJson(transcript));
    await persistV5Task(directory, task);

    const before = await directoryManifest(directory);
    await expect(stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id))).resolves.toMatchObject({ status: 'completed' });
    await expect(stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id))).resolves.toMatchObject({ status: 'completed' });
    await expect(readVerifiedV5Review(directory)).resolves.toMatchObject({ task_id: task.identity.task_id });
    expect(await directoryManifest(directory)).toEqual(before);

    transcript.warnings = ['{"warning_id":"warning-words-dropped","severity":"low","stage":"response_validation","message":"4 word timings were dropped.","code":"WORDS_DROPPED"}'];
    await writeFile(transcriptPath, canonicalJson(transcript), { mode: 0o600 });
    task.artifacts.transcript!.sha256 = sha(canonicalJson(transcript));
    await persistV5Task(directory, task);
    await expect(stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id))).rejects.toMatchObject({ code: 'CALIBRATION_SOURCE_INVALID' });
  });

  it('cancels a queued provider task with no transcript as a zero-call terminal result', async () => {
    const input = await prepared();
    const business = path.join(await realpath(input.home), 'cancelled-delivery');
    const audio = path.join(input.home, 'queued-cancel.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request, request_id: 'request-provider-queued-cancel',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider', models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
      output: { ...input.request.output, approved_srt_directory: business },
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
    expect(result).toMatchObject({ status: 'cancelled', next_action: '任务已取消；尚未产生字幕文件。', delivery: { status: 'failed', final_path: null, error: { code: 'DELIVERY_NOT_READY' } } });
    expect(await lstat(business).catch(() => null)).toBeNull();
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

  it('checkpoints subtitle submit and query as one logical ASR call', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'subtitle-two-stage.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-subtitle-two-stage-checkpoint',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider',
      models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const calls: string[] = [];
    const twoStageAsr: AsrAdapter = {
      adapterId: 'volcengine_subtitle_asr',
      async run(adapterInput) {
        await adapterInput.beforeProviderDispatch?.('volcengine_subtitle_submit');
        calls.push('subtitle-submit');
        await adapterInput.beforeProviderDispatch?.('volcengine_subtitle_query');
        calls.push('subtitle-query');
        const { beforeProviderDispatch: _checkpoint, ...withoutCheckpoint } = adapterInput;
        return fixtureAsr([]).run(withoutCheckpoint);
      },
    };
    await runWorker(input.workspace, {
      asrAdapter: twoStageAsr,
      fetch: fixtureFetch(calls),
      readCredential: async () => 'fixture-secret',
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.execution.provider_calls.asr).toMatchObject({ state: 'terminal', count: 1, outcome: 'response_persisted' });
    expect(calls).toEqual(['subtitle-submit', 'subtitle-query', 'chat']);
    const events = await readV5Events(directory);
    expect(events.filter((event) => event.type === 'provider_dispatched' && event.data.capability === 'transcription')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'provider_subrequest_checkpointed')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ operation: 'volcengine_subtitle_query', count: 1 }),
      }),
    ]);
    const providerFacts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry) => entry.contract === 'mercury.provider-call/v1' && entry.role === 'asr');
    expect(new Set(providerFacts.map((entry) => entry.call_id)).size).toBe(1);
    expect(new Set(providerFacts.map((entry) => entry.call_number))).toEqual(new Set([1]));
  });

  it('does not send subtitle query or replay submit when its local checkpoint crashes', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'subtitle-query-checkpoint-crash.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-subtitle-query-checkpoint-crash',
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
      transcription_mode: 'provider',
      models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    });
    const calls: string[] = [];
    const twoStageAsr: AsrAdapter = {
      adapterId: 'volcengine_subtitle_asr',
      async run(adapterInput) {
        await adapterInput.beforeProviderDispatch?.('volcengine_subtitle_submit');
        calls.push('subtitle-submit');
        await adapterInput.beforeProviderDispatch?.('volcengine_subtitle_query');
        calls.push('subtitle-query');
        const { beforeProviderDispatch: _checkpoint, ...withoutCheckpoint } = adapterInput;
        return fixtureAsr([]).run(withoutCheckpoint);
      },
    };
    let crashed = false;
    await expect(runWorker(
      input.workspace,
      { asrAdapter: twoStageAsr, fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' },
      {
        v5Fault: async (point) => {
          if (!crashed && point === 'after_asr_query_checkpointed') {
            crashed = true;
            throw new Error('crash:after_asr_query_checkpointed');
          }
        },
      },
    )).rejects.toThrow('crash:after_asr_query_checkpointed');
    await runWorker(input.workspace, {
      asrAdapter: twoStageAsr,
      fetch: fixtureFetch(calls),
      readCredential: async () => 'fixture-secret',
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    expect(task.status).toBe('interrupted');
    expect(task.execution.provider_calls.asr).toMatchObject({ state: 'in_flight', count: 1, outcome: 'outcome_unknown' });
    expect(task.execution.provider_calls.chat).toMatchObject({ state: 'not_started', count: 0, outcome: 'not_dispatched' });
    expect(task.error).toMatchObject({ code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', retryability: 'unsafe' });
    expect(calls).toEqual(['subtitle-submit']);
    expect((await readV5Events(directory)).filter((event) => event.type === 'provider_subrequest_checkpointed')).toHaveLength(1);
  });

  it('finishes the in-flight subtitle query before honoring pause or cancel', async () => {
    for (const action of ['pause', 'cancel'] as const) {
      const input = await prepared();
      const audio = path.join(input.home, `subtitle-query-${action}.mp3`);
      const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
      const registry = await loadModelRegistryV2(input.workspace);
      const submitted = await submitExchangeRequest(input.workspace, {
        ...input.request,
        request_id: `request-subtitle-query-${action}`,
        inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' }, transcript: null },
        transcription_mode: 'provider',
        models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
      });
      const calls: string[] = [];
      let signalSubmitted!: () => void;
      const submittedResponse = new Promise<void>((resolve) => { signalSubmitted = resolve; });
      let continueQuery!: () => void;
      const queryGate = new Promise<void>((resolve) => { continueQuery = resolve; });
      const twoStageAsr: AsrAdapter = {
        adapterId: 'volcengine_subtitle_asr',
        async run(adapterInput) {
          await adapterInput.beforeProviderDispatch?.('volcengine_subtitle_submit');
          calls.push('subtitle-submit');
          signalSubmitted();
          await queryGate;
          await adapterInput.beforeProviderDispatch?.('volcengine_subtitle_query');
          calls.push('subtitle-query');
          const { beforeProviderDispatch: _checkpoint, ...withoutCheckpoint } = adapterInput;
          return fixtureAsr([]).run(withoutCheckpoint);
        },
      };
      const worker = runWorker(input.workspace, {
        asrAdapter: twoStageAsr,
        fetch: fixtureFetch(calls),
        readCredential: async () => 'fixture-secret',
      });
      await submittedResponse;
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
      if (action === 'pause') {
        expect((await pauseV5Task(input.workspace, await readV5Task(directory))).pending).toBe(true);
      } else {
        expect((await cancelV5Task(input.workspace, await readV5Task(directory))).pending).toBe(true);
      }
      continueQuery();
      await worker;
      const task = await readV5Task(directory);
      expect(task.status).toBe(action === 'pause' ? 'paused' : 'cancelled');
      expect(task.execution.provider_calls.asr).toMatchObject({ state: 'response_persisted', count: 1, outcome: 'response_persisted' });
      expect(task.execution.provider_calls.chat).toMatchObject({ state: 'not_started', count: 0, outcome: 'not_dispatched' });
      expect(calls).toEqual(['subtitle-submit', 'subtitle-query']);
    }
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

  it('keeps a persisted Gemini outcome-unknown artifact interrupted and never replays it', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provided-strong-unknown.mp3');
    const bytes = Buffer.alloc(417 * 80);
    for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
    await writeFile(audio, bytes);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-provided-strong-outcome-unknown',
      inputs: { ...input.request.inputs, media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' } },
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await forceStrongEvidence(directory, true);
    let providerCalls = 0;
    const dependencies = {
      createVertexClient: () => ({
        interactions: { create: async () => { throw new Error('unexpected'); } },
        models: { generateContent: async () => {
          providerCalls += 1;
          throw new Error('fetch failed', { cause: new Error('other side closed') });
        } },
      }),
    };
    await runWorker(input.workspace, dependencies);
    const task = await readV5Task(directory);
    expect(task.status).toBe('interrupted');
    expect(task.execution.provider_calls.chat).toMatchObject({
      state: 'in_flight', count: 1, outcome: 'outcome_unknown',
      evidence_ref: 'work/calibration-response.json',
    });
    expect(task.execution.provider_calls.chat.evidence_sha256).toBe(sha(await readFile(path.join(directory, 'work/calibration-response.json'))));
    expect((await stat(path.join(directory, 'work/calibration-response.json'))).mode & 0o777).toBe(0o600);
    expect(task.error).toMatchObject({ code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', retryability: 'unsafe' });
    const view = await stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    expect(view).toMatchObject({ status: 'interrupted', retry: { allowed: false }, error: { retryability: 'unsafe' } });
    expect(result).toMatchObject({ status: 'interrupted', error: { retryability: 'unsafe' } });
    expect(await runWorker(input.workspace, dependencies)).toBe('acquired');
    expect(providerCalls).toBe(1);

    // Reproduce the pre-fix on-disk classification and prove a later Worker
    // audit corrects only the certainty metadata from the pinned artifact.
    const misclassified = JSON.parse(await readFile(path.join(directory, 'task.json'), 'utf8'));
    misclassified.status = 'failed';
    misclassified.execution.provider_calls.chat.state = 'terminal';
    misclassified.execution.provider_calls.chat.outcome = 'response_persisted';
    misclassified.execution.provider_calls.chat.terminal_at = misclassified.updated_at;
    misclassified.error = {
      ...misclassified.error,
      code: 'GEMINI_MODEL_CALL_FAILED',
      provider_outcome: 'response_persisted',
      retryability: 'after_user_action',
      remediation: ['检查模型配置后使用新的 request ID 创建任务。'],
    };
    misclassified.identity.revision += 1;
    await writeFile(path.join(directory, 'task.json'), canonicalJson(misclassified), { mode: 0o600 });
    const historicalAttempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    for (const entry of historicalAttempts) {
      if (entry.contract === 'mercury.attempt-result/v1') {
        entry.status = 'failed';
        entry.safe_checkpoint = 'chat_response_persisted';
      }
    }
    await writeFile(
      path.join(directory, 'attempts.jsonl'),
      `${historicalAttempts.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      { mode: 0o600 },
    );
    await runWorker(input.workspace, dependencies);
    const repaired = await readV5Task(directory);
    expect(repaired).toMatchObject({
      status: 'interrupted',
      execution: { provider_calls: { chat: { state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: 'work/calibration-response.json' } } },
      error: { code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', retryability: 'unsafe' },
    });
    expect(providerCalls).toBe(1);
    const attemptRecords = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(attemptRecords.filter((entry) => entry.contract === 'mercury.attempt-result/v1')).toEqual([
      expect.objectContaining({ attempt_id: repaired.execution.attempt_id, status: 'failed' }),
    ]);
    expect(attemptRecords.filter((entry) => entry.contract === 'mercury.attempt-result-correction/v1')).toEqual([
      expect.objectContaining({
        attempt_id: repaired.execution.attempt_id,
        supersedes_status: 'failed',
        status: 'interrupted',
        reason_code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN',
      }),
    ]);
    await runWorker(input.workspace, dependencies);
    const afterSecondAudit = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(afterSecondAudit.filter((entry) => entry.contract === 'mercury.attempt-result-correction/v1')).toHaveLength(1);
    expect(providerCalls).toBe(1);
  });

  it('keeps a persisted Gemini known response terminal while outcome-unknown semantics stay separate', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'provided-strong-known.mp3');
    const bytes = Buffer.alloc(417 * 80);
    for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
    await writeFile(audio, bytes);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-provided-strong-known-terminal',
      inputs: { ...input.request.inputs, media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' } },
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await forceStrongEvidence(directory, true);
    let providerCalls = 0;
    const dependencies = {
      createVertexClient: () => ({
        interactions: { create: async () => { throw new Error('unexpected'); } },
        models: { generateContent: async () => {
          providerCalls += 1;
          throw new Error('400 INVALID_ARGUMENT');
        } },
      }),
    };
    await runWorker(input.workspace, dependencies);
    const task = await readV5Task(directory);
    expect(task.status).toBe('failed');
    expect(task.execution.provider_calls.chat).toMatchObject({
      state: 'terminal', count: 1, outcome: 'response_persisted',
      evidence_ref: 'work/calibration-response.json',
    });
    expect(task.error).toMatchObject({ code: 'GEMINI_VERTEX_REQUEST_INVALID', provider_outcome: 'response_persisted' });
    expect(await runWorker(input.workspace, dependencies)).toBe('acquired');
    expect(providerCalls).toBe(1);
  });

  it('rejects a tampered provided calibration transcript bridge before Chat dispatch', async () => {
    const input = await prepared();
    input.request.request_id = 'request-provided-bridge-transcript-tamper';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const pointer = submitted.task.calibration_sources.transcript!;
    await writeFile(path.join(directory, pointer.path), canonicalJson({ tampered: true }), { mode: 0o600 });
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
      } : knownFailureChat(calls);
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
    expect(recovered.artifacts.report).toMatchObject({ path: 'output/calibration-report.md', validation: 'passed' });
    const reportPath = path.join(directory, recovered.artifacts.report!.path);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect(sha(await readFile(reportPath))).toBe(recovered.artifacts.report!.sha256);
    expect(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'))).toMatchObject({
      status: 'failed', error: { provider_outcome: 'known_terminal' },
      artifacts: expect.arrayContaining([expect.objectContaining({ identity: 'calibration_report', exists: true, validation: 'passed', sha256: recovered.artifacts.report!.sha256 })]),
    });
  });

  it.each(['after_terminal_report_written', 'after_terminal_report_committed'] as const)('recovers the %s window idempotently without another Provider call', async (point) => {
    const input = await prepared();
    input.request.request_id = `request-report-recovery-${point}`;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    const dependencies = { chatRuntime: knownFailureChat(calls), readCredential: async () => 'fixture-secret' };
    let crashed = false;
    await expect(runWorker(input.workspace, dependencies, {
      v5Fault: async (current, task) => {
        if (!crashed && current === point && task.error?.provider_outcome === 'known_terminal') {
          crashed = true;
          throw new Error(`crash:${point}`);
        }
      },
    })).rejects.toThrow(`crash:${point}`);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const afterCrash = await readV5Task(directory);
    expect(afterCrash).toMatchObject({ status: 'failed', execution: { provider_calls: { chat: { state: 'terminal', count: 1, outcome: 'known_terminal' } } } });
    expect(await stat(path.join(directory, 'output/calibration-report.md')).then(() => true, () => false)).toBe(true);
    expect(afterCrash.artifacts.report === null).toBe(point === 'after_terminal_report_written');
    expect(await stat(path.join(directory, 'result.json')).then(() => true, () => false)).toBe(false);
    const callsAfterCrash = [...calls];
    await runWorker(input.workspace, dependencies);
    const recovered = await readV5Task(directory);
    expect(calls).toEqual(callsAfterCrash);
    expect(recovered.artifacts.report).toMatchObject({ path: 'output/calibration-report.md', validation: 'passed' });
    const reportPath = path.join(directory, recovered.artifacts.report!.path);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect(sha(await readFile(reportPath))).toBe(recovered.artifacts.report!.sha256);
    const beforeSecondAudit = await directoryManifest(directory);
    await runWorker(input.workspace, dependencies);
    expect(calls).toEqual(callsAfterCrash);
    expect(await directoryManifest(directory)).toEqual(beforeSecondAudit);
  });

  it('preserves known terminal truth and emits a structured diagnostic when fixed report evidence is damaged', async () => {
    const input = await prepared();
    input.request.request_id = 'request-report-recovery-damaged-evidence';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    const dependencies = { chatRuntime: knownFailureChat(calls), readCredential: async () => 'fixture-secret' };
    await expect(runWorker(input.workspace, dependencies, {
      v5Fault: async (point, task) => {
        if (point === 'terminal_task_before_result' && task.error?.provider_outcome === 'known_terminal') throw new Error('crash:report-evidence-damage');
      },
    })).rejects.toThrow('crash:report-evidence-damage');
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const durable = await readV5Task(directory);
    await writeFile(path.join(directory, durable.dictionary_snapshot.path), canonicalJson({ tampered: true }), { mode: 0o600 });
    const callsBeforeAudit = [...calls];
    await runWorker(input.workspace, dependencies);
    const afterAudit = await readV5Task(directory);
    expect(afterAudit).toMatchObject({
      status: 'failed', error: { provider_outcome: 'known_terminal' },
      execution: { provider_calls: { chat: { state: 'terminal', count: 1, outcome: 'known_terminal' } } },
      artifacts: { report: null },
    });
    expect(calls).toEqual(callsBeforeAudit);
    const diagnostics = JSON.parse(await readFile(path.join(input.workspace, 'runtime/worker-diagnostics.json'), 'utf8'));
    expect(diagnostics.issues).toEqual(expect.arrayContaining([expect.objectContaining({ file: `${afterAudit.identity.task_id}.json`, code: 'DICTIONARY_RECORD_INVALID' })]));
  });

  it.each([0o644, 0o666, 0o444])('restores a hash-correct terminal report from mode %o to exact 0600 without another Provider call', async (unsafeMode) => {
    const input = await prepared();
    input.request.request_id = `request-report-mode-${unsafeMode.toString(8)}`;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    const dependencies = { chatRuntime: knownFailureChat(calls), readCredential: async () => 'fixture-secret' };
    await runWorker(input.workspace, dependencies);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const before = await readV5Task(directory);
    const reportBefore = structuredClone(before.artifacts.report!);
    const reportPath = path.join(directory, reportBefore.path);
    await chmod(reportPath, unsafeMode);
    expect((await stat(reportPath)).mode & 0o777).toBe(unsafeMode);
    const callsBeforeAudit = [...calls];
    await runWorker(input.workspace, dependencies);
    const recovered = await readV5Task(directory);
    expect(calls).toEqual(callsBeforeAudit);
    expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    expect(recovered.artifacts.report).toEqual(reportBefore);
    expect(sha(await readFile(reportPath))).toBe(reportBefore.sha256);
    expect(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'))).toMatchObject({
      status: 'failed',
      artifacts: expect.arrayContaining([expect.objectContaining({ identity: 'calibration_report', exists: true, validation: 'passed', sha256: reportBefore.sha256 })]),
    });
    const beforeIdempotentAudit = await directoryManifest(directory);
    await runWorker(input.workspace, dependencies);
    expect(calls).toEqual(callsBeforeAudit);
    expect(await directoryManifest(directory)).toEqual(beforeIdempotentAudit);
  });

  it('replaces an unsafe terminal-report symlink without modifying its external target or calling Provider', async () => {
    const input = await prepared();
    input.request.request_id = 'request-report-symlink-recovery';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    const dependencies = { chatRuntime: knownFailureChat(calls), readCredential: async () => 'fixture-secret' };
    await runWorker(input.workspace, dependencies);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    const reportPath = path.join(directory, task.artifacts.report!.path);
    const outside = path.join(input.home, 'outside-report.md');
    const original = await readFile(reportPath);
    await writeFile(outside, original, { mode: 0o600 });
    const outsideBefore = sha(await readFile(outside));
    await rm(reportPath);
    await symlink(outside, reportPath);
    const callsBeforeAudit = [...calls];
    await runWorker(input.workspace, dependencies);
    const entry = await lstat(reportPath);
    expect(entry.isFile()).toBe(true);
    expect(entry.isSymbolicLink()).toBe(false);
    expect(entry.mode & 0o777).toBe(0o600);
    expect(sha(await readFile(reportPath))).toBe(task.artifacts.report!.sha256);
    expect(sha(await readFile(outside))).toBe(outsideBefore);
    expect(calls).toEqual(callsBeforeAudit);
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
      reference: null,
    });
    for (const relative of ['request.json', 'task.json', 'events.jsonl', 'attempts.jsonl', 'input/transcript-source.srt', 'work/transcript.normalized.json', 'work/transcript.raw.json', first.task.artifacts.transcribed!.path]) {
      if (relative === 'attempts.jsonl') continue;
      expect((await stat(path.join(directory, relative))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(path.join(directory, 'input/transcript-source.srt'), 'utf8')).toBe(await readFile(input.source, 'utf8'));
    expect(first.task.execution.provider_calls.asr).toMatchObject({ state: 'not_started', count: 0, outcome: 'not_dispatched', evidence_ref: null, evidence_sha256: null });

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
    const bridgeBefore = sha(await readFile(path.join(directory, completed.calibration_sources.transcript!.path)));
    const view = await stableTaskView(input.workspace, found);
    const result = await stableTaskResult(input.workspace, found);
    const response = JSON.parse(await readFile(path.join(directory, 'work/calibration-response.json'), 'utf8'));
    const calibratedTranscript = JSON.parse(await readFile(path.join(directory, 'work/transcript.calibrated.json'), 'utf8'));
    expect(response.request).toMatchObject({ transcript_ref: 'work/transcript.raw.json', reference_srt_ref: null });
    expect(calibratedTranscript.source_refs).toMatchObject({ transcript_ref: 'work/transcript.raw.json', reference_srt_ref: null });
    expect(sha(await readFile(path.join(directory, completed.calibration_sources.transcript!.path)))).toBe(completed.calibration_sources.transcript!.sha256);
    expect(view.source_schema_version).toBe('5.0.0');
    expect(view.capabilities.provided_transcript.supported).toBe(true);
    expect(result.transcription).toMatchObject({ mode: 'provided', asr_call_count: 0 });
    expect(result.dictionaries).toMatchObject({ match_count: 1, conflict_count: 0, snapshots: [expect.objectContaining({ revision: dictionaryV2.revision })] });
    expect(result.artifacts.find((entry) => entry.identity === 'transcribed_srt')).toMatchObject({ exists: true, validation: 'passed' });
    expect(result.artifacts.find((entry) => entry.identity === 'calibrated_srt')).toMatchObject({ exists: true, validation: 'passed' });
    expect(sha(await readFile(path.join(directory, completed.calibration_sources.transcript!.path)))).toBe(bridgeBefore);
    const attempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(attempts.find((entry) => entry.contract === 'mercury.attempt/v1')).toMatchObject({ asr_call_count: 0 });
    expect(attempts.find((entry) => entry.contract === 'mercury.attempt-result/v1')).toMatchObject({ status: 'completed', asr_call_count: 0, chat_call_count: 1 });

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
    const business = path.join(await realpath(input.home), 'failed-delivery');
    input.request.request_id = 'request-external-failure';
    input.request.output.approved_srt_directory = business;
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
    expect(result.delivery).toMatchObject({ status: 'failed', final_path: null, error: { code: 'DELIVERY_NOT_READY' } });
    expect(await lstat(business).catch(() => null)).toBeNull();
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
    dispatched.execution.provider_calls.chat = {
      state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null, evidence_sha256: null,
      call_id: 'pcl-0123456789abcdef01234567', capability: 'calibration', model_snapshot_entry_ref: `${submitted.task.identity.task_id}-chat`,
      dispatched_at: started, response_persisted_at: null, terminal_at: null,
    };
    await persistV5Task(directory, dispatched);
    stale.execution.heartbeat_at = '2026-08-16T15:00:02.000Z'; stale.updated_at = stale.execution.heartbeat_at;
    await persistV5Task(directory, stale);
    await appendV5Event(directory, structuredClone(stale), 'heartbeat_fixture', '旧事件快照不覆盖 dispatch。');
    expect((await readV5Task(directory)).execution.provider_calls.chat).toMatchObject({ state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null, evidence_sha256: null });
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
    const business = path.join(await realpath(input.home), 'interrupted-delivery');
    input.request.request_id = 'request-v5-crash-after-dispatch';
    input.request.output.approved_srt_directory = business;
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
    const result = await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    expect(result.delivery).toMatchObject({ status: 'failed', final_path: null, error: { code: 'DELIVERY_NOT_READY' } });
    expect(await lstat(business).catch(() => null)).toBeNull();
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
    expect(status).toMatchObject({ contract: 'mercury.cli/v1', command: 'review.status', ok: true });
    expect(status.data).toMatchObject({ task_id: taskId, status: 'pending', counts: { pending: 1 } });
    const listOut: string[] = [];
    expect(await runCli(['review', 'list', taskId, '--limit', '10', '--json'], { ...io, stdout: (value) => listOut.push(value) })).toBe(0);
    expect(JSON.parse(listOut[0]!)).toMatchObject({ contract: 'mercury.cli/v1', command: 'review.list', ok: true });
    const change = JSON.parse(listOut[0]!).data.changes[0];
    const before = parseSrt(await readFile(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory, submitted.task.artifacts.transcribed!.path), 'utf8'));
    expect(await runCli(['review', 'decide', taskId, '--change', change.change_id, '--accept', '--json'], { ...io, stdout: () => undefined })).toBe(0);
    const finalized: string[] = [];
    expect(await runCli(['review', 'finalize', taskId, '--json'], { ...io, stdout: (value) => finalized.push(value) })).toBe(0);
    expect(JSON.parse(finalized[0]!)).toMatchObject({ contract: 'mercury.cli/v1', command: 'review.finalize', ok: true });
    const approvedPath = JSON.parse(finalized[0]!).data.approved_artifact.absolute_path;
    const after = parseSrt(await readFile(approvedPath, 'utf8'));
    expect(after.map(({ start, end }) => ({ start, end }))).toEqual(before.map(({ start, end }) => ({ start, end })));
    expect((await readV5Task(path.dirname(path.dirname(approvedPath)))).review.status).toBe('finalized');
  });

  it('auto-delivers a no-change approved SRT once, preserves 0600 bytes, and replays the request 100 times without another file', async () => {
    const input = await prepared();
    const business = path.join(await realpath(input.home), 'business-output');
    input.request.request_id = 'request-approved-delivery-no-change';
    input.request.output.approved_srt_directory = business;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory);
    expect(task.status, JSON.stringify(task.error)).toBe('completed');
    expect(task.review.status).toBe('not_required');
    expect(task.delivery).toMatchObject({ status: 'delivered', validation: 'passed' });
    const external = task.delivery!.final_path!;
    expect(path.dirname(external)).toBe(business);
    expect((await stat(business)).mode & 0o777).toBe(0o700);
    expect((await stat(external)).mode & 0o777).toBe(0o600);
    expect(sha(await readFile(external))).toBe(task.artifacts.approved!.sha256);
    expect(await readFile(external)).toEqual(await readFile(path.join(directory, task.artifacts.approved!.path)));
    for (let index = 0; index < 100; index += 1) {
      const replay = await submitExchangeRequest(input.workspace, input.request);
      expect(replay.replayed).toBe(true);
      expect(replay.task.identity.task_id).toBe(task.identity.task_id);
    }
    const before = await directoryManifest(directory); const outsideBefore = await directoryManifest(business);
    const record = await findTaskReadOnly(input.workspace, task.identity.task_id);
    const view = await stableTaskView(input.workspace, record); const result = await stableTaskResult(input.workspace, record);
    expect(view.delivery).toMatchObject({ status: 'delivered', final_path: external, sha256: task.artifacts.approved!.sha256 });
    expect(result.delivery).toEqual(view.delivery);
    const io = { homeDirectory: input.home, stdout: (_value: string) => undefined, stderr: (_value: string) => undefined };
    expect(await runCli(['task', 'list', '--json'], io)).toBe(0);
    expect(await runCli(['task', 'status', task.identity.task_id, '--json'], io)).toBe(0);
    expect(await runCli(['task', 'result', task.identity.task_id, '--json'], io)).toBe(0);
    const lastSequence = (await readV5Events(directory)).at(-1)!.sequence;
    expect(await runCli(['task', 'watch', task.identity.task_id, '--after', String(lastSequence), '--jsonl'], io)).toBe(0);
    expect(await directoryManifest(directory)).toEqual(before);
    expect(await directoryManifest(business)).toEqual(outsideBefore);
    await chmod(external, 0o644); const unsafeManifest = await directoryManifest(business);
    const unsafeView = await stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, task.identity.task_id));
    expect(unsafeView.delivery).toMatchObject({ status: 'failed', validation: 'unavailable', error: { code: 'DELIVERY_HISTORY_INVALID' } });
    expect(await directoryManifest(business)).toEqual(unsafeManifest);
    await chmod(external, 0o600);
    expect(calls).toEqual(['chat']);
  });

  it('projects an older schema5 task without a delivery field as not_requested without writing it back', async () => {
    const input = await prepared(); input.request.request_id = 'request-old-v5-without-delivery';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const raw = JSON.parse(await readFile(path.join(directory, 'task.json'), 'utf8')); delete raw.delivery;
    await writeFile(path.join(directory, 'task.json'), canonicalJson(raw), { mode: 0o600 });
    const before = await directoryManifest(directory);
    const record = await findTaskReadOnly(input.workspace, submitted.task.identity.task_id);
    expect((await stableTaskView(input.workspace, record)).delivery).toMatchObject({ status: 'not_requested', requested_directory: null, history: [] });
    expect((await stableTaskResult(input.workspace, record)).delivery).toMatchObject({ status: 'not_requested', requested_directory: null, history: [] });
    expect(await directoryManifest(directory)).toEqual(before);
  });

  it('treats the requested business directory as part of the stable request fingerprint', async () => {
    const input = await prepared();
    input.request.request_id = 'request-approved-delivery-fingerprint';
    input.request.output.approved_srt_directory = path.join(await realpath(input.home), 'output-a');
    await submitExchangeRequest(input.workspace, input.request);
    const changed = structuredClone(input.request);
    changed.output.approved_srt_directory = path.join(await realpath(input.home), 'output-b');
    await expect(submitExchangeRequest(input.workspace, changed)).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(await readdir(path.join(input.workspace, 'tasks'))).toHaveLength(1);
  });

  it('keeps immutable versioned deliveries while the same task is edited, finalized, and returned to historical content', async () => {
    const input = await prepared();
    const business = path.join(await realpath(input.home), 'versioned-output');
    input.request.request_id = 'request-approved-delivery-versioned';
    input.request.output.approved_srt_directory = business;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls, [], (text, index) => index === 0 ? text.replace('您好', '你好') : text), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    let review = await readVerifiedV5Review(directory);
    const change = review.changes[0]!;
    expect((await lstat(business).catch(() => null))).toBeNull();
    review = await decideV5ReviewChange(directory, { changeId: change.change_id, decision: 'accepted', actor: 'user_via_cli', now: () => new Date('2026-08-17T10:00:00.000Z') });
    await finalizeV5Review(directory, () => new Date('2026-08-17T10:00:01.000Z'));
    let task = await readV5Task(directory); const fileA = task.delivery!.final_path!; const hashA = task.delivery!.sha256!;
    expect(task.delivery!.history).toHaveLength(1);
    const bytesA = await readFile(fileA);

    await decideV5ReviewChange(directory, { changeId: change.change_id, decision: 'edited', text: '您好 Mercury 新版本', actor: 'user_via_cli', now: () => new Date('2026-08-17T10:01:00.000Z') });
    task = await readV5Task(directory);
    expect(task.delivery).toMatchObject({ status: 'pending_review', final_path: null, sha256: null });
    expect(task.delivery!.history).toHaveLength(1);
    expect(await readFile(fileA)).toEqual(bytesA);
    await Promise.all([finalizeV5Review(directory, () => new Date('2026-08-17T10:01:01.000Z')), finalizeV5Review(directory, () => new Date('2026-08-17T10:01:01.000Z'))]);
    task = await readV5Task(directory); const fileB = task.delivery!.final_path!;
    expect(fileB).not.toBe(fileA); expect(task.delivery!.history).toHaveLength(2);
    expect(await readFile(fileA)).toEqual(bytesA);

    await decideV5ReviewChange(directory, { changeId: change.change_id, decision: 'edited', text: change.proposed_text, actor: 'user_via_cli', now: () => new Date('2026-08-17T10:02:00.000Z') });
    await finalizeV5Review(directory, () => new Date('2026-08-17T10:02:01.000Z'));
    task = await readV5Task(directory);
    expect(task.delivery).toMatchObject({ status: 'delivered', final_path: fileA, sha256: hashA });
    expect(task.delivery!.history).toHaveLength(3);
    expect((await readdir(business)).filter((name) => name.endsWith('.srt'))).toHaveLength(2);
    const eventsBefore = (await readV5Events(directory)).filter((event) => event.type === 'approved_srt_delivered').length;
    const manifestBefore = await directoryManifest(business);
    await finalizeV5Review(directory); await deliverApprovedSrt(directory, await readVerifiedV5Review(directory));
    expect((await readV5Task(directory)).delivery!.history).toHaveLength(3);
    expect((await readV5Events(directory)).filter((event) => event.type === 'approved_srt_delivered')).toHaveLength(eventsBefore);
    expect(await directoryManifest(business)).toEqual(manifestBefore);
    expect(calls).toEqual(['chat']);
  });

  it('waits for accepted, rejected, and edited review decisions before publishing the final SRT with the exact calibrated timeline', async () => {
    const input = await prepared();
    const sourceText = '1\n00:00:00,000 --> 00:00:01,000\n甲原文\n\n2\n00:00:01,000 --> 00:00:02,000\n乙原文\n\n3\n00:00:02,000 --> 00:00:03,000\n丙原文\n';
    await writeFile(input.source, sourceText); input.request.inputs.transcript!.sha256 = sha(sourceText);
    const business = path.join(await realpath(input.home), 'three-decisions-output');
    input.request.request_id = 'request-approved-delivery-three-decisions'; input.request.output.approved_srt_directory = business;
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls, [], (text) => `${text}校`), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    let review = await readVerifiedV5Review(directory);
    expect(review.counts.pending).toBe(3); expect(await lstat(business).catch(() => null)).toBeNull();
    const pendingManifest = await directoryManifest(directory); const rejectedOutput: string[] = [];
    expect(await runCli(['task', 'deliver', submitted.task.identity.task_id, '--json'], { homeDirectory: input.home, stdout: (value) => rejectedOutput.push(value), stderr: () => undefined })).toBe(3);
    expect(JSON.parse(rejectedOutput[0]!).error).toMatchObject({ code: 'DELIVERY_NOT_READY', category: 'conflict', retryability: 'after_user_action' });
    expect((await readV5Task(directory)).delivery?.status).toBe('pending_review');
    expect(await directoryManifest(directory)).toEqual(pendingManifest); expect(await lstat(business).catch(() => null)).toBeNull();
    review = await decideV5ReviewChange(directory, { changeId: review.changes[0]!.change_id, decision: 'accepted', actor: 'user_via_cli' });
    review = await decideV5ReviewChange(directory, { changeId: review.changes[1]!.change_id, decision: 'rejected', actor: 'user_via_cli' });
    review = await decideV5ReviewChange(directory, { changeId: review.changes[2]!.change_id, decision: 'edited', text: '丙，人工确认！', actor: 'user_via_cli' });
    expect(review.counts).toMatchObject({ accepted: 1, rejected: 1, edited: 1, pending: 0 });
    expect(await lstat(business).catch(() => null)).toBeNull();
    const finalized = await finalizeV5Review(directory);
    const task = await readV5Task(directory); const delivered = await readFile(task.delivery!.final_path!, 'utf8');
    const calibrated = await readFile(path.join(directory, task.artifacts.calibrated!.path), 'utf8');
    expect(parseSrt(delivered)).toEqual(parseSrt(calibrated));
    expect(delivered).toContain('甲原文校'); expect(delivered).toContain('乙原文'); expect(delivered).toContain('丙人工确认'); expect(delivered).not.toMatch(/[，！]/u);
    expect(task.delivery).toMatchObject({ status: 'delivered', sha256: finalized.approved_artifact!.sha256 });
    expect(calls).toEqual(['chat']);
  });

  it('recovers a local-only delivery commit crash without another Provider call and rejects symlink directories without changing the target', async () => {
    const input = await prepared();
    const missingParent = path.join(await realpath(input.home), 'later-parent');
    const business = path.join(missingParent, 'delivery');
    input.request.request_id = 'request-approved-delivery-recovery';
    input.request.output.approved_srt_directory = business;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    let task = await readV5Task(directory);
    expect(task.delivery).toMatchObject({ status: 'failed', validation: 'unavailable' });
    expect(task.artifacts.approved?.validation).toBe('passed');
    const failedOutput: string[] = [];
    expect(await runCli(['task', 'deliver', task.identity.task_id, '--json'], { homeDirectory: input.home, stdout: (value) => failedOutput.push(value), stderr: () => undefined })).toBe(2);
    expect(JSON.parse(failedOutput[0]!).error).toMatchObject({ code: 'DELIVERY_DIRECTORY_INVALID', category: 'input', retryability: 'after_user_action', provider_outcome: 'not_applicable' });
    expect(calls).toEqual(['chat']);
    await mkdir(missingParent, { mode: 0o700 });
    const review = await readVerifiedV5Review(directory);
    await expect(deliverApprovedSrt(directory, review, { fault: (point) => { if (point === 'after_final_committed') throw new Error('crash:delivery-final'); } })).rejects.toBeInstanceOf(SimulatedDeliveryCrash);
    task = await readV5Task(directory);
    expect(task.delivery?.status).toBe('ready');
    expect(calls).toEqual(['chat']);
    const output: string[] = [];
    expect(await runCli(['task', 'deliver', task.identity.task_id, '--json'], { homeDirectory: input.home, stdout: (value) => output.push(value), stderr: () => undefined }), output.join('')).toBe(0);
    expect(JSON.parse(output[0]!).data.task.delivery).toMatchObject({ status: 'delivered', validation: 'passed' });
    task = await readV5Task(directory);
    expect(task.delivery).toMatchObject({ status: 'delivered', validation: 'passed' });
    expect(calls).toEqual(['chat']);

    const unsafeInput = await prepared();
    const unsafeHome = await realpath(unsafeInput.home);
    const outside = path.join(unsafeHome, 'outside'); await mkdir(outside, { mode: 0o700 });
    const marker = path.join(outside, 'keep.txt'); await writeFile(marker, 'unchanged', { mode: 0o600 });
    const linked = path.join(unsafeHome, 'linked-output'); await symlink(outside, linked);
    unsafeInput.request.request_id = 'request-approved-delivery-symlink'; unsafeInput.request.output.approved_srt_directory = linked;
    const unsafeSubmitted = await submitExchangeRequest(unsafeInput.workspace, unsafeInput.request);
    const unsafeCalls: string[] = [];
    await runWorker(unsafeInput.workspace, { fetch: fixtureFetch(unsafeCalls), readCredential: async () => 'fixture-secret' });
    const unsafeTask = await readV5Task(path.join(unsafeInput.workspace, 'tasks', unsafeSubmitted.task.identity.task_directory));
    expect(unsafeTask.delivery?.error?.code).toBe('DELIVERY_PATH_UNSAFE');
    expect(await readFile(marker, 'utf8')).toBe('unchanged');
    expect((await readdir(outside))).toEqual(['keep.txt']);
    expect(unsafeCalls).toEqual(['chat']);
  });

  it.each(['after_ready_persisted', 'after_temp_synced', 'after_final_committed', 'after_task_committed', 'after_event_committed'] as const)('recovers the delivery %s crash window locally with one immutable fact', async (point) => {
    const input = await prepared();
    const realHome = await realpath(input.home);
    const parent = path.join(realHome, `recovery-${point}`); const business = path.join(parent, 'output');
    input.request.request_id = `request-delivery-window-${point.replaceAll('_', '-')}`;
    input.request.output.approved_srt_directory = business;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await mkdir(parent, { mode: 0o700 });
    const review = await readVerifiedV5Review(directory);
    await expect(deliverApprovedSrt(directory, review, { fault: (current) => { if (current === point) throw new Error(`crash:${point}`); } })).rejects.toBeInstanceOf(SimulatedDeliveryCrash);
    await deliverApprovedSrt(directory, review);
    const task = await readV5Task(directory);
    expect(task.delivery).toMatchObject({ status: 'delivered', validation: 'passed' });
    expect(task.delivery!.history).toHaveLength(1);
    expect((await readV5Events(directory)).filter((event) => event.type === 'approved_srt_delivered')).toHaveLength(1);
    expect((await readdir(business)).filter((name) => name.endsWith('.srt'))).toHaveLength(1);
    const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    expect(result.delivery).toMatchObject({ status: 'delivered', final_path: task.delivery!.final_path, sha256: task.delivery!.sha256 });
    expect(calls).toEqual(['chat']);
  });

  it('never overwrites an existing deterministic target with different bytes or unsafe permissions', async () => {
    const input = await prepared();
    const parent = path.join(await realpath(input.home), 'conflict-parent'); const business = path.join(parent, 'output');
    input.request.request_id = 'request-delivery-target-conflict'; input.request.output.approved_srt_directory = business;
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await mkdir(parent, { mode: 0o700 }); await mkdir(business, { mode: 0o700 });
    const task = await readV5Task(directory); const target = task.delivery!.final_path!;
    await writeFile(target, 'external-content', { mode: 0o600 });
    const before = await readFile(target);
    await expect(deliverApprovedSrt(directory, await readVerifiedV5Review(directory))).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' });
    expect(await readFile(target)).toEqual(before);
    expect(calls).toEqual(['chat']);

    await rm(target); const approved = await readFile(path.join(directory, task.artifacts.approved!.path)); await writeFile(target, approved, { mode: 0o644 });
    await expect(deliverApprovedSrt(directory, await readVerifiedV5Review(directory))).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' });
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await readFile(target)).toEqual(approved);
    expect(calls).toEqual(['chat']);
  });

  it('keeps the workspace approved artifact passed when the existing business directory is not writable', async () => {
    const input = await prepared(); const business = path.join(await realpath(input.home), 'readonly-output');
    await mkdir(business, { mode: 0o500 });
    input.request.request_id = 'request-delivery-directory-not-writable'; input.request.output.approved_srt_directory = business;
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    try {
      await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const task = await readV5Task(directory);
      expect(task.artifacts.approved?.validation).toBe('passed');
      expect(task.delivery).toMatchObject({ status: 'failed', error: { code: 'DELIVERY_DIRECTORY_NOT_WRITABLE' } });
      expect(await readdir(business)).toEqual([]);
      expect(calls).toEqual(['chat']);
    } finally { await chmod(business, 0o700); }
  });

  it('detects a business directory replacement between temp sync and commit, touches no outside file, and recovers locally', async () => {
    const input = await prepared(); const realHome = await realpath(input.home);
    const parent = path.join(realHome, 'toctou-parent'); const business = path.join(parent, 'output');
    input.request.request_id = 'request-delivery-directory-toctou'; input.request.output.approved_srt_directory = business;
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    await mkdir(parent, { mode: 0o700 });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const review = await readVerifiedV5Review(directory);
    const outside = path.join(realHome, 'toctou-outside'); await mkdir(outside, { mode: 0o700 });
    const marker = path.join(outside, 'keep.txt'); await writeFile(marker, 'outside-unchanged', { mode: 0o600 });
    const moved = path.join(parent, 'output-original');
    await expect(deliverApprovedSrt(directory, review, { fault: async (point) => {
      if (point === 'after_temp_synced') { await rename(business, moved); await symlink(outside, business); }
    } })).rejects.toMatchObject({ code: 'DELIVERY_PATH_UNSAFE' });
    let task = await readV5Task(directory);
    expect(task.artifacts.approved?.validation).toBe('passed'); expect(task.delivery?.error?.code).toBe('DELIVERY_PATH_UNSAFE');
    expect(await readFile(marker, 'utf8')).toBe('outside-unchanged'); expect(await readdir(outside)).toEqual(['keep.txt']); expect(calls).toEqual(['chat']);
    await rm(business); await rename(moved, business);
    await deliverApprovedSrt(directory, review); task = await readV5Task(directory);
    expect(task.delivery).toMatchObject({ status: 'delivered', validation: 'passed' }); expect(calls).toEqual(['chat']);
  });

  it('rejects request hash mismatch before creating a task or dispatching a provider', async () => {
    const input = await prepared();
    input.request.inputs.transcript!.sha256 = '0'.repeat(64);
    await expect(submitExchangeRequest(input.workspace, input.request)).rejects.toMatchObject({ code: 'INPUT_HASH_MISMATCH' });
    const tasks = await (await import('node:fs/promises')).readdir(path.join(input.workspace, 'tasks'));
    expect(tasks).toHaveLength(0);
  });

  it('keeps active task actions, review readiness, delivery guidance, and retry reasons consistent', async () => {
    const input = await prepared();
    input.request.request_id = 'request-alpha2-active-projection-matrix';
    input.request.output.approved_srt_directory = path.join(input.home, 'business-output');
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const cases = [
      ['queued', '任务已入队', '当前 attempt 的队列中'],
      ['running', '正在后台处理', '当前 attempt 中处理'],
      ['pausing', '等待安全检查点', '正在等待安全暂停'],
      ['paused', 'task resume', '请使用 task resume 继续同一 attempt'],
      ['needs_input', '等待用户处理输入问题', '等待用户处理输入问题'],
    ] as const;

    for (const [status, deliveryText, retryText] of cases) {
      const task = structuredClone(submitted.task);
      task.status = status;
      task.execution.safe_checkpoint = status === 'paused' ? 'queued' : task.execution.safe_checkpoint;
      const view = await stableTaskView(input.workspace, task);
      expect(view.review).toEqual({ status: 'not_ready', pending_count: null });
      expect(view.delivery).toBeDefined();
      const delivery = view.delivery!;
      expect(delivery.status).toBe(status === 'needs_input' ? 'failed' : 'pending_review');
      expect(delivery.next_action).toContain(deliveryText);
      expect(delivery.next_action).not.toMatch(/完成人工审阅|finalize|task deliver/iu);
      expect(view.retry).toMatchObject({ allowed: false, reason: expect.stringContaining(retryText) });
      expect(view.retry.reason).not.toContain('RETRY_LEDGER_INVALID');
      const result = await stableTaskResult(input.workspace, task);
      expect(result.delivery).toEqual(view.delivery);
      expect(result.next_action).toBe(view.next_action);
      if (status === 'paused') {
        expect(view.resume).toEqual({ allowed: true, reason: null });
        expect(view.next_action).toContain('task resume');
      }
    }
  });

  it('pauses a queued Alpha.2 task immediately with zero Provider calls and resumes the same request safely', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-queued-pause';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const paused = await pauseV5Task(input.workspace, submitted.task);
    expect(paused).toMatchObject({ pending: false, task: { status: 'paused', execution: { safe_checkpoint: 'queued', attempt_id: null, attempt_count: 0 } } });
    expect((await readJob(input.workspace, submitted.task.identity.task_id)).state).toBe('paused');
    const view = await stableTaskView(input.workspace, await findTaskReadOnly(input.workspace, submitted.task.identity.task_id));
    expect(view).toMatchObject({ status: 'paused', capabilities: { pause: { supported: true }, resume: { supported: true } }, pause: { allowed: false }, resume: { allowed: true, reason: null } });
    const resumed = await resumeV5Task(input.workspace, paused.task);
    expect(resumed).toMatchObject({ status: 'queued', execution: { attempt_id: null, attempt_count: 0, control: { resume_count: 1, pause_requested_at: null, paused_at: null } } });
    const calls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    expect((await readV5Task(path.join(input.workspace, 'tasks', submitted.task.identity.task_directory))).status).toBe('completed');
    expect(calls).toEqual(['chat']);
  });

  it('serializes one hundred pause/resume requests and a claim/pause race through the task owner lock', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-control-concurrency';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const pauses = await Promise.all(Array.from({ length: 100 }, () => pauseV5Task(input.workspace, submitted.task)));
    expect(pauses.every((entry) => entry.task.status === 'paused')).toBe(true);
    const paused = await readV5Task(directory);
    const resumes = await Promise.all(Array.from({ length: 100 }, () => resumeV5Task(input.workspace, paused)));
    expect(resumes.every((entry) => entry.status === 'queued' && entry.execution.attempt_count === 0)).toBe(true);
    expect((await readV5Task(directory)).execution.control).toMatchObject({ resume_count: 1 });
    expect((await readV5Events(directory)).filter((event) => event.type === 'task_paused')).toHaveLength(1);
    expect((await readV5Events(directory)).filter((event) => event.type === 'task_resumed')).toHaveLength(1);

    const claimJob = await readJob(input.workspace, submitted.task.identity.task_id);
    const race = await Promise.allSettled([
      claimV5Job(input.workspace, claimJob, 'worker-race'),
      ...Array.from({ length: 99 }, () => pauseV5Task(input.workspace, submitted.task)),
    ]);
    expect(race.filter((entry) => entry.status === 'rejected').length).toBeLessThanOrEqual(99);
    const final = await readV5Task(directory);
    expect(['paused', 'pausing']).toContain(final.status);
    expect(final.execution.provider_calls).toMatchObject({ asr: { count: 0 }, chat: { count: 0 } });
    const events = await readV5Events(directory);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });

  it('waits for an in-flight Chat response, pauses at response_persisted, and resumes locally in the same attempt', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-inflight-pause';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = [];
    const baseFetch = fixtureFetch(calls);
    let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const blockingFetch = vi.fn(async (...args: Parameters<typeof fetch>) => { signalStarted(); await gate; return baseFetch(...args); });
    const worker = runWorker(input.workspace, { fetch: blockingFetch, readCredential: async () => 'fixture-secret' });
    await started;
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const requested = await pauseV5Task(input.workspace, await readV5Task(directory));
    expect(requested).toMatchObject({ pending: true, task: { status: 'pausing', execution: { provider_calls: { chat: { state: 'in_flight', count: 1, outcome: 'outcome_unknown' } } } } });
    release(); await worker;
    const paused = await readV5Task(directory);
    expect(paused).toMatchObject({ status: 'paused', execution: { safe_checkpoint: 'chat_response_persisted', attempt_count: 1, provider_calls: { chat: { state: 'response_persisted', count: 1 } } } });
    const attemptId = paused.execution.attempt_id;
    await resumeV5Task(input.workspace, paused);
    await runWorker(input.workspace, { fetch: blockingFetch, readCredential: async () => 'fixture-secret' });
    const completed = await readV5Task(directory);
    expect(completed).toMatchObject({ status: 'completed', execution: { attempt_id: attemptId, attempt_count: 1, provider_calls: { chat: { count: 1 } } } });
    expect(blockingFetch).toHaveBeenCalledTimes(1);
  });

  it('pins the actual Gemini budget through response_persisted pause/resume without replay', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'pause-gemini.mp3');
    const bytes = Buffer.alloc(417 * 80);
    for (let offset = 0; offset < bytes.length; offset += 417) bytes.set([0xff, 0xfb, 0x90, 0x64], offset);
    await writeFile(audio, bytes);
    const submitted = await submitExchangeRequest(input.workspace, {
      ...input.request,
      request_id: 'request-alpha2-gemini-budget-pause',
      inputs: { ...input.request.inputs, media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' } },
    });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await forceStrongEvidence(directory, true);
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let providerCalls = 0;
    const requests: any[] = [];
    const dependencies = {
      captureRequest: (request: Record<string, unknown>) => { requests.push(request); },
      createVertexClient: () => ({
        interactions: { create: async () => { throw new Error('unexpected'); } },
        models: {
          generateContent: async (request: any) => {
            providerCalls += 1;
            signalStarted();
            await gate;
            const prompt = request.contents[0].parts[0].text;
            const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
            return {
              responseId: 'gemini-budget-pause',
              finishReason: 'STOP',
              text: JSON.stringify({
                corrected_units: payload.calibration_units.map((unit: any) => ({
                  unit_id: unit.unit_id,
                  corrected_text: unit.original_text,
                  rationale: null,
                })),
              }),
            };
          },
        },
      }),
    };
    const worker = runWorker(input.workspace, dependencies);
    await started;
    expect((await pauseV5Task(input.workspace, await readV5Task(directory))).pending).toBe(true);
    release();
    await worker;

    const paused = await readV5Task(directory);
    expect(paused).toMatchObject({
      status: 'paused',
      execution: { safe_checkpoint: 'chat_response_persisted', provider_calls: { chat: { count: 1, state: 'response_persisted' } } },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].config.maxOutputTokens).toBe(12_288);
    const responsePath = path.join(directory, 'work/calibration-response.json');
    const responseBytes = await readFile(responsePath);
    const response = JSON.parse(responseBytes.toString('utf8'));
    expect(response.strategy.output_budget_tokens).toBe(12_288);
    expect(paused.execution.provider_calls.chat.evidence_sha256).toBe(sha(responseBytes));
    const responseFacts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry) => entry.contract === 'mercury.provider-call/v1' && entry.phase === 'response_persisted');
    expect(responseFacts).toEqual([
      expect.objectContaining({ attempt_id: paused.execution.attempt_id, evidence_sha256: sha(responseBytes) }),
    ]);

    await resumeV5Task(input.workspace, paused);
    await runWorker(input.workspace, dependencies);
    const completed = await readV5Task(directory);
    expect(completed.status).toBe('completed');
    expect(completed.execution.attempt_id).toBe(paused.execution.attempt_id);
    expect(completed.execution.provider_calls.chat.count).toBe(1);
    expect(providerCalls).toBe(1);
    expect(JSON.parse(await readFile(responsePath, 'utf8')).strategy.output_budget_tokens).toBe(12_288);
  });

  it('waits for an in-flight ASR response, then resumes from the pinned response without replaying ASR', async () => {
    const input = await prepared();
    const audio = path.join(input.home, 'pause-asr.mp3');
    const bytes = Buffer.alloc(834); bytes.set([0xff, 0xfb, 0x90, 0x64], 0); bytes.set([0xff, 0xfb, 0x90, 0x64], 417); await writeFile(audio, bytes);
    const registry = await loadModelRegistryV2(input.workspace);
    const request = {
      ...input.request, request_id: 'request-alpha2-inflight-asr-pause', transcription_mode: 'provider' as const,
      inputs: { media: { path: audio, sha256: sha(bytes), mime_type: 'audio/mpeg' as const }, transcript: null },
      models: { asr: registry.defaults.asr, chat: registry.defaults.chat },
    };
    const submitted = await submitExchangeRequest(input.workspace, request);
    const calls: string[] = []; const base = fixtureAsr(calls);
    let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const blockingAsr: AsrAdapter = {
      ...base,
      async run(asrInput) {
        const originalDispatch = asrInput.beforeProviderDispatch;
        return base.run({
          ...asrInput,
          beforeProviderDispatch: async (operation, evidence) => {
            await originalDispatch?.(operation, evidence); signalStarted(); await gate;
          },
        });
      },
    };
    const worker = runWorker(input.workspace, { asrAdapter: blockingAsr, fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    await started;
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    expect((await pauseV5Task(input.workspace, await readV5Task(directory))).pending).toBe(true);
    release(); await worker;
    const paused = await readV5Task(directory);
    expect(paused).toMatchObject({ status: 'paused', execution: { safe_checkpoint: 'asr_response_persisted', provider_calls: { asr: { state: 'response_persisted', count: 1 } } } });
    const attemptId = paused.execution.attempt_id;
    await resumeV5Task(input.workspace, paused);
    await runWorker(input.workspace, { asrAdapter: blockingAsr, fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
    const completed = await readV5Task(directory);
    expect(completed).toMatchObject({ status: 'completed', execution: { attempt_id: attemptId, attempt_count: 1, provider_calls: { asr: { count: 1 }, chat: { count: 1 } } } });
    expect(calls).toEqual(['asr', 'chat']);
  });

  it('lets cancellation win over an in-flight pause request at the next safe boundary', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-pause-cancel-race';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = []; const baseFetch = fixtureFetch(calls);
    let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const blockingFetch = vi.fn(async (...args: Parameters<typeof fetch>) => { signalStarted(); await gate; return baseFetch(...args); });
    const worker = runWorker(input.workspace, { fetch: blockingFetch, readCredential: async () => 'fixture-secret' });
    await started;
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await pauseV5Task(input.workspace, await readV5Task(directory));
    const cancelling = await cancelV5Task(input.workspace, await readV5Task(directory));
    expect(cancelling).toMatchObject({ pending: true, task: { status: 'pausing' } });
    release(); await worker;
    const cancelled = await readV5Task(directory);
    expect(cancelled).toMatchObject({ status: 'cancelled', execution: { provider_calls: { chat: { count: 1, outcome: 'response_persisted' } } } });
    expect(cancelled.artifacts.calibrated).toBeNull();
    expect(blockingFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects resume when pinned response evidence is damaged and leaves the paused task unchanged', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-resume-damaged';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = []; const baseFetch = fixtureFetch(calls);
    let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const blockingFetch = vi.fn(async (...args: Parameters<typeof fetch>) => { signalStarted(); await gate; return baseFetch(...args); });
    const worker = runWorker(input.workspace, { fetch: blockingFetch, readCredential: async () => 'fixture-secret' });
    await started;
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await pauseV5Task(input.workspace, await readV5Task(directory)); release(); await worker;
    const paused = await readV5Task(directory);
    await writeFile(path.join(directory, paused.execution.provider_calls.chat.evidence_ref!), '{}', { mode: 0o600 });
    await expect(resumeV5Task(input.workspace, paused)).rejects.toMatchObject({ code: 'TASK_RESUME_UNSAFE' });
    expect((await readV5Task(directory)).status).toBe('paused');
    expect((await readJob(input.workspace, paused.identity.task_id)).state).toBe('paused');
    expect(blockingFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects resume when the current attempt ledger is missing without replaying a persisted response', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-resume-attempt-ledger-damaged';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const calls: string[] = []; const baseFetch = fixtureFetch(calls);
    let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const blockingFetch = vi.fn(async (...args: Parameters<typeof fetch>) => { signalStarted(); await gate; return baseFetch(...args); });
    const worker = runWorker(input.workspace, { fetch: blockingFetch, readCredential: async () => 'fixture-secret' });
    await started;
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    await pauseV5Task(input.workspace, await readV5Task(directory)); release(); await worker;
    const paused = await readV5Task(directory);
    await writeFile(path.join(directory, 'attempts.jsonl'), '', { mode: 0o600 });
    const before = await directoryManifest(directory);
    await expect(resumeV5Task(input.workspace, paused)).rejects.toMatchObject({ code: 'TASK_RESUME_UNSAFE' });
    expect(await directoryManifest(directory)).toEqual(before);
    expect((await readV5Task(directory)).status).toBe('paused');
    expect(blockingFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a paused retry resume when its plan or historical ledger identity is damaged', async () => {
    const corruptions: Array<{ name: string; mutate: (records: any[]) => any[] }> = [
      { name: 'missing-retry', mutate: (records) => records.filter((record) => record.contract !== 'mercury.retry/v1') },
      { name: 'missing-history-call', mutate: (records) => records.filter((record) => !(record.contract === 'mercury.provider-call/v1' && record.call_number === 1)) },
      { name: 'plan-identity', mutate: (records) => records.map((record) => record.contract === 'mercury.retry/v1' ? { ...record, plan: { ...record.plan, attempt_id: 'att-wrong-previous' } } : record) },
      { name: 'current-attempt-identity', mutate: (records) => records.map((record) => record.contract === 'mercury.attempt/v1' && record.number === 2 ? { ...record, retry_plan_id: `rpl-${'e'.repeat(24)}` } : record) },
    ];
    for (const corruption of corruptions) {
      const input = await prepared(); input.request.request_id = `request-alpha2-paused-retry-${corruption.name}`;
      const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
      await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
      const first = await readV5Task(directory); const plan = await planV5Retry(directory, first);
      const queued = await executeV5Retry(input.workspace, first, plan.plan_id);
      const paused = (await pauseV5Task(input.workspace, queued)).task;
      const target = path.join(directory, 'attempts.jsonl');
      const records = (await readFile(target, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      await writeFile(target, `${corruption.mutate(records).map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
      const before = await directoryManifest(directory);
      await expect(resumeV5Task(input.workspace, paused)).rejects.toMatchObject({ code: 'TASK_RESUME_UNSAFE' });
      expect(await directoryManifest(directory)).toEqual(before);
      expect((await readV5Task(directory)).status).toBe('paused');
      expect((await readJob(input.workspace, paused.identity.task_id)).state).toBe('paused');
      expect(calls).toEqual(['chat']);
    }
  });

  it('resumes a valid paused retry attempt and closes only its planned second call/result', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-paused-retry-valid';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const first = await readV5Task(directory); const plan = await planV5Retry(directory, first);
    const queued = await executeV5Retry(input.workspace, first, plan.plan_id); const paused = (await pauseV5Task(input.workspace, queued)).task;
    const attemptId = paused.execution.attempt_id; const resumed = await resumeV5Task(input.workspace, paused);
    expect(resumed).toMatchObject({ status: 'queued', execution: { attempt_id: attemptId, attempt_count: 2, provider_calls: { chat: { count: 1 } } } });
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const failed = await readV5Task(directory);
    expect(failed).toMatchObject({ status: 'failed', execution: { attempt_id: attemptId, attempt_count: 2, provider_calls: { chat: { count: 2 } } } });
    expect((await planV5Retry(directory, failed)).allowed).toBe(true);
    const records = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(records.filter((record) => record.contract === 'mercury.attempt-result/v1')).toHaveLength(2);
    expect(records.filter((record) => record.contract === 'mercury.provider-call/v1' && record.call_number === 2 && record.phase === 'terminal')).toHaveLength(1);
    expect(calls).toEqual(['chat', 'chat']);
  });

  it('rejects response-persisted resume when pinned Provider call facts are missing or changed', async () => {
    for (const corruption of ['missing', 'model'] as const) {
      const input = await prepared(); input.request.request_id = `request-alpha2-persisted-ledger-${corruption}`;
      const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = []; const baseFetch = fixtureFetch(calls);
      let signalStarted!: () => void; const started = new Promise<void>((resolve) => { signalStarted = resolve; });
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      const blockingFetch = vi.fn(async (...args: Parameters<typeof fetch>) => { signalStarted(); await gate; return baseFetch(...args); });
      const worker = runWorker(input.workspace, { fetch: blockingFetch, readCredential: async () => 'fixture-secret' }); await started;
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
      await pauseV5Task(input.workspace, await readV5Task(directory)); release(); await worker;
      const paused = await readV5Task(directory); const target = path.join(directory, 'attempts.jsonl');
      const records = (await readFile(target, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const corrupted = corruption === 'missing'
        ? records.filter((record) => !(record.contract === 'mercury.provider-call/v1' && record.phase === 'response_persisted'))
        : records.map((record) => record.contract === 'mercury.provider-call/v1' ? { ...record, model_snapshot_entry_ref: 'wrong-persisted-model' } : record);
      await writeFile(target, `${corrupted.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
      const before = await directoryManifest(directory);
      await expect(resumeV5Task(input.workspace, paused)).rejects.toMatchObject({ code: 'TASK_RESUME_UNSAFE' });
      expect(await directoryManifest(directory)).toEqual(before); expect((await readV5Task(directory)).status).toBe('paused');
      expect(blockingFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps Alpha.1 v5 tasks without the optional control record readable but control-unsupported', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha1-control-compatibility';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const legacy = await readV5Task(directory); delete legacy.execution.control; await persistV5Task(directory, legacy);
    const manifest = await directoryManifest(directory);
    const record = await findTaskReadOnly(input.workspace, legacy.identity.task_id);
    expect((await stableTaskView(input.workspace, record)).capabilities.resume.supported).toBe(false);
    await expect(stablePauseTask(input.workspace, record)).rejects.toMatchObject({ code: 'CONTRACT_UNSUPPORTED' });
    expect(await directoryManifest(directory)).toEqual(manifest);
  });

  it('builds a deterministic read-only retry plan and executes one append-only Chat retry', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-known-chat';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const firstCalls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(firstCalls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const failed = await readV5Task(directory); const before = await directoryManifest(directory);
    const firstPlan = await planV5Retry(directory, failed); const secondPlan = await planV5Retry(directory, failed);
    expect(firstPlan).toEqual(secondPlan);
    expect(firstPlan).toMatchObject({ contract: 'mercury.retry-plan/v1', allowed: true, checkpoint: 'chat_not_started', provider_outcome: 'known_terminal', estimated_calls: { asr: 0, chat: 1 }, models: { asr: null, chat: failed.models.chat }, risk: 'new_provider_calls' });
    expect(await directoryManifest(directory)).toEqual(before);
    const stdout: string[] = []; const stderr: string[] = [];
    expect(await runCli(['task', 'retry-plan', failed.identity.task_id, '--json'], { homeDirectory: input.home, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) })).toBe(0);
    expect(stderr).toEqual([]); expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ contract: 'mercury.cli/v1', command: 'task.retry-plan', ok: true, data: { plan_id: firstPlan.plan_id, allowed: true, estimated_calls: { asr: 0, chat: 1 } } });
    expect(await directoryManifest(directory)).toEqual(before);
    const retried = await executeV5Retry(input.workspace, failed, firstPlan.plan_id);
    expect(retried).toMatchObject({ status: 'queued', execution: { attempt_count: 2, provider_calls: { chat: { state: 'not_started', count: 1, outcome: 'not_dispatched' } }, control: { retry_count: 1 } } });
    expect(retried.execution.attempt_id).not.toBe(failed.execution.attempt_id);
    const successCalls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(successCalls), readCredential: async () => 'fixture-secret' });
    const completed = await readV5Task(directory);
    expect(completed).toMatchObject({ status: 'completed', execution: { attempt_count: 2, provider_calls: { chat: { count: 2, outcome: 'response_persisted' } } } });
    expect(firstCalls).toEqual(['chat']); expect(successCalls).toEqual(['chat']);
    const attempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(attempts.filter((entry) => entry.contract === 'mercury.retry/v1' && entry.plan_id === firstPlan.plan_id)).toHaveLength(1);
    expect(attempts.filter((entry) => entry.contract === 'mercury.attempt/v1')).toHaveLength(2);
    expect(attempts.find((entry) => entry.contract === 'mercury.retry/v1')).toMatchObject({ previous_status: 'failed', previous_error: { code: 'FIXTURE_KNOWN_CHAT' } });
    const callFacts = attempts.filter((entry) => entry.contract === 'mercury.provider-call/v1');
    expect(new Set(callFacts.map((entry) => entry.call_id)).size).toBe(2);
    expect(callFacts.filter((entry) => entry.phase === 'dispatched')).toHaveLength(2);
    expect(callFacts.filter((entry) => entry.phase === 'response_persisted')).toHaveLength(1);
    expect(callFacts.filter((entry) => entry.phase === 'terminal')).toHaveLength(2);
    expect(callFacts.every((entry) => entry.model_snapshot_entry_ref && entry.capability === 'calibration')).toBe(true);
    expect(attempts.filter((entry) => entry.contract === 'mercury.attempt-result/v1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'failed', new_call_counts: { asr: 0, chat: 1 }, error_code: 'FIXTURE_KNOWN_CHAT' }),
      expect.objectContaining({ status: 'completed', new_call_counts: { asr: 0, chat: 1 }, error_code: null }),
    ]));
  });

  it('allows only one winner for 100 concurrent executions of the same retry plan', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-concurrent';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const failed = await readV5Task(directory);
    const plan = await planV5Retry(directory, failed);
    const outcomes = await Promise.allSettled(Array.from({ length: 100 }, () => executeV5Retry(input.workspace, failed, plan.plan_id)));
    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const task = await readV5Task(directory); expect(task).toMatchObject({ status: 'queued', execution: { attempt_count: 2 } });
    const attempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(attempts.filter((entry) => entry.contract === 'mercury.retry/v1')).toHaveLength(1);
    expect(attempts.filter((entry) => entry.contract === 'mercury.attempt/v1')).toHaveLength(2);
    expect(calls).toEqual(['chat']);
  });

  it('rejects a symlinked retry ledger without changing its external target or creating an attempt', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-ledger-symlink';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const failed = await readV5Task(directory);
    const plan = await planV5Retry(directory, failed);
    const attemptsPath = path.join(directory, 'attempts.jsonl');
    const outside = path.join(input.home, 'outside-attempts.jsonl');
    await writeFile(outside, await readFile(attemptsPath), { mode: 0o640 });
    await rm(attemptsPath); await symlink(outside, attemptsPath);
    const outsideBefore = { bytes: await readFile(outside), mode: (await stat(outside)).mode & 0o777 };
    const taskBefore = await readFile(path.join(directory, 'task.json'));
    const jobPath = path.join(input.workspace, 'runtime/jobs', `${failed.identity.task_id}.json`);
    const jobBefore = await readFile(jobPath);
    await expect(executeV5Retry(input.workspace, failed, plan.plan_id)).rejects.toMatchObject({ code: 'RETRY_LEDGER_INVALID' });
    expect(await readFile(outside)).toEqual(outsideBefore.bytes);
    expect((await stat(outside)).mode & 0o777).toBe(outsideBefore.mode);
    expect(await readFile(path.join(directory, 'task.json'))).toEqual(taskBefore);
    expect(await readFile(jobPath)).toEqual(jobBefore);
    expect(calls).toEqual(['chat']);
  });

  it('rejects a symlinked v5 event log without reading or modifying the external target', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-event-ledger-symlink';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const target = path.join(directory, 'events.jsonl'); const outside = path.join(input.home, 'outside-v5-events.jsonl');
    await writeFile(outside, await readFile(target), { mode: 0o640 });
    await rm(target); await symlink(outside, target);
    const before = { bytes: await readFile(outside), mode: (await stat(outside)).mode & 0o777 };
    await expect(appendV5Event(directory, await readV5Task(directory), 'test_event', 'must not escape')).rejects.toMatchObject({ code: 'EVENT_LOG_INVALID' });
    await expect(readV5Events(directory)).rejects.toMatchObject({ code: 'EVENT_LOG_INVALID' });
    expect(await readFile(outside)).toEqual(before.bytes);
    expect((await stat(outside)).mode & 0o777).toBe(before.mode);
  });

  it('rejects a symlinked attempt archive directory without writing outside or creating an attempt', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-archive-symlink';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const failed = await readV5Task(directory);
    const plan = await planV5Retry(directory, failed);
    const outside = path.join(input.home, 'outside-history'); await mkdir(outside, { mode: 0o755 });
    await writeFile(path.join(outside, 'keep.txt'), 'outside stays unchanged', { mode: 0o644 });
    await symlink(outside, path.join(directory, 'work/attempt-history'));
    const outsideBefore = await directoryManifest(outside);
    const attemptsBefore = await readFile(path.join(directory, 'attempts.jsonl'));
    await expect(executeV5Retry(input.workspace, failed, plan.plan_id)).rejects.toMatchObject({ code: 'RETRY_ARCHIVE_INVALID' });
    expect(await directoryManifest(outside)).toEqual(outsideBefore);
    expect(await readFile(path.join(directory, 'attempts.jsonl'))).toEqual(attemptsBefore);
    expect((await readV5Task(directory)).status).toBe('failed');
    expect((await readJob(input.workspace, failed.identity.task_id)).state).toBe('terminal');
    expect(calls).toEqual(['chat']);
  });

  it('keeps outcome_unknown retry plans read-only and rejects execution without replay', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-unknown';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const task = await readV5Task(directory); const at = '2026-08-17T00:00:00.000Z';
    task.status = 'running'; task.stage = 'calibrating'; task.execution.started_at = at; task.execution.worker_id = 'worker-unknown'; task.execution.heartbeat_at = at; task.execution.attempt_id = 'att-unknown'; task.execution.attempt_count = 1; task.execution.safe_checkpoint = null;
    await persistV5Task(directory, task);
    task.status = 'interrupted'; task.stage = null; task.execution.ended_at = at;
    task.execution.provider_calls.chat = {
      state: 'in_flight', count: 1, outcome: 'outcome_unknown', evidence_ref: null, evidence_sha256: null,
      call_id: 'pcl-fedcba9876543210fedcba98', capability: 'calibration', model_snapshot_entry_ref: `${task.identity.task_id}-chat`,
      dispatched_at: at, response_persisted_at: null, terminal_at: null,
    };
    task.error = { contract: 'mercury.error/v1', code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', category: 'provider', message: 'Provider 结果无法确认。', retryability: 'unsafe', provider_outcome: 'outcome_unknown', remediation: ['不要自动重试。'], technical: null, extensions: {} };
    await persistV5Task(directory, task); const job = await readJob(input.workspace, task.identity.task_id); job.state = 'terminal'; await (await import('../src/background/storage.js')).writeJob(input.workspace, job);
    const before = await directoryManifest(directory); const plan = await planV5Retry(directory);
    expect(plan).toMatchObject({ allowed: false, provider_outcome: 'outcome_unknown', risk: 'unsafe_provider_outcome', estimated_calls: { asr: 0, chat: 0 } });
    expect(await directoryManifest(directory)).toEqual(before);
    await expect(executeV5Retry(input.workspace, task, plan.plan_id)).rejects.toMatchObject({ code: 'RETRY_UNSAFE_PROVIDER_OUTCOME' });
    expect(await directoryManifest(directory)).toEqual(before);
    const stdout: string[] = []; const stderr: string[] = [];
    expect(await runCli(['task', 'retry', task.identity.task_id, '--plan', plan.plan_id, '--json'], { homeDirectory: input.home, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) })).toBe(3);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ contract: 'mercury.cli/v1', command: 'task.retry', ok: false, error: { code: 'RETRY_UNSAFE_PROVIDER_OUTCOME', retryability: 'unsafe', provider_outcome: 'outcome_unknown' } });
    expect(await directoryManifest(directory)).toEqual(before);
  });

  it('returns a read-only disallowed retry plan when a promised reuse artifact is damaged', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-reuse-damaged';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const failed = await readV5Task(directory);
    await writeFile(path.join(directory, failed.artifacts.transcribed!.path), 'tampered', { mode: 0o600 });
    const before = await directoryManifest(directory);
    const plan = await planV5Retry(directory, failed);
    expect(plan).toMatchObject({ allowed: false, estimated_calls: { asr: 0, chat: 0 }, requires_user_action: true, risk: 'none' });
    expect(plan.reason).toContain('RETRY_EVIDENCE_INVALID');
    expect(await directoryManifest(directory)).toEqual(before);
    await expect(executeV5Retry(input.workspace, failed, plan.plan_id)).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' });
    expect(await directoryManifest(directory)).toEqual(before);
    expect(calls).toEqual(['chat']);
  });

  it('refreshes an expired read-only plan without changing the task and rejects the old plan', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-expired-refresh';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const failed = await readV5Task(directory);
    const plan = await planV5Retry(directory, failed, new Date(failed.updated_at));
    const afterExpiry = new Date(new Date(plan.expires_at).getTime() + 1);
    const beforeRefresh = await directoryManifest(directory);
    const refreshed = await planV5Retry(directory, failed, afterExpiry);
    expect(refreshed.plan_id).not.toBe(plan.plan_id);
    expect(new Date(refreshed.created_at).getTime()).toBe(new Date(plan.expires_at).getTime());
    expect(new Date(refreshed.expires_at).getTime()).toBeGreaterThan(afterExpiry.getTime());
    expect(await directoryManifest(directory)).toEqual(beforeRefresh);
    await expect(executeV5Retry(input.workspace, failed, plan.plan_id, afterExpiry)).rejects.toMatchObject({ code: 'RETRY_PLAN_EXPIRED' });
    expect(await directoryManifest(directory)).toEqual(beforeRefresh);
    expect(await executeV5Retry(input.workspace, failed, refreshed.plan_id, afterExpiry)).toMatchObject({ status: 'queued', execution: { attempt_count: 2 } });
    expect(calls).toEqual(['chat']);
  });

  it('rejects a retry plan after the task revision changes', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-stale';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const failed = await readV5Task(directory); const plan = await planV5Retry(directory, failed);
    await appendV5Event(directory, failed, 'fixture_revision_changed', 'fixture revision changed');
    const before = await directoryManifest(directory);
    await expect(executeV5Retry(input.workspace, failed, plan.plan_id)).rejects.toMatchObject({ code: 'RETRY_PLAN_STALE' });
    expect(await directoryManifest(directory)).toEqual(before);
  });

  it('keeps retry-plan/status/result read-only and rejects missing or malformed complete ledger records', async () => {
    for (const corruption of ['missing', 'malformed'] as const) {
      const input = await prepared(); input.request.request_id = `request-alpha2-retry-ledger-${corruption}`;
      const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
      await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const failed = await readV5Task(directory);
      await writeFile(path.join(directory, 'attempts.jsonl'), corruption === 'missing' ? '' : 'not-json\n', { mode: 0o600 });
      const before = await directoryManifest(directory);
      const plan = await planV5Retry(directory, failed);
      expect(plan).toMatchObject({ allowed: false, estimated_calls: { asr: 0, chat: 0 } });
      expect(plan.reason).toContain('RETRY_LEDGER_INVALID');
      const record = await findTaskReadOnly(input.workspace, failed.identity.task_id);
      expect((await stableTaskView(input.workspace, record)).retry).toMatchObject({ allowed: false });
      expect((await stableTaskResult(input.workspace, record)).status).toBe('failed');
      expect(await directoryManifest(directory)).toEqual(before);
      await expect(executeV5Retry(input.workspace, failed, plan.plan_id)).rejects.toMatchObject({ code: 'RETRY_LEDGER_INVALID' });
      expect(await directoryManifest(directory)).toEqual(before);
      expect(calls).toEqual(['chat']);
    }
  });

  it('rejects retry ledgers with broken task, attempt, result, or Provider call identity', async () => {
    const corruptions: Array<{ name: string; mutate: (records: any[]) => any[] }> = [
      { name: 'task-identity', mutate: (records) => records.map((record, index) => index === 0 ? { ...record, task_id: 'tsk-20260817-000000-deadbeef' } : record) },
      { name: 'missing-result', mutate: (records) => records.filter((record) => record.contract !== 'mercury.attempt-result/v1') },
      { name: 'result-call-count', mutate: (records) => records.map((record) => record.contract === 'mercury.attempt-result/v1' ? { ...record, ending_call_counts: { ...record.ending_call_counts, chat: 0 } } : record) },
      { name: 'provider-model-identity', mutate: (records) => records.map((record) => record.contract === 'mercury.provider-call/v1' ? { ...record, model_snapshot_entry_ref: 'wrong-model-entry' } : record) },
    ];
    for (const corruption of corruptions) {
      const input = await prepared(); input.request.request_id = `request-alpha2-ledger-identity-${corruption.name}`;
      const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
      await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const failed = await readV5Task(directory);
      const target = path.join(directory, 'attempts.jsonl');
      const records = (await readFile(target, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      await writeFile(target, `${corruption.mutate(records).map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
      const before = await directoryManifest(directory); const plan = await planV5Retry(directory, failed);
      expect(plan).toMatchObject({ allowed: false, reason: expect.stringContaining('RETRY_LEDGER_INVALID') });
      expect(await directoryManifest(directory)).toEqual(before);
      await expect(executeV5Retry(input.workspace, failed, plan.plan_id)).rejects.toMatchObject({ code: 'RETRY_LEDGER_INVALID' });
      expect(await directoryManifest(directory)).toEqual(before); expect(calls).toEqual(['chat']);
    }
  });

  it('closes the complete multi-attempt retry, plan, result, and Provider call history before attempt 3', async () => {
    const failTwice = async (requestId: string) => {
      const input = await prepared(); input.request.request_id = requestId;
      const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
      await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
      const first = await readV5Task(directory); const firstPlan = await planV5Retry(directory, first);
      await executeV5Retry(input.workspace, first, firstPlan.plan_id);
      await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
      return { input, directory, failed: await readV5Task(directory), calls };
    };

    const valid = await failTwice('request-alpha2-history-valid-attempt3');
    const validManifest = await directoryManifest(valid.directory); const validPlan = await planV5Retry(valid.directory, valid.failed);
    expect(validPlan.allowed).toBe(true); expect(await directoryManifest(valid.directory)).toEqual(validManifest);
    const third = await executeV5Retry(valid.input.workspace, valid.failed, validPlan.plan_id);
    expect(third).toMatchObject({ status: 'queued', execution: { attempt_count: 3, provider_calls: { chat: { count: 2 } } } });
    const validRecords = (await readFile(path.join(valid.directory, 'attempts.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(validRecords.filter((record) => record.contract === 'mercury.attempt/v1').map((record) => record.number)).toEqual([1, 2, 3]);
    expect(validRecords.filter((record) => record.contract === 'mercury.retry/v1')).toHaveLength(2);
    expect(valid.calls).toEqual(['chat', 'chat']);

    const corruptions: Array<{ name: string; mutate: (records: any[]) => any[] }> = [
      { name: 'missing-retry', mutate: (records) => records.filter((record) => !(record.contract === 'mercury.retry/v1' && record.plan_id === records.find((entry) => entry.contract === 'mercury.attempt/v1' && entry.number === 2)?.retry_plan_id)) },
      { name: 'missing-call1', mutate: (records) => records.filter((record) => !(record.contract === 'mercury.provider-call/v1' && record.call_number === 1)) },
      { name: 'historical-call-model', mutate: (records) => records.map((record) => record.contract === 'mercury.provider-call/v1' && record.call_number === 1 ? { ...record, model_snapshot_entry_ref: 'wrong-historical-model' } : record) },
      { name: 'historical-call-attempt', mutate: (records) => {
        const secondAttempt = records.find((record) => record.contract === 'mercury.attempt/v1' && record.number === 2)?.attempt_id;
        return records.map((record) => record.contract === 'mercury.provider-call/v1' && record.call_number === 1 ? { ...record, attempt_id: secondAttempt } : record);
      } },
      { name: 'duplicate-retry', mutate: (records) => [...records, { ...records.find((record) => record.contract === 'mercury.retry/v1') }] },
      { name: 'orphan-retry', mutate: (records) => {
        const retry = structuredClone(records.find((record) => record.contract === 'mercury.retry/v1'));
        retry.plan_id = `rpl-${'f'.repeat(24)}`; retry.plan.plan_id = retry.plan_id;
        return [...records, retry];
      } },
      { name: 'duplicate-call', mutate: (records) => [...records, { ...records.find((record) => record.contract === 'mercury.provider-call/v1' && record.call_number === 1 && record.phase === 'dispatched') }] },
      { name: 'orphan-call', mutate: (records) => {
        const call = structuredClone(records.find((record) => record.contract === 'mercury.provider-call/v1' && record.call_number === 2));
        call.call_number = 3; call.call_id = 'pcl-orphan-history-call';
        return [...records, call];
      } },
    ];
    for (const corruption of corruptions) {
      const fixture = await failTwice(`request-alpha2-history-${corruption.name}`); const target = path.join(fixture.directory, 'attempts.jsonl');
      const records = (await readFile(target, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      await writeFile(target, `${corruption.mutate(records).map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
      const before = await directoryManifest(fixture.directory); const plan = await planV5Retry(fixture.directory, fixture.failed);
      expect(plan).toMatchObject({ allowed: false, reason: expect.stringContaining('RETRY_LEDGER_INVALID') });
      const record = await findTaskReadOnly(fixture.input.workspace, fixture.failed.identity.task_id);
      expect((await stableTaskView(fixture.input.workspace, record)).retry).toMatchObject({ allowed: false });
      expect((await stableTaskResult(fixture.input.workspace, record)).status).toBe('failed');
      expect(await readV5Events(fixture.directory)).not.toHaveLength(0);
      expect(await directoryManifest(fixture.directory)).toEqual(before);
      await expect(executeV5Retry(fixture.input.workspace, fixture.failed, plan.plan_id)).rejects.toMatchObject({ code: 'RETRY_LEDGER_INVALID' });
      expect(await directoryManifest(fixture.directory)).toEqual(before); expect(fixture.calls).toEqual(['chat', 'chat']);
    }
  }, 30_000);

  it('ignores a trailing partial retry record during read-only planning and repairs it only during execute', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-retry-ledger-trailing-partial';
    const submitted = await submitExchangeRequest(input.workspace, input.request); const calls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(calls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory); const failed = await readV5Task(directory);
    await writeFile(path.join(directory, 'attempts.jsonl'), '{"partial":', { flag: 'a' });
    const before = await directoryManifest(directory); const plan = await planV5Retry(directory, failed);
    expect(plan.allowed).toBe(true); expect(await directoryManifest(directory)).toEqual(before);
    await executeV5Retry(input.workspace, failed, plan.plan_id);
    const source = await readFile(path.join(directory, 'attempts.jsonl'), 'utf8');
    expect(source).not.toContain('{"partial":');
    expect(source.endsWith('\n')).toBe(true);
    expect(calls).toEqual(['chat']);
  });

  it('replays queued pause/resume idempotently and repairs every local control commit window', async () => {
    for (const point of ['after_pause_task_committed', 'after_pause_job_committed'] as const) {
      const input = await prepared(); input.request.request_id = `request-alpha2-pause-crash-${point}`;
      const submitted = await submitExchangeRequest(input.workspace, input.request);
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
      await expect(pauseV5Task(input.workspace, submitted.task, async (seen) => { if (seen === point) throw new Error(point); })).rejects.toThrow(point);
      await auditV5Job(input.workspace, await readJob(input.workspace, submitted.task.identity.task_id));
      const paused = await readV5Task(directory);
      expect(paused).toMatchObject({ status: 'paused', execution: { attempt_id: null, attempt_count: 0, safe_checkpoint: 'queued', provider_calls: { asr: { count: 0 }, chat: { count: 0 } } } });
      expect((await readJob(input.workspace, paused.identity.task_id)).state).toBe('paused');
      expect((await readV5Events(directory)).filter((event) => event.type === 'task_paused')).toHaveLength(1);
      const replayManifest = await directoryManifest(directory);
      await pauseV5Task(input.workspace, paused);
      expect(await directoryManifest(directory)).toEqual(replayManifest);
    }

    for (const point of ['after_resume_task_committed', 'after_resume_job_committed'] as const) {
      const input = await prepared(); input.request.request_id = `request-alpha2-resume-crash-${point}`;
      const submitted = await submitExchangeRequest(input.workspace, input.request);
      const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
      const paused = (await pauseV5Task(input.workspace, submitted.task)).task;
      await expect(resumeV5Task(input.workspace, paused, async (seen) => { if (seen === point) throw new Error(point); })).rejects.toThrow(point);
      await auditV5Job(input.workspace, await readJob(input.workspace, submitted.task.identity.task_id));
      const resumed = await readV5Task(directory);
      expect(resumed).toMatchObject({ status: 'queued', execution: { attempt_id: null, attempt_count: 0, control: { resume_count: 1 } } });
      expect((await readJob(input.workspace, resumed.identity.task_id)).state).toBe('queued');
      expect((await readV5Events(directory)).filter((event) => event.type === 'task_resumed')).toHaveLength(1);
      const replayManifest = await directoryManifest(directory);
      await resumeV5Task(input.workspace, resumed);
      expect(await directoryManifest(directory)).toEqual(replayManifest);
      const calls: string[] = [];
      await runWorker(input.workspace, { fetch: fixtureFetch(calls), readCredential: async () => 'fixture-secret' });
      expect((await readV5Task(directory)).execution).toMatchObject({ attempt_count: 1, provider_calls: { chat: { count: 1 } } });
      expect(calls).toEqual(['chat']);
    }
  });

  it('keeps REVIEW_NOT_READY aligned with the active task action and strictly read-only', async () => {
    const input = await prepared(); input.request.request_id = 'request-alpha2-review-not-ready-action';
    const submitted = await submitExchangeRequest(input.workspace, input.request);
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);

    for (const status of ['queued', 'running', 'pausing', 'paused', 'needs_input'] as const) {
      const candidate = structuredClone(submitted.task);
      candidate.status = status;
      try {
        assertStableReviewReady(candidate);
        throw new Error(`expected REVIEW_NOT_READY for ${status}`);
      } catch (error) {
        expect(error).toMatchObject({ code: 'REVIEW_NOT_READY', exitCode: 3 });
        const remediation = (error as { remediation: string }).remediation;
        expect(remediation).not.toContain('核对命令');
        expect(remediation).not.toContain('finalize');
        expect(remediation).not.toContain('deliver');
        if (status === 'paused') expect(remediation).toContain(`mercury task resume ${submitted.task.identity.task_id} --json`);
      }
    }

    const queuedBefore = await directoryManifest(directory);
    const queuedOutput: string[] = [];
    expect(await runCli(['review', 'status', submitted.task.identity.task_id, '--json'], {
      homeDirectory: input.home,
      stdout: (line) => queuedOutput.push(line),
      stderr: () => { throw new Error('stable review must not use stderr'); },
    })).toBe(3);
    expect(JSON.parse(queuedOutput[0]!)).toMatchObject({
      contract: 'mercury.cli/v1', command: 'review.status', ok: false,
      error: { code: 'REVIEW_NOT_READY', category: 'conflict', retryability: 'after_user_action', remediation: [expect.stringContaining('worker start')] },
    });
    expect(await directoryManifest(directory)).toEqual(queuedBefore);

    const paused = (await pauseV5Task(input.workspace, submitted.task)).task;
    const pausedBefore = await directoryManifest(directory);
    const pausedOutput: string[] = [];
    expect(await runCli(['review', 'list', paused.identity.task_id, '--limit', '10', '--json'], {
      homeDirectory: input.home,
      stdout: (line) => pausedOutput.push(line),
      stderr: () => { throw new Error('stable review must not use stderr'); },
    })).toBe(3);
    const pausedError = JSON.parse(pausedOutput[0]!).error;
    expect(pausedError).toMatchObject({ code: 'REVIEW_NOT_READY', category: 'conflict', retryability: 'after_user_action' });
    expect(pausedError.remediation).toEqual([expect.stringContaining(`mercury task resume ${paused.identity.task_id} --json`)]);
    expect(JSON.stringify(pausedError)).not.toMatch(/finalize|deliver|核对命令/iu);
    expect(await directoryManifest(directory)).toEqual(pausedBefore);
  });

  it.each(['after_retry_ledger_appended', 'after_retry_task_committed', 'after_retry_job_committed'] as const)('recovers the retry %s window with one append-only attempt and no duplicate call', async (point) => {
    const input = await prepared(); input.request.request_id = `request-alpha2-retry-crash-${point}`;
    const submitted = await submitExchangeRequest(input.workspace, input.request); const failedCalls: string[] = [];
    await runWorker(input.workspace, { chatRuntime: knownFailureChat(failedCalls) });
    const directory = path.join(input.workspace, 'tasks', submitted.task.identity.task_directory);
    const failed = await readV5Task(directory); const plan = await planV5Retry(directory, failed);
    await expect(executeV5Retry(input.workspace, failed, plan.plan_id, new Date(), async (seen) => { if (seen === point) throw new Error(point); })).rejects.toThrow(point);
    const successCalls: string[] = [];
    await runWorker(input.workspace, { fetch: fixtureFetch(successCalls), readCredential: async () => 'fixture-secret' });
    const completed = await readV5Task(directory);
    expect(completed).toMatchObject({ status: 'completed', execution: { attempt_count: 2, control: { retry_count: 1 }, provider_calls: { chat: { count: 2 } } } });
    expect(failedCalls).toEqual(['chat']); expect(successCalls).toEqual(['chat']);
    const events = await readV5Events(directory);
    expect(events.filter((event) => event.type === 'retry_scheduled')).toHaveLength(1);
    const attempts = (await readFile(path.join(directory, 'attempts.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(attempts.filter((entry) => entry.contract === 'mercury.retry/v1')).toHaveLength(1);
    expect(attempts.filter((entry) => entry.contract === 'mercury.attempt/v1')).toHaveLength(2);
    expect(attempts.find((entry) => entry.contract === 'mercury.retry/v1')).toMatchObject({ actor: 'user', plan: { plan_id: plan.plan_id } });
    expect((await stableTaskResult(input.workspace, await findTaskReadOnly(input.workspace, completed.identity.task_id))).calls.find((entry) => entry.capability === 'calibration')).toMatchObject({ count: 2, outcome: 'mixed' });
  });
});

function parseSrt(source: string): Array<{ start: string; end: string }> {
  return [...source.matchAll(/^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/gmu)].map((match) => ({ start: match[1]!, end: match[2]! }));
}
