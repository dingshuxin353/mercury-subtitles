import { randomBytes } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import type {
  AudioVerification,
  CalibrationResult,
  ModelSnapshot,
  TranscriptRaw
} from '../contracts/index.js';
import { validateContractGraph } from '../contracts/index.js';
import { MercuryError } from '../errors.js';
import {
  normalizeMatchText,
  parseReferenceSrt,
  type AlignmentArtifact,
  type CalibratedTranscript
} from '../subtitle-core/index.js';
import {
  persistTaskRecord,
  readTaskRecord,
  safeAudioStem,
  sha256File,
  type TaskRecord
} from '../tasks.js';
import { buildCalibrationReport } from './report.js';
import {
  serializeCalibratedSrt,
  validateSrtFile,
  type SrtValidationContext
} from './srt.js';
import type {
  GenerateTaskOutputsOptions,
  GenerateTaskOutputsResult,
  OutputSourceArtifacts,
  SrtValidationResult
} from './types.js';

const REPORT_PATH = 'output/calibration-report.md' as const;
const MODEL_SNAPSHOT_PATH = 'work/model-snapshot.json';
const TRANSCRIPT_PATH = 'work/transcript.raw.json';
const CALIBRATION_PATH = 'work/calibration-result.json';
const ALIGNMENT_PATH = 'work/alignment.json';
const CALIBRATED_PATH = 'work/transcript.calibrated.json';
const AUDIO_VERIFICATION_PATH = 'work/audio-verification.json';
const COMPLETED_WORK_PATHS = [
  MODEL_SNAPSHOT_PATH,
  TRANSCRIPT_PATH,
  CALIBRATION_PATH,
  ALIGNMENT_PATH,
  CALIBRATED_PATH,
  AUDIO_VERIFICATION_PATH
] as const;

class OutputStageError extends MercuryError {
  readonly validation: SrtValidationResult | null;

  constructor(code: string, message: string, validation: SrtValidationResult | null = null) {
    super(code, message);
    this.validation = validation;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function canonicalTaskPath(taskDirectory: string, relativePath: string): string {
  const normalized = path.posix.normalize(relativePath);
  if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new OutputStageError('OUTPUT_PATH_INVALID', `任务产物路径越界：${relativePath}`);
  }
  return path.join(taskDirectory, ...normalized.split('/'));
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readJsonIfPresent<T>(taskDirectory: string, relativePath: string): Promise<T | null> {
  try {
    const filePath = canonicalTaskPath(taskDirectory, relativePath);
    const details = await lstat(filePath);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new OutputStageError('OUTPUT_SOURCE_PATH_INVALID', `${relativePath} 必须是任务目录内的普通文件。`);
    }
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new OutputStageError('OUTPUT_SOURCE_READ_FAILED', `无法读取 ${relativePath}：${errorMessage(error)}`);
  }
}

async function assertTaskDirectoryBoundary(taskDirectory: string): Promise<void> {
  const rootDetails = await lstat(taskDirectory);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new OutputStageError('OUTPUT_TASK_DIRECTORY_INVALID', '任务目录必须是普通目录，不能是符号链接。');
  }
  const root = await realpath(taskDirectory);
  for (const relativePath of ['input', 'work', 'output']) {
    const directory = canonicalTaskPath(taskDirectory, relativePath);
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new OutputStageError('OUTPUT_TASK_DIRECTORY_INVALID', `${relativePath}/ 必须是任务目录内的普通目录。`);
    }
    const actual = await realpath(directory);
    if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) {
      throw new OutputStageError('OUTPUT_TASK_DIRECTORY_INVALID', `${relativePath}/ 解析到任务目录之外。`);
    }
  }
  const taskFile = await lstat(canonicalTaskPath(taskDirectory, 'task.json'));
  if (!taskFile.isFile() || taskFile.isSymbolicLink()) {
    throw new OutputStageError('OUTPUT_TASK_DIRECTORY_INVALID', 'task.json 必须是任务目录内的普通文件。');
  }
}

async function collectTaskFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTaskFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return files;
}

function calibratedTranscript(value: unknown): CalibratedTranscript | null {
  if (!isRecord(value)) return null;
  const candidate = value as Partial<CalibratedTranscript>;
  if (
    candidate.artifact_version !== '1.0.0' ||
    typeof candidate.task_id !== 'string' ||
    ![null, 'text-only', 'text-and-segmentation'].includes(candidate.mode ?? null) ||
    candidate.thresholds_version !== 'v0.1' ||
    !isRecord(candidate.source_refs) ||
    candidate.source_refs.transcript_ref !== TRANSCRIPT_PATH ||
    candidate.source_refs.calibration_ref !== CALIBRATION_PATH ||
    ![null, 'input/reference.srt'].includes(candidate.source_refs.reference_srt_ref as null | string) ||
    !Array.isArray(candidate.segments) ||
    !Array.isArray(candidate.modifications) ||
    !Array.isArray(candidate.warnings) ||
    candidate.segments.length === 0 ||
    candidate.segments.some((segment, index) =>
      !isRecord(segment) ||
      typeof segment.subtitle_segment_id !== 'string' ||
      segment.index !== index ||
      !nonNegativeInteger(segment.start_ms) ||
      !nonNegativeInteger(segment.end_ms) ||
      Number(segment.start_ms) >= Number(segment.end_ms) ||
      typeof segment.text !== 'string' ||
      segment.text.trim().length === 0 ||
      !['high', 'medium', 'low'].includes(String(segment.confidence)) ||
      !stringArray(segment.asr_segment_refs) ||
      !Array.isArray(segment.reference_segment_refs) ||
      !segment.reference_segment_refs.every((entry) => typeof entry === 'string' && entry.length > 0)
    ) ||
    candidate.modifications.some((modification) =>
      !isRecord(modification) ||
      typeof modification.modification_id !== 'string' ||
      !['text_correction', 'omission_recovery', 'segmentation', 'split', 'merge', 'timing_adjustment'].includes(String(modification.type)) ||
      typeof modification.original_text !== 'string' ||
      !Array.isArray(modification.original_segment_refs) ||
      !modification.original_segment_refs.every((entry) => typeof entry === 'string' && entry.length > 0) ||
      typeof modification.replacement_text !== 'string' ||
      !Array.isArray(modification.result_segment_refs) ||
      !modification.result_segment_refs.every((entry) => typeof entry === 'string' && entry.length > 0) ||
      !nonNegativeInteger(modification.start_ms) ||
      !nonNegativeInteger(modification.end_ms) ||
      Number(modification.start_ms) >= Number(modification.end_ms) ||
      !isRecord(modification.evidence) ||
      !stringArray(modification.evidence.asr_segment_refs) ||
      !Array.isArray(modification.evidence.reference_segment_refs) ||
      !modification.evidence.reference_segment_refs.every((entry) => typeof entry === 'string' && entry.length > 0) ||
      !(modification.evidence.calibration_suggestion_ref === null || typeof modification.evidence.calibration_suggestion_ref === 'string') ||
      typeof modification.reason !== 'string' ||
      modification.reason.trim().length === 0 ||
      !['high', 'medium', 'low'].includes(String(modification.confidence)) ||
      typeof modification.applied !== 'boolean'
    ) ||
    candidate.warnings.some((warning) =>
      !isRecord(warning) ||
      typeof warning.warning_id !== 'string' ||
      typeof warning.code !== 'string' ||
      typeof warning.message !== 'string' ||
      !Array.isArray(warning.segment_refs)
    )
  ) return null;
  const segmentIds = candidate.segments.map((segment) => segment.subtitle_segment_id);
  const modificationIds = candidate.modifications.map((modification) => modification.modification_id);
  if (new Set(segmentIds).size !== segmentIds.length || new Set(modificationIds).size !== modificationIds.length) return null;
  return candidate as CalibratedTranscript;
}

interface AlignmentCharacterSequence {
  values: string[];
  refs: string[];
}

interface CharacterRange {
  start: number;
  end: number;
}

interface TimedAlignmentItem {
  segment_id?: string;
  reference_segment_id?: string;
  start_ms: number;
  end_ms: number;
}

function alignmentCharacterSequence(items: Array<{ id: string; text: string }>): AlignmentCharacterSequence {
  const values: string[] = [];
  const refs: string[] = [];
  for (const item of items) {
    for (const character of normalizeMatchText(item.text)) {
      values.push(character);
      refs.push(item.id);
    }
  }
  return { values, refs };
}

function validCharacterRange(value: unknown, total: number, emptyOnly: boolean): value is CharacterRange {
  if (
    !isRecord(value) ||
    !nonNegativeInteger(value.start) ||
    !nonNegativeInteger(value.end)
  ) return false;
  if (emptyOnly) return value.start === 0 && value.end === 0;
  return Number(value.start) < Number(value.end) && Number(value.end) <= total;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function refsForRange(refs: string[], range: CharacterRange): string[] {
  return [...new Set(refs.slice(range.start, range.end))];
}

function timingWithinRefs(
  start: number,
  end: number,
  refs: string[],
  items: readonly TimedAlignmentItem[],
  idKey: 'segment_id' | 'reference_segment_id'
): boolean {
  const requested = new Set(refs);
  const matched = items.filter((item) => {
    const id = item[idKey];
    return typeof id === 'string' && requested.has(id);
  });
  return matched.length === requested.size &&
    start >= Math.min(...matched.map((item) => item.start_ms)) &&
    end <= Math.max(...matched.map((item) => item.end_ms));
}

function complementRanges(total: number, covered: CharacterRange[]): CharacterRange[] {
  const gaps: CharacterRange[] = [];
  let cursor = 0;
  for (const range of covered) {
    if (cursor < range.start) gaps.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < total) gaps.push({ start: cursor, end: total });
  return gaps;
}

function validUnalignedRegions(
  regions: AlignmentArtifact['unaligned_regions'],
  sequence: AlignmentCharacterSequence,
  items: readonly TimedAlignmentItem[],
  idKey: 'segment_id' | 'reference_segment_id',
  expectedRanges: CharacterRange[]
): boolean {
  if (regions.length !== expectedRanges.length) return false;
  return regions.every((region, index) => {
    const expected = expectedRanges[index];
    if (
      !expected ||
      !stringArray(region.segment_refs) ||
      !validCharacterRange(region.character_range, sequence.values.length, false) ||
      region.character_range.start !== expected.start ||
      region.character_range.end !== expected.end ||
      !sameStrings(region.segment_refs, refsForRange(sequence.refs, region.character_range)) ||
      typeof region.normalized_text !== 'string' ||
      region.normalized_text !== sequence.values.slice(region.character_range.start, region.character_range.end).join('') ||
      !nonNegativeInteger(region.start_ms) ||
      !nonNegativeInteger(region.end_ms) ||
      region.start_ms >= region.end_ms
    ) return false;
    return timingWithinRefs(region.start_ms, region.end_ms, region.segment_refs, items, idKey);
  });
}

function sameNumber(actual: number | null, expected: number): boolean {
  return typeof actual === 'number' && Math.abs(actual - expected) < 1e-12;
}

function alignmentArtifact(value: unknown): AlignmentArtifact | null {
  if (!isRecord(value)) return null;
  const candidate = value as Partial<AlignmentArtifact>;
  if (
    candidate.artifact_version !== '1.0.0' ||
    typeof candidate.task_id !== 'string' ||
    !Array.isArray(candidate.asr_units) ||
    candidate.asr_units.length === 0 ||
    !Array.isArray(candidate.relations) ||
    !Array.isArray(candidate.unaligned_regions) ||
    candidate.asr_units.some((unit) =>
      !isRecord(unit) ||
      typeof unit.segment_id !== 'string' ||
      !nonNegativeInteger(unit.start_ms) ||
      !nonNegativeInteger(unit.end_ms) ||
      Number(unit.start_ms) >= Number(unit.end_ms) ||
      typeof unit.text !== 'string' ||
      unit.text.trim().length === 0
    ) ||
    !(candidate.reference_segments === null || Array.isArray(candidate.reference_segments)) ||
    candidate.reference_segments?.some((segment) =>
      !isRecord(segment) ||
      typeof segment.reference_segment_id !== 'string' ||
      !nonNegativeInteger(segment.sequence) ||
      !nonNegativeInteger(segment.start_ms) ||
      !nonNegativeInteger(segment.end_ms) ||
      Number(segment.start_ms) >= Number(segment.end_ms) ||
      typeof segment.text !== 'string' ||
      segment.text.trim().length === 0
    ) ||
    !nonNegativeInteger(candidate.matched_character_count) ||
    !nonNegativeInteger(candidate.asr_character_count) ||
    candidate.asr_character_count === 0 ||
    !(candidate.reference_character_count === null || nonNegativeInteger(candidate.reference_character_count)) ||
    typeof candidate.asr_coverage !== 'number' ||
    !Number.isFinite(candidate.asr_coverage) ||
    candidate.asr_coverage < 0 ||
    candidate.asr_coverage > 1 ||
    !(candidate.reference_coverage === null || (typeof candidate.reference_coverage === 'number' && Number.isFinite(candidate.reference_coverage) && candidate.reference_coverage >= 0 && candidate.reference_coverage <= 1)) ||
    candidate.threshold !== 0.8 ||
    candidate.monotonic !== true ||
    !['matched', 'needs_input'].includes(String(candidate.conclusion))
  ) return null;

  const artifact = candidate as AlignmentArtifact;
  const asrIds = artifact.asr_units.map((unit) => unit.segment_id);
  const referenceIds = artifact.reference_segments?.map((segment) => segment.reference_segment_id) ?? [];
  if (
    new Set(asrIds).size !== asrIds.length ||
    new Set(referenceIds).size !== referenceIds.length ||
    artifact.asr_units.some((unit, index) => index > 0 && unit.start_ms < artifact.asr_units[index - 1]!.end_ms) ||
    artifact.reference_segments?.some((segment, index) =>
      segment.sequence !== index + 1 ||
      (index > 0 && segment.start_ms < artifact.reference_segments![index - 1]!.end_ms)
    )
  ) return null;

  const asrSequence = alignmentCharacterSequence(artifact.asr_units.map((unit) => ({ id: unit.segment_id, text: unit.text })));
  const referenceSequence = alignmentCharacterSequence(
    artifact.reference_segments?.map((segment) => ({ id: segment.reference_segment_id, text: segment.text })) ?? []
  );
  const hasReference = artifact.reference_segments !== null;
  if (
    asrSequence.values.length !== artifact.asr_character_count ||
    (hasReference && referenceSequence.values.length !== artifact.reference_character_count) ||
    (!hasReference && (artifact.reference_character_count !== null || artifact.reference_coverage !== null))
  ) return null;

  let matchedCharacters = 0;
  let previousAsrEnd = 0;
  let previousReferenceEnd = 0;
  let previousStartMs = 0;
  let previousEndMs = 0;
  for (const [index, relation] of artifact.relations.entries()) {
    if (
      !isRecord(relation) ||
      !stringArray(relation.asr_segment_refs) ||
      !Array.isArray(relation.reference_segment_refs) ||
      !relation.reference_segment_refs.every((entry) => typeof entry === 'string' && entry.length > 0) ||
      !validCharacterRange(relation.asr_character_range, asrSequence.values.length, false) ||
      !validCharacterRange(relation.reference_character_range, referenceSequence.values.length, !hasReference) ||
      !nonNegativeInteger(relation.start_ms) ||
      !nonNegativeInteger(relation.end_ms) ||
      Number(relation.start_ms) >= Number(relation.end_ms)
    ) return null;
    const asrRange = relation.asr_character_range;
    const referenceRange = relation.reference_character_range;
    if (
      !sameStrings(relation.asr_segment_refs, refsForRange(asrSequence.refs, asrRange)) ||
      !timingWithinRefs(relation.start_ms, relation.end_ms, relation.asr_segment_refs, artifact.asr_units, 'segment_id') ||
      asrRange.start < previousAsrEnd ||
      (index > 0 && (relation.start_ms < previousStartMs || relation.end_ms < previousEndMs))
    ) return null;
    if (hasReference) {
      if (
        !stringArray(relation.reference_segment_refs) ||
        !sameStrings(relation.reference_segment_refs, refsForRange(referenceSequence.refs, referenceRange)) ||
        referenceRange.start < previousReferenceEnd ||
        asrRange.end - asrRange.start !== referenceRange.end - referenceRange.start ||
        asrSequence.values.slice(asrRange.start, asrRange.end).join('') !==
          referenceSequence.values.slice(referenceRange.start, referenceRange.end).join('')
      ) return null;
      previousReferenceEnd = referenceRange.end;
    } else if (relation.reference_segment_refs.length !== 0 || referenceRange.start !== 0 || referenceRange.end !== 0) {
      return null;
    }
    matchedCharacters += asrRange.end - asrRange.start;
    previousAsrEnd = asrRange.end;
    previousStartMs = relation.start_ms;
    previousEndMs = relation.end_ms;
  }

  const regionsBySide = {
    asr: artifact.unaligned_regions.filter((region) => isRecord(region) && region.side === 'asr'),
    reference: artifact.unaligned_regions.filter((region) => isRecord(region) && region.side === 'reference')
  };
  if (regionsBySide.asr.length + regionsBySide.reference.length !== artifact.unaligned_regions.length) return null;
  if (!validUnalignedRegions(
    regionsBySide.asr,
    asrSequence,
    artifact.asr_units,
    'segment_id',
    complementRanges(asrSequence.values.length, artifact.relations.map((relation) => relation.asr_character_range))
  )) return null;
  if (!validUnalignedRegions(
    regionsBySide.reference,
    referenceSequence,
    artifact.reference_segments ?? [],
    'reference_segment_id',
    complementRanges(referenceSequence.values.length, artifact.relations.map((relation) => relation.reference_character_range))
  )) return null;

  const expectedAsrCoverage = matchedCharacters / asrSequence.values.length;
  const expectedReferenceCoverage = hasReference && referenceSequence.values.length > 0
    ? matchedCharacters / referenceSequence.values.length
    : null;
  const expectedConclusion = expectedAsrCoverage >= artifact.threshold &&
    (!hasReference || (expectedReferenceCoverage !== null && expectedReferenceCoverage >= artifact.threshold))
    ? 'matched'
    : 'needs_input';
  if (
    matchedCharacters !== artifact.matched_character_count ||
    !sameNumber(artifact.asr_coverage, expectedAsrCoverage) ||
    (hasReference && (expectedReferenceCoverage === null || !sameNumber(artifact.reference_coverage, expectedReferenceCoverage))) ||
    artifact.conclusion !== expectedConclusion
  ) return null;
  return artifact;
}

async function loadSources(taskDirectory: string, task: TaskRecord): Promise<OutputSourceArtifacts> {
  const [
    snapshot,
    transcript,
    calibration,
    alignmentValue,
    calibratedValue,
    audioVerification
  ] = await Promise.all([
    task.model_snapshot.path
      ? readJsonIfPresent<ModelSnapshot>(taskDirectory, task.model_snapshot.path)
      : Promise.resolve(null),
    task.artifacts.work.includes(TRANSCRIPT_PATH)
      ? readJsonIfPresent<TranscriptRaw>(taskDirectory, TRANSCRIPT_PATH)
      : Promise.resolve(null),
    task.artifacts.work.includes(CALIBRATION_PATH)
      ? readJsonIfPresent<CalibrationResult>(taskDirectory, CALIBRATION_PATH)
      : Promise.resolve(null),
    task.artifacts.work.includes(ALIGNMENT_PATH)
      ? readJsonIfPresent<unknown>(taskDirectory, ALIGNMENT_PATH)
      : Promise.resolve(null),
    task.artifacts.work.includes(CALIBRATED_PATH)
      ? readJsonIfPresent<unknown>(taskDirectory, CALIBRATED_PATH)
      : Promise.resolve(null),
    task.audio_verification.artifact_path
      ? readJsonIfPresent<AudioVerification>(taskDirectory, task.audio_verification.artifact_path)
      : Promise.resolve(null)
  ]);
  const alignment = alignmentArtifact(alignmentValue);
  const calibrated = calibratedTranscript(calibratedValue);
  if (alignmentValue !== null && !alignment) throw new OutputStageError('OUTPUT_ALIGNMENT_INVALID', 'work/alignment.json 不符合 D005 对齐产物边界。');
  if (calibratedValue !== null && !calibrated) throw new OutputStageError('OUTPUT_CALIBRATED_INVALID', 'work/transcript.calibrated.json 不符合 D005 校准产物边界。');

  const availableTaskFiles = await collectTaskFiles(taskDirectory);
  const graph = {
    ...(snapshot ? { modelSnapshot: snapshot } : {}),
    ...(transcript ? { transcriptRaw: transcript } : {}),
    ...(calibration ? { calibrationResult: calibration } : {}),
    ...(audioVerification ? { audioVerification } : {}),
    adapterFailures: task.adapter_failures,
    availableTaskFiles,
    availableModificationIds: calibrated?.modifications.map((modification) => modification.modification_id) ?? [],
    availableReferenceSegmentIds: [...new Set(
      calibrated?.segments.flatMap((segment) => segment.reference_segment_refs) ?? []
    )]
  };
  const graphValidation = validateContractGraph(graph);
  if (!graphValidation.valid) {
    const summary = graphValidation.issues.map((issue) => `${issue.invariant_id} ${issue.path} ${issue.message}`).join('; ');
    throw new OutputStageError('OUTPUT_CONTRACT_GRAPH_INVALID', `输入产物关系不符合 D001：${summary}`);
  }

  const hashes: Record<string, string> = {};
  for (const relativePath of [
    task.model_snapshot.path,
    transcript ? TRANSCRIPT_PATH : null,
    calibration ? CALIBRATION_PATH : null,
    alignment ? ALIGNMENT_PATH : null,
    calibrated ? CALIBRATED_PATH : null,
    audioVerification ? (task.audio_verification.artifact_path ?? AUDIO_VERIFICATION_PATH) : null
  ]) {
    if (relativePath) hashes[relativePath] = await sha256File(canonicalTaskPath(taskDirectory, relativePath));
  }
  if (task.model_snapshot.path && task.model_snapshot.sha256 && hashes[task.model_snapshot.path] !== task.model_snapshot.sha256) {
    throw new OutputStageError('OUTPUT_SOURCE_HASH_MISMATCH', '模型快照 SHA-256 与 task.json 不一致。');
  }
  if (
    task.audio_verification.artifact_path &&
    task.audio_verification.sha256 &&
    hashes[task.audio_verification.artifact_path] !== task.audio_verification.sha256
  ) {
    throw new OutputStageError('OUTPUT_SOURCE_HASH_MISMATCH', '强校验产物 SHA-256 与 task.json 不一致。');
  }
  return {
    modelSnapshot: snapshot,
    transcript,
    calibrationResult: calibration,
    alignment,
    calibratedTranscript: calibrated,
    audioVerification,
    hashes
  };
}

function emptySources(): OutputSourceArtifacts {
  return {
    modelSnapshot: null,
    transcript: null,
    calibrationResult: null,
    alignment: null,
    calibratedTranscript: null,
    audioVerification: null,
    hashes: {}
  };
}

function requireCompletedArtifactTracking(task: TaskRecord): void {
  if (
    task.model_snapshot.path !== MODEL_SNAPSHOT_PATH ||
    task.audio_verification.artifact_path !== AUDIO_VERIFICATION_PATH ||
    COMPLETED_WORK_PATHS.some((relativePath) => !task.artifacts.work.includes(relativePath))
  ) {
    throw new OutputStageError('OUTPUT_TASK_ARTIFACT_TRACKING_INVALID', 'task.json 未完整登记 D001/D005 权威工作产物。');
  }
}

function requireCompletedSources(task: TaskRecord, sources: OutputSourceArtifacts): asserts sources is OutputSourceArtifacts & {
  modelSnapshot: ModelSnapshot;
  transcript: TranscriptRaw;
  calibrationResult: CalibrationResult;
  alignment: AlignmentArtifact;
  calibratedTranscript: CalibratedTranscript;
  audioVerification: AudioVerification;
} {
  if (
    !sources.modelSnapshot ||
    !sources.transcript ||
    !sources.calibrationResult ||
    !sources.alignment ||
    !sources.calibratedTranscript ||
    !sources.audioVerification
  ) {
    const missing = [
      !sources.modelSnapshot && MODEL_SNAPSHOT_PATH,
      !sources.transcript && TRANSCRIPT_PATH,
      !sources.calibrationResult && CALIBRATION_PATH,
      !sources.alignment && ALIGNMENT_PATH,
      !sources.calibratedTranscript && CALIBRATED_PATH,
      !sources.audioVerification && AUDIO_VERIFICATION_PATH
    ].filter((value): value is string => Boolean(value));
    throw new OutputStageError('OUTPUT_SOURCE_MISSING', `完成任务缺少权威产物：${missing.join(', ')}`);
  }
  const taskIds = [
    sources.modelSnapshot.task_id,
    sources.transcript.task_id,
    sources.calibrationResult.task_id,
    sources.alignment.task_id,
    sources.calibratedTranscript.task_id,
    sources.audioVerification.task_id
  ];
  if (taskIds.some((taskId) => taskId !== task.task_id)) {
    throw new OutputStageError('OUTPUT_TASK_ID_MISMATCH', '输出输入产物的 task_id 与 task.json 不一致。');
  }
  if (sources.calibratedTranscript.mode !== task.input_config.mode) {
    throw new OutputStageError('OUTPUT_MODE_MISMATCH', 'D005 校准模式与 task.json 不一致。');
  }
  if (sources.alignment.conclusion !== 'matched') {
    throw new OutputStageError('OUTPUT_ALIGNMENT_NOT_MATCHED', '只有 D005 对齐结论为 matched 才能生成成功 SRT。');
  }
  if (
    task.input_config.has_reference_srt !== (sources.alignment.reference_segments !== null) ||
    task.input_config.has_reference_srt !== (sources.calibratedTranscript.source_refs.reference_srt_ref !== null) ||
    task.input_config.has_reference_srt !== (sources.calibrationResult.request.reference_srt_ref !== null)
  ) {
    throw new OutputStageError('OUTPUT_REFERENCE_MODE_MISMATCH', '任务、D001 校准请求、D005 对齐和校准产物的参考 SRT 状态不一致。');
  }
  const asrIds = new Set(sources.alignment.asr_units.map((unit) => unit.segment_id));
  const referenceIds = new Set(sources.alignment.reference_segments?.map((segment) => segment.reference_segment_id) ?? []);
  const resultIds = new Set(sources.calibratedTranscript.segments.map((segment) => segment.subtitle_segment_id));
  const suggestionIds = new Set(sources.calibrationResult.suggestions.map((suggestion) => suggestion.suggestion_id));
  const danglingSegmentRef = sources.calibratedTranscript.segments.some((segment) =>
    segment.asr_segment_refs.some((reference) => !asrIds.has(reference)) ||
    segment.reference_segment_refs.some((reference) => !referenceIds.has(reference))
  );
  const danglingModificationRef = sources.calibratedTranscript.modifications.some((modification) =>
    modification.result_segment_refs.some((reference) => !resultIds.has(reference)) ||
    modification.evidence.asr_segment_refs.some((reference) => !asrIds.has(reference)) ||
    modification.evidence.reference_segment_refs.some((reference) => !referenceIds.has(reference)) ||
    (modification.evidence.calibration_suggestion_ref !== null && !suggestionIds.has(modification.evidence.calibration_suggestion_ref)) ||
    modification.original_segment_refs.some((reference) => !asrIds.has(reference) && !referenceIds.has(reference)) ||
    (modification.applied && modification.result_segment_refs.length === 0)
  );
  if (danglingSegmentRef || danglingModificationRef) {
    throw new OutputStageError('OUTPUT_D005_REFERENCE_INVALID', 'D005 校准产物包含无法回读的 ASR、参考、建议或输出片段引用。');
  }
  requireCompletedArtifactTracking(task);
  if (task.inputs.audio.duration_ms === null || task.inputs.audio.duration_ms <= 0) {
    throw new OutputStageError('OUTPUT_AUDIO_DURATION_MISSING', '完成输出前 task.json 必须记录有效音频时长。');
  }
  if (sources.transcript.audio.duration_ms !== task.inputs.audio.duration_ms) {
    throw new OutputStageError('OUTPUT_AUDIO_DURATION_MISMATCH', '转录产物与 task.json 的音频时长不一致。');
  }
  if (
    sources.transcript.audio.path_ref !== task.inputs.audio.workspace_copy_path ||
    sources.transcript.audio.sha256 !== task.inputs.audio.sha256
  ) {
    throw new OutputStageError('OUTPUT_AUDIO_SOURCE_MISMATCH', '转录产物与 task.json 的音频副本引用或 SHA-256 不一致。');
  }
  if (task.audio_verification.requested !== (sources.audioVerification.status !== 'not_requested')) {
    throw new OutputStageError('OUTPUT_AUDIO_VERIFICATION_MISMATCH', 'task.json 的强校验请求状态与权威产物不一致。');
  }
  if (
    sources.audioVerification.status === 'not_requested' &&
    sources.modelSnapshot.models.audio_verification !== undefined
  ) {
    throw new OutputStageError(
      'OUTPUT_AUDIO_VERIFICATION_MODEL_MISMATCH',
      '强校验未请求时，任务模型快照不得包含 audio_verification 条目。'
    );
  }
}

async function referenceSegments(taskDirectory: string, task: TaskRecord) {
  if (task.input_config.mode !== 'text-only') return null;
  const referencePath = task.inputs.reference_srt?.workspace_copy_path;
  if (!referencePath) throw new OutputStageError('OUTPUT_REFERENCE_MISSING', 'text-only 输出缺少参考 SRT 副本。');
  const parsed = parseReferenceSrt(await readFile(canonicalTaskPath(taskDirectory, referencePath), 'utf8'));
  if (!parsed.ok) throw new OutputStageError('OUTPUT_REFERENCE_INVALID', parsed.issue.message);
  return parsed.segments;
}

function outputFailureTask(task: TaskRecord, error: unknown, now: Date): TaskRecord {
  const failed = structuredClone(task);
  failed.execution.status = 'failed';
  failed.execution.ended_at = now.toISOString();
  failed.updated_at = failed.execution.ended_at;
  failed.error = {
    error_id: `${failed.task_id}-output`,
    code: error instanceof MercuryError ? error.code : 'OUTPUT_ARTIFACT_WRITE_FAILED',
    message: errorMessage(error),
    stage: error instanceof OutputStageError && error.code.includes('VALIDATION') ? 'output_validation' : 'artifact_write',
    retryable: false,
    remediation: '检查任务工作产物和输出目录后，使用新的 calibrate 命令创建任务。'
  };
  failed.failure_stage = failed.error.stage;
  failed.artifacts.outputs = failed.artifacts.outputs.filter((item) => !item.endsWith('.calibrated.srt'));
  failed.artifacts.report = REPORT_PATH;
  return failed;
}

function interruptedSourceDiagnosticTask(task: TaskRecord, error: unknown): TaskRecord {
  const updated = structuredClone(task);
  if (!updated.warnings.some((warning) => warning.code === 'OUTPUT_INTERRUPTED_SOURCE_DIAGNOSTIC')) {
    const sourceCode = error instanceof MercuryError ? error.code : 'OUTPUT_SOURCE_READ_FAILED';
    updated.warnings.push({
      warning_id: `${updated.task_id}-interrupted-source`,
      code: 'OUTPUT_INTERRUPTED_SOURCE_DIAGNOSTIC',
      message: `生成中断诊断报告时无法完整回读工作产物（${sourceCode}）；报告仅使用已安全读取的任务状态。`,
      stage: 'artifact_write',
      severity: 'high'
    });
  }
  return updated;
}

function reportOnlyTask(task: TaskRecord): TaskRecord {
  const updated = structuredClone(task);
  updated.artifacts.outputs = updated.artifacts.outputs.filter((item) => !item.endsWith('.calibrated.srt'));
  updated.artifacts.report = REPORT_PATH;
  if (updated.execution.execution_interrupted && !updated.warnings.some((warning) => warning.code === 'TASK_EXECUTION_INTERRUPTED')) {
    updated.warnings.push({
      warning_id: `${updated.task_id}-execution-interrupted`,
      code: 'TASK_EXECUTION_INTERRUPTED',
      message: '执行进程已中断，任务保留最后持久化的非终态。',
      stage: 'execution',
      severity: 'high'
    });
  }
  return updated;
}

async function writeReport(
  taskDirectory: string,
  task: TaskRecord,
  sources: OutputSourceArtifacts,
  srtPath: string | null,
  validation: SrtValidationResult | null
): Promise<void> {
  await writeTextAtomic(
    canonicalTaskPath(taskDirectory, REPORT_PATH),
    buildCalibrationReport({ task, sources, srtPath, validation })
  );
  sources.hashes[REPORT_PATH] = await sha256File(canonicalTaskPath(taskDirectory, REPORT_PATH));
}

async function reportAbnormalTask(
  taskDirectory: string,
  task: TaskRecord,
  sources: OutputSourceArtifacts,
  validation: SrtValidationResult | null
): Promise<GenerateTaskOutputsResult> {
  const srtPath = `output/${safeAudioStem(task.inputs.audio.original_name)}.calibrated.srt`;
  await rm(canonicalTaskPath(taskDirectory, srtPath), { force: true });
  const updated = reportOnlyTask(task);
  try {
    await writeReport(taskDirectory, updated, sources, null, validation);
  } catch (error) {
    const reportFailure = outputFailureTask(
      updated,
      new OutputStageError('OUTPUT_REPORT_WRITE_FAILED', `无法写入失败或中断报告：${errorMessage(error)}`),
      new Date()
    );
    reportFailure.artifacts.report = null;
    await persistTaskRecord(taskDirectory, reportFailure);
    throw new OutputStageError('OUTPUT_REPORT_WRITE_FAILED', `无法写入 calibration-report.md：${errorMessage(error)}`);
  }
  await persistTaskRecord(taskDirectory, updated);
  return { task: updated, srt_path: null, report_path: REPORT_PATH, srt_validation: validation, sources };
}

export async function generateTaskOutputs(
  taskDirectory: string,
  options: GenerateTaskOutputsOptions = {}
): Promise<GenerateTaskOutputsResult> {
  const resolvedDirectory = path.resolve(taskDirectory);
  await assertTaskDirectoryBoundary(resolvedDirectory);
  const task = await readTaskRecord(resolvedDirectory);

  if (
    task.execution.status !== 'validating' &&
    task.execution.status !== 'completed' &&
    task.execution.status !== 'needs_input' &&
    task.execution.status !== 'failed' &&
    !task.execution.execution_interrupted
  ) {
    throw new OutputStageError('OUTPUT_TASK_STATE_INVALID', `任务状态 ${task.execution.status} 尚不能生成终态或中断报告。`);
  }

  let sources = emptySources();
  try {
    if (task.execution.status === 'validating' || task.execution.status === 'completed') {
      requireCompletedArtifactTracking(task);
    }
    sources = await loadSources(resolvedDirectory, task);
  } catch (error) {
    if (task.execution.execution_interrupted) {
      return reportAbnormalTask(
        resolvedDirectory,
        interruptedSourceDiagnosticTask(task, error),
        sources,
        error instanceof OutputStageError ? error.validation : null
      );
    }
    if (task.execution.status !== 'validating' && task.execution.status !== 'completed') {
      const failed = outputFailureTask(task, error, (options.now ?? (() => new Date()))());
      return reportAbnormalTask(resolvedDirectory, failed, sources, null);
    }
    const failed = outputFailureTask(task, error, (options.now ?? (() => new Date()))());
    return reportAbnormalTask(resolvedDirectory, failed, sources, error instanceof OutputStageError ? error.validation : null);
  }

  if (task.execution.status === 'needs_input' || task.execution.status === 'failed' || task.execution.execution_interrupted) {
    return reportAbnormalTask(resolvedDirectory, task, sources, null);
  }

  const srtPath = `output/${safeAudioStem(task.inputs.audio.original_name)}.calibrated.srt`;
  const srtFile = canonicalTaskPath(resolvedDirectory, srtPath);
  let validation: SrtValidationResult | null = null;
  try {
    requireCompletedSources(task, sources);
    const reference = await referenceSegments(resolvedDirectory, task);
    const validationContext: SrtValidationContext = {
      audioDurationMs: task.inputs.audio.duration_ms!,
      expectedSegments: sources.calibratedTranscript.segments,
      mode: sources.calibratedTranscript.mode,
      referenceSegments: reference
    };
    if (task.execution.status === 'validating') {
      await writeTextAtomic(srtFile, serializeCalibratedSrt(sources.calibratedTranscript));
    } else {
      try {
        const details = await stat(srtFile);
        if (!details.isFile()) throw new Error('not a regular file');
      } catch (error) {
        throw new OutputStageError('OUTPUT_COMPLETED_ARTIFACT_MISSING', `completed 任务缺少最终 SRT：${errorMessage(error)}`);
      }
    }
    validation = await validateSrtFile(srtFile, validationContext);
    if (!validation.valid) {
      const summary = validation.checks.filter((check) => check.status === 'failed').map((check) => check.message).join('；');
      throw new OutputStageError('OUTPUT_VALIDATION_FAILED', summary, validation);
    }
    const srtSha256 = await sha256File(srtFile);
    sources.hashes[srtPath] = srtSha256;
    const updated = structuredClone(task);
    if (updated.execution.status === 'validating') {
      const ended = (options.now ?? (() => new Date()))().toISOString();
      updated.execution.status = 'completed';
      updated.execution.last_completed_stage = 'validating';
      updated.execution.ended_at = ended;
      updated.updated_at = ended;
      updated.error = null;
      updated.failure_stage = null;
    }
    updated.artifacts.outputs = [srtPath];
    updated.artifacts.report = REPORT_PATH;
    if (sources.audioVerification) {
      updated.audio_verification.artifact_path = AUDIO_VERIFICATION_PATH;
      updated.audio_verification.sha256 = sources.hashes[AUDIO_VERIFICATION_PATH]!;
    }
    await writeReport(resolvedDirectory, updated, sources, srtPath, validation);
    await persistTaskRecord(resolvedDirectory, updated);
    return { task: updated, srt_path: srtPath, report_path: REPORT_PATH, srt_validation: validation, sources };
  } catch (error) {
    await rm(srtFile, { force: true });
    const failed = outputFailureTask(task, error, (options.now ?? (() => new Date()))());
    validation = error instanceof OutputStageError ? error.validation : validation;
    return reportAbnormalTask(resolvedDirectory, failed, sources, validation);
  }
}
