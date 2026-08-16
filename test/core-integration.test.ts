import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterFailureRecord,
  AsrAdapter,
  CalibrationAdapter,
  ErrorRecord
} from '../src/contracts/index.js';
import {
  executeCalibrationTask,
  reconcileInterruptedTask,
  type CoreIntegrationDependencies
} from '../src/core-integration.js';
import {
  createCalibrationTask,
  persistTaskRecord,
  readTaskRecord,
  sha256File,
  writeJsonAtomic,
  type CalibrationMode
} from '../src/tasks.js';
import { ensureWorkspace } from '../src/workspace.js';

const roots: string[] = [];
const REFERENCE_SRT = '1\n00:00:00,000 --> 00:00:00,052\n你好\n';

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

async function writeRecognizableMp3(filePath: string, bytes = 417 * 2): Promise<void> {
  const frames = Buffer.alloc(bytes);
  frames.set([0xff, 0xfb, 0x90, 0x64], 0);
  frames.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(filePath, frames);
}

async function preparedInputs(hasReference: boolean, audioBytes?: number): Promise<{
  workspaceRoot: string;
  audio: string;
  srt: string | undefined;
}> {
  const root = await temporaryDirectory('mercury-core-integration-');
  const workspaceRoot = path.join(root, 'mercury-workspace');
  await ensureWorkspace(workspaceRoot);
  await writeFile(
    path.join(workspaceRoot, 'config', 'model-config.json'),
    await readFile(new URL('./fixtures/valid/model-config.json', import.meta.url), 'utf8')
  );
  const audio = path.join(root, 'source.mp3');
  await writeRecognizableMp3(audio, audioBytes);
  if (!hasReference) return { workspaceRoot, audio, srt: undefined };
  const srt = path.join(root, 'source.srt');
  await writeFile(srt, REFERENCE_SRT);
  return { workspaceRoot, audio, srt };
}

function successfulAsr(): AsrAdapter {
  return {
    adapterId: 'volcengine_asr',
    async run(input) {
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
            mime_type: 'audio/mpeg'
          },
          full_text: '你好',
          segments: [{
            segment_id: 'seg-0001',
            index: 0,
            start_ms: 0,
            end_ms: input.audio.durationMs,
            text: '你好',
            confidence: 0.99,
            words: []
          }],
          model_snapshot_ref: input.modelSnapshotRef,
          call: {
            call_id: 'call-asr-integration',
            model_snapshot_entry_ref: input.model.snapshot_entry_id,
            started_at: '2030-01-01T00:00:00.000Z',
            ended_at: '2030-01-01T00:00:01.000Z',
            outcome: 'completed',
            error_ref: null
          },
          raw_response_ref: null,
          warnings: [],
          errors: []
        }
      };
    }
  };
}

function successfulCalibration(): CalibrationAdapter {
  return {
    adapterId: 'openai_chat_completions',
    async run(input) {
      return {
        kind: 'artifact',
        artifact: {
          schema_version: '1.0.0',
          task_id: input.taskId,
          created_at: '2030-01-01T00:00:02.000Z',
          status: 'completed',
          request: {
            transcript_ref: 'work/transcript.raw.json',
            reference_srt_ref: input.referenceSrt?.pathRef ?? null,
            mode: input.mode
          },
          model_snapshot_ref: input.modelSnapshotRef,
          call: {
            call_id: 'call-calibration-integration',
            model_snapshot_entry_ref: input.model.snapshot_entry_id,
            started_at: '2030-01-01T00:00:01.000Z',
            ended_at: '2030-01-01T00:00:02.000Z',
            outcome: 'completed',
            error_ref: null
          },
          suggestions: [],
          warnings: [],
          errors: []
        }
      };
    }
  };
}

function successfulDependencies(): CoreIntegrationDependencies {
  return { asrAdapter: successfulAsr(), calibrationAdapter: successfulCalibration() };
}

async function createTask(
  hasReference: boolean,
  mode?: CalibrationMode,
  verifyAudio = false,
  audioBytes?: number
): Promise<{ taskDirectory: string; audio: string; srt: string | undefined }> {
  const inputs = await preparedInputs(hasReference, audioBytes);
  const task = await createCalibrationTask({
    workspaceRoot: inputs.workspaceRoot,
    audioPath: inputs.audio,
    ...(inputs.srt ? { srtPath: inputs.srt } : {}),
    ...(mode ? { mode } : {}),
    verifyAudio
  });
  return {
    taskDirectory: path.join(inputs.workspaceRoot, 'tasks', task.task_directory),
    audio: inputs.audio,
    srt: inputs.srt
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('D007 core integration', () => {
  it('records a requested but unconfigured verification as skipped without falling back or failing the base path', async () => {
    const inputs = await preparedInputs(false);
    const configPath = path.join(inputs.workspaceRoot, 'config', 'model-config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { models: Array<{ role: string }>; defaults: Record<string, string> };
    config.models = config.models.filter((model) => model.role !== 'audio_verification');
    delete config.defaults.audio_verification;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const task = await createCalibrationTask({ workspaceRoot: inputs.workspaceRoot, audioPath: inputs.audio, verifyAudio: true });
    const taskDirectory = path.join(inputs.workspaceRoot, 'tasks', task.task_directory);
    const completed = await executeCalibrationTask(taskDirectory, successfulDependencies());
    const audio = JSON.parse(await readFile(path.join(taskDirectory, 'work/audio-verification.json'), 'utf8')) as { status: string; skip_reason: string };
    expect(completed.execution.status).toBe('completed');
    expect(audio).toMatchObject({ status: 'skipped', skip_reason: 'not_configured' });
  });

  it('runs requested D009 verification through the frozen Gemini plugin and keeps the base task successful', async () => {
    const prepared = await createTask(false, undefined, true);
    const generateContent = async () => ({
      text: JSON.stringify({ findings: [{
        kind: 'text_correction', start_ms: 0, end_ms: 52,
        current_text: '你好', suggested_text: '您好', rationale: '音频支持“您”。', confidence: 'high'
      }] }),
      modelVersion: 'gemini-audio-fixture-v1', responseId: 'gemini-task-call'
    });
    const completed = await executeCalibrationTask(prepared.taskDirectory, {
      ...successfulDependencies(),
      createVertexClient: () => ({
        interactions: { create: async () => { throw new Error('wrong connection'); } },
        files: {
          upload: async () => { throw new Error('wrong connection'); },
          delete: async () => { throw new Error('wrong connection'); }
        },
        models: { generateContent }
      })
    });

    expect(completed.execution.status).toBe('completed');
    expect(completed.audio_verification).toMatchObject({ requested: true, artifact_path: 'work/audio-verification.json' });
    const audio = JSON.parse(await readFile(path.join(prepared.taskDirectory, 'work/audio-verification.json'), 'utf8')) as { status: string; calls: unknown[] };
    expect(audio).toMatchObject({ status: 'completed' });
    expect(audio.calls).toHaveLength(1);
    const calibrated = JSON.parse(
      await readFile(path.join(prepared.taskDirectory, 'work/transcript.calibrated.json'), 'utf8')
    ) as { modifications: Array<{ original_segment_refs: string[] }> };
    expect(calibrated.modifications[0]?.original_segment_refs).toEqual(['seg-0001']);
    expect(calibrated.modifications[0]?.original_segment_refs).not.toContain('subtitle-0001');
    await expect(readFile(path.join(prepared.taskDirectory, completed.artifacts.outputs[0]!), 'utf8')).resolves.toContain('您好');
    await expect(readFile(path.join(prepared.taskDirectory, 'output/calibration-report.md'), 'utf8'))
      .resolves.toContain('connection=vertex_ai');
  });

  it('skips a 15,000,001-byte Gemini input before Provider access and completes the base SRT and report', async () => {
    const prepared = await createTask(false, undefined, true, 15_000_001);
    const createVertexClient = vi.fn(() => ({
      interactions: { create: vi.fn() },
      files: { upload: vi.fn(), delete: vi.fn() },
      models: { generateContent: vi.fn() }
    }));
    const completed = await executeCalibrationTask(prepared.taskDirectory, {
      ...successfulDependencies(),
      createVertexClient
    });

    expect(completed.execution.status).toBe('completed');
    expect(createVertexClient).not.toHaveBeenCalled();
    const audio = JSON.parse(
      await readFile(path.join(prepared.taskDirectory, 'work/audio-verification.json'), 'utf8')
    ) as { status: string; skip_reason: string; calls: unknown[]; local_chunking: unknown };
    expect(audio).toMatchObject({
      status: 'skipped',
      skip_reason: 'input_limit_exceeded',
      calls: [],
      local_chunking: null
    });
    await expect(readFile(path.join(prepared.taskDirectory, completed.artifacts.outputs[0]!), 'utf8'))
      .resolves.toContain('你好');
    await expect(readFile(path.join(prepared.taskDirectory, 'output/calibration-report.md'), 'utf8'))
      .resolves.toContain('V0.1 Gemini 强校验仅支持不超过 15MB');
  });

  it('keeps the base result successful when the optional Gemini provider call fails', async () => {
    const prepared = await createTask(false, undefined, true);
    const completed = await executeCalibrationTask(prepared.taskDirectory, {
      ...successfulDependencies(),
      createVertexClient: () => ({
        interactions: { create: async () => { throw new Error('wrong connection'); } },
        files: {
          upload: async () => { throw new Error('wrong connection'); },
          delete: async () => { throw new Error('wrong connection'); }
        },
        models: { generateContent: async () => { throw new Error('provider unavailable'); } }
      })
    });
    const audio = JSON.parse(await readFile(path.join(prepared.taskDirectory, 'work/audio-verification.json'), 'utf8')) as { status: string; errors: Array<{ code: string }> };
    expect(completed.execution.status).toBe('completed');
    expect(audio).toMatchObject({ status: 'failed', errors: [{ code: 'GEMINI_MODEL_CALL_FAILED' }] });
  });

  it.each([
    ['MP3 only', false, undefined],
    ['MP3 plus SRT text-only', true, 'text-only'],
    ['MP3 plus SRT text-and-segmentation', true, 'text-and-segmentation']
  ] as const)('completes the %s path and preserves original inputs', async (_label, hasReference, mode) => {
    const prepared = await createTask(hasReference, mode);
    const audioBefore = await stat(prepared.audio);
    const audioHash = await sha256File(prepared.audio);
    const srtBefore = prepared.srt ? await stat(prepared.srt) : null;
    const srtHash = prepared.srt ? await sha256File(prepared.srt) : null;

    const completed = await executeCalibrationTask(prepared.taskDirectory, successfulDependencies());

    expect(completed.execution.status).toBe('completed');
    expect(completed.execution.last_completed_stage).toBe('validating');
    expect(completed.adapter_failures).toEqual([]);
    expect(completed.audio_verification.requested).toBe(false);
    expect(completed.audio_verification.artifact_path).toBe('work/audio-verification.json');
    expect(completed.artifacts.work).toEqual(expect.arrayContaining([
      'work/model-snapshot.json',
      'work/transcript.raw.json',
      'work/alignment.json',
      'work/calibration-result.json',
      'work/audio-verification.json',
      'work/transcript.calibrated.json'
    ]));
    expect(completed.artifacts.outputs).toHaveLength(1);
    expect(completed.artifacts.report).toBe('output/calibration-report.md');
    await expect(readFile(path.join(prepared.taskDirectory, completed.artifacts.outputs[0]!), 'utf8')).resolves.toContain('你好');
    await expect(readFile(path.join(prepared.taskDirectory, 'output/calibration-report.md'), 'utf8')).resolves.toContain('not_requested');
    const audioVerification = JSON.parse(await readFile(path.join(prepared.taskDirectory, 'work/audio-verification.json'), 'utf8')) as { status: string };
    expect(audioVerification.status).toBe('not_requested');

    const audioAfter = await stat(prepared.audio);
    expect(await sha256File(prepared.audio)).toBe(audioHash);
    expect({ size: audioAfter.size, mtimeMs: audioAfter.mtimeMs }).toEqual({ size: audioBefore.size, mtimeMs: audioBefore.mtimeMs });
    if (prepared.srt && srtBefore) {
      const srtAfter = await stat(prepared.srt);
      expect(await sha256File(prepared.srt)).toBe(srtHash);
      expect({ size: srtAfter.size, mtimeMs: srtAfter.mtimeMs }).toEqual({ size: srtBefore.size, mtimeMs: srtBefore.mtimeMs });
    }

    const restartedRead = await readTaskRecord(prepared.taskDirectory);
    expect(restartedRead.execution.status).toBe('completed');
    expect(restartedRead.artifacts).toEqual(completed.artifacts);
  });

  it('runs the production path through model-center plugin resolution', async () => {
    const prepared = await createTask(false);
    const requests: string[] = [];
    const fetchMock = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requests.push(url);
      if (url.includes('openspeech.bytedance.com')) {
        return new Response(JSON.stringify({
          result: {
            text: '你好',
            utterances: [{ start_time: 0, end_time: 52, text: '你好' }]
          }
        }), { status: 200, headers: { 'X-Api-Status-Code': '20000000' } });
      }
      return Response.json({
        id: 'provider-calibration-model-center',
        choices: [{ message: { content: JSON.stringify({
          suggestions: [{
            suggestion_id: 1,
            kind: 'text_correction',
            source_segment_refs: ['asr-segment-0001'],
            start_ms: 0,
            end_ms: 52,
            original_text: '\n你\u200B好\r',
            suggested_text: '\n您\u200B好\r',
            rationale: '\nprovider response normalization fixture\r',
            confidence: 'high'
          }]
        }) } }]
      });
    };

    const completed = await executeCalibrationTask(prepared.taskDirectory, {
      fetch: fetchMock,
      resolveAsrCredential: async () => ({ mode: 'api_key', uid: 'test-user', value: 'fake-test-value' }),
      readCredential: async () => 'fake-test-value'
    });

    expect(completed.execution.status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('openspeech.bytedance.com');
    expect(requests[1]).toContain('/chat/completions');
    const calibration = JSON.parse(
      await readFile(path.join(prepared.taskDirectory, 'work/calibration-result.json'), 'utf8')
    ) as { suggestions: Array<Record<string, unknown>> };
    expect(calibration.suggestions[0]).toMatchObject({
      suggestion_id: 'suggestion-0001',
      original_text: '你好',
      suggested_text: '您好',
      rationale: 'provider response normalization fixture'
    });
  });

  it('persists an ASR supplier failure before entering failed', async () => {
    const prepared = await createTask(false);
    const asrAdapter: AsrAdapter = {
      adapterId: 'volcengine_asr',
      async run(input) {
        const error: ErrorRecord = {
          error_id: 'error-asr-provider', code: 'MODEL_HTTP_ERROR', message: 'ASR provider returned HTTP 503.',
          stage: 'model_call', retryable: true
        };
        const failure: AdapterFailureRecord = {
          failure_id: 'failure-asr-provider', task_id: input.taskId, role: 'asr',
          model_snapshot_ref: input.modelSnapshotRef, occurred_at: '2030-01-01T00:00:01.000Z',
          provider_outcome_certainty: 'known_terminal',
          errors: [error], warnings: [],
          call: {
            call_id: 'call-asr-provider', model_snapshot_entry_ref: input.model.snapshot_entry_id,
            started_at: '2030-01-01T00:00:00.000Z', ended_at: '2030-01-01T00:00:01.000Z',
            outcome: 'failed', error_ref: error.error_id
          },
          staging: []
        };
        return { kind: 'failure', failure };
      }
    };

    const failed = await executeCalibrationTask(prepared.taskDirectory, {
      asrAdapter,
      calibrationAdapter: successfulCalibration()
    });

    expect(failed.execution.status).toBe('failed');
    expect(failed.error?.code, failed.error?.message).toBe('MODEL_HTTP_ERROR');
    expect(failed.adapter_failures).toHaveLength(1);
    expect(failed.adapter_failures[0]?.failure_id).toBe('failure-asr-provider');
    expect(failed.artifacts.work).not.toContain('work/transcript.raw.json');
    expect(failed.artifacts.outputs).toEqual([]);
    await expect(readFile(path.join(prepared.taskDirectory, 'output/calibration-report.md'), 'utf8')).resolves.toContain('MODEL_HTTP_ERROR');
  });

  it('keeps a legal failed calibration artifact authoritative without duplicating adapter_failures', async () => {
    const prepared = await createTask(false);
    const calibrationAdapter: CalibrationAdapter = {
      adapterId: 'openai_chat_completions',
      async run(input) {
        const error: ErrorRecord = {
          error_id: 'error-calibration-provider', code: 'MODEL_HTTP_ERROR', message: 'Calibration provider returned HTTP 503.',
          stage: 'model_call', retryable: true
        };
        return {
          kind: 'artifact',
          artifact: {
            schema_version: '1.0.0', task_id: input.taskId, created_at: '2030-01-01T00:00:02.000Z', status: 'failed',
            request: { transcript_ref: 'work/transcript.raw.json', reference_srt_ref: null, mode: null },
            model_snapshot_ref: input.modelSnapshotRef,
            call: {
              call_id: 'call-calibration-failed', model_snapshot_entry_ref: input.model.snapshot_entry_id,
              started_at: '2030-01-01T00:00:01.000Z', ended_at: '2030-01-01T00:00:02.000Z',
              outcome: 'failed', error_ref: error.error_id
            },
            suggestions: [], warnings: [], errors: [error]
          }
        };
      }
    };

    const failed = await executeCalibrationTask(prepared.taskDirectory, {
      asrAdapter: successfulAsr(),
      calibrationAdapter
    });

    expect(failed.execution.status).toBe('failed');
    expect(failed.error?.code).toBe('MODEL_HTTP_ERROR');
    expect(failed.adapter_failures).toEqual([]);
    expect(failed.artifacts.work).toContain('work/calibration-result.json');
    expect(failed.artifacts.outputs).toEqual([]);
  });

  it('fails closed and records D001 evidence when an adapter returns an illegal artifact', async () => {
    const prepared = await createTask(false);
    const invalidAsr: AsrAdapter = {
      adapterId: 'volcengine_asr',
      async run() {
        return { kind: 'artifact', artifact: { schema_version: '9.9.9' } as never };
      }
    };

    const failed = await executeCalibrationTask(prepared.taskDirectory, {
      asrAdapter: invalidAsr,
      calibrationAdapter: successfulCalibration()
    });

    expect(failed.execution.status).toBe('failed');
    expect(failed.error?.code, failed.error?.message).toBe('ASR_ARTIFACT_INVALID');
    expect(failed.adapter_failures).toHaveLength(1);
    expect(failed.adapter_failures[0]?.errors[0].code).toBe('ASR_ARTIFACT_INVALID');
    expect(failed.artifacts.work).not.toContain('work/transcript.raw.json');
    expect(failed.artifacts.outputs).toEqual([]);
  });

  it('rejects an otherwise shaped transcript whose snapshot reference is incompatible', async () => {
    const prepared = await createTask(false);
    const mismatchedAsr: AsrAdapter = {
      adapterId: 'volcengine_asr',
      async run(input) {
        const result = await successfulAsr().run(input);
        if (result.kind === 'artifact') result.artifact.model_snapshot_ref = 'snapshot-other-task';
        return result;
      }
    };

    const failed = await executeCalibrationTask(prepared.taskDirectory, {
      asrAdapter: mismatchedAsr,
      calibrationAdapter: successfulCalibration()
    });

    expect(failed.execution.status).toBe('failed');
    expect(failed.error?.code).toBe('ASR_ARTIFACT_INVALID');
    expect(failed.adapter_failures).toHaveLength(1);
    expect(failed.artifacts.work).not.toContain('work/transcript.raw.json');
  });

  it('detects a changed task audio copy before any provider adapter runs', async () => {
    const prepared = await createTask(false);
    const task = await readTaskRecord(prepared.taskDirectory);
    const audioCopy = path.join(prepared.taskDirectory, task.inputs.audio.workspace_copy_path);
    await chmod(audioCopy, 0o644);
    const changedFrames = Buffer.alloc(417 * 3);
    for (const offset of [0, 417, 834]) changedFrames.set([0xff, 0xfb, 0x90, 0x64], offset);
    await writeFile(audioCopy, changedFrames);
    let adapterCalled = false;
    const asrAdapter: AsrAdapter = {
      adapterId: 'volcengine_asr',
      async run() {
        adapterCalled = true;
        throw new Error('must not run');
      }
    };

    const failed = await executeCalibrationTask(prepared.taskDirectory, {
      asrAdapter,
      calibrationAdapter: successfulCalibration()
    });

    expect(adapterCalled).toBe(false);
    expect(failed.execution.status).toBe('failed');
    expect(failed.error?.code).toBe('INPUT_COPY_HASH_MISMATCH');
    expect(failed.adapter_failures).toEqual([]);
    expect(failed.artifacts.report).toBe('output/calibration-report.md');
  });

  it('marks a dead nonterminal execution as interrupted and keeps the last state on repeated reads', async () => {
    const prepared = await createTask(false);
    const before = await readTaskRecord(prepared.taskDirectory);
    expect(before.execution.status).toBe('analyzing_audio');

    const interrupted = await reconcileInterruptedTask(prepared.taskDirectory, {
      now: () => new Date('2030-01-01T00:00:03.000Z'),
      processExists: () => false
    });

    expect(interrupted.execution.status).toBe('analyzing_audio');
    expect(interrupted.execution.execution_interrupted).toBe(true);
    expect(interrupted.execution.ended_at).toBeNull();
    expect(interrupted.warnings.some((warning) => warning.code === 'TASK_EXECUTION_INTERRUPTED')).toBe(true);
    expect(interrupted.artifacts.outputs).toEqual([]);
    expect(interrupted.artifacts.report).toBe('output/calibration-report.md');
    const report = await readFile(path.join(prepared.taskDirectory, 'output/calibration-report.md'), 'utf8');
    expect(report).toContain('TASK_EXECUTION_INTERRUPTED');

    const repeated = await reconcileInterruptedTask(prepared.taskDirectory, {
      processExists: () => false
    });
    expect(repeated.execution.status).toBe('analyzing_audio');
    expect(repeated.warnings.filter((warning) => warning.code === 'TASK_EXECUTION_INTERRUPTED')).toHaveLength(1);

    repeated.artifacts.report = null;
    await rm(path.join(prepared.taskDirectory, 'output', 'calibration-report.md'));
    await persistTaskRecord(prepared.taskDirectory, repeated);
    const repairedRead = await reconcileInterruptedTask(prepared.taskDirectory);
    expect(repairedRead.execution.status).toBe('analyzing_audio');
    expect(repairedRead.artifacts.report).toBe('output/calibration-report.md');
  });

  it('does not mark a nonterminal task interrupted while its execution marker process is alive', async () => {
    const prepared = await createTask(false);
    const task = await readTaskRecord(prepared.taskDirectory);
    await writeJsonAtomic(path.join(prepared.taskDirectory, 'logs', 'execution.json'), {
      schema_version: '1.0.0', task_id: task.task_id, process_id: 4242, started_at: '2030-01-01T00:00:00.000Z'
    });

    const active = await reconcileInterruptedTask(prepared.taskDirectory, { processExists: (pid) => pid === 4242 });

    expect(active.execution.status).toBe('analyzing_audio');
    expect(active.execution.execution_interrupted).toBe(false);
    expect(active.artifacts.report).toBeNull();
  });
});
