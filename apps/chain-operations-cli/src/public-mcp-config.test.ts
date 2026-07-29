import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { loadPublicOnchainMcpConfig } from './public-mcp-config.js';

describe('public onchain MCP configuration', () => {
  it('requires the same explicit RPC configuration in every environment', () => {
    expect(() => loadPublicOnchainMcpConfig({})).toThrow('ONCHAIN_RPC_CONFIG_JSON is required');
    expect(() => loadPublicOnchainMcpConfig({ NODE_ENV: 'production' })).toThrow(
      'ONCHAIN_RPC_CONFIG_JSON is required',
    );
  });

  it('keeps the six public convenience RPCs in .env.example instead of runtime code', () => {
    const example = parseEnv(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
    );
    expect(example.ONCHAIN_RPC_CONFIG_JSON).toBeTypeOf('string');
    const config = loadPublicOnchainMcpConfig({
      ONCHAIN_ALLOW_INSECURE_LOCALHOST: example.ONCHAIN_ALLOW_INSECURE_LOCALHOST ?? 'false',
      ONCHAIN_RPC_CONFIG_JSON: example.ONCHAIN_RPC_CONFIG_JSON ?? '',
    });
    const productionConfig = loadPublicOnchainMcpConfig({
      NODE_ENV: 'production',
      ONCHAIN_ALLOW_INSECURE_LOCALHOST: example.ONCHAIN_ALLOW_INSECURE_LOCALHOST ?? 'false',
      ONCHAIN_RPC_CONFIG_JSON: example.ONCHAIN_RPC_CONFIG_JSON ?? '',
    });

    expect(config).toEqual({
      allowInsecureLocalhost: false,
      evm: [
        {
          chainId: '1',
          providers: [{ endpoint: 'https://ethereum-rpc.publicnode.com', id: 'ethereum_public' }],
        },
        {
          chainId: '56',
          providers: [{ endpoint: 'https://bsc-dataseed-public.bnbchain.org', id: 'bsc_public' }],
        },
        {
          chainId: '8453',
          providers: [{ endpoint: 'https://mainnet.base.org', id: 'base_public' }],
        },
        {
          chainId: '4663',
          providers: [
            {
              endpoint: 'https://rpc.mainnet.chain.robinhood.com',
              id: 'robinhood_public',
            },
          ],
        },
        {
          chainId: '988',
          providers: [{ endpoint: 'https://rpc.stable.xyz', id: 'stable_public' }],
        },
      ],
      execution: [
        {
          chainId: '4663',
          factories: {
            uniswapV2: ['0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f'],
            uniswapV3: ['0x1f7d7550b1b028f7571e69a784071f0205fd2efa'],
          },
          providers: [
            {
              endpoint: 'https://rpc.mainnet.chain.robinhood.com',
              id: 'robinhood_public_execution',
              traceSource: {
                endpoint: 'https://robinhoodchain.blockscout.com',
                id: 'robinhood_blockscout',
                kind: 'blockscout_v2',
              },
            },
          ],
        },
      ],
      profile: 'configured',
      solana: {
        network: 'solana:mainnet',
        providers: [{ endpoint: 'https://api.mainnet.solana.com', id: 'solana_public' }],
      },
    });
    expect(productionConfig).toEqual(config);
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
  });
});
