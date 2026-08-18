import type { ExchangeErrorV1 } from '../contracts/index.js';
import { MercuryError } from '../errors.js';
import { sensitiveTextIssues } from '../contracts/validation/security.js';

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
  if (/^UPDATE_(?:REDIRECT_UNSAFE|NPM_UNTRUSTED)$/u.test(code)) return 'security';
  if (/^UPDATE_(?:REGISTRY_INVALID|REDIRECT_LIMIT|REGISTRY_TOO_LARGE)$/u.test(code)) return 'compatibility';
  if (/^UPDATE_(?:CONFIRMATION_REQUIRED|TARGET_REQUIRED|VERSION_NOT_FOUND|CHANNEL_OLDER)$/u.test(code)) return 'input';
  if (/^UPDATE_(?:NODE_INCOMPATIBLE|INSTALLATION_NOT_WRITABLE|NPM_UNAVAILABLE)$/u.test(code)) return 'config';
  if (/^DELIVERY_PATH_UNSAFE$/u.test(code)) return 'security';
  if (/^(?:DELIVERY_CONFLICT|DELIVERY_NOT_READY|REVIEW_NOT_READY)$/u.test(code)) return 'conflict';
  if (/^(?:DELIVERY_DIRECTORY_INVALID|DELIVERY_DIRECTORY_NOT_WRITABLE|DELIVERY_NOT_REQUESTED)$/u.test(code)) return 'input';
  if (/^(?:INPUT|TRANSCRIPT|SRT|VTT|REQUEST_INVALID|CLI_|DICTIONARY_IMPORT_INVALID)/u.test(code)) return 'input';
  if (/^(?:MODEL|CONFIG|MIGRATION)/u.test(code)) return 'config';
  if (/^(?:CONTRACT|MACHINE_CONTRACT)/u.test(code)) return 'compatibility';
  if (/^(?:TASK_(?:STATE|PAUSE|RESUME|RETRY|CANCEL)|RETRY_|REQUEST_ID_CONFLICT|DICTIONARY_(?:CONFLICT|REVISION_CONFLICT|ENTRY_CONFLICT|SCOPE_MISMATCH))/u.test(code)) return 'conflict';
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
      message: (() => {
        const message = mercury.message.replace(/\s*(?:Provider detail|provider detail)=.*$/iu, '').trim();
        return sensitiveTextIssues(message).length > 0 ? '操作失败，原始错误包含敏感信息，已脱敏。' : message;
      })(),
      retryability: mercury.code === 'RETRY_UNSAFE_PROVIDER_OUTCOME' ? 'unsafe'
        : /^(?:UPDATE_CHECK_OFFLINE|UPDATE_CHECK_TIMEOUT|UPDATE_REGISTRY_UNAVAILABLE)$/u.test(mercury.code) ? 'safe'
        : /^(?:UPDATE_CONFIRMATION_REQUIRED|UPDATE_NODE_INCOMPATIBLE|UPDATE_INSTALLATION_NOT_WRITABLE|UPDATE_NPM_UNAVAILABLE|UPDATE_INSTALL_FAILED|UPDATE_VERIFY_FAILED)$/u.test(mercury.code) ? 'after_user_action'
        : /^(?:DELIVERY_|REVIEW_NOT_READY|TASK_RESUME_UNSAFE|RETRY_)/u.test(mercury.code) ? 'after_user_action' : 'not_applicable',
      provider_outcome: mercury.code === 'RETRY_UNSAFE_PROVIDER_OUTCOME' ? 'outcome_unknown' : 'not_applicable',
      remediation: [mercury.remediation ?? (mercury.code === 'RETRY_UNSAFE_PROVIDER_OUTCOME'
        ? '不要重放当前 attempt；如用户明确接受可能重复计费，请使用新的逻辑 request ID 创建新任务。'
        : '请核对命令、合同版本与本地状态后重试。')],
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
