import type { TranscriptRaw } from '../generated/transcript-raw.js';
import type { AdapterExecutionResult } from './result.js';
import type { AsrAdapterInput } from './types.js';

export interface AsrHintEntry {
  entryId: string;
  canonical: string;
  variants: string[];
  language: string;
  caseSensitive: boolean;
  numberSensitive: boolean;
}

export interface AsrHintsInput {
  entries: AsrHintEntry[];
}

export interface AsrHintsEvidence {
  status: 'pending' | 'not_applicable' | 'not_supported' | 'used';
  adapter_id: string | null;
  entry_ids: string[];
  available_count: number;
  input_count: number;
  truncated: boolean;
  input_hash: string | null;
  reason: string | null;
}

/**
 * Adapter 在已经把 hints 写入即将发送的真实 Provider 请求后，才可在
 * beforeProviderDispatch 边界提交此证据。仅收到 AsrHintsInput 不代表 used。
 */
export interface AsrHintsDispatchEvidence {
  status: 'used';
  entryIds: string[];
  inputHash: string;
}

export interface AsrAdapter {
  readonly adapterId: string;
  run(input: AsrAdapterInput): Promise<AdapterExecutionResult<TranscriptRaw>>;
}

export interface AsrHintsCapableAdapter extends AsrAdapter {
  readonly asrHintsCapability:
    | { status: 'not_supported'; reason: string }
    | { status: 'supported'; maxEntries: number; acceptedFields: readonly ['canonical', 'variants'] };
  run(input: AsrAdapterInput & { asrHints: AsrHintsInput }): Promise<AdapterExecutionResult<TranscriptRaw>>;
}
