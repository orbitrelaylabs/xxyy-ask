import { describe, expect, it } from 'vitest';

import {
  PUBLIC_BASE_RPC_ENDPOINT,
  PUBLIC_BSC_RPC_ENDPOINT,
  PUBLIC_ETHEREUM_RPC_ENDPOINT,
  PUBLIC_ROBINHOOD_RPC_ENDPOINT,
  PUBLIC_SOLANA_RPC_ENDPOINT,
  PUBLIC_STABLE_RPC_ENDPOINT,
  loadPublicOnchainMcpConfig,
} from './public-mcp-config.js';

describe('public onchain MCP configuration', () => {
  it('uses free public RPC defaults only outside production', () => {
    const config = loadPublicOnchainMcpConfig({});
    expect(config).toMatchObject({
      evm: [
        {
          chainId: '1',
          providers: [{ endpoint: PUBLIC_ETHEREUM_RPC_ENDPOINT }],
        },
        {
          chainId: '56',
          providers: [{ endpoint: PUBLIC_BSC_RPC_ENDPOINT }],
        },
        {
          chainId: '8453',
          providers: [{ endpoint: PUBLIC_BASE_RPC_ENDPOINT }],
        },
        {
          chainId: '4663',
          providers: [{ endpoint: PUBLIC_ROBINHOOD_RPC_ENDPOINT }],
        },
        {
          chainId: '988',
          providers: [{ endpoint: PUBLIC_STABLE_RPC_ENDPOINT }],
        },
      ],
      profile: 'public_development_defaults',
      solana: {
        providers: [{ endpoint: PUBLIC_SOLANA_RPC_ENDPOINT }],
      },
    });
    expect(() => loadPublicOnchainMcpConfig({ NODE_ENV: 'production' })).toThrow(
      'required in production',
    );
  });

  it('accepts a strict startup-time provider configuration', () => {
    const config = loadPublicOnchainMcpConfig({
      NODE_ENV: 'production',
      ONCHAIN_RPC_CONFIG_JSON: JSON.stringify({
        evm: [
          {
            chainId: '1',
            providers: [{ endpoint: 'https://eth.example/rpc', id: 'eth_private' }],
          },
        ],
        solana: {
          network: 'solana:mainnet',
          providers: [{ endpoint: 'https://sol.example/rpc', id: 'sol_private' }],
        },
      }),
    });
    expect(config.profile).toBe('configured');
    expect(config.evm[0]?.providers[0]?.id).toBe('eth_private');
  });

  it('rejects arbitrary fields and insecure production localhost configuration', () => {
    expect(() =>
      loadPublicOnchainMcpConfig({
        ONCHAIN_RPC_CONFIG_JSON: JSON.stringify({
          evm: [],
          arbitraryRpcMethod: 'debug_traceTransaction',
        }),
      }),
    ).toThrow('strict provider validation');
    expect(() =>
      loadPublicOnchainMcpConfig({
        NODE_ENV: 'production',
        ONCHAIN_ALLOW_INSECURE_LOCALHOST: 'true',
      }),
    ).toThrow('forbidden in production');
  });
});
