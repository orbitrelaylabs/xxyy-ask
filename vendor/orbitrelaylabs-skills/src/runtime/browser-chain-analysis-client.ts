import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readlink, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import { transactionAnalysisResultSchema } from '../transaction-analysis/index.js';
import { z } from 'zod';

import {
  getTransactionOutputSchema,
  type GetTransactionOutput,
  type PublicTransactionClient,
} from './public-transaction-contracts.js';
import { resolvePublicTransactionReference } from './transaction-reference.js';
import { solanaSignatureSchema } from './solana-browser-contracts.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const EXPLORER_VERIFICATION_EXPRESSION = `(() => {
  const state = ((document.title || '') + '\\n' + (document.body?.innerText || '')).trim();
  return /Just a moment|security verification|安全验证|Checking your browser|Verify you are human|Attention Required|Sorry, you have been blocked/i.test(state);
})()`;
const SOLSCAN_ORIGIN = 'https://solscan.io';
const SOLSCAN_API_ORIGIN = 'https://api-v2.solscan.io';
const BLOCKSCOUT_ORIGINS: Readonly<Record<string, string>> = {
  'eip155:1': 'https://eth.blockscout.com',
  'eip155:8453': 'https://base.blockscout.com',
  'eip155:4663': 'https://robinhoodchain.blockscout.com',
};
const SCAN_ORIGINS: Readonly<Record<string, string>> = {
  'eip155:56': 'https://bscscan.com',
  'eip155:988': 'https://stablescan.xyz',
};

export class ExplorerBrowserVerificationError extends Error {
  readonly code = 'explorer_verification_required';

  constructor(host?: string, taskName?: string) {
    super(
      host === undefined
        ? 'Explorer browser requires interactive verification.'
        : `Explorer browser requires interactive verification for ${host}${taskName === undefined ? '' : ` in browser session ${taskName}`}.`,
    );
    this.name = 'ExplorerBrowserVerificationError';
  }
}

export class ExplorerBrowserUnavailableError extends Error {
  readonly code = 'explorer_browser_unavailable';

  constructor() {
    super('xxyy-chrome-driver with Chrome or Chromium is required for public Explorer queries.');
    this.name = 'ExplorerBrowserUnavailableError';
  }
}

const browserTransactionSchema = z
  .object({
    accountKeys: z.array(z.string()).max(512),
    blockTime: z.number().int().nonnegative().optional(),
    computeUnitsConsumed: z.union([z.string(), z.number()]).optional(),
    executionStatus: z.enum(['reverted', 'success', 'unknown']),
    feeLamports: z.union([z.string(), z.number()]).optional(),
    logCount: z.number().int().nonnegative(),
    nativeChanges: z
      .array(z.object({ account: z.string(), delta: z.union([z.string(), z.number()]) }))
      .max(512),
    programIds: z.array(z.string()).max(512),
    slot: z.union([z.string(), z.number()]),
    tokenChanges: z
      .array(
        z.object({
          account: z.string().optional(),
          decimals: z.number().int().nonnegative(),
          delta: z.union([z.string(), z.number()]),
          mint: z.string(),
          owner: z.string().optional(),
          programId: z.string().optional(),
        }),
      )
      .max(1_024),
    transactionId: z.string(),
  })
  .strict();

const browserEvmTransactionSchema = z
  .object({
    accountAddresses: z.array(z.string()).max(1_024),
    blockNumber: z.union([z.string(), z.number()]),
    failureReason: z.string().trim().min(1).max(1_000).optional(),
    feeWei: z.string(),
    from: z.string(),
    hash: z.string(),
    rawInput: z.string(),
    swapPools: z
      .array(
        z
          .object({
            amount0Raw: z
              .string()
              .regex(/^-?(?:0|[1-9]\d*)$/u)
              .optional(),
            amount1Raw: z
              .string()
              .regex(/^-?(?:0|[1-9]\d*)$/u)
              .optional(),
            emitterAddress: z.string().regex(/^0x[0-9a-f]{40}$/iu),
            logIndex: z.number().int().nonnegative(),
            poolIdentifier: z.string().regex(/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu),
          })
          .strict(),
      )
      .max(128),
    status: z.enum(['reverted', 'success', 'unknown']),
    timestamp: z.string(),
    to: z.string().nullable(),
    tokenAddresses: z.array(z.string()).max(512),
    tokenTransfers: z
      .array(
        z.object({
          amountRaw: z.string(),
          from: z.string(),
          logIndex: z.number().int().nonnegative(),
          to: z.string(),
          tokenAddress: z.string(),
        }),
      )
      .max(500),
    valueWei: z.string(),
  })
  .strict();

export interface CreateBrowserChainAnalysisClientOptions {
  pageEvaluator?: BrowserPageEvaluator;
  timeoutMs?: number;
}

export type BrowserPageEvaluator = (input: {
  expression?: string;
  fetchUrl?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  url: string;
}) => Promise<unknown>;

/**
 * Fixed-origin, read-only Explorer evidence for every XXYY-supported chain. This deliberately
 * exposes only getTransaction; trace and MEV calls remain unavailable because browser pages are
 * partial evidence.
 */
export function createBrowserChainAnalysisClient(
  options: CreateBrowserChainAnalysisClientOptions,
): PublicTransactionClient {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const pageEvaluator = options.pageEvaluator ?? createChromeBrowserPageEvaluator();
  let browserQueue: Promise<void> = Promise.resolve();
  return {
    async close() {},
    async getTransaction(input, requestOptions = {}) {
      const reference = resolvePublicTransactionReference(input);
      const load = browserQueue.then(
        () =>
          loadBrowserTransaction({
            reference,
            pageEvaluator,
            timeoutMs,
            ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          }),
        () =>
          loadBrowserTransaction({
            reference,
            pageEvaluator,
            timeoutMs,
            ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          }),
      );
      browserQueue = load.then(
        () => undefined,
        () => undefined,
      );
      return await load;
    },
  };
}

async function loadBrowserTransaction(input: {
  reference: ReturnType<typeof resolvePublicTransactionReference>;
  pageEvaluator: BrowserPageEvaluator;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<GetTransactionOutput> {
  if (input.reference.family === 'solana') {
    return await loadSolscanTransaction({ ...input, reference: input.reference });
  }
  const blockscoutOrigin = BLOCKSCOUT_ORIGINS[input.reference.network];
  if (blockscoutOrigin !== undefined) {
    return await loadBlockscoutTransaction({
      ...input,
      origin: blockscoutOrigin,
      reference: input.reference,
    });
  }
  const scanOrigin = SCAN_ORIGINS[input.reference.network];
  if (scanOrigin !== undefined) {
    return await loadScanPageTransaction({
      ...input,
      origin: scanOrigin,
      reference: input.reference,
    });
  }
  throw new Error(`Browser evidence is unavailable for ${input.reference.network}.`);
}

export async function resolveBrowserChromeExecutable(
  configured?: string,
): Promise<string | undefined> {
  const candidates = [
    configured?.trim(),
    process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined,
    process.platform === 'darwin'
      ? '/Applications/Chromium.app/Contents/MacOS/Chromium'
      : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : undefined,
    process.platform === 'linux' ? '/usr/bin/chromium' : undefined,
    process.platform === 'linux' ? '/usr/bin/chromium-browser' : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {
      // Try the next fixed local browser location.
    }
  }
  return undefined;
}

export async function resolveExplorerBrowserDriverExecutable(
  pathValue: string | undefined = process.env.PATH,
): Promise<string | undefined> {
  if (pathValue === undefined || pathValue.trim().length === 0) return undefined;
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, 'xxyy-chrome-driver');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching the configured PATH.
    }
  }
  return undefined;
}

export function createChromeBrowserPageEvaluator(
  options: {
    command?: string;
    taskName?: string;
  } = {},
): BrowserPageEvaluator {
  const command = options.command?.trim() || 'xxyy-chrome-driver';
  const taskName = options.taskName?.trim() || 'xxyy-public-explorer';
  return async (input) => {
    try {
      return await evaluateChromeBrowserPage(command, taskName, input);
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        throw new ExplorerBrowserUnavailableError();
      }
      throw error;
    }
  };
}

async function evaluateChromeBrowserPage(
  command: string,
  taskName: string,
  input: Parameters<BrowserPageEvaluator>[0],
): Promise<unknown> {
  if ((input.expression === undefined) === (input.fetchUrl === undefined)) {
    throw new TypeError('Browser page evaluation requires exactly one expression or fetchUrl.');
  }
  const nonce = randomUUID();
  const marker = '__XXYY_BROWSER_RESULT_' + nonce + '__:';
  const timeoutSeconds = Math.max(5, Math.ceil(input.timeoutMs / 1_000));
  const script = [
    'const task = await useOrCreateTaskSpace(' + JSON.stringify(taskName) + ')',
    'let payload',
    'try {',
    '  await openOrReuseTab(' +
      JSON.stringify(input.url) +
      ', {wait:true, timeout:' +
      timeoutSeconds +
      '})',
    '  const verificationRequiredBeforeRead = await js(' +
      JSON.stringify(EXPLORER_VERIFICATION_EXPRESSION) +
      ')',
    "  if (verificationRequiredBeforeRead) throw new Error('verification_required')",
    ...(input.fetchUrl === undefined
      ? [
          '  const deadline = Date.now() + ' + input.timeoutMs,
          '  let value',
          '  while (Date.now() < deadline) {',
          '    value = await js(' + JSON.stringify(input.expression) + ')',
          '    if (value !== null && value !== undefined) break',
          '    await wait(0.25)',
          '  }',
        ]
      : [
          '  const responseBody = await browserFetch(' + JSON.stringify(input.fetchUrl) + ')',
          "  const value = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody",
        ]),
    '  const verificationRequired = value === null || value === undefined ? await js(' +
      JSON.stringify(EXPLORER_VERIFICATION_EXPRESSION) +
      ') : false',
    "  payload = value === null || value === undefined ? {ok:false, error:verificationRequired ? 'verification_required' : 'page_evidence_timeout'} : {ok:true, value}",
    '} catch (error) {',
    "  payload = {ok:false, error:error?.message === 'verification_required' ? 'verification_required' : 'page_evaluation_failed'}",
    '}',
    'const serialized = JSON.stringify(payload)',
    'const totalChunks = Math.max(1, Math.ceil(serialized.length / 400))',
    'for (let index = 0; index < totalChunks; index += 1) {',
    '  cliLog(' +
      JSON.stringify(marker) +
      " + index + ':' + totalChunks + ':' + serialized.slice(index * 400, (index + 1) * 400))",
    '}',
  ].join('\n');
  const child = spawn(command, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const maxOutputBytes = 4 * 1_048_576;
  let outputBytes = 0;
  const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += buffer.byteLength;
    if (outputBytes > maxOutputBytes) {
      child.kill('SIGTERM');
      return;
    }
    target.push(buffer);
  };
  child.stdout?.on('data', collect(stdout));
  child.stderr?.on('data', collect(stderr));
  child.stdin?.end(script);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Chrome browser page evaluation timed out.'));
    }, input.timeoutMs + 10_000);
    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error('Chrome browser page evaluation was aborted.'));
    };
    child.once('error', (error) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abort);
      if (outputBytes > maxOutputBytes) {
        reject(new Error('Chrome browser page evaluation output was too large.'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error('Chrome browser page evaluation failed.'));
      }
    });
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted === true) abort();
  });
  const text = Buffer.concat([...stdout, ...stderr]).toString('utf8');
  const chunks = text
    .split(/\r?\n/u)
    .flatMap((line) => {
      const markerIndex = line.indexOf(marker);
      if (markerIndex < 0) return [];
      const value = line.slice(markerIndex + marker.length);
      const match = value.match(/^(\d+):(\d+):(.*)$/u);
      return match === null
        ? []
        : [{ index: Number(match[1]), total: Number(match[2]), value: match[3] }];
    })
    .sort((left, right) => left.index - right.index);
  const expectedChunks = chunks[0]?.total;
  if (
    expectedChunks === undefined ||
    chunks.length !== expectedChunks ||
    chunks.some((chunk, index) => chunk.index !== index || chunk.total !== expectedChunks)
  ) {
    throw new Error('Chrome browser page evaluation omitted its result.');
  }
  const payloadText = chunks.map((chunk) => chunk.value).join('');
  const payload = JSON.parse(payloadText) as unknown;
  if (isRecord(payload) && payload.error === 'verification_required') {
    throw new ExplorerBrowserVerificationError(new URL(input.url).hostname, taskName);
  }
  if (!isRecord(payload) || payload.ok !== true || !('value' in payload)) {
    throw new Error('Chrome browser page evaluation returned no evidence.');
  }
  return payload.value;
}

async function loadBlockscoutTransaction(input: {
  origin: string;
  pageEvaluator: BrowserPageEvaluator;
  reference: Extract<ReturnType<typeof resolvePublicTransactionReference>, { family: 'evm' }>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<GetTransactionOutput> {
  const apiUrl = `${input.origin}/api/v2/transactions/${input.reference.transactionId}`;
  const explorerUrl = `${input.origin}/tx/${input.reference.transactionId}`;
  const raw = await input.pageEvaluator({ ...input, fetchUrl: apiUrl, url: explorerUrl });
  if (!isRecord(raw)) throw new Error('Blockscout browser page returned invalid JSON.');
  const transfers = Array.isArray(raw.token_transfers) ? raw.token_transfers : [];
  const tokenTransfers = transfers.flatMap((item) => {
    if (!isRecord(item) || !isRecord(item.from) || !isRecord(item.to) || !isRecord(item.token)) {
      return [];
    }
    const total = isRecord(item.total) ? item.total : undefined;
    return typeof item.from.hash === 'string' &&
      typeof item.to.hash === 'string' &&
      typeof item.token.address_hash === 'string' &&
      typeof total?.value === 'string' &&
      typeof item.log_index === 'number'
      ? [
          {
            amountRaw: total.value,
            from: item.from.hash,
            logIndex: item.log_index,
            to: item.to.hash,
            tokenAddress: item.token.address_hash,
          },
        ]
      : [];
  });
  const from = addressHash(raw.from);
  const to = raw.to === null ? null : addressHash(raw.to);
  const fee = isRecord(raw.fee) && typeof raw.fee.value === 'string' ? raw.fee.value : undefined;
  const parsed = browserEvmTransactionSchema.parse({
    accountAddresses: unique([
      from,
      ...(to === null ? [] : [to]),
      ...tokenTransfers.flatMap((transfer) => [transfer.from, transfer.to, transfer.tokenAddress]),
    ]),
    blockNumber: raw.block_number,
    ...(typeof raw.revert_reason === 'string' && raw.revert_reason.trim().length > 0
      ? { failureReason: raw.revert_reason.trim() }
      : {}),
    feeWei: fee ?? '0',
    from,
    hash: raw.hash,
    rawInput: typeof raw.raw_input === 'string' ? raw.raw_input : '0x',
    swapPools: [],
    status:
      raw.status === 'ok' || raw.result === 'success'
        ? 'success'
        : raw.status === 'error' || raw.result === 'error'
          ? 'reverted'
          : 'unknown',
    timestamp: raw.timestamp,
    to,
    tokenAddresses: unique(tokenTransfers.map((transfer) => transfer.tokenAddress)),
    tokenTransfers,
    valueWei: typeof raw.value === 'string' ? raw.value : '0',
  });
  assertEvmTransactionMatch(parsed.hash, input.reference.transactionId);
  return projectEvmBrowserTransaction(parsed, input.reference, explorerUrl, 'blockscout_browser');
}

async function loadScanPageTransaction(input: {
  origin: string;
  pageEvaluator: BrowserPageEvaluator;
  reference: Extract<ReturnType<typeof resolvePublicTransactionReference>, { family: 'evm' }>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<GetTransactionOutput> {
  const explorerUrl = `${input.origin}/tx/${input.reference.transactionId}`;
  const expression = createScanPageTransactionExpression();
  const raw = await input.pageEvaluator({ ...input, expression, url: explorerUrl });
  if (isRecord(raw) && raw.blocked === true) {
    throw new ExplorerBrowserVerificationError(new URL(explorerUrl).hostname);
  }
  const parsed = browserEvmTransactionSchema.parse(raw);
  assertEvmTransactionMatch(parsed.hash, input.reference.transactionId);
  return projectEvmBrowserTransaction(parsed, input.reference, explorerUrl, 'scan_browser');
}

export function createScanPageTransactionExpression(): string {
  return `(() => {
    const text = (document.body?.innerText || '').replace(/\\r/g, '');
    const pageState = ((document.title || '') + '\\n' + text).trim();
    if (/Attention Required|Sorry, you have been blocked/i.test(pageState)) return {blocked:true};
    if (/Just a moment|security verification|安全验证|Checking your browser|Verify you are human/i.test(pageState)) return null;
    const addressLinks = [...document.querySelectorAll('a[href*="/address/0x"]')].map((a) => (a.getAttribute('href') || '').match(/\\/address\\/(0x[0-9a-f]{40})/i)?.[1]).filter(Boolean);
    const tokenLinks = [...document.querySelectorAll('a[href*="/token/0x"]')].map((a) => (a.getAttribute('href') || '').match(/\\/token\\/(0x[0-9a-f]{40})/i)?.[1]).filter(Boolean);
    const hash = location.pathname.match(/\\/tx\\/(0x[0-9a-f]{64})/i)?.[1];
    const block = text.match(/(?:Block|区块)\\s*(?:Height)?\\s*[:#]?\\s*([0-9,]+)/i)?.[1]?.replace(/,/g, '');
    const timestampText = text.match(/[A-Z][a-z]{2}-\\d{2}-\\d{4}\\s+\\d{1,2}:\\d{2}:\\d{2}\\s+[AP]M\\s+\\+UTC/)?.[0] || '';
    const unix = text.match(/\\((\\d{10})\\)/)?.[1];
    const feeEth = text.match(/(?:Transaction Fee|Txn Fee|交易费用)[^0-9]*([0-9]+(?:\\.[0-9]+)?)/i)?.[1];
    const valueEth = text.match(/(?:Value|价值)[^0-9]*([0-9]+(?:\\.[0-9]+)?)/i)?.[1];
    const statusText = text.match(/(?:Status|状态)\\s*[:]?\\s*([^\\n]+)/i)?.[1] || '';
    const executionErrorText = text.match(/(?:Warning!\\s*)?Error encountered during contract execution\\s*\\[([^\\]]+)\\]/i)?.[1] || '';
    const reverted = /fail|error|revert|失败/i.test(statusText) || executionErrorText.length > 0;
    const failureReason = reverted
      ? (/fail|error|revert|失败/i.test(statusText) ? statusText.trim() : executionErrorText.trim())
      : '';
    const toWei = (value) => {
      if (!value) return '0';
      const [whole, fraction=''] = value.split('.');
      return (BigInt(whole || '0') * 1000000000000000000n + BigInt((fraction + '000000000000000000').slice(0,18))).toString();
    };
    const fromMatch = text.match(/(?:^|\\n)From:\\s*\\n(0x[0-9a-f]{40})/i)?.[1];
    const toMatch = text.match(/(?:^|\\n)To:\\s*\\n(0x[0-9a-f]{40})/i)?.[1];
    const actionTokenLinks = [...document.querySelectorAll('a[href^="/token/"]')].flatMap((anchor) => {
      const href = anchor.getAttribute('href') || '';
      const token = href.match(/^\\/token\\/(0x[0-9a-f]{40})$/i)?.[1];
      if (!token) return [];
      let node = anchor;
      for (let index = 0; index < 3 && node.parentElement; index += 1) {
        const actionText = (node.textContent || '').replace(/\\s+/g, ' ').trim();
        const looksLikeTransferRow = /(?:^|\\s)(?:From|To|received|sent)(?:\\s|$)/i.test(actionText);
        if (/(?:^|\\s)Swap(?:\\s|$)/i.test(actionText) && !looksLikeTransferRow && actionText.length < 800) return [token];
        node = node.parentElement;
      }
      return [];
    });
    const actorReceivedTokens = fromMatch ? [...document.querySelectorAll('a[href^="/token/"]')].flatMap((anchor) => {
      const href = anchor.getAttribute('href') || '';
      const token = href.match(/^\\/token\\/(0x[0-9a-f]{40})/i)?.[1];
      let owner;
      try { owner = new URL(href, location.origin).searchParams.get('a'); } catch {}
      if (!token || owner?.toLowerCase() !== fromMatch.toLowerCase()) return [];
      let row = anchor;
      for (let index = 0; index < 4 && row.parentElement; index += 1) {
        const rowText = (row.textContent || '').replace(/\\s+/g, ' ').trim();
        if (/received|接收|收到/i.test(rowText) && rowText.length < 600) return [token];
        row = row.parentElement;
      }
      return [];
    }) : [];
    const excludedAddresses = new Set([fromMatch, toMatch].filter(Boolean).map((value) => value.toLowerCase()));
    const textAddresses = [...text.matchAll(/\\b0x[0-9a-f]{40}\\b/gi)]
      .map((match) => match[0])
      .filter((address) => !excludedAddresses.has(address.toLowerCase()));
    const targetTokenLinks = actionTokenLinks.length > 0
      ? [...new Set(actionTokenLinks)].slice(0, 1)
      : [...new Set([...actorReceivedTokens, ...tokenLinks, ...textAddresses])];
    const eventLogRows = [...document.querySelectorAll('#eventlog-tab-content [id^="logI_"], [id^="logI_"]')];
    const eventLogTab = document.querySelector?.('#eventlog-tab');
    const eventLogTabActive = eventLogTab?.getAttribute('aria-selected') === 'true' || eventLogTab?.classList?.contains('active');
    if (eventLogTab && eventLogRows.length === 0 && !eventLogTabActive) {
      eventLogTab.click();
      return null;
    }
    const swapPools = eventLogRows.flatMap((row) => {
      const rowText = (row.textContent || '').replace(/\\r/g, '').trim();
      if (!/(?:^|\\s)Name\\s*Swap\\s*\\(/i.test(rowText)) return [];
      const logIndex = Number((row.getAttribute('id') || '').match(/^logI_(\\d+)$/i)?.[1]);
      const emitterAddress = [...row.querySelectorAll('a[href*="/address/0x"]')]
        .map((anchor) => (anchor.getAttribute('href') || '').match(/\\/address\\/(0x[0-9a-f]{40})/i)?.[1])
        .find(Boolean) || rowText.match(/(?:^|\\s)Address\\s+(0x[0-9a-f]{40})/i)?.[1];
      const poolId = rowText.match(/:\\s*id\\s+DecDecode\\s+Hex\\s+(?:0x)?([0-9a-f]{64})/i)?.[1];
      const amount0Raw = rowText.match(/amount0\\s*\\(int\\d+\\)\\s*:\\s*(-?\\d+)/i)?.[1];
      const amount1Raw = rowText.match(/amount1\\s*\\(int\\d+\\)\\s*:\\s*(-?\\d+)/i)?.[1];
      if (!Number.isSafeInteger(logIndex) || !emitterAddress) return [];
      return [{...(amount0Raw ? {amount0Raw} : {}), ...(amount1Raw ? {amount1Raw} : {}), emitterAddress, logIndex, poolIdentifier:poolId ? '0x' + poolId : emitterAddress}];
    });
    if (!hash || !block || (!fromMatch && addressLinks.length === 0)) return null;
    return {
      accountAddresses:[...new Set([fromMatch || addressLinks[0], toMatch || addressLinks[1], ...swapPools.map((pool) => pool.poolIdentifier)].filter(Boolean))], blockNumber:block, feeWei:toWei(feeEth),
      ...(failureReason ? {failureReason} : {}), from:fromMatch || addressLinks[0], hash, rawInput:'0x',
      swapPools,
      status:/success|成功/i.test(statusText)?'success':reverted?'reverted':'unknown',
      timestamp:unix ? new Date(Number(unix)*1000).toISOString() : timestampText ? new Date(timestampText.replace('+UTC','UTC')).toISOString() : new Date().toISOString(),
      to:toMatch || addressLinks[1] || null, tokenAddresses:targetTokenLinks, tokenTransfers:[], valueWei:toWei(valueEth)
    };
  })()`;
}

function projectEvmBrowserTransaction(
  parsed: z.output<typeof browserEvmTransactionSchema>,
  reference: Extract<ReturnType<typeof resolvePublicTransactionReference>, { family: 'evm' }>,
  explorerUrl: string,
  source: string,
): GetTransactionOutput {
  const evidenceId = 'browser.transaction';
  const findingId = 'browser_transaction_facts';
  const observedAt = new Date().toISOString();
  const blockTimestamp = Math.floor(Date.parse(parsed.timestamp) / 1_000).toString();
  const analysis = transactionAnalysisResultSchema.parse({
    assetChanges: [],
    conflicts: [],
    diagnostics: [],
    evidence: [
      {
        blockNumber: integerString(parsed.blockNumber),
        chainId: reference.chainId,
        confidence: 0.75,
        effectiveAt: parsed.timestamp,
        id: evidenceId,
        kind: 'transaction',
        observedAt,
        payloadHash: `sha256:${createHash('sha256').update(JSON.stringify(parsed)).digest('hex')}`,
        source,
        sourceUrl: explorerUrl,
        structuredData: {
          accountAddresses: parsed.accountAddresses,
          ...(parsed.failureReason === undefined ? {} : { failureReason: parsed.failureReason }),
          swapPools: parsed.swapPools,
          tokenAddresses: parsed.tokenAddresses,
        },
        supports: [findingId],
        transactionHash: reference.transactionId,
      },
    ],
    findings: [
      {
        confidence: 0.75,
        evidenceIds: [evidenceId],
        id: findingId,
        inference: false,
        statement: 'Transaction facts were read from a fixed public Explorer in a browser.',
      },
    ],
    skill: 'transaction_analysis',
    status: 'partial',
    summary: 'Browser Explorer returned partial single-source transaction facts.',
    timeline: [],
    tokenTransfers: parsed.tokenTransfers.map((transfer) => ({
      ...transfer,
      evidenceId,
      transferType: 'transfer' as const,
    })),
    transaction: {
      blockNumber: integerString(parsed.blockNumber),
      blockTimestamp,
      chainId: reference.chainId,
      executionStatus: parsed.status,
      ...(parsed.failureReason === undefined ? {} : { failureReason: parsed.failureReason }),
      feeWei: parsed.feeWei,
      from: parsed.from,
      hash: reference.transactionId,
      inputKind:
        parsed.rawInput === '0x'
          ? parsed.to === null
            ? 'unknown'
            : 'native_transfer'
          : parsed.to === null
            ? 'contract_creation'
            : 'contract_call',
      to: parsed.to,
      valueWei: parsed.valueWei,
    },
    version: '1.0.0',
    warnings: ['Explorer browser evidence is single-source and partial.'],
  });
  return getTransactionOutputSchema.parse({
    analysis,
    chainId: reference.chainId,
    diagnostics: [],
    explorerUrl,
    family: 'evm',
    network: reference.network,
    status: 'partial',
    summary: 'Transaction facts were read from a fixed Explorer browser page.',
    transactionId: reference.transactionId,
  });
}

function addressHash(value: unknown): string {
  if (!isRecord(value) || typeof value.hash !== 'string') {
    throw new Error('Explorer browser response omitted an address.');
  }
  return value.hash;
}

export function resolveSolanaBrowserTransactionId(reference: string, network?: string): string {
  const trimmed = reference.trim();
  if (
    network !== undefined &&
    !['sol', 'solana', 'solana:mainnet'].includes(network.toLowerCase())
  ) {
    throw new Error('Browser-only XXYY diagnosis currently supports Solana Explorer evidence.');
  }
  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'solscan.io' && url.hostname !== 'www.solscan.io') {
      throw new Error('Only fixed Solscan transaction pages are allowed in browser mode.');
    }
    const match = url.pathname.match(/^\/tx\/([^/]+)\/?$/u);
    if (match?.[1] === undefined) throw new Error('Expected a Solscan transaction URL.');
    candidate = decodeURIComponent(match[1]);
  } catch (error) {
    if (trimmed.includes('://')) throw error;
  }
  return solanaSignatureSchema.parse(candidate);
}

async function loadSolscanTransaction(input: {
  pageEvaluator: BrowserPageEvaluator;
  reference: Extract<ReturnType<typeof resolvePublicTransactionReference>, { family: 'solana' }>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<GetTransactionOutput> {
  const explorerUrl = `${SOLSCAN_ORIGIN}/tx/${input.reference.transactionId}`;
  const apiUrl = `${SOLSCAN_API_ORIGIN}/v2/transaction/detail?tx=${input.reference.transactionId}`;
  const response = await input.pageEvaluator({
    ...input,
    expression: createFixedBrowserFetchExpression(apiUrl),
    url: explorerUrl,
  });
  if (!isRecord(response) || typeof response.status !== 'number' || !('body' in response)) {
    throw new Error('Solscan browser response envelope was invalid.');
  }
  if (response.status === 400 && isSolscanTransactionNotFound(response.body)) {
    return getTransactionOutputSchema.parse({
      diagnostics: [
        {
          code: 'transaction_not_found',
          message: 'Solscan did not return this transaction.',
          severity: 'warning',
        },
      ],
      explorerUrl,
      family: 'solana',
      network: input.reference.network,
      status: 'insufficient_data',
      summary: 'The fixed Solscan page could not locate this transaction.',
      transactionId: input.reference.transactionId,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Solscan browser request failed with HTTP ${response.status}.`);
  }
  const payload = response.body;
  const parsed = browserTransactionSchema.parse(normalizeSolscanPayload(payload));
  if (parsed.transactionId !== input.reference.transactionId) {
    throw new Error('Solscan browser response transaction ID conflicted with the request.');
  }
  return projectTransaction(parsed, explorerUrl);
}

function createFixedBrowserFetchExpression(url: string): string {
  return `(async () => {
    const response = await fetch(${JSON.stringify(url)}, {credentials:'include'});
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return {status:response.status, body};
  })()`;
}

function isSolscanTransactionNotFound(value: unknown): boolean {
  if (!isRecord(value) || value.success !== false || !isRecord(value.errors)) return false;
  return value.errors.code === 2001 && value.errors.message === 'Transaction not found';
}

function assertEvmTransactionMatch(actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Explorer browser response transaction hash conflicted with the request.');
  }
}

export async function prepareBrowserProfile(profileDirectory: string): Promise<void> {
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(profileDirectory, 'SingletonLock');
  let owner: string;
  try {
    owner = await readlink(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }

  const separator = owner.lastIndexOf('-');
  const ownerHost = separator < 0 ? owner : owner.slice(0, separator);
  const ownerPid = separator < 0 ? Number.NaN : Number(owner.slice(separator + 1));
  if (ownerHost === hostname() && Number.isSafeInteger(ownerPid) && ownerPid > 0) {
    try {
      process.kill(ownerPid, 0);
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ESRCH') return;
    }
  }

  await Promise.all(
    ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].map(
      async (name) => {
        try {
          await unlink(path.join(profileDirectory, name));
        } catch (error) {
          if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
        }
      },
    ),
  );
}

export async function resolveExplorerChromeLaunch(
  chromeExecutable: string,
  chromeArguments: string[],
  options: { xvfbRunExecutable?: string } = {},
): Promise<{ arguments: string[]; command: string }> {
  const xvfbRunExecutable = options.xvfbRunExecutable ?? '/usr/bin/xvfb-run';
  try {
    await access(xvfbRunExecutable);
    return {
      arguments: [
        '-a',
        '--server-args=-screen 0 1600x1000x24 -nolisten tcp',
        chromeExecutable,
        ...chromeArguments,
      ],
      command: xvfbRunExecutable,
    };
  } catch {
    return { arguments: ['--headless=new', ...chromeArguments], command: chromeExecutable };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function projectTransaction(
  parsed: z.output<typeof browserTransactionSchema>,
  explorerUrl: string,
): GetTransactionOutput {
  const accountKeys = unique([
    ...parsed.accountKeys,
    ...parsed.tokenChanges.flatMap((change) => [
      ...(change.account === undefined ? [] : [change.account]),
      ...(change.owner === undefined ? [] : [change.owner]),
    ]),
  ]);
  const accountIndexes = new Map(accountKeys.map((address, index) => [address, index]));
  const payloadHash = `sha256:${createHash('sha256').update(JSON.stringify(parsed)).digest('hex')}`;
  return getTransactionOutputSchema.parse({
    analysis: {
      accountKeys,
      ...(parsed.blockTime === undefined
        ? {}
        : { blockTime: new Date(parsed.blockTime * 1_000).toISOString() }),
      ...(parsed.computeUnitsConsumed === undefined
        ? {}
        : { computeUnitsConsumed: integerString(parsed.computeUnitsConsumed) }),
      executionStatus: parsed.executionStatus,
      ...(parsed.feeLamports === undefined
        ? {}
        : { feeLamports: integerString(parsed.feeLamports) }),
      logCount: parsed.logCount,
      nativeBalanceChanges: parsed.nativeChanges.flatMap((change) => {
        const accountIndex = accountIndexes.get(change.account);
        return accountIndex === undefined
          ? []
          : [{ account: change.account, accountIndex, deltaLamports: integerString(change.delta) }];
      }),
      network: 'solana:mainnet',
      programIds: unique(parsed.programIds),
      slot: integerString(parsed.slot),
      sources: [
        {
          id: 'solscan_browser',
          kind: 'explorer_browser',
          observedAt: new Date().toISOString(),
          payloadHash,
          provenanceUrl: explorerUrl,
        },
      ],
      tokenBalanceChanges: parsed.tokenChanges.flatMap((change) => {
        const account = change.account ?? change.owner;
        const accountIndex = account === undefined ? undefined : accountIndexes.get(account);
        if (accountIndex === undefined) return [];
        return [
          {
            ...(change.account === undefined ? {} : { account: change.account }),
            accountIndex,
            decimals: change.decimals,
            deltaRaw: integerString(change.delta),
            mint: change.mint,
            ...(change.owner === undefined ? {} : { owner: change.owner }),
            ...(change.programId === undefined ? {} : { programId: change.programId }),
          },
        ];
      }),
      transactionId: parsed.transactionId,
    },
    diagnostics: [],
    explorerUrl,
    family: 'solana',
    network: 'solana:mainnet',
    status: 'partial',
    summary:
      'Transaction facts were read from the fixed Solscan page in a browser; evidence is partial and not an RPC consensus result.',
    transactionId: parsed.transactionId,
  });
}

function normalizeSolscanPayload(payload: unknown): unknown {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    throw new Error('Solscan browser response did not contain transaction data.');
  }
  const data = payload.data;
  const native = Array.isArray(data.sol_bal_change) ? data.sol_bal_change : [];
  const tokens = Array.isArray(data.token_bal_change) ? data.token_bal_change : [];
  const programs: string[] = [];
  collectProgramIds(data.parsed_instructions, programs);
  return {
    accountKeys: native.flatMap((item) =>
      isRecord(item) && typeof item.address === 'string' ? [item.address] : [],
    ),
    ...(typeof data.trans_time === 'number' && Number.isInteger(data.trans_time)
      ? { blockTime: data.trans_time }
      : {}),
    ...(integerValue(data.compute_units_consumed) === undefined
      ? {}
      : { computeUnitsConsumed: integerValue(data.compute_units_consumed) }),
    executionStatus:
      data.status === 'Fail' || data.status === 'failed'
        ? 'reverted'
        : data.status === 'Success' || data.status === 'success' || data.status === 1
          ? 'success'
          : 'unknown',
    ...(integerValue(data.fee) === undefined ? {} : { feeLamports: integerValue(data.fee) }),
    logCount: Array.isArray(data.log_message) ? data.log_message.length : 0,
    nativeChanges: native.flatMap((item) =>
      isRecord(item) &&
      typeof item.address === 'string' &&
      integerValue(item.change_amount) !== undefined
        ? [{ account: item.address, delta: integerValue(item.change_amount)! }]
        : [],
    ),
    programIds: unique(programs),
    slot: data.block_id,
    tokenChanges: tokens.flatMap((item) => {
      if (
        !isRecord(item) ||
        typeof item.token_address !== 'string' ||
        typeof item.decimals !== 'number' ||
        integerValue(item.change_amount) === undefined
      )
        return [];
      return [
        {
          ...(typeof item.address === 'string' ? { account: item.address } : {}),
          decimals: item.decimals,
          delta: integerValue(item.change_amount)!,
          mint: item.token_address,
          ...(typeof item.owner === 'string' ? { owner: item.owner } : {}),
          ...(typeof item.program_id === 'string' ? { programId: item.program_id } : {}),
        },
      ];
    }),
    transactionId: data.trans_id,
  };
}

function collectProgramIds(value: unknown, output: string[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.program_id === 'string') output.push(item.program_id);
    collectProgramIds(item.inner_instructions, output);
  }
}

function integerValue(value: unknown): string | number | undefined {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
    ? value
    : undefined;
}

function integerString(value: string | number): string {
  const string = String(value);
  if (!/^-?(?:0|[1-9]\d*)$/u.test(string))
    throw new Error('Explorer returned a non-integer value.');
  return string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be positive.`);
  return value;
}
