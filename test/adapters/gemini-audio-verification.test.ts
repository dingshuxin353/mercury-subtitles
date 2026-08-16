import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GEMINI_INLINE_REQUEST_LIMIT_BYTES,
  GeminiAudioVerificationAdapter,
  type GeminiClientLike
} from '../../src/adapters/gemini-audio-verification.js';
import type { AudioVerificationInput, PluginModelSnapshotEntry } from '../../src/model-center/index.js';
import { applyAudioVerificationFindings } from '../../src/subtitle-core/index.js';

const directories: string[] = [];

function clock() {
  let offset = 0;
  return () => new Date(Date.UTC(2026, 7, 10, 8, 0, offset++));
}

function ids() {
  let value = 0;
  return () => String(++value).padStart(4, '0');
}

function model(connectionType: 'developer_api' | 'vertex_ai'): PluginModelSnapshotEntry {
  return {
    snapshot_entry_id: 'task-001-audio-verification', role: 'audio_verification',
    config_id: 'audio-verification-default', name: 'Gemini fixture', config_fingerprint: 'a'.repeat(64),
    plugin_id: 'gemini', connection_id: 'audio-verification-default', connection_type: connectionType,
    model: 'gemini-3.6-flash', runtime: 'cloud', endpoint: null,
    credential_ref: connectionType === 'developer_api' ? 'env:GEMINI_API_KEY' : 'adc:fixture',
    provider_config: connectionType === 'developer_api' ? {} : { project: 'fixture-project', location: 'us-central1' },
    declared_capabilities: {
      task_capabilities: ['audio_verification'], input_modalities: ['text', 'audio'],
      output_types: ['structured_result'], structured_output: true
    },
    cloud_data_confirmation: {
      confirmation_id: 'confirm-audio', confirmed: true, confirmed_at: '2026-08-10T07:00:00.000Z',
      method: 'non_interactive_flag',
      data_categories: ['audio', 'reference_srt', 'calibration_candidate', 'timed_text', 'context']
    },
    check_snapshot: {
      check_id: 'check-audio', config_id: 'audio-verification-default', config_fingerprint: 'a'.repeat(64),
      role: 'audio_verification', confirmation_ref: 'confirm-audio',
      started_at: '2026-08-10T07:01:00.000Z', ended_at: '2026-08-10T07:02:00.000Z',
      outcome: 'passed', actual_model: 'gemini-3.6-flash',
      capabilities: {
        role: 'audio_verification', sample_sha256: 'b'.repeat(64), mime_type: 'audio/mpeg',
        timed_text_fixture_id: 'timed-text-v1', result_schema_version: '1.0.0',
        inline_audio: { max_inline_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES, max_audio_duration_ms: 3_600_000, parsed_finding_count: 0 },
        private_gcs: null,
        local_chunking: {
          threshold_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES,
          source_bytes: 32,
          part_count: 1,
          largest_part_bytes: 32,
          model_request_count: 1,
          parts: [{
            chunk_id: 'chunk-check-0001', bytes: 32, start_ms: 0, end_ms: 5_000,
            call_ref: 'call-check-0001', outcome: 'completed', error_ref: null
          }]
        }
      },
      verified_capabilities: {
        task_capabilities: ['audio_verification'], input_modalities: ['text', 'audio'],
        output_types: ['structured_result'], structured_output: true
      },
      error: null
    }
  } as PluginModelSnapshotEntry;
}

async function input(connectionType: 'developer_api' | 'vertex_ai'): Promise<AudioVerificationInput> {
  const directory = await mkdtemp(path.join(tmpdir(), 'mercury-gemini-adapter-'));
  directories.push(directory);
  const audioPath = path.join(directory, 'sample.mp3');
  await writeFile(audioPath, Buffer.alloc(32, 1));
  return {
    taskId: 'task-001', modelSnapshotRef: 'snapshot-001', model: model(connectionType),
    audio: {
      sourcePath: audioPath, pathRef: 'input/sample.mp3', sha256: 'c'.repeat(64),
      durationMs: 5_000, mimeType: 'audio/mpeg', language: 'zh-CN'
    },
    transcript: {
      schema_version: '1.0.0', task_id: 'task-001', created_at: '2026-08-10T07:10:00.000Z',
      audio: { path_ref: 'input/sample.mp3', sha256: 'c'.repeat(64), duration_ms: 5_000, language: 'zh-CN', mime_type: 'audio/mpeg' },
      full_text: '欢迎使用水星',
      segments: [{ segment_id: 'seg-0001', index: 0, start_ms: 0, end_ms: 5_000, text: '欢迎使用水星', confidence: null, words: [] }],
      model_snapshot_ref: 'snapshot-001',
      call: { call_id: 'call-asr', model_snapshot_entry_ref: 'task-001-asr', started_at: '2026-08-10T07:10:00.000Z', ended_at: '2026-08-10T07:10:01.000Z', outcome: 'completed', error_ref: null },
      raw_response_ref: null, warnings: [], errors: []
    },
    calibrationResult: {
      schema_version: '1.0.0', task_id: 'task-001', created_at: '2026-08-10T07:11:00.000Z', status: 'completed',
      request: { transcript_ref: 'work/transcript.raw.json', reference_srt_ref: null, mode: null },
      model_snapshot_ref: 'snapshot-001',
      call: { call_id: 'call-calibration', model_snapshot_entry_ref: 'task-001-calibration', started_at: '2026-08-10T07:11:00.000Z', ended_at: '2026-08-10T07:11:01.000Z', outcome: 'completed', error_ref: null },
      suggestions: [], warnings: [], errors: []
    },
    calibratedTranscript: {
      artifact_version: '1.0.0', task_id: 'task-001', mode: null, thresholds_version: 'v0.1',
      source_refs: { transcript_ref: 'work/transcript.raw.json', calibration_ref: 'work/calibration-result.json', reference_srt_ref: null },
      segments: [{ subtitle_segment_id: 'subtitle-0001', index: 0, start_ms: 0, end_ms: 5_000, text: '欢迎使用水星', confidence: 'high', asr_segment_refs: ['seg-0001'], reference_segment_refs: [] }],
      modifications: [], warnings: []
    },
    referenceSrt: null
  };
}

function structuredBody(): string {
  return JSON.stringify({
    findings: [{
      kind: 'text_correction', start_ms: 0, end_ms: 5_000,
      current_text: '欢迎使用水星', suggested_text: '欢迎使用水星',
      rationale: '音频与候选一致。', confidence: 'high'
    }]
  });
}

function client(): GeminiClientLike {
  return {
    interactions: {
      create: vi.fn(async () => ({ id: 'interaction-001', status: 'completed', model: 'gemini-3.6-flash', output_text: structuredBody() }))
    },
    files: {
      upload: vi.fn(async () => { throw new Error('Files API must not be used'); }),
      delete: vi.fn(async () => { throw new Error('Files API must not be used'); })
    },
    models: {
      generateContent: vi.fn(async () => ({ text: structuredBody(), modelVersion: 'gemini-3.6-flash', responseId: 'vertex-001' }))
    }
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Gemini audio verification adapter', () => {
  it('uses stateless Developer Interactions with response_format and never uses Files API', async () => {
    const sdk = client();
    const adapter = new GeminiAudioVerificationAdapter({
      readCredential: async () => 'secret-not-persisted', createDeveloperClient: () => sdk,
      now: clock(), createId: ids()
    });
    const result = await adapter.run(await input('developer_api'));
    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact).toMatchObject({ status: 'completed', staging: [] });
    expect(result.artifact.findings[0]?.source_segment_refs).toEqual(['seg-0001']);
    expect(sdk.interactions.create).toHaveBeenCalledWith(expect.objectContaining({
      store: false,
      response_format: expect.objectContaining({
        type: 'text', mime_type: 'application/json',
        schema: expect.objectContaining({ properties: expect.objectContaining({
          findings: expect.objectContaining({ items: expect.objectContaining({ properties: expect.objectContaining({
            end_ms: expect.objectContaining({ maximum: 5_000 }),
            suggested_text: expect.objectContaining({ anyOf: expect.arrayContaining([
              expect.objectContaining({ type: 'string' }), expect.objectContaining({ type: 'null' })
            ]) })
          }), anyOf: expect.arrayContaining([expect.objectContaining({ properties: expect.objectContaining({
            kind: expect.objectContaining({ enum: ['uncertain'] })
          }) })]) }) })
        }) })
      })
    }));
    expect(sdk.files.upload).not.toHaveBeenCalled();
  });

  it('uses Vertex inlineData and current JSON Schema output configuration', async () => {
    const sdk = client();
    const result = await new GeminiAudioVerificationAdapter({
      createVertexClient: () => sdk, now: clock(), createId: ids()
    }).run(await input('vertex_ai'));
    expect(result.kind).toBe('artifact');
    expect(sdk.models.generateContent).toHaveBeenCalledWith(expect.objectContaining({
      contents: [expect.objectContaining({ parts: expect.arrayContaining([
        expect.objectContaining({ inlineData: expect.objectContaining({ mimeType: 'audio/mpeg' }) })
      ]) })],
      config: expect.objectContaining({
        responseMimeType: 'application/json',
        responseJsonSchema: expect.objectContaining({ properties: expect.objectContaining({
          findings: expect.objectContaining({ items: expect.objectContaining({ properties: expect.objectContaining({
            end_ms: expect.objectContaining({ maximum: 5_000 }),
            suggested_text: expect.objectContaining({ anyOf: expect.arrayContaining([
              expect.objectContaining({ type: 'string' }), expect.objectContaining({ type: 'null' })
            ]) })
          }), anyOf: expect.arrayContaining([expect.objectContaining({ properties: expect.objectContaining({
            kind: expect.objectContaining({ enum: ['uncertain'] })
          }) })]) }) })
        }) })
      })
    }));
    expect(sdk.files.upload).not.toHaveBeenCalled();
  });

  it.each(['developer_api', 'vertex_ai'] as const)(
    'uses one whole-file inline request at exactly 15,000,000 bytes for %s',
    async (connectionType) => {
      const value = await input(connectionType);
      await writeFile(value.audio.sourcePath, Buffer.alloc(GEMINI_INLINE_REQUEST_LIMIT_BYTES));
      value.audio.durationMs = 1;
      value.transcript.audio.duration_ms = 1;
      value.transcript.segments[0]!.end_ms = 1;
      value.calibratedTranscript.segments[0]!.end_ms = 1;
      const sdk = client();
      sdk.interactions.create = vi.fn(async () => ({ id: 'boundary-call', output_text: '{"findings":[]}' }));
      sdk.models.generateContent = vi.fn(async () => ({ responseId: 'boundary-call', text: '{"findings":[]}' }));
      const result = await new GeminiAudioVerificationAdapter({
        readCredential: async () => 'ephemeral',
        createDeveloperClient: () => sdk,
        createVertexClient: () => sdk,
        now: clock(), createId: ids()
      }).run(value);
      expect(result.kind === 'artifact' && result.artifact.status).toBe('completed');
      const activeRequest = connectionType === 'developer_api'
        ? sdk.interactions.create
        : sdk.models.generateContent;
      expect(activeRequest).toHaveBeenCalledTimes(1);
      if (result.kind === 'artifact') {
        expect(result.artifact.local_chunking).toMatchObject({
          threshold_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES,
          source_bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES,
          parts: [expect.objectContaining({
            bytes: GEMINI_INLINE_REQUEST_LIMIT_BYTES,
            start_ms: 0,
            end_ms: 1,
            call_ref: (result.artifact.calls[0] as any)?.call_id,
            outcome: 'completed',
            error_ref: null
          })]
        });
      }
    }
  );

  it.each(['developer_api', 'vertex_ai'] as const)(
    'skips 15,000,001-byte input before credentials, client creation, or Provider calls for %s',
    async (connectionType) => {
      const value = await input(connectionType);
      await writeFile(value.audio.sourcePath, Buffer.alloc(GEMINI_INLINE_REQUEST_LIMIT_BYTES + 1));
      const sdk = client();
      const readCredential = vi.fn(async () => 'must-not-be-read');
      const createDeveloperClient = vi.fn(() => sdk);
      const createVertexClient = vi.fn(() => sdk);
      const captureChunkEvidence = vi.fn();
      const result = await new GeminiAudioVerificationAdapter({
        readCredential,
        createDeveloperClient,
        createVertexClient,
        captureChunkEvidence,
        now: clock(),
        createId: ids()
      }).run(value);
      expect(result.kind).toBe('artifact');
      if (result.kind !== 'artifact') return;
      expect(result.artifact).toMatchObject({
        status: 'skipped',
        skip_reason: 'input_limit_exceeded',
        calls: [],
        local_chunking: null,
        staging: []
      });
      expect(readCredential).not.toHaveBeenCalled();
      expect(createDeveloperClient).not.toHaveBeenCalled();
      expect(createVertexClient).not.toHaveBeenCalled();
      expect(captureChunkEvidence).not.toHaveBeenCalled();
      expect(sdk.interactions.create).not.toHaveBeenCalled();
      expect(sdk.models.generateContent).not.toHaveBeenCalled();
      expect(sdk.files.upload).not.toHaveBeenCalled();
    }
  );

  it.runIf(typeof process.env.MERCURY_D009_978MB_SAMPLE === 'string')(
    'skips the real 97.8 MB acceptance sample without preparing parts or calling Vertex',
    async () => {
      const value = await input('vertex_ai');
      await copyFile(process.env.MERCURY_D009_978MB_SAMPLE!, value.audio.sourcePath);
      value.audio.durationMs = 6_114_384;
      value.transcript.audio.duration_ms = value.audio.durationMs;
      value.transcript.segments[0]!.end_ms = value.audio.durationMs;
      value.calibratedTranscript.segments[0]!.end_ms = value.audio.durationMs;
      const sdk = client();
      const createVertexClient = vi.fn(() => sdk);
      const captureChunkEvidence = vi.fn();
      const result = await new GeminiAudioVerificationAdapter({
        createVertexClient,
        captureChunkEvidence,
        now: clock(), createId: ids()
      }).run(value);
      expect(result.kind).toBe('artifact');
      if (result.kind !== 'artifact') return;
      expect(result.artifact).toMatchObject({
        status: 'skipped', skip_reason: 'input_limit_exceeded', calls: [], local_chunking: null
      });
      expect(createVertexClient).not.toHaveBeenCalled();
      expect(captureChunkEvidence).not.toHaveBeenCalled();
      expect(sdk.models.generateContent).not.toHaveBeenCalled();
    }
  );

  it('accepts a fenced structured body but rejects text outside the submitted candidate window', async () => {
    const sdk = client();
    sdk.models.generateContent = vi.fn(async () => ({
      responseId: 'vertex-e05',
      text: '```json\n{"findings":[]}\n```'
    }));
    const accepted = await new GeminiAudioVerificationAdapter({
      createVertexClient: () => sdk, now: clock(), createId: ids()
    }).run(await input('vertex_ai'));
    expect(accepted.kind === 'artifact' && accepted.artifact.status).toBe('completed');

    const asrCandidate = await input('vertex_ai');
    asrCandidate.calibratedTranscript.segments[0]!.text = '欢迎使用水兴';
    sdk.models.generateContent = vi.fn(async () => ({
      responseId: 'vertex-asr-candidate',
      text: JSON.stringify({ findings: [{
        kind: 'text_correction', start_ms: 0, end_ms: 100,
        current_text: '欢迎使用水星', suggested_text: '欢迎使用水兴', rationale: 'ASR 原始候选证据。', confidence: 'high'
      }] })
    }));
    const acceptedAsr = await new GeminiAudioVerificationAdapter({
      createVertexClient: () => sdk, now: clock(), createId: ids()
    }).run(asrCandidate);
    expect(acceptedAsr.kind === 'artifact' && acceptedAsr.artifact.status).toBe('completed');
    if (acceptedAsr.kind === 'artifact') {
      expect(acceptedAsr.artifact.findings[0]?.source_segment_refs).toEqual(['seg-0001']);
    }

    sdk.models.generateContent = vi.fn(async () => ({
      responseId: 'vertex-invalid',
      text: JSON.stringify({ findings: [{
        kind: 'text_correction', start_ms: 0, end_ms: 100,
        current_text: '并不存在', suggested_text: '错误', rationale: '无证据。', confidence: 'high'
      }] })
    }));
    const rejected = await new GeminiAudioVerificationAdapter({
      createVertexClient: () => sdk, now: clock(), createId: ids()
    }).run(await input('vertex_ai'));
    expect(rejected.kind === 'artifact' && rejected.artifact.status).toBe('failed');

    sdk.models.generateContent = vi.fn(async () => ({
      responseId: 'vertex-uncertain',
      text: JSON.stringify({ findings: [{
        kind: 'uncertain', start_ms: 0, end_ms: 100,
        current_text: '欢迎使用水星', suggested_text: null, rationale: '音频证据不足。', confidence: 'low'
      }] })
    }));
    const uncertain = await new GeminiAudioVerificationAdapter({
      createVertexClient: () => sdk, now: clock(), createId: ids()
    }).run(await input('vertex_ai'));
    expect(uncertain.kind === 'artifact' && uncertain.artifact.status).toBe('completed');
    if (uncertain.kind === 'artifact') expect(uncertain.artifact.findings[0]?.suggested_text).toBeNull();
  });

  it.each(['developer_api', 'vertex_ai'] as const)(
    'safely downgrades only incomplete suggestions while preserving valid findings for %s',
    async (connectionType) => {
      const value = await input(connectionType);
      const sdk = client();
      const body = JSON.stringify({ findings: [
        {
          kind: 'segmentation', start_ms: 0, end_ms: 100,
          current_text: '欢迎', suggested_text: null, rationale: '建议缺失但其他字段完整。', confidence: 'high'
        },
        {
          kind: 'timing', start_ms: 100, end_ms: 200,
          current_text: '使用', suggested_text: '', rationale: '建议为空但其他字段完整。', confidence: 'medium'
        },
        {
          kind: 'text_correction', start_ms: 200, end_ms: 300,
          current_text: '水星', suggested_text: '   ', rationale: '建议为空白但其他字段完整。', confidence: 'low'
        },
        {
          kind: 'text_correction', start_ms: 0, end_ms: 5_000,
          current_text: '欢迎使用水星', suggested_text: '欢迎使用水兴', rationale: '合法建议继续处理。', confidence: 'high'
        }
      ] });
      const response = {
        id: 'incomplete-suggestions',
        responseId: 'incomplete-suggestions',
        output_text: body,
        text: body
      };
      sdk.interactions.create = vi.fn(async () => response);
      sdk.models.generateContent = vi.fn(async () => response);
      const result = await new GeminiAudioVerificationAdapter({
        readCredential: async () => 'ephemeral',
        createDeveloperClient: () => sdk,
        createVertexClient: () => sdk,
        now: clock(),
        createId: ids()
      }).run(value);
      expect(result.kind).toBe('artifact');
      if (result.kind !== 'artifact') return;
      expect(result.artifact.status).toBe('completed');
      const incomplete = result.artifact.findings.filter((finding) =>
        finding.rationale.startsWith('模型建议不完整')
      );
      expect(incomplete).toHaveLength(3);
      expect(incomplete.every((finding) => finding.kind === 'uncertain' && finding.suggested_text === null)).toBe(true);
      const applied = applyAudioVerificationFindings(value.calibratedTranscript, result.artifact);
      expect(applied.verification.application_results.filter((item) => item.disposition === 'not_applied')).toHaveLength(3);
      expect(applied.verification.application_results.filter((item) => item.disposition === 'applied')).toHaveLength(1);
      expect(applied.calibrated.segments[0]?.text).toBe('欢迎使用水兴');
      expect(applied.calibrated.modifications).toHaveLength(1);
    }
  );

  it.each([
    ['missing start time', { kind: 'text_correction', end_ms: 100, current_text: '欢迎', suggested_text: null, rationale: '缺少开始时间。', confidence: 'high' }],
    ['missing end time', { kind: 'text_correction', start_ms: 0, current_text: '欢迎', suggested_text: null, rationale: '缺少结束时间。', confidence: 'high' }],
    ['missing current text', { kind: 'text_correction', start_ms: 0, end_ms: 100, suggested_text: null, rationale: '缺少当前文字。', confidence: 'high' }],
    ['blank rationale', { kind: 'text_correction', start_ms: 0, end_ms: 100, current_text: '欢迎', suggested_text: null, rationale: '   ', confidence: 'high' }],
    ['missing confidence', { kind: 'text_correction', start_ms: 0, end_ms: 100, current_text: '欢迎', suggested_text: null, rationale: '缺少置信等级。' }],
    ['missing suggestion field', { kind: 'text_correction', start_ms: 0, end_ms: 100, current_text: '欢迎', rationale: '建议字段缺失。', confidence: 'high' }]
  ] as const)('keeps the whole response invalid for %s', async (_label, finding) => {
    const sdk = client();
    sdk.models.generateContent = vi.fn(async () => ({
      responseId: 'vertex-invalid-core-field',
      text: JSON.stringify({ findings: [finding] })
    }));
    const result = await new GeminiAudioVerificationAdapter({
      createVertexClient: () => sdk, now: clock(), createId: ids()
    }).run(await input('vertex_ai'));
    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.status).toBe('failed');
    expect(result.artifact.findings).toEqual([]);
    expect(result.artifact.errors[0]).toMatchObject({ code: 'GEMINI_RESPONSE_INVALID' });
  });

  it('deduplicates one finding identity despite rationale or confidence differences', async () => {
    const sdk = client();
    sdk.models.generateContent = vi.fn(async () => ({
      responseId: 'vertex-duplicate',
      text: JSON.stringify({ findings: [
        {
          kind: 'text_correction', start_ms: 0, end_ms: 100,
          current_text: '欢迎使用水星', suggested_text: '欢迎使用水星',
          rationale: '较弱理由。', confidence: 'medium'
        },
        {
          kind: 'text_correction', start_ms: 0, end_ms: 100,
          current_text: '欢迎使用水星', suggested_text: '欢迎使用水星',
          rationale: '较强理由。', confidence: 'high'
        }
      ] })
    }));
    const result = await new GeminiAudioVerificationAdapter({
      createVertexClient: () => sdk, now: clock(), createId: ids()
    }).run(await input('vertex_ai'));
    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.status).toBe('completed');
    expect(result.artifact.findings).toHaveLength(1);
    expect(result.artifact.findings[0]).toMatchObject({ confidence: 'high', rationale: '较强理由。' });
    expect(result.artifact.application_results).toHaveLength(1);
  });

  it('does not persist credential or provider exception text in diagnostics', async () => {
    const sdk = client();
    sdk.interactions.create = vi.fn(async () => { throw new Error('secret-not-persisted provider detail'); });
    const result = await new GeminiAudioVerificationAdapter({
      readCredential: async () => 'secret-not-persisted', createDeveloperClient: () => sdk,
      now: clock(), createId: ids()
    }).run(await input('developer_api'));
    expect(result.kind).toBe('artifact');
    if (result.kind !== 'artifact') return;
    expect(result.artifact.errors[0]).toMatchObject({ code: 'GEMINI_MODEL_CALL_FAILED', stage: 'model_call' });
    expect(JSON.stringify(result.artifact)).not.toContain('secret-not-persisted');
  });
});
