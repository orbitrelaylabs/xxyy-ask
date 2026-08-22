import { describe, expect, it, vi } from 'vitest';

import { createXxyyMarketDataClientStub } from '../xxyy-market-data/index.js';

import {
  createPublicTransactionClientStub,
  getTransactionOutputSchema,
} from './public-transaction-contracts.js';
import { createXxyyTransactionDiagnosisService } from './service.js';

const signature = '4'.repeat(88);
const maker = '5'.repeat(44);
const mint = '6'.repeat(44);
const pair = '7'.repeat(44);
const dominantPair = '8'.repeat(44);
const frontSignature = '3'.repeat(88);
const backSignature = '9'.repeat(88);
const evmTransactionHash = `0x${'1'.repeat(64)}`;
const evmActor = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const evmPool = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const evmToken = '0x1111111111111111111111111111111111111111';
const evmV4PoolId = `0x${'c'.repeat(64)}`;

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
          kind: 'explorer_browser' as const,
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

function evmTransactionOutput() {
  const evidenceId = 'browser.transaction';
  return getTransactionOutputSchema.parse({
    analysis: {
      assetChanges: [],
      conflicts: [],
      diagnostics: [],
      evidence: [
        {
          blockNumber: '113369791',
          chainId: '56',
          confidence: 0.75,
          effectiveAt: '2026-08-01T09:28:39.000Z',
          id: evidenceId,
          kind: 'transaction' as const,
          observedAt: '2026-08-01T09:28:40.000Z',
          payloadHash: `sha256:${'a'.repeat(64)}`,
          source: 'scan_browser',
          sourceUrl: `https://bscscan.com/tx/${evmTransactionHash}`,
          structuredData: {
            accountAddresses: [evmActor, evmPool],
            swapPools: [
              {
                emitterAddress: evmPool,
                logIndex: 970,
                poolIdentifier: evmV4PoolId,
              },
            ],
            tokenAddresses: [evmToken],
          },
          supports: ['browser_transaction_facts'],
          transactionHash: evmTransactionHash,
        },
      ],
      findings: [
        {
          confidence: 0.75,
          evidenceIds: [evidenceId],
          id: 'browser_transaction_facts',
          inference: false,
          statement: 'Transaction facts were read from a fixed public Explorer in a browser.',
        },
      ],
      skill: 'transaction_analysis' as const,
      status: 'partial' as const,
      summary: 'Browser Explorer returned partial single-source transaction facts.',
      timeline: [],
      tokenTransfers: [
        {
          amountRaw: '100',
          evidenceId,
          from: evmActor,
          logIndex: 0,
          to: evmPool,
          tokenAddress: evmToken,
          transferType: 'transfer' as const,
        },
      ],
      transaction: {
        blockNumber: '113369791',
        blockTimestamp: '1754040519',
        chainId: '56',
        executionStatus: 'success' as const,
        feeWei: '1',
        from: evmActor,
        hash: evmTransactionHash,
        inputKind: 'contract_call' as const,
        to: evmPool,
        valueWei: '1',
      },
      version: '1.0.0' as const,
      warnings: ['Explorer browser evidence is single-source and partial.'],
    },
    chainId: '56',
    diagnostics: [],
    explorerUrl: `https://bscscan.com/tx/${evmTransactionHash}`,
    family: 'evm' as const,
    network: 'eip155:56',
    status: 'partial' as const,
    summary: 'Transaction facts were read from a fixed Explorer browser page.',
    transactionId: evmTransactionHash,
  });
}

describe('createXxyyTransactionDiagnosisService', () => {
  it('selects a primary split-route pool only when both event amount rankings agree', async () => {
    const transaction = evmTransactionOutput();
    if (transaction.family !== 'evm') throw new Error('Expected EVM fixture.');
    const evidence = transaction.analysis.evidence[0]!;
    evidence.structuredData = {
      accountAddresses: [evmActor, evmPool],
      swapPools: [
        {
          amount0Raw: '-10',
          amount1Raw: '100',
          emitterAddress: evmPool,
          logIndex: 1,
          poolIdentifier: `0x${'1'.repeat(64)}`,
        },
        {
          amount0Raw: '-30',
          amount1Raw: '300',
          emitterAddress: evmPool,
          logIndex: 2,
          poolIdentifier: `0x${'2'.repeat(64)}`,
        },
      ],
      tokenAddresses: [evmToken],
    };
    const service = createXxyyTransactionDiagnosisService({
      chainAnalysis: createPublicTransactionClientStub(async () => transaction),
      marketData: createXxyyMarketDataClientStub(async () => ({
        candidatePairs: [],
        diagnostics: [],
        status: 'conflict',
      })),
      poolPolicy: {
        maxSmallPoolLiquidityUsd: '10000',
        maxSmallPoolRelativeLiquidityPpm: 100_000,
        version: '1.0.0',
      },
    });

    const result = await service.diagnoseXxyyTransaction({
      checks: ['pool'],
      network: 'eip155:56',
      reference: evmTransactionHash,
    });

    expect(result.executionPools?.map((pool) => [pool.logIndex, pool.isPrimary])).toEqual([
      [1, undefined],
      [2, true],
    ]);
  });

  it('never calls deep MEV analysis from the browser-only EVM diagnosis path', async () => {
    const transaction = evmTransactionOutput();
    const getTransaction = vi.fn(async () => transaction);
    const service = createXxyyTransactionDiagnosisService({
      chainAnalysis: createPublicTransactionClientStub(getTransaction),
      marketData: createXxyyMarketDataClientStub(async () => ({
        candidatePairs: [
          {
            baseToken: evmToken,
            chain: 'eip155:56',
            liquidityUsd: '100000',
            pairAddress: evmPool,
            quoteToken: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        ],
        contextTrades: [
          {
            blockNumber: '113369790',
            displayIndex: 1,
            maker: '0x2222222222222222222222222222222222222222',
            nativeAmount: '0.1',
            relation: 'earlier',
            timestamp: 1_699_999_999_000,
            tokenAmount: '10',
            transactionId: `0x${'2'.repeat(64)}`,
            type: 'buy',
          },
        ],
        diagnostics: [],
        matchedPair: {
          baseToken: evmToken,
          chain: 'eip155:56',
          liquidityUsd: '100000',
          pairAddress: evmPool,
          quoteToken: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        status: 'exact',
        trade: {
          maker: evmActor,
          nativeAmount: '1',
          timestamp: 1_700_000_000_000,
          tokenAmount: '100',
          transactionId: evmTransactionHash,
          type: 'buy',
          usdAmount: '2000',
        },
      })),
      poolPolicy: {
        maxSmallPoolLiquidityUsd: '10000',
        maxSmallPoolRelativeLiquidityPpm: 100_000,
        version: '1.0.0',
      },
    });

    const result = await service.diagnoseXxyyTransaction({
      checks: ['sandwich'],
      network: 'eip155:56',
      reference: evmTransactionHash,
    });

    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(result.surroundingTrades).toEqual([
      expect.objectContaining({ blockNumber: '113369790', chainStatus: 'resolved' }),
    ]);
    expect(result.executionPools).toEqual([
      {
        emitterAddress: evmPool,
        logIndex: 970,
        poolIdentifier: evmV4PoolId,
        source: 'explorer_event_log',
      },
    ]);
    expect(result.sandwichAssessment).toMatchObject({
      verdict: 'insufficient_data',
    });
    expect(result.warnings).toContain(
      'Browser and XXYY rows can support a same-block/slot structural pattern, but pool-state and profit/loss evidence remain unavailable for confirmation.',
    );
  });

  it('returns unlikely when resolved adjacent XXYY rows contradict the Sandwich structure', async () => {
    const transaction = evmTransactionOutput();
    const service = createXxyyTransactionDiagnosisService({
      chainAnalysis: createPublicTransactionClientStub(async () => transaction),
      marketData: createXxyyMarketDataClientStub(async () => ({
        candidatePairs: [],
        contextTrades: [
          {
            blockNumber: '113369790',
            displayIndex: 2,
            maker: '0x2222222222222222222222222222222222222222',
            nativeAmount: '0.1',
            relation: 'earlier',
            timestamp: 1_699_999_999_000,
            tokenAmount: '10',
            transactionId: `0x${'2'.repeat(64)}`,
            type: 'buy',
          },
          {
            blockNumber: '113369792',
            displayIndex: 0,
            maker: '0x3333333333333333333333333333333333333333',
            nativeAmount: '0.2',
            relation: 'later',
            timestamp: 1_700_000_001_000,
            tokenAmount: '20',
            transactionId: `0x${'3'.repeat(64)}`,
            type: 'buy',
          },
        ],
        diagnostics: [],
        matchedPair: {
          baseToken: evmToken,
          chain: 'eip155:56',
          pairAddress: evmPool,
          quoteToken: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        status: 'exact',
        trade: {
          blockNumber: '113369791',
          maker: evmActor,
          nativeAmount: '1',
          timestamp: 1_700_000_000_000,
          tokenAmount: '100',
          transactionId: evmTransactionHash,
          type: 'buy',
          usdAmount: '2000',
        },
      })),
      poolPolicy: {
        maxSmallPoolLiquidityUsd: '10000',
        maxSmallPoolRelativeLiquidityPpm: 100_000,
        version: '1.0.0',
      },
    });

    const result = await service.diagnoseXxyyTransaction({
      checks: ['sandwich'],
      network: 'eip155:56',
      reference: evmTransactionHash,
    });

    expect(result.sandwichAssessment).toMatchObject({
      reasonCodes: ['same_block_or_slot_missing', 'actor_mismatch', 'direction_mismatch'],
      verdict: 'unlikely',
    });
  });

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
      contextTrades: [
        {
          displayIndex: 2,
          maker: 'A'.repeat(44),
          nativeAmount: '0.5',
          relation: 'earlier' as const,
          timestamp: 1_775_353_322_000,
          tokenAmount: '5',
          transactionId: frontSignature,
          type: 'buy' as const,
          usdAmount: '50',
        },
        {
          displayIndex: 0,
          maker: 'A'.repeat(44),
          nativeAmount: '0.6',
          relation: 'later' as const,
          timestamp: 1_775_353_324_000,
          tokenAmount: '5.5',
          transactionId: backSignature,
          type: 'sell' as const,
          usdAmount: '60',
        },
      ],
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
      chainAnalysis: createPublicTransactionClientStub(async (input) => {
        const output = transactionOutput();
        output.transactionId = input.reference;
        output.analysis.transactionId = input.reference;
        return output;
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
          url: `/xxyy-evidence/${'a'.repeat(64)}.png`,
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
    expect(result.sandwichAssessment).toMatchObject({
      backTransactionId: backSignature,
      candidateActor: 'A'.repeat(44),
      frontTransactionId: frontSignature,
      verdict: 'likely',
    });
    expect(result.surroundingTrades).toEqual([
      expect.objectContaining({ slot: '1234', transactionId: frontSignature }),
      expect.objectContaining({ slot: '1234', transactionId: backSignature }),
    ]);
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
      chainAnalysis: createPublicTransactionClientStub(async () => transaction),
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
