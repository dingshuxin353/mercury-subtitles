import { readFile } from 'node:fs/promises';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export async function readProductVersion(): Promise<string> {
  const candidates = [
    new URL('../VERSION', import.meta.url),
    new URL('../../VERSION', import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      const version = (await readFile(candidate, 'utf8')).trim();
      if (!VERSION_PATTERN.test(version)) {
        throw new Error(
          `VERSION contains an invalid product version: ${version}`,
        );
      }
      return version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  throw new Error('VERSION is unavailable from the Mercury installation.');
}
