import type { CliIo } from '../cli.js';
import path from 'node:path';
import { MercuryError } from '../errors.js';
import { readProductVersion } from '../version.js';
import { applyConfigMigration, inspectConfigMigration } from './config.js';
import { stableFailure, stableSuccess } from './envelope.js';
import { createdAtOf, decodeTaskCursor, findTaskReadOnly, listTasksReadOnly, stableCancelTask, stableDeliverTask, stableEventsAfter, stablePauseTask, stableResumeTask, stableRetryPlan, stableRetryTask, stableTaskResult, stableTaskView, taskCursor, taskIdOf } from './tasks.js';
import { readStableJson, writeStableJsonAtomic } from '../exchange/storage.js';
import { projectV5Task, submitExchangeRequest } from '../exchange/runtime.js';
import { startDetachedWorker, workerStatus } from '../background/worker.js';
import { inspectTranscriptInput, type TranscriptInputFormat, type TranscriptInputRole } from '../external-input.js';
import { assertExchangeContract, type ExchangeRequestV1 } from '../contracts/index.js';
import { runDictionaryCommand } from './dictionary.js';
import { loadModelRegistryV2 } from '../models-v2.js';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readMp3DurationMsFromBytes } from '../models.js';
import { listJobsIsolated } from '../background/storage.js';
import { acceptAllV5ReviewChanges, decideV5ReviewChange, finalizeV5Review, readVerifiedV5Review } from '../review-v5.js';
import type { ReviewActor } from '../review.js';

export interface StableCliContext {
  workspaceRoot: string;
  io: CliIo;
  startDetachedWorker?: typeof startDetachedWorker;
}

function output(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

async function stableConfigStatus(workspaceRoot: string): Promise<Record<string, unknown>> {
  const migration = await inspectConfigMigration(workspaceRoot);
  if (migration.state !== 'current') return migration as unknown as Record<string, unknown>;
  const registry = await loadModelRegistryV2(workspaceRoot);
  return {
    ...migration,
    defaults: { ...registry.defaults },
    models: registry.models.map((model) => ({
      model_id: model.model_id, name: model.name, category: model.category, provider: model.plugin_id,
      enabled: model.enabled, check: model.check?.outcome ?? 'not_checked',
      ready: model.enabled && model.check?.outcome === 'passed' && model.cloud_data_confirmation.confirmed,
    })),
  };
}

async function wakeStableWorker(workspaceRoot: string, queued: boolean, fallback: string, starter: typeof startDetachedWorker = startDetachedWorker): Promise<{ started: boolean; pid: number | null; problem: string | null }> {
  if (!queued) return { started: false, pid: null, problem: null };
  const existing = await workerStatus(workspaceRoot);
  if (existing.running) return { started: false, pid: existing.worker?.pid ?? null, problem: null };
  try {
    const started = await starter(workspaceRoot);
    return { started: true, pid: started.pid, problem: null };
  } catch (error) {
    return { started: false, pid: null, problem: error instanceof MercuryError ? error.message : fallback };
  }
}

function value(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const found = args[index + 1];
  if (!found || found.startsWith('--')) throw new MercuryError('CLI_OPTION_VALUE_MISSING', `${option} 缺少参数值。`, { exitCode: 2 });
  return found;
}

function exactJson(args: string[], allowedValues: string[] = [], allowedFlags: string[] = []): void {
  const allowed = new Set(['--json', ...allowedValues, ...allowedFlags]);
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index]!;
    if (!allowed.has(entry)) throw new MercuryError('CLI_ARGUMENT_INVALID', `不支持的参数：${entry}`, { exitCode: 2 });
    if (allowedValues.includes(entry)) index += 1;
  }
  if (!args.includes('--json')) throw new MercuryError('CLI_ARGUMENT_INVALID', '稳定机器命令必须使用 --json。', { exitCode: 2 });
}

export async function tryRunStableCli(args: string[], context: StableCliContext): Promise<number | null> {
  const command = args[0] === 'protocol' && args[1] ? `protocol.${args[1]}`
    : args[0] === 'input' && args[1] === 'inspect' ? 'input.inspect'
    : args[0] === 'dictionary' && args[1] ? `dictionary.${args[1]}`
    : args[0] === 'config' && args[1] === 'status' ? 'config.status'
      : args[0] === 'config' && args[1] === 'migrate' ? 'config.migrate'
        : args[0] === 'worker' && ['status', 'start'].includes(args[1] ?? '') && args.includes('--json') ? `worker.${args[1]}`
        : args[0] === 'review' && ['status', 'list', 'decide', 'accept-all', 'finalize'].includes(args[1] ?? '') && args.includes('--json') ? `review.${args[1]}`
        : args[0] === 'task' && args[1] && (args.includes('--json') || args.includes('--jsonl')) ? `task.${args[1]}`
        : null;
  if (!command) return null;
  const version = await readProductVersion();
  try {
    let data: unknown;
    if (args[0] === 'protocol') {
      exactJson(args.slice(2));
      if (args[1] === 'version') data = { protocol: 'v1', contracts: ['mercury.exchange.request/v1', 'mercury.task/v1', 'mercury.event/v1', 'mercury.result/v1', 'mercury.error/v1', 'mercury.transcript/v1', 'mercury.dictionary/v1', 'mercury.retry-plan/v1'] };
      else if (args[1] === 'capabilities') data = {
        alpha: '0.3.0-alpha.2',
        commands: {
          protocol: true, config_migration: true, external_srt: true, external_vtt: true, external_transcript_json: true,
          dictionary: true, approved_srt_delivery: true, worker_start: true, review: true,
          dictionary_skill_management: false, pause: true, resume: true, retry: true, venus_adapter: false,
        },
        task_control: { cancel: true, pause: { supported: true, checkpoint_version: 'mercury.safe-checkpoint/v1' }, resume: { supported: true, same_attempt: true }, retry: { supported: true, plan_contract: 'mercury.retry-plan/v1', append_only_attempts: true } },
        machine_contract: 'mercury.cli/v1', input_formats: ['srt', 'vtt', 'transcript_json'], query_commands_are_read_only: true,
      };
      else throw new MercuryError('CLI_COMMAND_INVALID', `不支持的协议命令：${args[1]}`, { exitCode: 2 });
    } else if (args[0] === 'worker') {
      exactJson(args.slice(2));
      if (args[1] === 'status') {
        const status = await workerStatus(context.workspaceRoot);
        data = {
          running: status.running,
          stale: status.stale,
          state: status.worker?.state ?? 'stopped',
          task_id: status.worker?.task_id ?? null,
          heartbeat_at: status.worker?.heartbeat_at ?? null,
          diagnostic_count: status.worker?.diagnostic_count ?? 0,
        };
      } else {
        const scan = await listJobsIsolated(context.workspaceRoot);
        const queued = scan.jobs.some((job) => job.state === 'queued');
        const worker = await wakeStableWorker(context.workspaceRoot, queued, 'Worker 启动失败；排队任务保持不变，不会同步调用 Provider。', context.startDetachedWorker);
        data = { queued, running: worker.started || worker.pid !== null, ...worker, diagnostic_count: scan.invalid.length };
      }
    } else if (args[0] === 'review') {
      const operation = args[1]!;
      const reviewArgs = args.slice(2);
      const taskId = reviewArgs[0];
      if (!taskId || taskId.startsWith('--')) throw new MercuryError('TASK_ID_REQUIRED', `review ${operation} 必须提供 task ID。`, { exitCode: 2 });
      if (operation === 'list') exactJson(reviewArgs.slice(1), ['--after', '--limit']);
      else if (operation === 'decide') exactJson(reviewArgs.slice(1), ['--change', '--text', '--actor'], ['--accept', '--reject']);
      else if (operation === 'accept-all') exactJson(reviewArgs.slice(1), ['--confirm-count', '--actor']);
      else exactJson(reviewArgs.slice(1));
      const record = await findTaskReadOnly(context.workspaceRoot, taskId);
      if (!('identity' in record)) throw new MercuryError('CONTRACT_UNSUPPORTED', '此历史任务不支持稳定人工审阅命令。', { exitCode: 5 });
      const directory = path.join(context.workspaceRoot, 'tasks', record.identity.task_directory);
      const actorText = value(reviewArgs, '--actor');
      if (actorText && !['cli', 'skill'].includes(actorText)) throw new MercuryError('CLI_ARGUMENT_INVALID', '--actor 只能是 cli 或 skill。', { exitCode: 2 });
      const actor: ReviewActor = actorText === 'skill' ? 'user_via_skill' : 'user_via_cli';
      if (operation === 'status') {
        const review = await readVerifiedV5Review(directory);
        data = { task_id: taskId, status: review.status, counts: review.counts, next_change_id: review.changes.find((item) => item.decision === 'pending')?.change_id ?? null, approved_artifact: review.approved_artifact ? { ...review.approved_artifact, absolute_path: path.join(directory, review.approved_artifact.path) } : null };
      } else if (operation === 'list') {
        const review = await readVerifiedV5Review(directory);
        const after = value(reviewArgs, '--after');
        const start = after ? review.changes.findIndex((item) => item.change_id === after) + 1 : 0;
        if (after && start === 0) throw new MercuryError('REVIEW_CHANGE_NOT_FOUND', '审阅游标不存在。', { exitCode: 2 });
        const limit = Number.parseInt(value(reviewArgs, '--limit') ?? '10', 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MercuryError('CLI_ARGUMENT_INVALID', '--limit 必须是 1–50。', { exitCode: 2 });
        const changes = review.changes.slice(start, start + limit);
        data = { task_id: taskId, status: review.status, counts: review.counts, changes, next_after: start + changes.length < review.changes.length ? changes.at(-1)?.change_id ?? null : null };
      } else if (operation === 'decide') {
        const change = value(reviewArgs, '--change');
        if (!change) throw new MercuryError('REVIEW_CHANGE_REQUIRED', 'review decide 必须提供 --change。', { exitCode: 2 });
        const editedText = value(reviewArgs, '--text');
        const selected = [reviewArgs.includes('--accept'), reviewArgs.includes('--reject'), editedText !== undefined].filter(Boolean).length;
        if (selected !== 1) throw new MercuryError('CLI_ARGUMENT_INVALID', '必须且只能选择 --accept、--reject 或 --text。', { exitCode: 2 });
        const review = await decideV5ReviewChange(directory, {
          changeId: change,
          decision: reviewArgs.includes('--accept') ? 'accepted' : reviewArgs.includes('--reject') ? 'rejected' : 'edited',
          ...(editedText !== undefined ? { text: editedText } : {}), actor,
        });
        data = { task_id: taskId, status: review.status, counts: review.counts, change: review.changes.find((item) => item.change_id === change) };
      } else if (operation === 'accept-all') {
        const rawCount = value(reviewArgs, '--confirm-count');
        const confirmCount = Number.parseInt(rawCount ?? '', 10);
        if (!rawCount || !Number.isSafeInteger(confirmCount) || confirmCount < 0) throw new MercuryError('CLI_ARGUMENT_INVALID', '--confirm-count 必须是非负整数。', { exitCode: 2 });
        const review = await acceptAllV5ReviewChanges(directory, { confirmCount, actor });
        data = { task_id: taskId, status: review.status, counts: review.counts };
      } else {
        const review = await finalizeV5Review(directory);
        data = { task_id: taskId, status: review.status, counts: review.counts, approved_artifact: review.approved_artifact ? { ...review.approved_artifact, absolute_path: path.join(directory, review.approved_artifact.path) } : null };
      }
    } else if (args[0] === 'dictionary') {
      if (!args.includes('--json')) throw new MercuryError('CLI_ARGUMENT_INVALID', '稳定词典命令必须使用 --json。', { exitCode: 2 });
      data = await runDictionaryCommand(context.workspaceRoot, args.slice(1));
    } else if (args[0] === 'input') {
      const inspectArgs = args.slice(2);
      exactJson(inspectArgs, ['--file', '--format', '--role']);
      const file = value(inspectArgs, '--file');
      const formatText = value(inspectArgs, '--format');
      const roleText = value(inspectArgs, '--role');
      if (!file) throw new MercuryError('CLI_OPTION_VALUE_MISSING', '--file 缺少绝对输入路径。', { exitCode: 2 });
      if (!formatText || !['auto', 'srt', 'vtt', 'transcript-json', 'mp3'].includes(formatText)) {
        throw new MercuryError('CLI_ARGUMENT_INVALID', '--format 必须是 auto、mp3、srt、vtt 或 transcript-json。', { exitCode: 2 });
      }
      if (!roleText) throw new MercuryError('TRANSCRIPT_ROLE_REQUIRED', '--role 必须显式选择 media、transcript-source 或 reference。', { exitCode: 2 });
      if (!['media', 'transcript-source', 'reference'].includes(roleText)) {
        throw new MercuryError('TRANSCRIPT_ROLE_REQUIRED', '--role 必须显式选择 media、transcript-source 或 reference。', { exitCode: 2 });
      }
      if (roleText === 'media') {
        if (formatText !== 'mp3' && formatText !== 'auto') throw new MercuryError('CLI_ARGUMENT_INVALID', 'media 输入当前只支持 --format mp3 或 auto。', { exitCode: 2 });
        if (!path.isAbsolute(file)) throw new MercuryError('CLI_ARGUMENT_INVALID', '--file 必须使用绝对路径。', { exitCode: 2 });
        const entry = await lstat(file).catch(() => null);
        if (!entry?.isFile() || entry.isSymbolicLink()) throw new MercuryError('MEDIA_INPUT_INVALID', '媒体输入必须是普通 MP3 文件。', { exitCode: 2 });
        const handle = await open(file, constants.O_RDONLY);
        let bytes: Buffer;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
            throw new MercuryError('MEDIA_INPUT_INVALID', '媒体输入在检查期间发生变化；请重新检查后再创建 request。', { exitCode: 2 });
          }
          bytes = await handle.readFile();
          if (bytes.length !== opened.size) throw new MercuryError('MEDIA_INPUT_INVALID', '媒体输入在检查期间发生变化；请重新检查后再创建 request。', { exitCode: 2 });
        } finally {
          await handle.close();
        }
        data = { path: file, format: 'mp3', role: 'media', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), duration_ms: readMp3DurationMsFromBytes(bytes), mime_type: 'audio/mpeg', warnings: [], valid: true };
      } else {
        if (formatText === 'mp3') throw new MercuryError('CLI_ARGUMENT_INVALID', '字幕角色不能使用 mp3 格式。', { exitCode: 2 });
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
      }
    } else if (args[0] === 'config' && args[1] === 'status') {
      exactJson(args.slice(2));
      data = await stableConfigStatus(context.workspaceRoot);
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
        const rawRequest = await readStableJson(requestPath, 'REQUEST_INVALID');
        if (rawRequest && typeof rawRequest === 'object') {
          const transcript = (rawRequest as { inputs?: { transcript?: unknown } }).inputs?.transcript;
          if (transcript && typeof transcript === 'object' && !('role' in transcript)) {
            throw new MercuryError('TRANSCRIPT_ROLE_REQUIRED', '机器请求必须显式声明 transcript_source 或 reference；Mercury 不会猜测用途。', { exitCode: 2 });
          }
        }
        const request = assertExchangeContract('request', rawRequest);
        const submitted = await submitExchangeRequest(context.workspaceRoot, request);
        const status = submitted.task.status;
        const worker = await wakeStableWorker(context.workspaceRoot, status === 'queued', 'Worker 启动失败；任务仍安全保留在队列。', context.startDetachedWorker);
        const stableTask = await projectV5Task(path.join(context.workspaceRoot, 'tasks', submitted.task.identity.task_directory), submitted.task);
        data = { task: stableTask, request_id: request.request_id, replayed: submitted.replayed, worker };
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
            if (['paused', 'needs_input', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)) return 0;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        if (operation === 'retry') exactJson(commandArgs.slice(1), ['--plan']);
        else exactJson(commandArgs.slice(1));
        const record = await findTaskReadOnly(context.workspaceRoot, taskId);
        if (operation === 'status') data = await stableTaskView(context.workspaceRoot, record);
        else if (operation === 'result') data = await stableTaskResult(context.workspaceRoot, record);
        else if (operation === 'pause') data = await stablePauseTask(context.workspaceRoot, record);
        else if (operation === 'resume') {
          const resumed = await stableResumeTask(context.workspaceRoot, record);
          const worker = await wakeStableWorker(context.workspaceRoot, resumed.task.status === 'queued', 'Worker 启动失败；任务仍安全保留在队列。', context.startDetachedWorker);
          data = { ...resumed, worker };
        }
        else if (operation === 'retry-plan') data = await stableRetryPlan(context.workspaceRoot, record);
        else if (operation === 'retry') {
          const planId = value(commandArgs.slice(1), '--plan');
          if (!planId) throw new MercuryError('CLI_OPTION_VALUE_MISSING', 'task retry 必须提供 --plan <plan_id>。', { exitCode: 2 });
          const retried = await stableRetryTask(context.workspaceRoot, record, planId);
          const worker = await wakeStableWorker(context.workspaceRoot, retried.task.status === 'queued', 'Worker 启动失败；新 attempt 仍安全保留在队列。', context.startDetachedWorker);
          data = { ...retried, plan_id: planId, worker };
        }
        else if (operation === 'cancel') data = await stableCancelTask(context.workspaceRoot, record);
        else if (operation === 'deliver') data = await stableDeliverTask(context.workspaceRoot, record);
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
