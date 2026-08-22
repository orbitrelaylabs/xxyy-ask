import { access, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createBrowserChainAnalysisClient,
  createChromeBrowserPageEvaluator,
  createScanPageTransactionExpression,
  ExplorerBrowserUnavailableError,
  ExplorerBrowserVerificationError,
  prepareBrowserProfile,
  resolveExplorerChromeLaunch,
  resolveExplorerBrowserDriverExecutable,
  resolveSolanaBrowserTransactionId,
} from './browser-chain-analysis-client.js';

const signature =
  'mC3JipVwKobtkB1evDCxb9jDWqic9aVaRj81r6ffNweQ3gfmA9vPJCmftTuUCECb35TbvovRznezsuL7TCq6BVb';

describe('browser chain analysis client', () => {
  it('accepts a Solana signature or fixed Solscan transaction URL', () => {
    expect(resolveSolanaBrowserTransactionId(signature, 'solana:mainnet')).toBe(signature);
    expect(resolveSolanaBrowserTransactionId(`https://solscan.io/tx/${signature}`)).toBe(signature);
  });

  it('rejects non-allowlisted explorer URLs and non-Solana networks', () => {
    expect(() =>
      resolveSolanaBrowserTransactionId(`https://example.com/tx/${signature}`),
    ).toThrow();
    expect(() => resolveSolanaBrowserTransactionId(signature, 'eip155:1')).toThrow();
  });

  it('waits for transient scan verification but fails closed on a hard block', () => {
    const evaluate = (title: string, innerText: string) =>
      Function(
        'document',
        'location',
        `return ${createScanPageTransactionExpression()}`,
      )({ body: { innerText }, title }, { pathname: '/tx/0x' }) as unknown;

    expect(evaluate('Just a moment...', 'Performing security verification')).toBeNull();
    expect(evaluate('Attention Required', 'Sorry, you have been blocked')).toEqual({
      blocked: true,
    });
  });

  it('preserves the concrete execution error shown by a scan explorer', () => {
    const hash = `0x${'3'.repeat(64)}`;
    const from = `0x${'a'.repeat(40)}`;
    const to = `0x${'b'.repeat(40)}`;
    const innerText = [
      'Status:',
      "Fail with Custom Error 'SafeTransferFailed ()'",
      'Warning! Error encountered during contract execution [execution reverted]',
      'Block: 113521306',
      '(1785630312)',
      'From:',
      from,
      'To:',
      to,
      'Value: 0.5 BNB',
      'Transaction Fee: 0.0208102824 BNB',
    ].join('\n');
    const value = Function(
      'document',
      'location',
      `return ${createScanPageTransactionExpression()}`,
    )(
      { body: { innerText }, querySelectorAll: () => [], title: 'Bsc Transaction Hash' },
      { origin: 'https://bscscan.com', pathname: `/tx/${hash}` },
    ) as { failureReason?: string; status?: string };

    expect(value.status).toBe('reverted');
    expect(value.failureReason).toBe("Fail with Custom Error 'SafeTransferFailed ()'");
  });

  it('extracts V4 pool identifiers from scan Explorer Swap event logs', () => {
    const hash = `0x${'3'.repeat(64)}`;
    const from = `0x${'a'.repeat(40)}`;
    const to = `0x${'b'.repeat(40)}`;
    const emitter = `0x${'c'.repeat(40)}`;
    const poolId = '1E66E233CBEC7CC091F16DFA1FE19130D9853DD3DDE9BAA308A9B8A4C81658F5';
    const eventRow = {
      getAttribute: (name: string) => (name === 'id' ? 'logI_970' : null),
      querySelectorAll: () => [
        { getAttribute: () => `/address/${emitter}`, parentElement: null, textContent: emitter },
      ],
      textContent: `Address ${emitter}\nNameSwap (index_topic_1 bytes32 id) View Source Topics0 0x${'f'.repeat(64)} 1: id DecDecode Hex ${poolId} amount0 (int128) :-46215000000000000 amount1 (int128) :172347457808914585152`,
    };
    const innerText = [
      'Status:',
      'Success',
      'Block: 115509048',
      '(1786539681)',
      'From:',
      from,
      'To:',
      to,
      'Value: 0.5135 BNB',
      'Transaction Fee: 0.0006829536 BNB',
    ].join('\n');
    const value = Function(
      'document',
      'location',
      `return ${createScanPageTransactionExpression()}`,
    )(
      {
        body: { innerText },
        querySelectorAll: (selector: string) => (selector.includes('logI_') ? [eventRow] : []),
        title: 'Bsc Transaction Hash',
      },
      { origin: 'https://bscscan.com', pathname: `/tx/${hash}` },
    ) as {
      accountAddresses: string[];
      swapPools: Array<{ emitterAddress: string; logIndex: number; poolIdentifier: string }>;
    };

    expect(value.swapPools).toEqual([
      {
        amount0Raw: '-46215000000000000',
        amount1Raw: '172347457808914585152',
        emitterAddress: emitter,
        logIndex: 970,
        poolIdentifier: `0x${poolId}`,
      },
    ]);
    expect(value.accountAddresses).toContain(`0x${poolId}`);
  });

  it('classifies a hard scan block as interactive verification', async () => {
    const client = createBrowserChainAnalysisClient({
      pageEvaluator: async () => ({ blocked: true }),
    });

    await expect(
      client.getTransaction({
        reference: `https://bscscan.com/tx/0x${'1'.repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(ExplorerBrowserVerificationError);
  });

  it('fails closed when an Explorer page returns a different transaction hash', async () => {
    const requestedHash = `0x${'1'.repeat(64)}`;
    const address = `0x${'a'.repeat(40)}`;
    const client = createBrowserChainAnalysisClient({
      pageEvaluator: async () => ({
        accountAddresses: [address],
        blockNumber: '1',
        feeWei: '1',
        from: address,
        hash: `0x${'2'.repeat(64)}`,
        rawInput: '0x',
        swapPools: [],
        status: 'success',
        timestamp: '2026-08-05T00:00:00.000Z',
        to: address,
        tokenAddresses: [],
        tokenTransfers: [],
        valueWei: '0',
      }),
    });

    await expect(
      client.getTransaction({ reference: `https://bscscan.com/tx/${requestedHash}` }),
    ).rejects.toThrow('transaction hash conflicted');
  });

  it('routes every XXYY-supported chain through one page evaluator', async () => {
    const evmHash = `0x${'1'.repeat(64)}`;
    const evmAddress = `0x${'a'.repeat(40)}`;
    const solanaAddress = '9eHe3W17meRrZhMSYQiLsUvo13a5xUYGABxnwErfHN3S';
    const calls: Array<{ expression?: string; fetchUrl?: string; url: string }> = [];
    const client = createBrowserChainAnalysisClient({
      pageEvaluator: async (input) => {
        calls.push({
          ...(input.expression === undefined ? {} : { expression: input.expression }),
          ...(input.fetchUrl === undefined ? {} : { fetchUrl: input.fetchUrl }),
          url: input.url,
        });
        if (input.url.includes('solscan.io')) {
          return {
            body: {
              data: {
                block_id: 1,
                fee: 5_000,
                log_message: [],
                parsed_instructions: [],
                sol_bal_change: [{ address: solanaAddress, change_amount: 0 }],
                status: 1,
                token_bal_change: [],
                trans_id: signature,
                trans_time: 1_700_000_000,
              },
              success: true,
            },
            status: 200,
          };
        }
        if (input.fetchUrl !== undefined) {
          return {
            block_number: 1,
            fee: { value: '1' },
            from: { hash: evmAddress },
            hash: evmHash,
            raw_input: '0x',
            status: 'ok',
            timestamp: '2026-08-05T00:00:00.000Z',
            to: { hash: evmAddress },
            token_transfers: [],
            value: '0',
          };
        }
        return {
          accountAddresses: [evmAddress],
          blockNumber: '1',
          feeWei: '1',
          from: evmAddress,
          hash: evmHash,
          rawInput: '0x',
          swapPools: [],
          status: 'success',
          timestamp: '2026-08-05T00:00:00.000Z',
          to: evmAddress,
          tokenAddresses: [],
          tokenTransfers: [],
          valueWei: '0',
        };
      },
    });

    const references = [
      `https://solscan.io/tx/${signature}`,
      `https://etherscan.io/tx/${evmHash}`,
      `https://bscscan.com/tx/${evmHash}`,
      `https://basescan.org/tx/${evmHash}`,
      `https://robinhoodchain.blockscout.com/tx/${evmHash}`,
      `https://stablescan.xyz/tx/${evmHash}`,
    ];
    const outputs = await Promise.all(
      references.map((reference) => client.getTransaction({ reference })),
    );

    expect(outputs.map((output) => output.network)).toEqual([
      'solana:mainnet',
      'eip155:1',
      'eip155:56',
      'eip155:8453',
      'eip155:4663',
      'eip155:988',
    ]);
    expect(calls).toHaveLength(6);
    expect(calls.filter((call) => call.fetchUrl !== undefined)).toHaveLength(3);
    expect(calls[0]?.expression).toContain('api-v2.solscan.io');
    expect(calls.filter((call) => call.expression !== undefined)).toHaveLength(3);
  });

  it('returns insufficient data when Solscan cannot locate the transaction', async () => {
    const client = createBrowserChainAnalysisClient({
      pageEvaluator: async () => ({
        body: {
          errors: { code: 2001, message: 'Transaction not found' },
          success: false,
        },
        status: 400,
      }),
    });

    await expect(
      client.getTransaction({ reference: `https://solscan.io/tx/${signature}` }),
    ).resolves.toMatchObject({
      family: 'solana',
      status: 'insufficient_data',
      transactionId: signature,
    });
  });

  it('does not silently fall back when the Chrome browser driver is unavailable', async () => {
    const evaluator = createChromeBrowserPageEvaluator({
      command: '/missing/xxyy-chrome-driver',
    });

    await expect(
      evaluator({
        expression: 'null',
        timeoutMs: 1_000,
        url: `https://bscscan.com/tx/0x${'1'.repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(ExplorerBrowserUnavailableError);
  });

  it('resolves the Chrome browser driver from the configured PATH', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xxyy-chrome-driver-test-'));
    const executable = path.join(directory, 'xxyy-chrome-driver');
    try {
      await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
      await chmod(executable, 0o700);

      await expect(resolveExplorerBrowserDriverExecutable(directory)).resolves.toBe(executable);
      await expect(resolveExplorerBrowserDriverExecutable('')).resolves.toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('keeps all explorer token links after prioritizing actor-received tokens', () => {
    const expression = createScanPageTransactionExpression();

    expect(expression).toContain('actionTokenLinks.length > 0');
    expect(expression).toContain('[...actorReceivedTokens, ...tokenLinks, ...textAddresses]');
    expect(expression).toContain('text.matchAll(/\\b0x[0-9a-f]{40}\\b/gi)');
    expect(expression).not.toContain('actorReceivedTokens.length > 0 ?');
  });

  it('prioritizes the token named by the explorer transaction action', () => {
    const hash = `0x${'4'.repeat(64)}`;
    const from = `0x${'a'.repeat(40)}`;
    const targetToken = `0x${'2'.repeat(40)}`;
    const dustToken = `0x${'5'.repeat(40)}`;
    const actionAnchor = tokenAnchor(targetToken, 'Swap 10 TARGET for 1 BNB');
    const dustAnchor = tokenAnchor(
      dustToken,
      `From 0xrouter To ${from} received 0.00001 DUST`,
      `?a=${from}`,
    );
    const innerText = [
      'Status:',
      'Success',
      'Block: 113923921',
      '(1785825932)',
      'From:',
      from,
      'Value: 0 BNB',
      'Transaction Fee: 0.001 BNB',
    ].join('\n');
    const value = Function(
      'document',
      'location',
      `return ${createScanPageTransactionExpression()}`,
    )(
      {
        body: { innerText },
        querySelectorAll: (selector: string) =>
          selector.includes('/token/') ? [actionAnchor, dustAnchor] : [],
        title: 'Bsc Transaction Hash',
      },
      { origin: 'https://bscscan.com', pathname: `/tx/${hash}` },
    ) as { tokenAddresses?: string[] };

    expect(value.tokenAddresses).toEqual([targetToken]);
  });

  it('does not mistake a transfer row beneath a generic swap action for the action token', () => {
    const hash = `0x${'6'.repeat(64)}`;
    const from = `0x${'a'.repeat(40)}`;
    const quoteToken = `0x${'5'.repeat(40)}`;
    const targetToken = `0x${'2'.repeat(40)}`;
    const misleadingQuoteAnchor = tokenAnchor(
      quoteToken,
      'PancakeSwap V2: TOKEN-USDT From router To pool For 583 USDT',
    );
    const receivedTargetAnchor = tokenAnchor(
      targetToken,
      `${from} received 2107091 TARGET`,
      `?a=${from}`,
    );
    const innerText = [
      'TRANSACTION ACTION',
      'Call Swap Function',
      'Status:',
      'Success',
      'Block: 113946329',
      '(1785836017)',
      'From:',
      from,
      'Value: 0 BNB',
      'Transaction Fee: 0.001 BNB',
    ].join('\n');
    const value = Function(
      'document',
      'location',
      `return ${createScanPageTransactionExpression()}`,
    )(
      {
        body: { innerText },
        querySelectorAll: (selector: string) =>
          selector.includes('/token/') ? [misleadingQuoteAnchor, receivedTargetAnchor] : [],
        title: 'Bsc Transaction Hash',
      },
      { origin: 'https://bscscan.com', pathname: `/tx/${hash}` },
    ) as { tokenAddresses?: string[] };

    expect(value.tokenAddresses?.[0]).toBe(targetToken);
  });

  it('removes browser profile locks left by a previous container', async () => {
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'xxyy-browser-profile-test-'));
    try {
      await symlink('previous-container-123', path.join(profileDirectory, 'SingletonLock'));
      await symlink('cookie', path.join(profileDirectory, 'SingletonCookie'));
      await symlink('/tmp/missing-browser-socket', path.join(profileDirectory, 'SingletonSocket'));
      await writeFile(path.join(profileDirectory, 'DevToolsActivePort'), '9222');

      await prepareBrowserProfile(profileDirectory);

      await expect(access(path.join(profileDirectory, 'SingletonLock'))).rejects.toThrow();
      await expect(access(path.join(profileDirectory, 'SingletonCookie'))).rejects.toThrow();
      await expect(access(path.join(profileDirectory, 'SingletonSocket'))).rejects.toThrow();
      await expect(access(path.join(profileDirectory, 'DevToolsActivePort'))).rejects.toThrow();
    } finally {
      await rm(profileDirectory, { force: true, recursive: true });
    }
  });

  it('uses a virtual display when xvfb-run is installed and otherwise stays headless', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'xxyy-xvfb-test-'));
    const xvfbRunExecutable = path.join(directory, 'xvfb-run');
    try {
      await writeFile(xvfbRunExecutable, '#!/bin/sh\n', { mode: 0o700 });
      await chmod(xvfbRunExecutable, 0o700);

      expect(
        await resolveExplorerChromeLaunch('/usr/bin/chromium', ['about:blank'], {
          xvfbRunExecutable,
        }),
      ).toEqual({
        arguments: [
          '-a',
          '--server-args=-screen 0 1600x1000x24 -nolisten tcp',
          '/usr/bin/chromium',
          'about:blank',
        ],
        command: xvfbRunExecutable,
      });
      expect(
        await resolveExplorerChromeLaunch('/usr/bin/chromium', ['about:blank'], {
          xvfbRunExecutable: path.join(directory, 'missing-xvfb-run'),
        }),
      ).toEqual({
        arguments: ['--headless=new', 'about:blank'],
        command: '/usr/bin/chromium',
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function tokenAnchor(token: string, parentText: string, suffix = '') {
  const grandparent = { parentElement: null, textContent: parentText };
  const parent = { parentElement: grandparent, textContent: parentText };
  return {
    getAttribute: () => `/token/${token}${suffix}`,
    parentElement: parent,
    textContent: '',
  };
}
