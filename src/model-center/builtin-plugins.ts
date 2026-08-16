import { OpenAiChatCompletionsCalibrationAdapter } from '../adapters/openai-chat-completions.js';
import { VolcengineAsrAdapter } from '../adapters/volcengine-asr.js';
import { VolcengineSubtitleAsrAdapter } from '../adapters/volcengine-subtitle-asr.js';
import { GeminiAudioVerificationAdapter } from '../adapters/gemini-audio-verification.js';
import type {
  AsrAdapterInput,
  CalibrationAdapterInput,
  ModelSnapshotEntry
} from '../contracts/index.js';
import { AUDIO_VERIFICATION_PROFILE, CHAT_PROOFREADING_PROFILE, VOLCENGINE_TRANSCRIPTION_PROFILE } from './profiles.js';
import type {
  BuiltinModelPlugin,
  ModelPluginRuntimeDependencies,
  PluginModelSnapshotEntry,
  ProofreadingRuntime,
  TranscriptionRuntime,
  AudioVerificationRuntime
} from './types.js';

function legacyEntry(
  entry: PluginModelSnapshotEntry,
  adapter: 'volcengine_asr' | 'volcengine_subtitle_asr' | 'openai_chat_completions'
): ModelSnapshotEntry {
  return { ...structuredClone(entry), adapter } as unknown as ModelSnapshotEntry;
}

function transcriptionRuntime(dependencies: ModelPluginRuntimeDependencies): TranscriptionRuntime {
  if (!dependencies.resolveAsrCredential) {
    throw new Error('Volcengine runtime requires a credential reference resolver.');
  }
  const adapter = new VolcengineAsrAdapter({
    resolveCredential: dependencies.resolveAsrCredential,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {})
  });
  return {
    capability: 'transcription',
    run: (input) => adapter.run({
      ...input,
      model: legacyEntry(input.model, 'volcengine_asr') as AsrAdapterInput['model']
    })
  };
}

function subtitleTranscriptionRuntime(dependencies: ModelPluginRuntimeDependencies): TranscriptionRuntime {
  if (!dependencies.readCredential) {
    throw new Error('Volcengine subtitle runtime requires a credential resolver.');
  }
  const adapter = new VolcengineSubtitleAsrAdapter({
    readCredential: dependencies.readCredential,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {})
  });
  return {
    capability: 'transcription',
    run: (input) => adapter.run({
      ...input,
      model: legacyEntry(input.model, 'volcengine_subtitle_asr') as AsrAdapterInput['model']
    })
  };
}

function proofreadingRuntime(dependencies: ModelPluginRuntimeDependencies): ProofreadingRuntime {
  const adapter = new OpenAiChatCompletionsCalibrationAdapter({
    normalizeSuggestions: true,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.readCredential ? { resolveCredential: dependencies.readCredential } : {}),
    ...(dependencies.captureCalibrationResponseBody
      ? { captureProviderResponseBody: dependencies.captureCalibrationResponseBody }
      : {})
  });
  return {
    capability: 'proofreading',
    run: (input) => adapter.run({
      ...input,
      model: legacyEntry(input.model, 'openai_chat_completions') as CalibrationAdapterInput['model']
    })
  };
}

function audioVerificationRuntime(dependencies: ModelPluginRuntimeDependencies): AudioVerificationRuntime {
  const adapter = new GeminiAudioVerificationAdapter(dependencies);
  return {
    capability: 'audio_verification',
    run: (input) => adapter.run(input)
  };
}

export const builtinModelPlugins: readonly BuiltinModelPlugin[] = [
  {
    pluginId: 'volcengine_asr',
    apiVersion: 1,
    connectionTypes: ['volcengine_cloud'],
    declaredCapabilities: VOLCENGINE_TRANSCRIPTION_PROFILE,
    createTranscriptionRuntime: transcriptionRuntime
  },
  {
    pluginId: 'volcengine_subtitle_asr',
    apiVersion: 1,
    connectionTypes: ['volcengine_subtitle_cloud'],
    declaredCapabilities: VOLCENGINE_TRANSCRIPTION_PROFILE,
    createTranscriptionRuntime: subtitleTranscriptionRuntime
  },
  {
    pluginId: 'openai_chat_completions',
    apiVersion: 1,
    connectionTypes: ['compatible_endpoint'],
    declaredCapabilities: CHAT_PROOFREADING_PROFILE,
    createProofreadingRuntime: proofreadingRuntime
  },
  {
    pluginId: 'gemini',
    apiVersion: 1,
    connectionTypes: ['developer_api', 'vertex_ai'],
    declaredCapabilities: AUDIO_VERIFICATION_PROFILE,
    createAudioVerificationRuntime: audioVerificationRuntime
  }
];
