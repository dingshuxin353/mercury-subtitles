import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AsrAdapter,
  ModelCapabilityProfileV2,
  ModelConfigRegistryV2,
  ModelConfigV2,
  TranscriptRaw,
} from '../src/contracts/index.js';
import { computeModelConfigFingerprintV2 } from '../src/contracts/index.js';
import { createCalibrationTaskV2, readTaskRecordV2 } from '../src/tasks-v2.js';
import { executeCalibrationTaskV2 } from '../src/core-integration-v2.js';
import { runCli } from '../src/cli.js';
import { ensureWorkspace } from '../src/workspace.js';
import {
  calibrationBaseOutputBudget,
  calibrationOutputBudget,
} from '../src/adapters/chat-calibration-v2.js';

const roots: string[] = [];
const TIMED_TEXT = ['您好世界，和平发展。', '共同创造美好未来。'] as const;
const REFERENCE_TWO = `1\n00:00:00,000 --> 00:00:00,026\n${TIMED_TEXT[0]}\n\n2\n00:00:00,026 --> 00:00:00,052\n${TIMED_TEXT[1]}\n`;
const REFERENCE_JOINED = `1\n00:00:00,000 --> 00:00:00,052\n${TIMED_TEXT.join('')}\n`;
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), 'mercury-d011-'));
  roots.push(root);
  return root;
}
async function mp3(target: string, bytes = 834) {
  const data = Buffer.alloc(bytes);
  data.set([0xff, 0xfb, 0x90, 0x64], 0);
  data.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(target, data);
}
const ASR: ModelCapabilityProfileV2 = {
  capabilities: ['transcription'],
  input_modalities: ['audio'],
  output_types: ['timed_transcript'],
  structured_output: true,
};
const TEXT: ModelCapabilityProfileV2 = {
  capabilities: ['calibration'],
  input_modalities: ['text'],
  output_types: ['structured_result'],
  structured_output: true,
};
const AUDIO: ModelCapabilityProfileV2 = {
  capabilities: ['calibration'],
  input_modalities: ['text', 'audio'],
  output_types: ['structured_result'],
  structured_output: true,
};
function model(
  id: string,
  category: 'asr' | 'chat',
  plugin: 'volcengine_asr' | 'openai_chat_completions' | 'gemini',
  profile: ModelCapabilityProfileV2,
  connection?: string,
): ModelConfigV2 {
  const at = '2030-01-01T00:00:00.000Z';
  const value: ModelConfigV2 = {
    model_id: id,
    name: id,
    category,
    plugin_id: plugin,
    connection_id: `conn-${id}`,
    connection_type: (connection ??
      (plugin === 'volcengine_asr'
        ? 'volcengine_cloud'
        : plugin === 'gemini'
          ? 'vertex_ai'
          : 'compatible_endpoint')) as any,
    provider_model: plugin === 'volcengine_asr' ? 'bigmodel' : `${id}-provider`,
    runtime: 'cloud',
    endpoint:
      plugin === 'openai_chat_completions' ? 'https://chat.example/v1' : null,
    credential_ref:
      plugin === 'openai_chat_completions'
        ? null
        : plugin === 'gemini'
          ? 'adc:test'
          : 'env:ASR_TEST',
    provider_config:
      plugin === 'volcengine_asr'
        ? { resource_id: 'volc.bigasr.auc_turbo' }
        : plugin === 'gemini'
          ? { project: 'safe-project', location: 'us-central1' }
          : {},
    declared_capabilities: structuredClone(profile),
    verified_capabilities: structuredClone(profile),
    enabled: true,
    cloud_data_confirmation: {
      confirmation_id: `confirm-${id}`,
      confirmed: true,
      confirmed_at: at,
      method: 'interactive_cli',
      data_categories:
        category === 'asr'
          ? ['audio']
          : profile.input_modalities.includes('audio')
            ? [
                'audio',
                'transcript',
                'reference_srt',
                'calibration_candidate',
                'timed_text',
                'context',
              ]
            : ['transcript', 'reference_srt', 'context'],
    } as any,
    config_fingerprint: '',
    check: null,
  };
  value.config_fingerprint = computeModelConfigFingerprintV2(value);
  value.check = {
    check_id: `check-${id}`,
    model_id: id,
    config_fingerprint: value.config_fingerprint,
    category,
    confirmation_ref: value.cloud_data_confirmation.confirmation_id,
    started_at: at,
    ended_at: at,
    outcome: 'passed',
    actual_model: value.provider_model,
    verified_capabilities: structuredClone(profile),
    evidence: { fixture: 'd011' },
    error: null,
  };
  return value;
}
async function prepared(
  chat: ModelConfigV2,
  bytes = 834,
  extras: ModelConfigV2[] = [],
) {
  const root = await temp();
  const workspace = path.join(root, 'mercury-workspace');
  await ensureWorkspace(workspace);
  const audio = path.join(root, 'source.mp3');
  await mp3(audio, bytes);
  const asr = model('asr-default', 'asr', 'volcengine_asr', ASR);
  const registry: ModelConfigRegistryV2 = {
    schema_version: '2.0.0',
    updated_at: '2030-01-01T00:00:00.000Z',
    defaults: { asr: asr.model_id, chat: chat.model_id },
    models: [asr, chat, ...extras],
  };
  await writeFile(
    path.join(workspace, 'config/model-config.json'),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  return { root, workspace, audio, registry };
}
function asr(calls: string[] = []): AsrAdapter {
  return {
    adapterId: 'volcengine_asr',
    async run(input) {
      calls.push((input.model as any).config_id);
      return {
        kind: 'artifact',
        artifact: {
          schema_version: '1.0.0',
          task_id: input.taskId,
          created_at: '2030-01-01T00:00:01.000Z',
          audio: {
            path_ref: input.audio.pathRef,
            sha256: input.audio.sha256,
            duration_ms: input.audio.durationMs,
            language: 'zh-CN',
            mime_type: 'audio/mpeg',
          },
          full_text: '您好世界和平',
          segments: [
            {
              segment_id: 'seg-1',
              index: 0,
              start_ms: 0,
              end_ms: input.audio.durationMs,
              text: '您好世界和平',
              confidence: 0.99,
              words: [],
            },
          ],
          model_snapshot_ref: input.modelSnapshotRef,
          call: {
            call_id: 'call-asr',
            model_snapshot_entry_ref: input.model.snapshot_entry_id,
            started_at: '2030-01-01T00:00:00.000Z',
            ended_at: '2030-01-01T00:00:01.000Z',
            outcome: 'completed',
            error_ref: null,
          },
          raw_response_ref: null,
          warnings: [],
          errors: [],
        },
      };
    },
  };
}
function timedAsr(): AsrAdapter {
  return {
    adapterId: 'volcengine_asr',
    async run(input) {
      const middle = Math.floor(input.audio.durationMs / 2);
      return {
        kind: 'artifact',
        artifact: {
          schema_version: '1.0.0',
          task_id: input.taskId,
          created_at: '2030-01-01T00:00:01.000Z',
          audio: {
            path_ref: input.audio.pathRef,
            sha256: input.audio.sha256,
            duration_ms: input.audio.durationMs,
            language: 'zh-CN',
            mime_type: 'audio/mpeg',
          },
          full_text: TIMED_TEXT.join('\n'),
          segments: [
            {
              segment_id: 'seg-1',
              index: 0,
              start_ms: 0,
              end_ms: middle,
              text: TIMED_TEXT[0],
              confidence: 0.99,
              words: [],
            },
            {
              segment_id: 'seg-2',
              index: 1,
              start_ms: middle,
              end_ms: input.audio.durationMs,
              text: TIMED_TEXT[1],
              confidence: 0.99,
              words: [],
            },
          ],
          model_snapshot_ref: input.modelSnapshotRef,
          call: {
            call_id: 'call-asr-timed',
            model_snapshot_entry_ref: input.model.snapshot_entry_id,
            started_at: '2030-01-01T00:00:00.000Z',
            ended_at: '2030-01-01T00:00:01.000Z',
            outcome: 'completed',
            error_ref: null,
          },
          raw_response_ref: null,
          warnings: [],
          errors: [],
        },
      };
    },
  };
}
function manyUnitAsr(unitCount: number): AsrAdapter {
  return {
    adapterId: 'volcengine_asr',
    async run(input) {
      const segments = Array.from({ length: unitCount }, (_, index) => ({
        segment_id: `seg-${index + 1}`,
        index,
        start_ms: index * 2,
        end_ms: index === unitCount - 1 ? input.audio.durationMs : (index + 1) * 2,
        text: `单元${index + 1}`,
        confidence: 0.99,
        words: [],
      })) as unknown as TranscriptRaw['segments'];
      return {
        kind: 'artifact',
        artifact: {
          schema_version: '1.0.0',
          task_id: input.taskId,
          created_at: '2030-01-01T00:00:01.000Z',
          audio: {
            path_ref: input.audio.pathRef,
            sha256: input.audio.sha256,
            duration_ms: input.audio.durationMs,
            language: 'zh-CN',
            mime_type: 'audio/mpeg',
          },
          full_text: segments.map((segment) => segment.text).join('\n'),
          segments,
          model_snapshot_ref: input.modelSnapshotRef,
          call: {
            call_id: 'call-asr-many',
            model_snapshot_entry_ref: input.model.snapshot_entry_id,
            started_at: '2030-01-01T00:00:00.000Z',
            ended_at: '2030-01-01T00:00:01.000Z',
            outcome: 'completed',
            error_ref: null,
          },
          raw_response_ref: null,
          warnings: [],
          errors: [],
        },
      };
    },
  };
}
function promptPayload(prompt: string) {
  return JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as {
    calibration_units: Array<{ unit_id: string; original_text: string }>;
  };
}
function completeFromPrompt(prompt: string): string {
  const payload = promptPayload(prompt);
  return JSON.stringify({
    corrected_units: payload.calibration_units.map((unit) => ({
      unit_id: unit.unit_id,
      corrected_text: unit.original_text,
      rationale: null,
    })),
  });
}
function openAiFetch(
  response = (prompt: string) => completeFromPrompt(prompt),
  finishReason = 'stop',
) {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = request.messages.find((message) => message.role === 'user')!.content;
    return Response.json({
      id: 'chat-request',
      choices: [{ finish_reason: finishReason, message: { content: response(prompt) } }],
    });
  });
}
async function taskDir(workspace: string, task: { task_directory: string }) {
  return path.join(workspace, 'tasks', task.task_directory);
}
afterEach(async () => {
  if (!process.env.KEEP_D011)
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
});

describe('V01-D011 C01-C09/C11', () => {
  it('assigns an auditable Gemini-only output reserve and caps the total budget', () => {
    expect(calibrationBaseOutputBudget(20)).toBe(4_096);
    expect(calibrationOutputBudget(20, 'non_gemini')).toBe(4_096);
    expect(calibrationOutputBudget(20, 'gemini')).toBe(12_288);
    expect(calibrationBaseOutputBudget(160)).toBe(25_600);
    expect(calibrationOutputBudget(160, 'gemini')).toBe(32_768);
    expect(calibrationOutputBudget(10_000, 'gemini')).toBe(32_768);
  });
  it.each(['vertex_ai', 'developer_api'] as const)(
    'sends and records 12288 tokens for a 20-unit Gemini %s request',
    async (connection) => {
      const input = await prepared(model('chat-gemini', 'chat', 'gemini', AUDIO, connection));
      const srt = path.join(input.root, `twenty-${connection}.srt`);
      const cues = Array.from({ length: 20 }, (_, index) => {
        const start = index * 2;
        const end = index === 19 ? 52 : (index + 1) * 2;
        const stamp = (milliseconds: number) =>
          `00:00:00,${String(milliseconds).padStart(3, '0')}`;
        return `${index + 1}\n${stamp(start)} --> ${stamp(end)}\n单元${index + 1}`;
      }).join('\n\n');
      await writeFile(srt, `${cues}\n`);
      const requests: any[] = [];
      const complete = (request: any) => {
        const sentPrompt = connection === 'developer_api'
          ? request.input[0].text
          : request.contents[0].parts[0].text;
        return completeFromPrompt(sentPrompt);
      };
      const task = await createCalibrationTaskV2({
        workspaceRoot: input.workspace,
        audioPath: input.audio,
        srtPath: srt,
        mode: 'text-only',
      });
      const root = await taskDir(input.workspace, task);
      const done = await executeCalibrationTaskV2(root, {
        asrAdapter: manyUnitAsr(20),
        captureRequest: (request) => requests.push(request),
        readCredential: async () => 'fixture-key',
        createDeveloperClient: () => ({
          interactions: {
            create: async (request: any) => ({
              id: 'gemini-developer-20',
              output_text: complete(request),
              finishReason: 'STOP',
            }),
          },
          models: { generateContent: async () => ({}) },
        }),
        createVertexClient: () => ({
          interactions: { create: async () => ({}) },
          models: {
            generateContent: async (request: any) => ({
              responseId: 'gemini-vertex-20',
              text: complete(request),
              finishReason: 'STOP',
            }),
          },
        }),
      });

      expect(done.execution.status, JSON.stringify(done.error)).toBe('completed');
      expect(requests).toHaveLength(1);
      if (connection === 'developer_api') {
        expect(requests[0].max_output_tokens).toBe(12_288);
      } else {
        expect(requests[0].config.maxOutputTokens).toBe(12_288);
      }
      const result = JSON.parse(await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'));
      expect(result.strategy).toMatchObject({
        output_budget_tokens: 12_288,
        input_unit_count: 20,
        returned_unit_count: 20,
        coverage_complete: true,
      });
    },
  );
  it('maps Vertex permission failures to an actionable redacted error', async () => {
    const input = await prepared(model('chat-gemini', 'chat', 'gemini', AUDIO));
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
    });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      createVertexClient: () => ({
        interactions: { create: async () => ({}) },
        models: {
          generateContent: async () => {
            throw new Error('fetch failed', {
              cause: new Error(
                '403 PERMISSION_DENIED request token abcdefghijklmnopqrstuvwxyz123456',
              ),
            });
          },
        },
      }),
    });
    expect(done.execution.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'GEMINI_VERTEX_PERMISSION_DENIED' });
    const result = JSON.parse(
      await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'),
    );
    expect(result.errors[0]).toMatchObject({
      code: 'GEMINI_VERTEX_PERMISSION_DENIED',
      retryable: false,
    });
    expect(result.provider_outcome_certainty).toBe('known_terminal');
    expect(result.errors[0].message).toContain('项目权限');
    expect(result.errors[0].message).toContain('[redacted]');
    expect(result.errors[0].message).not.toContain(
      'abcdefghijklmnopqrstuvwxyz123456',
    );
  });
  it.each([
    ['400 INVALID_ARGUMENT', 'GEMINI_VERTEX_REQUEST_INVALID', false],
    ['401 UNAUTHENTICATED', 'GEMINI_VERTEX_UNAUTHENTICATED', false],
    ['404 NOT_FOUND', 'GEMINI_VERTEX_MODEL_NOT_FOUND', false],
    ['429 RESOURCE_EXHAUSTED', 'GEMINI_VERTEX_QUOTA_EXHAUSTED', true],
  ] as const)('classifies a recognized Gemini response %s as known terminal', async (detail, code, retryable) => {
    const input = await prepared(model('chat-gemini', 'chat', 'gemini', AUDIO));
    const task = await createCalibrationTaskV2({ workspaceRoot: input.workspace, audioPath: input.audio });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      createVertexClient: () => ({
        interactions: { create: async () => ({}) },
        models: { generateContent: async () => { throw new Error(detail); } },
      }),
    });
    expect(done.execution.status).toBe('failed');
    expect(done.error?.code).toBe(code);
    const result = JSON.parse(await readFile(path.join(root, 'work/calibration-result.json'), 'utf8')) as any;
    expect(result.provider_outcome_certainty).toBe('known_terminal');
    expect(result.errors[0].retryable).toBe(retryable);
  });
  it('keeps a Gemini MAX_TOKENS response known-terminal with the actual sent budget', async () => {
    const input = await prepared(model('chat-gemini', 'chat', 'gemini', AUDIO));
    const requests: any[] = [];
    const generateContent = vi.fn(async () => ({
      text: '{"corrected_units":[',
      responseId: 'gemini-max-tokens',
      finishReason: 'MAX_TOKENS',
    }));
    const task = await createCalibrationTaskV2({ workspaceRoot: input.workspace, audioPath: input.audio });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      captureRequest: (request) => requests.push(request),
      createVertexClient: () => ({
        interactions: { create: async () => ({}) },
        models: { generateContent },
      }),
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].config.maxOutputTokens).toBe(12_288);
    expect(done.execution.status).toBe('failed');
    expect(done.error?.code).toBe('CALIBRATION_RESPONSE_TRUNCATED');
    expect(done.artifacts.outputs).toEqual(['output/source.transcribed.srt']);
    const result = JSON.parse(await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'));
    expect(result).toMatchObject({
      status: 'failed',
      provider_outcome_certainty: 'known_terminal',
      strategy: {
        output_budget_tokens: 12_288,
        provider_finish_reason: 'MAX_TOKENS',
        returned_unit_count: 0,
        coverage_complete: false,
      },
    });
    await expect(readFile(path.join(root, 'output/source.calibrated.srt'))).rejects.toThrow();
    await expect(readFile(path.join(root, 'output/source.approved.srt'))).rejects.toThrow();
  });
  it('C01 uses one selected ASR and one text Chat call without a verification stage or artifact', async () => {
    const input = await prepared(
      model('chat-text', 'chat', 'openai_chat_completions', TEXT),
    );
    const fetch = openAiFetch();
    const asrCalls: string[] = [];
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
    });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(asrCalls),
      fetch,
    });
    expect(done.execution.status).toBe('completed');
    expect(asrCalls).toEqual(['asr-default']);
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body));
    expect(request).toMatchObject({ max_tokens: 4096, temperature: 0, stream: true });
    expect(request).not.toHaveProperty('thinking');
    const userPrompt = request.messages.find((message: any) => message.role === 'user').content;
    expect(userPrompt).toContain('证据只来自本请求中的音频、完整转录、参考字幕');
    expect(userPrompt).toContain('先在内部静默通读全部单元');
    expect(userPrompt).toContain('同一术语的多种 ASR 音近写法必须依据全文内部证据统一');
    expect(userPrompt).toContain('数字和版本号只有在音频声学证据或全文重复证据充分时才可修改');
    expect(userPrompt).toContain('全文术语一致性和无依据改写复检');
    expect(userPrompt).toContain('按输入顺序逐个审查每个校验单元');
    expect(userPrompt).toContain('返回前复检是否遗漏、重复或新增任何 ID');
    expect(userPrompt).not.toContain('最多 4');
    const result = JSON.parse(
      await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'),
    );
    expect(result.request).toMatchObject({
      evidence_mode: 'text',
      non_strong_reason: 'audio_not_supported',
      input_modalities: ['text'],
      audio: null,
    });
    expect(result).toMatchObject({
      schema_version: '3.0.0',
      status: 'completed',
      strategy: {
        prompt_version: 'mercury-alpha3-full-calibration-v2',
        response_contract_version: 'corrected-units-v1',
        output_budget_tokens: 4_096,
        input_unit_count: 1,
        returned_unit_count: 1,
        coverage_complete: true,
      },
    });
    expect(done.artifacts.outputs).toEqual([
      'output/source.transcribed.srt',
      'output/source.calibrated.srt',
    ]);
    expect(done.artifacts.subtitles).toMatchObject({
      transcribed: { purpose: 'unverified_transcription', validation: 'passed' },
      calibrated: { purpose: 'calibrated_result', validation: 'passed' },
    });
    expect(await readFile(path.join(root, 'output/source.transcribed.srt'), 'utf8')).toContain('您好世界和平');
    expect(await readFile(path.join(root, 'output/source.calibrated.srt'), 'utf8')).toContain('您好世界和平');
    const report = await readFile(path.join(root, 'output/calibration-report.md'), 'utf8');
    expect(report).toContain('纯转写字幕：output/source.transcribed.srt');
    expect(report).toContain('校验后字幕：output/source.calibrated.srt');
    const visible: string[] = [];
    expect(await runCli(['task', 'status', task.task_id], {
      homeDirectory: input.root,
      stdout: (value) => visible.push(value),
      stderr: (value) => visible.push(value),
    })).toBe(0);
    expect(visible.join('')).toContain(`纯转写字幕（未经 Chat 校验）：${path.join(root, 'output/source.transcribed.srt')}`);
    expect(visible.join('')).toContain(`校验后字幕：${path.join(root, 'output/source.calibrated.srt')}`);
    expect(done.artifacts.work).not.toContain('work/audio-verification.json');
    expect(JSON.stringify(done)).not.toContain('verifying_audio');
  });
  it('disables deep thinking only for the documented Volcengine Ark compatible endpoint', async () => {
    const chat = model('chat-text', 'chat', 'openai_chat_completions', TEXT);
    chat.endpoint = 'https://ark.cn-beijing.volces.com/api/v3';
    chat.config_fingerprint = computeModelConfigFingerprintV2(chat);
    chat.check!.config_fingerprint = chat.config_fingerprint;
    const input = await prepared(chat);
    const fetch = openAiFetch();
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
    });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      fetch,
    });
    expect(done.execution.status).toBe('completed');
    const request = JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body));
    expect(request).toMatchObject({
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      stream: true,
    });
  });
  it.each([
    {
      name: 'missing ID',
      finish: 'stop',
      response: (prompt: string) => JSON.stringify({ corrected_units: [] }),
      code: 'CALIBRATION_COVERAGE_INVALID',
    },
    {
      name: 'duplicate ID',
      finish: 'stop',
      response: (prompt: string) => {
        const unit = promptPayload(prompt).calibration_units[0]!;
        return JSON.stringify({ corrected_units: [unit, unit].map((item) => ({ unit_id: item.unit_id, corrected_text: item.original_text, rationale: null })) });
      },
      code: 'CALIBRATION_COVERAGE_INVALID',
    },
    {
      name: 'unknown ID',
      finish: 'stop',
      response: (prompt: string) => {
        const unit = promptPayload(prompt).calibration_units[0]!;
        return JSON.stringify({ corrected_units: [{ unit_id: 'unknown-unit', corrected_text: unit.original_text, rationale: null }] });
      },
      code: 'CALIBRATION_COVERAGE_INVALID',
    },
    {
      name: 'empty text',
      finish: 'stop',
      response: (prompt: string) => {
        const unit = promptPayload(prompt).calibration_units[0]!;
        return JSON.stringify({ corrected_units: [{ unit_id: unit.unit_id, corrected_text: '', rationale: null }] });
      },
      code: 'CALIBRATION_COVERAGE_INVALID',
    },
    {
      name: 'model explanation wrapper',
      finish: 'stop',
      response: (prompt: string) => {
        const unit = promptPayload(prompt).calibration_units[0]!;
        return JSON.stringify({ corrected_units: [{ unit_id: unit.unit_id, corrected_text: `修正后：${unit.original_text}`, rationale: null }] });
      },
      code: 'CALIBRATION_COVERAGE_INVALID',
    },
    {
      name: 'truncated structure',
      finish: 'stop',
      response: () => '{"corrected_units":[',
      code: 'CALIBRATION_COVERAGE_INVALID',
    },
    {
      name: 'provider length finish',
      finish: 'length',
      response: (prompt: string) => completeFromPrompt(prompt),
      code: 'CALIBRATION_RESPONSE_TRUNCATED',
    },
  ])('fails one-call incomplete response: $name', async ({ response, finish, code }) => {
    const input = await prepared(model('chat-text', 'chat', 'openai_chat_completions', TEXT));
    const fetch = openAiFetch(response, finish);
    const task = await createCalibrationTaskV2({ workspaceRoot: input.workspace, audioPath: input.audio });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, { asrAdapter: asr(), fetch });
    expect(fetch, JSON.stringify(done.error)).toHaveBeenCalledTimes(1);
    expect(done.execution.status).toBe('failed');
    expect(done.error?.code).toBe(code);
    const failedResult = JSON.parse(await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'));
    expect(failedResult.provider_outcome_certainty).toBe('known_terminal');
    expect(done.artifacts.outputs).toEqual(['output/source.transcribed.srt']);
    expect(await readFile(path.join(root, 'output/source.transcribed.srt'), 'utf8')).toContain('您好世界和平');
    await expect(readFile(path.join(root, 'output/source.calibrated.srt'), 'utf8')).rejects.toThrow();
  });
  it('applies a large legal model rewrite and derives the sparse modification locally', async () => {
    const input = await prepared(model('chat-text', 'chat', 'openai_chat_completions', TEXT));
    const fetch = openAiFetch((prompt) => {
      const unit = promptPayload(prompt).calibration_units[0]!;
      return JSON.stringify({
        corrected_units: [{
          unit_id: unit.unit_id,
          corrected_text: '完全不同而且明显更长的合法校验正文',
          rationale: '依据全文上下文修正',
        }],
      });
    });
    const task = await createCalibrationTaskV2({ workspaceRoot: input.workspace, audioPath: input.audio });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, { asrAdapter: asr(), fetch });
    expect(done.execution.status).toBe('completed');
    const result = JSON.parse(await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'));
    expect(result.corrected_units[0]).toMatchObject({ changed: true, corrected_text: '完全不同而且明显更长的合法校验正文' });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ disposition: 'applied' });
    expect(await readFile(path.join(root, 'output/source.transcribed.srt'), 'utf8')).toContain('您好世界和平');
    expect(await readFile(path.join(root, 'output/source.transcribed.srt'), 'utf8')).not.toContain('完全不同');
    expect(await readFile(path.join(root, 'output/source.calibrated.srt'), 'utf8')).toContain('完全不同而且明显更长的合法校验正文');
  });
  it('stops an OpenAI-compatible SSE request at finish_reason without waiting for keep-alive close', async () => {
    const input = await prepared(model('chat-text', 'chat', 'openai_chat_completions', TEXT));
    const cancel = vi.fn();
    const streamMetrics: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      const prompt = request.messages.find((message: any) => message.role === 'user').content;
      const complete = completeFromPrompt(prompt);
      const middle = Math.floor(complete.length / 2);
      const event = (content: string, finishReason: string | null = null) =>
        `data: ${JSON.stringify({ id: 'stream-request', choices: [{ delta: { content }, finish_reason: finishReason }] })}\n\n`;
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(event(complete.slice(0, middle))));
            controller.enqueue(encoder.encode(event(complete.slice(middle))));
            controller.enqueue(encoder.encode(event('', 'stop')));
          },
          cancel,
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const task = await createCalibrationTaskV2({ workspaceRoot: input.workspace, audioPath: input.audio });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      fetch,
      captureStreamMetrics: (metrics) => streamMetrics.push(metrics),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(done.execution.status).toBe('completed');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(streamMetrics).toEqual([
      expect.objectContaining({
        event_count: 3,
        ended_by: 'finish_reason',
        first_content_ms_from_headers: expect.any(Number),
        last_content_ms_from_headers: expect.any(Number),
        end_marker_ms_from_headers: expect.any(Number),
      }),
    ]);
    const result = JSON.parse(await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'));
    expect(result.strategy).toMatchObject({ provider_finish_reason: 'stop', coverage_complete: true });
  });
  it('rejects an SSE body that closes without a finish reason or DONE marker', async () => {
    const input = await prepared(model('chat-text', 'chat', 'openai_chat_completions', TEXT));
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      const prompt = request.messages.find((message: any) => message.role === 'user').content;
      const content = completeFromPrompt(prompt);
      return new Response(
        `data: ${JSON.stringify({ id: 'stream-incomplete', choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const task = await createCalibrationTaskV2({ workspaceRoot: input.workspace, audioPath: input.audio });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, { asrAdapter: asr(), fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(done.execution.status).toBe('interrupted');
    expect(done.error?.code).toBe('TASK_INTERRUPTED_PROVIDER_UNKNOWN');
    const failedResult = JSON.parse(await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'));
    expect(failedResult.provider_outcome_certainty).toBe('outcome_unknown');
    expect(done.artifacts.outputs).toEqual(['output/source.transcribed.srt']);
  });
  it('treats a 200 SSE body read interruption as Provider outcome unknown', async () => {
    const input = await prepared(model('chat-text', 'chat', 'openai_chat_completions', TEXT));
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"id":"partial","choices":[{"delta":{"content":"{\\"corrected_units\\":"}}]}\n\n'));
        controller.error(new Error('connection reset during body'));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const task = await createCalibrationTaskV2({ workspaceRoot: input.workspace, audioPath: input.audio });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, { asrAdapter: asr(), fetch });
    expect(done.execution.status).toBe('interrupted');
    expect(done.error).toMatchObject({ code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', retryable: false });
    const result = JSON.parse(await readFile(path.join(root, 'work/calibration-result.json'), 'utf8')) as any;
    expect(result.provider_outcome_certainty).toBe('outcome_unknown');
  });
  it('C02 keeps the exact 15,000,000-byte boundary multimodal in one Developer API interaction', async () => {
    const input = await prepared(
      model('chat-gemini', 'chat', 'gemini', AUDIO, 'developer_api'),
      15_000_000,
    );
    const requests: any[] = [];
    const create = vi.fn(async (request: any) => ({
      id: 'gemini-boundary',
      output_text: completeFromPrompt(request.input[0].text),
      finishReason: 'STOP',
    }));
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
    });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      captureRequest: (request) => requests.push(request),
      createDeveloperClient: () => ({
        interactions: { create },
        models: { generateContent: async () => ({}) },
      }),
      readCredential: async () => 'fixture-key',
    });
    expect(done.execution.status).toBe('completed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ store: false, max_output_tokens: 12_288 });
    expect(requests[0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
        expect.objectContaining({ type: 'audio', mime_type: 'audio/mpeg' }),
      ]),
    );
    const result = JSON.parse(
      await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'),
    );
    expect(result.request).toMatchObject({
      evidence_mode: 'audio_multimodal',
      non_strong_reason: null,
      input_modalities: ['text', 'audio'],
      audio: { bytes: 15_000_000 },
    });
    expect(result.strategy.output_budget_tokens).toBe(12_288);
  });
  it('C03 uses one multimodal Vertex call and text-only preserves segment count, order, and every timestamp', async () => {
    const input = await prepared(model('chat-gemini', 'chat', 'gemini', AUDIO));
    const srt = path.join(input.root, 'source.srt');
    const multilineReference = REFERENCE_TWO.replace(TIMED_TEXT[0], '您好世界，\n和平发展。');
    await writeFile(srt, multilineReference);
    const requests: any[] = [];
    const generateContent = vi.fn(async (request: any) => {
      const units = promptPayload(request.contents[0].parts[0].text).calibration_units;
      return {
        text: JSON.stringify({ corrected_units: units.map((unit, index) => ({
          unit_id: unit.unit_id,
          corrected_text: index === 0 ? '您好世界，和平与共同发展。' : '美好未来',
          rationale: '依据音频校正',
        })) }),
        responseId: 'gemini-1',
        modelVersion: 'fixture',
        finishReason: 'STOP',
      };
    });
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
      srtPath: srt,
      mode: 'text-only',
    });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: timedAsr(),
      captureRequest: (value) => requests.push(value),
      createVertexClient: () => ({
        interactions: {
          create: async () => {
            throw new Error('wrong');
          },
        },
        models: { generateContent },
      }),
    });
    expect(done.execution.status).toBe('completed');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('inlineData');
    expect(requests[0].config.maxOutputTokens).toBe(12_288);
    const sentPrompt = requests[0].contents[0].parts.find((part: any) => typeof part.text === 'string').text;
    const sentUnit = promptPayload(sentPrompt).calibration_units[0]!;
    expect(sentUnit.original_text).toBe('您好世界， 和平发展。');
    expect(sentUnit.original_text).not.toMatch(/[\r\n]/u);
    const result = JSON.parse(
      await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'),
    );
    expect(result.request.evidence_mode).toBe('audio_multimodal');
    expect(result.strategy.output_budget_tokens).toBe(12_288);
    const calibrated = JSON.parse(
      await readFile(
        path.join(root, 'work/transcript.calibrated.json'),
        'utf8',
      ),
    );
    expect(
      calibrated.segments.map((item: any) => [
        item.index,
        item.start_ms,
        item.end_ms,
        item.text,
      ]),
    ).toEqual([
      [0, 0, 26, '您好世界和平与共同发展'],
      [1, 26, 52, '美好未来'],
    ]);
  });
  it('C04 maps a complete reference unit onto traceable ASR timing and allowed splits', async () => {
    const input = await prepared(model('chat-gemini', 'chat', 'gemini', AUDIO));
    const srt = path.join(input.root, 'source.srt');
    await writeFile(srt, REFERENCE_JOINED);
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
      srtPath: srt,
      mode: 'text-and-segmentation',
    });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: timedAsr(),
      createVertexClient: () => ({
        interactions: { create: async () => ({}) },
        models: {
          generateContent: async (request: any) => ({
            text: completeFromPrompt(request.contents[0].parts[0].text),
            finishReason: 'STOP',
          }),
        },
      }),
    });
    expect(done.execution.status).toBe('completed');
    const result = JSON.parse(
      await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'),
    );
    const calibrated = JSON.parse(
      await readFile(
        path.join(root, 'work/transcript.calibrated.json'),
        'utf8',
      ),
    );
    expect(result.request).toMatchObject({
      mode: 'text-and-segmentation',
      evidence_mode: 'audio_multimodal',
    });
    expect(result.strategy).toMatchObject({
      input_unit_count: 1,
      returned_unit_count: 1,
      coverage_complete: true,
    });
    expect(calibrated.segments).toHaveLength(2);
    expect(calibrated.modifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'split',
          start_ms: 0,
          end_ms: 52,
          evidence: expect.objectContaining({
            asr_segment_refs: expect.arrayContaining(['seg-1', 'seg-2']),
          }),
        }),
      ]),
    );
  });
  it('C05/C06 freezes explicit non-default selections and historical artifacts after defaults change', async () => {
    const defaultChat = model(
      'chat-default',
      'chat',
      'openai_chat_completions',
      TEXT,
    );
    const explicitAsr = model('asr-explicit', 'asr', 'volcengine_asr', ASR);
    const explicitChat = model(
      'chat-explicit',
      'chat',
      'openai_chat_completions',
      TEXT,
    );
    const alternateAsr = model('asr-alternate', 'asr', 'volcengine_asr', ASR);
    const alternateChat = model(
      'chat-alternate',
      'chat',
      'openai_chat_completions',
      TEXT,
    );
    const input = await prepared(defaultChat, 834, [
      explicitAsr,
      explicitChat,
      alternateAsr,
      alternateChat,
    ]);
    const calls: string[] = [];
    const fetch = openAiFetch();
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
      asrModelId: 'asr-explicit',
      chatModelId: 'chat-explicit',
    });
    const root = await taskDir(input.workspace, task);
    const snapshotBefore = await readFile(
      path.join(root, 'work/model-snapshot.json'),
      'utf8',
    );
    input.registry.defaults = { asr: 'asr-alternate', chat: 'chat-alternate' };
    await writeFile(
      path.join(input.workspace, 'config/model-config.json'),
      JSON.stringify(input.registry),
    );
    await executeCalibrationTaskV2(root, { asrAdapter: asr(calls), fetch });
    const resultBefore = await readFile(
      path.join(root, 'work/calibration-result.json'),
      'utf8',
    );
    const taskBefore = await readFile(path.join(root, 'task.json'), 'utf8');
    input.registry.defaults = { asr: 'asr-default', chat: 'chat-default' };
    await writeFile(
      path.join(input.workspace, 'config/model-config.json'),
      JSON.stringify(input.registry),
    );
    const historical = await readTaskRecordV2(root);
    const snapshot = JSON.parse(snapshotBefore);
    expect(snapshot.models.asr.model_id).toBe('asr-explicit');
    expect(snapshot.models.chat.model_id).toBe('chat-explicit');
    expect(calls).toEqual(['asr-explicit']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string).model,
    ).toBe('chat-explicit-provider');
    expect(historical.task_id).toBe(task.task_id);
    expect(
      await readFile(path.join(root, 'work/model-snapshot.json'), 'utf8'),
    ).toBe(snapshotBefore);
    expect(
      await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'),
    ).toBe(resultBefore);
    expect(await readFile(path.join(root, 'task.json'), 'utf8')).toBe(
      taskBefore,
    );
  });
  it('C07 sends zero audio bytes for oversized MP3 and makes exactly one text Chat call', async () => {
    const input = await prepared(
      model('chat-gemini', 'chat', 'gemini', AUDIO, 'developer_api'),
      15_000_001,
    );
    const requests: any[] = [];
    const create = vi.fn(async (request: any) => ({
      id: 'gemini-text',
      output_text: completeFromPrompt(request.input[0].text),
      finishReason: 'STOP',
    }));
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
    });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      captureRequest: (request) => requests.push(request),
      createDeveloperClient: () => ({
        interactions: { create },
        models: { generateContent: async () => ({}) },
      }),
      readCredential: async () => 'fixture-key',
    });
    expect(done.execution.status).toBe('completed');
    expect(create).toHaveBeenCalledTimes(1);
    expect(requests[0].store).toBe(false);
    expect(JSON.stringify(requests[0])).not.toContain('"type":"audio"');
    expect(
      (await readdir(root, { recursive: true })).filter((name) =>
        /(staging|chunk|gcs|gemini.?files)/iu.test(String(name)),
      ),
    ).toEqual([]);
    const result = JSON.parse(
      await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'),
    );
    expect(result.request).toMatchObject({
      evidence_mode: 'text',
      non_strong_reason: 'audio_input_limit_exceeded',
      audio: null,
    });
    expect(
      await readFile(path.join(root, 'output/calibration-report.md'), 'utf8'),
    ).toContain('audio_input_limit_exceeded');
  });
  it('C08 fails a started multimodal request without retry, model switch, or successful SRT', async () => {
    const input = await prepared(model('chat-gemini', 'chat', 'gemini', AUDIO));
    const call = vi.fn(async () => {
      throw new Error('provider down');
    });
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
    });
    const root = await taskDir(input.workspace, task);
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      createVertexClient: () => ({
        interactions: { create: async () => ({}) },
        models: { generateContent: call },
      }),
    });
    expect(done.execution.status).toBe('interrupted');
    expect(done.error).toMatchObject({ code: 'TASK_INTERRUPTED_PROVIDER_UNKNOWN', retryable: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(done.artifacts.outputs).toEqual(['output/source.transcribed.srt']);
    expect(done.adapter_failures).toEqual([
      expect.objectContaining({
        model_category: 'chat',
        capability: 'calibration',
        provider_outcome_certainty: 'outcome_unknown',
      }),
    ]);
    const result = JSON.parse(
      await readFile(path.join(root, 'work/calibration-result.json'), 'utf8'),
    );
    expect(result.status).toBe('failed');
    expect(result.provider_outcome_certainty).toBe('outcome_unknown');
    expect(result.request.evidence_mode).toBe('audio_multimodal');
  });
  it('C11 writes no credentials, authorization header, redemption code, or full sensitive request body', async () => {
    const input = await prepared(
      model('chat-text', 'chat', 'openai_chat_completions', TEXT),
    );
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
    });
    const root = await taskDir(input.workspace, task);
    await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      fetch: openAiFetch(),
    });
    const files = await readdir(root, { recursive: true });
    const textFiles = files.filter(
      (name) => typeof name === 'string' && /\.(json|md|log)$/u.test(name),
    );
    const combined = (
      await Promise.all(
        textFiles.map((name) => readFile(path.join(root, name), 'utf8')),
      )
    ).join('\n');
    expect(combined).not.toMatch(
      /Authorization|Bearer\s|AIza|credit.{0,20}(code|兑换码)/iu,
    );
    expect(combined).not.toContain('fixture-key');
    expect(combined).not.toContain('你是 Mercury 的中文保真字幕校准模型');
    expect(combined).not.toContain('只返回 JSON 对象');
    });
  });
  it('freezes the alignment preflight terminal timestamps when the runtime clock advances each read', async () => {
    const input = await prepared(
      model('chat-text', 'chat', 'openai_chat_completions', TEXT),
    );
    const fetch = openAiFetch();
    const task = await createCalibrationTaskV2({
      workspaceRoot: input.workspace,
      audioPath: input.audio,
    });
    const root = await taskDir(input.workspace, task);
    let timestamp = Date.parse('2030-01-01T00:00:00.000Z');
    const done = await executeCalibrationTaskV2(root, {
      asrAdapter: asr(),
      fetch,
      now: () => new Date(timestamp++),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(done.execution.status).toBe('completed');
  });
