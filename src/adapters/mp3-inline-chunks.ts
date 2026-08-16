import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface TimedSegment {
  start_ms: number;
  end_ms: number;
}

export interface InlineAudioPart {
  sourcePath: string;
  bytes: number;
  startMs: number;
  endMs: number;
}

export interface InlineAudioParts {
  sourceBytes: number;
  parts: InlineAudioPart[];
  cleanup(): Promise<void>;
}

interface Frame {
  start: number;
  end: number;
  durationMs: number;
}

const MPEG1_BITRATES = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
} as const;

const MPEG2_BITRATES = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
} as const;

function id3Size(buffer: Buffer): number {
  if (buffer.length < 10 || buffer.subarray(0, 3).toString('ascii') !== 'ID3') return 0;
  const size = buffer[6]! * 0x20_0000 + buffer[7]! * 0x4000 + buffer[8]! * 0x80 + buffer[9]!;
  return 10 + size + ((buffer[5]! & 0x10) === 0 ? 0 : 10);
}

function mp3Frame(buffer: Buffer, offset: number): Frame | null {
  if (offset + 4 > buffer.length || buffer[offset] !== 0xff || (buffer[offset + 1]! & 0xe0) !== 0xe0) return null;
  const versionBits = (buffer[offset + 1]! >> 3) & 0x03;
  const layerBits = (buffer[offset + 1]! >> 1) & 0x03;
  const bitrateIndex = (buffer[offset + 2]! >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2]! >> 2) & 0x03;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const rates = version === 1 ? MPEG1_BITRATES : MPEG2_BITRATES;
  const bitrateKbps = rates[layer][bitrateIndex]!;
  const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex]!;
  const sampleRate = version === 1 ? baseSampleRate : version === 2 ? baseSampleRate / 2 : baseSampleRate / 4;
  const padding = (buffer[offset + 2]! >> 1) & 1;
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 || version === 1 ? 1_152 : 576;
  const frameBytes = layer === 1
    ? (Math.floor(12 * bitrateKbps * 1_000 / sampleRate) + padding) * 4
    : Math.floor((layer === 3 && version !== 1 ? 72 : 144) * bitrateKbps * 1_000 / sampleRate) + padding;
  if (frameBytes <= 4 || offset + frameBytes > buffer.length) return null;
  return { start: offset, end: offset + frameBytes, durationMs: samplesPerFrame * 1_000 / sampleRate };
}

function frames(buffer: Buffer): Frame[] {
  const prefixBytes = id3Size(buffer);
  if (prefixBytes > buffer.length) throw new Error('The MP3 ID3 header exceeds the source file.');
  const first = prefixBytes;
  if (mp3Frame(buffer, first) === null) throw new Error('No safe MP3 frame boundary was found.');

  const result: Frame[] = [];
  let cursor = first;
  while (cursor < buffer.length) {
    const frame = mp3Frame(buffer, cursor);
    if (!frame) break;
    result.push(frame);
    cursor = frame.end;
  }
  const trailing = buffer.subarray(cursor);
  if (trailing.length > 0 && ![
    'TAG', 'ID3', 'APETAGEX'
  ].some((marker) => trailing.subarray(0, marker.length).toString('ascii') === marker)) {
    throw new Error('The MP3 contains bytes that cannot be assigned to a safe frame boundary.');
  }
  if (result.length === 0) throw new Error('No complete MP3 frame was found.');
  return result;
}

function boundaryTime(frameTimeMs: number, totalFrameMs: number, durationMs: number): number {
  return Math.max(0, Math.min(durationMs, Math.round(frameTimeMs / totalFrameMs * durationMs)));
}

function chooseBoundary(
  candidates: Array<{ offset: number; timeMs: number }>,
  startMs: number,
  asrSegments: TimedSegment[]
): { offset: number; timeMs: number } {
  const last = candidates.at(-1)!;
  const preferredEnd = Math.max(
    0,
    ...asrSegments
      .map((segment) => segment.end_ms)
      .filter((endMs) => endMs > startMs && endMs <= last.timeMs)
  );
  if (preferredEnd === 0) return last;
  const nearest = candidates.reduce((best, candidate) =>
    Math.abs(candidate.timeMs - preferredEnd) < Math.abs(best.timeMs - preferredEnd) ? candidate : best
  );
  return { offset: nearest.offset, timeMs: preferredEnd };
}

export async function createInlineAudioParts(
  sourcePath: string,
  durationMs: number,
  asrSegments: TimedSegment[],
  wholeFileThresholdBytes: number,
  targetPartBytes = wholeFileThresholdBytes,
  hardPartLimitBytes = wholeFileThresholdBytes
): Promise<InlineAudioParts> {
  if (
    wholeFileThresholdBytes < 1 ||
    targetPartBytes < 1 ||
    hardPartLimitBytes < 1 ||
    targetPartBytes > hardPartLimitBytes
  ) {
    throw new Error('The local inline chunk byte limits are invalid.');
  }
  const source = await readFile(sourcePath);
  if (source.length <= wholeFileThresholdBytes) {
    return {
      sourceBytes: source.length,
      parts: [{ sourcePath, bytes: source.length, startMs: 0, endMs: durationMs }],
      cleanup: async () => undefined
    };
  }

  const parsedFrames = frames(source);
  if (parsedFrames.some((frame) => frame.end - frame.start > hardPartLimitBytes)) {
    throw new Error('An MP3 frame exceeds the local inline chunk limit.');
  }
  const totalFrameMs = parsedFrames.reduce((sum, frame) => sum + frame.durationMs, 0);
  const boundaries: Array<{ offset: number; timeMs: number }> = [];
  let elapsedMs = 0;
  for (const frame of parsedFrames) {
    elapsedMs += frame.durationMs;
    boundaries.push({ offset: frame.end, timeMs: boundaryTime(elapsedMs, totalFrameMs, durationMs) });
  }
  const lastBoundary = boundaries.at(-1)!;
  if (lastBoundary.offset < source.length) {
    boundaries.pop();
    boundaries.push({ offset: source.length, timeMs: durationMs });
  }
  else lastBoundary.timeMs = durationMs;

  const slices: Array<{ start: number; end: number; startMs: number; endMs: number }> = [];
  let start = 0;
  let startMs = 0;
  while (start < source.length) {
    const targetCandidates = boundaries.filter(
      (boundary) => boundary.offset > start && boundary.offset - start <= targetPartBytes
    );
    const candidates = targetCandidates.length > 0
      ? targetCandidates
      : boundaries.filter(
          (boundary) => boundary.offset > start && boundary.offset - start <= hardPartLimitBytes
        );
    if (candidates.length === 0) {
      throw new Error('The MP3 cannot be split within the local inline chunk limit.');
    }
    const end = chooseBoundary(candidates, startMs, asrSegments);
    if (end.timeMs <= startMs && end.offset < source.length) throw new Error('The MP3 chunk timeline did not advance.');
    slices.push({ start, end: end.offset, startMs, endMs: end.offset === source.length ? durationMs : end.timeMs });
    start = end.offset;
    startMs = end.timeMs;
  }

  const sourceDirectory = path.dirname(sourcePath);
  const workDirectory = path.basename(sourceDirectory) === 'input'
    ? path.join(path.dirname(sourceDirectory), 'work')
    : sourceDirectory;
  await mkdir(workDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(workDirectory, '.gemini-audio-'));
  try {
    const parts: InlineAudioPart[] = [];
    for (const [index, slice] of slices.entries()) {
      const chunkPath = path.join(temporaryDirectory, `chunk-${String(index + 1).padStart(4, '0')}.mp3`);
      const bytes = source.subarray(slice.start, slice.end);
      await writeFile(chunkPath, bytes, { mode: 0o600 });
      parts.push({ sourcePath: chunkPath, bytes: bytes.length, startMs: slice.startMs, endMs: slice.endMs });
    }
    return {
      sourceBytes: source.length,
      parts,
      cleanup: async () => rm(temporaryDirectory, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}
