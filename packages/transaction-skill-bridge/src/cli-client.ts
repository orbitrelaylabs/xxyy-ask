import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  DIAGNOSE_XXYY_TRANSACTION_TIMEOUT_MS,
  diagnoseXxyyTransactionInputSchema,
  diagnoseXxyyTransactionOutputSchema,
  getTransactionInputSchema,
  getTransactionOutputSchema,
  type PublicTransactionClient,
  type XxyyTransactionDiagnosisHandler,
} from './contracts.js';

const require = createRequire(import.meta.url);
const bundledBrowserDriverDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bin',
);
const browserFetchShim = path.join(bundledBrowserDriverDirectory, 'xxyy-browser-fetch-shim.mjs');
const MAX_STDOUT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;
const ALLOWED_ENV_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'TMPDIR',
  'XXYY_BROWSER_PROFILE_DIRECTORY',
  'XXYY_CANONICAL_POOL_CONFIG_JSON',
  'XXYY_SCREENSHOT_CHROME_EXECUTABLE',
  'XXYY_SCREENSHOT_DIRECTORY',
  'XXYY_SMALL_POOL_MAX_LIQUIDITY_USD',
  'XXYY_SMALL_POOL_MAX_RELATIVE_LIQUIDITY_PPM',
] as const;

export class ExplorerBrowserUnavailableError extends Error {
  readonly code = 'explorer_browser_unavailable';

  constructor() {
    super('Chrome or Chromium is required for public Explorer queries.');
    this.name = 'ExplorerBrowserUnavailableError';
  }
}

export class ExplorerBrowserVerificationError extends Error {
  readonly code = 'explorer_verification_required';

  constructor(_host?: string, _taskName?: string) {
    super('Explorer browser requires interactive verification.');
    this.name = 'ExplorerBrowserVerificationError';
  }
}

export interface TransactionSkillBridgeOptions {
  env?: NodeJS.ProcessEnv;
  scriptPaths?: { diagnose: string; inspect: string };
}

export function createTransactionSkillPublicClient(
  options: TransactionSkillBridgeOptions = {},
): PublicTransactionClient {
  const scripts = options.scriptPaths ?? resolveTransactionSkillScriptPaths();
  return {
    close: () => Promise.resolve(),
    async getTransaction(input, invocation = {}) {
      const parsed = getTransactionInputSchema.parse(input);
      const args = ['--reference', parsed.reference];
      if (parsed.network !== undefined) args.push('--network', parsed.network);
      return getTransactionOutputSchema.parse(
        await runJsonCli(scripts.inspect, args, {
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
          timeoutMs: 45_000,
        }),
      );
    },
  };
}

export function createTransactionSkillDiagnosisHandler(
  options: TransactionSkillBridgeOptions & { outputDirectory?: string } = {},
): XxyyTransactionDiagnosisHandler {
  const scripts = options.scriptPaths ?? resolveTransactionSkillScriptPaths();
  return {
    async diagnoseXxyyTransaction(input, invocation = {}) {
      const parsed = diagnoseXxyyTransactionInputSchema.parse(input);
      const args = ['--reference', parsed.reference, '--checks', parsed.checks.join(',')];
      if (parsed.network !== undefined) args.push('--network', parsed.network);
      if (parsed.swapIndex !== undefined) args.push('--swap-index', String(parsed.swapIndex));
      args.push('--screenshot', options.outputDirectory === undefined ? 'disabled' : 'required');
      if (options.outputDirectory !== undefined) args.push('--output-dir', options.outputDirectory);
      return diagnoseXxyyTransactionOutputSchema.parse(
        await runJsonCli(scripts.diagnose, args, {
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
          timeoutMs: DIAGNOSE_XXYY_TRANSACTION_TIMEOUT_MS,
        }),
      );
    },
  };
}

export function resolveTransactionSkillScriptPaths(): { diagnose: string; inspect: string } {
  const packageJson = require.resolve('@orbitrelaylabs/xxyy-transaction-skills/package.json');
  const root = path.dirname(packageJson);
  return {
    diagnose: path.join(root, 'skills/xxyy-transaction-diagnosis/scripts/diagnose.mjs'),
    inspect: path.join(root, 'skills/onchain-transaction-inspector/scripts/inspect.mjs'),
  };
}

export async function resolveExplorerBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const { access } = await import('node:fs/promises');
  const configured = env.XXYY_SCREENSHOT_CHROME_EXECUTABLE?.trim();
  const candidates = (
    configured
      ? [configured]
      : [
          process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : undefined,
          process.platform === 'darwin'
            ? '/Applications/Chromium.app/Contents/MacOS/Chromium'
            : undefined,
          process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : undefined,
          process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
          process.platform === 'linux' ? '/usr/bin/chromium' : undefined,
          process.platform === 'linux' ? '/usr/bin/chromium-browser' : undefined,
        ]
  ).filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const resolved = path.resolve(candidate);
      if (await isChromeExecutable(resolved)) return resolved;
    } catch {
      // Try the next fixed local browser location.
    }
  }
  return undefined;
}

function isChromeExecutable(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: 2_000 }, (error, stdout, stderr) => {
      resolve(
        error === null &&
          /(?:Google Chrome|Chromium|Chrome for Testing)/iu.test(`${stdout}${stderr}`),
      );
    });
  });
}

async function runJsonCli(
  scriptPath: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', browserFetchShim, scriptPath, ...args], {
      env: createSkillEnvironment(options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const abort = (): void => {
      child.kill('SIGTERM');
      finish(new DOMException('Transaction Skill invocation was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`Transaction Skill exceeded ${options.timeoutMs} ms.`));
    }, options.timeoutMs);
    timer.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_STDOUT_BYTES) {
        child.kill('SIGTERM');
        finish(new Error('Transaction Skill stdout exceeded the configured limit.'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr = Buffer.concat([stderr, chunk]);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.toString('utf8'));
      } catch {
        finish(new Error('Transaction Skill returned invalid JSON.'));
        return;
      }
      if (code === 0) {
        finish(undefined, parsed);
        return;
      }
      const message = extractCliError(parsed) ?? stderr.toString('utf8').trim();
      finish(classifyCliError(message));
    });
  });
}

function createSkillEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    ALLOWED_ENV_KEYS.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]] as const],
    ),
  );
  environment.PATH = [bundledBrowserDriverDirectory, source.PATH]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(path.delimiter);
  return environment;
}

function extractCliError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('error' in value)) return undefined;
  const error = value.error;
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
  return typeof error.message === 'string' ? error.message : undefined;
}

function classifyCliError(message: string): Error {
  if (message.toLowerCase().includes('verification')) {
    return new ExplorerBrowserVerificationError();
  }
  if (/xxyy-chrome-driver|Chrome or Chromium is required/iu.test(message)) {
    return new ExplorerBrowserUnavailableError();
  }
  return new Error(message || 'Transaction Skill failed.');
}
