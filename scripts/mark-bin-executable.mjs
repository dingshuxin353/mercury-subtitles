import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const target = path.join(projectRoot, 'dist/src/bin.js');
const source = await readFile(target, 'utf8');
if (!source.startsWith('#!/usr/bin/env node\n')) {
  throw new Error('Mercury bin is missing its Node shebang');
}
await chmod(target, 0o755);
