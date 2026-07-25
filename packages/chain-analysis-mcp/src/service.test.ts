import { describe, expect, it } from 'vitest';

import type { ChainAnalysisMcpToolError } from './errors.js';
import { createChainAnalysisFixtureRuntime } from './fixture-handler.test-helper.js';
import { createReadinessGuardedChainAnalysisHandler } from './runtime-guard.js';

describe('createChainAnalysisHandler', () => {
  it('inspects a transaction through snapshot, execution, and deterministic composition', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const capabilities = runtime.handler.getCapabilities();
    const chainId = capabilities.chains[0]?.chainId;
    expect(chainId).toBe('1');

    const output = await runtime.handler.inspectTransaction({
      chainId: runtime.chainId,
      transactionHash: runtime.transactionHash,
    });

    expect(output.capability).toMatchObject({
      capability: 'chain.inspect_transaction',
      executionEnrichmentStatus: 'partial',
      status: 'partial',
    });
    expect(output.execution?.internalTransfers.length).toBeGreaterThan(0);
    expect(output).not.toHaveProperty('observation');
    expect(runtime.executionInputs).toHaveLength(1);
  });

  it('detects a confirmed Sandwich without returning the raw observation payload', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.confirmed-v2');
    if (runtime.poolAddress === undefined) {
      throw new Error('Confirmed Sandwich fixture requires a pool address.');
    }
    const capabilities = runtime.handler.getCapabilities();
    expect(capabilities).toMatchObject({
      runtimeStatus: 'internal',
      chains: [
        {
          chainId: '1',
          protocols: ['uniswap_v2', 'uniswap_v3'],
          tools: ['get_transaction', 'inspect_transaction', 'detect_sandwich'],
        },
      ],
      networks: [],
    });

    const output = await runtime.handler.detectSandwich({
      chainId: runtime.chainId,
      poolAddress: runtime.poolAddress,
      transactionHash: runtime.transactionHash,
    });

    expect(output.capability).toMatchObject({
      capability: 'chain.detect_sandwich',
      status: 'success',
      verdict: 'confirmed',
    });
    expect(output.mev?.sandwich.verdict).toBe('confirmed');
    expect(output).not.toHaveProperty('observation');
    expect(runtime.executionInputs[0]?.pools).toEqual([
      {
        poolAddress: runtime.poolAddress,
        protocol: 'uniswap_v2',
      },
    ]);
  });

  it('fails closed for a pool outside the configured observation allowlist', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.confirmed-v2');

    await expect(
      runtime.handler.detectSandwich({
        chainId: runtime.chainId,
        poolAddress: '0x9999999999999999999999999999999999999999',
        transactionHash: runtime.transactionHash,
      }),
    ).rejects.toMatchObject({
      code: 'pool_not_configured',
    });
  });

  it('fails closed outside the attested readiness window', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    let now = new Date('2026-07-24T12:30:00.000Z');
    const handler = createReadinessGuardedChainAnalysisHandler({
      handler: runtime.handler,
      now: () => now,
      readyFrom: '2026-07-24T12:00:00.000Z',
      readyUntil: '2026-07-24T13:00:00.000Z',
    });

    expect(handler.getCapabilities().runtimeStatus).toBe('ready');
    await expect(
      handler.inspectTransaction({
        chainId: runtime.chainId,
        transactionHash: runtime.transactionHash,
      }),
    ).resolves.toMatchObject({
      capability: { capability: 'chain.inspect_transaction' },
    });

    now = new Date('2026-07-24T13:00:00.000Z');
    expect(handler.getCapabilities().runtimeStatus).toBe('degraded');
    await expect(
      handler.inspectTransaction({
        chainId: runtime.chainId,
        transactionHash: runtime.transactionHash,
      }),
    ).rejects.toMatchObject({
      code: 'runtime_not_ready',
    } satisfies Partial<ChainAnalysisMcpToolError>);
  });
});
