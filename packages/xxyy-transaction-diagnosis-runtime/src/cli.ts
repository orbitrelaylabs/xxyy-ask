import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createXxyyMarketDataClient } from '@xxyy/xxyy-market-data-adapter';

import {
  createBrowserChainAnalysisClient,
  resolveBrowserChromeExecutable,
} from './browser-chain-analysis-client.js';
import { createConfiguredCanonicalPoolResolver } from './canonical-pool-config.js';
import { createChromeXxyyScreenshotProvider } from './chrome-screenshot-provider.js';
import {
  XXYY_TRANSACTION_DIAGNOSIS_RUNTIME_VERSION,
  diagnoseXxyyTransactionInputSchema,
} from './contracts.js';
import { createXxyyTransactionDiagnosisService } from './service.js';

export interface XxyyDiagnosisCliOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export async function runXxyyTransactionDiagnosisCli(
  options: XxyyDiagnosisCliOptions = {},
): Promise<Record<string, unknown>> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const parsed = parseCliArguments(argv);
  const chromeExecutable = await resolveBrowserChromeExecutable(
    env.XXYY_SCREENSHOT_CHROME_EXECUTABLE,
  );
  if (chromeExecutable === undefined) {
    throw new TypeError('Chrome or Chromium is required for XXYY transaction diagnosis.');
  }
  const stateDirectory = path.join(homedir(), '.xxyy');
  const profileDirectory = path.resolve(
    env.XXYY_BROWSER_PROFILE_DIRECTORY?.trim() || path.join(stateDirectory, 'browser-profile'),
  );
  const artifactDirectory = path.resolve(
    parsed.outputDirectory ??
      env.XXYY_SCREENSHOT_DIRECTORY?.trim() ??
      path.join(stateDirectory, 'evidence'),
  );
  await Promise.all([
    mkdir(profileDirectory, { mode: 0o750, recursive: true }),
    mkdir(artifactDirectory, { mode: 0o750, recursive: true }),
  ]);
  const chainAnalysis = createBrowserChainAnalysisClient({
    chromeExecutable,
    profileDirectory,
  });
  try {
    const canonicalPoolConfig = env.XXYY_CANONICAL_POOL_CONFIG_JSON?.trim();
    const service = createXxyyTransactionDiagnosisService({
      chainAnalysis,
      ...(canonicalPoolConfig === undefined || canonicalPoolConfig.length === 0
        ? {}
        : { canonicalPoolResolver: createConfiguredCanonicalPoolResolver(canonicalPoolConfig) }),
      marketData: createXxyyMarketDataClient(),
      poolPolicy: {
        maxSmallPoolLiquidityUsd: env.XXYY_SMALL_POOL_MAX_LIQUIDITY_USD?.trim() || '10000',
        maxSmallPoolRelativeLiquidityPpm: parseRelativeLiquidityPpm(
          env.XXYY_SMALL_POOL_MAX_RELATIVE_LIQUIDITY_PPM,
        ),
        version: '1.0.0',
      },
      screenshotProvider: createChromeXxyyScreenshotProvider({
        artifactDirectory,
        chromeExecutable,
      }),
    });
    const output = await service.diagnoseXxyyTransaction(
      diagnoseXxyyTransactionInputSchema.parse({
        checks: parsed.checks,
        ...(parsed.network === undefined ? {} : { network: parsed.network }),
        reference: parsed.reference,
        ...(parsed.swapIndex === undefined ? {} : { swapIndex: parsed.swapIndex }),
      }),
    );
    const artifact = output.screenshotEvidence.artifact;
    return {
      ...output,
      runtimeVersion: XXYY_TRANSACTION_DIAGNOSIS_RUNTIME_VERSION,
      ...(artifact === undefined
        ? {}
        : {
            screenshotEvidence: {
              ...output.screenshotEvidence,
              artifact: {
                ...artifact,
                filePath: path.join(artifactDirectory, path.basename(artifact.url)),
              },
            },
          }),
    };
  } finally {
    await chainAnalysis.close();
  }
}

export async function main(options: XxyyDiagnosisCliOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const pretty = argv.includes('--pretty');
  try {
    const output = await runXxyyTransactionDiagnosisCli({ ...options, argv });
    process.stdout.write(`${JSON.stringify(output, null, pretty ? 2 : undefined)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          error: {
            code: 'diagnosis_failed',
            message: error instanceof Error ? error.message : 'XXYY diagnosis failed.',
          },
          status: 'error',
        },
        null,
        pretty ? 2 : undefined,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

function parseCliArguments(argv: readonly string[]): {
  checks: Array<'pool' | 'sandwich'>;
  network?: string;
  outputDirectory?: string;
  reference: string;
  swapIndex?: number;
} {
  const values = new Map<string, string>();
  const allowedArguments = new Set([
    '--checks',
    '--network',
    '--output-dir',
    '--reference',
    '--swap-index',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--pretty') continue;
    if (!argument.startsWith('--')) throw new TypeError(`Unknown positional argument: ${argument}`);
    if (!allowedArguments.has(argument)) throw new TypeError(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new TypeError(`${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }
  const reference = values.get('--reference')?.trim();
  if (reference === undefined || reference.length === 0) {
    throw new TypeError('--reference is required.');
  }
  const rawChecks = (values.get('--checks') ?? 'sandwich,pool')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (
    rawChecks.length === 0 ||
    rawChecks.some((value) => value !== 'pool' && value !== 'sandwich') ||
    new Set(rawChecks).size !== rawChecks.length
  ) {
    throw new TypeError('--checks must contain unique sandwich and/or pool values.');
  }
  const checks = rawChecks as Array<'pool' | 'sandwich'>;
  const swapIndexText = values.get('--swap-index');
  const swapIndex = swapIndexText === undefined ? undefined : Number(swapIndexText);
  if (swapIndex !== undefined && (!Number.isSafeInteger(swapIndex) || swapIndex < 0)) {
    throw new TypeError('--swap-index must be a nonnegative integer.');
  }
  const network = values.get('--network');
  const outputDirectory = values.get('--output-dir');
  return {
    checks,
    ...(network === undefined ? {} : { network }),
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    reference,
    ...(swapIndex === undefined ? {} : { swapIndex }),
  };
}

function parseRelativeLiquidityPpm(value: string | undefined): number {
  const parsed = Number(value ?? '100000');
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new TypeError('XXYY_SMALL_POOL_MAX_RELATIVE_LIQUIDITY_PPM must be 0..1000000.');
  }
  return parsed;
}

function usage(): string {
  return [
    'Usage: diagnose.mjs --reference <tx-hash-or-explorer-url> [options]',
    '',
    'Options:',
    '  --checks sandwich,pool   Checks to run (default: both)',
    '  --network <network>      Required only when a bare hash is ambiguous',
    '  --swap-index <index>     Select one swap from a multi-swap transaction',
    '  --output-dir <path>      Evidence image directory (default: ~/.xxyy/evidence)',
    '  --pretty                 Pretty-print the JSON result',
  ].join('\n');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
