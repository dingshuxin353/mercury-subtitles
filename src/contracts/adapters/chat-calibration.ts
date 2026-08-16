import type { CalibrationResult } from '../generated/calibration-result.js';
import type { AdapterExecutionResult } from './result.js';
import type { CalibrationAdapterInput } from './types.js';

export interface CalibrationAdapter {
  readonly adapterId: 'openai_chat_completions';
  run(input: CalibrationAdapterInput): Promise<AdapterExecutionResult<CalibrationResult>>;
}
