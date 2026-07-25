import { describe, expect, it } from 'vitest';

import { createInMemoryChainAnalysisMcpClient } from './client.js';
import { createChainAnalysisFixtureRuntime } from './fixture-handler.test-helper.js';

describe('createInMemoryChainAnalysisMcpClient', () => {
  it('invokes transaction and Sandwich analysis through a real MCP transport', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.confirmed-v2');
    if (runtime.poolAddress === undefined) {
      throw new Error('Confirmed Sandwich fixture requires a pool address.');
    }
    const client = createInMemoryChainAnalysisMcpClient({ handler: runtime.handler });

    try {
      await expect(
        client.inspectTransaction({
          chainId: runtime.chainId,
          transactionHash: runtime.transactionHash,
        }),
      ).resolves.toMatchObject({
        capability: {
          capability: 'chain.inspect_transaction',
          transactionHash: runtime.transactionHash,
        },
      });
      await expect(
        client.detectSandwich({
          chainId: runtime.chainId,
          poolAddress: runtime.poolAddress,
          transactionHash: runtime.transactionHash,
        }),
      ).resolves.toMatchObject({
        capability: {
          capability: 'chain.detect_sandwich',
          verdict: 'confirmed',
        },
      });
    } finally {
      await client.close();
    }
  });

  it('preserves safe dynamic-allowlist errors across MCP', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.confirmed-v2');
    const client = createInMemoryChainAnalysisMcpClient({ handler: runtime.handler });

    try {
      await expect(
        client.detectSandwich({
          chainId: runtime.chainId,
          poolAddress: '0x9999999999999999999999999999999999999999',
          transactionHash: runtime.transactionHash,
        }),
      ).rejects.toMatchObject({
        code: 'pool_not_configured',
      });
    } finally {
      await client.close();
    }
  });

  it('rejects calls after closing the bridge', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const client = createInMemoryChainAnalysisMcpClient({ handler: runtime.handler });
    await client.close();

    await expect(
      client.inspectTransaction({
        chainId: runtime.chainId,
        transactionHash: runtime.transactionHash,
      }),
    ).rejects.toThrow('closed');
  });
});
