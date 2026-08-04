import { describe, expect, it, vi } from 'vitest';

import { createXxyyMarketDataClient } from './client.js';

describe('XXYY market data adapter', () => {
  it('matches a trade only by full transaction id and preserves full maker data', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const href = String(url);
      if (href.includes('/api/data/search/v3')) {
        return jsonResponse({
          code: 0,
          data: {
            results: [
              {
                pairInfo: {
                  address: 'pool-1',
                  baseToken: 'token-1',
                  chain: 'sol',
                  dexId: 'pfamm',
                  liquidityUSD: '10000.5',
                  quoteToken: 'wrapped-sol',
                },
              },
            ],
          },
        });
      }
      expect(init?.method).toBe('POST');
      return jsonResponse({
        code: 0,
        data: [
          {
            blockNumber: 122,
            logIndex: 99,
            maker: 'earlier-attacker',
            nativeAmount: '0.8',
            timestamp: 1_699_999_999_999,
            tokenAmount: '800',
            txHash: 'earlier-transaction-id',
            type: 'buy',
            usdAmount: '160',
          },
          {
            blockNumber: 123,
            logIndex: 7,
            maker: 'full-maker-address',
            nativeAmount: '1.25',
            timestamp: 1_700_000_000_000,
            tokenAmount: '1000',
            txHash: 'exact-transaction-id',
            type: 'buy',
            usdAmount: '200',
          },
          {
            blockNumber: 124,
            logIndex: 1,
            maker: 'suffix-collision-address',
            nativeAmount: '1',
            timestamp: 1_699_999_999_998,
            tokenAmount: '900',
            txHash: 'different-transaction-id',
            type: 'buy',
          },
        ],
      });
    });
    const client = createXxyyMarketDataClient({ fetchImpl });

    await expect(
      client.findTrade({
        actor: 'full-maker-address',
        chain: 'solana:mainnet',
        targetTokenAddresses: ['token-1'],
        timestampMs: 1_700_000_000_000,
        transactionId: 'exact-transaction-id',
      }),
    ).resolves.toMatchObject({
      matchedPair: { pairAddress: 'pool-1' },
      status: 'exact',
      trade: {
        blockNumber: '123',
        logIndex: 7,
        maker: 'full-maker-address',
        transactionId: 'exact-transaction-id',
      },
      contextTrades: [
        expect.objectContaining({
          maker: 'earlier-attacker',
          relation: 'earlier',
          transactionId: 'earlier-transaction-id',
        }),
        expect.objectContaining({
          maker: 'suffix-collision-address',
          relation: 'later',
          transactionId: 'different-transaction-id',
        }),
      ],
    });
    const tradeRequest = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes('/api/data/trades/search'),
    );
    expect(JSON.parse(String(tradeRequest?.[1]?.body))).toMatchObject({ makerAddress: '' });
    expect(tradeRequest?.[1]?.headers).toMatchObject({
      'x-chain': 'sol',
      'x-language': 'zh',
      'x-version': '1',
    });
  });

  it('keeps widening a matched timestamp search to preserve surrounding trades', async () => {
    let tradeCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/search/v3')) {
        return jsonResponse({
          code: 0,
          data: {
            results: [
              {
                pairInfo: {
                  address: 'pool-1',
                  baseToken: 'token-1',
                  chain: 'bsc',
                  quoteToken: 'wrapped-bnb',
                },
              },
            ],
          },
        });
      }
      tradeCalls += 1;
      return jsonResponse({
        code: 0,
        data:
          tradeCalls === 1
            ? []
            : [
                {
                  blockNumber: 113369791,
                  logIndex: 406,
                  maker: '0x0b8fdf1678755561d9ad14d5422fcdd0aedae378',
                  nativeAmount: '0.494074594267978411',
                  timestamp: 1_785_576_519_057,
                  tokenAmount: '182276.429094995367852001',
                  txHash: `0x${'1'.repeat(64)}`,
                  type: 'buy',
                  usdAmount: '289.2658527060733653',
                },
              ],
      });
    });
    const client = createXxyyMarketDataClient({ fetchImpl });

    await expect(
      client.findTrade({
        chain: 'eip155:56',
        targetTokenAddresses: ['token-1'],
        timestampMs: 1_785_576_519_000,
        transactionId: `0x${'1'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({
      status: 'exact',
      trade: { blockNumber: '113369791', logIndex: 406 },
    });
    expect(tradeCalls).toBe(3);
    const tradeRequests = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('/api/data/trades/search'),
    );
    expect(JSON.parse(String(tradeRequests[0]?.[1]?.body))).toMatchObject({
      timeEnd: 1_785_576_521_000,
      timeStart: 1_785_576_517_000,
    });
    expect(JSON.parse(String(tradeRequests[1]?.[1]?.body))).toMatchObject({
      timeEnd: 1_785_576_534_000,
      timeStart: 1_785_576_504_000,
    });
  });

  it('fails closed when the chain-derived actor conflicts with XXYY market data', async () => {
    const client = createXxyyMarketDataClient({
      fetchImpl: async (url) =>
        String(url).includes('/search/v3')
          ? jsonResponse({
              code: 0,
              data: {
                results: [
                  {
                    pairInfo: {
                      address: 'pool-1',
                      baseToken: 'token-1',
                      chain: 'sol',
                      quoteToken: 'wrapped-sol',
                    },
                  },
                ],
              },
            })
          : jsonResponse({
              code: 0,
              data: [
                {
                  maker: 'different-maker',
                  nativeAmount: '1',
                  timestamp: 1,
                  tokenAmount: '2',
                  txHash: 'tx-1',
                  type: 'sell',
                },
              ],
            }),
    });

    await expect(
      client.findTrade({
        actor: 'chain-maker',
        chain: 'solana:mainnet',
        targetTokenAddresses: ['token-1'],
        transactionId: 'tx-1',
      }),
    ).resolves.toMatchObject({
      diagnostics: [{ code: 'source_actor_conflict' }],
      status: 'conflict',
    });
  });

  it('never accepts an endpoint from tool input', async () => {
    const client = createXxyyMarketDataClient({ fetchImpl: vi.fn() });
    await expect(
      client.findTrade({
        chain: 'solana:mainnet',
        endpoint: 'https://attacker.example',
        targetTokenAddresses: ['token-1'],
        transactionId: 'tx-1',
      } as never),
    ).rejects.toThrow();
  });

  it('normalizes fixed XXYY EVM chain aliases and checksum casing', async () => {
    const client = createXxyyMarketDataClient({
      fetchImpl: async (url) =>
        String(url).includes('/search/v3')
          ? jsonResponse({
              code: 0,
              data: {
                results: [
                  {
                    pairInfo: {
                      address: '0x2222222222222222222222222222222222222222',
                      baseToken: '0x3333333333333333333333333333333333333333',
                      chain: 'eth',
                      quoteToken: '0x4444444444444444444444444444444444444444',
                    },
                  },
                ],
              },
            })
          : jsonResponse({
              code: 0,
              data: [
                {
                  maker: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                  nativeAmount: '1',
                  timestamp: 1,
                  tokenAmount: '2',
                  txHash: `0x${'B'.repeat(64)}`,
                  type: 'buy',
                },
              ],
            }),
    });

    await expect(
      client.findTrade({
        actor: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        chain: 'eip155:1',
        targetTokenAddresses: ['0x3333333333333333333333333333333333333333'],
        transactionId: `0x${'b'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({ status: 'exact' });
  });

  it('fails closed when one transaction appears under multiple candidate pools', async () => {
    const client = createXxyyMarketDataClient({
      fetchImpl: async (url) =>
        String(url).includes('/search/v3')
          ? jsonResponse({
              code: 0,
              data: {
                results: ['pool-1', 'pool-2'].map((address) => ({
                  pairInfo: {
                    address,
                    baseToken: 'token-1',
                    chain: 'sol',
                    quoteToken: 'wrapped-sol',
                  },
                })),
              },
            })
          : jsonResponse({
              code: 0,
              data: [
                {
                  maker: 'maker-1',
                  nativeAmount: '1',
                  timestamp: 1,
                  tokenAmount: '2',
                  txHash: 'tx-1',
                  type: 'buy',
                },
              ],
            }),
    });

    await expect(
      client.findTrade({
        chain: 'solana:mainnet',
        targetTokenAddresses: ['token-1'],
        transactionId: 'tx-1',
      }),
    ).resolves.toMatchObject({
      diagnostics: [{ code: 'multiple_transaction_matches' }],
      status: 'conflict',
    });
  });

  it('resolves duplicate XXYY matches only when one candidate pool is present in the chain transaction', async () => {
    const client = createXxyyMarketDataClient({
      fetchImpl: async (url) =>
        String(url).includes('/search/v3')
          ? jsonResponse({
              code: 0,
              data: {
                results: ['pool-1', 'pool-2'].map((address) => ({
                  pairInfo: {
                    address,
                    baseToken: 'token-1',
                    chain: 'sol',
                    quoteToken: 'wrapped-sol',
                  },
                })),
              },
            })
          : jsonResponse({
              code: 0,
              data: [
                {
                  maker: 'maker-1',
                  nativeAmount: '1',
                  timestamp: 1,
                  tokenAmount: '2',
                  txHash: 'tx-1',
                  type: 'buy',
                },
              ],
            }),
    });

    await expect(
      client.findTrade({
        chain: 'solana:mainnet',
        targetTokenAddresses: ['token-1'],
        transactionAccountAddresses: ['maker-1', 'pool-2'],
        transactionId: 'tx-1',
      }),
    ).resolves.toMatchObject({
      matchedPair: { pairAddress: 'pool-2' },
      status: 'exact',
    });
  });

  it('stops pair discovery after the first candidate-bearing token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/search/v3')
        ? jsonResponse({
            code: 0,
            data: {
              results: Array.from({ length: 64 }, (_, index) => ({
                pairInfo: {
                  address: `pool-${index}`,
                  baseToken: 'token-1',
                  chain: 'bsc',
                  quoteToken: 'wrapped-bnb',
                },
              })),
            },
          })
        : jsonResponse({ code: 0, data: [] }),
    );
    const client = createXxyyMarketDataClient({ fetchImpl });

    const result = await client.findTrade({
      chain: 'eip155:56',
      targetTokenAddresses: ['token-1', 'token-2'],
      transactionId: 'tx-1',
    });

    expect(result.candidatePairs).toHaveLength(64);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/search/v3'))).toHaveLength(
      1,
    );
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}
