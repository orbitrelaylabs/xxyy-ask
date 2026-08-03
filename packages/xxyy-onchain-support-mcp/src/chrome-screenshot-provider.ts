import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { xxyyScreenshotArtifactSchema, type XxyyScreenshotEvidenceProvider } from './contracts.js';

const DEFAULT_CAPTURE_TIMEOUT_MS = 45_000;
const MAX_SCREENSHOT_BYTES = 10 * 1_048_576;

export interface CreateChromeXxyyScreenshotProviderOptions {
  artifactDirectory: string;
  chromeExecutable: string;
  timeoutMs?: number;
}

export function createChromeXxyyScreenshotProvider(
  options: CreateChromeXxyyScreenshotProviderOptions,
): XxyyScreenshotEvidenceProvider {
  const artifactDirectory = path.resolve(nonEmpty(options.artifactDirectory, 'artifactDirectory'));
  const chromeExecutable = path.resolve(nonEmpty(options.chromeExecutable, 'chromeExecutable'));
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS, 'timeoutMs');

  return {
    async capture(input, requestOptions = {}) {
      const sourceUrl = xxyyPairUrl(input.chain, input.pairAddress);
      const profileDirectory = await mkdtemp(path.join(tmpdir(), 'xxyy-screenshot-'));
      let chrome: ChildProcess | undefined;
      try {
        await mkdir(artifactDirectory, { recursive: true, mode: 0o750 });
        chrome = spawn(
          chromeExecutable,
          [
            '--headless=new',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-gpu',
            '--disable-sync',
            '--hide-scrollbars',
            '--no-default-browser-check',
            '--no-first-run',
            ...chromeRootSandboxFlags(),
            '--remote-debugging-port=0',
            `--user-data-dir=${profileDirectory}`,
            '--window-size=1600,1000',
            sourceUrl,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        const debuggerUrl = await readDebuggerUrl(chrome, timeoutMs, requestOptions.signal);
        const pageUrl = await findPageDebuggerUrl(debuggerUrl, timeoutMs, requestOptions.signal);
        const cdp = await createCdpClient(pageUrl, timeoutMs, requestOptions.signal);
        try {
          await cdp.call('Page.enable');
          await cdp.call('Runtime.enable');
          const highlighted = await pollForVerifiedRow({
            cdp,
            makerSuffix: input.maker.slice(-6),
            ...(input.nativeAmount === undefined ? {} : { nativeAmount: input.nativeAmount }),
            timeoutMs,
            ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
            ...(input.tokenAmount === undefined ? {} : { tokenAmount: input.tokenAmount }),
            transactionId: input.transactionId,
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.usdAmount === undefined ? {} : { usdAmount: input.usdAmount }),
          });
          if (!highlighted) {
            throw new Error(
              'The exact trade was verified by API but its visible XXYY row was absent.',
            );
          }
          const capture = await cdp.call('Page.captureScreenshot', {
            captureBeyondViewport: false,
            format: 'png',
            fromSurface: true,
          });
          const data = recordString(capture, 'data');
          const png = Buffer.from(data, 'base64');
          if (png.byteLength === 0 || png.byteLength > MAX_SCREENSHOT_BYTES) {
            throw new Error('XXYY screenshot size was invalid.');
          }
          const filename = `${createHash('sha256').update(input.transactionId).digest('hex')}.png`;
          const temporaryFile = path.join(artifactDirectory, `.${filename}.${randomUUID()}.tmp`);
          const finalFile = path.join(artifactDirectory, filename);
          await writeFile(temporaryFile, png, { flag: 'wx', mode: 0o640 });
          await rename(temporaryFile, finalFile);
          return xxyyScreenshotArtifactSchema.parse({
            capturedAt: new Date().toISOString(),
            maker: input.maker,
            mediaType: 'image/png',
            pairAddress: input.pairAddress,
            sourceUrl,
            title: 'XXYY verified trade-row evidence',
            transactionId: input.transactionId,
            url: `/xxyy-evidence/${filename}`,
          });
        } finally {
          cdp.close();
        }
      } finally {
        chrome?.kill('SIGTERM');
        await rm(profileDirectory, { force: true, recursive: true });
      }
    },
  };
}

function chromeRootSandboxFlags(): string[] {
  return typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
}

export function xxyyPairUrl(chain: string, pairAddress: string): string {
  const slug: Record<string, string> = {
    'eip155:1': 'eth',
    'eip155:56': 'bsc',
    'eip155:8453': 'base',
    'solana:mainnet': 'sol',
  };
  const route = slug[chain.trim().toLowerCase()];
  if (route === undefined || !/^[0-9A-Za-z]+$/u.test(pairAddress)) {
    throw new TypeError('XXYY screenshot source supports only fixed chain routes and pair ids.');
  }
  return `https://www.xxyy.io/${route}/${pairAddress}`;
}

export interface CdpClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void;
}

export async function readDebuggerUrl(
  process: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<URL> {
  const stderr = process.stderr;
  if (stderr === null) throw new Error('Chrome stderr was unavailable.');
  return await new Promise<URL>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(
      () => finish(new Error('Chrome debugger startup timed out.')),
      timeoutMs,
    );
    const abort = () => finish(new Error('XXYY screenshot capture was aborted.'));
    const exit = () => finish(new Error('Chrome exited before exposing its debugger.'));
    const data = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (buffer.length > 64_000) buffer = buffer.slice(-64_000);
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
      if (match?.[1] !== undefined) finish(undefined, new URL(match[1]));
    };
    const finish = (error?: Error, value?: URL) => {
      clearTimeout(timeout);
      stderr.off('data', data);
      process.off('exit', exit);
      signal?.removeEventListener('abort', abort);
      if (error === undefined && value !== undefined) resolve(value);
      else reject(error ?? new Error('Chrome debugger URL was missing.'));
    };
    stderr.on('data', data);
    process.once('exit', exit);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

export async function findPageDebuggerUrl(
  debuggerUrl: URL,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const endpoint = new URL('/json/list', `http://${debuggerUrl.host}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new Error('XXYY screenshot capture was aborted.');
    try {
      const response = await fetch(endpoint, signal === undefined ? {} : { signal });
      const targets = (await response.json()) as unknown;
      if (Array.isArray(targets)) {
        for (const target of targets) {
          if (
            isRecord(target) &&
            target.type === 'page' &&
            typeof target.webSocketDebuggerUrl === 'string'
          ) {
            return target.webSocketDebuggerUrl;
          }
        }
      }
    } catch {
      // Chrome may expose the browser debugger before the initial page target.
    }
    await delay(100, signal);
  }
  throw new Error('Chrome page debugger target was unavailable.');
}

export async function createCdpClient(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<CdpClient> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('CDP connection timed out.')), timeoutMs);
    const abort = () => finish(new Error('XXYY screenshot capture was aborted.'));
    const open = () => finish();
    const error = () => finish(new Error('CDP connection failed.'));
    const finish = (failure?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener('open', open);
      socket.removeEventListener('error', error);
      signal?.removeEventListener('abort', abort);
      failure === undefined ? resolve() : reject(failure);
    };
    socket.addEventListener('open', open, { once: true });
    socket.addEventListener('error', error, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: Record<string, unknown>) => void }
  >();
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as unknown;
    if (!isRecord(message)) return;
    if (typeof message.method === 'string') {
      const params = isRecord(message.params) ? message.params : {};
      for (const listener of listeners.get(message.method) ?? []) listener(params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    if (isRecord(message.error)) request.reject(new Error('CDP command failed.'));
    else request.resolve(isRecord(message.result) ? message.result : {});
  });
  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }, timeoutMs);
        pending.set(id, {
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
      for (const request of pending.values()) request.reject(new Error('CDP connection closed.'));
      pending.clear();
      listeners.clear();
    },
    on(method, listener) {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(method);
      };
    },
  };
}

async function pollForVerifiedRow(input: {
  cdp: CdpClient;
  makerSuffix: string;
  nativeAmount?: string;
  timeoutMs: number;
  timestamp?: number;
  tokenAmount?: string;
  transactionId: string;
  type?: 'buy' | 'sell';
  usdAmount?: string;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  const timeFragments = input.timestamp === undefined ? [] : timestampFragments(input.timestamp);
  const amountFragments = [input.tokenAmount, input.nativeAmount, input.usdAmount].flatMap(
    compactAmountFragments,
  );
  const expression = `(() => {
    const suffix = ${JSON.stringify(input.makerSuffix)};
    const tx = ${JSON.stringify(input.transactionId)};
    const side = ${JSON.stringify(input.type ?? '')};
    const times = ${JSON.stringify(timeFragments)};
    const amounts = ${JSON.stringify(amountFragments)};
    const nodes = [...document.querySelectorAll('body *')];
    const leaves = nodes.filter((node) => node.children.length === 0 && (node.textContent || '').trim().endsWith(suffix));
    const rows = [];
    for (const leaf of leaves) {
      let row = leaf;
      for (let i = 0; i < 8 && row.parentElement; i += 1) {
        const text = (row.textContent || '').trim();
        if (/\\b(?:Buy|Sell)\\b/i.test(text) && text.length < 1200) break;
        row = row.parentElement;
      }
      if (!rows.includes(row)) rows.push(row);
    }
    if (rows.length === 0) return false;
    const scored = rows.map((row) => {
      const text = (row.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      let score = 0;
      if (side && new RegExp('\\\\b' + side + '\\\\b', 'i').test(text)) score += 6;
      if (times.some((value) => text.includes(value.toLowerCase()))) score += 5;
      score += amounts.filter((value) => text.includes(value.toLowerCase())).length * 2;
      return {row, score};
    }).sort((a, b) => b.score - a.score);
    if (scored.length > 1 && scored[0].score === scored[1].score) return false;
    const row = scored[0].row;
    row.scrollIntoView({block: 'center', inline: 'nearest'});
    row.style.setProperty('outline', '4px solid #ff3b30', 'important');
    row.style.setProperty('outline-offset', '-4px', 'important');
    row.style.setProperty('box-shadow', '0 0 0 3px rgba(255,59,48,.35)', 'important');
    const badge = document.createElement('div');
    badge.textContent = 'Verified full tx: ' + tx.slice(0, 12) + '…' + tx.slice(-8);
    badge.style.cssText = 'position:fixed;left:20px;top:20px;z-index:2147483647;background:#ff3b30;color:white;padding:9px 14px;border-radius:6px;font:600 14px sans-serif';
    document.body.appendChild(badge);
    return true;
  })()`;
  while (Date.now() < deadline) {
    const result = await input.cdp.call('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    const remote = result.result;
    if (isRecord(remote) && remote.value === true) return true;
    await delay(250);
  }
  return false;
}

function timestampFragments(timestamp: number): string[] {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return [];
  return ['UTC', 'Asia/Shanghai'].flatMap((timeZone) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
        minute: '2-digit',
        month: '2-digit',
        second: '2-digit',
        timeZone,
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
    const time = `${parts.hour}:${parts.minute}:${parts.second}`;
    return [time, `${parts.month}-${parts.day} ${time}`];
  });
}

function compactAmountFragments(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  const numeric = Number(value);
  const normalized = value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
  const fragments = new Set([value, normalized]);
  if (Number.isFinite(numeric) && numeric >= 1_000) {
    for (const divisor of [
      { suffix: 'K', value: 1_000 },
      { suffix: 'M', value: 1_000_000 },
      { suffix: 'B', value: 1_000_000_000 },
    ]) {
      if (numeric >= divisor.value && numeric < divisor.value * 1_000) {
        fragments.add(`${Number((numeric / divisor.value).toFixed(2))}${divisor.suffix}`);
      }
    }
  }
  return [...fragments].filter((fragment) => fragment.length > 0);
}

function recordString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string') throw new Error(`CDP response omitted ${key}.`);
  return item;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timeout = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(new Error('XXYY screenshot capture was aborted.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new TypeError(`${label} is required.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be positive.`);
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
