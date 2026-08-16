import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  OpenAiChatCompletionsCalibrationAdapter
} from '../../src/adapters/openai-chat-completions.js';
import type {
  CalibrationAdapterInput,
  ModelSnapshot,
  TranscriptRaw
} from '../../src/contracts/index.js';
import { validateContract } from '../../src/contracts/index.js';

const fixtureDirectory = new URL('../fixtures/valid/', import.meta.url);

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(fileURLToPath(new URL(name, fixtureDirectory)), 'utf8')) as T;
}

async function calibrationInput(): Promise<CalibrationAdapterInput> {
  const transcript = await fixture<TranscriptRaw>('transcript.raw.json');
  const snapshot = await fixture<ModelSnapshot>('model-snapshot.json');
  const model = structuredClone(snapshot.models.calibration);
  model.endpoint = 'https://chat.example.test/custom/v1/';
  model.model = 'custom-calibration-model';
  model.credential_ref = 'env:MERCURY_CHAT_TOKEN';

  return {
    taskId: transcript.task_id,
    modelSnapshotRef: snapshot.snapshot_id,
    model: model as CalibrationAdapterInput['model'],
    transcript,
    referenceSrt: {
      pathRef: 'input/reference.srt',
      text: '1\n00:00:00,000 --> 00:00:02,500\n欢迎使用水兴\n'
    },
    mode: 'text-only'
  };
}

function modelContent(value: unknown, id = 'request-chat-001'): Response {
  return Response.json({
    id,
    choices: [{ message: { content: JSON.stringify(value, null, 2) } }]
  });
}

function adapterOptions(
  fetch: typeof globalThis.fetch,
  resolveCredential?: (reference: string) => Promise<string>,
  captureProviderResponseBody?: (body: string) => Promise<void>
) {
  let sequence = 0;
  return {
    fetch,
    ...(resolveCredential ? { resolveCredential } : {}),
    ...(captureProviderResponseBody ? { captureProviderResponseBody } : {}),
    now: () => new Date('2026-08-06T03:00:00.000Z'),
    createId: (kind: 'call' | 'error' | 'failure') => `${kind}-test-${++sequence}`
  };
}

describe('V01-D004 OpenAI Chat Completions calibration adapter', () => {
  it('uses the custom endpoint, model, credential reference, and minimal non-streaming messages', async () => {
    const input = await calibrationInput();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => modelContent({
      suggestions: [{
        suggestion_id: 'suggestion-0001',
        kind: 'text_correction',
        source_segment_refs: ['seg-0001'],
        start_ms: 0,
        end_ms: 2500,
        original_text: '欢迎使用水兴',
        suggested_text: '欢迎使用水星',
        rationale: '上下文和转录支持同音字修正。',
        confidence: 'high'
      }]
    }));
    const resolveCredential = vi.fn(async () => 'mock-secret-value');
    const adapter = new OpenAiChatCompletionsCalibrationAdapter(
      adapterOptions(fetchMock as typeof globalThis.fetch, resolveCredential)
    );

    const result = await adapter.run(input);

    expect(resolveCredential).toHaveBeenCalledExactlyOnceWith('env:MERCURY_CHAT_TOKEN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://chat.example.test/custom/v1/chat/completions');
    expect(request?.method).toBe('POST');
    expect(request?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-secret-value'
    });

    const body = JSON.parse(request?.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['messages', 'model']);
    expect(body.model).toBe('custom-calibration-model');
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('response_format');
    expect(body.messages).toMatchObject([
      { role: 'system', content: expect.any(String) },
      { role: 'user', content: expect.any(String) }
    ]);

    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.status).toBe('completed');
    expect(result.artifact.model_snapshot_ref).toBe('snapshot-001');
    expect(result.artifact.call.provider_request_id).toBe('request-chat-001');
    expect(result.artifact.suggestions).toEqual([{
      suggestion_id: 'suggestion-0001',
      kind: 'text_correction',
      source_segment_refs: ['seg-0001'],
      start_ms: 0,
      end_ms: 2500,
      original_text: '欢迎使用水兴',
      suggested_text: '欢迎使用水星',
      rationale: '上下文和转录支持同音字修正。',
      confidence: 'high',
      disposition: 'not_applied',
      disposition_reason: 'insufficient_evidence'
    }]);
    expect(validateContract('calibration-result', result.artifact).valid).toBe(true);
    expect(JSON.stringify(result.artifact)).not.toContain('mock-secret-value');
  });

  it('omits authorization when credential_ref is null', async () => {
    const input = await calibrationInput();
    input.model.credential_ref = null;
    input.referenceSrt = null;
    input.mode = null;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => modelContent({ suggestions: [] }));
    const resolveCredential = vi.fn(async () => 'unused');
    const adapter = new OpenAiChatCompletionsCalibrationAdapter(
      adapterOptions(fetchMock as typeof globalThis.fetch, resolveCredential)
    );

    const result = await adapter.run(input);

    expect(resolveCredential).not.toHaveBeenCalled();
    const request = fetchMock.mock.calls[0]![1];
    expect(request?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(result.kind).toBe('artifact');
    if (result.kind === 'artifact') {
      expect(result.artifact.status).toBe('completed');
      expect(result.artifact.request).toEqual({
        transcript_ref: 'work/transcript.raw.json',
        reference_srt_ref: null,
        mode: null
      });
    }
  });

  it('returns AdapterFailureRecord before any request when a credential reference cannot resolve', async () => {
    const input = await calibrationInput();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      throw new Error('fetch must not be called');
    });
    const adapter = new OpenAiChatCompletionsCalibrationAdapter(
      adapterOptions(fetchMock as typeof globalThis.fetch, async () => {
        throw new Error('resolver details must not leak');
      })
    );

    const result = await adapter.run(input);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.failure.call).toBeNull();
    expect(result.failure.errors[0].code).toBe('CREDENTIAL_RESOLUTION_FAILED');
    expect(JSON.stringify(result.failure)).not.toContain('resolver details');
  });

  it('turns HTTP failures into a failed D001 calibration result after the request starts', async () => {
    const input = await calibrationInput();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('rate limited', {
      status: 429,
      headers: { 'x-request-id': 'request-rate-limited' }
    }));
    const adapter = new OpenAiChatCompletionsCalibrationAdapter(
      adapterOptions(fetchMock as typeof globalThis.fetch, async () => 'mock-secret-value')
    );

    const result = await adapter.run(input);

    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.status).toBe('failed');
    expect(result.artifact.suggestions).toEqual([]);
    expect(result.artifact.call).toMatchObject({
      outcome: 'failed',
      provider_request_id: 'request-rate-limited'
    });
    expect(result.artifact.errors[0]).toMatchObject({
      code: 'MODEL_HTTP_ERROR',
      stage: 'model_call',
      retryable: true
    });
    expect(validateContract('calibration-result', result.artifact).valid).toBe(true);
  });

  it('passes the exact provider response body to an explicitly configured diagnostic capture', async () => {
    const input = await calibrationInput();
    const responseBody = JSON.stringify({
      id: 'request-captured',
      choices: [{ message: { content: '{"suggestions":[]}' } }]
    }, null, 2);
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(responseBody, { headers: { 'Content-Type': 'application/json' } })
    );
    const captureProviderResponseBody = vi.fn(async (_body: string) => undefined);
    const adapter = new OpenAiChatCompletionsCalibrationAdapter(
      adapterOptions(
        fetchMock as typeof globalThis.fetch,
        async () => 'mock-secret-value',
        captureProviderResponseBody
      )
    );

    const result = await adapter.run(input);

    expect(captureProviderResponseBody).toHaveBeenCalledExactlyOnceWith(responseBody);
    expect(result.kind).toBe('artifact');
    if (result.kind === 'artifact') expect(result.artifact.status).toBe('completed');
  });

  it('returns a safe failure when the configured diagnostic capture cannot persist the response', async () => {
    const input = await calibrationInput();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      modelContent({ suggestions: [] })
    );
    const adapter = new OpenAiChatCompletionsCalibrationAdapter(
      adapterOptions(
        fetchMock as typeof globalThis.fetch,
        async () => 'mock-secret-value',
        async () => {
          throw new Error('local diagnostic path details');
        }
      )
    );

    const result = await adapter.run(input);

    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.status).toBe('failed');
    expect(result.artifact.errors[0]).toMatchObject({
      code: 'PROVIDER_RESPONSE_CAPTURE_FAILED',
      stage: 'artifact_write'
    });
    expect(JSON.stringify(result.artifact)).not.toContain('local diagnostic path details');
  });

  it('reports D001 field path, invariant, and value type without echoing the invalid value', async () => {
    const input = await calibrationInput();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => modelContent({
      suggestions: [{
        suggestion_id: 'suggestion-invalid-confidence',
        kind: 'text_correction',
        source_segment_refs: ['seg-0001'],
        start_ms: 0,
        end_ms: 2500,
        original_text: '欢迎使用水兴',
        suggested_text: '欢迎使用水星',
        rationale: '上下文支持该修正。',
        confidence: 'secret-invalid-confidence-value'
      }]
    }));
    const adapter = new OpenAiChatCompletionsCalibrationAdapter(
      adapterOptions(fetchMock as typeof globalThis.fetch, async () => 'mock-secret-value')
    );

    const result = await adapter.run(input);

    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.status).toBe('failed');
    const error = result.artifact.errors[0] as { code: string; message: string };
    expect(error.code).toBe('CALIBRATION_RESULT_INVALID');
    expect(error.message).toContain('/suggestions/0/confidence');
    expect(error.message).toMatch(/\[INV-[A-Z0-9-]+\]/);
    expect(error.message).toContain('value_type=string');
    expect(error.message).not.toContain('secret-invalid-confidence-value');
    expect(validateContract('calibration-result', result.artifact).valid).toBe(true);
  });

  it.each([
    {
      name: 'invalid provider JSON',
      response: () => new Response('not-json', { status: 200 }),
      code: 'PROVIDER_RESPONSE_INVALID_JSON'
    },
    {
      name: 'empty choices',
      response: () => Response.json({ choices: [] }),
      code: 'PROVIDER_RESPONSE_EMPTY_CONTENT'
    },
    {
      name: 'blank content',
      response: () => Response.json({ choices: [{ message: { content: '  ' } }] }),
      code: 'PROVIDER_RESPONSE_EMPTY_CONTENT'
    },
    {
      name: 'non-JSON message content',
      response: () => Response.json({ choices: [{ message: { content: 'free text' } }] }),
      code: 'CALIBRATION_CONTENT_INVALID_JSON'
    },
    {
      name: 'unknown transcript segment',
      response: () => modelContent({
        suggestions: [{
          suggestion_id: 'suggestion-unknown',
          kind: 'text_correction',
          source_segment_refs: ['seg-unknown'],
          start_ms: 0,
          end_ms: 100,
          original_text: '原文',
          suggested_text: '建议',
          rationale: '理由',
          confidence: 'low'
        }]
      }),
      code: 'CALIBRATION_CONTENT_INVALID'
    },
    {
      name: 'unsupported response field',
      response: () => modelContent({ suggestions: [], extra: true }),
      code: 'CALIBRATION_CONTENT_INVALID'
    }
  ])('rejects $name without preserving partial suggestions', async ({ response, code }) => {
    const input = await calibrationInput();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response());
    const adapter = new OpenAiChatCompletionsCalibrationAdapter(
      adapterOptions(fetchMock as typeof globalThis.fetch, async () => 'mock-secret-value')
    );

    const result = await adapter.run(input);

    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.status).toBe('failed');
    expect(result.artifact.suggestions).toEqual([]);
    expect((result.artifact.errors[0] as { code: string }).code).toBe(code);
    expect(validateContract('calibration-result', result.artifact).valid).toBe(true);
  });
});
