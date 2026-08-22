import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const XXYY_ORIGIN = 'https://www.xxyy.io';
const MAX_BROWSER_OUTPUT_BYTES = 4 * 1_048_576;
const DEFAULT_TIMEOUT_MS = 45_000;
const driverExecutable = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bin/xxyy-chrome-driver.mjs',
);

export function createXxyyBrowserFetch(options = {}) {
  const originalFetch = options.originalFetch ?? globalThis.fetch;
  const evaluate = options.evaluate ?? evaluateWithChromeDriver;
  const targetTransactionId = options.targetTransactionId?.trim();
  const pairCache = new Map();
  const tradeCache = new Map();
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== XXYY_ORIGIN || !url.pathname.startsWith('/api/')) {
      return originalFetch(input, init);
    }
    if (url.pathname === '/api/data/search/v3' && request.method === 'GET') {
      const query = url.searchParams.get('q')?.trim();
      if (!query) return jsonResponse({ code: 0, data: { results: [] } });
      let pairs = pairCache.get(query);
      if (pairs === undefined) {
        pairs = normalizePairResults(
          await evaluate({
            expression: createXxyyPairSearchExpression(query),
            signal: request.signal,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            url: `${XXYY_ORIGIN}/`,
          }),
        );
        pairCache.set(query, pairs);
      }
      return jsonResponse({
        code: 0,
        data: { results: pairs.map((pairInfo) => ({ pairInfo })) },
      });
    }
    if (url.pathname === '/api/data/trades/search' && request.method === 'POST') {
      const body = await request.clone().json();
      const chain = normalizeXxyyChain(request.headers.get('x-chain'));
      const pairAddress = readIdentifier(body, 'pairAddress');
      const requestedTimeStart = readOptionalTimestamp(body, 'timeStart');
      const requestedTimeEnd = readOptionalTimestamp(body, 'timeEnd');
      const timeCenter =
        requestedTimeStart === undefined || requestedTimeEnd === undefined
          ? undefined
          : Math.floor((requestedTimeStart + requestedTimeEnd) / 2);
      const cacheKey = `${chain}\0${pairAddress}\0${timeCenter ?? ''}\0${targetTransactionId ?? ''}`;
      let trades = tradeCache.get(cacheKey);
      if (trades === undefined) {
        trades = normalizeTradeResults(
          await evaluate({
            expression: createXxyyTradeTableExpression({
              ...(targetTransactionId === undefined || targetTransactionId.length === 0
                ? {}
                : { targetTransactionId }),
              ...(timeCenter === undefined ? {} : { timeCenter }),
              ...(timeCenter !== undefined && targetTransactionId
                ? { windows: [2_000, 15_000, 120_000] }
                : {
                    ...(requestedTimeEnd === undefined ? {} : { timeEnd: requestedTimeEnd }),
                    ...(requestedTimeStart === undefined ? {} : { timeStart: requestedTimeStart }),
                  }),
            }),
            signal: request.signal,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            url: `${XXYY_ORIGIN}/${chain}/${pairAddress}`,
          }),
        );
        tradeCache.set(cacheKey, trades);
      }
      return jsonResponse({ code: 0, data: trades });
    }
    throw new Error(`Direct XXYY API access is disabled for ${url.pathname}.`);
  };
}

export function createXxyyPairSearchExpression(query) {
  return `(async () => {
    const findComponent = (name) => {
      const root = document.querySelector('#app')?._vnode;
      if (!root) return undefined;
      const seen = new Set();
      let found;
      const visit = (vnode) => {
        if (!vnode || typeof vnode !== 'object' || seen.has(vnode) || found) return;
        seen.add(vnode);
        if (vnode.component) {
          const component = vnode.component;
          const componentName = component.type && (component.type.name || component.type.__name);
          if (componentName === name) found = component;
          visit(component.subTree);
        }
        if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
        if (vnode.suspense) visit(vnode.suspense.activeBranch);
      };
      visit(root);
      return found;
    };
    const deadline = Date.now() + 25000;
    let component;
    while (Date.now() < deadline && !(component = findComponent('SearchDialog'))) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const proxy = component?.proxy;
    if (!proxy || !component.data || typeof proxy.search !== 'function') return null;
    component.data.keyword = ${JSON.stringify(query)};
    proxy.openDialog?.();
    proxy.search();
    await new Promise((resolve) => setTimeout(resolve, 800));
    while (Date.now() < deadline && proxy.isLoading) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (proxy.isLoading) return null;
    return Array.from(proxy.rawResults || []).slice(0, 64).flatMap((item) => {
      const pair = item?.pairInfo;
      if (!pair) return [];
      return [{
        address: pair.address,
        baseToken: pair.baseToken,
        chain: pair.chain,
        dexId: pair.dexId,
        liquidityUSD: pair.liquidityUSD,
        quoteToken: pair.quoteToken,
      }];
    });
  })()`;
}

export function createXxyyTradeTableExpression(input) {
  return `(async () => {
    const findComponent = (name) => {
      const root = document.querySelector('#app')?._vnode;
      if (!root) return undefined;
      const seen = new Set();
      let found;
      const visit = (vnode) => {
        if (!vnode || typeof vnode !== 'object' || seen.has(vnode) || found) return;
        seen.add(vnode);
        if (vnode.component) {
          const component = vnode.component;
          const componentName = component.type && (component.type.name || component.type.__name);
          if (componentName === name) found = component;
          visit(component.subTree);
        }
        if (Array.isArray(vnode.children)) vnode.children.forEach(visit);
        if (vnode.suspense) visit(vnode.suspense.activeBranch);
      };
      visit(root);
      return found;
    };
    const deadline = Date.now() + 20000;
    let component;
    while (Date.now() < deadline && !(component = findComponent('tradeTable'))) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const proxy = component?.proxy;
    if (!proxy || !component.data) return null;
    const projectTrades = (trades) => Array.from(trades || []).slice(0, 500).map((trade) => ({
          blockNumber: trade.blockNumber,
          logIndex: trade.logIndex,
          maker: trade.maker,
          marketCapUSD: trade.marketCapUSD,
          nativeAmount: trade.nativeAmount,
          timestamp: trade.timestamp,
          tokenAmount: trade.tokenAmount,
          txHash: trade.txHash,
          type: trade.type,
          usdAmount: trade.usdAmount,
        }));
    const readWindow = async (timeStart, timeEnd, targetTransactionId, maxWaitMs = 4500) => {
      if (
        timeStart !== undefined &&
        timeEnd !== undefined &&
        typeof proxy.updateFilters === 'function'
      ) {
        proxy.updateFilters({...proxy.filters, timeStart, timeEnd});
      }
      let observedLoading = component.data.loading === true;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const windowDeadline = Math.min(deadline, Date.now() + maxWaitMs);
      while (Date.now() < windowDeadline) {
        const trades = projectTrades(component.data.trades).filter(
          (trade) =>
            timeStart === undefined ||
            timeEnd === undefined ||
            (trade.timestamp >= timeStart && trade.timestamp <= timeEnd),
        );
        observedLoading ||= component.data.loading === true;
        if (
          trades.length > 0 &&
          (targetTransactionId === undefined ||
            trades.some((trade) => trade.txHash === targetTransactionId))
        ) {
          return trades;
        }
        if (
          component.data.loading === false &&
          (observedLoading ||
            (targetTransactionId === undefined && component.data.firstRequest === false))
        ) {
          return trades;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return [];
    };
    const targetTransactionId = ${JSON.stringify(input.targetTransactionId)};
    const timeCenter = ${input.timeCenter === undefined ? 'undefined' : input.timeCenter};
    const windows = ${JSON.stringify(input.windows ?? [])};
    if (targetTransactionId && timeCenter !== undefined && windows.length > 0) {
      let best = [];
      for (const [index, windowMs] of windows.entries()) {
        const trades = await readWindow(
          Math.max(0, timeCenter - windowMs),
          timeCenter + windowMs,
          targetTransactionId,
          2500,
        );
        const containsTarget = trades.some((trade) => trade.txHash === targetTransactionId);
        if (index === 0 && !containsTarget) return [];
        if (containsTarget && trades.length >= best.length) {
          best = trades;
        }
      }
      return best;
    }
    return readWindow(
      ${input.timeStart === undefined ? 'undefined' : input.timeStart},
      ${input.timeEnd === undefined ? 'undefined' : input.timeEnd},
      undefined,
    );
  })()`;
}

export async function evaluateWithChromeDriver(input) {
  const marker = `__XXYY_BROWSER_FETCH_${randomUUID()}__:`;
  const script = [
    'const task = await useOrCreateTaskSpace("xxyy-browser-market-data")',
    `await openOrReuseTab(${JSON.stringify(input.url)}, {wait:true, timeout:${Math.ceil(input.timeoutMs / 1_000)}})`,
    `value = await js(${JSON.stringify(input.expression)})`,
    `cliLog(${JSON.stringify(marker)} + index + ':' + totalChunks + ':' + serialized.slice(index * 400, (index + 1) * 400))`,
  ].join('\n');
  const child = spawn(process.execPath, [driverExecutable, 'nodejs'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  const collect = (target) => (chunk) => {
    const buffer = Buffer.from(chunk);
    outputBytes += buffer.byteLength;
    if (outputBytes <= MAX_BROWSER_OUTPUT_BYTES) target.push(buffer);
    else child.kill('SIGTERM');
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  child.stdin.end(script);
  const abort = () => child.kill('SIGTERM');
  input.signal?.addEventListener('abort', abort, { once: true });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('XXYY browser page evaluation timed out.'));
    }, input.timeoutMs + 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode ?? 1);
    });
  }).finally(() => input.signal?.removeEventListener('abort', abort));
  if (input.signal?.aborted) throw new DOMException('XXYY browser request aborted.', 'AbortError');
  if (code !== 0 || outputBytes > MAX_BROWSER_OUTPUT_BYTES) {
    throw new Error(
      Buffer.concat(stderr).toString('utf8').trim() || 'XXYY browser page evaluation failed.',
    );
  }
  const chunks = Buffer.concat(stdout)
    .toString('utf8')
    .split(/\r?\n/u)
    .flatMap((line) => {
      const markerIndex = line.indexOf(marker);
      if (markerIndex < 0) return [];
      const match = line.slice(markerIndex + marker.length).match(/^(\d+):(\d+):(.*)$/u);
      return match === null
        ? []
        : [{ index: Number(match[1]), total: Number(match[2]), value: match[3] }];
    })
    .sort((left, right) => left.index - right.index);
  if (chunks.length === 0 || chunks.some((chunk) => chunk.total !== chunks.length)) {
    throw new Error('XXYY browser page evaluation returned incomplete output.');
  }
  const payload = JSON.parse(chunks.map((chunk) => chunk.value).join(''));
  if (payload?.ok !== true || !('value' in payload)) {
    throw new Error(
      payload?.error === 'verification_required'
        ? 'XXYY browser requires interactive verification.'
        : 'XXYY browser page returned no evidence.',
    );
  }
  return payload.value;
}

function normalizePairResults(value) {
  if (!Array.isArray(value)) throw new Error('XXYY browser pair search returned invalid data.');
  return value.slice(0, 64).map((pair) => ({
    address: readText(pair, 'address'),
    baseToken: readText(pair, 'baseToken'),
    chain: normalizeXxyyChain(readText(pair, 'chain')),
    ...(optionalText(pair, 'dexId') === undefined ? {} : { dexId: optionalText(pair, 'dexId') }),
    ...(optionalDecimal(pair, 'liquidityUSD') === undefined
      ? {}
      : { liquidityUSD: optionalDecimal(pair, 'liquidityUSD') }),
    quoteToken: readText(pair, 'quoteToken'),
  }));
}

function normalizeTradeResults(value) {
  if (!Array.isArray(value)) throw new Error('XXYY browser trade table returned invalid data.');
  return value.slice(0, 500).map((trade) => ({
    ...(optionalInteger(trade, 'blockNumber') === undefined
      ? {}
      : { blockNumber: optionalInteger(trade, 'blockNumber') }),
    ...(optionalInteger(trade, 'logIndex') === undefined
      ? {}
      : { logIndex: Number(optionalInteger(trade, 'logIndex')) }),
    maker: readText(trade, 'maker'),
    ...(optionalDecimal(trade, 'marketCapUSD') === undefined
      ? {}
      : { marketCapUSD: optionalDecimal(trade, 'marketCapUSD') }),
    nativeAmount: readDecimal(trade, 'nativeAmount'),
    timestamp: readTimestamp(trade, 'timestamp'),
    tokenAmount: readDecimal(trade, 'tokenAmount'),
    txHash: readText(trade, 'txHash'),
    type: trade?.type === 'buy' || trade?.type === 'sell' ? trade.type : invalidField('type'),
    ...(optionalDecimal(trade, 'usdAmount') === undefined
      ? {}
      : { usdAmount: optionalDecimal(trade, 'usdAmount') }),
  }));
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function normalizeXxyyChain(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!['base', 'bsc', 'eth', 'robin', 'sol', 'stable'].includes(normalized)) {
    throw new Error('XXYY browser returned an unsupported chain.');
  }
  return normalized;
}

function readIdentifier(value, key) {
  const item = readText(value, key);
  if (!/^[0-9A-Za-z]+$/u.test(item)) invalidField(key);
  return item;
}

function readText(value, key) {
  const item = value?.[key];
  if (typeof item !== 'string' || item.trim().length === 0 || item.length > 512) invalidField(key);
  return item.trim();
}

function optionalText(value, key) {
  const item = value?.[key];
  return item === undefined || item === null || item === '' ? undefined : readText(value, key);
}

function readDecimal(value, key) {
  const item = readText(value, key);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(item)) invalidField(key);
  return item;
}

function optionalDecimal(value, key) {
  const item = optionalText(value, key);
  if (item === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(item)) invalidField(key);
  return item;
}

function optionalInteger(value, key) {
  const item = value?.[key];
  if (item === undefined || item === null || item === '') return undefined;
  const normalized = String(item);
  if (!/^\d+$/u.test(normalized)) invalidField(key);
  return normalized;
}

function readTimestamp(value, key) {
  const item = value?.[key];
  if (!Number.isSafeInteger(item) || item < 0) invalidField(key);
  return item;
}

function readOptionalTimestamp(value, key) {
  const item = value?.[key];
  if (item === undefined || item === null || item === '') return undefined;
  if (!Number.isSafeInteger(item) || item < 0) invalidField(key);
  return item;
}

function invalidField(key) {
  throw new Error(`XXYY browser data field ${key} was invalid.`);
}
