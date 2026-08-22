import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const ALLOWED_EXPLORER_HOSTS = new Set([
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
]);

const CHALLENGE_EXPRESSION = `(() => {
  const state = ((document.title || '') + '\\n' + (document.body?.innerText || '')).trim();
  return /Just a moment|security verification|安全验证|Checking your browser|Verify you are human|Attention Required|Sorry, you have been blocked/i.test(state);
})()`;

const DEFAULT_TIMEOUT_MS = 45_000;

export function parseBrowserDriverScript(script) {
  let url;
  let expression;
  let fetchUrl;
  let marker;
  for (const line of script.split(/\r?\n/u)) {
    if (line.includes('await openOrReuseTab(')) {
      url = parseJsonCallArgument(line, 'await openOrReuseTab(', ', {wait:');
    } else if (line.includes('value = await js(')) {
      expression = parseJsonCallArgument(line, 'value = await js(', ')');
    } else if (line.includes('const responseBody = await browserFetch(')) {
      fetchUrl = parseJsonCallArgument(line, 'const responseBody = await browserFetch(', ')');
    } else if (line.includes('cliLog(') && line.includes(' + index + ')) {
      marker = parseJsonCallArgument(line, 'cliLog(', ' + index + ');
    }
  }
  if (typeof url !== 'string' || typeof marker !== 'string') {
    throw new Error('Browser driver received an unsupported command script.');
  }
  if ((expression === undefined) === (fetchUrl === undefined)) {
    throw new Error('Browser driver expected exactly one page expression or browser fetch.');
  }
  return { expression, fetchUrl, marker, url };
}

function parseJsonCallArgument(line, prefix, suffix) {
  const start = line.indexOf(prefix);
  if (start < 0) return undefined;
  const valueStart = start + prefix.length;
  const source = line.slice(valueStart);
  if (!source.startsWith('"')) return undefined;
  let escaped = false;
  let valueEnd = -1;
  for (let index = 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      valueEnd = index + 1;
      break;
    }
  }
  if (valueEnd < 0 || !source.slice(valueEnd).includes(suffix)) return undefined;
  try {
    return JSON.parse(source.slice(0, valueEnd));
  } catch {
    return undefined;
  }
}

export function assertAllowedExplorerUrl(value) {
  const url = new URL(value);
  const transactionId = decodeURIComponent(url.pathname.match(/^\/tx\/([^/]+)\/?$/u)?.[1] ?? '');
  const isXxyy = url.hostname === 'www.xxyy.io';
  const isSolscan = url.hostname === 'solscan.io' || url.hostname === 'www.solscan.io';
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
    !ALLOWED_EXPLORER_HOSTS.has(url.hostname.toLowerCase()) ||
    !validPath
  ) {
    throw new Error(
      `Explorer browser navigation is not allowed for ${url.hostname}${url.pathname}.`,
    );
  }
  return url;
}

export function selectBrowserDomExpression(input) {
  const url = assertAllowedExplorerUrl(input.url);
  const transactionId = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
  if (url.hostname === 'www.xxyy.io') {
    if (typeof input.expression !== 'string' || /\bfetch\s*\(/u.test(input.expression)) {
      throw new Error('XXYY browser access requires a fixed DOM expression.');
    }
    return input.expression;
  }
  if (url.hostname.endsWith('blockscout.com')) {
    return createBlockscoutDomExpression(transactionId);
  }
  if (url.hostname === 'solscan.io' || url.hostname === 'www.solscan.io') {
    return createSolscanDomExpression(transactionId);
  }
  if (typeof input.expression !== 'string') {
    throw new Error('Explorer browser DOM expression is unavailable for this page.');
  }
  if (/\bfetch\s*\(/u.test(input.expression)) {
    throw new Error('Explorer browser API fetches are disabled; DOM evidence is required.');
  }
  return input.expression;
}

function createBlockscoutDomExpression(expectedHash) {
  return `(() => {
    const text = (document.body?.innerText || '').replace(/\\r/g, '');
    const pageState = ((document.title || '') + '\\n' + text).trim();
    if (/Just a moment|security verification|安全验证|Checking your browser|Verify you are human|Attention Required|Sorry, you have been blocked/i.test(pageState)) return null;
    const hash = location.pathname.match(/\\/tx\\/(0x[0-9a-f]{64})/i)?.[1];
    if (!hash || hash.toLowerCase() !== ${JSON.stringify(expectedHash.toLowerCase())}) return null;
    const addresses = [...document.querySelectorAll('a[href*="/address/0x"]')]
      .map((anchor) => (anchor.getAttribute('href') || '').match(/\\/address\\/(0x[0-9a-f]{40})/i)?.[1])
      .filter(Boolean);
    const uniqueAddresses = [...new Set(addresses.map((address) => address.toLowerCase()))];
    const block = text.match(/(?:Block|区块)\\s*(?:Height)?\\s*[:#]?\\s*([0-9,]+)/i)?.[1]?.replace(/,/g, '');
    const timestampText = document.querySelector('time[datetime]')?.getAttribute('datetime')
      || text.match(/\\b20\\d{2}-\\d{2}-\\d{2}[T ][0-9:.+-]+Z?\\b/)?.[0]
      || text.match(/[A-Z][a-z]{2}[- ]\\d{1,2}[- ,]20\\d{2}[^\\n]*/)?.[0];
    const timestampValue = timestampText
      ?.replace(/\\u00a0/g, ' ')
      .replace(/\\(([+-]\\d{2}:\\d{2})\\s*UTC\\)/i, '$1');
    const timestampMs = timestampValue ? Date.parse(timestampValue) : Number.NaN;
    const timestamp = Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : undefined;
    const feeValue = text.match(/(?:^|\\n)(?:Transaction fee|Txn Fee)\\s*\\n?\\s*([0-9]+(?:\\.[0-9]+)?)/im)?.[1] || '0';
    const valueValue = text.match(/(?:^|\\n)Value\\s*\\n?\\s*([0-9]+(?:\\.[0-9]+)?)/im)?.[1] || '0';
    const statusText = text.match(/(?:Status(?: and method)?|状态)\\s*[:]?\\s*([^\\n]+)/i)?.[1] || '';
    const toWei = (value) => {
      const [whole, fraction=''] = String(value).split('.');
      return (BigInt(whole || '0') * 1000000000000000000n + BigInt((fraction + '000000000000000000').slice(0, 18))).toString();
    };
    if (!block || !timestamp || uniqueAddresses.length === 0) return null;
    return {
      block_number: block,
      fee: {value: toWei(feeValue)},
      from: {hash: uniqueAddresses[0]},
      hash,
      raw_input: '0x',
      status: /fail|error|revert|失败/i.test(statusText) ? 'error' : /success|ok|成功/i.test(statusText) ? 'ok' : 'unknown',
      timestamp,
      to: uniqueAddresses[1] ? {hash: uniqueAddresses[1]} : null,
      token_transfers: [],
      value: toWei(valueValue),
    };
  })()`;
}

function createSolscanDomExpression(expectedSignature) {
  return `(() => {
    const text = (document.body?.innerText || '').replace(/\\r/g, '');
    const pageState = ((document.title || '') + '\\n' + text).trim();
    if (/Just a moment|security verification|安全验证|Checking your browser|Verify you are human|Attention Required|Sorry, you have been blocked/i.test(pageState)) return null;
    const signature = decodeURIComponent(location.pathname.match(/\\/tx\\/([^/]+)/)?.[1] || '');
    if (!signature || signature !== ${JSON.stringify(expectedSignature)}) return null;
    const slot = text.match(/(?:Slot|区块)\\s*[:#]?\\s*([0-9,]+)/i)?.[1]?.replace(/,/g, '');
    const statusText = text.match(/(?:Status|状态)\\s*[:]?\\s*([^\\n]+)/i)?.[1] || '';
    const feeSol = text.match(/(?:Transaction Fee|Fee|费用)[^0-9]*([0-9]+(?:\\.[0-9]+)?)/i)?.[1];
    const timeValue = document.querySelector('time[datetime]')?.getAttribute('datetime');
    const blockTime = timeValue ? Math.floor(Date.parse(timeValue) / 1000) : undefined;
    const feeLamports = feeSol ? Math.round(Number(feeSol) * 1000000000) : 0;
    if (!slot) return null;
    return {
      status: 200,
      body: {
        success: true,
        data: {
          block_id: slot,
          fee: feeLamports,
          log_message: [],
          parsed_instructions: [],
          sol_bal_change: [],
          status: /fail|error|失败/i.test(statusText) ? 'Fail' : /success|成功/i.test(statusText) ? 'Success' : 'Unknown',
          token_bal_change: [],
          trans_id: signature,
          ...(Number.isFinite(blockTime) ? {trans_time: blockTime} : {}),
        },
      },
    };
  })()`;
}

export async function runBrowserDriverCommand(options = {}) {
  const script = options.script ?? (await readStdin());
  const parsed = parseBrowserDriverScript(script);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const env = options.env ?? process.env;
  const releaseBrowserLock = await acquireBrowserLock(env, timeoutMs);
  let client;
  let targetId;
  try {
    const browser = await connectOrLaunchBrowser(env, timeoutMs);
    client = browser.client;
    targetId = await createBackgroundTarget(client);
    const attached = await client.call('Target.attachToTarget', { flatten: true, targetId });
    const sessionId = attached.sessionId;
    await Promise.all([
      client.call('Page.enable', {}, sessionId),
      client.call('Runtime.enable', {}, sessionId),
      client.call('Network.enable', {}, sessionId),
    ]);
    let challenged = false;
    const stopListening = client.on('Network.responseReceived', (params) => {
      const headers = params?.response?.headers;
      if (
        headers &&
        Object.entries(headers).some(
          ([key, value]) =>
            key.toLowerCase() === 'cf-mitigated' && String(value).toLowerCase() === 'challenge',
        )
      ) {
        challenged = true;
      }
    });
    try {
      await client.call('Page.navigate', { url: parsed.url }, sessionId);
      await waitForDocumentReady(client, sessionId, timeoutMs);
      const currentUrl = await evaluateValue(client, sessionId, 'location.href');
      if (typeof currentUrl !== 'string') throw new Error('Explorer browser returned no page URL.');
      assertAllowedExplorerUrl(currentUrl);
      const expression = selectBrowserDomExpression(parsed);
      const deadline = Date.now() + timeoutMs;
      let value;
      while (Date.now() < deadline) {
        if (challenged || (await evaluateValue(client, sessionId, CHALLENGE_EXPRESSION)) === true) {
          writeChunkedResult(parsed.marker, { error: 'verification_required', ok: false });
          return;
        }
        value = await evaluateValue(client, sessionId, expression, true);
        if (value !== null && value !== undefined) break;
        await delay(250);
      }
      if (value === null || value === undefined) {
        writeChunkedResult(parsed.marker, { error: 'page_evidence_timeout', ok: false });
        return;
      }
      await captureExplorerScreenshot(client, sessionId, parsed.url, env.XXYY_SCREENSHOT_DIRECTORY);
      writeChunkedResult(parsed.marker, { ok: true, value });
    } finally {
      stopListening();
    }
  } finally {
    if (client !== undefined && targetId !== undefined) {
      await client.call('Target.closeTarget', { targetId }).catch(() => undefined);
    }
    client?.close();
    await releaseBrowserLock();
  }
}

export async function openVerificationWindow(url, options = {}) {
  assertAllowedExplorerUrl(url);
  const env = options.env ?? process.env;
  const releaseBrowserLock = await acquireBrowserLock(env, DEFAULT_TIMEOUT_MS);
  let client;
  let targetId;
  try {
    const browser = await connectOrLaunchBrowser(env, DEFAULT_TIMEOUT_MS);
    client = browser.client;
    let target;
    try {
      target = await client.call('Target.createTarget', {
        focus: true,
        height: 900,
        left: 80,
        newWindow: true,
        top: 80,
        url,
        width: 1400,
      });
    } catch {
      target = await client.call('Target.createTarget', { url });
      await client.call('Target.activateTarget', { targetId: target.targetId });
    }
    targetId = target.targetId;
    process.stdout.write(
      `Explorer verification window opened for ${new URL(url).hostname}. Complete verification, then press Ctrl+C.\n`,
    );
    await new Promise((resolve) => {
      const finish = () => resolve();
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    });
  } finally {
    if (client !== undefined && targetId !== undefined) {
      await client.call('Target.closeTarget', { targetId }).catch(() => undefined);
    }
    client?.close();
    await releaseBrowserLock();
  }
}

export async function stopExplorerBrowser(options = {}) {
  const env = options.env ?? process.env;
  const releaseBrowserLock = await acquireBrowserLock(env, DEFAULT_TIMEOUT_MS);
  let client;
  try {
    const profileDirectory = path.join(resolveProfileRoot(env), 'explorer-chrome');
    const endpoint = await readDebuggerEndpoint(profileDirectory).catch(() => undefined);
    if (endpoint === undefined) return false;
    client = await CdpClient.connect(endpoint.webSocketDebuggerUrl);
    await client.call('Browser.close').catch(() => undefined);
    await delay(1_000);
    if ((await readDebuggerEndpoint(profileDirectory).catch(() => undefined)) !== undefined) {
      await terminateManagedBrowser(profileDirectory);
    }
    return true;
  } finally {
    client?.close();
    await releaseBrowserLock();
  }
}

async function connectOrLaunchBrowser(env, timeoutMs) {
  const profileRoot = resolveProfileRoot(env);
  const profileDirectory = path.join(profileRoot, 'explorer-chrome');
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const existing = await readDebuggerEndpoint(profileDirectory).catch(() => undefined);
  if (existing !== undefined) {
    return { client: await CdpClient.connect(existing.webSocketDebuggerUrl), profileDirectory };
  }
  await cleanupStaleProfileLocks(profileDirectory);
  const chromeExecutable = await resolveChromeExecutable(env.XXYY_SCREENSHOT_CHROME_EXECUTABLE);
  if (chromeExecutable === undefined) {
    throw new Error('Chrome or Chromium is required for public Explorer queries.');
  }
  const chromeArguments = [
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--no-default-browser-check',
    '--no-first-run',
    '--no-startup-window',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`,
    '--window-position=-32000,-32000',
    '--window-size=1600,1000',
    ...(typeof process.getuid === 'function' && process.getuid() === 0
      ? ['--disable-setuid-sandbox', '--no-sandbox']
      : []),
  ];
  const launch = await resolveChromeLaunch(chromeExecutable, chromeArguments);
  const child = spawn(launch.command, launch.arguments, {
    detached: true,
    stdio: 'ignore',
  });
  if (child.pid !== undefined) {
    await writeFile(path.join(profileDirectory, 'BrowserDriverPid'), `${child.pid}\n`, {
      mode: 0o600,
    });
  }
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoint = await readDebuggerEndpoint(profileDirectory).catch(() => undefined);
    if (endpoint !== undefined) {
      return { client: await CdpClient.connect(endpoint.webSocketDebuggerUrl), profileDirectory };
    }
    await delay(100);
  }
  throw new Error('Chrome browser did not expose its debugger endpoint.');
}

function resolveProfileRoot(env) {
  return path.resolve(
    env.XXYY_BROWSER_PROFILE_DIRECTORY?.trim() || path.join(homedir(), '.xxyy', 'browser-profile'),
  );
}

async function acquireBrowserLock(env, timeoutMs) {
  const profileRoot = resolveProfileRoot(env);
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(profileRoot, 'explorer-chrome-driver.lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockPath, now, now).catch(() => undefined);
      }, 15_000);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await unlink(lockPath).catch((error) => {
          if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
        });
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      const lockOwner = await readFile(lockPath, 'utf8').catch(() => '');
      const ownerPid = Number(lockOwner.trim());
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && !isProcessRunning(ownerPid)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat !== undefined && Date.now() - lockStat.mtimeMs > 120_000) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(100);
    }
  }
  throw new Error('Explorer browser is busy with another transaction query.');
}

async function resolveChromeExecutable(configured) {
  const normalizedConfigured = configured?.trim();
  const candidates = (
    normalizedConfigured
      ? [normalizedConfigured]
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
  ).filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const resolved = path.resolve(candidate);
      if (await isChromeExecutable(resolved)) return resolved;
    } catch {
      // Try the next fixed browser location.
    }
  }
  return undefined;
}

function isChromeExecutable(executable) {
  return new Promise((resolve) => {
    execFile(executable, ['--version'], { timeout: 2_000 }, (error, stdout, stderr) => {
      resolve(
        error === null &&
          /(?:Google Chrome|Chromium|Chrome for Testing)/iu.test(`${stdout}${stderr}`),
      );
    });
  });
}

async function resolveChromeLaunch(chromeExecutable, chromeArguments) {
  if (process.platform !== 'linux') {
    return { arguments: chromeArguments, command: chromeExecutable };
  }
  try {
    await access('/usr/bin/xvfb-run', fsConstants.X_OK);
    return {
      arguments: [
        '-a',
        '--server-args=-screen 0 1600x1000x24 -nolisten tcp',
        chromeExecutable,
        ...chromeArguments,
      ],
      command: '/usr/bin/xvfb-run',
    };
  } catch {
    return { arguments: ['--headless=new', ...chromeArguments], command: chromeExecutable };
  }
}

async function readDebuggerEndpoint(profileDirectory) {
  const contents = await readFile(path.join(profileDirectory, 'DevToolsActivePort'), 'utf8');
  const [port] = contents.trim().split(/\r?\n/u);
  if (!/^\d+$/u.test(port ?? '')) throw new Error('Chrome debugger port file was invalid.');
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error('Chrome debugger endpoint was unavailable.');
  const payload = await response.json();
  if (typeof payload.webSocketDebuggerUrl !== 'string') {
    throw new Error('Chrome debugger endpoint returned no WebSocket URL.');
  }
  return { port: Number(port), webSocketDebuggerUrl: payload.webSocketDebuggerUrl };
}

async function cleanupStaleProfileLocks(profileDirectory) {
  await Promise.all(
    [
      'BrowserDriverPid',
      'DevToolsActivePort',
      'SingletonCookie',
      'SingletonLock',
      'SingletonSocket',
    ].map((name) => rm(path.join(profileDirectory, name), { force: true, recursive: true })),
  );
}

async function terminateManagedBrowser(profileDirectory) {
  const pidText = await readFile(path.join(profileDirectory, 'BrowserDriverPid'), 'utf8').catch(
    () => '',
  );
  const pid = Number(pidText.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const signal = (value) => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, value);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal('SIGTERM')) return;
  for (let index = 0; index < 10 && isProcessRunning(pid); index += 1) await delay(100);
  if (isProcessRunning(pid)) signal('SIGKILL');
  await rm(path.join(profileDirectory, 'BrowserDriverPid'), { force: true });
}

async function createBackgroundTarget(client) {
  try {
    const target = await client.call('Target.createTarget', {
      background: true,
      focus: false,
      url: 'about:blank',
    });
    return target.targetId;
  } catch {
    const target = await client.call('Target.createTarget', {
      background: true,
      url: 'about:blank',
    });
    return target.targetId;
  }
}

async function waitForDocumentReady(client, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluateValue(client, sessionId, 'document.readyState').catch(
      () => undefined,
    );
    if (state === 'interactive' || state === 'complete') return;
    await delay(100);
  }
  throw new Error('Explorer browser navigation timed out.');
}

async function evaluateValue(client, sessionId, expression, awaitPromise = false) {
  const result = await client.call(
    'Runtime.evaluate',
    {
      awaitPromise,
      expression,
      returnByValue: true,
      userGesture: false,
    },
    sessionId,
  );
  if (result.exceptionDetails !== undefined) {
    throw new Error('Explorer browser DOM evaluation failed.');
  }
  return result.result?.value;
}

async function captureExplorerScreenshot(client, sessionId, url, configuredDirectory) {
  const directory = configuredDirectory?.trim();
  if (!directory) return;
  const response = await client.call(
    'Page.captureScreenshot',
    { captureBeyondViewport: false, format: 'png', fromSurface: true },
    sessionId,
  );
  if (typeof response.data !== 'string') {
    throw new Error('Explorer browser screenshot returned no PNG data.');
  }
  const png = Buffer.from(response.data, 'base64');
  if (png.byteLength === 0 || png.byteLength > 10 * 1_048_576) {
    throw new Error('Explorer browser screenshot size was invalid.');
  }
  const explorerDirectory = path.join(path.resolve(directory), 'explorer');
  await mkdir(explorerDirectory, { recursive: true, mode: 0o750 });
  const filename = `${createHash('sha256').update(url).digest('hex')}.png`;
  await writeFile(path.join(explorerDirectory, filename), png, { mode: 0o640 });
}

function writeChunkedResult(marker, payload) {
  const serialized = JSON.stringify(payload);
  const totalChunks = Math.max(1, Math.ceil(serialized.length / 400));
  for (let index = 0; index < totalChunks; index += 1) {
    process.stdout.write(
      `${marker}${index}:${totalChunks}:${serialized.slice(index * 400, (index + 1) * 400)}\n`,
    );
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function normalizeTimeout(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 120_000) : DEFAULT_TIMEOUT_MS;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error) {
  return error instanceof Error && 'code' in error;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== 'ESRCH';
  }
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', () => this.failPending(new Error('Chrome debugger closed.')));
    socket.addEventListener('error', () => this.failPending(new Error('Chrome debugger failed.')));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Chrome debugger connection timed out.')),
        5_000,
      );
      const opened = () => {
        clearTimeout(timer);
        socket.removeEventListener('error', failed);
        resolve();
      };
      const failed = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        reject(new Error('Chrome debugger connection failed.'));
      };
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
    });
    return new CdpClient(socket);
  }

  call(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome debugger command ${method} timed out.`));
      }, 30_000);
      this.pending.set(id, { reject, resolve, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined)
        pending.reject(new Error(message.error.message ?? 'CDP error'));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
