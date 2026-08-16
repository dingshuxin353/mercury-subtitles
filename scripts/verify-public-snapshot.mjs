import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotRoot = path.resolve(process.argv[2] ?? scriptRoot);

const allowedTopLevel = new Set([
  '.git',
  '.github',
  '.gitignore',
  '.node-version',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'VERSION',
  'assets',
  'coverage',
  'dist',
  'docs',
  'node_modules',
  'package-lock.json',
  'package.json',
  'schemas',
  'scripts',
  'skills',
  'src',
  'test',
  'tsconfig.build.json',
  'tsconfig.json',
]);
const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const requiredPaths = [
  '.github/ISSUE_TEMPLATE/bug-report.yml',
  '.github/ISSUE_TEMPLATE/feature-request.yml',
  '.github/ISSUE_TEMPLATE/installation-help.yml',
  '.github/pull_request_template.md',
  '.github/workflows/ci.yml',
  'assets/readme-cover.svg',
  'docs/architecture.md',
  'docs/cli.md',
  'docs/privacy.md',
  'docs/providers.md',
  'docs/agent-skill.md',
  'docs/troubleshooting.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'VERSION',
  'package-lock.json',
  'package.json',
  'schemas/v4/background-task.schema.json',
  'skills/mercury-subtitles/SKILL.md',
  'src/bin.ts',
  'test/skill.test.ts',
];

async function ordinaryPath(relative) {
  const target = path.join(snapshotRoot, relative);
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) throw new Error(`Public snapshot contains symlink: ${relative}`);
    return entry;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Public snapshot is missing ${relative}`);
    throw error;
  }
}

for (const required of requiredPaths) await ordinaryPath(required);
for (const entry of await readdir(snapshotRoot)) {
  // Finder may recreate this ignored metadata file while a local checkout is
  // open. It cannot enter the public Git history because .gitignore excludes it.
  if (entry === '.DS_Store') continue;
  if (!allowedTopLevel.has(entry)) {
    throw new Error(`Public snapshot contains non-allowlisted top-level path: ${entry}`);
  }
}

async function collect(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Public snapshot contains symlink: ${path.relative(root, path.join(directory, entry.name))}`);
    }
    if (entry.isDirectory() && ignoredDirectories.has(entry.name) && directory === root) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(target, root));
    if (entry.isFile()) files.push(path.relative(root, target));
  }
  return files.sort();
}

const files = await collect(snapshotRoot);
const forbiddenPathPatterns = [
  /(^|\/)\.env(?:\.|$)/u,
  /(^|\/)artifacts(?:\/|$)/u,
  /(^|\/)docs\/evidence(?:\/|$)/u,
  /(^|\/)mercury-workspace(?:\/|$)/u,
  /(^|\/)provider-call-ledger\.md$/u,
  /(^|\/)\.DS_Store$/u,
];
for (const relative of files) {
  if (forbiddenPathPatterns.some((pattern) => pattern.test(relative))) {
    throw new Error(`Public snapshot contains forbidden path: ${relative}`);
  }
}

const forbiddenTextPatterns = [
  { label: 'macOS user path', pattern: /\/Users\/[^/\s"'<>]+\//u },
  { label: 'Linux user path', pattern: /\/home\/[^/\s"'<>]+\//u },
  { label: 'temporary acceptance path', pattern: /\/(?:private\/)?tmp\/mercury-[^\s"'<>]*/u },
  { label: 'private evidence path', pattern: /docs\/evidence\//u },
  { label: 'private source checkout', pattern: /main-repo\/mercury/u },
  { label: 'provider ledger', pattern: /provider-call-ledger/u },
  { label: 'workspace owner name', pattern: /\bgouzi\b/iu },
];
for (const relative of files) {
  if (relative === 'scripts/verify-public-snapshot.mjs') continue;
  const bytes = await readFile(path.join(snapshotRoot, relative));
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const { label, pattern } of forbiddenTextPatterns) {
    if (pattern.test(text)) {
      throw new Error(`Public snapshot contains ${label}: ${relative}`);
    }
  }
}

const packageJson = JSON.parse(await readFile(path.join(snapshotRoot, 'package.json'), 'utf8'));
const lockJson = JSON.parse(await readFile(path.join(snapshotRoot, 'package-lock.json'), 'utf8'));
const version = (await readFile(path.join(snapshotRoot, 'VERSION'), 'utf8')).trim();
if (
  packageJson.name !== 'mercury-subtitles' ||
  packageJson.version !== '0.2.0-alpha.3' ||
  packageJson.version !== version ||
  lockJson.name !== packageJson.name ||
  lockJson.version !== packageJson.version ||
  packageJson.private === true ||
  packageJson.license !== 'Apache-2.0' ||
  packageJson.bin?.mercury !== './dist/src/bin.js' ||
  packageJson.publishConfig?.access !== 'public' ||
  packageJson.publishConfig?.tag !== 'next'
) {
  throw new Error('Public package identity or publish metadata is inconsistent');
}

const readme = await readFile(path.join(snapshotRoot, 'README.md'), 'utf8');
for (const required of [
  '把中文 MP3 变成可检查、可修改、可交付的字幕',
  '## 选择你的使用方式',
  '## 三步开始',
  '## 方式一：直接使用 CLI / App',
  '## 方式二：让 Agent 通过 Skill 使用',
  '## 你的数据会去哪里',
  'mercury-subtitles@next',
  'npx skills add dingshuxin353/mercury-subtitles',
  'Public Alpha',
]) {
  if (!readme.includes(required)) {
    throw new Error(`Public README is missing required beginner content: ${required}`);
  }
}
if (!readme.includes('Skill 只使用 Mercury 的机器命令')) {
  throw new Error('Public README does not state the Skill execution boundary');
}
if (readme.includes('github.com/dingshuxin353/mercury-subtitles/blob/main/docs/skill.md')) {
  throw new Error('Public README links to the retired ambiguous docs/skill.md path');
}

const license = await readFile(path.join(snapshotRoot, 'LICENSE'), 'utf8');
if (!license.includes('Apache License') || !license.includes('Version 2.0, January 2004')) {
  throw new Error('Apache-2.0 license text is incomplete');
}

console.log(`Public snapshot verified: ${files.length} allowlisted files, package ${packageJson.name}@${packageJson.version}.`);
