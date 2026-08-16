import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let temporaryRoot = '';
let snapshotRoot = '';

describe('Public Alpha release surface', () => {
  beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'mercury-public-release-'));
    snapshotRoot = path.join(temporaryRoot, 'snapshot');
    await execute(process.execPath, [
      path.join(projectRoot, 'scripts/build-public-snapshot.mjs'),
      snapshotRoot,
    ], { cwd: projectRoot });
  });

  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('publishes one consistent public package identity', async () => {
    const packageJson = JSON.parse(await readFile(path.join(snapshotRoot, 'package.json'), 'utf8'));
    const lockJson = JSON.parse(await readFile(path.join(snapshotRoot, 'package-lock.json'), 'utf8'));
    const version = (await readFile(path.join(snapshotRoot, 'VERSION'), 'utf8')).trim();

    expect(packageJson).toMatchObject({
      name: 'mercury-subtitles',
      version: '0.2.0-alpha.2',
      license: 'Apache-2.0',
      engines: { node: '>=24.0.0 <25.0.0' },
      bin: { mercury: './dist/src/bin.js' },
      publishConfig: { access: 'public', tag: 'next' },
    });
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.repository.url).toBe('git+https://github.com/dingshuxin353/mercury-subtitles.git');
    expect(lockJson.name).toBe(packageJson.name);
    expect(lockJson.version).toBe(packageJson.version);
    expect(version).toBe(packageJson.version);
  });

  it('builds only the public allowlist and maps public documentation', async () => {
    const topLevel = (await readdir(snapshotRoot)).sort();
    expect(topLevel).toContain('src');
    expect(topLevel).toContain('skills');
    expect(topLevel).toContain('docs');
    expect(topLevel).not.toContain('artifacts');
    expect(topLevel).not.toContain('docs/evidence');
    expect(await readdir(path.join(snapshotRoot, 'docs'))).toContain('cli.md');
    expect(await readdir(path.join(snapshotRoot, 'docs'))).not.toContain('public');
  });

  it('gives beginners separate CLI and Skill paths with honest data boundaries', async () => {
    const readme = await readFile(path.join(snapshotRoot, 'README.md'), 'utf8');
    for (const heading of [
      '## 你会得到什么',
      '## 选择你的使用方式',
      '## 三步开始',
      '## 方式一：直接使用 CLI / App',
      '## 方式二：让 Agent 通过 Skill 使用',
      '## 你的数据会去哪里',
      '## 常见问题',
    ]) {
      expect(readme).toContain(heading);
    }
    expect(readme).toContain('npm install --global mercury-subtitles@next');
    expect(readme).toContain('Skill 只使用 Mercury 的机器命令');
    expect(readme).toContain('MP3 会发送给你在模型中心选择的 ASR 服务');
    expect(readme).toContain('当前版本没有 Mercury 托管的云端中转服务');
  });

  it('passes the independent public snapshot verifier', async () => {
    const { stdout } = await execute(process.execPath, [
      path.join(snapshotRoot, 'scripts/verify-public-snapshot.mjs'),
      snapshotRoot,
    ], { cwd: snapshotRoot });
    expect(stdout).toContain('Public snapshot verified');
  });
});
