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
            maker: 'earlier-attacker',
            nativeAmount: '0.8',
            timestamp: 1_699_999_999_999,
            tokenAmount: '800',
            txHash: 'earlier-transaction-id',
            type: 'buy',
            usdAmount: '160',
          },
          {
            maker: 'full-maker-address',
            nativeAmount: '1.25',
            timestamp: 1_700_000_000_000,
            tokenAmount: '1000',
            txHash: 'exact-transaction-id',
            type: 'buy',
            usdAmount: '200',
          },
          {
            maker: 'suffix-collision-address',
            nativeAmount: '1',
            timestamp: 1_700_000_000_001,
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
      trade: { maker: 'full-maker-address', transactionId: 'exact-transaction-id' },
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
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}
