import { describe, expect, it, vi } from 'vitest';

import {
  createXxyyBrowserFetch,
  createXxyyPairSearchExpression,
  createXxyyTradeTableExpression,
} from './xxyy-browser-fetch-runtime.mjs';

describe('XXYY browser fetch compatibility runtime', () => {
  it('projects pair and trade data from fixed page evaluators without direct API requests', async () => {
    const originalFetch = vi.fn();
    const evaluate = vi.fn(async (input) =>
      input.url === 'https://www.xxyy.io/'
        ? [
            {
              address: 'pair1',
              baseToken: 'token1',
              chain: 'sol',
              dexId: 'amm',
              liquidityUSD: '123.45',
              quoteToken: 'quote1',
            },
          ]
        : [
            {
              maker: 'maker1',
              marketCapUSD: '1000',
              nativeAmount: '1.25',
              timestamp: 1_787_376_615_788,
              tokenAmount: '42',
              txHash: 'transaction1',
              type: 'buy',
              usdAmount: '99.50',
            },
          ],
    );
    const browserFetch = createXxyyBrowserFetch({ evaluate, originalFetch });

    const pairs = await (
      await browserFetch('https://www.xxyy.io/api/data/search/v3?q=token1')
    ).json();
    const trades = await (
      await browserFetch('https://www.xxyy.io/api/data/trades/search', {
        body: JSON.stringify({ pairAddress: 'pair1', timeEnd: '', timeStart: '' }),
        headers: { 'content-type': 'application/json', 'x-chain': 'sol' },
        method: 'POST',
      })
    ).json();

    expect(pairs).toEqual({
      code: 0,
      data: {
        results: [
          {
            pairInfo: {
              address: 'pair1',
              baseToken: 'token1',
              chain: 'sol',
              dexId: 'amm',
              liquidityUSD: '123.45',
              quoteToken: 'quote1',
            },
          },
        ],
      },
    });
    expect(trades).toMatchObject({
      code: 0,
      data: [{ maker: 'maker1', txHash: 'transaction1', type: 'buy' }],
    });
    expect(originalFetch).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[0]?.[0].expression).not.toContain('fetch(');
    expect(evaluate.mock.calls[1]?.[0].expression).not.toContain('fetch(');
  });

  it('passes non-XXYY requests through and fails closed for unknown XXYY API paths', async () => {
    const originalFetch = vi.fn(async () => new Response('ok'));
    const browserFetch = createXxyyBrowserFetch({
      evaluate: vi.fn(),
      originalFetch,
    });

    await expect((await browserFetch('https://example.com/page')).text()).resolves.toBe('ok');
    await expect(browserFetch('https://www.xxyy.io/api/unknown')).rejects.toThrow(
      'Direct XXYY API access is disabled',
    );
    expect(originalFetch).toHaveBeenCalledOnce();
  });

  it('collapses progressive history windows into one browser component session', async () => {
    const evaluate = vi.fn(async () => [
      {
        maker: 'maker1',
        nativeAmount: '1',
        timestamp: 1_000,
        tokenAmount: '2',
        txHash: 'target-transaction',
        type: 'buy',
      },
    ]);
    const browserFetch = createXxyyBrowserFetch({
      evaluate,
      originalFetch: vi.fn(),
      targetTransactionId: 'target-transaction',
    });
    for (const windowMs of [2_000, 15_000, 120_000]) {
      await browserFetch('https://www.xxyy.io/api/data/trades/search', {
        body: JSON.stringify({
          pairAddress: 'pair1',
          timeEnd: 200_000 + windowMs,
          timeStart: 200_000 - windowMs,
        }),
        headers: { 'content-type': 'application/json', 'x-chain': 'sol' },
        method: 'POST',
      });
    }

    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0].expression).toContain('120000');
    expect(evaluate.mock.calls[0]?.[0].expression).toContain('target-transaction');
  });

  it('builds fixed browser expressions that operate only on native Vue component state', () => {
    expect(createXxyyPairSearchExpression('token1')).toContain("findComponent('SearchDialog')");
    expect(createXxyyTradeTableExpression({ timeEnd: 200, timeStart: 100 })).toContain(
      "findComponent('tradeTable')",
    );
    expect(createXxyyPairSearchExpression('token1')).not.toContain('fetch(');
    expect(createXxyyTradeTableExpression({})).not.toContain('fetch(');
  });
});
