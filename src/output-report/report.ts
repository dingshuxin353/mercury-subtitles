import type { AudioVerification, ModelSnapshotEntry } from '../contracts/index.js';
import type {
  SubtitleModification
} from '../subtitle-core/index.js';
import type { TaskRecord } from '../tasks.js';
import type {
  OutputSourceArtifacts,
  QualityCheck,
  ReportModificationType,
  SrtValidationResult
} from './types.js';

export interface ReportContext {
  task: TaskRecord;
  sources: OutputSourceArtifacts;
  srtPath: string | null;
  validation: SrtValidationResult | null;
}

const ROLE_LABELS: Record<string, string> = {
  asr: 'ASR',
  calibration: '校准',
  audio_verification: '音频强校验'
};
const INCOMPLETE_SUGGESTION_RATIONALE = '模型建议不完整';
const V01_GEMINI_INPUT_LIMIT = 'V0.1 Gemini 强校验仅支持不超过 15MB';

function md(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value)
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:authorization|api[-_ ]?key|access[-_ ]?token|secret|password)\s*[:=]\s*\S+/giu, '[REDACTED]')
    .replace(/\b(?:env|keychain|adc):[^\s；，,)]+/giu, '[CREDENTIAL_REF_REDACTED]')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replaceAll('|', '\\|')
    .replaceAll('\r', '')
    .replaceAll('\n', '<br>')
    .trim() || '—';
}

function audioSkipReason(reason: AudioVerification['skip_reason']): string {
  return reason === 'input_limit_exceeded' ? V01_GEMINI_INPUT_LIMIT : md(reason);
}

function timeRange(start: number, end: number): string {
  return `${start}–${end} ms`;
}

function artifactLine(path: string, sources: OutputSourceArtifacts): string {
  return `\`${path}\`（SHA-256: \`${sources.hashes[path] ?? '未形成'}\`）`;
}

function modificationType(modification: SubtitleModification): ReportModificationType {
  if (modification.type === 'omission_recovery') return 'missing_content';
  if (modification.type === 'split' || modification.type === 'segmentation') return 'split';
  if (modification.type === 'merge') return 'merge';
  if (modification.type === 'timing_adjustment') return 'timing';
  const comparison = `${modification.original_text}${modification.replacement_text}`;
  if (/\d|[０-９]|%|％|[年月日时分秒元角万元亿元公里千米米厘米毫米公斤千克克]/u.test(comparison)) {
    return 'number_unit';
  }
  if (/人名|姓名|品牌|产品名|专有名词/u.test(modification.reason)) return 'proper_noun';
  if (/术语|专业词|固定词/u.test(modification.reason)) return 'term';
  const withoutPunctuation = (value: string) => value.replace(/[\p{P}\p{S}\s]/gu, '');
  if (withoutPunctuation(modification.original_text) === withoutPunctuation(modification.replacement_text)) {
    return 'punctuation';
  }
  return 'recognition_error';
}

function callOutcome(
  role: ModelSnapshotEntry['role'],
  context: ReportContext
): { stage: string; outcome: string; source: string } {
  if (role === 'asr' && context.sources.transcript) {
    return { stage: 'analyzing_audio', outcome: context.sources.transcript.call.outcome, source: 'work/transcript.raw.json' };
  }
  if (role === 'calibration' && context.sources.calibrationResult) {
    return { stage: 'calibrating', outcome: context.sources.calibrationResult.call.outcome, source: 'work/calibration-result.json' };
  }
  if (role === 'audio_verification' && context.sources.audioVerification) {
    const audio = context.sources.audioVerification;
    return {
      stage: 'verifying_audio',
      outcome: audio.status,
      source: 'work/audio-verification.json'
    };
  }
  const failure = context.task.adapter_failures.find((candidate) => candidate.role === role);
  if (failure) return { stage: failure.errors[0].stage, outcome: 'failed', source: `task.json#${failure.failure_id}` };
  return { stage: '未执行', outcome: '未形成', source: '—' };
}

function modelRows(context: ReportContext): string[] {
  const snapshot = context.sources.modelSnapshot;
  const audioStatus = context.sources.audioVerification?.status;
  const rows: string[] = [];
  if (snapshot) {
    for (const role of ['asr', 'calibration', 'audio_verification'] as const) {
      if (role === 'audio_verification' && audioStatus === 'not_requested') continue;
      const entry = snapshot.models[role];
      if (!entry) continue;
      const call = callOutcome(role, context);
      const checkedActualModel = entry.check_snapshot.outcome === 'passed'
        ? entry.check_snapshot.actual_model
        : null;
      rows.push(`| ${ROLE_LABELS[role]} | ${md(entry.config_id)} | ${md(entry.name)} | ${md(entry.model)} | ${md(checkedActualModel)} | ${md(entry.runtime)} | ${md(call.stage)} | ${md(call.outcome)} | ${md(call.source)} |`);
    }
  }
  const audio = context.sources.audioVerification;
  if (audio?.status === 'not_requested') {
    rows.push('| 音频强校验 | — | — | — | — | — | 未请求 | not_requested | work/audio-verification.json |');
  } else if (!snapshot?.models.audio_verification && audio?.status === 'skipped') {
    rows.push(`| 音频强校验 | — | — | — | — | — | 调用前跳过 | skipped: ${audioSkipReason(audio.skip_reason)} | work/audio-verification.json |`);
  }
  return rows.length > 0 ? rows : ['| — | — | — | — | — | — | — | 未形成 | — |'];
}

function strongVerification(context: ReportContext): string[] {
  const audio = context.sources.audioVerification;
  const failure = context.task.adapter_failures.find((candidate) => candidate.role === 'audio_verification');
  if (!audio && failure) {
    return [
      `- 权威来源：\`task.json\` 中的 AdapterFailureRecord \`${failure.failure_id}\``,
      '- 状态：`failed`（强校验未完成）',
      `- 原因：${md(failure.errors.map((error) => `${error.code}: ${error.message}`).join('；'))}`
    ];
  }
  if (!audio) {
    return [
      '- 权威来源：未形成',
      `- 状态：${context.task.audio_verification.requested ? '未形成（强校验未完成）' : '未形成（基础链路在强校验产物形成前结束）'}`
    ];
  }
  const applied = audio.application_results.filter((item) => item.disposition === 'applied').length;
  const review = audio.application_results.filter((item) => item.disposition === 'not_applied').length;
  const discarded = audio.application_results.filter((item) =>
    item.reason === 'translation_out_of_scope' || item.reason === 'verification_failed'
  ).length;
  const incompleteSuggestions = audio.findings.filter((finding) =>
    finding.kind === 'uncertain' &&
    finding.suggested_text === null &&
    finding.rationale.startsWith(INCOMPLETE_SUGGESTION_RATIONALE)
  ).length;
  const effectiveFindings = audio.findings.length - incompleteSuggestions;
  const lines = [
    `- 权威来源：${artifactLine('work/audio-verification.json', context.sources)}`,
    `- 状态：\`${audio.status}\`${audio.status === 'failed' || audio.status === 'skipped' ? '（强校验未完成）' : ''}`,
    `- 跳过原因：${audioSkipReason(audio.skip_reason)}`,
    `- 有效发现项：${effectiveFindings}；模型建议不完整：${incompleteSuggestions}；已应用：${applied}；仅待复核：${review}；越界丢弃：${discarded}`
  ];
  if (audio.errors.length > 0) {
    lines.push(`- 错误：${md(audio.errors.map((error) => `${error.code}: ${error.message}`).join('；'))}`);
  }
  if (audio.local_chunking) {
    lines.push(
      `- 本地音频分片：源文件 ${audio.local_chunking.source_bytes} bytes；阈值 ${audio.local_chunking.threshold_bytes} bytes；共 ${audio.local_chunking.parts.length} 片。`,
      '',
      '| 分片 ID | bytes | 全局时间 | 调用 | 终态 | 错误引用 |',
      '|---|---:|---|---|---|---|'
    );
    for (const part of audio.local_chunking.parts) {
      lines.push(`| ${md(part.chunk_id)} | ${part.bytes} | ${timeRange(part.start_ms, part.end_ms)} | ${md(part.call_ref)} | ${md(part.outcome)} | ${md(part.error_ref)} |`);
    }
  }
  const entry = context.sources.modelSnapshot?.models.audio_verification;
  if (entry && audio.status !== 'not_requested') {
    const identity = entry as typeof entry & { plugin_id?: string; connection_type?: string };
    const provider = entry.provider_config as Record<string, unknown>;
    if (identity.plugin_id === 'gemini') {
      const location = identity.connection_type === 'vertex_ai'
        ? `；project=${md(provider.project)}；location=${md(provider.location)}`
        : '';
      lines.push(`- Gemini：connection=${md(identity.connection_type)}；model=${md(entry.model)}${location}`);
    } else {
      lines.push(`- Vertex AI：project=${md(provider.project)}；location=${md(provider.location)}；model=${md(entry.model)}`);
    }
  }
  const staging = audio.staging[0];
  if (staging) {
    const label = staging.staging_kind === 'gemini_file' ? 'Gemini Files 暂存' : '私有 GCS 暂存';
    lines.push(`- ${label}：${md(staging.object_uri)}；清理状态：\`${staging.cleanup_status}\`；完成时间：${md(staging.cleanup_finished_at)}`);
    if (staging.cleanup_status === 'failed') {
      const cleanupError = audio.errors.find((error) => error.error_id === staging.error_ref);
      lines.push(`- 人工建议：${md(cleanupError?.remediation ?? '立即按对象 URI 检查并清理遗留私有对象。')}`);
    }
  }
  if (audio.findings.length > 0) {
    lines.push('', '| 发现 ID | 时间 | 当前文字 | 建议文字 | 理由 | 置信度 | 应用结果 |', '|---|---|---|---|---|---|---|');
    for (const finding of audio.findings) {
      const application = audio.application_results.find((item) => item.finding_ref === finding.finding_id);
      lines.push(`| ${md(finding.finding_id)} | ${timeRange(finding.start_ms, finding.end_ms)} | ${md(finding.current_text)} | ${md(finding.suggested_text)} | ${md(finding.rationale)} | ${md(finding.confidence)} | ${md(application ? `${application.disposition}: ${application.reason}` : '未形成')} |`);
    }
  }
  return lines;
}

function mappedRange(
  context: ReportContext,
  refs: string[],
  side: 'original' | 'result',
  fallback: { start: number; end: number }
): { start: number; end: number } {
  const calibrated = context.sources.calibratedTranscript;
  const alignment = context.sources.alignment;
  const candidates = side === 'result'
    ? calibrated?.segments.filter((segment) => refs.includes(segment.subtitle_segment_id)) ?? []
    : [
        ...(alignment?.reference_segments?.filter((segment) => refs.includes(segment.reference_segment_id)) ?? []),
        ...(alignment?.asr_units.filter((segment) => refs.includes(segment.segment_id)) ?? [])
      ];
  if (candidates.length === 0) return fallback;
  return {
    start: Math.min(...candidates.map((candidate) => candidate.start_ms)),
    end: Math.max(...candidates.map((candidate) => candidate.end_ms))
  };
}

function modificationRows(context: ReportContext, modifications: SubtitleModification[]): string[] {
  if (modifications.length === 0) return ['- 无逐项修改或结构调整记录。'];
  const lines = [
    '| 修改 ID | 主要类型 | 原片段 / ASR | 输出片段 | 原时间 → 新时间 | 原文字 → 新文字 | 证据与原因 | 置信度 | 写入最终 SRT |',
    '|---|---|---|---|---|---|---|---|---|'
  ];
  for (const modification of modifications) {
    const originalRefs = modification.original_segment_refs.length > 0
      ? modification.original_segment_refs
      : modification.evidence.asr_segment_refs;
    const originalRange = mappedRange(context, originalRefs, 'original', { start: modification.start_ms, end: modification.end_ms });
    const resultRange = mappedRange(context, modification.result_segment_refs, 'result', { start: modification.start_ms, end: modification.end_ms });
    const evidence = [
      `ASR=${modification.evidence.asr_segment_refs.join(',') || '—'}`,
      `参考=${modification.evidence.reference_segment_refs.join(',') || '—'}`,
      `音频=${timeRange(modification.start_ms, modification.end_ms)}`,
      modification.reason
    ].join('；');
    lines.push(`| ${md(modification.modification_id)} | ${modificationType(modification)} | ${md(originalRefs.join(','))} | ${md(modification.result_segment_refs.join(','))} | ${timeRange(originalRange.start, originalRange.end)} → ${timeRange(resultRange.start, resultRange.end)} | ${md(modification.original_text)} → ${md(modification.replacement_text)} | ${md(evidence)} | ${modification.confidence} | ${modification.applied ? '是' : '否'} |`);
  }
  return lines;
}

function qualityRows(checks: QualityCheck[]): string[] {
  if (checks.length === 0) return ['- 最终 SRT 质量检查未执行。'];
  const lines = ['| 检查项 | 结果 | 实际值或位置 |', '|---|---|---|'];
  for (const check of checks) {
    lines.push(`| ${md(check.check_id)} | ${check.status} | ${md(`${check.message}${check.segment_refs.length ? ` [${check.segment_refs.join(', ')}]` : ''}`)} |`);
  }
  return lines;
}

function reviewItems(context: ReportContext): string[] {
  const calibrated = context.sources.calibratedTranscript;
  const lines: string[] = [];
  for (const segment of calibrated?.segments ?? []) {
    if (segment.confidence === 'high') continue;
    lines.push(`- ${segment.subtitle_segment_id}（${timeRange(segment.start_ms, segment.end_ms)}）：${md(segment.text)}；置信度 ${segment.confidence}，建议核听。`);
  }
  for (const modification of calibrated?.modifications ?? []) {
    if (modification.applied) continue;
    lines.push(`- ${modification.modification_id}（${timeRange(modification.start_ms, modification.end_ms)}）：保留 ${md(modification.original_text)}；原因：${md(modification.reason)}；置信度 ${modification.confidence}。`);
  }
  return lines.length > 0 ? lines : ['- 无待人工复核项；这不表示已经进行人工确认。'];
}

function warningLines(context: ReportContext): string[] {
  const warnings: Array<{ id: string; code: string; message: string }> = [];
  for (const warning of context.task.warnings) warnings.push({ id: warning.warning_id, code: warning.code, message: warning.message });
  for (const warning of context.sources.calibratedTranscript?.warnings ?? []) {
    warnings.push({ id: warning.warning_id, code: warning.code, message: warning.message });
  }
  for (const warning of context.sources.audioVerification?.warnings ?? []) warnings.push({ id: warning.warning_id, code: warning.code, message: warning.message });
  for (const check of context.validation?.checks.filter((candidate) => candidate.status === 'warning') ?? []) {
    warnings.push({ id: check.check_id, code: check.check_id, message: check.message });
  }
  const unique = [...new Map(warnings.map((warning) => [warning.id, warning])).values()];
  return unique.length > 0
    ? unique.map((warning) => `- ${md(warning.id)} / ${md(warning.code)}：${md(warning.message)}`)
    : ['- 无普通警告。'];
}

function terminalReason(context: ReportContext): string[] {
  const task = context.task;
  if (task.execution.execution_interrupted) {
    return [
      `- 诊断码：\`TASK_EXECUTION_INTERRUPTED\``,
      `- 最后成功阶段：${md(task.execution.last_completed_stage)}`,
      `- 中断时间：${md(task.updated_at)}`,
      '- 说明：任务保留最后非终态；这不是 `failed`、已恢复或已完成。',
      '- 建议：检查已形成产物和可能遗留的云端对象，再用新的命令创建新任务。'
    ];
  }
  if (task.execution.status === 'needs_input') {
    return [
      `- 未通过门槛：${md(task.error ? `${task.error.code}: ${task.error.message}` : task.failure_stage)}`,
      '- 未生成 SRT：是',
      `- 下一步：${md(task.error?.remediation ?? '检查输入文件或校准模式后创建新任务。')}`
    ];
  }
  if (task.execution.status === 'failed') {
    const cloudCallOccurred = Boolean(
      context.sources.transcript?.call ||
      context.sources.calibrationResult?.call ||
      context.sources.audioVerification?.calls[0] ||
      task.adapter_failures.some((failure) => failure.call !== null)
    );
    return [
      `- 失败阶段：${md(task.failure_stage ?? task.error?.stage)}`,
      `- 错误：${md(task.error ? `${task.error.code}: ${task.error.message}` : '未形成错误记录')}`,
      `- 已完成阶段：${md(task.execution.last_completed_stage)}`,
      `- 是否发生云端调用：${cloudCallOccurred ? '是；请按调用产物逐项回读' : '否；未发现调用记录'}`,
      '- 原始输入：Mercury 只读取任务副本，原件不应被修改。',
      `- 下一步：${md(task.error?.remediation ?? '处理问题后创建新任务；V0.1 不支持原任务重试。')}`
    ];
  }
  return [];
}

function sourceTracking(context: ReportContext): string[] {
  const paths = [
    context.task.model_snapshot.path,
    'work/transcript.raw.json',
    'work/calibration-result.json',
    'work/alignment.json',
    'work/transcript.calibrated.json',
    context.task.audio_verification.artifact_path,
    context.srtPath
  ].filter((path): path is string => Boolean(path));
  return [
    ...[...new Set(paths)].map((path) => `- ${artifactLine(path, context.sources)}`),
    '- `output/calibration-report.md`（当前报告；不在正文中嵌入自身哈希）'
  ];
}

export function buildCalibrationReport(context: ReportContext): string {
  const task = context.task;
  const calibrated = context.sources.calibratedTranscript;
  const alignment = context.sources.alignment;
  const reviewCount = (calibrated?.segments ?? []).filter((segment) => segment.confidence !== 'high').length +
    (calibrated?.modifications ?? []).filter((modification) => !modification.applied).length +
    (context.sources.audioVerification?.application_results ?? []).filter((item) => item.disposition === 'not_applied').length;
  const warningCount = task.warnings.length +
    (calibrated?.warnings.length ?? 0) +
    (context.sources.audioVerification?.warnings.length ?? 0) +
    (context.validation?.checks.filter((check) => check.status === 'warning').length ?? 0);
  const lines = [
    '# Mercury 字幕校准工作报告',
    '',
    '## 任务结果',
    '',
    `- 任务 ID：\`${task.task_id}\``,
    `- 任务目录：\`${md(task.task_directory)}\``,
    '- 任务类型：`subtitle_calibration`',
    `- 状态：\`${task.execution.status}\``,
    `- execution_interrupted：\`${task.execution.execution_interrupted}\``,
    `- 创建时间：${md(task.created_at)}`,
    `- 开始时间：${md(task.execution.started_at)}`,
    `- 结束时间：${md(task.execution.ended_at)}`,
    `- 是否生成校准 SRT：${context.srtPath ? '是' : '否'}`,
    `- SRT：${context.srtPath ? artifactLine(context.srtPath, context.sources) : '未生成'}`,
    `- 警告总数：${warningCount}`,
    `- 待人工复核总数：${reviewCount}`,
    ''
  ];

  const reason = terminalReason(context);
  if (reason.length > 0) lines.push(task.execution.execution_interrupted ? '## 执行中断' : '## 失败或拒绝原因', '', ...reason, '');

  lines.push(
    '## 输入与模式',
    '',
    `- MP3 原文件名：${md(task.inputs.audio.original_name)}`,
    `- MP3 来源路径：${md(task.inputs.audio.original_path)}`,
    `- MP3 工作区副本：\`${md(task.inputs.audio.workspace_copy_path)}\``,
    `- MP3 SHA-256：\`${md(task.inputs.audio.sha256)}\``,
    `- 音频时长：${md(task.inputs.audio.duration_ms === null ? null : `${task.inputs.audio.duration_ms} ms`)}`,
    `- 参考 SRT：${task.input_config.has_reference_srt ? '已提供' : '未提供'}`,
    `- 参考 SRT 来源：${md(task.inputs.reference_srt?.original_path)}`,
    `- 参考 SRT 副本：${md(task.inputs.reference_srt?.workspace_copy_path)}`,
    `- 参考 SRT SHA-256：${md(task.inputs.reference_srt?.sha256)}`,
    `- 输入配置：${task.input_config.has_reference_srt ? 'MP3 + SRT' : '仅 MP3'}`,
    `- 校准模式：${md(task.input_config.mode)}`,
    `- text-only 时间轴预检查：${task.input_config.mode === 'text-only' ? (context.validation?.checks.find((check) => check.check_id === 'SRT_TEXT_ONLY_TIMELINE')?.status ?? '未执行') : '不适用'}`,
    `- ASR 覆盖率 / 参考覆盖率 / 阈值：${alignment ? `${(alignment.asr_coverage * 100).toFixed(2)}% / ${alignment.reference_coverage === null ? '不适用' : `${(alignment.reference_coverage * 100).toFixed(2)}%`} / ${(alignment.threshold * 100).toFixed(0)}%` : '未形成'}`,
    '',
    '## 实际模型',
    '',
    '| 角色 | 配置 ID | 名称 | 配置 / 实际请求模型 | 能力检查实际模型 | runtime | 调用阶段 | 结果 | 权威来源 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...modelRows(context),
    '',
    '> 任务调用协议未单独保存供应商任务响应中的模型字段；“配置 / 实际请求模型”来自快照 `model`，“能力检查实际模型”来自 `check_snapshot.actual_model`，两者允许不同。',
    '',
    '## 处理摘要',
    '',
    `- 原始转录片段：${context.sources.transcript?.segments.length ?? 0}`,
    `- 最终字幕片段：${calibrated?.segments.length ?? 0}`,
    `- 修改与结构调整：${calibrated?.modifications.length ?? 0}`,
    `- 已自动写入：${calibrated?.modifications.filter((item) => item.applied).length ?? 0}`,
    `- 未写入：${calibrated?.modifications.filter((item) => !item.applied).length ?? 0}`,
    '',
    '## 多模态音频强校验',
    '',
    ...strongVerification(context),
    '',
    '## 修改与结构调整',
    '',
    ...modificationRows(context, calibrated?.modifications ?? []),
    '',
    '## 质量检查',
    '',
    ...qualityRows(context.validation?.checks ?? []),
    '',
    '## 警告与待人工复核',
    '',
    '### 警告',
    '',
    ...warningLines(context),
    '',
    '### 待人工复核',
    '',
    ...reviewItems(context),
    '',
    '## 产物与追踪信息',
    '',
    ...sourceTracking(context),
    '',
    '> 本报告是 task.json、模型快照及工作产物的人类可读投影，不是可独立修改的事实源。',
    ''
  );
  return lines.join('\n');
}
