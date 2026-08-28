#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const EXPECTED_ORIGINS = new Set([
  'chrome-extension://nmfeoljpogndeibaihjkgokpaophpjhn',
  'chrome-extension://nmfeoljpogndeibaihjkgokpaophpjhn/',
]);
const NATIVE_HOST_NAME = 'io.xxyy.browser_bridge';
const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_EXPRESSION_CHARS = 512_000;
const origin = process.argv[2];

if (!EXPECTED_ORIGINS.has(origin)) {
  process.stderr.write('XXYY browser native host rejected the extension origin.\n');
  process.exit(1);
}

const profileRoot = await resolveProfileRoot();
const taskDirectory = path.join(profileRoot, 'extension-tasks');
const readyDirectory = path.join(profileRoot, 'extension-hosts');
const pending = new Map();
let heartbeat;
let input = Buffer.alloc(0);
let installationId;
let poller;
let readyFile;
let stopped = false;
const keepAlive = setInterval(() => undefined, 60_000);

await Promise.all([
  mkdir(taskDirectory, { recursive: true, mode: 0o700 }),
  mkdir(readyDirectory, { recursive: true, mode: 0o700 }),
]);
await chmod(taskDirectory, 0o700);

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, Buffer.from(chunk)]);
  parseNativeMessages();
});
process.stdin.once('end', stop);
process.stdin.once('error', stop);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

function parseNativeMessages() {
  while (input.byteLength >= 4) {
    const length = input.readUInt32LE(0);
    if (length === 0 || length > MAX_MESSAGE_BYTES) {
      stop();
      return;
    }
    if (input.byteLength < length + 4) return;
    const payload = input.subarray(4, length + 4).toString('utf8');
    input = input.subarray(length + 4);
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      continue;
    }
    void handleExtensionMessage(message).catch(() => stop());
  }
}

async function handleExtensionMessage(message) {
  if (message?.type === 'extension_ready') {
    await registerInstallation(message.installationId);
    return;
  }
  if (typeof message?.id !== 'string') return;
  const request = pending.get(message.id);
  if (request === undefined) return;
  pending.delete(message.id);
  const responseFile = path.join(taskDirectory, `${message.id}.response.json`);
  const temporaryFile = `${responseFile}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(message), { flag: 'wx', mode: 0o600 });
  await rename(temporaryFile, responseFile);
  await rm(request.inflightFile, { force: true });
}

async function pollTasks() {
  if (stopped || installationId === undefined) return;
  const entries = await readdir(taskDirectory).catch(() => []);
  for (const entry of entries) {
    const match = entry.match(
      new RegExp(`^([0-9a-f-]{36})\\.${escapeRegex(installationId)}\\.request\\.json$`, 'u'),
    );
    if (match?.[1] === undefined || pending.has(match[1])) continue;
    const requestFile = path.join(taskDirectory, entry);
    const inflightFile = path.join(taskDirectory, `${match[1]}.inflight.json`);
    try {
      await rename(requestFile, inflightFile);
      const task = validateTask(JSON.parse(await readFile(inflightFile, 'utf8')));
      pending.set(task.id, { inflightFile });
      writeNativeMessage(task);
    } catch {
      await rm(inflightFile, { force: true });
    }
  }
}

async function registerInstallation(value) {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/u.test(value)) {
    throw new Error('Invalid browser extension installation id.');
  }
  if (installationId !== undefined && installationId !== value) {
    throw new Error('Browser extension installation id changed during a native session.');
  }
  installationId = value;
  readyFile = path.join(readyDirectory, `${installationId}.json`);
  await writeReadyFile();
  if (poller === undefined) {
    poller = setInterval(() => void pollTasks(), 100);
    poller.unref();
    heartbeat = setInterval(() => void writeReadyFile(), 5_000);
    heartbeat.unref();
    await pollTasks();
  }
}

async function writeReadyFile() {
  if (readyFile === undefined || installationId === undefined) return;
  await writeFile(
    readyFile,
    `${JSON.stringify({ installationId, pid: process.pid, updatedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
}

function validateTask(value) {
  if (
    typeof value?.id !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(value.id) ||
    typeof value.url !== 'string' ||
    typeof value.expression !== 'string' ||
    value.expression.length === 0 ||
    value.expression.length > MAX_EXPRESSION_CHARS ||
    /\bfetch\s*\(/u.test(value.expression) ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 1_000 ||
    value.timeoutMs > 120_000
  ) {
    throw new Error('Invalid browser extension task.');
  }
  return value;
}

function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.byteLength > MAX_MESSAGE_BYTES) throw new Error('Native message is too large.');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.byteLength, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(keepAlive);
  if (poller !== undefined) clearInterval(poller);
  if (heartbeat !== undefined) clearInterval(heartbeat);
  void (readyFile === undefined ? Promise.resolve() : rm(readyFile, { force: true })).finally(() =>
    process.exit(0),
  );
}

async function resolveProfileRoot() {
  const configured = process.env.XXYY_BROWSER_PROFILE_DIRECTORY?.trim();
  if (configured) return path.resolve(configured);
  const configFile = path.join(
    resolveNativeMessagingDirectory(),
    `${NATIVE_HOST_NAME}.config.json`,
  );
  try {
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    if (typeof config.profileRoot === 'string' && path.isAbsolute(config.profileRoot)) {
      const info = await stat(configFile);
      if ((info.mode & 0o077) === 0) return path.resolve(config.profileRoot);
    }
  } catch {
    // Fall back to the private default profile root.
  }
  return path.join(homedir(), '.xxyy', 'browser-profile');
}

function resolveNativeMessagingDirectory() {
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
  return path.join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
