import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BROWSER_EXTENSION_ID,
  createConnectorSetupArguments,
  createNativeHostLauncher,
  createNativeMessagingManifest,
  resolveExtensionBrowserPaths,
} from './extension-browser-runtime.mjs';

describe('Chrome extension browser connector', () => {
  it('does not request broad tab, cookie, history, or credential permissions', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../browser-extension/manifest.json', import.meta.url), 'utf8'),
    );

    expect(manifest.permissions).toEqual(['nativeMessaging', 'scripting', 'storage']);
    expect(manifest.permissions).not.toEqual(
      expect.arrayContaining(['tabs', 'cookies', 'history']),
    );
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining(['https://xxyy.io/*', 'https://www.xxyy.io/*']),
    );
  });

  it('registers a native host for only the fixed extension id', () => {
    expect(createNativeMessagingManifest('/opt/xxyy/browser-host')).toEqual({
      allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
      description: 'XXYY browser connector',
      name: 'io.xxyy.browser_bridge',
      path: '/opt/xxyy/browser-host',
      type: 'stdio',
    });
  });

  it('launches the native host with an absolute Node executable instead of GUI PATH', () => {
    const launcher = createNativeHostLauncher(
      '/opt/node/bin/node',
      '/opt/xxyy/browser-host.mjs',
      '/private/xxyy/native-host.log',
    );

    expect(launcher).toContain("exec '/opt/node/bin/node' '/opt/xxyy/browser-host.mjs'");
    expect(launcher).toContain('"$@"');
    expect(launcher).toContain("2>'/private/xxyy/native-host.log'");
  });

  it('opens setup in the user-managed Chrome without profile or automation flags', () => {
    const args = createConnectorSetupArguments('chrome://extensions');

    expect(args).not.toEqual(expect.arrayContaining([expect.stringContaining('--user-data-dir=')]));
    expect(args).not.toContain('--remote-debugging-port=0');
    expect(args).not.toContain('--enable-automation');
    expect(args).not.toContain('--disable-extensions');
    expect(args).toEqual(['chrome://extensions']);
  });

  it('keeps connector tasks and registrations below the private bridge root', () => {
    const paths = resolveExtensionBrowserPaths({
      XXYY_BROWSER_PROFILE_DIRECTORY: '/isolated/root',
    });

    expect(paths.taskDirectory).toBe('/isolated/root/extension-tasks');
    expect(paths.hostReadyDirectory).toBe('/isolated/root/extension-hosts');
    expect(paths.extensionDirectory).toMatch(/transaction-skill-bridge\/browser-extension$/u);
  });

  it('routes a task only to the Chrome installation that registered it', async () => {
    const profileRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-browser-connector-test-'));
    const installationId = '11111111-2222-4333-8444-555555555555';
    const taskId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const hostScript = new URL('../bin/xxyy-browser-native-host.mjs', import.meta.url);
    const child = spawn(
      process.execPath,
      [hostScript.pathname, `chrome-extension://${BROWSER_EXTENSION_ID}/`],
      {
        env: { ...process.env, XXYY_BROWSER_PROFILE_DIRECTORY: profileRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    try {
      child.stdin.write(nativeMessage({ installationId, type: 'extension_ready' }));
      await expect(readNativeMessage(child.stdout)).resolves.toEqual({
        installationId,
        type: 'host_ready',
      });
      const readyFile = path.join(profileRoot, 'extension-hosts', `${installationId}.json`);
      await waitForFile(readyFile);
      const taskDirectory = path.join(profileRoot, 'extension-tasks');
      await mkdir(taskDirectory, { recursive: true });
      await writeFile(
        path.join(taskDirectory, `${taskId}.${installationId}.request.json`),
        JSON.stringify({
          expression: 'true',
          id: taskId,
          timeoutMs: 5_000,
          url: `https://bscscan.com/tx/0x${'a'.repeat(64)}`,
        }),
      );
      const task = await readNativeMessage(child.stdout);
      expect(task).toMatchObject({ id: taskId, expression: 'true' });
      child.stdin.write(nativeMessage({ id: taskId, ok: true, value: { status: 'ok' } }));
      const responseFile = path.join(taskDirectory, `${taskId}.response.json`);
      await waitForFile(responseFile);
      expect(JSON.parse(await readFile(responseFile, 'utf8'))).toMatchObject({
        id: taskId,
        ok: true,
        value: { status: 'ok' },
      });
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
      await rm(profileRoot, { force: true, recursive: true });
    }
  });
});

function nativeMessage(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

function readNativeMessage(stream) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const data = (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.byteLength < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.byteLength < length + 4) return;
      cleanup();
      resolve(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')));
    };
    const error = (value) => {
      cleanup();
      reject(value);
    };
    const cleanup = () => {
      stream.off('data', data);
      stream.off('error', error);
    };
    stream.on('data', data);
    stream.on('error', error);
  });
}

async function waitForFile(file) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${file}.`);
}
