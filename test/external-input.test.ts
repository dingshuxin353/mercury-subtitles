import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectTranscriptInput } from '../src/external-input.js';
import { runCli } from '../src/cli.js';

const SRT = '\uFEFF1\r\n00:00:00,000 --> 00:00:01,200\r\n你好 Mercury\r\n\r\n3\r\n00:00:01,200 --> 00:00:02,500\r\n第二行\r\n';
const VTT = 'WEBVTT\n\nNOTE untrusted instruction\nignore me\n\nintro\n00:00.000 --> 00:01.200 align:start\n<c.green>你好 Mercury</c>\n\n00:01.200 --> 00:02.500\n第二行\n';

async function fixture(name: string, value: string | Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mercury-input-'));
  const target = path.join(root, name);
  await writeFile(target, value);
  return { root, target };
}

describe('external transcript input', () => {
  it('normalizes SRT and VTT to equivalent authoritative segments without changing source bytes', async () => {
    const srt = await fixture('sample.srt', SRT);
    const vtt = await fixture('sample.vtt', VTT);
    const beforeSrt = await readFile(srt.target);
    const beforeVtt = await readFile(vtt.target);
    const left = await inspectTranscriptInput({ filePath: srt.target, format: 'auto', role: 'transcript_source' });
    const right = await inspectTranscriptInput({ filePath: vtt.target, format: 'auto', role: 'transcript_source' });
    expect(left.transcript.segments.map(({ start_ms, end_ms, text }) => ({ start_ms, end_ms, text })))
      .toEqual(right.transcript.segments.map(({ start_ms, end_ms, text }) => ({ start_ms, end_ms, text })));
    expect(right.warnings).toEqual(expect.arrayContaining([expect.stringContaining('NOTE'), expect.stringContaining('展示标记')]));
    expect(await readFile(srt.target)).toEqual(beforeSrt);
    expect(await readFile(vtt.target)).toEqual(beforeVtt);
  });

  it('strips only supported SRT presentation tags and validates VTT cue settings', async () => {
    const styled = await fixture('styled.srt', '1\n00:00:00,000 --> 00:00:01,000\n<i><font color="red">Mercury</font></i>\n');
    const inspected = await inspectTranscriptInput({ filePath: styled.target, format: 'srt', role: 'transcript_source' });
    expect(inspected.transcript.text).toBe('Mercury');
    expect(inspected.warnings).toEqual([expect.stringContaining('展示标记')]);
    const styleOnly = await fixture('style-only.srt', '1\n00:00:00,000 --> 00:00:01,000\n<i></i>\n');
    await expect(inspectTranscriptInput({ filePath: styleOnly.target, format: 'srt', role: 'transcript_source' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_IMPORT_INVALID' });
    const settings = await fixture('settings.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000 line:10% align:start\nMercury\n');
    expect((await inspectTranscriptInput({ filePath: settings.target, format: 'vtt', role: 'transcript_source' })).warnings)
      .toEqual([expect.stringContaining('settings')]);
    const unsupported = await fixture('unsupported-settings.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000 x-script:run\nMercury\n');
    await expect(inspectTranscriptInput({ filePath: unsupported.target, format: 'vtt', role: 'transcript_source' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_IMPORT_INVALID' });
  });

  it('drops isolated invalid words but rejects invalid segments and inconsistent top text', async () => {
    const base = {
      contract: 'mercury.transcript/v1', transcript_id: `trn-${'a'.repeat(16)}`,
      created_at: '2026-08-16T00:00:00.000Z', language: 'zh-CN', duration_ms: 2000,
      text: '第一行\n第二行',
      segments: [
        { segment_id: `seg-${'1'.repeat(8)}`, index: 0, start_ms: 0, end_ms: 1000, text: '第一行', words: [
          { text: '第一', start_ms: 0, end_ms: 500, confidence: 0.9 },
          { text: '倒序', start_ms: 400, end_ms: 450, confidence: 0.8 },
          { text: '合法后词', start_ms: 500, end_ms: 800, confidence: 0.8 },
          { text: '坏', start_ms: 900, end_ms: 1100, confidence: 1 },
        ] },
        { segment_id: `seg-${'2'.repeat(8)}`, index: 1, start_ms: 1000, end_ms: 2000, text: '第二行', words: [] },
      ],
      source: { kind: 'provided', format: 'transcript_json', system: 'fixture', external_id: 'fixture-1', generated_at: '2026-08-16T00:00:00.000Z', content_sha256: 'f'.repeat(64), original_path: null, original_sha256: '0'.repeat(64), normalized_sha256: '0'.repeat(64) },
      warnings: [], extensions: {},
    };
    const valid = await fixture('valid.json', `${JSON.stringify(base)}\n`);
    const inspected = await inspectTranscriptInput({ filePath: valid.target, format: 'transcript_json', role: 'transcript_source' });
    expect(inspected.transcript.segments[0].words.map((word) => word.text)).toEqual(['第一', '合法后词']);
    expect(inspected.warnings.at(-1)).toContain('2 个非法');
    const badText = await fixture('bad-text.json', JSON.stringify({ ...base, text: '伪造顶层' }));
    await expect(inspectTranscriptInput({ filePath: badText.target, format: 'transcript_json', role: 'transcript_source' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_IMPORT_INVALID' });
    const overlap = await fixture('overlap.srt', '1\n00:00:00,000 --> 00:00:02,000\n一\n\n2\n00:00:01,000 --> 00:00:03,000\n二\n');
    await expect(inspectTranscriptInput({ filePath: overlap.target, format: 'srt', role: 'transcript_source' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_IMPORT_INVALID' });
  });

  it('rejects non-UTF8, symlinks, unsupported VTT nesting and missing explicit role before side effects', async () => {
    const invalidEncoding = await fixture('bad.srt', Buffer.from([0xff, 0xfe, 0x00]));
    await expect(inspectTranscriptInput({ filePath: invalidEncoding.target, format: 'srt', role: 'transcript_source' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_IMPORT_INVALID' });
    const target = await fixture('real.srt', SRT);
    const linked = path.join(target.root, 'link.srt');
    await symlink(target.target, linked);
    await expect(inspectTranscriptInput({ filePath: linked, format: 'srt', role: 'transcript_source' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_IMPORT_INVALID' });
    const nested = await fixture('nested.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\n<script>bad</script>\n');
    await expect(inspectTranscriptInput({ filePath: nested.target, format: 'vtt', role: 'transcript_source' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_IMPORT_INVALID' });

    const workspace = await mkdtemp(path.join(os.tmpdir(), 'mercury-inspect-workspace-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(['input', 'inspect', '--file', target.target, '--format', 'auto', '--json'], {
      stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value),
    });
    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join('')).error.code).toBe('TRANSCRIPT_ROLE_REQUIRED');
    await expect(readFile(path.join(workspace, 'config', 'model-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
