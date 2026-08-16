import type { CalibrationResult } from '../generated/calibration-result.js';
import type { ModelSnapshotEntry } from '../generated/model-snapshot.js';
import type { TranscriptRaw } from '../generated/transcript-raw.js';
import type { AsrHintsDispatchEvidence, AsrHintsInput } from './asr.js';

export interface AdapterAudioInput {
  sourcePath: string;
  pathRef: string;
  sha256: string;
  durationMs: number;
  mimeType: 'audio/mpeg';
  language: 'zh-CN';
}

export interface ReferenceSrtInput {
  pathRef: 'input/reference.srt';
  text: string;
}

export interface AsrAdapterInput {
  taskId: string;
  modelSnapshotRef: string;
  model: ModelSnapshotEntry & { role: 'asr'; adapter: 'volcengine_asr' };
  audio: AdapterAudioInput;
  asrHints?: AsrHintsInput;
  beforeProviderDispatch?: (
    operation: 'volcengine_asr_recognize' | 'volcengine_subtitle_submit' | 'volcengine_subtitle_query',
    evidence?: { asrHints?: AsrHintsDispatchEvidence },
  ) => Promise<void>;
}

export interface CalibrationAdapterInput {
  taskId: string;
  modelSnapshotRef: string;
  model: ModelSnapshotEntry & {
    role: 'calibration';
    adapter: 'openai_chat_completions';
  };
  transcript: TranscriptRaw;
  referenceSrt: ReferenceSrtInput | null;
  mode: 'text-only' | 'text-and-segmentation' | null;
}

export interface AudioVerificationAdapterInput {
  taskId: string;
  modelSnapshotRef: string;
  model: ModelSnapshotEntry & {
    role: 'audio_verification';
    adapter: 'vertex_gemini_audio_verifier';
  };
  audio: AdapterAudioInput;
  transcript: TranscriptRaw;
  calibrationResult: CalibrationResult & { status: 'completed' };
  referenceSrt: ReferenceSrtInput | null;
}
