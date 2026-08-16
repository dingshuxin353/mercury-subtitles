import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  };
}

describe('V01-D012 release identity and help', () => {
  it('R02 reads CLI version from the VERSION fact source', async () => {
    const expected = (await readFile(path.resolve('VERSION'), 'utf8')).trim();
    const output = capture();
    expect(await runCli(['--version'], output.io)).toBe(0);
    expect(output.stderr).toEqual([]);
    expect(output.stdout.join('')).toBe(`${expected}\n`);
  });

  it('R03 exposes every supported command help without legacy new-task options', async () => {
    const commands = [
      ['--help'],
      ['setup', '--help'],
      ['model', 'check', '--help'],
      ['calibrate', '--help'],
      ['task', 'status', '--help'],
      ['task', 'list', '--help'],
    ];

    const combined: string[] = [];
    for (const command of commands) {
      const output = capture();
      expect(await runCli(command, output.io), command.join(' ')).toBe(0);
      expect(output.stderr, command.join(' ')).toEqual([]);
      combined.push(output.stdout.join(''));
    }

    const help = combined.join('\n');
    expect(help).toContain('model check --model <model-id>');
    expect(help).toContain('--asr-model <model-id>');
    expect(help).toContain('--chat-model <model-id>');
    expect(help).not.toContain('--verify-audio');
    expect(help).not.toContain('audio-verification');
    expect(help).not.toContain('--role asr');
  });
});
