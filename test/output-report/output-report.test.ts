import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AudioVerification,
  CalibrationResult,
  ModelSnapshot,
  TranscriptRaw
} from '../../src/contracts/index.js';
import {
  buildCalibrationReport,
  formatSrtTimestamp,
  generateTaskOutputs,
  serializeCalibratedSrt,
  validateSrtFile,
  validateSrtText,
  wrapSubtitleText,
  type ReportContext
} from '../../src/output-report/index.js';
import {
  runSubtitleCore,
  type AlignmentArtifact,
  type CalibratedTranscript,
  type SubtitleCoreResult
} from '../../src/subtitle-core/index.js';
import type { TaskRecord, TaskStatus } from '../../src/tasks.js';

const TASK_ID = 'tsk-20260807-120000-aabbccdd';
const REFERENCE_SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,500',
  '欢迎使用水兴',
  '',
  '2',
  '00:00:02,500 --> 00:00:05,000',
  '字幕工具',
  ''
].join('\n');
const taskDirectories: string[] = [];

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../fixtures/valid/${name}`, import.meta.url), 'utf8')) as T;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface PreparedTask {
  directory: string;
  task: TaskRecord;
  subtitleResult: Extract<SubtitleCoreResult, { status: 'completed' }>;
}

interface PrepareOptions {
  status?: TaskStatus;
  interrupted?: boolean;
  audioStatus?: AudioVerification['status'];
  requestedAudio?: boolean;
  hasReference?: boolean;
  mode?: 'text-only' | 'text-and-segmentation' | null;
  mutateCalibrated?: (artifact: CalibratedTranscript) => void;
  mutateAlignment?: (artifact: AlignmentArtifact) => void;
  omitSource?: 'transcript' | 'calibration' | 'alignment' | 'calibrated' | 'audio-verification';
}

async function prepareTask(options: PrepareOptions = {}): Promise<PreparedTask> {
  const root = await mkdtemp(path.join(tmpdir(), 'mercury-output-report-'));
  taskDirectories.push(root);
  const directory = path.join(root, `${TASK_ID}-sample`);
  await Promise.all([
    mkdir(path.join(directory, 'input'), { recursive: true }),
    mkdir(path.join(directory, 'work'), { recursive: true }),
    mkdir(path.join(directory, 'output'), { recursive: true }),
    mkdir(path.join(directory, 'logs'), { recursive: true })
  ]);

  const modelSnapshot = await fixture<ModelSnapshot>('model-snapshot.json');
  const transcript = await fixture<TranscriptRaw>('transcript.raw.json');
  const calibration = await fixture<CalibrationResult>('calibration-result.json');
  const hasReference = options.hasReference ?? true;
  const mode = hasReference ? options.mode ?? 'text-only' : null;
  modelSnapshot.task_id = TASK_ID;
  transcript.task_id = TASK_ID;
  calibration.task_id = TASK_ID;
  calibration.request.reference_srt_ref = hasReference ? 'input/reference.srt' : null;
  calibration.request.mode = mode;
  if (!hasReference) calibration.suggestions = [];
  const audioStatus = options.audioStatus ?? 'not_requested';
  if (audioStatus === 'not_requested' || audioStatus === 'skipped') delete modelSnapshot.models.audio_verification;
  const audio = await fixture<AudioVerification>(`audio-verification.${audioStatus === 'not_requested' ? 'not-requested' : audioStatus}.json`);
  audio.task_id = TASK_ID;

  const subtitleResult = runSubtitleCore({
    transcript,
    calibrationResult: calibration,
    referenceSrtText: hasReference ? REFERENCE_SRT : null,
    requestedMode: mode
  });
  if (subtitleResult.status !== 'completed') throw new Error(`fixture did not calibrate: ${subtitleResult.status}`);
  options.mutateAlignment?.(subtitleResult.alignment);
  options.mutateCalibrated?.(subtitleResult.artifact);

  await writeFile(path.join(directory, 'input', 'sample.mp3'), 'fixture audio', 'utf8');
  if (hasReference) await writeFile(path.join(directory, 'input', 'reference.srt'), REFERENCE_SRT, 'utf8');
  await writeJson(path.join(directory, 'work', 'model-snapshot.json'), modelSnapshot);
  if (options.omitSource !== 'transcript') await writeJson(path.join(directory, 'work', 'transcript.raw.json'), transcript);
  if (options.omitSource !== 'calibration') await writeJson(path.join(directory, 'work', 'calibration-result.json'), calibration);
  if (options.omitSource !== 'alignment') await writeJson(path.join(directory, 'work', 'alignment.json'), subtitleResult.alignment);
  if (options.omitSource !== 'calibrated') await writeJson(path.join(directory, 'work', 'transcript.calibrated.json'), subtitleResult.artifact);
  if (options.omitSource !== 'audio-verification') await writeJson(path.join(directory, 'work', 'audio-verification.json'), audio);
  await writeJson(path.join(directory, 'work', 'provider-response.asr.redacted.json'), { redacted: true });

  const modelHash = sha256(await readFile(path.join(directory, 'work', 'model-snapshot.json')));
  const audioHash = options.omitSource === 'audio-verification'
    ? null
    : sha256(await readFile(path.join(directory, 'work', 'audio-verification.json')));
  const status = options.status ?? 'validating';
  const interrupted = options.interrupted ?? false;
  const workArtifacts = [
    'work/model-snapshot.json',
    'work/provider-response.asr.redacted.json',
    ...(options.omitSource === 'transcript' ? [] : ['work/transcript.raw.json']),
    ...(options.omitSource === 'calibration' ? [] : ['work/calibration-result.json']),
    ...(options.omitSource === 'alignment' ? [] : ['work/alignment.json']),
    ...(options.omitSource === 'calibrated' ? [] : ['work/transcript.calibrated.json']),
    ...(options.omitSource === 'audio-verification' ? [] : ['work/audio-verification.json'])
  ];
  const task: TaskRecord = {
    schema_version: '1.0.0',
    task_id: TASK_ID,
    task_type: 'subtitle_calibration',
    created_at: '2026-08-07T12:00:00.000Z',
    updated_at: '2026-08-07T12:00:05.000Z',
    task_directory: path.basename(directory),
    input_config: { has_reference_srt: hasReference, mode, source_language: 'zh-CN' },
    inputs: {
      audio: {
        original_path: '/source/sample.mp3',
        original_name: 'sample.mp3',
        workspace_copy_path: 'input/sample.mp3',
        bytes: 13,
        modified_at: '2026-08-07T11:59:00.000Z',
        sha256: transcript.audio.sha256,
        copy_verified: true,
        duration_ms: 5_000
      },
      reference_srt: hasReference
        ? {
            original_path: '/source/reference.srt',
            original_name: 'reference.srt',
            workspace_copy_path: 'input/reference.srt',
            bytes: Buffer.byteLength(REFERENCE_SRT),
            modified_at: '2026-08-07T11:59:00.000Z',
            sha256: sha256(REFERENCE_SRT),
            copy_verified: true
          }
        : null
    },
    model_snapshot: { path: 'work/model-snapshot.json', sha256: modelHash },
    audio_verification: {
      requested: options.requestedAudio ?? audioStatus !== 'not_requested',
      artifact_path: options.omitSource === 'audio-verification' ? null : 'work/audio-verification.json',
      sha256: audioHash
    },
    execution: {
      status,
      last_completed_stage: status === 'validating' ? 'segmenting' : 'aligning',
      started_at: '2026-08-07T12:00:01.000Z',
      ended_at: status === 'failed' || status === 'needs_input' ? '2026-08-07T12:00:05.000Z' : null,
      execution_interrupted: interrupted
    },
    artifacts: { work: workArtifacts, outputs: [], report: null },
    adapter_failures: [],
    warnings: [],
    error: status === 'failed' || status === 'needs_input'
      ? {
          error_id: `${TASK_ID}-fixture-error`,
          code: status === 'failed' ? 'FIXTURE_FAILURE' : 'REFERENCE_MISMATCH',
          message: status === 'failed' ? '固定技术失败。' : '双向覆盖率不足。',
          stage: status === 'failed' ? 'model_call' : 'alignment',
          retryable: false,
          remediation: '检查输入后创建新任务。'
        }
      : null,
    failure_stage: status === 'failed' ? 'model_call' : status === 'needs_input' ? 'alignment' : null
  };
  await writeJson(path.join(directory, 'task.json'), task);
  return { directory, task, subtitleResult };
}

afterEach(async () => {
  await Promise.all(taskDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SRT serialization and disk validation', () => {
  it('serializes standard LF UTF-8 blocks with a single final newline', async () => {
    const prepared = await prepareTask();
    const source = serializeCalibratedSrt(prepared.subtitleResult.artifact);
    expect(source).not.toMatch(/^\uFEFF/u);
    expect(source).not.toContain('\r');
    expect(source.endsWith('\n')).toBe(true);
    expect(source.endsWith('\n\n')).toBe(false);
    expect(source).toContain('1\n00:00:00,000 --> 00:00:02,500\n欢迎使用水星');
  });

  it('supports hours greater than 23 with fixed millisecond precision', () => {
    expect(formatSrtTimestamp(27 * 3_600_000 + 2_003)).toBe('27:00:02,003');
  });

  it('wraps a long segment into no more than two lines without changing text', () => {
    const text = '欢迎使用Mercury字幕校准工具并继续完成后续剪辑';
    const lines = wrapSubtitleText(text, 'text-and-segmentation');
    expect(lines).toHaveLength(2);
    expect(lines.join('')).toBe(text);
  });

  it.each([
    ['中文金额单位', '甲乙丙丁戊己100万元甲乙丙丁戊己庚辛', '100万元'],
    ['英文单位', '甲乙丙丁戊己庚辛250kg甲乙丙丁戊己庚辛', '250kg'],
    ['连续数字日期', '甲乙丙丁戊己庚辛2026年8月7日甲乙丙丁戊己庚辛', '2026年8月7日']
  ])('does not split a %s token while wrapping', (_label, text, token) => {
    const lines = wrapSubtitleText(text, 'text-and-segmentation');
    expect(lines).toHaveLength(2);
    expect(lines.join('')).toBe(text);
    expect(lines.some((line) => line.includes(token))).toBe(true);
  });

  it('rejects BOM, discontinuous sequence, overlap, metadata tags, and JSON fragments', () => {
    const expected = [{
      subtitle_segment_id: 'subtitle-0001', index: 0, start_ms: 0, end_ms: 1_000,
      text: '正常文字', confidence: 'high' as const, asr_segment_refs: ['seg-1'], reference_segment_refs: []
    }];
    const base = { audioDurationMs: 2_000, expectedSegments: expected, mode: null, referenceSegments: null };
    for (const source of [
      '\uFEFF1\n00:00:00,000 --> 00:00:01,000\n正常文字\n',
      '2\n00:00:00,000 --> 00:00:01,000\n正常文字\n',
      '1\n00:00:00,000 --> 00:00:01,500\n正常文字\n\n2\n00:00:01,000 --> 00:00:02,000\n后续\n',
      '1\n00:00:00,000 --> 00:00:01,000\n<i>正常文字</i>\n',
      '1\n00:00:00,000 --> 00:00:01,000\n{"prompt":"文字"}\n'
    ]) {
      expect(validateSrtText(source, base).valid).toBe(false);
    }
  });

  it('reports soft duration and reading-speed limits as warnings without failing', () => {
    const expected = [{
      subtitle_segment_id: 'subtitle-0001', index: 0, start_ms: 0, end_ms: 500,
      text: '一二三四五六七八九十', confidence: 'high' as const, asr_segment_refs: ['seg-1'], reference_segment_refs: []
    }];
    const result = validateSrtText(
      '1\n00:00:00,000 --> 00:00:00,500\n一二三四五六七八九十\n',
      { audioDurationMs: 1_000, expectedSegments: expected, mode: null, referenceSegments: null }
    );
    expect(result.valid).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check_id: 'SRT_DURATION', status: 'warning' }),
      expect.objectContaining({ check_id: 'SRT_READING_SPEED', status: 'warning' })
    ]));
  });

  it('enforces the 24-character hard limit even when two output lines are possible', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十一二三四五';
    const expected = [{
      subtitle_segment_id: 'subtitle-0001', index: 0, start_ms: 0, end_ms: 3_000,
      text, confidence: 'high' as const, asr_segment_refs: ['seg-1'], reference_segment_refs: []
    }];
    const lines = wrapSubtitleText(text, null);
    const result = validateSrtText(
      `1\n00:00:00,000 --> 00:00:03,000\n${lines.join('\n')}\n`,
      { audioDurationMs: 3_000, expectedSegments: expected, mode: null, referenceSegments: null }
    );
    expect(result.valid).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check_id: 'SRT_HARD_CHARACTER_LIMIT', status: 'failed' })
    ]));
  });
});

describe('D002 task and D005 calibrated output integration', () => {
  it('writes, rereads, validates and registers a completed text-only SRT and report', async () => {
    const prepared = await prepareTask();
    const referenceBefore = await readFile(path.join(prepared.directory, 'input', 'reference.srt'));
    const result = await generateTaskOutputs(prepared.directory, { now: () => new Date('2026-08-07T12:00:06.000Z') });

    expect(result.task.execution).toMatchObject({ status: 'completed', last_completed_stage: 'validating', ended_at: '2026-08-07T12:00:06.000Z' });
    expect(result.srt_path).toBe('output/sample.calibrated.srt');
    expect(result.srt_validation?.valid).toBe(true);
    expect(result.srt_validation?.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check_id: 'SRT_TEXT_ONLY_TIMELINE', status: 'passed' }),
      expect.objectContaining({ check_id: 'SRT_CALIBRATED_MAPPING', status: 'passed' })
    ]));
    expect(await readFile(path.join(prepared.directory, 'input', 'reference.srt'))).toEqual(referenceBefore);
    const persisted = JSON.parse(await readFile(path.join(prepared.directory, 'task.json'), 'utf8')) as TaskRecord;
    expect(persisted.artifacts).toMatchObject({ outputs: ['output/sample.calibrated.srt'], report: 'output/calibration-report.md' });
    expect(persisted.audio_verification).toMatchObject({ requested: false, artifact_path: 'work/audio-verification.json' });

    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    for (const heading of [
      '任务结果', '输入与模式', '实际模型', '处理摘要', '多模态音频强校验',
      '修改与结构调整', '质量检查', '警告与待人工复核', '产物与追踪信息'
    ]) expect(report).toContain(`## ${heading}`);
    expect(report).toContain('`not_requested`');
    expect(report).toContain('modification-0001');
    expect(report).toContain('text-only 片段数、顺序和时间戳逐毫秒保持不变');
    expect(report).not.toContain('env:VOLCENGINE_API_KEY');
    expect(report).not.toContain('keychain:mercury-calibration');
  });

  it('completes the no-reference path without fabricating an original-SRT comparison', async () => {
    const prepared = await prepareTask({ hasReference: false, mode: null });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('completed');
    expect(result.task.input_config).toMatchObject({ has_reference_srt: false, mode: null });
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('参考 SRT：未提供');
    expect(report).toContain('输入配置：仅 MP3');
    expect(report).not.toContain('原 SRT 修改前后对比');
  });

  it('completes text-and-segmentation while preserving D005 structure mappings', async () => {
    const prepared = await prepareTask({ mode: 'text-and-segmentation' });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('completed');
    expect(result.task.input_config.mode).toBe('text-and-segmentation');
    expect(result.srt_validation?.valid).toBe(true);
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('校准模式：text-and-segmentation');
    expect(report).toContain('modification-');
  });

  it('keeps a post-verification subtitle identity traceable through final SRT and report output', async () => {
    const prepared = await prepareTask({
      hasReference: false,
      mode: null,
      mutateCalibrated: (artifact) => {
        const segment = artifact.segments[0]!;
        segment.text = '但是我们这个 skill 是按照兼容万相3.0的那个';
        artifact.modifications.push({
          modification_id: 'audio-finding-e01-mapping',
          type: 'text_correction',
          original_text: '兼容 One 3.0',
          original_segment_refs: [...segment.asr_segment_refs],
          replacement_text: '兼容万相3.0',
          result_segment_refs: [segment.subtitle_segment_id],
          start_ms: segment.start_ms,
          end_ms: segment.end_ms,
          evidence: {
            asr_segment_refs: [...segment.asr_segment_refs],
            reference_segment_refs: [],
            calibration_suggestion_ref: null
          },
          reason: 'Gemini audio verification: E01 mapping regression.',
          confidence: 'high',
          applied: true
        });
      }
    });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('completed');
    expect(result.srt_validation?.checks).toContainEqual(expect.objectContaining({
      check_id: 'SRT_CALIBRATED_MAPPING', status: 'passed'
    }));
    const srt = await readFile(path.join(prepared.directory, result.srt_path!), 'utf8');
    expect(srt.split('\n').slice(2, -1).join('')).toContain('但是我们这个 skill 是按照兼容万相3.0的那个');
    const report = await readFile(path.join(prepared.directory, 'output/calibration-report.md'), 'utf8');
    expect(report).toContain('audio-finding-e01-mapping');
    expect(report).toContain(prepared.subtitleResult.artifact.segments[0]!.subtitle_segment_id);
    expect(report).toContain('写入最终 SRT');
  });

  it('reuses the same output names when a completed task is reread', async () => {
    const prepared = await prepareTask();
    await generateTaskOutputs(prepared.directory, { now: () => new Date('2026-08-07T12:00:06.000Z') });
    const result = await generateTaskOutputs(prepared.directory, { now: () => new Date('2026-08-07T12:00:10.000Z') });
    expect(result.task.execution.ended_at).toBe('2026-08-07T12:00:06.000Z');
    expect((await readdir(path.join(prepared.directory, 'output'))).sort()).toEqual(['calibration-report.md', 'sample.calibrated.srt']);
  });

  it('turns a disk validation failure into failed and removes the final SRT', async () => {
    const prepared = await prepareTask({
      mutateCalibrated: (artifact) => { artifact.segments[0]!.text = '欢迎\u200B使用水星'; }
    });
    const result = await generateTaskOutputs(prepared.directory, { now: () => new Date('2026-08-07T12:00:07.000Z') });
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_VALIDATION_FAILED');
    await expect(stat(path.join(prepared.directory, 'output', 'sample.calibrated.srt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('## 失败或拒绝原因');
    expect(report).toContain('OUTPUT_VALIDATION_FAILED');
  });

  it('detects a completed SRT corrupted on disk and revokes completed status', async () => {
    const prepared = await prepareTask();
    await generateTaskOutputs(prepared.directory, { now: () => new Date('2026-08-07T12:00:06.000Z') });
    const srt = path.join(prepared.directory, 'output', 'sample.calibrated.srt');
    await writeFile(srt, '1\ninvalid timeline\n损坏内容\n', 'utf8');
    const result = await generateTaskOutputs(prepared.directory, { now: () => new Date('2026-08-07T12:00:08.000Z') });
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_VALIDATION_FAILED');
    await expect(stat(srt)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['transcript', 'calibration', 'alignment', 'calibrated', 'audio-verification'] as const)(
    'fails closed when the completed path is missing %s',
    async (omitSource) => {
      const prepared = await prepareTask({ omitSource });
      const result = await generateTaskOutputs(prepared.directory);
      expect(result.task.execution.status).toBe('failed');
      expect(result.srt_path).toBeNull();
      expect(result.task.artifacts.outputs).toEqual([]);
      expect(await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8')).toContain('未生成');
    }
  );

  it('does not treat an unregistered canonical file as an authority artifact', async () => {
    const prepared = await prepareTask({ omitSource: 'audio-verification' });
    const audio = await fixture<AudioVerification>('audio-verification.not-requested.json');
    audio.task_id = TASK_ID;
    await writeJson(path.join(prepared.directory, 'work', 'audio-verification.json'), audio);
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_TASK_ARTIFACT_TRACKING_INVALID');
  });

  it('fails when task.json does not track every required D001 and D005 work artifact', async () => {
    const prepared = await prepareTask();
    prepared.task.artifacts.work = prepared.task.artifacts.work.filter((item) => item !== 'work/alignment.json');
    await writeJson(path.join(prepared.directory, 'task.json'), prepared.task);
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_TASK_ARTIFACT_TRACKING_INVALID');
  });

  it('rejects cross-task D005 artifacts instead of writing a misleading result', async () => {
    const prepared = await prepareTask({
      mutateCalibrated: (artifact) => { artifact.task_id = 'tsk-20260807-120000-deadbeef'; }
    });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_TASK_ID_MISMATCH');
    expect(result.srt_path).toBeNull();
  });

  it('rejects dangling D005 evidence references as a shared consumer invariant', async () => {
    const prepared = await prepareTask({
      mutateCalibrated: (artifact) => { artifact.segments[0]!.asr_segment_refs = ['seg-9999']; }
    });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_D005_REFERENCE_INVALID');
  });

  it('rejects malformed D005 segment structures before report projection', async () => {
    const prepared = await prepareTask();
    const file = path.join(prepared.directory, 'work', 'transcript.calibrated.json');
    const artifact = JSON.parse(await readFile(file, 'utf8')) as CalibratedTranscript;
    artifact.segments[1]!.subtitle_segment_id = artifact.segments[0]!.subtitle_segment_id;
    await writeJson(file, artifact);
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_CALIBRATED_INVALID');
  });

  it.each([
    {
      name: 'relation object shape',
      mutate: (alignment: AlignmentArtifact) => { alignment.relations = [{} as AlignmentArtifact['relations'][number]]; }
    },
    {
      name: 'unaligned-region object shape',
      mutate: (alignment: AlignmentArtifact) => { alignment.unaligned_regions = [{} as AlignmentArtifact['unaligned_regions'][number]]; }
    },
    {
      name: 'unknown relation reference',
      mutate: (alignment: AlignmentArtifact) => { alignment.relations[0]!.asr_segment_refs = ['seg-9999']; }
    },
    {
      name: 'out-of-range relation characters',
      mutate: (alignment: AlignmentArtifact) => { alignment.relations[0]!.asr_character_range.end = alignment.asr_character_count + 1; }
    },
    {
      name: 'out-of-range unaligned timing',
      mutate: (alignment: AlignmentArtifact) => { alignment.unaligned_regions[0]!.end_ms = 99_999; }
    }
  ])('rejects malformed D005 alignment $name', async ({ mutate }) => {
    const prepared = await prepareTask({ mutateAlignment: mutate });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_ALIGNMENT_INVALID');
    expect(result.srt_path).toBeNull();
  });

  it('does not follow a task output directory symlink', async () => {
    const prepared = await prepareTask();
    const external = await mkdtemp(path.join(tmpdir(), 'mercury-output-external-'));
    taskDirectories.push(external);
    await rm(path.join(prepared.directory, 'output'), { recursive: true });
    await symlink(external, path.join(prepared.directory, 'output'));
    await expect(generateTaskOutputs(prepared.directory)).rejects.toMatchObject({ code: 'OUTPUT_TASK_DIRECTORY_INVALID' });
    expect(await readdir(external)).toEqual([]);
  });

  it('persists failed task state when the mandatory report cannot be written', async () => {
    const prepared = await prepareTask();
    await mkdir(path.join(prepared.directory, 'output', 'calibration-report.md'));
    await expect(generateTaskOutputs(prepared.directory)).rejects.toMatchObject({ code: 'OUTPUT_REPORT_WRITE_FAILED' });
    const task = JSON.parse(await readFile(path.join(prepared.directory, 'task.json'), 'utf8')) as TaskRecord;
    expect(task.execution.status).toBe('failed');
    expect(task.error?.code).toBe('OUTPUT_REPORT_WRITE_FAILED');
    expect(task.artifacts.report).toBeNull();
    await expect(stat(path.join(prepared.directory, 'output', 'sample.calibrated.srt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('abnormal and interrupted reports', () => {
  it.each(['needs_input', 'failed'] as const)('writes a report and no SRT for %s', async (status) => {
    const prepared = await prepareTask({ status });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe(status);
    expect(result.srt_path).toBeNull();
    expect(result.task.artifacts.outputs).toEqual([]);
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('## 失败或拒绝原因');
    expect(report).toContain(status === 'needs_input' ? '双向覆盖率不足' : '固定技术失败');
    expect(report).toContain('创建新任务');
  });

  it('preserves the last nonterminal state and records an interrupted diagnostic report', async () => {
    const prepared = await prepareTask({ status: 'calibrating', interrupted: true });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution).toMatchObject({ status: 'calibrating', execution_interrupted: true, ended_at: null });
    expect(result.task.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TASK_EXECUTION_INTERRUPTED' })]));
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('## 执行中断');
    expect(report).toContain('这不是 `failed`、已恢复或已完成');
  });

  it('preserves an interrupted nonterminal state when a work artifact cannot be read', async () => {
    const prepared = await prepareTask({ status: 'calibrating', interrupted: true });
    await writeFile(path.join(prepared.directory, 'work', 'alignment.json'), '{broken json', 'utf8');
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution).toMatchObject({ status: 'calibrating', execution_interrupted: true, ended_at: null });
    expect(result.task.error).toBeNull();
    expect(result.task.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TASK_EXECUTION_INTERRUPTED' }),
      expect.objectContaining({ code: 'OUTPUT_INTERRUPTED_SOURCE_DIAGNOSTIC' })
    ]));
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('## 执行中断');
    expect(report).toContain('OUTPUT_INTERRUPTED_SOURCE_DIAGNOSTIC');
  });

  it('refuses to generate a report for an active task not marked interrupted', async () => {
    const prepared = await prepareTask({ status: 'calibrating' });
    await expect(generateTaskOutputs(prepared.directory)).rejects.toMatchObject({ code: 'OUTPUT_TASK_STATE_INVALID' });
  });

  it('redacts credentials that accidentally appear in a task diagnostic', async () => {
    const prepared = await prepareTask({ status: 'failed' });
    const secret = ['live', '-fixture-', 'value'].join('');
    const credentialReference = ['env', ':MERCURY_', 'FIXTURE'].join('');
    prepared.task.error!.message = ['Author', 'ization: Bearer ', secret, ' ', credentialReference].join('');
    await writeJson(path.join(prepared.directory, 'task.json'), prepared.task);
    await generateTaskOutputs(prepared.directory);
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).not.toContain(secret);
    expect(report).not.toContain(credentialReference);
    expect(report).toContain('[REDACTED]');
  });
});

describe('model and strong-verification projections', () => {
  it.each([
    ['not_requested', false, '`not_requested`', '未请求'],
    ['skipped', true, '`skipped`（强校验未完成）', 'not_configured'],
    ['failed', true, '`failed`（强校验未完成）', 'MODEL_CALL_FAILED'],
    ['completed', true, '`completed`', 'fixture-project']
  ] as const)('renders %s from the authority artifact', async (audioStatus, requestedAudio, statusText, detail) => {
    const prepared = await prepareTask({ audioStatus, requestedAudio });
    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('completed');
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain(statusText);
    expect(report).toContain(detail);
    if (audioStatus === 'not_requested') expect(report).not.toContain('虚构');
  });

  it('renders persisted chunk bytes, global range, call, outcome, and failure reference', async () => {
    const prepared = await prepareTask({ audioStatus: 'failed', requestedAudio: true });
    const audioPath = path.join(prepared.directory, 'work', 'audio-verification.json');
    const audio = JSON.parse(await readFile(audioPath, 'utf8')) as AudioVerification;
    audio.staging = [];
    audio.local_chunking = {
      threshold_bytes: 15000000,
      source_bytes: 1200,
      parts: [{
        chunk_id: 'chunk-report-0001', bytes: 1200, start_ms: 0, end_ms: 5000,
        call_ref: (audio.calls[0] as any).call_id, outcome: 'failed', error_ref: (audio.errors[0] as any).error_id
      }]
    };
    await writeJson(audioPath, audio);
    prepared.task.audio_verification.sha256 = sha256(await readFile(audioPath));
    await writeJson(path.join(prepared.directory, 'task.json'), prepared.task);

    await generateTaskOutputs(prepared.directory);
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('本地音频分片：源文件 1200 bytes');
    expect(report).toContain('chunk-report-0001');
    expect(report).toContain((audio.calls[0] as any).call_id);
    expect(report).toContain((audio.errors[0] as any).error_id);
    expect(report).toContain('`failed`（强校验未完成）');
  });

  it('reports incomplete model suggestions separately from effective findings and corrections', async () => {
    const prepared = await prepareTask({ audioStatus: 'completed', requestedAudio: true });
    const audioPath = path.join(prepared.directory, 'work', 'audio-verification.json');
    const audio = JSON.parse(await readFile(audioPath, 'utf8')) as AudioVerification;
    audio.findings[0]!.kind = 'uncertain';
    audio.findings[0]!.suggested_text = null;
    audio.findings[0]!.rationale = '模型建议不完整；Provider 未给出有效建议文字。';
    audio.application_results[0]!.disposition = 'not_applied';
    audio.application_results[0]!.reason = 'insufficient_evidence';
    audio.application_results[0]!.modification_ref = null;
    await writeJson(audioPath, audio);
    prepared.task.audio_verification.sha256 = sha256(await readFile(audioPath));
    await writeJson(path.join(prepared.directory, 'task.json'), prepared.task);

    await generateTaskOutputs(prepared.directory);
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('有效发现项：0；模型建议不完整：1；已应用：0');
    expect(report).toContain('模型建议不完整；Provider 未给出有效建议文字。');
    expect(report).toContain('not_applied: insufficient_evidence');
  });

  it('rejects and suppresses an audio-verification model when verification was not requested', async () => {
    const prepared = await prepareTask();
    const snapshotPath = path.join(prepared.directory, 'work', 'model-snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as ModelSnapshot;
    const fullSnapshot = await fixture<ModelSnapshot>('model-snapshot.json');
    const audioEntry = fullSnapshot.models.audio_verification;
    if (!audioEntry) throw new Error('audio-verification fixture is missing');
    snapshot.models.audio_verification = audioEntry;
    await writeJson(snapshotPath, snapshot);
    prepared.task.model_snapshot.sha256 = sha256(await readFile(snapshotPath));
    await writeJson(path.join(prepared.directory, 'task.json'), prepared.task);

    const result = await generateTaskOutputs(prepared.directory);
    expect(result.task.execution.status).toBe('failed');
    expect(result.task.error?.code).toBe('OUTPUT_AUDIO_VERIFICATION_MODEL_MISMATCH');
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('not_requested');
    expect(report).toContain('未请求');
    expect(report).not.toContain('gemini-audio-fixture');
  });

  it('does not expose credential references in model rows', async () => {
    const prepared = await prepareTask({ audioStatus: 'completed', requestedAudio: true });
    await generateTaskOutputs(prepared.directory);
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('fixture-calibration-model');
    expect(report).toContain('gemini-audio-fixture');
    expect(report).not.toContain('VOLCENGINE_API_KEY');
    expect(report).not.toContain('mercury-calibration');
    expect(report).not.toContain('mercury-audio-verification');
  });

  it('keeps configured/request and provider-returned check models distinct', async () => {
    const prepared = await prepareTask();
    const snapshotPath = path.join(prepared.directory, 'work', 'model-snapshot.json');
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as ModelSnapshot;
    if (snapshot.models.calibration.check_snapshot.outcome !== 'passed') throw new Error('unexpected fixture');
    snapshot.models.calibration.check_snapshot.actual_model = 'provider-returned-model';
    await writeJson(snapshotPath, snapshot);
    prepared.task.model_snapshot.sha256 = sha256(await readFile(snapshotPath));
    await writeJson(path.join(prepared.directory, 'task.json'), prepared.task);
    await generateTaskOutputs(prepared.directory);
    const report = await readFile(path.join(prepared.directory, 'output', 'calibration-report.md'), 'utf8');
    expect(report).toContain('fixture-calibration-model');
    expect(report).toContain('provider-returned-model');
    expect(report).toContain('两者允许不同');
  });
});

describe('modification and report semantics', () => {
  it('classifies number, proper-noun, term, punctuation and structural changes without changing D005', async () => {
    const prepared = await prepareTask();
    const artifact = prepared.subtitleResult.artifact;
    const base = artifact.modifications[0]!;
    artifact.modifications = [
      { ...base, modification_id: 'mod-number', original_text: '十元', replacement_text: '十一元', reason: '音频数字证据。' },
      { ...base, modification_id: 'mod-name', original_text: '水兴', replacement_text: '水星', reason: '产品名与音频一致。' },
      { ...base, modification_id: 'mod-term', original_text: '接囗', replacement_text: '接口', reason: '专业术语与 ASR 一致。' },
      { ...base, modification_id: 'mod-punctuation', original_text: '你好', replacement_text: '你好，', reason: '不改变语义的标点。' },
      { ...base, modification_id: 'mod-missing', type: 'omission_recovery', reason: '音频存在漏字。' },
      { ...base, modification_id: 'mod-split', type: 'split', reason: '自然停顿拆分。' },
      { ...base, modification_id: 'mod-merge', type: 'merge', reason: '相邻短句合并。' },
      { ...base, modification_id: 'mod-timing', type: 'timing_adjustment', reason: '时间证据调整。' }
    ];
    const context: ReportContext = {
      task: prepared.task,
      sources: {
        modelSnapshot: null,
        transcript: null,
        calibrationResult: null,
        alignment: prepared.subtitleResult.alignment,
        calibratedTranscript: artifact,
        audioVerification: null,
        hashes: {}
      },
      srtPath: null,
      validation: null
    };
    const report = buildCalibrationReport(context);
    for (const type of ['number_unit', 'proper_noun', 'term', 'punctuation', 'missing_content', 'split', 'merge', 'timing']) {
      expect(report).toContain(type);
    }
  });

  it('derives original and new timing from D005 reference/output mappings', async () => {
    const prepared = await prepareTask();
    const artifact = structuredClone(prepared.subtitleResult.artifact);
    artifact.segments[0]!.start_ms = 100;
    artifact.segments[0]!.end_ms = 2_000;
    artifact.modifications = [{
      ...artifact.modifications[0]!,
      type: 'timing_adjustment',
      original_segment_refs: ['reference-0001'],
      result_segment_refs: ['subtitle-0001']
    }];
    const report = buildCalibrationReport({
      task: prepared.task,
      sources: {
        modelSnapshot: null,
        transcript: null,
        calibrationResult: null,
        alignment: prepared.subtitleResult.alignment,
        calibratedTranscript: artifact,
        audioVerification: null,
        hashes: {}
      },
      srtPath: null,
      validation: null
    });
    expect(report).toContain('0–2500 ms → 100–2000 ms');
  });

  it('does not fabricate an original-SRT comparison when the task has no reference', async () => {
    const prepared = await prepareTask();
    const task = structuredClone(prepared.task);
    task.input_config = { has_reference_srt: false, mode: null, source_language: 'zh-CN' };
    task.inputs.reference_srt = null;
    const artifact = structuredClone(prepared.subtitleResult.artifact);
    artifact.mode = null;
    artifact.source_refs.reference_srt_ref = null;
    artifact.segments.forEach((segment) => { segment.reference_segment_refs = []; });
    artifact.modifications.forEach((modification) => {
      modification.original_segment_refs = [];
      modification.evidence.reference_segment_refs = [];
    });
    const report = buildCalibrationReport({
      task,
      sources: {
        modelSnapshot: null,
        transcript: null,
        calibrationResult: null,
        alignment: null,
        calibratedTranscript: artifact,
        audioVerification: null,
        hashes: {}
      },
      srtPath: null,
      validation: null
    });
    expect(report).toContain('参考 SRT：未提供');
    expect(report).not.toContain('原 SRT 修改前后对比');
  });
});

describe('public disk validator', () => {
  it('rejects a valid SRT when the disk bytes start with UTF-8 BOM', async () => {
    const prepared = await prepareTask();
    const directory = await mkdtemp(path.join(tmpdir(), 'mercury-bom-srt-'));
    taskDirectories.push(directory);
    const file = path.join(directory, 'bom.srt');
    const source = serializeCalibratedSrt(prepared.subtitleResult.artifact);
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]));
    const result = await validateSrtFile(file, {
      audioDurationMs: prepared.task.inputs.audio.duration_ms!,
      expectedSegments: prepared.subtitleResult.artifact.segments,
      mode: prepared.subtitleResult.artifact.mode,
      referenceSegments: prepared.subtitleResult.alignment.reference_segments
    });
    expect(result.valid).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check_id: 'SRT_UTF8', status: 'failed' })
    ]));
  });

  it('rereads the actual file and rejects invalid UTF-8 bytes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mercury-invalid-srt-'));
    taskDirectories.push(directory);
    const file = path.join(directory, 'broken.srt');
    await writeFile(file, Buffer.from([0xff, 0xfe, 0xfd]));
    const result = await validateSrtFile(file, { audioDurationMs: 1_000, expectedSegments: [], mode: null, referenceSegments: null });
    expect(result.valid).toBe(false);
    expect(result.checks).toEqual([expect.objectContaining({ check_id: 'SRT_UTF8', status: 'failed' })]);
  });
});
