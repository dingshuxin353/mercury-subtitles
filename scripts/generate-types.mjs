import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateTypeSource } from './compile-types.mjs';
import {
  generatedDirectory,
  schemaManifest
} from './schema-manifest.mjs';

await mkdir(generatedDirectory, { recursive: true });

for (const [schemaFile, outputFile] of schemaManifest) {
  const source = await generateTypeSource(schemaFile);
  await writeFile(path.join(generatedDirectory, outputFile), source, 'utf8');
}
