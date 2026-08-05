import { describe, expect, it } from 'vitest';

import type { DiagnoseXxyyTransactionOutput } from '@xxyy/transaction-skill-bridge';

import {
  extractEvmTokenAddresses,
  formatXxyyTransactionDiagnosis,
} from './xxyy-transaction-diagnosis-tool.js';

describe('formatXxyyTransactionDiagnosis', () => {
  it('uses token addresses extracted from partial Explorer evidence', () => {
    const tokenAddress = `0x${'2'.repeat(40)}`;
    expect(
      extractEvmTokenAddresses({
        analysis: {
          evidence: [{ structuredData: { tokenAddresses: [tokenAddress] } }],
          tokenTransfers: [],
        },
      } as never),
    ).toEqual([tokenAddress]);
  });

  it('marks a verified screenshot as required user-visible evidence', () => {
    const transactionId = '4'.repeat(88);
    const maker = '5'.repeat(44);
    const pairAddress = '7'.repeat(44);
    const dominantPair = '8'.repeat(44);
    const attacker = '9'.repeat(44);
    const mint = '6'.repeat(44);
    const output = {
      checks: ['pool', 'sandwich'],
      market: {
        candidatePairs: [
          {
            baseToken: mint,
            chain: 'solana:mainnet',
            liquidityUsd: '100',
            pairAddress,
            quoteToken: 'So11111111111111111111111111111111111111112',
          },
          {
            baseToken: mint,
            chain: 'solana:mainnet',
            liquidityUsd: '10000',
            pairAddress: dominantPair,
            quoteToken: 'So11111111111111111111111111111111111111112',
          },
        ],
        diagnostics: [],
        matchedPair: {
          baseToken: mint,
          chain: 'solana:mainnet',
          liquidityUsd: '100',
          pairAddress,
          quoteToken: 'So11111111111111111111111111111111111111112',
        },
        status: 'exact',
        trade: {
          maker,
          nativeAmount: '1',
          timestamp: 1_775_353_323_000,
          tokenAmount: '10',
          transactionId,
          type: 'buy',
          usdAmount: '100',
        },
      },
      poolAssessment: {
        actualLiquidityUsd: '100',
        canonicalMatch: 'does_not_match',
        dominantLiquidityUsd: '10000',
        dominantPoolAddress: dominantPair,
        liquidityClass: 'small',
        policyVersion: '1.0.0',
        reasonCodes: ['non_canonical_pool', 'relative_and_absolute_liquidity_small'],
        relativeLiquidityPpm: 10_000,
      },
      sandwichAssessment: {
        backTransactionId: 'back-transaction',
        candidateActor: attacker,
        criteria: {
          actorLoop: 'unknown',
          adverseVictimImpact: 'unknown',
          profitableActor: 'unknown',
          sameBlockOrSlot: 'yes',
          samePool: 'yes',
          transactionOrder: 'yes',
          twoSidedDirection: 'yes',
        },
        frontTransactionId: 'front-transaction',
        reasonCodes: ['candidate_pattern_complete', 'loss_or_profit_missing'],
        verdict: 'likely',
      },
      screenshotEvidence: {
        artifact: {
          capturedAt: '2026-08-03T01:02:05.000Z',
          maker,
          mediaType: 'image/png',
          pairAddress,
          sourceUrl: `https://www.xxyy.io/sol/${pairAddress}`,
          title: 'Verified XXYY trade row',
          transactionId,
          url: `/xxyy-evidence/${'a'.repeat(64)}.png`,
        },
        status: 'ready',
      },
      status: 'partial',
      surroundingTrades: [
        {
          chainStatus: 'resolved',
          displayIndex: 2,
          maker: attacker,
          nativeAmount: '0.5',
          relation: 'earlier',
          slot: '1234',
          timestamp: 1_775_353_322_000,
          tokenAmount: '5',
          transactionId: 'front-transaction',
          type: 'buy',
          usdAmount: '50',
        },
        {
          chainStatus: 'resolved',
          displayIndex: 0,
          maker: attacker,
          nativeAmount: '0.6',
          relation: 'later',
          slot: '1234',
          timestamp: 1_775_353_324_000,
          tokenAmount: '5.5',
          transactionId: 'back-transaction',
          type: 'sell',
          usdAmount: '60',
        },
      ],
      summary: 'Pool diagnosis completed.',
      transaction: {
        analysis: {
          accountKeys: [maker],
          blockTime: '2026-08-03T01:02:03.000Z',
          executionStatus: 'success',
          logCount: 0,
          nativeBalanceChanges: [],
          network: 'solana:mainnet',
          programIds: [],
          slot: '1234',
          sources: [],
          tokenBalanceChanges: [],
          transactionId,
        },
        diagnostics: [],
        explorerUrl: `https://solscan.io/tx/${transactionId}`,
        family: 'solana',
        network: 'solana:mainnet',
        status: 'success',
        summary: 'Solana transaction loaded.',
        transactionId,
      },
      warnings: [],
    } satisfies DiagnoseXxyyTransactionOutput;

    const response = formatXxyyTransactionDiagnosis(output);
    expect(response.attachments).toEqual([
      expect.objectContaining({
        delivery: 'required',
        kind: 'image',
        url: `/xxyy-evidence/${'a'.repeat(64)}.png`,
      }),
    ]);
    expect(response.answer).toContain('实际池流动性：$100');
    expect(response.answer).toContain(`主导池：${dominantPair}，流动性 $10000`);
    expect(response.answer).toContain(`前后交易候选地址：${attacker}`);
    expect(response.answer).toContain('前置交易：front-transaction');
    expect(response.answer).toContain('后置交易：back-transaction');
    expect(response.answer).toContain('代币 5，原生币 0.5，约 $50，Slot 1234');
  });
});
