import type { ExchangeErrorV1 } from '../contracts/index.js';
import { MercuryError } from '../errors.js';

export const STABLE_CLI_CONTRACT = 'mercury.cli/v1' as const;

export interface StableCliMeta {
  cli_version: string;
  protocol_versions: ['v1'];
}

export interface StableCliEnvelope<T> {
  contract: typeof STABLE_CLI_CONTRACT;
  command: string;
  ok: boolean;
  data: T | null;
  error: ExchangeErrorV1 | null;
  meta: StableCliMeta;
}

export function stableSuccess<T>(command: string, data: T, version: string): StableCliEnvelope<T> {
  return { contract: STABLE_CLI_CONTRACT, command, ok: true, data, error: null, meta: { cli_version: version, protocol_versions: ['v1'] } };
}

function category(code: string): ExchangeErrorV1['category'] {
  if (/^(?:INPUT|TRANSCRIPT|SRT|VTT|REQUEST_INVALID|CLI_)/u.test(code)) return 'input';
  if (/^(?:MODEL|CONFIG|MIGRATION)/u.test(code)) return 'config';
  if (/^(?:CONTRACT|MACHINE_CONTRACT)/u.test(code)) return 'compatibility';
  if (/^(?:TASK_STATE|REQUEST_ID_CONFLICT|DICTIONARY_CONFLICT)/u.test(code)) return 'conflict';
  if (/^(?:TASK_PATH|WORKSPACE_PATH|SECURITY)/u.test(code)) return 'security';
  if (/^(?:PROVIDER|VOLCENGINE|GEMINI)/u.test(code)) return 'provider';
  return 'runtime';
}

export function stableErrorFrom(error: unknown): { error: ExchangeErrorV1; exitCode: number } {
  const mercury = error instanceof MercuryError
    ? error
    : new MercuryError('UNEXPECTED_ERROR', error instanceof Error ? error.message : String(error));
  const exitCode = mercury.exitCode === 130 ? 130
    : /(?:ARGUMENT|OPTION|INVALID|ROLE_REQUIRED)$/u.test(mercury.code) ? 2
      : /(?:STATE_CONFLICT|_UNSAFE|PLAN_STALE)$/u.test(mercury.code) ? 3
        : /^(?:MODEL_|CONFIG_)/u.test(mercury.code) ? 4
          : /(?:UNSUPPORTED|MIGRATION_REQUIRED|CONTRACT_UNAVAILABLE)$/u.test(mercury.code) ? 5
            : mercury.exitCode;
  return {
    error: {
      contract: 'mercury.error/v1', code: mercury.code, category: category(mercury.code),
      message: mercury.message.replace(/\s*(?:Provider detail|provider detail)=.*$/iu, '').trim(),
      retryability: 'not_applicable', provider_outcome: 'not_applicable',
      remediation: [mercury.remediation ?? '请核对命令、合同版本与本地状态后重试。'],
      technical: null, extensions: {},
    },
    exitCode,
  };
}

export function stableFailure(command: string, error: unknown, version: string): { envelope: StableCliEnvelope<never>; exitCode: number } {
  const stable = stableErrorFrom(error);
  return {
    envelope: { contract: STABLE_CLI_CONTRACT, command, ok: false, data: null, error: stable.error, meta: { cli_version: version, protocol_versions: ['v1'] } },
    exitCode: stable.exitCode,
  };
}
