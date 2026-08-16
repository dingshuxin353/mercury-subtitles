import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateTypeSource } from './compile-types.mjs';
import { generatedDirectory, schemaManifest } from './schema-manifest.mjs';

const staleFiles = [];

for (const [schemaFile, outputFile] of schemaManifest) {
  const expected = await generateTypeSource(schemaFile);
  const outputPath = path.join(generatedDirectory, outputFile);
  let actual;

  try {
    actual = await readFile(outputPath, 'utf8');
  } catch {
    staleFiles.push(outputFile);
    continue;
  }

  if (actual !== expected) {
    staleFiles.push(outputFile);
  }
}

if (staleFiles.length > 0) {
  throw new Error(
    `Generated contract types are missing or stale: ${staleFiles.join(', ')}. Run npm run generate:types.`
  );
}
