import type { AudioVerification } from '../generated/audio-verification.js';
import type { AdapterExecutionResult } from './result.js';
import type { AudioVerificationAdapterInput } from './types.js';

export interface AudioVerificationAdapter {
  readonly adapterId: 'vertex_gemini_audio_verifier';
  run(
    input: AudioVerificationAdapterInput
  ): Promise<AdapterExecutionResult<AudioVerification>>;
}
