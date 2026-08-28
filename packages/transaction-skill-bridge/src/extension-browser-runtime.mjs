import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BROWSER_EXTENSION_ID = 'nmfeoljpogndeibaihjkgokpaophpjhn';
export const NATIVE_HOST_NAME = 'io.xxyy.browser_bridge';
const MAX_RESPONSE_BYTES = 1_048_576;

export async function runExtensionBrowserTask(options) {
  const connection = await resolveExtensionConnection(options.env);
  const { paths } = connection;
  const id = randomUUID();
  const requestFile = path.join(
    paths.taskDirectory,
    `${id}.${connection.installationId}.request.json`,
  );
  const responseFile = path.join(paths.taskDirectory, `${id}.response.json`);
  const inflightFile = path.join(paths.taskDirectory, `${id}.inflight.json`);
  await writeFile(
    requestFile,
    JSON.stringify({
      expression: options.expression,
      id,
      timeoutMs: options.timeoutMs,
      url: options.url,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  const deadline = Date.now() + options.timeoutMs + 5_000;
  try {
    while (Date.now() < deadline) {
      try {
        const responseStat = await stat(responseFile);
        if (responseStat.size <= 0 || responseStat.size > MAX_RESPONSE_BYTES) {
          throw new Error('Browser extension response size was invalid.');
        }
        return JSON.parse(await readFile(responseFile, 'utf8'));
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      }
      await delay(100);
    }
    throw new Error('Browser extension task timed out.');
  } finally {
    await Promise.all([
      rm(requestFile, { force: true }),
      rm(responseFile, { force: true }),
      rm(inflightFile, { force: true }),
    ]);
  }
}

export async function openExtensionSetup(options = {}) {
  const env = options.env ?? process.env;
  const paths = resolveExtensionBrowserPaths(env);
  await Promise.all([
    mkdir(paths.taskDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.hostReadyDirectory, { recursive: true, mode: 0o700 }),
    installNativeMessagingManifest(paths, env),
  ]);
  const chromeExecutable = await resolveChromeExecutable(env.XXYY_SCREENSHOT_CHROME_EXECUTABLE);
  if (chromeExecutable === undefined) {
    throw new Error('Chrome or Chromium is required for the browser connector.');
  }
  const child = spawn(chromeExecutable, createConnectorSetupArguments('chrome://extensions'), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { extensionDirectory: paths.extensionDirectory };
}

export async function openExtensionBrowserUrl(url, options = {}) {
  return await runExtensionBrowserTask({
    env: options.env ?? process.env,
    expression: 'true',
    timeoutMs: 45_000,
    url,
  });
}

export async function stopExtensionBrowser() {
  // Connector mode never owns or terminates the user's Chrome process.
  return false;
}

async function resolveExtensionConnection(env) {
  const paths = resolveExtensionBrowserPaths(env);
  await Promise.all([
    mkdir(paths.taskDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.hostReadyDirectory, { recursive: true, mode: 0o700 }),
    installNativeMessagingManifest(paths, env),
  ]);
  const connections = await discoverExtensionConnections(paths);
  const configured = env.XXYY_BROWSER_EXTENSION_INSTALLATION_ID?.trim();
  if (configured) {
    const selected = connections.find((connection) => connection.installationId === configured);
    if (selected !== undefined) return { ...selected, paths };
    throw new Error(`Configured XXYY browser extension ${configured} is not connected.`);
  }
  if (connections.length === 1) return { ...connections[0], paths };
  if (connections.length === 0) {
    throw new Error(
      `XXYY browser extension is not connected. Load unpacked extension from ${paths.extensionDirectory} in the Chrome profile you want the Agent to control.`,
    );
  }
  throw new Error(
    `Multiple XXYY browser extensions are connected (${connections.map((item) => item.installationId).join(', ')}). Set XXYY_BROWSER_EXTENSION_INSTALLATION_ID to select one.`,
  );
}

async function discoverExtensionConnections(paths) {
  const entries = await readdir(paths.hostReadyDirectory).catch(() => []);
  const connections = [];
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}\.json$/u.test(entry)) continue;
    try {
      const value = JSON.parse(await readFile(path.join(paths.hostReadyDirectory, entry), 'utf8'));
      if (
        typeof value.installationId === 'string' &&
        /^[0-9a-f-]{36}$/u.test(value.installationId) &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0 &&
        isProcessRunning(value.pid)
      ) {
        connections.push({ installationId: value.installationId, pid: value.pid });
      }
    } catch {
      // Ignore stale or malformed connector registrations.
    }
  }
  return connections;
}

export function resolveExtensionBrowserPaths(env = process.env) {
  const profileRoot = path.resolve(
    env.XXYY_BROWSER_PROFILE_DIRECTORY?.trim() || path.join(homedir(), '.xxyy', 'browser-profile'),
  );
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
  return {
    extensionDirectory: path.resolve(sourceDirectory, '../browser-extension'),
    hostExecutable: path.resolve(sourceDirectory, '../bin/xxyy-browser-native-host'),
    hostReadyDirectory: path.join(profileRoot, 'extension-hosts'),
    profileRoot,
    taskDirectory: path.join(profileRoot, 'extension-tasks'),
  };
}

export function createNativeMessagingManifest(hostExecutable) {
  return {
    allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
    description: 'XXYY browser connector',
    name: NATIVE_HOST_NAME,
    path: path.resolve(hostExecutable),
    type: 'stdio',
  };
}

export function createNativeHostLauncher(nodeExecutable, hostScript, errorLog) {
  return `#!/bin/sh\nexec ${shellQuote(path.resolve(nodeExecutable))} ${shellQuote(path.resolve(hostScript))} "$@" 2>${shellQuote(path.resolve(errorLog))}\n`;
}

export function createConnectorSetupArguments(initialUrl) {
  return [initialUrl];
}

async function installNativeMessagingManifest(paths, env) {
  const directory = resolveNativeMessagingDirectory(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await access(paths.hostExecutable, fsConstants.X_OK);
  const manifestFile = path.join(directory, `${NATIVE_HOST_NAME}.json`);
  const configFile = path.join(directory, `${NATIVE_HOST_NAME}.config.json`);
  const launcherFile = path.join(directory, `${NATIVE_HOST_NAME}.launcher`);
  const launcher = createNativeHostLauncher(
    process.execPath,
    `${paths.hostExecutable}.mjs`,
    path.join(paths.profileRoot, 'BrowserExtensionHostError.log'),
  );
  const currentLauncher = await readFile(launcherFile, 'utf8').catch(() => undefined);
  if (currentLauncher !== launcher) await writeFile(launcherFile, launcher, { mode: 0o700 });
  await chmod(launcherFile, 0o700);
  const serialized = `${JSON.stringify(createNativeMessagingManifest(launcherFile), null, 2)}\n`;
  const current = await readFile(manifestFile, 'utf8').catch(() => undefined);
  if (current !== serialized) await writeFile(manifestFile, serialized, { mode: 0o600 });
  const config = `${JSON.stringify({ profileRoot: paths.profileRoot }, null, 2)}\n`;
  const currentConfig = await readFile(configFile, 'utf8').catch(() => undefined);
  if (currentConfig !== config) await writeFile(configFile, config, { mode: 0o600 });
}

function shellQuote(value) {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function resolveNativeMessagingDirectory(env) {
  const configured = env.XXYY_BROWSER_NATIVE_MESSAGING_DIRECTORY?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === 'darwin') {
    return path.join(
      homedir(),
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
    );
  }
  if (process.platform === 'linux') {
    return path.join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
  }
  throw new Error('The browser connector currently supports macOS and Linux.');
}

async function resolveChromeExecutable(configured) {
  const candidates = (
    configured?.trim()
      ? [configured.trim()]
      : [
          process.platform === 'darwin'
            ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : undefined,
          process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : undefined,
          process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
        ]
  ).filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {
      // Try the next fixed browser location.
    }
  }
  return undefined;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error) {
  return error instanceof Error && 'code' in error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
