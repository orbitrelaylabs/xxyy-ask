import { describe, expect, it } from 'vitest';

import {
  createPublicOnchainMcpClient,
  createPublicOnchainMcpHandler,
  loadPublicOnchainMcpConfig,
} from './public-runtime.js';

const HASH = `0x${'ab'.repeat(32)}`;
const FACTORY = `0x${'11'.repeat(20)}`;
const POOL = `0x${'33'.repeat(20)}`;
const TOKEN_0 = `0x${'44'.repeat(20)}`;
const TOKEN_1 = `0x${'55'.repeat(20)}`;

describe('public onchain MCP runtime', () => {
  it('requires a strict startup allowlist and rejects insecure production localhost RPCs', () => {
    expect(() => loadPublicOnchainMcpConfig({})).toThrow('ONCHAIN_RPC_CONFIG_JSON is required');
    expect(() =>
      loadPublicOnchainMcpConfig({
        NODE_ENV: 'production',
        ONCHAIN_ALLOW_INSECURE_LOCALHOST: 'true',
        ONCHAIN_RPC_CONFIG_JSON: JSON.stringify({
          evm: [
            {
              chainId: '1',
              providers: [{ endpoint: 'http://localhost:8545', id: 'local' }],
            },
          ],
        }),
      }),
    ).toThrow('forbidden in production');
    expect(() =>
      loadPublicOnchainMcpConfig({
        NODE_ENV: 'production',
        ONCHAIN_RPC_CONFIG_JSON: JSON.stringify({
          evm: [
            {
              chainId: '1',
              providers: [{ endpoint: 'https://snapshot.example/rpc', id: 'snapshot' }],
            },
          ],
          execution: [
            {
              chainId: '1',
              factories: { uniswapV2: [], uniswapV3: [] },
              providers: [{ endpoint: 'https://trace.example/rpc', id: 'trace' }],
            },
          ],
        }),
      }),
    ).toThrow('readiness-gated chain-analysis composition');
  });

  it('allows explicitly configured Blockscout partial trace evidence in production', () => {
    const config = loadPublicOnchainMcpConfig({
      NODE_ENV: 'production',
      ONCHAIN_RPC_CONFIG_JSON: JSON.stringify({
        evm: [
          {
            chainId: '4663',
            providers: [{ endpoint: 'https://snapshot.example/rpc', id: 'snapshot' }],
          },
        ],
        execution: [
          {
            chainId: '4663',
            factories: { uniswapV2: [FACTORY], uniswapV3: [] },
            providers: [
              {
                endpoint: 'https://snapshot.example/rpc',
                id: 'execution',
                traceSource: {
                  endpoint: 'https://blockscout.example',
                  id: 'blockscout',
                  kind: 'blockscout_v2',
                },
              },
            ],
          },
        ],
      }),
    });

    expect(config.execution?.[0]?.providers[0]?.traceSource).toEqual({
      endpoint: 'https://blockscout.example',
      id: 'blockscout',
      kind: 'blockscout_v2',
    });
  });

  it('queries an Explorer reference through linked MCP and the configured RPC adapter', async () => {
    const requestedMethods: string[] = [];
    const client = createPublicOnchainMcpClient({
      env: {
        ONCHAIN_RPC_CONFIG_JSON: JSON.stringify({
          evm: [
            {
              chainId: '1',
              providers: [{ endpoint: 'https://eth.example/rpc', id: 'eth' }],
            },
          ],
        }),
      },
      fetchImpl: (_url, init) => {
        if (typeof init?.body !== 'string') {
          throw new TypeError('Expected a JSON string request body.');
        }
        const body = JSON.parse(init.body) as Array<{ method: string }>;
        requestedMethods.push(...body.map((item) => item.method));
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { id: 1, jsonrpc: '2.0', result: null },
              { id: 2, jsonrpc: '2.0', result: null },
              { id: 3, jsonrpc: '2.0', result: '0x1' },
            ]),
            { status: 200 },
          ),
        );
      },
    });

    try {
      await expect(
        client.getTransaction({ reference: `https://etherscan.io/tx/${HASH}` }),
      ).resolves.toMatchObject({
        family: 'evm',
        network: 'eip155:1',
        status: 'insufficient_data',
      });
      expect(requestedMethods).toEqual([
        'eth_getTransactionByHash',
        'eth_getTransactionReceipt',
        'eth_chainId',
      ]);
    } finally {
      await client.close();
    }
  });

  it('strictly wires optional execution and MEV allowlists into the public handler', () => {
    const config = loadPublicOnchainMcpConfig({
      ONCHAIN_RPC_CONFIG_JSON: JSON.stringify({
        evm: [
          {
            chainId: '1',
            providers: [{ endpoint: 'https://snapshot.example/rpc', id: 'snapshot' }],
          },
        ],
        execution: [
          {
            chainId: '1',
            factories: {
              uniswapV2: [FACTORY],
              uniswapV3: [],
            },
            providers: [{ endpoint: 'https://trace.example/rpc', id: 'trace' }],
          },
        ],
        mevObservation: [
          {
            chainId: '1',
            pools: [
              {
                exactInputRoutes: [],
                feePips: 3000,
                poolAddress: POOL,
                protocol: 'uniswap_v2',
                token0: TOKEN_0,
                token1: TOKEN_1,
                tokenBehavior: 'standard',
              },
            ],
            providers: [
              {
                archive: true,
                costUnitsPerRequest: 1,
                endpoint: 'https://archive.example/rpc',
                id: 'archive',
              },
            ],
          },
        ],
      }),
    });
    const handler = createPublicOnchainMcpHandler(config, {
      fetchImpl: () => Promise.reject(new Error('not used')),
    });

    expect(config).toMatchObject({
      execution: [{ chainId: '1' }],
      mevObservation: [{ chainId: '1', pools: [{ poolAddress: POOL }] }],
    });
    expect(handler.getCapabilities()).toMatchObject({
      chains: [
        {
          chainId: '1',
          protocols: ['uniswap_v2'],
          tools: ['get_transaction', 'inspect_transaction', 'detect_sandwich'],
        },
      ],
    });
  });
});
