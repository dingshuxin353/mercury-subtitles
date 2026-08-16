import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VolcengineAsrAdapter,
  VOLCENGINE_ASR_ENDPOINT,
  VOLCENGINE_ASR_MAX_DURATION_MS,
  VOLCENGINE_ASR_MAX_INPUT_BYTES,
  VOLCENGINE_ASR_RESOURCE_ID
} from '../../src/adapters/volcengine-asr.js';
import type { AsrAdapterInput, ModelSnapshot } from '../../src/contracts/index.js';
import {
  validateContract,
  validateContractGraph
} from '../../src/contracts/index.js';

const taskDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(taskDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function modelSnapshot(): Promise<ModelSnapshot> {
  return JSON.parse(
    await readFile(new URL('../fixtures/valid/model-snapshot.json', import.meta.url), 'utf8')
  ) as ModelSnapshot;
}

async function taskInput(durationMs = 2_499): Promise<{
  input: AsrAdapterInput;
  snapshot: ModelSnapshot;
  taskDirectory: string;
  audioBytes: Buffer;
}> {
  const taskDirectory = await mkdtemp(join(tmpdir(), 'mercury-d003-'));
  taskDirectories.push(taskDirectory);
  const inputDirectory = join(taskDirectory, 'input');
  await mkdir(inputDirectory);
  const sourcePath = join(inputDirectory, 'sample.mp3');
  const audioBytes = Buffer.from('ID3\u0004\u0000\u0000mock-mp3-audio');
  await writeFile(sourcePath, audioBytes);
  const snapshot = await modelSnapshot();
  return {
    taskDirectory,
    snapshot,
    audioBytes,
    input: {
      taskId: snapshot.task_id,
      modelSnapshotRef: snapshot.snapshot_id,
      model: snapshot.models.asr as AsrAdapterInput['model'],
      audio: {
        sourcePath,
        pathRef: 'input/sample.mp3',
        sha256: 'a'.repeat(64),
        durationMs,
        mimeType: 'audio/mpeg',
        language: 'zh-CN'
      }
    }
  };
}

function ids(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  };
}

function providerResponse(): Record<string, unknown> {
  return {
    audio_info: { duration: 2_499 },
    result: {
      additions: { duration: '2499' },
      text: '关闭透传。字幕完成。',
      utterances: [
        {
          start_time: 450,
          end_time: 1_530,
          text: '关闭透传。',
          words: [
            { start_time: 450, end_time: 770, text: '关', confidence: 0.98 },
            { start_time: 770, end_time: 970, text: '闭', confidence: 0.97 },
            { start_time: 1_130, end_time: 1_530, text: '透传', confidence: 0.96 }
          ]
        },
        {
          start_time: 1_530,
          end_time: 2_499,
          text: '字幕完成。'
        }
      ]
    }
  };
}

function redactedLiveResponseShape(): Record<string, unknown> {
  const trailingWhitespaceIndexes = new Set([3, 44, 50, 52]);
  const utterances = Array.from({ length: 54 }, (_, index) => {
    const startTime = index * 1_000;
    const endTime = startTime + 1_000;
    const text = `脱敏片段${index + 1}`;
    return {
      start_time: startTime,
      end_time: endTime,
      text: `${index === 0 ? ' ' : ''}${text}${trailingWhitespaceIndexes.has(index) ? ' ' : ''}`,
      words: [
        { start_time: startTime, end_time: endTime, text: ` ${text} `, confidence: 0.9 },
        { start_time: -1, end_time: -1, text: ' ' }
      ]
    };
  });
  return {
    audio_info: { duration: 54_000 },
    result: {
      text: utterances.map((utterance) => utterance.text).join(''),
      utterances
    }
  };
}

function successResponse(body: unknown = providerResponse()): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Status-Code': '20000000',
      'X-Api-Message': 'OK',
      'X-Tt-Logid': 'provider-log-id-001'
    }
  });
}

function adapter(fetch: typeof globalThis.fetch): VolcengineAsrAdapter {
  return new VolcengineAsrAdapter({
    fetch,
    resolveCredential: (credentialRef) => {
      expect(credentialRef).toBe('env:VOLCENGINE_API_KEY');
      return { mode: 'api_key', uid: 'mercury-task-user', value: 'fixture-current-key' };
    },
    now: () => new Date('2026-08-06T04:00:00.000Z'),
    createId: ids()
  });
}

describe('V01-D003 Volcengine turbo ASR adapter', () => {
  it('dispatches the runtime-verified bytes even if the task path changes during credential resolution', async () => {
    const fixture = await taskInput();
    fixture.input.audio.verifiedBytes = Buffer.from(fixture.audioBytes);
    fixture.input.audio.sha256 = createHash('sha256').update(fixture.audioBytes).digest('hex');
    const changed = Buffer.from('changed-after-runtime-verification');
    let sent: Buffer | null = null;
    const result = await new VolcengineAsrAdapter({
      resolveCredential: async () => {
        await writeFile(fixture.input.audio.sourcePath, changed);
        return { mode: 'api_key', uid: 'fixture-user', value: 'fixture-key' };
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { audio: { data: string } };
        sent = Buffer.from(body.audio.data, 'base64');
        return successResponse();
      },
    }).run(fixture.input);
    expect(result.kind).toBe('artifact');
    expect(sent).toEqual(fixture.audioBytes);
    expect(sent).not.toEqual(changed);
  });

  it('submits local MP3 bytes with audio.data and returns a valid D001 transcript.raw', async () => {
    const { input, snapshot, taskDirectory, audioBytes } = await taskInput();
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    const responseBody = {
      ...providerResponse(),
      diagnostics: { access_token: 'fixture-provider-token' }
    };
    const fetchMock: typeof globalThis.fetch = async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return successResponse(responseBody);
    };

    const result = await adapter(fetchMock).run(input);

    expect(requestUrl).toBe(VOLCENGINE_ASR_ENDPOINT);
    expect(requestInit?.method).toBe('POST');
    const headers = new Headers(requestInit?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-api-key')).toBe('fixture-current-key');
    expect(headers.get('x-api-resource-id')).toBe(VOLCENGINE_ASR_RESOURCE_ID);
    expect(headers.get('x-api-sequence')).toBe('-1');
    expect(headers.get('x-api-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    const body = JSON.parse(String(requestInit?.body));
    expect(body).toEqual({
      user: { uid: 'mercury-task-user' },
      audio: { data: audioBytes.toString('base64') },
      request: { model_name: 'bigmodel' }
    });
    expect(body.audio).not.toHaveProperty('url');

    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') throw new Error('expected transcript artifact');
    expect(result.artifact.full_text).toBe('关闭透传。\n字幕完成。');
    expect(result.artifact.segments).toHaveLength(2);
    expect(result.artifact.segments[0]?.words).toHaveLength(3);
    expect(result.artifact.segments[1]?.confidence).toBeNull();
    expect(result.artifact.segments[1]?.words).toEqual([]);
    expect(result.artifact.call).toMatchObject({
      model_snapshot_entry_ref: snapshot.models.asr.snapshot_entry_id,
      outcome: 'completed',
      provider_request_id: 'provider-log-id-001',
      error_ref: null
    });
    expect(validateContract('transcript.raw', result.artifact).valid).toBe(true);
    expect(
      validateContractGraph({
        modelSnapshot: snapshot,
        transcriptRaw: result.artifact,
        availableTaskFiles: ['input/sample.mp3', 'work/provider-response.asr.redacted.json']
      }).valid
    ).toBe(true);

    const persistedResponse = await readFile(
      join(taskDirectory, 'work/provider-response.asr.redacted.json'),
      'utf8'
    );
    const persisted = JSON.parse(persistedResponse);
    expect(persisted.result).toEqual(providerResponse().result);
    expect(persisted.diagnostics.access_token).toBe('[REDACTED]');
    expect(persistedResponse).not.toContain('fixture-current-key');
    expect(persistedResponse).not.toContain('fixture-provider-token');
    expect(await readFile(input.audio.sourcePath)).toEqual(audioBytes);
  });

  it('supports the official legacy credential headers without persisting them', async () => {
    const { input, taskDirectory } = await taskInput();
    let sentHeaders = new Headers();
    const fetchMock: typeof globalThis.fetch = async (_url, init) => {
      sentHeaders = new Headers(init?.headers);
      return successResponse();
    };
    const legacy = new VolcengineAsrAdapter({
      fetch: fetchMock,
      resolveCredential: () => ({
        mode: 'legacy',
        uid: 'legacy-app-identifier',
        appKey: 'fixture-app-key',
        accessKey: 'fixture-access-key'
      }),
      now: () => new Date('2026-08-06T04:00:00.000Z'),
      createId: ids()
    });

    const result = await legacy.run(input);
    expect(result.kind).toBe('artifact');
    expect(sentHeaders.get('x-api-app-key')).toBe('fixture-app-key');
    expect(sentHeaders.get('x-api-access-key')).toBe('fixture-access-key');
    expect(sentHeaders.has('x-api-key')).toBe(false);
    const persistedResponse = await readFile(
      join(taskDirectory, 'work/provider-response.asr.redacted.json'),
      'utf8'
    );
    expect(persistedResponse).not.toContain('fixture-app-key');
    expect(persistedResponse).not.toContain('fixture-access-key');
  });

  it('normalizes the redacted 54-utterance live response shape without inventing word timing', async () => {
    const { input, snapshot } = await taskInput(54_000);

    const result = await adapter(async () => successResponse(redactedLiveResponseShape())).run(input);

    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') throw new Error('expected transcript artifact');
    expect(result.artifact.segments).toHaveLength(54);
    expect(result.artifact.segments[0]?.text).toBe('脱敏片段1');
    expect(result.artifact.segments[3]?.text).toBe('脱敏片段4');
    expect(result.artifact.segments[44]?.text).toBe('脱敏片段45');
    expect(result.artifact.segments[50]?.text).toBe('脱敏片段51');
    expect(result.artifact.segments[52]?.text).toBe('脱敏片段53');
    expect(result.artifact.segments.every((segment) => segment.words.length === 1)).toBe(true);
    expect(
      result.artifact.segments.every((segment) =>
        segment.words.every(
          (word) =>
            word.text === word.text.trim() && word.start_ms >= segment.start_ms && word.end_ms <= segment.end_ms
        )
      )
    ).toBe(true);
    expect(validateContract('transcript.raw', result.artifact).valid).toBe(true);
    expect(
      validateContractGraph({
        modelSnapshot: snapshot,
        transcriptRaw: result.artifact,
        availableTaskFiles: ['input/sample.mp3', 'work/provider-response.asr.redacted.json']
      }).valid
    ).toBe(true);
  });

  it('still rejects all-whitespace content and non-placeholder invalid timing', async () => {
    for (const invalidPart of [
      'utterance-whitespace',
      'word-whitespace',
      'word-negative-timing',
      'utterance-out-of-bounds'
    ] as const) {
      const { input } = await taskInput();
      const response = providerResponse() as any;
      if (invalidPart === 'utterance-whitespace') {
        response.result.utterances[1].text = ' \t ';
      } else if (invalidPart === 'word-whitespace') {
        response.result.utterances[0].words[0].text = '   ';
      } else if (invalidPart === 'word-negative-timing') {
        response.result.utterances[0].words[0] = {
          start_time: -1,
          end_time: -1,
          text: '有效词'
        };
      } else {
        response.result.utterances[1].end_time = input.audio.durationMs + 1;
      }

      const result = await adapter(async () => successResponse(response)).run(input);
      expect(result.kind).toBe('failure');
      if (result.kind !== 'failure') throw new Error('expected adapter failure');
      expect(result.failure.errors[0]).toMatchObject({
        code: 'VOLCENGINE_TIMING_INVALID',
        stage: 'response_validation',
        retryable: false
      });
    }
  });

  it('rejects the documented duration and size limits before resolving credentials or fetching', async () => {
    for (const boundary of ['duration', 'size'] as const) {
      const { input, snapshot } = await taskInput(
        boundary === 'duration' ? VOLCENGINE_ASR_MAX_DURATION_MS + 1 : 2_499
      );
      if (boundary === 'size') {
        await truncate(input.audio.sourcePath, VOLCENGINE_ASR_MAX_INPUT_BYTES + 1);
      }
      const fetchMock = vi.fn<typeof globalThis.fetch>();
      const resolver = vi.fn(() => ({
        mode: 'api_key' as const,
        uid: 'fixture-user',
        value: 'fixture-current-key'
      }));
      const subject = new VolcengineAsrAdapter({
        fetch: fetchMock,
        resolveCredential: resolver,
        now: () => new Date('2026-08-06T04:00:00.000Z'),
        createId: ids()
      });

      const result = await subject.run(input);
      expect(result.kind).toBe('failure');
      if (result.kind !== 'failure') throw new Error('expected adapter failure');
      expect(result.failure.call).toBeNull();
      expect(result.failure.errors[0].code).toBe(
        boundary === 'duration' ? 'ASR_INPUT_DURATION_EXCEEDED' : 'ASR_INPUT_SIZE_EXCEEDED'
      );
      expect(result.failure.errors[0].stage).toBe('media_decode');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(resolver).not.toHaveBeenCalled();
      expect(result.failure.model_snapshot_ref).toBe(snapshot.snapshot_id);
    }
  });

  it('returns a linked retryable failure for a real provider status error', async () => {
    const { input, snapshot } = await taskInput();
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response('{}', {
        status: 200,
        headers: {
          'X-Api-Status-Code': '55000031',
          'X-Tt-Logid': 'provider-overload-log'
        }
      });

    const result = await adapter(fetchMock).run(input);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') throw new Error('expected adapter failure');
    const error = result.failure.errors[0];
    expect(error).toMatchObject({
      code: 'VOLCENGINE_STATUS_55000031',
      stage: 'model_call',
      retryable: true
    });
    expect(result.failure.call).toMatchObject({
      model_snapshot_entry_ref: snapshot.models.asr.snapshot_entry_id,
      provider_request_id: 'provider-overload-log',
      outcome: 'failed',
      error_ref: error.error_id
    });
    expect(
      validateContractGraph({ modelSnapshot: snapshot, adapterFailures: [result.failure] }).valid
    ).toBe(true);
  });

  it('distinguishes provider silence, network failure, malformed JSON, and invalid timing', async () => {
    const cases: Array<{
      fetch: typeof globalThis.fetch;
      code: string;
      stage: string;
      retryable: boolean;
      certainty: 'known_terminal' | 'outcome_unknown';
    }> = [
      {
        fetch: async () =>
          new Response('{}', {
            status: 200,
            headers: { 'X-Api-Status-Code': '20000003' }
          }),
        code: 'VOLCENGINE_NO_SPEECH',
        stage: 'model_call',
        retryable: false,
        certainty: 'known_terminal'
      },
      {
        fetch: async () => {
          throw new TypeError('fixture network failure');
        },
        code: 'VOLCENGINE_NETWORK_ERROR',
        stage: 'connectivity',
        retryable: true,
        certainty: 'outcome_unknown'
      },
      {
        fetch: async () =>
          new Response('{', {
            status: 200,
            headers: { 'X-Api-Status-Code': '20000000' }
          }),
        code: 'VOLCENGINE_RESPONSE_PARSE_FAILED',
        stage: 'response_parse',
        retryable: false,
        certainty: 'known_terminal'
      },
      {
        fetch: async () => {
          const invalid = providerResponse() as any;
          invalid.result.utterances[1].start_time = 1_000;
          return successResponse(invalid);
        },
        code: 'VOLCENGINE_TIMING_INVALID',
        stage: 'response_validation',
        retryable: false,
        certainty: 'known_terminal'
      }
    ];

    for (const testCase of cases) {
      const { input, snapshot } = await taskInput();
      const result = await adapter(testCase.fetch).run(input);
      expect(result.kind).toBe('failure');
      if (result.kind !== 'failure') throw new Error('expected adapter failure');
      expect(result.failure.errors[0]).toMatchObject({
        code: testCase.code,
        stage: testCase.stage,
        retryable: testCase.retryable
      });
      expect(result.failure.provider_outcome_certainty).toBe(testCase.certainty);
      expect(result.failure.call?.error_ref).toBe(result.failure.errors[0].error_id);
      expect(
        validateContractGraph({ modelSnapshot: snapshot, adapterFailures: [result.failure] }).valid
      ).toBe(true);
    }
  });

  it('records a completed provider call when only raw-response persistence fails', async () => {
    const { input, snapshot, taskDirectory } = await taskInput();
    await writeFile(join(taskDirectory, 'work'), 'blocks the work directory');

    const result = await adapter(async () => successResponse()).run(input);

    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') throw new Error('expected adapter failure');
    expect(result.failure.errors[0]).toMatchObject({
      code: 'ASR_RAW_RESPONSE_WRITE_FAILED',
      stage: 'artifact_write',
      retryable: false
    });
    expect(result.failure.call).toMatchObject({ outcome: 'completed', error_ref: null });
    expect(
      validateContractGraph({ modelSnapshot: snapshot, adapterFailures: [result.failure] }).valid
    ).toBe(true);
  });
});
