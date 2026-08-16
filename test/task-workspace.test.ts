import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateContract } from '../src/contracts/index.js';
import { MercuryError } from '../src/errors.js';
import {
  createCalibrationTask,
  createTaskId,
  findTask,
  listTasks,
  safeAudioStem,
  sha256File
} from '../src/tasks.js';
import { ensureWorkspace, WORKSPACE_SUBDIRECTORIES } from '../src/workspace.js';

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

async function writeRecognizableMp3(filePath: string): Promise<void> {
  const frames = Buffer.alloc(417 * 2);
  frames.set([0xff, 0xfb, 0x90, 0x64], 0);
  frames.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(filePath, frames);
}

async function installValidModelRegistry(workspaceRoot: string): Promise<void> {
  const fixture = await readFile(new URL('./fixtures/valid/model-config.json', import.meta.url), 'utf8');
  await writeFile(path.join(workspaceRoot, 'config', 'model-config.json'), fixture);
}

async function preparedWorkspace(): Promise<string> {
  const workspaceRoot = path.join(await temporaryDirectory('mercury-task-'), 'mercury-workspace');
  await ensureWorkspace(workspaceRoot);
  await installValidModelRegistry(workspaceRoot);
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('workspace initialization', () => {
  it('creates the fixed workspace directories idempotently without overwriting files', async () => {
    const workspaceRoot = path.join(await temporaryDirectory('mercury-workspace-'), 'mercury-workspace');
    await ensureWorkspace(workspaceRoot);
    const marker = path.join(workspaceRoot, 'config', 'keep.json');
    await writeFile(marker, '{"keep":true}\n');

    await ensureWorkspace(workspaceRoot);

    await expect(readFile(marker, 'utf8')).resolves.toBe('{"keep":true}\n');
    for (const directory of WORKSPACE_SUBDIRECTORIES) {
      expect((await stat(path.join(workspaceRoot, directory))).isDirectory()).toBe(true);
    }
  });

  it('fails instead of falling back when the workspace path is occupied by a file', async () => {
    const root = await temporaryDirectory('mercury-workspace-file-');
    const workspaceRoot = path.join(root, 'mercury-workspace');
    await writeFile(workspaceRoot, 'occupied');

    await expect(ensureWorkspace(workspaceRoot)).rejects.toMatchObject({ code: 'WORKSPACE_PATH_NOT_DIRECTORY' });
    await expect(stat(path.join(root, 'tasks'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('task identity and directory names', () => {
  it('uses local time and an eight-character lowercase random suffix', () => {
    const date = new Date(2026, 7, 6, 9, 8, 7);
    expect(createTaskId(date, () => '00abcdef')).toBe('tsk-20260806-090807-00abcdef');
  });

  it('preserves safe Unicode and bounds the readable suffix', () => {
    expect(safeAudioStem(' 产品 访谈：第一期.mp3')).toBe('产品-访谈-第一期');
    expect(Array.from(safeAudioStem(`${'长'.repeat(60)}.mp3`))).toHaveLength(40);
    expect(safeAudioStem('---.mp3')).toBe('audio');
  });
});

describe('calibration task skeleton', () => {
  it('creates the standard task tree, a valid D001 snapshot, and read-only verified input copies', async () => {
    const workspaceRoot = await preparedWorkspace();
    const sourceRoot = await temporaryDirectory('mercury-input-');
    const audio = path.join(sourceRoot, '中文 访谈.mp3');
    const srt = path.join(sourceRoot, 'reference.srt');
    await writeRecognizableMp3(audio);
    await writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\n你好，Mercury。\n');
    const beforeAudio = await stat(audio);
    const beforeSrt = await stat(srt);
    const beforeAudioHash = await sha256File(audio);
    const beforeSrtHash = await sha256File(srt);

    const task = await createCalibrationTask({
      workspaceRoot,
      audioPath: audio,
      srtPath: srt,
      mode: 'text-and-segmentation',
      verifyAudio: true,
      now: (() => {
        const times = [new Date('2026-08-06T01:00:00.000Z'), new Date('2026-08-06T01:00:01.000Z'), new Date('2026-08-06T01:00:02.000Z')];
        return () => times.shift() ?? new Date('2026-08-06T01:00:03.000Z');
      })(),
      randomHex: () => '1234abcd'
    });

    const taskDirectory = path.join(workspaceRoot, 'tasks', task.task_directory);
    expect(task.task_type).toBe('subtitle_calibration');
    expect(task.input_config).toEqual({ has_reference_srt: true, mode: 'text-and-segmentation', source_language: 'zh-CN' });
    expect(task.execution.status).toBe('analyzing_audio');
    expect(task.execution.last_completed_stage).toBe('preparing');
    expect(task.error).toBeNull();
    expect(task.adapter_failures).toEqual([]);
    expect(task.audio_verification).toEqual({ requested: true, artifact_path: null, sha256: null });
    for (const directory of ['input', 'work', 'output', 'logs']) {
      expect((await stat(path.join(taskDirectory, directory))).isDirectory()).toBe(true);
    }

    const snapshot = JSON.parse(await readFile(path.join(taskDirectory, 'work', 'model-snapshot.json'), 'utf8')) as any;
    expect(validateContract('model-snapshot', snapshot).valid).toBe(true);
    expect(snapshot.models.asr).toMatchObject({
      plugin_id: 'volcengine_asr',
      connection_type: 'volcengine_cloud',
      declared_capabilities: { input_modalities: ['audio'] },
      check_snapshot: { verified_capabilities: { task_capabilities: ['transcription'] } }
    });
    expect(snapshot.models.calibration).toMatchObject({
      plugin_id: 'openai_chat_completions',
      connection_type: 'compatible_endpoint',
      declared_capabilities: { input_modalities: ['text'] },
      check_snapshot: { verified_capabilities: { task_capabilities: ['proofreading'] } }
    });
    expect(task.model_snapshot.path).toBe('work/model-snapshot.json');
    expect(task.inputs.audio.copy_verified).toBe(true);
    expect(task.inputs.reference_srt?.copy_verified).toBe(true);
    expect(await sha256File(path.join(taskDirectory, task.inputs.audio.workspace_copy_path))).toBe(beforeAudioHash);
    expect(await sha256File(path.join(taskDirectory, task.inputs.reference_srt!.workspace_copy_path))).toBe(beforeSrtHash);
    expect((await stat(path.join(taskDirectory, task.inputs.audio.workspace_copy_path))).mode & 0o777).toBe(0o444);
    expect((await stat(path.join(taskDirectory, task.inputs.reference_srt!.workspace_copy_path))).mode & 0o777).toBe(0o444);

    const afterAudio = await stat(audio);
    const afterSrt = await stat(srt);
    expect(await sha256File(audio)).toBe(beforeAudioHash);
    expect(await sha256File(srt)).toBe(beforeSrtHash);
    expect({ size: afterAudio.size, mtimeMs: afterAudio.mtimeMs }).toEqual({ size: beforeAudio.size, mtimeMs: beforeAudio.mtimeMs });
    expect({ size: afterSrt.size, mtimeMs: afterSrt.mtimeMs }).toEqual({ size: beforeSrt.size, mtimeMs: beforeSrt.mtimeMs });
  });

  it('creates distinct tasks for the same audio and lists newest first', async () => {
    const workspaceRoot = await preparedWorkspace();
    const sourceRoot = await temporaryDirectory('mercury-repeat-');
    const audio = path.join(sourceRoot, 'same.mp3');
    await writeRecognizableMp3(audio);

    const first = await createCalibrationTask({ workspaceRoot, audioPath: audio, now: () => new Date('2026-08-06T01:00:00.000Z'), randomHex: () => '00000001' });
    const second = await createCalibrationTask({ workspaceRoot, audioPath: audio, now: () => new Date('2026-08-06T01:00:01.000Z'), randomHex: () => '00000002' });

    expect(first.task_id).not.toBe(second.task_id);
    expect(first.task_directory).not.toBe(second.task_directory);
    expect((await listTasks(workspaceRoot)).map((task) => task.task_id)).toEqual([second.task_id, first.task_id]);
    await expect(findTask(workspaceRoot, first.task_id)).resolves.toMatchObject({ task_id: first.task_id });
  });

  it('rejects invalid input and argument combinations before creating a task', async () => {
    const workspaceRoot = await preparedWorkspace();
    const sourceRoot = await temporaryDirectory('mercury-invalid-');
    const fakeAudio = path.join(sourceRoot, 'fake.mp3');
    const incompleteFrame = Buffer.alloc(256);
    incompleteFrame.set([0xff, 0xfb, 0x90, 0x64], 0);
    await writeFile(fakeAudio, incompleteFrame);

    await expect(createCalibrationTask({ workspaceRoot, audioPath: fakeAudio })).rejects.toMatchObject({ code: 'AUDIO_CONTENT_INVALID' });
    await expect(createCalibrationTask({ workspaceRoot, audioPath: fakeAudio, mode: 'text-only' })).rejects.toMatchObject({ code: 'CALIBRATION_MODE_REQUIRES_SRT' });
    expect(await listTasks(workspaceRoot)).toEqual([]);
  });

  it('refuses task creation until both required model checks have passed', async () => {
    const workspaceRoot = path.join(await temporaryDirectory('mercury-no-models-'), 'mercury-workspace');
    await ensureWorkspace(workspaceRoot);
    const audio = path.join(await temporaryDirectory('mercury-model-input-'), 'input.mp3');
    await writeRecognizableMp3(audio);

    await expect(createCalibrationTask({ workspaceRoot, audioPath: audio })).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    expect(await listTasks(workspaceRoot)).toEqual([]);
  });

  it('rejects path traversal task IDs', async () => {
    const workspaceRoot = await preparedWorkspace();
    await expect(findTask(workspaceRoot, '../../task.json')).rejects.toBeInstanceOf(MercuryError);
    await expect(findTask(workspaceRoot, '../../task.json')).rejects.toMatchObject({ code: 'TASK_ID_INVALID' });
  });
});
