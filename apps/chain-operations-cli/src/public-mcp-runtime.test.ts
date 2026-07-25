import { describe, expect, it } from 'vitest';

import { loadPublicOnchainMcpConfig } from './public-mcp-config.js';
import { createPublicOnchainMcpHandler } from './public-mcp-runtime.js';

const HASH = `0x${'ab'.repeat(32)}`;

describe('createPublicOnchainMcpHandler', () => {
  it('advertises all six XXYY product chains without enabling Sandwich by default', () => {
    const handler = createPublicOnchainMcpHandler(loadPublicOnchainMcpConfig({}), {
      fetchImpl: () => Promise.reject(new Error('not used')),
    });
    expect(handler.getCapabilities()).toMatchObject({
      chains: [
        {
          chainId: '1',
          network: 'eip155:1',
          protocols: [],
          tools: ['get_transaction', 'inspect_transaction'],
        },
        {
          chainId: '56',
          network: 'eip155:56',
          protocols: [],
          tools: ['get_transaction', 'inspect_transaction'],
        },
        {
          chainId: '8453',
          network: 'eip155:8453',
          protocols: [],
          tools: ['get_transaction', 'inspect_transaction'],
        },
        {
          chainId: '4663',
          network: 'eip155:4663',
          protocols: [],
          tools: ['get_transaction', 'inspect_transaction'],
        },
        {
          chainId: '988',
          network: 'eip155:988',
          protocols: [],
          tools: ['get_transaction', 'inspect_transaction'],
        },
      ],
      networks: [
        {
          family: 'solana',
          network: 'solana:mainnet',
          tools: ['get_transaction'],
        },
      ],
    });
  });

  it('routes an Etherscan reference through the configured EVM RPC adapter', async () => {
    const requestedMethods: string[] = [];
    const handler = createPublicOnchainMcpHandler(
      loadPublicOnchainMcpConfig({
        ONCHAIN_RPC_CONFIG_JSON: JSON.stringify({
          evm: [
            {
              chainId: '1',
              providers: [{ endpoint: 'https://eth.example/rpc', id: 'eth' }],
            },
          ],
        }),
      }),
      {
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
      },
    );

    await expect(
      handler.getTransaction({ reference: `https://etherscan.io/tx/${HASH}` }),
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
  });
});
