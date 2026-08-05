import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { xxyyScreenshotArtifactSchema, type XxyyScreenshotEvidenceProvider } from './contracts.js';
import {
  prepareBrowserProfile,
  resolveExplorerChromeLaunch,
} from './browser-chain-analysis-client.js';

const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;
const MAX_SCREENSHOT_BYTES = 10 * 1_048_576;

export interface CreateChromeXxyyScreenshotProviderOptions {
  artifactDirectory: string;
  chromeExecutable: string;
  profileDirectory?: string;
  timeoutMs?: number;
}

export function createChromeXxyyScreenshotProvider(
  options: CreateChromeXxyyScreenshotProviderOptions,
): XxyyScreenshotEvidenceProvider {
  const artifactDirectory = path.resolve(nonEmpty(options.artifactDirectory, 'artifactDirectory'));
  const chromeExecutable = path.resolve(nonEmpty(options.chromeExecutable, 'chromeExecutable'));
  const persistentProfileDirectory =
    options.profileDirectory === undefined
      ? undefined
      : path.resolve(nonEmpty(options.profileDirectory, 'profileDirectory'));
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS, 'timeoutMs');
  let captureQueue = Promise.resolve();

  const capture = async (
    input: Parameters<XxyyScreenshotEvidenceProvider['capture']>[0],
    requestOptions: { signal?: AbortSignal } = {},
  ) => {
    const sourceUrl = xxyyPairUrl(input.chain, input.pairAddress);
    const profileDirectory =
      persistentProfileDirectory ?? (await mkdtemp(path.join(tmpdir(), 'xxyy-screenshot-')));
    const cacheDirectory = path.join(artifactDirectory, '.browser-cache');
    let chrome: ChildProcess | undefined;
    try {
      await Promise.all([
        mkdir(artifactDirectory, { recursive: true, mode: 0o750 }),
        mkdir(cacheDirectory, { recursive: true, mode: 0o750 }),
      ]);
      await prepareBrowserProfile(profileDirectory);
      const chromeArguments = [
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--enable-webgl',
        '--hide-scrollbars',
        '--ignore-gpu-blocklist',
        '--no-default-browser-check',
        '--no-first-run',
        '--use-gl=swiftshader',
        ...chromeRootSandboxFlags(),
        '--remote-debugging-port=0',
        `--disk-cache-dir=${cacheDirectory}`,
        `--user-data-dir=${profileDirectory}`,
        '--window-size=1600,1000',
        sourceUrl,
      ];
      const launch = await resolveExplorerChromeLaunch(chromeExecutable, chromeArguments);
      chrome = spawn(launch.command, launch.arguments, {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const debuggerUrl = await readDebuggerUrl(chrome, timeoutMs, requestOptions.signal);
      const pageUrl = await findPageDebuggerUrl(debuggerUrl, timeoutMs, requestOptions.signal);
      const cdp = await createCdpClient(pageUrl, timeoutMs, requestOptions.signal);
      try {
        await cdp.call('Page.enable');
        await cdp.call('Runtime.enable');
        await cdp.call('Page.bringToFront');
        await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
        await prepareNativeEvidencePage({
          cdp,
          input,
          timeoutMs,
        });
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
          title: 'XXYY native trade-row evidence',
          transactionId: input.transactionId,
          url: `/xxyy-evidence/${filename}`,
        });
      } finally {
        cdp.close();
      }
    } finally {
      await terminateChrome(chrome);
      if (persistentProfileDirectory === undefined) {
        await rm(profileDirectory, {
          force: true,
          maxRetries: 5,
          recursive: true,
          retryDelay: 100,
        });
      }
    }
  };

  return {
    capture(input, requestOptions = {}) {
      const result = captureQueue.then(() => capture(input, requestOptions));
      captureQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

async function prepareNativeEvidencePage(input: {
  cdp: CdpClient;
  input: Parameters<XxyyScreenshotEvidenceProvider['capture']>[0];
  timeoutMs: number;
}): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await input.cdp.call('Page.reload');
      await delay(500);
    }
    const klineReady = await waitForKlineReady({
      cdp: input.cdp,
      timeoutMs: Math.min(input.timeoutMs, attempt === 0 ? 30_000 : 20_000),
    });
    if (!klineReady && attempt === 0) {
      continue;
    }
    let highlighted = false;
    const filterWindows =
      input.input.timestamp === undefined ? [undefined] : [5_000, 15_000, 120_000];
    for (const windowMs of filterWindows) {
      if (input.input.timestamp !== undefined && windowMs !== undefined) {
        try {
          await applyNativeHistoricalFilter({
            cdp: input.cdp,
            timeoutMs: Math.min(input.timeoutMs, 10_000),
            timestamp: input.input.timestamp,
            windowMs,
          });
        } catch (error) {
          if (attempt === 0) continue;
          throw error;
        }
      }
      highlighted = await pollForVerifiedRow({
        cdp: input.cdp,
        makerSuffix: input.input.maker.slice(-6),
        ...(input.input.nativeAmount === undefined
          ? {}
          : { nativeAmount: input.input.nativeAmount }),
        timeoutMs: Math.min(input.timeoutMs, 8_000),
        ...(input.input.timestamp === undefined ? {} : { timestamp: input.input.timestamp }),
        ...(input.input.tokenAmount === undefined ? {} : { tokenAmount: input.input.tokenAmount }),
        ...(input.input.type === undefined ? {} : { type: input.input.type }),
        ...(input.input.usdAmount === undefined ? {} : { usdAmount: input.input.usdAmount }),
      });
      if (highlighted) break;
    }
    if (!highlighted) {
      throw new Error(
        'The exact trade was verified by API but its native XXYY trade row was not rendered.',
      );
    }
    if (
      !klineReady ||
      (await waitForKlineReady({
        cdp: input.cdp,
        timeoutMs: Math.min(input.timeoutMs, 5_000),
      }))
    ) {
      return;
    }
  }
  throw new Error('XXYY K-line data was not rendered after a bounded page retry.');
}

async function terminateChrome(process: ChildProcess | undefined): Promise<void> {
  if (process === undefined || process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signalBrowserProcess(process, 'SIGKILL');
      resolve();
    }, 2_000);
    process.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    signalBrowserProcess(process, 'SIGTERM');
  });
}

function signalBrowserProcess(process: ChildProcess, signal: NodeJS.Signals): void {
  if (process.pid !== undefined && globalThis.process.platform !== 'win32') {
    try {
      globalThis.process.kill(-process.pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child when its process group is already gone.
    }
  }
  process.kill(signal);
}

function chromeRootSandboxFlags(): string[] {
  return typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
}

export function xxyyPairUrl(chain: string, pairAddress: string): string {
  const slug: Record<string, string> = {
    'eip155:1': 'eth',
    'eip155:56': 'bsc',
    'eip155:988': 'stable',
    'eip155:4663': 'robin',
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
  type?: 'buy' | 'sell';
  usdAmount?: string;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  const timeFragments = input.timestamp === undefined ? [] : timestampFragments(input.timestamp);
  const amountFragments = [input.tokenAmount, input.nativeAmount, input.usdAmount].flatMap(
    compactAmountFragments,
  );
  const expression = buildVerifiedRowHighlightExpression({
    amountFragments,
    makerSuffix: input.makerSuffix,
    side: input.type ?? '',
    timeFragments,
  });
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

export function buildVerifiedRowHighlightExpression(input: {
  amountFragments: readonly string[];
  makerSuffix: string;
  side: '' | 'buy' | 'sell';
  timeFragments: readonly string[];
}): string {
  return `(async () => {
    const suffix = ${JSON.stringify(input.makerSuffix)};
    const side = ${JSON.stringify(input.side)};
    const times = ${JSON.stringify(input.timeFragments)};
    const amounts = ${JSON.stringify(input.amountFragments)};
    const dashboard = document.querySelector('.main-content .dashboard');
    if (dashboard) {
      const desiredHeight = Math.min(420, Math.max(360, Math.round(innerHeight * 0.4)));
      dashboard.style.setProperty('height', desiredHeight + 'px', 'important');
      dashboard.style.setProperty('flex-basis', desiredHeight + 'px', 'important');
    }
    const syncNativeTradeRows = () => {
      const root = document.querySelector('#app')?._vnode;
      if (!root) return -1;
      const seen = new Set();
      let component;
      const visit = (vnode) => {
        if (!vnode || typeof vnode !== 'object' || seen.has(vnode) || component) return;
        seen.add(vnode);
        if (vnode.component) {
          const candidate = vnode.component;
          const name = candidate.type && (candidate.type.name || candidate.type.__name);
          if (name === 'tradeTable') {
            component = candidate;
            return;
          }
          visit(candidate.subTree);
        }
        if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
        if (vnode.suspense) visit(vnode.suspense.activeBranch);
      };
      visit(root);
      const source = component && component.data && component.data.trades;
      const rendered = component && component.data && component.data.datas;
      if (!Array.isArray(source) || !Array.isArray(rendered)) return -1;
      const isTarget = (trade) => {
        const text = [trade.maker, trade.type, trade.tokenAmount, trade.nativeAmount, trade.usdAmount]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return text.includes(suffix.toLowerCase()) &&
          (!side || text.includes(side.toLowerCase())) &&
          (amounts.length === 0 || amounts.some((value) => text.includes(value.toLowerCase())));
      };
      const targetIndex = source.findIndex(isTarget);
      if (targetIndex < 0) return -1;
      if (!rendered.some(isTarget)) rendered.splice(0, rendered.length, ...source);
      return targetIndex;
    };
    const nativeTargetIndex = syncNativeTradeRows();
    if (nativeTargetIndex >= 0) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const nativeScroller = document.querySelector('.vue-recycle-scroller');
      const sampleRow = nativeScroller && nativeScroller.querySelector('.row');
      if (nativeScroller && sampleRow) {
        const rowHeight = Math.max(1, sampleRow.getBoundingClientRect().height);
        nativeScroller.scrollTop = Math.max(0, (nativeTargetIndex - 2) * rowHeight);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    }
    const findScoredRows = () => {
      const leaves = [...document.querySelectorAll('body *')].filter((node) => node.children.length === 0 && (node.textContent || '').trim().endsWith(suffix));
      const rows = [];
      for (const leaf of leaves) {
        const row = leaf.closest('.row');
        if (row && !rows.includes(row)) rows.push(row);
      }
      return rows.map((row) => {
        const text = (row.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        let score = 0;
        if (side && new RegExp('\\\\b' + side + '\\\\b', 'i').test(text)) score += 6;
        if (times.some((value) => text.includes(value.toLowerCase()))) score += 5;
        score += amounts.filter((value) => text.includes(value.toLowerCase())).length * 2;
        return {row, score};
      }).sort((a, b) => b.score - a.score);
    };
    let scored = findScoredRows();
    if (scored.length === 0) return false;
    if (scored.length > 1 && scored[0].score === scored[1].score) return false;
    let row = scored[0].row;
    const scroller = row.closest('.vue-recycle-scroller');
    if (!scroller) return false;
    const rowBox = row.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    scroller.scrollTop += rowBox.top + rowBox.height / 2 - (scrollerBox.top + scrollerBox.height / 2);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    scored = findScoredRows();
    if (scored.length === 0) return false;
    if (scored.length > 1 && scored[0].score === scored[1].score) return false;
    row = scored[0].row;
    const refreshedScroller = row.closest('.vue-recycle-scroller');
    if (!refreshedScroller) return false;
    const viewport = refreshedScroller.getBoundingClientRect();
    const visibleRows = [...refreshedScroller.querySelectorAll('.row')].filter((candidate) => {
      const box = candidate.getBoundingClientRect();
      return box.bottom > viewport.top && box.top < viewport.bottom;
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const targetIndex = visibleRows.indexOf(row);
    if (targetIndex < 2 || visibleRows.length - targetIndex - 1 < 2) return false;
    row.style.setProperty('outline', 'none', 'important');
    row.style.setProperty('box-shadow', 'inset 0 0 0 4px #ff3b30', 'important');
    return true;
  })()`;
}

async function waitForKlineReady(input: { cdp: CdpClient; timeoutMs: number }): Promise<boolean> {
  const expression = buildKlineReadinessExpression();
  const deadline = Date.now() + input.timeoutMs;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    const result = await input.cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    const remote = result.result;
    if (isRecord(remote) && remote.value === true) {
      stableSamples += 1;
      if (stableSamples >= 3) {
        await delay(500);
        return true;
      }
    } else {
      stableSamples = 0;
    }
    await delay(300);
  }
  return false;
}

export function buildKlineReadinessExpression(): string {
  return `(() => {
    const frame = [...document.querySelectorAll('.main-content iframe')]
      .find((candidate) => candidate.src.startsWith('blob:https://www.xxyy.io/'));
    const frameDocument = frame && frame.contentDocument;
    if (!frameDocument || frameDocument.readyState !== 'complete') return false;
    const text = (frameDocument.body && frameDocument.body.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!text || /No data here/i.test(text) || text.includes('∅')) return false;
    const hasOpen = /(?:开|open|\\bO)\\s*=?:?\\s*[-+]?\\d/i.test(text);
    const hasClose = /(?:收|close|\\bC)\\s*=?:?\\s*[-+]?\\d/i.test(text);
    if (!hasOpen || !hasClose) return false;
    const canvases = [...frameDocument.querySelectorAll('.pane canvas')];
    return canvases.some((canvas) => canvas.width >= 100 && canvas.height >= 100);
  })()`;
}

async function applyNativeHistoricalFilter(input: {
  cdp: CdpClient;
  timeoutMs: number;
  timestamp: number;
  windowMs: number;
}): Promise<void> {
  const expression = buildNativeHistoricalFilterExpression(input.timestamp, input.windowMs);
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const result = await input.cdp.call('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    const remote = result.result;
    if (isRecord(remote) && remote.value === true) return;
    await delay(250);
  }
  throw new Error('XXYY native historical trade filter was unavailable.');
}

export function buildNativeHistoricalFilterExpression(
  timestamp: number,
  windowMs = 120_000,
): string {
  const start = timestamp - windowMs;
  const end = timestamp + windowMs;
  return `(() => {
    if (document.hidden) return false;
    const root = document.querySelector('#app')?._vnode;
    if (!root) return false;
    const seen = new Set();
    let tradeTable;
    const visit = (vnode) => {
      if (!vnode || typeof vnode !== 'object' || seen.has(vnode) || tradeTable) return;
      seen.add(vnode);
      if (vnode.component) {
        const component = vnode.component;
        const name = component.type && (component.type.name || component.type.__name);
        if (name === 'tradeTable') {
          tradeTable = component.proxy;
          return;
        }
        visit(component.subTree);
      }
      if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
      if (vnode.suspense) visit(vnode.suspense.activeBranch);
    };
    visit(root);
    if (!tradeTable || !tradeTable.filters || typeof tradeTable.updateFilters !== 'function') {
      return false;
    }
    const current = tradeTable.filters;
    if (current.timeStart === ${start} && current.timeEnd === ${end}) return true;
    tradeTable.updateFilters({...current, timeStart:${start}, timeEnd:${end}});
    return true;
  })()`;
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
