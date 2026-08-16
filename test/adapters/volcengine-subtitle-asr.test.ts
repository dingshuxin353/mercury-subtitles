import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VolcengineSubtitleAsrAdapter } from '../../src/adapters/volcengine-subtitle-asr.js';
import type { AsrAdapterInput, ModelSnapshot } from '../../src/contracts/index.js';
import { validateContract } from '../../src/contracts/index.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true }))));

async function input(): Promise<AsrAdapterInput> {
  const root = await mkdtemp(path.join(tmpdir(), 'mercury-subtitle-asr-'));
  directories.push(root);
  await mkdir(path.join(root, 'input'));
  const sourcePath = path.join(root, 'input', 'sample.mp3');
  await writeFile(sourcePath, Buffer.from('ID3 fixture'));
  const snapshot = JSON.parse(await readFile(new URL('../fixtures/valid/model-snapshot.json', import.meta.url), 'utf8')) as ModelSnapshot;
  const model = structuredClone(snapshot.models.asr) as any;
  model.provider_config = { auth_mode: 'legacy', app_id: 'fixture-app' };
  model.credential_ref = 'file:/private/token';
  return {
    taskId: snapshot.task_id,
    modelSnapshotRef: snapshot.snapshot_id,
    model,
    audio: { sourcePath, pathRef: 'input/sample.mp3', sha256: 'a'.repeat(64), durationMs: 2500, mimeType: 'audio/mpeg', language: 'zh-CN' },
  };
}

describe('Volcengine subtitle ASR built-in plugin', () => {
  it('submits the runtime-verified bytes even if the task path changes during credential resolution', async () => {
    const adapterInput = await input();
    const verified = Buffer.from('ID3 fixture');
    const changed = Buffer.from('ID3 changed after verification');
    adapterInput.audio.verifiedBytes = verified;
    adapterInput.audio.sha256 = createHash('sha256').update(verified).digest('hex');
    let submitted: Buffer | null = null;
    let calls = 0;
    const result = await new VolcengineSubtitleAsrAdapter({
      readCredential: async () => {
        await writeFile(adapterInput.audio.sourcePath, changed);
        return 'fixture-access-token';
      },
      fetch: async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          submitted = Buffer.from(init?.body as Buffer);
          return Response.json({ code: 0, message: 'Success', id: 'job-verified-buffer' });
        }
        return Response.json({ code: 0, message: 'Success', id: 'job-verified-buffer', utterances: [{ text: '字幕完成', start_time: 0, end_time: 1000 }] });
      },
    }).run(adapterInput);
    expect(result.kind).toBe('artifact');
    expect(submitted).toEqual(verified);
    expect(submitted).not.toEqual(changed);
  });

  it('classifies submit transport uncertainty, known HTTP errors, and malformed submit responses', async () => {
    const cases: Array<{
      fetch: typeof globalThis.fetch;
      code: string;
      certainty: 'known_terminal' | 'outcome_unknown';
    }> = [
      {
        fetch: async () => { throw new TypeError('connection reset before response'); },
        code: 'VOLCENGINE_SUBTITLE_NETWORK_ERROR',
        certainty: 'outcome_unknown',
      },
      {
        fetch: async () => Response.json({ code: 1002, message: 'token invalid' }, { status: 403 }),
        code: 'VOLCENGINE_SUBTITLE_STATUS_1002',
        certainty: 'known_terminal',
      },
      {
        fetch: async () => new Response('{', { status: 200 }),
        code: 'VOLCENGINE_SUBTITLE_RESPONSE_PARSE_FAILED',
        certainty: 'outcome_unknown',
      },
    ];
    for (const testCase of cases) {
      const result = await new VolcengineSubtitleAsrAdapter({ fetch: testCase.fetch, readCredential: async () => 'fixture-token' }).run(await input());
      expect(result.kind).toBe('failure');
      if (result.kind !== 'failure') continue;
      expect(result.failure).toMatchObject({ provider_outcome_certainty: testCase.certainty, errors: [{ code: testCase.code }] });
      expect(result.failure.call).not.toBeNull();
    }
  });

  it('preserves the submitted job ID when query transport/parse outcome is unknown and never submits again', async () => {
    for (const queryMode of ['network', 'parse'] as const) {
      const requests: string[] = [];
      const fetch: typeof globalThis.fetch = async (url) => {
        requests.push(String(url));
        if (requests.length === 1) return Response.json({ code: 0, message: 'Success', id: 'job-preserved-42' });
        if (queryMode === 'network') throw new TypeError('query connection reset');
        return new Response('{', { status: 200 });
      };
      const result = await new VolcengineSubtitleAsrAdapter({ fetch, readCredential: async () => 'fixture-token' }).run(await input());
      expect(requests).toHaveLength(2);
      expect(requests.filter((url) => url.includes('/submit?'))).toHaveLength(1);
      expect(requests.filter((url) => url.includes('/query?'))).toHaveLength(1);
      expect(result.kind).toBe('failure');
      if (result.kind !== 'failure') continue;
      expect(result.failure.provider_outcome_certainty).toBe('outcome_unknown');
      expect(result.failure.call?.provider_request_id).toBe('job-preserved-42');
      expect(result.failure.errors[0]).toMatchObject({
        code: queryMode === 'network' ? 'VOLCENGINE_SUBTITLE_QUERY_NETWORK_ERROR' : 'VOLCENGINE_SUBTITLE_QUERY_PARSE_FAILED',
        retryable: false,
      });
      expect(result.failure.errors[0]!.remediation).toMatch(/不.*重新提交|绝不能重新提交/u);
    }
  });

  it('submits MP3 bytes, queries once, and normalizes timed utterances', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      if (requests.length === 1) return Response.json({ code: 0, message: 'Success', id: 'job-safe-1' });
      return Response.json({
        code: 0, message: 'Success', id: 'job-safe-1',
        utterances: [
          { text: '你好 Mercury', start_time: 100, end_time: 1200, words: [{ text: '你好', start_time: 100, end_time: 500 }] },
          { text: '字幕完成', start_time: 1300, end_time: 2400 },
        ],
      });
    };
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch,
      readCredential: async (reference) => {
        expect(reference).toBe('file:/private/token');
        return JSON.stringify({
          mode: 'legacy',
          appId: 'fixture-app',
          token: 'fixture-secret-token',
        });
      },
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      createId: (() => { let value = 0; return () => `id-${++value}`; })(),
    }).run(await input());
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toContain('/submit?');
    expect(requests[0]!.url).toContain('appid=fixture-app');
    expect(new Headers(requests[0]!.init?.headers).get('authorization')).toBe(
      'Bearer; fixture-secret-token',
    );
    expect(requests[0]!.init?.body).toBeInstanceOf(Buffer);
    expect(requests[1]!.url).toContain('/query?');
    expect(requests[1]!.url).toContain('appid=fixture-app');
    expect(requests[1]!.url).toContain('blocking=1');
    for (const request of requests) {
      const headers = new Headers(request.init?.headers);
      expect(headers.get('authorization')).toBe('Bearer; fixture-secret-token');
      expect(headers.has('x-api-key')).toBe(false);
      expect(headers.has('x-api-resource-id')).toBe(false);
      expect(headers.has('resource-id')).toBe(false);
      expect(headers.has('cluster')).toBe(false);
      expect(new URL(request.url).searchParams.has('resource_id')).toBe(false);
      expect(new URL(request.url).searchParams.has('cluster')).toBe(false);
    }
    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.full_text).toBe('你好 Mercury\n字幕完成');
    expect(result.artifact.segments).toHaveLength(2);
    expect(validateContract('transcript.raw', result.artifact).valid).toBe(true);
  });

  it('turns provider authorization errors into actionable redacted failures', async () => {
    const fetch: typeof globalThis.fetch = async () => Response.json({ code: 1002, message: 'token invalid' });
    const result = await new VolcengineSubtitleAsrAdapter({ fetch, readCredential: async () => 'fixture-token' }).run(await input());
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.failure.errors[0]).toMatchObject({
      code: 'VOLCENGINE_SUBTITLE_STATUS_1002',
      retryable: false,
    });
    expect(result.failure.errors[0]!.message).toContain('没有授予');
    expect(result.failure.errors[0]!.remediation).toContain('APP ID');
    expect(JSON.stringify(result)).not.toContain('fixture-token');
  });

  it('keeps the documented APP ID independent from the Bearer Access Token', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      if (requests.length === 1)
        return Response.json({ code: 0, message: 'Success', id: 'legacy-job' });
      return Response.json({
        code: 0,
        message: 'Success',
        id: 'legacy-job',
        utterances: [{ text: '旧版鉴权', start_time: 0, end_time: 2000 }],
      });
    };
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch,
      readCredential: async () =>
        JSON.stringify({
          mode: 'legacy',
          appId: 'credential-copy-is-not-the-query-appid',
          token: 'legacy-token-secret',
        }),
    }).run(await input());
    expect(result.kind).toBe('artifact');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toContain('appid=fixture-app');
    expect(new Headers(requests[0]!.init?.headers).get('authorization')).toBe(
      'Bearer; legacy-token-secret',
    );
    expect(new Headers(requests[0]!.init?.headers).has('x-api-key')).toBe(false);
  });

  it('keeps successful timed segments when optional provider word timings are unusable', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1)
        return Response.json({ code: 0, message: 'Success', id: 'word-timing-job' });
      return Response.json({
        code: 0,
        message: 'Success',
        id: 'word-timing-job',
        utterances: [{
          text: '你好，字幕完成',
          start_time: 0,
          end_time: 2400,
          words: [
            { text: '你好', start_time: 0, end_time: 500 },
            { text: '，', start_time: -1, end_time: -1 },
            { text: '重叠项', start_time: 400, end_time: 700 },
            { text: '字幕完成', start_time: 800, end_time: 2300 },
          ],
        }],
      });
    };
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch,
      readCredential: async () => 'fixture-access-token',
    }).run(await input());
    expect(calls).toBe(2);
    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.full_text).toBe('你好，字幕完成');
    expect(result.artifact.segments[0]!.words.map((word) => word.text)).toEqual([
      '你好',
      '字幕完成',
    ]);
    expect(result.artifact.warnings).toEqual([
      expect.objectContaining({
        code: 'VOLCENGINE_SUBTITLE_WORD_TIMING_DROPPED',
        stage: 'response_validation',
        severity: 'low',
      }),
    ]);
    expect(result.artifact.warnings[0]!.message).toContain('2 个词级时间项');
    expect(result.artifact.warnings[0]!.message).not.toContain('重叠项');
    expect(result.artifact.warnings[0]!.message).not.toContain('fixture-access-token');
    expect(result.artifact.warnings[0]!.message).not.toContain('fixture-app');
    expect(validateContract('transcript.raw', result.artifact).valid).toBe(true);
  });

  it('keeps valid utterances when every optional provider word timing is unusable', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1)
        return Response.json({ code: 0, message: 'Success', id: 'all-words-invalid-job' });
      return Response.json({
        code: 0,
        message: 'Success',
        id: 'all-words-invalid-job',
        utterances: [{
          text: '分句仍然有效',
          start_time: 100,
          end_time: 2200,
          words: [
            { text: '缺时间' },
            { text: '越界', start_time: 0, end_time: 300 },
            { text: '倒序', start_time: 900, end_time: 800 },
            'not-a-word-object',
          ],
        }],
      });
    };
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch,
      readCredential: async () => 'fixture-access-token',
    }).run(await input());
    expect(calls).toBe(2);
    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.full_text).toBe('分句仍然有效');
    expect(result.artifact.segments[0]!.words).toEqual([]);
    expect(result.artifact.warnings).toEqual([
      expect.objectContaining({
        code: 'VOLCENGINE_SUBTITLE_WORD_TIMING_DROPPED',
        message: expect.stringContaining('4 个词级时间项'),
      }),
    ]);
    expect(JSON.stringify(result.artifact.warnings)).not.toContain('分句仍然有效');
    expect(JSON.stringify(result.artifact.warnings)).not.toContain('fixture-access-token');
    expect(validateContract('transcript.raw', result.artifact).valid).toBe(true);
  });

  it('persists a redacted 0600 response before rejecting an invalid utterance', async () => {
    let calls = 0;
    const adapterInput = await input();
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1)
        return Response.json({ code: 0, message: 'Success', id: 'invalid-utterance-job' });
      return Response.json({
        code: 0,
        message: 'Success',
        id: 'invalid-utterance-job',
        debug: { appid: 'fixture-app', token: 'fixture-access-token' },
        utterances: [{ text: '', start_time: 0, end_time: 2000 }],
      });
    };
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch,
      readCredential: async () => 'fixture-access-token',
    }).run(adapterInput);
    expect(calls).toBe(2);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.failure.errors[0]).toMatchObject({
      code: 'VOLCENGINE_SUBTITLE_TIMING_INVALID',
      retryable: false,
    });
    const rawPath = path.join(
      path.resolve(path.dirname(adapterInput.audio.sourcePath), '..'),
      'work/provider-response.asr.redacted.json',
    );
    const rawInfo = await stat(rawPath);
    expect(rawInfo.mode & 0o777).toBe(0o600);
    const raw = await readFile(rawPath, 'utf8');
    expect(raw).toContain('<redacted-app-id>');
    expect(raw).toContain('<redacted-access-token>');
    expect(raw).not.toContain('fixture-app');
    expect(raw).not.toContain('fixture-access-token');
  });

  it('rejects the removed APP Key credential before any Provider request', async () => {
    let calls = 0;
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch: async () => {
        calls += 1;
        return Response.json({ code: 0, message: 'Success' });
      },
      readCredential: async () =>
        JSON.stringify({ mode: 'api_key', value: 'removed-app-key' }),
    }).run(await input());
    expect(calls).toBe(0);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.failure.errors[0]).toMatchObject({
      code: 'VOLCENGINE_SUBTITLE_CREDENTIAL_INVALID',
      retryable: false,
    });
    expect(result.failure.errors[0]!.remediation).toContain('APP ID');
    expect(result.failure.errors[0]!.remediation).toContain('Access Token');
    expect(JSON.stringify(result)).not.toContain('removed-app-key');
  });

  it('reports vc.async.default authorization as a non-retryable user action without fallback', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return Response.json(
        {
          code: 1022,
          message:
            '[resource_id=vc.async.default] Requested Resource Not Granted',
        },
        { headers: { 'X-Tt-Logid': 'provider-log-id-1234567890' } },
      );
    };
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch,
      readCredential: async () => 'fixture-api-key',
    }).run(await input());
    expect(calls).toBe(1);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.failure.errors[0]).toMatchObject({
      code: 'VOLCENGINE_SUBTITLE_STATUS_1022',
      retryable: false,
    });
    expect(result.failure.errors[0]!.message).toContain('音视频字幕');
    expect(result.failure.errors[0]!.message).toContain('vc.async.default');
    expect(result.failure.errors[0]!.message).toContain('请求使用的火山应用');
    expect(result.failure.errors[0]!.message).not.toContain('未开通');
    expect(result.failure.errors[0]!.message).not.toContain(
      'requested resource not granted',
    );
    expect(result.failure.errors[0]!.message).toContain('Provider code=1022');
    expect(result.failure.errors[0]!.message).toContain(
      'log id=provider…7890',
    );
    expect(result.failure.errors[0]!.remediation).toContain('APP ID');
    expect(result.failure.errors[0]!.remediation).toContain('Access Token');
    expect(result.failure.errors[0]!.remediation).toContain('项目');
    expect(JSON.stringify(result)).not.toContain('fixture-api-key');
  });

  it('maps a blocking query that remains processing to an explicit timeout', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ code: 0, message: 'Success', id: 'pending-job' })
        : Response.json({ code: 2000, message: 'processing', id: 'pending-job' });
    };
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch,
      readCredential: async () => 'fixture-api-key',
    }).run(await input());
    expect(calls).toBe(2);
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.failure.errors[0]).toMatchObject({
      code: 'VOLCENGINE_SUBTITLE_STATUS_2000',
      retryable: true,
    });
    expect(result.failure.errors[0]!.message).toContain('等待已超时');
  });

  it('rejects invalid or out-of-order provider timings', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ code: 0, message: 'Success', id: 'timing-job' })
        : Response.json({
            code: 0,
            message: 'Success',
            id: 'timing-job',
            utterances: [
              { text: '第一句', start_time: 1000, end_time: 1800 },
              { text: '倒序', start_time: 900, end_time: 2100 },
            ],
          });
    };
    const result = await new VolcengineSubtitleAsrAdapter({
      fetch,
      readCredential: async () => 'fixture-api-key',
    }).run(await input());
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.failure.errors[0]).toMatchObject({
      code: 'VOLCENGINE_SUBTITLE_TIMING_INVALID',
      retryable: false,
    });
  });
});
