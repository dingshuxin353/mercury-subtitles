import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const tarball = process.argv[2];
if (!tarball || !path.isAbsolute(tarball)) throw new Error('usage: node scripts/verify-delivery-package.mjs /absolute/package.tgz');

const digest = (value) => createHash('sha256').update(value).digest('hex');
const temporaryAlias = await mkdtemp(path.join(os.tmpdir(), 'mercury-delivery-package-'));
const temporary = await realpath(temporaryAlias);
const install = path.join(temporary, 'install');
await mkdir(install, { mode: 0o700 });
await execute('npm', ['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', tarball], { env: process.env });
const packageRoot = path.join(install, 'node_modules', 'mercury-subtitles');
const imported = async (relative) => import(pathToFileURL(path.join(packageRoot, 'dist/src', relative)).href);
const { ensureWorkspace } = await imported('workspace.js');
const { loadModelRegistryV2 } = await imported('models-v2.js');
const { submitExchangeRequest, readV5Task } = await imported('exchange/runtime.js');
const { runWorker } = await imported('background/worker.js');

const home = path.join(temporary, 'home');
const workspace = path.join(home, 'mercury-workspace');
const business = path.join(temporary, 'business-output');
await ensureWorkspace(workspace);
const configTarget = path.join(workspace, 'config/model-config.json');
await copyFile(path.resolve('test/fixtures/valid/model-config.json'), configTarget, constants.COPYFILE_EXCL);
await chmod(configTarget, 0o600);
const registry = await loadModelRegistryV2(workspace);
const source = path.join(temporary, 'provided.srt');
const sourceText = '1\n00:00:00,000 --> 00:00:01,000\n最终交付测试\n';
await writeFile(source, sourceText, { mode: 0o600 });
const request = {
  contract: 'mercury.exchange.request/v1', request_id: 'request-package-delivery-fixture', created_at: '2026-08-17T06:00:00.000Z', operation: 'subtitle_calibration',
  inputs: { media: null, transcript: { path: source, sha256: digest(sourceText), format: 'srt', role: 'transcript_source' } },
  transcription_mode: 'provided', calibration: { mode: 'text-only', source_language: 'zh-CN' },
  models: { asr: null, chat: registry.defaults.chat }, dictionaries: { project_key: null, selected: [], task_overrides: [] },
  output: { formats: ['srt', 'report'], workspace_policy: 'managed', approved_srt_directory: business }, extensions: {},
};
const submitted = await submitExchangeRequest(workspace, request);
let fixtureCalls = 0;
const fetch = async (_url, init) => {
  fixtureCalls += 1;
  const body = JSON.parse(String(init?.body));
  const prompt = body.messages.find((message) => message.role === 'user').content;
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  const content = JSON.stringify({ corrected_units: payload.calibration_units.map((unit) => ({ unit_id: unit.unit_id, corrected_text: unit.original_text, rationale: null })) });
  return new Response(`data: ${JSON.stringify({ id: 'package-fixture', choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'package-fixture', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
await runWorker(workspace, { fetch, readCredential: async () => 'fixture-only' });
const taskDirectory = path.join(workspace, 'tasks', submitted.task.identity.task_directory);
const task = await readV5Task(taskDirectory);
if (fixtureCalls !== 1 || task.status !== 'completed' || task.delivery?.status !== 'delivered' || task.delivery.history.length !== 1) throw new Error('installed package did not complete one local fixture delivery');
const approved = path.join(taskDirectory, task.artifacts.approved.path);
const delivered = task.delivery.final_path;
if (!await lstat(delivered).then((entry) => entry.isFile() && !entry.isSymbolicLink())) throw new Error('delivered target is not a regular file');
if (((await stat(delivered)).mode & 0o777) !== 0o600 || ((await stat(business)).mode & 0o777) !== 0o700) throw new Error('delivery permissions are not 0600/0700');
if (digest(await readFile(approved)) !== digest(await readFile(delivered)) || digest(await readFile(delivered)) !== task.delivery.sha256) throw new Error('workspace and business delivery hashes differ');

const cli = path.join(packageRoot, 'dist/src/bin.js');
const environment = { ...process.env, HOME: home };
const version = await execute(process.execPath, [cli, '--version'], { env: environment });
if (version.stdout.trim() !== '0.3.0') throw new Error('installed CLI version mismatch');
for (const command of [
  ['task', 'status', task.identity.task_id, '--json'],
  ['task', 'result', task.identity.task_id, '--json'],
  ['task', 'deliver', task.identity.task_id, '--json'],
]) {
  const result = await execute(process.execPath, [cli, ...command], { env: environment });
  const envelope = JSON.parse(result.stdout);
  if (!envelope.ok) throw new Error(`installed CLI failed: ${command.join(' ')}`);
}
const after = await readV5Task(taskDirectory);
if (fixtureCalls !== 1 || after.delivery.history.length !== 1 || after.delivery.final_path !== delivered) throw new Error('local deliver replay changed provider count or delivery identity');
console.log(JSON.stringify({ task_id: task.identity.task_id, delivery_sha256: task.delivery.sha256, history_count: task.delivery.history.length, fixture_provider_calls: fixtureCalls }));
