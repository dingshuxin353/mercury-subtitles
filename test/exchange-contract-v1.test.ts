import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXCHANGE_CONTRACTS,
  assertExchangeContract,
  validateV5TaskRecord,
  exchangeSchemaDocuments,
  validateExchangeContract,
  type ExchangeDictionaryV1,
  type ExchangeRequestV1,
  type ExchangeTranscriptV1,
} from '../src/contracts/index.js';
import {
  appendStableJsonLine,
  projectMachineTaskToExchangeResult,
  projectMachineTaskToExchangeTask,
  readStableJson,
  repairTrailingJsonlFragment,
  writeStableJsonAtomic,
} from '../src/exchange/index.js';
import type { MachineTaskView } from '../src/background/types.js';

const roots: string[] = [];
const hash = 'a'.repeat(64);
const now = '2026-08-16T12:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => (await import('node:fs/promises')).rm(root, { recursive: true, force: true })));
});

function request(overrides: Partial<ExchangeRequestV1> = {}): ExchangeRequestV1 {
  return {
    contract: 'mercury.exchange.request/v1',
    request_id: 'req-test-001',
    created_at: now,
    operation: 'subtitle_calibration',
    inputs: {
      media: { path: '/tmp/audio.mp3', sha256: hash, mime_type: 'audio/mpeg' },
      transcript: null,
    },
    transcription_mode: 'provider',
    calibration: { mode: 'text-only', source_language: 'zh-CN' },
    models: { asr: 'asr-default', chat: 'chat-default' },
    dictionaries: { project_key: null, selected: [], task_overrides: [] },
    output: { formats: ['srt', 'report'], workspace_policy: 'managed' },
    extensions: {},
    ...overrides,
  };
}

function transcript(): ExchangeTranscriptV1 {
  return {
    contract: 'mercury.transcript/v1',
    transcript_id: 'trn-0123456789abcdef',
    created_at: now,
    language: 'zh-CN',
    duration_ms: 2000,
    text: '你好\n世界',
    segments: [
      { segment_id: 'seg-00000001', index: 0, start_ms: 0, end_ms: 900, text: '你好', words: [] },
      { segment_id: 'seg-00000002', index: 1, start_ms: 1000, end_ms: 1800, text: '世界', words: [] },
    ],
    source: { kind: 'provided', format: 'srt', system: 'fixture', external_id: null, generated_at: now, content_sha256: hash, original_path: '/tmp/input.srt', original_sha256: hash, normalized_sha256: hash },
    warnings: [],
    extensions: {},
  };
}

function dictionary(): ExchangeDictionaryV1 {
  return {
    contract: 'mercury.dictionary/v1', dictionary_id: 'dict-demo', scope: 'global', project_key: null,
    name: '演示词典', revision: 'rev-123456789abc', content_hash: hash, created_at: now, updated_at: now,
    enabled: true, is_default: false, entries: [{
      entry_id: 'entry-wan', kind: 'product', canonical: 'Wan 3.0', variants: ['千问万 3.0'], language: 'zh-CN',
      case_sensitive: true, number_sensitive: true, notes: null, tags: ['video'], enabled: true, created_at: now, updated_at: now,
    }], extensions: {},
  };
}

describe('Exchange Protocol v1 contracts', () => {
  it('ships all seven stable contract identities and schemas', () => {
    expect(EXCHANGE_CONTRACTS).toEqual({
      request: 'mercury.exchange.request/v1', task: 'mercury.task/v1', event: 'mercury.event/v1',
      result: 'mercury.result/v1', error: 'mercury.error/v1', transcript: 'mercury.transcript/v1', dictionary: 'mercury.dictionary/v1',
    });
    expect(Object.keys(exchangeSchemaDocuments()).sort()).toEqual(['common', 'dictionary', 'error', 'event', 'request', 'result', 'task', 'transcript']);
  });

  it('enforces explicit provider/provided transcription roles', () => {
    expect(validateExchangeContract('request', request()).valid).toBe(true);
    const provided = request({
      transcription_mode: 'provided', models: { asr: null, chat: 'chat-default' },
      inputs: { media: null, transcript: { path: '/tmp/input.srt', sha256: hash, format: 'srt', role: 'transcript_source' } },
    });
    expect(validateExchangeContract('request', provided).valid).toBe(true);
    expect(validateExchangeContract('request', { ...provided, models: { asr: 'asr-default', chat: 'chat-default' } }).valid).toBe(false);
    expect(validateExchangeContract('request', { ...provided, inputs: { ...provided.inputs, transcript: { ...provided.inputs.transcript!, role: 'reference' } } }).valid).toBe(false);
  });

  it('rejects transcript gaps in identity, order, overlap, full text and word bounds', () => {
    expect(validateExchangeContract('transcript', transcript()).valid).toBe(true);
    const bad = transcript();
    bad.text = '被截断';
    bad.segments[1]!.index = 4;
    bad.segments[1]!.start_ms = 800;
    bad.segments[0]!.words.push({ text: '越界', start_ms: 800, end_ms: 1000, confidence: null });
    const result = validateExchangeContract('transcript', bad);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((entry) => entry.path)).toEqual(expect.arrayContaining(['/text', '/segments/1/index', '/segments/1/start_ms', '/segments/0/words/0']));
  });

  it('rejects dictionary identity conflicts and project scope mismatch', () => {
    expect(validateExchangeContract('dictionary', dictionary()).valid).toBe(true);
    const bad = dictionary();
    bad.scope = 'project';
    bad.entries.push({ ...bad.entries[0]!, entry_id: 'entry-other', canonical: 'Another', variants: ['千问万 3.0'] });
    const result = validateExchangeContract('dictionary', bad);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((entry) => entry.path)).toContain('/project_key');
  });

  it('rejects secret-shaped extension keys', () => {
    const bad = request({ extensions: { 'com.example': { authorization: 'Bearer secret' } } });
    expect(() => assertExchangeContract('request', bad)).toThrowError(/credential|凭据/iu);
  });

  it('rejects secret-shaped values throughout extensions, event data, errors, transcripts, and dictionaries', () => {
    const secret = `Authorization: Bearer ${'x'.repeat(40)}`;
    expect(validateExchangeContract('request', request({ extensions: { 'com.example': { note: secret } } })).valid).toBe(false);
    expect(validateExchangeContract('event', {
      contract: 'mercury.event/v1', event_id: 'evt-1234567890abcdef', task_id: 'tsk-20260816-120000-deadbeef', sequence: 1,
      occurred_at: now, type: 'fixture', severity: 'error', task_revision: 1, attempt_id: null, stage: null, progress: null,
      message: '失败', data: { note: secret }, extensions: {},
    }).valid).toBe(false);
    expect(validateExchangeContract('error', {
      contract: 'mercury.error/v1', code: 'FIXTURE_ERROR', category: 'runtime', message: '失败', retryability: 'not_applicable',
      provider_outcome: 'not_applicable', remediation: ['检查输入。'], technical: { provider_code: null, log_id: null, detail: secret }, extensions: {},
    }).valid).toBe(false);
    const secretTranscript = transcript(); secretTranscript.extensions = { 'com.example': { note: secret } };
    expect(validateExchangeContract('transcript', secretTranscript).valid).toBe(false);
    const secretDictionary = dictionary(); secretDictionary.entries[0]!.notes = secret;
    expect(validateExchangeContract('dictionary', secretDictionary).valid).toBe(false);
  });

  it('rejects deeply nested and oversized arbitrary JSON before schema evaluation', () => {
    const deep: Record<string, unknown> = {}; let cursor = deep;
    for (let index = 0; index < 25; index += 1) { const child: Record<string, unknown> = {}; cursor.next = child; cursor = child; }
    const deepResult = validateExchangeContract('request', request({ extensions: { 'com.example': deep } }));
    expect(deepResult.valid).toBe(false);
    if (!deepResult.valid) expect(deepResult.issues.some((entry) => entry.message.includes('递归深度'))).toBe(true);
    const largeResult = validateExchangeContract('request', request({ extensions: { 'com.example': { note: 'x'.repeat(1_000_000) } } }));
    expect(largeResult.valid).toBe(false);
    if (!largeResult.valid) expect(largeResult.issues.some((entry) => entry.message.includes('单个字符串'))).toBe(true);
  });

  it('validates complete internal v5 state and rejects missing fields or impossible combinations', () => {
    const record: any = {
      schema_version: '5.0.0',
      identity: { task_id: 'tsk-20260816-120000-deadbeef', request_id: 'req-test-001', request_fingerprint: hash, task_directory: 'tsk-20260816-120000-deadbeef-demo', revision: 0 },
      created_at: now, updated_at: now, status: 'queued', stage: null,
      input_config: { transcription_mode: 'provided', calibration_mode: 'text-only', source_language: 'zh-CN', evidence_mode: 'text' },
      inputs: {
        media: null,
        transcript_source: { original_path: '/tmp/input.srt', workspace_path: 'input/transcript-source.srt', sha256: hash, bytes: 10, mime_type: 'application/x-subrip', format: 'srt', role: 'transcript_source' },
        reference: null,
        reference_normalized: null,
      },
      calibration_sources: {
        transcript: { path: 'work/transcript.raw.json', sha256: hash, validation: 'passed' },
        reference: null,
      },
      models: { asr: null, chat: 'chat-default', snapshot_path: 'work/model-snapshot.json', snapshot_sha256: hash },
      dictionary_snapshot: { path: 'work/dictionary-snapshot.json', sha256: hash, resolved: [] },
      execution: {
        queued_at: now, started_at: null, ended_at: null, worker_id: null, heartbeat_at: null, attempt_id: null, attempt_count: 0,
        safe_checkpoint: 'queued', cancel_requested_at: null,
        provider_calls: {
          asr: { state: 'not_started', count: 0, outcome: 'not_dispatched', evidence_ref: null, evidence_sha256: null },
          chat: { state: 'not_started', count: 0, outcome: 'not_dispatched', evidence_ref: null, evidence_sha256: null },
        },
      },
      artifacts: { transcript: null, transcribed: null, calibrated: null, approved: null, report: null },
      review: { status: 'not_ready', pending_count: null }, warnings: [], error: null,
    };
    expect(validateV5TaskRecord(record).valid).toBe(true);
    const legacyProvidedReference = structuredClone(record);
    legacyProvidedReference.calibration_sources.reference = { path: 'input/reference.srt', sha256: hash, validation: 'passed' };
    expect(validateV5TaskRecord(legacyProvidedReference).valid).toBe(true);
    const unexpectedSyntheticReference = structuredClone(record);
    unexpectedSyntheticReference.calibration_sources.reference = { path: 'input/not-a-legacy-reference.srt', sha256: hash, validation: 'passed' };
    expect(validateV5TaskRecord(unexpectedSyntheticReference).valid).toBe(false);
    const missing = structuredClone(record);
    delete missing.inputs;
    expect(validateV5TaskRecord(missing).valid).toBe(false);
    const repeatedAsr = structuredClone(record);
    repeatedAsr.execution.provider_calls.asr = { state: 'terminal', count: 1, outcome: 'known_terminal', evidence_ref: null, evidence_sha256: null };
    expect(validateV5TaskRecord(repeatedAsr).valid).toBe(false);
    const unpinnedResponse = structuredClone(record);
    unpinnedResponse.execution.provider_calls.chat = { state: 'response_persisted', count: 1, outcome: 'response_persisted', evidence_ref: 'work/calibration-response.json', evidence_sha256: null };
    expect(validateV5TaskRecord(unpinnedResponse).valid).toBe(false);
    const unnormalizedReference = structuredClone(record);
    unnormalizedReference.input_config.transcription_mode = 'provider';
    unnormalizedReference.models.asr = 'asr-default';
    unnormalizedReference.inputs.media = { original_path: '/tmp/audio.mp3', workspace_path: 'input/audio.mp3', sha256: hash, bytes: 10, mime_type: 'audio/mpeg' };
    unnormalizedReference.inputs.transcript_source = null;
    unnormalizedReference.inputs.reference = { original_path: '/tmp/reference.srt', workspace_path: 'input/reference-source.srt', sha256: hash, bytes: 10, mime_type: 'application/x-subrip', format: 'srt', role: 'reference' };
    unnormalizedReference.inputs.reference_normalized = null;
    expect(validateV5TaskRecord(unnormalizedReference).valid).toBe(false);
    const impossible = structuredClone(record);
    impossible.status = 'completed';
    impossible.execution.ended_at = now;
    expect(validateV5TaskRecord(impossible).valid).toBe(false);
    const secretTask = structuredClone(record);
    secretTask.warnings = [`${'Author'}ization: ${'Bear'}er ${'x'.repeat(40)}`];
    expect(validateV5TaskRecord(secretTask).valid).toBe(false);
  });
});

describe('stable storage and history projection', () => {
  it('writes deterministic newline-terminated 0600 JSON atomically', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mercury-exchange-'));
    roots.push(root);
    const target = path.join(root, 'request.json');
    await writeStableJsonAtomic(target, { z: 1, a: { c: 2, b: 1 } });
    expect(await readFile(target, 'utf8')).toBe('{\n  "a": {\n    "b": 1,\n    "c": 2\n  },\n  "z": 1\n}\n');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readStableJson(target)).toEqual({ a: { b: 1, c: 2 }, z: 1 });
  });

  it('rejects oversized stable JSON files before parsing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mercury-exchange-large-'));
    roots.push(root);
    const target = path.join(root, 'large.json');
    await writeFile(target, `${JSON.stringify({ payload: 'x'.repeat(8 * 1024 * 1024) })}\n`);
    await expect(readStableJson(target, 'REQUEST_INVALID')).rejects.toMatchObject({ code: 'REQUEST_INVALID' });
  });

  it('repairs only a trailing half-line and rejects middle corruption', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mercury-events-'));
    roots.push(root);
    const target = path.join(root, 'events.jsonl');
    await appendStableJsonLine(target, { sequence: 1 });
    await writeFile(target, `${await readFile(target, 'utf8')}{"sequence":`, 'utf8');
    expect(await repairTrailingJsonlFragment(target)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('{"sequence":1}\n');
    await writeFile(target, '{"sequence":1}\nnot-json\n{"sequence":', 'utf8');
    await expect(repairTrailingJsonlFragment(target)).rejects.toMatchObject({ code: 'EVENT_LOG_INVALID' });
  });

  it('projects historical machine views without inventing request, calls, dictionaries or capabilities', () => {
    const artifact = (purpose: any) => ({ exists: false, path: null, purpose, validation: 'unavailable' as const });
    const view: MachineTaskView = {
      task_id: 'tsk-20260816-120000-deadbeef', display_name: 'old.mp3', created_at: now,
      execution: { status: 'completed', stage: null, summary: '处理完成' },
      review: { status: 'unsupported', pending_count: null, problem: null },
      models: { asr: '历史模型', chat: '历史模型', evidence_mode: null },
      artifacts: { transcribed: artifact('unverified_transcription'), calibrated: artifact('calibrated_result'), approved: artifact('approved_result'), report: artifact('calibration_report') },
      error: null, next_action: '可以打开现有结果。', last_event_sequence: 0, historical: true,
    };
    const task = projectMachineTaskToExchangeTask(view, { sourceSchemaVersion: '3.0.0' });
    const result = projectMachineTaskToExchangeResult(view);
    expect(validateExchangeContract('task', task).valid).toBe(true);
    expect(validateExchangeContract('result', result).valid).toBe(true);
    expect(task.request_id).toBeNull();
    expect(task.capabilities.dictionary_snapshot.supported).toBe(false);
    expect(result.transcription.asr_call_count).toBeNull();
    expect(result.dictionaries.snapshots).toEqual([]);
  });
});
