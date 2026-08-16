import type { CliIo } from '../cli.js';
import { MercuryError } from '../errors.js';
import { readProductVersion } from '../version.js';
import { applyConfigMigration, inspectConfigMigration } from './config.js';
import { stableFailure, stableSuccess } from './envelope.js';
import { decodeTaskCursor, findTaskReadOnly, listTasksReadOnly, stableCancelTask, stableEventsAfter, stableTaskResult, stableTaskView, taskCursor } from './tasks.js';

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

export async function tryRunStableCli(args: string[], context: StableCliContext): Promise<number | null> {
  const command = args[0] === 'protocol' && args[1] ? `protocol.${args[1]}`
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
      if (['pause', 'resume', 'retry-plan', 'retry'].includes(operation)) {
        throw new MercuryError('CONTRACT_UNSUPPORTED', `0.3.0-alpha.1 不支持 task ${operation}；能力发现已标记为 Alpha.2。`, { exitCode: 5 });
      }
      if (operation === 'list') {
        exactJson(commandArgs, ['--cursor', '--limit']);
        const rawLimit = value(commandArgs, '--limit') ?? '20';
        const limit = Number.parseInt(rawLimit, 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MercuryError('CLI_ARGUMENT_INVALID', '--limit 必须是 1–100。', { exitCode: 2 });
        const all = await listTasksReadOnly(context.workspaceRoot);
        const cursor = value(commandArgs, '--cursor');
        const start = cursor
          ? (() => {
              const decoded = decodeTaskCursor(cursor);
              const index = all.findIndex((task) => task.created_at === decoded.createdAt && task.task_id === decoded.taskId);
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
