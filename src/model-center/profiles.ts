import type { ModelRole } from '../contracts/index.js';
import type { ModelCapabilityProfile, ModelTaskCapability } from './types.js';

export const VOLCENGINE_TRANSCRIPTION_PROFILE: ModelCapabilityProfile = {
  task_capabilities: ['transcription'],
  input_modalities: ['audio'],
  output_types: ['timed_transcript'],
  structured_output: true
};

export const CHAT_PROOFREADING_PROFILE: ModelCapabilityProfile = {
  task_capabilities: ['proofreading'],
  input_modalities: ['text'],
  output_types: ['structured_result'],
  structured_output: true
};

export const AUDIO_VERIFICATION_PROFILE: ModelCapabilityProfile = {
  task_capabilities: ['audio_verification'],
  input_modalities: ['text', 'audio'],
  output_types: ['structured_result'],
  structured_output: true
};

export function requiredCapability(role: ModelRole): {
  capability: ModelTaskCapability;
  profile: ModelCapabilityProfile;
} {
  if (role === 'asr') return { capability: 'transcription', profile: VOLCENGINE_TRANSCRIPTION_PROFILE };
  if (role === 'calibration') return { capability: 'proofreading', profile: CHAT_PROOFREADING_PROFILE };
  return { capability: 'audio_verification', profile: AUDIO_VERIFICATION_PROFILE };
}

export function capabilityProfileForPlugin(pluginId: string): ModelCapabilityProfile | null {
  if (pluginId === 'volcengine_asr' || pluginId === 'volcengine_subtitle_asr') return structuredClone(VOLCENGINE_TRANSCRIPTION_PROFILE);
  if (pluginId === 'openai_chat_completions') return structuredClone(CHAT_PROOFREADING_PROFILE);
  if (pluginId === 'gemini') return structuredClone(AUDIO_VERIFICATION_PROFILE);
  return null;
}

export function profileSatisfies(actual: ModelCapabilityProfile, required: ModelCapabilityProfile): boolean {
  return required.task_capabilities.every((value) => actual.task_capabilities.includes(value))
    && required.input_modalities.every((value) => actual.input_modalities.includes(value))
    && required.output_types.every((value) => actual.output_types.includes(value))
    && (!required.structured_output || actual.structured_output);
}
