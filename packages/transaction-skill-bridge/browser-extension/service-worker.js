const NATIVE_HOST_NAME = 'io.xxyy.browser_bridge';
const MAX_EXPRESSION_CHARS = 512_000;
const CHALLENGE_PATTERN =
  /Just a moment|security verification|安全验证|Checking your browser|Verify you are human|Attention Required|Sorry, you have been blocked/i;

let nativePort;
let reconnectTimer;
let taskQueue = Promise.resolve();
let installationId;
let initialization;

void ensureConnection();
chrome.runtime.onStartup.addListener(() => void ensureConnection());
chrome.runtime.onInstalled.addListener(() => void ensureConnection());
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ensure_connection') void ensureConnection();
});

function ensureConnection() {
  initialization ??= initialize().finally(() => {
    initialization = undefined;
  });
  return initialization;
}

async function initialize() {
  const stored = await chrome.storage.local.get('installationId');
  installationId =
    typeof stored.installationId === 'string' ? stored.installationId : crypto.randomUUID();
  if (stored.installationId !== installationId) {
    await chrome.storage.local.set({ installationId });
  }
  if (nativePort === undefined) connectNativeHost();
}

function connectNativeHost() {
  clearTimeout(reconnectTimer);
  try {
    void chrome.storage.local.set({
      connectionStatus: 'connecting',
      lastConnectionAt: new Date().toISOString(),
      lastConnectionError: '',
    });
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    port.onMessage.addListener((message) => {
      if (message?.type === 'host_ready' && message.installationId === installationId) {
        void chrome.storage.local.set({
          connectionStatus: 'connected',
          lastConnectionAt: new Date().toISOString(),
          lastConnectionError: '',
        });
        return;
      }
      taskQueue = taskQueue.then(
        () => handleTask(message),
        () => handleTask(message),
      );
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Native host disconnected.';
      void chrome.storage.local.set({
        connectionStatus: 'disconnected',
        lastConnectionAt: new Date().toISOString(),
        lastConnectionError: error,
      });
      if (nativePort === port) nativePort = undefined;
      reconnectTimer = setTimeout(() => void ensureConnection(), 1_000);
    });
    port.postMessage({ installationId, type: 'extension_ready' });
  } catch {
    reconnectTimer = setTimeout(() => void ensureConnection(), 1_000);
  }
}

async function handleTask(message) {
  const id = typeof message?.id === 'string' ? message.id : undefined;
  if (id === undefined) return;
  try {
    const task = validateTask(message);
    const value = await readBrowserPage(task);
    nativePort?.postMessage({ id, ok: true, value });
  } catch (error) {
    nativePort?.postMessage({
      error: error instanceof Error ? error.message : String(error),
      id,
      ok: false,
    });
  }
}

function validateTask(message) {
  const url = assertAllowedUrl(message?.url);
  if (
    typeof message.expression !== 'string' ||
    message.expression.length === 0 ||
    message.expression.length > MAX_EXPRESSION_CHARS ||
    /\bfetch\s*\(/u.test(message.expression)
  ) {
    throw new Error('browser_expression_not_allowed');
  }
  if (
    !Number.isInteger(message.timeoutMs) ||
    message.timeoutMs < 1_000 ||
    message.timeoutMs > 120_000
  ) {
    throw new Error('browser_timeout_invalid');
  }
  return { expression: message.expression, id: message.id, timeoutMs: message.timeoutMs, url };
}

async function readBrowserPage(task) {
  const taskDeadline = Date.now() + task.timeoutMs;
  const tab = await getControlledTab();
  await chrome.tabs.update(tab.id, { active: false, url: task.url.href });
  await waitForTabComplete(tab.id, task.timeoutMs);

  const challengeDeadline = Math.min(taskDeadline, Date.now() + 40_000);
  while (Date.now() < challengeDeadline) {
    const state = await readChallengeState(tab.id);
    if (!state.challenged) break;
    await delay(500);
  }
  if ((await readChallengeState(tab.id)).challenged) {
    await chrome.tabs.update(tab.id, { active: true });
    throw new Error('verification_required');
  }

  while (Date.now() < taskDeadline) {
    const current = await chrome.tabs.get(tab.id);
    if (current.url === undefined) throw new Error('browser_page_url_missing');
    assertExpectedNavigation(current.url, task.url);
    const result = await chrome.scripting.executeScript({
      args: [task.expression],
      func: evaluateFixedExpression,
      target: { tabId: tab.id },
      world: 'MAIN',
    });
    const value = result[0]?.result;
    if (value !== null && value !== undefined) return value;
    if ((await readChallengeState(tab.id)).challenged) {
      throw new Error('verification_required');
    }
    await delay(250);
  }
  throw new Error('page_evidence_timeout');
}

function evaluateFixedExpression(expression) {
  return (0, eval)(expression);
}

async function getControlledTab() {
  const stored = await chrome.storage.session.get('controlledTabId');
  if (Number.isInteger(stored.controlledTabId)) {
    try {
      return await chrome.tabs.get(stored.controlledTabId);
    } catch {
      // The connector's prior tab was closed; create a fresh dedicated tab.
    }
  }
  const tab = await chrome.tabs.create({ active: false, url: 'about:blank' });
  if (tab.id === undefined) throw new Error('browser_controlled_tab_missing');
  await chrome.storage.session.set({ controlledTabId: tab.id });
  return tab;
}

async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await delay(100);
  }
  throw new Error('browser_navigation_timeout');
}

async function readChallengeState(tabId) {
  const result = await chrome.scripting.executeScript({
    func: () => ({
      href: location.href,
      state: `${document.title || ''}\n${document.body?.innerText || ''}`,
    }),
    target: { tabId },
  });
  const value = result[0]?.result;
  if (typeof value?.href !== 'string' || typeof value.state !== 'string') {
    throw new Error('browser_page_state_missing');
  }
  return { challenged: CHALLENGE_PATTERN.test(value.state), href: value.href };
}

function assertAllowedUrl(value) {
  const url = new URL(value);
  const transactionId = decodeURIComponent(url.pathname.match(/^\/tx\/([^/]+)\/?$/u)?.[1] ?? '');
  const isXxyy = url.hostname === 'xxyy.io' || url.hostname === 'www.xxyy.io';
  const isSolscan = url.hostname === 'solscan.io' || url.hostname === 'www.solscan.io';
  const allowedHosts = new Set([
    'basescan.org',
    'base.blockscout.com',
    'bscscan.com',
    'eth.blockscout.com',
    'robinhoodchain.blockscout.com',
    'solscan.io',
    'stablescan.xyz',
    'www.basescan.org',
    'www.bscscan.com',
    'www.solscan.io',
    'www.stablescan.xyz',
    'www.xxyy.io',
    'xxyy.io',
  ]);
  const validPath = isXxyy
    ? url.pathname === '/' ||
      url.pathname === '/meme' ||
      /^\/(?:base|bsc|eth|robin|sol|stable)\/[0-9A-Za-z]+\/?$/u.test(url.pathname)
    : isSolscan
      ? /^[1-9A-HJ-NP-Za-km-z]{43,88}$/u.test(transactionId)
      : /^0x[0-9a-f]{64}$/iu.test(transactionId);
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.search.length > 0 ||
    !allowedHosts.has(url.hostname.toLowerCase()) ||
    !validPath
  ) {
    throw new Error('browser_navigation_not_allowed');
  }
  return url;
}

function assertExpectedNavigation(value, requestedUrl) {
  const currentUrl = new URL(value);
  if (
    isXxyyHost(requestedUrl.hostname) &&
    isXxyyHost(currentUrl.hostname) &&
    currentUrl.username.length === 0 &&
    currentUrl.password.length === 0 &&
    currentUrl.hash.length === 0 &&
    currentUrl.search.length === 0
  ) {
    assertAllowedUrl(currentUrl.href);
    return;
  }
  if (
    currentUrl.origin !== requestedUrl.origin ||
    currentUrl.pathname !== requestedUrl.pathname ||
    currentUrl.username.length > 0 ||
    currentUrl.password.length > 0 ||
    currentUrl.hash.length > 0 ||
    currentUrl.search.length > 0
  ) {
    throw new Error('browser_navigation_not_allowed');
  }
}

function isXxyyHost(hostname) {
  return hostname === 'xxyy.io' || hostname === 'www.xxyy.io';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
