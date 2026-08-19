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

describe('public stable release surface', () => {
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
      version: '0.3.1',
      description: 'Local-first Chinese transcription, AI proofreading, and audited approved SRT with Skill-default auto-finalization and opt-in manual review.',
      license: 'Apache-2.0',
      engines: { node: '>=24.0.0 <25.0.0' },
      bin: { mercury: './dist/src/bin.js' },
      publishConfig: { access: 'public', tag: 'latest' },
    });
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.repository.url).toBe('git+https://github.com/dingshuxin353/mercury-subtitles.git');
    expect(packageJson.description).not.toContain('human-approved SRT workflow');
    expect(lockJson.name).toBe(packageJson.name);
    expect(lockJson.version).toBe(packageJson.version);
    expect(version).toBe(packageJson.version);
  });

  it('keeps public review documentation executable and aligned with auto-finalize', async () => {
    const architecture = await readFile(path.join(snapshotRoot, 'docs/architecture.md'), 'utf8');
    const providers = await readFile(path.join(snapshotRoot, 'docs/providers.md'), 'utf8');
    const cli = await readFile(path.join(snapshotRoot, 'docs/cli.md'), 'utf8');
    const readme = await readFile(path.join(snapshotRoot, 'README.md'), 'utf8');
    expect(architecture).toContain('审阅 / 自动批准');
    expect(architecture).toContain('`actor=skill` 默认接受剩余建议');
    expect(architecture).not.toContain('approved 只在全部人工决定完成后生成');
    expect(providers).toContain('全部 review 决定完成后');
    expect(providers).toContain('`actor=skill` 自动接受剩余建议');
    expect(providers).not.toContain('人工完成所有决定后');
    expect(readme).toContain('## 按需人工审阅校验结果');
    expect(readme).not.toContain('## 人工批准校验结果');
    expect(cli).toContain('review decide <task-id> --change <change-id> --accept --actor cli --json');
    expect(cli).toContain('review decide <task-id> --change <change-id> --reject --actor cli --json');
    expect(cli).toContain('review decide <task-id> --change <change-id> --text "人工确认文字" --actor cli --json');
    expect(cli).toContain('review accept-all <task-id> --confirm-count <pending-count> --actor cli --json');
    expect(cli).not.toMatch(/review decide[^\n]*--decision/u);
    expect(cli).not.toContain('review accept-all <task-id> --json');
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
    expect(readme).toContain('npm install --global mercury-subtitles@latest');
    expect(readme).toContain('`@latest` 是 Mercury 的稳定渠道');
    expect(readme).toContain('旧版尚无 `mercury update` 命令');
    expect(readme).toContain('npm install --global mercury-subtitles@0.3.1');
    expect(readme).toContain('mercury update apply --version 0.3.1 --yes --json');
    expect(readme).toContain('默认自动采用 AI 校对并输出最终字幕；如需逐条确认请直接说');
    expect(readme).toContain('该一次性动作是 bootstrap，不是旧版内置升级');
    expect(readme).toContain('`@next` 保留不可变的 `0.3.0-rc.2`');
    expect(readme).not.toContain('`@next` 当前仍指向已经发布的 `0.3.0-alpha.2`');
    expect(readme).not.toContain('尚未获得 npm 发布授权');
    expect(readme).not.toContain('当前候选');
    expect(readme).toContain('npx skills add dingshuxin353/mercury-subtitles');
    expect(readme).toContain('mercury task submit --request "/绝对路径/request.json" --json');
    expect(readme).not.toContain('mercury calibrate --audio "/绝对路径/访谈.mp3" --background --json');
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

  it('keeps one OIDC Release-event publish path and maps a formal Release to npm latest', async () => {
    const workflow = await readFile(path.join(snapshotRoot, '.github/workflows/publish.yml'), 'utf8');
    expect(workflow).toContain('release:\n    types: [published]');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('if [[ "$RELEASE_PRERELEASE" == "true" ]]');
    expect(workflow).toContain('dist_tag="next"');
    expect(workflow).toContain('dist_tag="latest"');
    expect(workflow).toContain('npm publish --access public --tag "$DIST_TAG"');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });
});
