import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const npmCli = process.env.npm_execpath;

if (!npmCli) {
  throw new Error('npm_execpath is required to verify the package');
}

const productVersion = (
  await readFile(path.join(projectRoot, 'VERSION'), 'utf8')
).trim();
const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
);
if (packageJson.version !== productVersion) {
  throw new Error('VERSION and package.json.version must be identical');
}
if (packageJson.name !== 'mercury-subtitles') {
  throw new Error('The public package name must be mercury-subtitles');
}
if (packageJson.private === true) {
  throw new Error('The public package must not be marked private');
}
if (packageJson.packageManager !== 'npm@11.12.1') {
  throw new Error('The D012 Alpha candidate requires npm 11.12.1');
}
if (
  packageJson.engines?.node !== '>=24.0.0 <25.0.0' ||
  packageJson.bin?.mercury !== './dist/src/bin.js' ||
  packageJson.license !== 'Apache-2.0' ||
  packageJson.repository?.url !== 'git+https://github.com/dingshuxin353/mercury-subtitles.git' ||
  packageJson.publishConfig?.access !== 'public' ||
  packageJson.publishConfig?.tag !== 'next'
) {
  throw new Error('The public package metadata is incomplete or inconsistent');
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'mercury-package-'));
const packageDirectory = path.join(temporaryRoot, 'package');
const isolatedHome = path.join(temporaryRoot, 'home');
const modelConfigFixture = JSON.parse(
  await readFile(
    path.join(projectRoot, 'test/fixtures/valid/model-config.json'),
    'utf8',
  ),
);
const readFixture = async (name) =>
  JSON.parse(
    await readFile(path.join(projectRoot, 'test/fixtures/valid', name), 'utf8'),
  );
const completeGraphFixture = {
  modelConfig: modelConfigFixture,
  modelSnapshot: await readFixture('model-snapshot.json'),
  transcriptRaw: await readFixture('transcript.raw.json'),
  calibrationResult: await readFixture('calibration-result.json'),
  audioVerification: await readFixture('audio-verification.completed.json'),
  adapterFailures: [],
  availableTaskFiles: [
    'input/sample.mp3',
    'input/reference.srt',
    'work/transcript.raw.json',
    'work/calibration-result.json',
    'work/provider-response.asr.redacted.json',
  ],
  availableModificationIds: ['modification-0001'],
};

async function collectFiles(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, root)));
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(path.relative(root, entryPath));
    }
  }
  return files.sort();
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoLocalAbsolutePaths(directory) {
  for (const relative of await collectFiles(directory)) {
    const content = await readFile(path.join(directory, relative));
    if (content.includes(0)) continue;
    const text = content.toString('utf8');
    if (/\/(?:Users|home)\/[^/\s]+\//u.test(text)) {
      throw new Error(`Packed artifact contains a local absolute path: ${relative}`);
    }
  }
}

try {
  await mkdir(packageDirectory);
  await mkdir(isolatedHome);
  const { stdout } = await execute(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', packageDirectory],
    { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const [packResult] = JSON.parse(stdout);
  if (!packResult || packResult.version !== productVersion) {
    throw new Error('npm pack metadata does not match VERSION');
  }
  const packageFiles = new Set(packResult.files.map((entry) => entry.path));
  for (const required of [
    'VERSION',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'NOTICE',
    'package.json',
    'dist/src/contracts/index.js',
    'dist/src/contracts/index.d.ts',
    'dist/src/subtitle-core/index.js',
    'dist/src/subtitle-core/index.d.ts',
    'dist/src/output-report/index.js',
    'dist/src/output-report/index.d.ts',
    'dist/src/model-center/index.js',
    'dist/src/model-center/index.d.ts',
    'dist/src/exchange/index.js',
    'dist/src/exchange/index.d.ts',
    'dist/src/core-integration.js',
    'dist/src/core-integration-v2.js',
    'dist/src/cli.js',
    'dist/src/version.js',
    'dist/src/bin.js',
    'schemas/v1/common.schema.json',
    'schemas/v1/model-config.schema.json',
    'schemas/v1/model-snapshot.schema.json',
    'schemas/v1/transcript.raw.schema.json',
    'schemas/v1/calibration-result.schema.json',
    'schemas/v1/audio-verification.schema.json',
    'schemas/v2/model-config.schema.json',
    'schemas/v2/model-snapshot.schema.json',
    'schemas/v2/calibration-result.schema.json',
    'schemas/v3/calibration-result.schema.json',
    'schemas/v4/background-task.schema.json',
    'schemas/v4/background-job.schema.json',
    'schemas/v4/background-request.schema.json',
    'schemas/v4/task-event.schema.json',
    'schemas/v4/review.schema.json',
    'schemas/exchange/v1/common.schema.json',
    'schemas/exchange/v1/request.schema.json',
    'schemas/exchange/v1/task.schema.json',
    'schemas/exchange/v1/event.schema.json',
    'schemas/exchange/v1/result.schema.json',
    'schemas/exchange/v1/error.schema.json',
    'schemas/exchange/v1/transcript.schema.json',
    'schemas/exchange/v1/dictionary.schema.json',
    'schemas/v5/task-record.schema.json',
    'skills/mercury-subtitles/SKILL.md',
    'skills/mercury-subtitles/agents/openai.yaml',
    'skills/mercury-subtitles/references/commands.md',
    'skills/mercury-subtitles/references/task-states.md',
    'skills/mercury-subtitles/references/review.md',
    'skills/mercury-subtitles/references/troubleshooting.md',
  ]) {
    if (!packageFiles.has(required)) {
      throw new Error(`Packed artifact is missing ${required}`);
    }
  }
  for (const entry of packResult.files) {
    if (
      path.isAbsolute(entry.path) ||
      entry.path.includes('..') ||
      /(^|\/)(?:\.git|node_modules|test|mercury-workspace)(?:\/|$)/u.test(
        entry.path,
      )
    ) {
      throw new Error(
        `Packed artifact contains a forbidden path: ${entry.path}`,
      );
    }
  }

  const tarball = path.join(packageDirectory, packResult.filename);
  const tarballStat = await stat(tarball);
  if (tarballStat.size !== packResult.size) {
    throw new Error('npm pack size metadata does not match the tarball');
  }

  await writeFile(
    path.join(temporaryRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await writeFile(
    path.join(temporaryRoot, 'verify-consumer.mjs'),
    [
      "import { ContractRegistryError, EXCHANGE_CONTRACTS, SUPPORTED_SCHEMA_VERSION, assertContractGraph, assertExchangeContract, assertV2Contract, assertV3CalibrationResult, validateAllSchemas, validateContract, validateContractGraph, validateExchangeContract, validateV2Contract, validateV3CalibrationResult } from 'mercury-subtitles';",
      "import { canonicalJson } from 'mercury-subtitles/exchange';",
      "import { parseReferenceSrt, runSubtitleCore } from 'mercury-subtitles/subtitle-core';",
      "import { generateTaskOutputs, validateSrtText } from 'mercury-subtitles/output-report';",
      "import { createBuiltinPluginRegistry } from 'mercury-subtitles/model-center';",
      "import commonSchema from 'mercury-subtitles/schemas/v1/common.schema.json' with { type: 'json' };",
      "import modelConfigSchema from 'mercury-subtitles/schemas/v1/model-config.schema.json' with { type: 'json' };",
      "import modelSnapshotSchema from 'mercury-subtitles/schemas/v1/model-snapshot.schema.json' with { type: 'json' };",
      "import transcriptSchema from 'mercury-subtitles/schemas/v1/transcript.raw.schema.json' with { type: 'json' };",
      "import calibrationSchema from 'mercury-subtitles/schemas/v1/calibration-result.schema.json' with { type: 'json' };",
      "import audioVerificationSchema from 'mercury-subtitles/schemas/v1/audio-verification.schema.json' with { type: 'json' };",
      "import modelConfigV2Schema from 'mercury-subtitles/schemas/v2/model-config.schema.json' with { type: 'json' };",
      "import modelSnapshotV2Schema from 'mercury-subtitles/schemas/v2/model-snapshot.schema.json' with { type: 'json' };",
      "import calibrationV2Schema from 'mercury-subtitles/schemas/v2/calibration-result.schema.json' with { type: 'json' };",
      "import calibrationV3Schema from 'mercury-subtitles/schemas/v3/calibration-result.schema.json' with { type: 'json' };",
      "import exchangeRequestSchema from 'mercury-subtitles/schemas/exchange/v1/request.schema.json' with { type: 'json' };",
      "import taskV5Schema from 'mercury-subtitles/schemas/v5/task-record.schema.json' with { type: 'json' };",
      "if (SUPPORTED_SCHEMA_VERSION !== '1.0.0') throw new Error('historical runtime export is unavailable');",
      "if (typeof validateContract !== 'function' || typeof validateContractGraph !== 'function' || typeof assertContractGraph !== 'function') throw new Error('v1 validator export is unavailable');",
      "if (typeof validateV2Contract !== 'function' || typeof assertV2Contract !== 'function') throw new Error('v2 validator export is unavailable');",
      "if (typeof validateV3CalibrationResult !== 'function' || typeof assertV3CalibrationResult !== 'function') throw new Error('v3 validator export is unavailable');",
      "if (typeof validateExchangeContract !== 'function' || typeof assertExchangeContract !== 'function' || EXCHANGE_CONTRACTS.task !== 'mercury.task/v1') throw new Error('exchange v1 export is unavailable');",
      "if (canonicalJson({ b: 2, a: 1 }) !== '{\\n  \"a\": 1,\\n  \"b\": 2\\n}\\n') throw new Error('exchange storage export is unavailable');",
      "if (typeof parseReferenceSrt !== 'function' || typeof runSubtitleCore !== 'function') throw new Error('subtitle-core export is unavailable');",
      "if (typeof generateTaskOutputs !== 'function' || typeof validateSrtText !== 'function') throw new Error('output-report export is unavailable');",
      "if (typeof createBuiltinPluginRegistry !== 'function') throw new Error('model-center export is unavailable');",
      "if (![commonSchema, modelConfigSchema, modelSnapshotSchema, transcriptSchema, calibrationSchema, audioVerificationSchema, modelConfigV2Schema, modelSnapshotV2Schema, calibrationV2Schema, calibrationV3Schema, exchangeRequestSchema, taskV5Schema].every((schema) => schema.$id)) throw new Error('schema export is unavailable');",
      'validateAllSchemas();',
      "try { validateContract('unregistered', {}); throw new Error('expected registry error'); } catch (error) {",
      "  if (!(error instanceof ContractRegistryError) || error.code !== 'CONTRACT_REGISTRY_INVALID') throw error;",
      '}',
      `const legalModelConfig = ${JSON.stringify(modelConfigFixture)};`,
      "const legalResult = validateContract('model-config', legalModelConfig);",
      "if (!legalResult.valid || legalResult.value !== legalModelConfig) throw new Error('legal v1 model config was rejected');",
      `const completeGraph = ${JSON.stringify(completeGraphFixture)};`,
      'const graphResult = validateContractGraph(completeGraph);',
      "if (!graphResult.valid || graphResult.value !== completeGraph || assertContractGraph(completeGraph) !== completeGraph) throw new Error('complete v1 ContractGraph was rejected');",
      'const brokenGraph = structuredClone(completeGraph);',
      "brokenGraph.audioVerification.staging[0].object_uri = 'gs://wrong-bucket/task/object.mp3';",
      'const brokenGraphResult = validateContractGraph(brokenGraph);',
      "if (brokenGraphResult.valid || !brokenGraphResult.issues.some((issue) => issue.invariant_id === 'INV-GCS-003')) throw new Error('broken historical ContractGraph was accepted');",
      "if (validateV2Contract('model-config', legalModelConfig).valid) throw new Error('v1 config was accepted as v2');",
    ].join('\n'),
  );
  await writeFile(
    path.join(temporaryRoot, 'verify-types.ts'),
    [
      "import type { AsrHintsCapableAdapter, AsrHintsDispatchEvidence, AsrHintsEvidence, AsrHintsInput, CalibrationResultV2, ExchangeRequestV1, ExchangeTaskV1, ModelConfigRegistryV2, ModelSnapshotV2, TaskRecordV5 } from 'mercury-subtitles';",
      "import type { SubtitleCoreResult } from 'mercury-subtitles/subtitle-core';",
      "import type { SrtValidationResult } from 'mercury-subtitles/output-report';",
      "import type { BuiltinModelPlugin } from 'mercury-subtitles/model-center';",
      'declare const config: ModelConfigRegistryV2;',
      'declare const snapshot: ModelSnapshotV2;',
      'declare const calibration: CalibrationResultV2;',
      'declare const exchangeRequest: ExchangeRequestV1;',
      'declare const exchangeTask: ExchangeTaskV1;',
      'declare const taskV5: TaskRecordV5;',
      'void exchangeRequest.output.approved_srt_directory;',
      'void exchangeTask.delivery?.history;',
      'void taskV5.delivery?.review_revision;',
      'declare const hintedAsr: AsrHintsCapableAdapter;',
      'declare const hintsInput: AsrHintsInput;',
      'declare const hintsEvidence: AsrHintsEvidence;',
      'declare const dispatchEvidence: AsrHintsDispatchEvidence;',
      'declare const subtitle: SubtitleCoreResult;',
      'declare const srt: SrtValidationResult;',
      'declare const plugin: BuiltinModelPlugin;',
      "if (hintedAsr.asrHintsCapability.status === 'supported') void hintedAsr.asrHintsCapability.acceptedFields;",
      'void [config, snapshot, calibration, exchangeRequest, exchangeTask, taskV5, hintedAsr, hintsInput, hintsEvidence, dispatchEvidence, subtitle, srt, plugin];',
    ].join('\n'),
  );
  await writeFile(
    path.join(temporaryRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ['verify-types.ts'],
    }),
  );
  await execute(
    process.execPath,
    [
      npmCli,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarball,
    ],
    { cwd: temporaryRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  await execute(
    process.execPath,
    [path.join(temporaryRoot, 'verify-consumer.mjs')],
    { cwd: temporaryRoot },
  );
  await execute(
    process.execPath,
    [path.join(projectRoot, 'node_modules/typescript/bin/tsc')],
    { cwd: temporaryRoot, maxBuffer: 10 * 1024 * 1024 },
  );

  const installedPackage = path.join(
    temporaryRoot,
    'node_modules/mercury-subtitles',
  );
  const installedBin = path.join(
    temporaryRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'mercury.cmd' : 'mercury',
  );
  const installedBinStat = await stat(installedBin);
  if (process.platform !== 'win32' && (installedBinStat.mode & 0o111) === 0) {
    throw new Error('Installed mercury bin is not executable');
  }
  await assertNoLocalAbsolutePaths(installedPackage);
  const installedBeforeCli = await collectFiles(installedPackage);
  const cliEnvironment = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    // The installed executable uses #!/usr/bin/env node. Make it resolve to
    // the same Node 24 runtime that launched this verifier, even when the
    // developer's login PATH still defaults to an older Node release.
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const runCli = (args) =>
    execute(installedBin, args, {
      cwd: temporaryRoot,
      env: cliEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    });

  const { stdout: cliVersion } = await runCli(['--version']);
  if (cliVersion.trim() !== productVersion) {
    throw new Error('Installed CLI version does not match VERSION');
  }
  const { stdout: skillStatusOutput } = await runCli(['skill', 'status', '--json']);
  const skillStatus = JSON.parse(skillStatusOutput);
  if (
    !skillStatus.ok ||
    skillStatus.data.product_version !== productVersion ||
    skillStatus.data.installed ||
    skillStatus.data.recommended_install_command !==
      'npx skills add dingshuxin353/mercury-subtitles'
  ) {
    throw new Error('Installed package Skill status is unavailable or incompatible');
  }
  const standardSkillParent = path.join(isolatedHome, '.agents', 'skills');
  await mkdir(standardSkillParent, { recursive: true });
  await cp(
    path.join(installedPackage, 'skills', 'mercury-subtitles'),
    path.join(standardSkillParent, 'mercury-subtitles'),
    { recursive: true, errorOnExist: true, force: false },
  );
  const packagedCommands = await readFile(
    path.join(installedPackage, 'skills', 'mercury-subtitles', 'references', 'commands.md'),
    'utf8',
  );
  const packagedTroubleshooting = await readFile(
    path.join(installedPackage, 'skills', 'mercury-subtitles', 'references', 'troubleshooting.md'),
    'utf8',
  );
  if (
    !packagedCommands.includes('config status.data.models[].model_id') ||
    !packagedCommands.includes('Never use `provider`, `name`, or `category` as a model ID') ||
    !packagedCommands.includes('derive a new stable request ID') ||
    !packagedCommands.includes('`resume.allowed`') ||
    !packagedCommands.includes('`dictionaries.selected` is an array of `dictionary_id` strings') ||
    !packagedCommands.includes('"selected": ["dict-project-terms"]') ||
    !packagedCommands.includes('do not put revision objects into `selected[]`') ||
    !packagedTroubleshooting.includes('If `approved_srt.exists` is false, do not call `task deliver`')
  ) {
    throw new Error('Installed package Skill is missing the rc3 model/action/delivery/dictionary safety guidance');
  }
  const { stdout: skillInstallOutput } = await runCli(['skill', 'install', '--json']);
  const skillInstall = JSON.parse(skillInstallOutput);
  if (
    !skillInstall.ok ||
    !skillInstall.data.installed ||
    !skillInstall.data.compatible ||
    skillInstall.data.install_method !== 'agents_global' ||
    skillInstall.data.install_action !== 'already_installed'
  ) {
    throw new Error('Installed package cannot recognize a standard Skills CLI installation');
  }
  const legacySkill = path.join(isolatedHome, '.codex', 'skills', 'mercury-subtitles');
  if (await lstat(legacySkill).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) {
    throw new Error('Compatibility install duplicated a standard Skill into the legacy directory');
  }
  const helpCommands = [
    ['--help'],
    ['setup', '--help'],
    ['model', 'check', '--help'],
    ['calibrate', '--help'],
    ['task', 'status', '--help'],
    ['task', 'list', '--help'],
  ];
  const helpText = (
    await Promise.all(
      helpCommands.map(async (args) => (await runCli(args)).stdout),
    )
  ).join('\n');
  for (const required of [
    'mercury setup',
    'model check --model <model-id>',
    '--asr-model <model-id>',
    '--chat-model <model-id>',
    'task status <task-id>',
    'task list',
  ]) {
    if (!helpText.includes(required)) {
      throw new Error(`Installed CLI help is missing ${required}`);
    }
  }
  for (const forbidden of [
    '--verify-audio',
    'audio-verification',
    '--role asr',
  ]) {
    if (helpText.includes(forbidden)) {
      throw new Error(`Installed CLI help contains legacy option ${forbidden}`);
    }
  }

  const { stdout: taskList } = await runCli(['task', 'list']);
  if (!taskList.includes('暂无本地任务')) {
    throw new Error('Installed CLI did not initialize an empty workspace');
  }
  const workspaceRoot = path.join(isolatedHome, 'mercury-workspace');
  for (const directory of ['config', 'models', 'tasks', 'logs']) {
    if (!(await pathExists(path.join(workspaceRoot, directory)))) {
      throw new Error(`Installed CLI did not initialize ${directory}`);
    }
  }

  const audio = path.join(temporaryRoot, 'candidate.mp3');
  const audioBytes = Buffer.alloc(834);
  audioBytes.set([0xff, 0xfb, 0x90, 0x64], 0);
  audioBytes.set([0xff, 0xfb, 0x90, 0x64], 417);
  await writeFile(audio, audioBytes);
  try {
    await runCli(['calibrate', '--audio', audio]);
    throw new Error('calibrate unexpectedly succeeded without model config');
  } catch (error) {
    if (!String(error.stderr ?? '').includes('MODEL_NOT_CONFIGURED')) {
      throw error;
    }
  }
  try {
    await runCli([
      'calibrate',
      '--audio',
      path.join(temporaryRoot, 'missing.mp3'),
      '--verify-audio',
    ]);
    throw new Error('legacy verification option unexpectedly succeeded');
  } catch (error) {
    if (!String(error.stderr ?? '').includes('VERIFY_AUDIO_REMOVED')) {
      throw error;
    }
  }
  if ((await readdir(path.join(workspaceRoot, 'tasks'))).length !== 0) {
    throw new Error('Rejected CLI calls created a task directory');
  }
  if (await pathExists(path.join(installedPackage, 'mercury-workspace'))) {
    throw new Error('Installed package contains runtime workspace data');
  }
  const installedAfterCli = await collectFiles(installedPackage);
  if (
    JSON.stringify(installedAfterCli) !== JSON.stringify(installedBeforeCli)
  ) {
    throw new Error('CLI consumption modified the installed package directory');
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(
  `Package ${packageJson.name}@${productVersion} contains runnable JavaScript, declarations, historical v1-v4 schemas, Exchange Protocol v1, internal v5, the Mercury subtitle Skill, and an isolated CLI consumer.`,
);
