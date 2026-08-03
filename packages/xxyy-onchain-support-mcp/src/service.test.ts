import { describe, expect, it, vi } from 'vitest';

import { createChainAnalysisMcpClientStub } from '@xxyy/chain-analysis-mcp';
import { createXxyyMarketDataClientStub } from '@xxyy/xxyy-market-data-adapter';

import { createXxyyTransactionDiagnosisService } from './service.js';

const signature = '4'.repeat(88);
const maker = '5'.repeat(44);
const mint = '6'.repeat(44);
const pair = '7'.repeat(44);
const dominantPair = '8'.repeat(44);

function transactionOutput() {
  return {
    analysis: {
      accountKeys: [maker],
      blockTime: '2026-08-03T01:02:03.000Z',
      executionStatus: 'success' as const,
      logCount: 3,
      nativeBalanceChanges: [],
      network: 'solana:mainnet' as const,
      programIds: [],
      slot: '1234',
      sources: [
        {
          id: 'solana_primary',
          kind: 'rpc' as const,
          observedAt: '2026-08-03T01:02:04.000Z',
          payloadHash: `sha256:${'a'.repeat(64)}`,
          provenanceUrl: 'https://rpc.example.invalid',
        },
      ],
      tokenBalanceChanges: [{ accountIndex: 0, decimals: 6, deltaRaw: '10', mint, owner: maker }],
      transactionId: signature,
    },
    diagnostics: [],
    explorerUrl: `https://solscan.io/tx/${signature}`,
    family: 'solana' as const,
    network: 'solana:mainnet',
    status: 'success' as const,
    summary: 'Solana transaction loaded.',
    transactionId: signature,
  };
}

describe('createXxyyTransactionDiagnosisService', () => {
  it('keeps pool and Sandwich conclusions separate and returns auditable screenshot metadata', async () => {
    const findTrade = vi.fn(async () => ({
      candidatePairs: [
        {
          baseToken: mint,
          chain: 'solana:mainnet',
          liquidityUsd: '100',
          pairAddress: pair,
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
        pairAddress: pair,
        quoteToken: 'So11111111111111111111111111111111111111112',
      },
      status: 'exact' as const,
      trade: {
        maker,
        nativeAmount: '1',
        timestamp: 1_775_353_323_000,
        tokenAmount: '10',
        transactionId: signature,
        type: 'buy' as const,
        usdAmount: '100',
      },
    }));
    const service = createXxyyTransactionDiagnosisService({
      canonicalPoolResolver: () => dominantPair,
      chainAnalysis: createChainAnalysisMcpClientStub({
        getTransaction: async () => transactionOutput(),
      }),
      marketData: createXxyyMarketDataClientStub(findTrade),
      poolPolicy: {
        maxSmallPoolLiquidityUsd: '500',
        maxSmallPoolRelativeLiquidityPpm: 100_000,
        version: '1.0.0',
      },
      screenshotProvider: {
        capture: async (input) => ({
          capturedAt: '2026-08-03T01:02:05.000Z',
          maker: input.maker,
          mediaType: 'image/png' as const,
          pairAddress: input.pairAddress,
          sourceUrl: `https://www.xxyy.io/sol/${input.pairAddress}`,
          title: 'Verified XXYY trade row',
          transactionId: input.transactionId,
          url: 'https://evidence.example.invalid/xxyy-trade.png',
        }),
      },
    });

    const result = await service.diagnoseXxyyTransaction({
      checks: ['pool', 'sandwich'],
      reference: signature,
      network: 'solana:mainnet',
    });

    expect(findTrade).toHaveBeenCalledWith(
      expect.objectContaining({ actor: maker, targetTokenAddresses: [mint] }),
      {},
    );
    expect(result.poolAssessment).toMatchObject({
      canonicalMatch: 'does_not_match',
      liquidityClass: 'small',
    });
    expect(result.sandwichAssessment).toMatchObject({ verdict: 'insufficient_data' });
    expect(result.screenshotEvidence).toMatchObject({
      artifact: { maker, pairAddress: pair, transactionId: signature },
      status: 'ready',
    });
    expect(result.status).toBe('partial');
  });

  it('does not call XXYY without a token address and degrades evidence explicitly', async () => {
    const findTrade = vi.fn();
    const transaction = transactionOutput();
    transaction.analysis.tokenBalanceChanges = [];
    const service = createXxyyTransactionDiagnosisService({
      chainAnalysis: createChainAnalysisMcpClientStub({
        getTransaction: async () => transaction,
      }),
      marketData: createXxyyMarketDataClientStub(findTrade),
      poolPolicy: {
        maxSmallPoolLiquidityUsd: '500',
        maxSmallPoolRelativeLiquidityPpm: 100_000,
        version: '1.0.0',
      },
    });

    const result = await service.diagnoseXxyyTransaction({
      checks: ['pool'],
      reference: signature,
    });

    expect(findTrade).not.toHaveBeenCalled();
    expect(result.status).toBe('insufficient_data');
    expect(result.screenshotEvidence).toEqual({
      reason: 'trade_not_exactly_matched',
      status: 'unavailable',
    });
  });
});
