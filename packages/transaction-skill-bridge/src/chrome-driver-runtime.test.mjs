import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertAllowedExplorerUrl,
  classifyExplorerNavigation,
  createChromeArguments,
  parseBrowserDriverScript,
  selectBrowserDomExpression,
  stopExplorerBrowser,
} from './chrome-driver-runtime.mjs';

describe('Chrome Explorer browser driver', () => {
  it('parses the fixed transaction Skill command without evaluating arbitrary Node code', () => {
    const expression = `(() => ({hash: location.pathname}))()`;
    const script = [
      'const task = await useOrCreateTaskSpace("xxyy-public-explorer")',
      'await openOrReuseTab("https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {wait:true, timeout:45})',
      `value = await js(${JSON.stringify(expression)})`,
      'cliLog("__XXYY_BROWSER_RESULT_test__:" + index + ":" + totalChunks + ":" + serialized.slice(index * 400, (index + 1) * 400))',
    ].join('\n');

    expect(parseBrowserDriverScript(script)).toEqual({
      expression,
      fetchUrl: undefined,
      marker: '__XXYY_BROWSER_RESULT_test__:',
      url: 'https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('rejects arbitrary destinations before Chrome navigation', () => {
    expect(() => assertAllowedExplorerUrl('https://example.com/tx/value')).toThrow('not allowed');
    expect(() => assertAllowedExplorerUrl('http://basescan.org/tx/value')).toThrow('not allowed');
    expect(() => assertAllowedExplorerUrl('https://basescan.org/address/0xabc')).toThrow(
      'not allowed',
    );
    expect(assertAllowedExplorerUrl('https://www.xxyy.io/meme').hostname).toBe('www.xxyy.io');
    expect(assertAllowedExplorerUrl('https://xxyy.io/meme').hostname).toBe('xxyy.io');
    expect(() => assertAllowedExplorerUrl('https://www.xxyy.io/api/data/search/v3')).toThrow(
      'not allowed',
    );
  });

  it('classifies same-transaction Cloudflare redirects before enforcing a query-free URL', () => {
    const transactionUrl =
      'https://bscscan.com/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const challengeUrl = `${transactionUrl}?__cf_chl_tk=verification-token`;

    expect(classifyExplorerNavigation(challengeUrl, transactionUrl, true)).toBe(
      'verification_required',
    );
    expect(() => classifyExplorerNavigation(challengeUrl, transactionUrl, false)).toThrow(
      'not allowed',
    );
    expect(() =>
      classifyExplorerNavigation(
        'https://example.com/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        transactionUrl,
        true,
      ),
    ).toThrow('not allowed');
  });

  it('uses a non-zero loopback debugger port without exposing the WebDriver port-zero signal', () => {
    const argumentsList = createChromeArguments('/isolated/explorer-chrome', 43_217);

    expect(argumentsList).toContain('--remote-debugging-address=127.0.0.1');
    expect(argumentsList).toContain('--remote-debugging-port=43217');
    expect(argumentsList).not.toContain('--remote-debugging-port=0');
    expect(argumentsList).toContain('--user-data-dir=/isolated/explorer-chrome');
    expect(() => createChromeArguments('/isolated/explorer-chrome', 0)).toThrow('non-zero');
  });

  it('replaces legacy in-page API fetches with fixed DOM-only extractors', () => {
    const blockscout = selectBrowserDomExpression({
      fetchUrl: 'https://base.blockscout.com/api/v2/transactions/hash',
      url: 'https://base.blockscout.com/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const solscan = selectBrowserDomExpression({
      expression: '(async () => fetch("https://api-v2.solscan.io"))()',
      url: `https://solscan.io/tx/${'1'.repeat(64)}`,
    });

    expect(blockscout).not.toContain('fetch(');
    expect(blockscout).toContain('document.body');
    expect(solscan).not.toContain('fetch(');
    expect(solscan).toContain('document.body');
  });

  it('rejects API expressions on fixed scan pages', () => {
    expect(() =>
      selectBrowserDomExpression({
        expression: 'fetch("https://basescan.org/api")',
        url: 'https://basescan.org/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow('API fetches are disabled');
    expect(() =>
      selectBrowserDomExpression({
        expression: 'fetch("https://www.xxyy.io/api/data/search/v3")',
        url: 'https://www.xxyy.io/meme',
      }),
    ).toThrow('requires a fixed DOM expression');
  });

  it('releases the cross-process lock when no persistent browser is running', async () => {
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'xxyy-chrome-driver-test-'));
    try {
      await expect(
        stopExplorerBrowser({
          env: { XXYY_BROWSER_PROFILE_DIRECTORY: profileDirectory },
        }),
      ).resolves.toBe(false);
      await expect(
        rm(path.join(profileDirectory, 'explorer-chrome-driver.lock')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(profileDirectory, { force: true, recursive: true });
    }
  });
});
