#!/usr/bin/env node

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createBrowserChainAnalysisClient,
  createChromeBrowserPageEvaluator,
  ExplorerBrowserUnavailableError,
  resolveExplorerBrowserDriverExecutable,
} from './browser-chain-analysis-client.js';
import { getTransactionInputSchema } from './public-transaction-contracts.js';

export async function runPublicTransactionCli(
  options: {
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Record<string, unknown>> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const parsed = parseArguments(argv);
  const browserDriverExecutable = await resolveExplorerBrowserDriverExecutable(env.PATH);
  if (browserDriverExecutable === undefined) throw new ExplorerBrowserUnavailableError();
  const client = createBrowserChainAnalysisClient({
    pageEvaluator: createChromeBrowserPageEvaluator({
      command: browserDriverExecutable,
      taskName: 'xxyy-onchain-skill-explorer',
    }),
  });
  try {
    const output = await client.getTransaction(
      getTransactionInputSchema.parse({
        reference: parsed.reference,
        ...(parsed.network === undefined ? {} : { network: parsed.network }),
      }),
    );
    return { ...output, runtimeVersion: '1.0.0' };
  } finally {
    await client.close();
  }
}

export async function publicTransactionMain(
  options: {
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${transactionUsage()}\n`);
    return;
  }
  try {
    const output = await runPublicTransactionCli({ ...options, argv });
    process.stdout.write(
      `${JSON.stringify(output, null, argv.includes('--pretty') ? 2 : undefined)}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        error: {
          code: 'transaction_inspection_failed',
          message: error instanceof Error ? error.message : 'Transaction inspection failed.',
        },
        status: 'error',
      })}\n`,
    );
    process.exitCode = 1;
  }
}

function parseArguments(argv: readonly string[]): { network?: string; reference: string } {
  const values = new Map<string, string>();
  const allowed = new Set(['--network', '--reference']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--' || argument === '--pretty') continue;
    if (!allowed.has(argument)) throw new TypeError(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new TypeError(`${argument} requires a value.`);
    values.set(argument, value);
    index += 1;
  }
  const reference = values.get('--reference')?.trim();
  if (reference === undefined || reference.length === 0)
    throw new TypeError('--reference is required.');
  const network = values.get('--network')?.trim();
  return { ...(network === undefined ? {} : { network }), reference };
}

function transactionUsage(): string {
  return [
    'Usage: inspect.mjs --reference <tx-hash-or-explorer-url> [options]',
    '',
    'Options:',
    '  --network <network>  Required only when a bare hash is ambiguous',
    '  --pretty             Pretty-print the JSON result',
  ].join('\n');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(await realpath(path.resolve(process.argv[1]))).href
) {
  await publicTransactionMain();
}
