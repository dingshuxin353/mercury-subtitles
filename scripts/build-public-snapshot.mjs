import { cp, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetArgument = process.argv[2];

if (!targetArgument) {
  throw new Error('Usage: node scripts/build-public-snapshot.mjs <empty-target-directory>');
}

const targetRoot = path.resolve(targetArgument);
if (targetRoot === sourceRoot || sourceRoot.startsWith(`${targetRoot}${path.sep}`)) {
  throw new Error('The public snapshot target must not be the source or its ancestor');
}

async function ordinaryDirectory(target) {
  try {
    const entry = await lstat(target);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

if (await ordinaryDirectory(targetRoot)) {
  const existing = await readdir(targetRoot);
  if (existing.length > 0) {
    throw new Error('The public snapshot target must be empty');
  }
} else {
  await mkdir(targetRoot, { recursive: true, mode: 0o755 });
}

const publicFiles = [
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
  'package-lock.json',
  'package.json',
  'tsconfig.build.json',
  'tsconfig.json',
];
const publicDirectories = [
  '.github',
  'assets',
  'schemas',
  'scripts',
  'skills',
  'src',
  'test',
];

for (const relative of publicFiles) {
  await cp(path.join(sourceRoot, relative), path.join(targetRoot, relative), {
    errorOnExist: true,
    force: false,
  });
}
for (const relative of publicDirectories) {
  await cp(path.join(sourceRoot, relative), path.join(targetRoot, relative), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

const privateDocumentation = path.join(sourceRoot, 'docs', 'public');
const publicDocumentation = path.join(sourceRoot, 'docs');
const documentationSource = await ordinaryDirectory(privateDocumentation)
  ? privateDocumentation
  : publicDocumentation;
await cp(documentationSource, path.join(targetRoot, 'docs'), {
  recursive: true,
  errorOnExist: true,
  force: false,
});

console.log(`Public snapshot created from explicit allowlist at ${targetRoot}`);
