import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error('npm_execpath is required to scan the packed package');
const securityModuleUrl = new URL('../dist/src/contracts/validation/security.js', import.meta.url);
let sensitiveInformationIssues;
let sensitiveTextIssues;
try {
  ({ sensitiveInformationIssues, sensitiveTextIssues } = await import(securityModuleUrl));
} catch (error) {
  throw new Error('Build the project before running the sensitive information scan', {
    cause: error
  });
}

const fakeSecret = ['sk', '-', 'a'.repeat(24)].join('');
for (const field of ['credentials', 'secrets', 'tokens', 'apiKeys', 'passwords', 'privateKeys']) {
  if (sensitiveInformationIssues({ [field]: 'fixture' }).length === 0) {
    throw new Error(`Sensitive field self-check failed: ${field}`);
  }
}
for (const reference of [
  `keychain:${fakeSecret}`,
  `adc:${fakeSecret}`,
  `file:/controlled/${fakeSecret}.json`
]) {
  const referenceContexts = [
    `credential_ref: "${reference}"`,
    `"credential_ref": "${reference}"`,
    `'credential_ref': '${reference}'`,
    `credential_ref: \`${reference}\``
  ];
  if (
    sensitiveInformationIssues({ credential_ref: reference }).length > 0 ||
    referenceContexts.some((context) => sensitiveTextIssues(context).length > 0)
  ) {
    throw new Error(`Credential reference self-check failed: ${reference}`);
  }
}
for (const field of [
  'api_key',
  'apiKey',
  'authorization',
  'auth_token',
  'refresh_token',
  'client_secret',
  'credential_ref'
]) {
  const url = ['https://example.invalid/object?', field, '=fixture-value'].join('');
  if (
    sensitiveInformationIssues({ resource_uri: url }).length === 0 ||
    sensitiveTextIssues(`resource_uri: "${url}"`).length === 0
  ) {
    throw new Error(`Credential URL self-check failed: ${field}`);
  }
}
for (const format of [
  'ENCRYPTED PRIVATE KEY',
  'DSA PRIVATE KEY',
  'PGP PRIVATE KEY BLOCK'
]) {
  const material = ['-----BEGIN ', format, '-----', '\nfixture-only'].join('');
  if (
    sensitiveInformationIssues({ material }).length === 0 ||
    sensitiveTextIssues(material).length === 0
  ) {
    throw new Error(`Private key self-check failed: ${format}`);
  }
}

async function scanFile(file, location, findings) {
  const content = await readFile(file);
  if (content.includes(0)) return;
  const text = content.toString('utf8');
  if (path.extname(file) === '.json') {
    try {
      const issues = sensitiveInformationIssues(JSON.parse(text), {
        inspectFieldNames: location.startsWith('git:test/fixtures/')
      });
      issues.forEach((issue) => findings.add(`${location}${issue.path}`));
      return;
    } catch {
      findings.add(`${location} (invalid JSON)`);
    }
  }
  if (sensitiveTextIssues(text).length > 0) findings.add(location);
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

const findings = new Set();
const { stdout: gitFiles } = await execute(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: projectRoot, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
);
for (const relative of gitFiles.toString('utf8').split('\0').filter(Boolean)) {
  if (sensitiveTextIssues(relative).length > 0) {
    findings.add(`git:${relative} (filename)`);
  }
  await scanFile(path.join(projectRoot, relative), `git:${relative}`, findings);
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'mercury-sensitive-scan-'));
try {
  const { stdout } = await execute(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', temporaryRoot],
    { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 }
  );
  const [packResult] = JSON.parse(stdout);
  for (const entry of packResult.files) {
    if (sensitiveTextIssues(entry.path).length > 0) {
      findings.add(`pack:${entry.path} (filename)`);
    }
  }
  const tarball = path.join(temporaryRoot, packResult.filename);
  const unpacked = path.join(temporaryRoot, 'unpacked');
  await mkdir(unpacked);
  await execute('tar', ['-xzf', tarball, '-C', unpacked]);
  for (const file of await collectFiles(path.join(unpacked, 'package'))) {
    await scanFile(file, `pack:${path.relative(path.join(unpacked, 'package'), file)}`, findings);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (findings.size > 0) {
  throw new Error(`Potential credential material found in:\n${[...findings].sort().join('\n')}`);
}

console.log('Sensitive information scan passed for Git files, JSON fixture keys/values, and npm pack.');
