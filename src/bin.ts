#!/usr/bin/env node
import { runCli } from './cli.js';
import { runtimeVersionProblem } from './runtime-version.js';

const runtimeProblem = runtimeVersionProblem();
if (runtimeProblem) {
  process.stderr.write(`${runtimeProblem}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = await runCli(process.argv.slice(2));
}
