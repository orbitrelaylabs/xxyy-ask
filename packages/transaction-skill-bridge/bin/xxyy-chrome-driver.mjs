#!/usr/bin/env node

import path from 'node:path';
import { loadEnvFile } from 'node:process';

import {
  openVerificationWindow,
  runBrowserDriverCommand,
  stopExplorerBrowser,
} from '../src/chrome-driver-runtime.mjs';

loadWorkspaceEnv();

const [command, reference] = process.argv.slice(2).filter((argument) => argument !== '--');

try {
  if (command === 'nodejs') {
    await runBrowserDriverCommand();
  } else if (command === 'verify') {
    if (reference === undefined) throw new Error('verify requires an Explorer URL.');
    await openVerificationWindow(reference);
  } else if (command === 'stop') {
    const stopped = await stopExplorerBrowser();
    process.stdout.write(
      `${stopped ? 'Explorer browser stopped.' : 'Explorer browser was not running.'}\n`,
    );
  } else {
    throw new Error('Usage: xxyy-chrome-driver <nodejs|verify|stop> [Explorer URL]');
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function loadWorkspaceEnv() {
  try {
    loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}
