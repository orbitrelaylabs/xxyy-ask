#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

loadWorkspaceEnv();

const require = createRequire(import.meta.url);
const [command, ...args] = process.argv.slice(2);
if (command !== 'inspect' && command !== 'diagnose') {
  process.stderr.write('Usage: run-pinned-skill.mjs <inspect|diagnose> [arguments]\n');
  process.exitCode = 1;
} else {
  const packageJson = require.resolve('@orbitrelaylabs/xxyy-transaction-skills/package.json');
  const dependencyRoot = path.dirname(packageJson);
  const driverDirectory = path.dirname(fileURLToPath(import.meta.url));
  const browserFetchShim = path.join(driverDirectory, 'xxyy-browser-fetch-shim.mjs');
  const script = path.join(
    dependencyRoot,
    command === 'inspect'
      ? 'skills/onchain-transaction-inspector/scripts/inspect.mjs'
      : 'skills/xxyy-transaction-diagnosis/scripts/diagnose.mjs',
  );
  const child = spawn(process.execPath, ['--import', browserFetchShim, script, ...args], {
    env: {
      ...process.env,
      PATH: [driverDirectory, process.env.PATH]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(path.delimiter),
    },
    stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal !== null) reject(new Error(`Transaction Skill stopped by ${signal}.`));
      else resolve(exitCode ?? 1);
    });
  });
  process.exitCode = code;
}

function loadWorkspaceEnv() {
  try {
    loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}
