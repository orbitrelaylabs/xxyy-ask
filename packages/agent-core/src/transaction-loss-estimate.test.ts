import { describe, expect, it } from 'vitest';

import type { DiagnoseXxyyTransactionOutput } from '@xxyy/transaction-skill-bridge';

import { estimateTransactionExecutionLoss } from './transaction-loss-estimate.js';

function outputWithTrade(input: {
  priorNative: string;
  priorToken: string;
  side?: 'buy' | 'sell';
  targetNative?: string;
  targetToken?: string;
}): DiagnoseXxyyTransactionOutput {
  const side = input.side ?? 'buy';
  return {
    checks: ['pool'],
    market: {
      candidatePairs: [],
      contextTrades: [
        {
          displayIndex: 0,
          maker: 'benchmark-maker',
          nativeAmount: input.priorNative,
          relation: 'earlier',
          timestamp: 99,
          tokenAmount: input.priorToken,
          transactionId: 'benchmark-transaction',
          type: side,
        },
      ],
      diagnostics: [],
      matchedPair: {
        baseToken: 'token',
        chain: 'eip155:56',
        pairAddress: 'pool',
        quoteToken: 'wbnb',
      },
      status: 'exact',
      trade: {
        maker: 'target-maker',
        nativeAmount: input.targetNative ?? '1',
        timestamp: 100,
        tokenAmount: input.targetToken ?? '10',
        transactionId: 'target-transaction',
        type: side,
        usdAmount: '100',
      },
    },
    poolAssessment: {
      canonicalMatch: 'unknown',
      liquidityClass: 'small',
      policyVersion: '1.0.0',
      reasonCodes: ['relative_and_absolute_liquidity_small'],
    },
    screenshotEvidence: { reason: 'not_configured', status: 'unavailable' },
    status: 'partial',
    summary: 'test',
    transaction: {
      analysis: {},
      chainId: '56',
      diagnostics: [],
      family: 'evm',
      network: 'eip155:56',
      status: 'partial',
      summary: 'test',
      transactionId: 'target-transaction',
    },
    warnings: [],
  } as DiagnoseXxyyTransactionOutput;
}

describe('estimateTransactionExecutionLoss', () => {
  it('estimates a buy-side adverse execution deviation in native and USD amounts', () => {
    const estimate = estimateTransactionExecutionLoss(
      outputWithTrade({ priorNative: '0.4', priorToken: '5' }),
    );
    expect(estimate).toMatchObject({
      benchmarkTransactionId: 'benchmark-transaction',
      expectedNativeAmount: 0.8,
      lossPpm: 250_000,
      relatedFindings: ['small_pool'],
      status: 'estimated',
    });
    expect(estimate?.status === 'estimated' ? estimate.lossNativeAmount : undefined).toBeCloseTo(
      0.2,
    );
    expect(estimate?.status === 'estimated' ? estimate.lossUsdAmount : undefined).toBeCloseTo(20);
  });

  it('estimates a sell-side shortfall against the prior same-side price', () => {
    const estimate = estimateTransactionExecutionLoss(
      outputWithTrade({
        priorNative: '0.6',
        priorToken: '5',
        side: 'sell',
        targetNative: '1',
        targetToken: '10',
      }),
    );
    expect(estimate).toMatchObject({
      expectedNativeAmount: 1.2,
      status: 'estimated',
    });
    expect(estimate?.status === 'estimated' ? estimate.lossNativeAmount : undefined).toBeCloseTo(
      0.2,
    );
  });

  it('fails closed when no prior same-side trade is available', () => {
    const output = outputWithTrade({ priorNative: '0.4', priorToken: '5' });
    output.market!.contextTrades = [];
    expect(estimateTransactionExecutionLoss(output)).toEqual({
      reason: 'missing_prior_same_side_trade',
      relatedFindings: ['small_pool'],
      scope: 'selected_trade',
      status: 'insufficient_data',
    });
  });
});
