import type { CliIo } from '../cli.js';
import path from 'node:path';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { MercuryError } from '../errors.js';
import { readProductVersion } from '../version.js';
import { applyConfigMigration, inspectConfigMigration } from './config.js';
import { stableFailure, stableSuccess } from './envelope.js';
import { createdAtOf, decodeTaskCursor, findTaskReadOnly, listTasksReadOnly, stableCancelTask, stableEventsAfter, stableTaskResult, stableTaskView, taskCursor, taskIdOf } from './tasks.js';
import { readStableJson, writeStableJsonAtomic } from '../exchange/storage.js';
import { projectV5Task, submitExchangeRequest } from '../exchange/runtime.js';
import { startDetachedWorker } from '../background/worker.js';
import { inspectTranscriptInput, serializeTranscriptSrt, type TranscriptInputFormat, type TranscriptInputRole } from '../external-input.js';
import { assertExchangeContract, type ExchangeRequestV1 } from '../contracts/index.js';
import { submitBackgroundTask } from '../background/runtime.js';
import { sha256File } from '../tasks.js';

export interface StableCliContext {
  workspaceRoot: string;
  io: CliIo;
}

function output(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

function value(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const found = args[index + 1];
  if (!found || found.startsWith('--')) throw new MercuryError('CLI_OPTION_VALUE_MISSING', `${option} 缺少参数值。`, { exitCode: 2 });
  return found;
}

function exactJson(args: string[], allowedValues: string[] = []): void {
  const allowed = new Set(['--json', ...allowedValues]);
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index]!;
    if (!allowed.has(entry)) throw new MercuryError('CLI_ARGUMENT_INVALID', `不支持的参数：${entry}`, { exitCode: 2 });
    if (allowedValues.includes(entry)) index += 1;
  }
  if (!args.includes('--json')) throw new MercuryError('CLI_ARGUMENT_INVALID', '稳定机器命令必须使用 --json。', { exitCode: 2 });
}

async function submitProviderRequest(workspaceRoot: string, request: ExchangeRequestV1) {
  if (!request.inputs.media || request.transcription_mode !== 'provider' || !request.models.asr) {
    throw new MercuryError('REQUEST_INVALID', 'Provider 转写请求缺少媒体或 ASR 模型。', { exitCode: 2 });
  }
  let temporary: string | null = null;
  try {
    let referencePath: string | undefined;
    if (request.inputs.transcript) {
      if (request.inputs.transcript.role !== 'reference') throw new MercuryError('REQUEST_INVALID', 'Provider 模式的外部文本只能声明 reference。', { exitCode: 2 });
      const inspected = await inspectTranscriptInput({ filePath: request.inputs.transcript.path, format: request.inputs.transcript.format, role: 'reference' });
      if (inspected.sha256 !== request.inputs.transcript.sha256) throw new MercuryError('INPUT_HASH_MISMATCH', '参考字幕 hash 与 request 不一致。', { exitCode: 2 });
      temporary = await mkdtemp(path.join(os.tmpdir(), 'mercury-reference-'));
      referencePath = path.join(temporary, 'reference.srt');
      await writeFile(referencePath, serializeTranscriptSrt(inspected.transcript), { mode: 0o600 });
    }
    if (await sha256File(request.inputs.media.path) !== request.inputs.media.sha256) throw new MercuryError('INPUT_HASH_MISMATCH', '媒体 hash 与 request 不一致。', { exitCode: 2 });
    const submitted = await submitBackgroundTask({
      workspaceRoot, requestId: request.request_id, audioPath: request.inputs.media.path,
      ...(referencePath ? { srtPath: referencePath, mode: request.calibration.mode } : {}),
      asrModelId: request.models.asr, chatModelId: request.models.chat,
      now: () => new Date(request.created_at),
    });
    const directory = path.join(workspaceRoot, 'tasks', submitted.task.task_directory);
    const stableRequest = path.join(directory, 'request.json');
    try {
      const existing = assertExchangeContract('request', await readStableJson(stableRequest, 'REQUEST_INVALID'));
      if (existing.request_id !== request.request_id) throw new MercuryError('REQUEST_ID_CONFLICT', '任务目录已有不同稳定 request。', { exitCode: 3 });
    } catch (error) {
      if (!(error instanceof MercuryError) || error.code !== 'REQUEST_INVALID') throw error;
      await writeStableJsonAtomic(stableRequest, request);
    }
    if (request.inputs.transcript) {
      const extension = request.inputs.transcript.format === 'transcript_json' ? 'json' : request.inputs.transcript.format;
      const original = path.join(directory, `input/reference-source.${extension}`);
      try {
        if (await sha256File(original) !== request.inputs.transcript.sha256) throw new MercuryError('INPUT_COPY_MISMATCH', '历史 reference 原件 hash 不一致。');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await copyFile(request.inputs.transcript.path, original);
        await chmod(original, 0o600);
      }
    }
    return { task: submitted.task, replayed: submitted.replayed };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export async function tryRunStableCli(args: string[], context: StableCliContext): Promise<number | null> {
  const command = args[0] === 'protocol' && args[1] ? `protocol.${args[1]}`
    : args[0] === 'input' && args[1] === 'inspect' ? 'input.inspect'
    : args[0] === 'config' && args[1] === 'status' ? 'config.status'
      : args[0] === 'config' && args[1] === 'migrate' ? 'config.migrate'
        : args[0] === 'task' && args[1] && (args.includes('--json') || args.includes('--jsonl')) ? `task.${args[1]}`
        : null;
  if (!command) return null;
  const version = await readProductVersion();
  try {
    let data: unknown;
    if (args[0] === 'protocol') {
      exactJson(args.slice(2));
      if (args[1] === 'version') data = { protocol: 'v1', contracts: ['mercury.exchange.request/v1', 'mercury.task/v1', 'mercury.event/v1', 'mercury.result/v1', 'mercury.error/v1', 'mercury.transcript/v1', 'mercury.dictionary/v1'] };
      else if (args[1] === 'capabilities') data = {
        alpha: '0.3.0-alpha.1',
        commands: {
          protocol: true, config_migration: true, external_srt: true, external_vtt: true, external_transcript_json: true,
          dictionary: true, dictionary_skill_management: false, pause: false, resume: false, retry: false, venus_adapter: false,
        },
        task_control: { cancel: true, pause: { supported: false, planned_for: '0.3.0-alpha.2' }, resume: { supported: false, planned_for: '0.3.0-alpha.2' }, retry: { supported: false, planned_for: '0.3.0-alpha.2' } },
        machine_contract: 'mercury.cli/v1', input_formats: ['srt', 'vtt', 'transcript_json'], query_commands_are_read_only: true,
      };
      else throw new MercuryError('CLI_COMMAND_INVALID', `不支持的协议命令：${args[1]}`, { exitCode: 2 });
    } else if (args[0] === 'input') {
      const inspectArgs = args.slice(2);
      exactJson(inspectArgs, ['--file', '--format', '--role']);
      const file = value(inspectArgs, '--file');
      const formatText = value(inspectArgs, '--format');
      const roleText = value(inspectArgs, '--role');
      if (!file) throw new MercuryError('CLI_OPTION_VALUE_MISSING', '--file 缺少绝对输入路径。', { exitCode: 2 });
      if (!formatText || !['auto', 'srt', 'vtt', 'transcript-json'].includes(formatText)) {
        throw new MercuryError('CLI_ARGUMENT_INVALID', '--format 必须是 auto、srt、vtt 或 transcript-json。', { exitCode: 2 });
      }
      if (!roleText) throw new MercuryError('TRANSCRIPT_ROLE_REQUIRED', '--role 必须显式选择 transcript-source 或 reference。', { exitCode: 2 });
      if (!['transcript-source', 'reference'].includes(roleText)) {
        throw new MercuryError('TRANSCRIPT_ROLE_REQUIRED', '--role 必须显式选择 transcript-source 或 reference。', { exitCode: 2 });
      }
      const inspected = await inspectTranscriptInput({
        filePath: file,
        format: (formatText === 'transcript-json' ? 'transcript_json' : formatText) as 'auto' | TranscriptInputFormat,
        role: roleText.replace('-', '_') as TranscriptInputRole,
      });
      data = {
        path: inspected.absolute_path,
        format: inspected.format,
        role: inspected.role,
        bytes: inspected.bytes,
        sha256: inspected.sha256,
        segment_count: inspected.cue_count,
        duration_ms: inspected.duration_ms,
        language: inspected.language,
        warnings: inspected.warnings,
        valid: true,
      };
    } else if (args[0] === 'config' && args[1] === 'status') {
      exactJson(args.slice(2));
      data = await inspectConfigMigration(context.workspaceRoot);
    } else if (args[0] === 'config') {
      const migrateArgs = args.slice(2);
      if (migrateArgs.includes('--check')) {
        exactJson(migrateArgs, ['--check']);
        data = await inspectConfigMigration(context.workspaceRoot);
      } else {
        exactJson(migrateArgs, ['--plan']);
        const plan = value(migrateArgs, '--plan');
        if (!plan) throw new MercuryError('CLI_OPTION_VALUE_MISSING', '--plan 缺少 plan_id。', { exitCode: 2 });
        data = await applyConfigMigration(context.workspaceRoot, plan);
      }
      } else {
        const operation = args[1]!;
        const commandArgs = args.slice(2);
      if (operation === 'submit') {
        exactJson(commandArgs, ['--request']);
        const requestPath = value(commandArgs, '--request');
        if (!requestPath) throw new MercuryError('CLI_OPTION_VALUE_MISSING', 'task submit 必须提供 --request <绝对 request.json>。', { exitCode: 2 });
        if (!path.isAbsolute(requestPath)) throw new MercuryError('CLI_ARGUMENT_INVALID', '--request 必须使用绝对路径。', { exitCode: 2 });
        const request = assertExchangeContract('request', await readStableJson(requestPath, 'REQUEST_INVALID'));
        const submitted = request.transcription_mode === 'provided'
          ? await submitExchangeRequest(context.workspaceRoot, request)
          : await submitProviderRequest(context.workspaceRoot, request);
        let worker: { started: boolean; pid: number | null; problem: string | null };
        try {
          const started = await startDetachedWorker(context.workspaceRoot);
          worker = { started: true, pid: started.pid, problem: null };
        } catch (error) {
          worker = { started: false, pid: null, problem: error instanceof MercuryError ? error.message : 'Worker 启动失败；任务仍安全保留在队列。' };
        }
        const stableTask = 'identity' in submitted.task
          ? await projectV5Task(path.join(context.workspaceRoot, 'tasks', submitted.task.identity.task_directory), submitted.task)
          : await stableTaskView(context.workspaceRoot, submitted.task);
        data = { task: stableTask, request_id: request.request_id, replayed: submitted.replayed, worker };
      } else if (['pause', 'resume', 'retry-plan', 'retry'].includes(operation)) {
        throw new MercuryError('CONTRACT_UNSUPPORTED', `0.3.0-alpha.1 不支持 task ${operation}；能力发现已标记为 Alpha.2。`, { exitCode: 5 });
      } else if (operation === 'list') {
        exactJson(commandArgs, ['--cursor', '--limit']);
        const rawLimit = value(commandArgs, '--limit') ?? '20';
        const limit = Number.parseInt(rawLimit, 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MercuryError('CLI_ARGUMENT_INVALID', '--limit 必须是 1–100。', { exitCode: 2 });
        const all = await listTasksReadOnly(context.workspaceRoot);
        const cursor = value(commandArgs, '--cursor');
        const start = cursor
          ? (() => {
              const decoded = decodeTaskCursor(cursor);
              const index = all.findIndex((task) => createdAtOf(task) === decoded.createdAt && taskIdOf(task) === decoded.taskId);
              if (index < 0) throw new MercuryError('CLI_ARGUMENT_INVALID', '任务列表 cursor 已过期或不存在。', { exitCode: 2 });
              return index + 1;
            })()
          : 0;
        const page = all.slice(start, start + limit);
        data = { tasks: await Promise.all(page.map((task) => stableTaskView(context.workspaceRoot, task))), next_cursor: start + page.length < all.length ? taskCursor(page.at(-1)!) : null };
      } else {
        const taskId = commandArgs[0];
        if (!taskId || taskId.startsWith('--')) throw new MercuryError('CLI_ARGUMENT_INVALID', `task ${operation} 必须提供 task ID。`, { exitCode: 2 });
        if (operation === 'watch') {
          const watchArgs = commandArgs.slice(1);
          const allowed = new Set(['--jsonl', '--after']);
          for (let index = 0; index < watchArgs.length; index += 1) {
            if (!allowed.has(watchArgs[index]!)) throw new MercuryError('CLI_ARGUMENT_INVALID', `不支持的参数：${watchArgs[index]}`, { exitCode: 2 });
            if (watchArgs[index] === '--after') index += 1;
          }
          if (!watchArgs.includes('--jsonl')) throw new MercuryError('CLI_ARGUMENT_INVALID', 'task watch 稳定机器模式必须使用 --jsonl。', { exitCode: 2 });
          let sequence = Number.parseInt(value(watchArgs, '--after') ?? '0', 10);
          if (!Number.isSafeInteger(sequence) || sequence < 0) throw new MercuryError('CLI_ARGUMENT_INVALID', '--after 必须是非负整数。', { exitCode: 2 });
          let record = await findTaskReadOnly(context.workspaceRoot, taskId);
          const snapshot = await stableTaskView(context.workspaceRoot, record);
          output(context.io, stableSuccess(command, { task: snapshot, after: sequence }, version));
          for (;;) {
            const events = await stableEventsAfter(context.workspaceRoot, record, sequence);
            for (const event of events) { sequence = event.sequence; output(context.io, event); }
            record = await findTaskReadOnly(context.workspaceRoot, taskId);
            const status = (await stableTaskView(context.workspaceRoot, record)).status;
            if (['needs_input', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)) return 0;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        exactJson(commandArgs.slice(1));
        const record = await findTaskReadOnly(context.workspaceRoot, taskId);
        if (operation === 'status') data = await stableTaskView(context.workspaceRoot, record);
        else if (operation === 'result') data = await stableTaskResult(context.workspaceRoot, record);
        else if (operation === 'cancel') data = await stableCancelTask(context.workspaceRoot, record);
        else throw new MercuryError('CLI_COMMAND_INVALID', `不支持的稳定任务命令：${operation}`, { exitCode: 2 });
      }
    }
    output(context.io, stableSuccess(command, data, version));
    return 0;
  } catch (error) {
    const failed = stableFailure(command, error, version);
    output(context.io, failed.envelope);
    return failed.exitCode;
  }
}

export { STABLE_CLI_CONTRACT, stableErrorFrom, stableFailure, stableSuccess } from './envelope.js';
export { applyConfigMigration, inspectConfigMigration } from './config.js';
