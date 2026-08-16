import type { TranscriptRaw } from '../generated/transcript-raw.js';
import type { AdapterExecutionResult } from './result.js';
import type { AsrAdapterInput } from './types.js';

export interface AsrAdapter {
  readonly adapterId: 'volcengine_asr' | 'volcengine_subtitle_asr';
  run(input: AsrAdapterInput): Promise<AdapterExecutionResult<TranscriptRaw>>;
}
