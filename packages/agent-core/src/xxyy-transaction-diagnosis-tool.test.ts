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
          ...['a', 'b', 'c', 'd'].map((character) => ({
            baseToken: mint,
            chain: 'solana:mainnet',
            dexId: 'orca',
            liquidityUsd: '1',
            pairAddress: character.repeat(44),
            quoteToken: 'So11111111111111111111111111111111111111112',
          })),
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
    expect(response.answer).toContain('本笔池流动性：约 $100');
    expect(response.answer).toContain(`当前主导池：\`${dominantPair}\`，约 $10,000`);
    expect(response.answer).toContain(`本笔成交池：\`${pairAddress}\``);
    expect(response.answer).toContain('XXYY 当前发现 6 个池子：');
    expect(response.answer).toContain(`✅ 本笔成交 · DEX 未标注 · 约 $100`);
    expect(response.answer).toContain(`池：\`${'d'.repeat(44)}\``);
    expect(response.answer).not.toContain('最多展示');
    expect(response.answer).toContain(`前后交易候选地址：${attacker}`);
    expect(response.answer).toContain('前置交易：front-transaction');
    expect(response.answer).toContain('后置交易：back-transaction');
    expect(response.answer).toContain('代币 5，原生币 0.5，约 $50，Slot 1234');
    expect(response.answer).toContain('用户损失估算');
    expect(response.answer).toContain('影响无法拆分，金额不能重复相加');
    expect(response.answer).toContain('按该相邻成交基准未观察到正向不利偏差');
    expect(response.answer).toContain('不是无攻击/主导池状态下的反事实损失证明');
  });

  it('reports the selected XXYY leg and Sandwich result for a split-route transaction', () => {
    const transactionId = `0x${'1'.repeat(64)}`;
    const token = `0x${'2'.repeat(40)}`;
    const actor = `0x${'3'.repeat(40)}`;
    const router = `0x${'4'.repeat(40)}`;
    const poolA = `0x${'a'.repeat(64)}`;
    const poolB = `0x${'b'.repeat(64)}`;
    const output = {
      checks: ['pool', 'sandwich'],
      executionPools: [
        {
          amount0Raw: '-100000000000000000',
          amount1Raw: '1000',
          emitterAddress: router,
          logIndex: 970,
          poolIdentifier: poolA,
          source: 'explorer_event_log',
        },
        {
          amount0Raw: '-300000000000000000',
          amount1Raw: '3000',
          emitterAddress: router,
          isPrimary: true,
          logIndex: 978,
          poolIdentifier: poolB,
          source: 'explorer_event_log',
        },
      ],
      market: {
        candidatePairs: [
          {
            baseToken: token,
            chain: 'eip155:56',
            dexId: 'pan4',
            liquidityUsd: '118.52',
            pairAddress: poolA,
            quoteToken: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
          },
        ],
        diagnostics: [],
        matchedPair: {
          baseToken: token,
          chain: 'eip155:56',
          dexId: 'pan4',
          liquidityUsd: '118.52',
          pairAddress: poolA,
          quoteToken: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
        },
        matchedTrades: [{}, {}],
        status: 'multi_exact',
        trade: {
          maker: actor,
          nativeAmount: '0.1',
          timestamp: 1_700_000_000_000,
          tokenAmount: '1000',
          transactionId,
          type: 'buy',
          usdAmount: '60',
        },
      },
      poolAssessment: {
        actualLiquidityUsd: '118.52',
        canonicalMatch: 'unknown',
        dominantLiquidityUsd: '10000',
        dominantPoolAddress: poolB,
        liquidityClass: 'small',
        policyVersion: '1.0.0',
        reasonCodes: [],
        relativeLiquidityPpm: 11852,
      },
      sandwichAssessment: {
        criteria: {
          actorLoop: 'unknown',
          adverseVictimImpact: 'unknown',
          profitableActor: 'unknown',
          sameBlockOrSlot: 'unknown',
          samePool: 'unknown',
          transactionOrder: 'unknown',
          twoSidedDirection: 'unknown',
        },
        reasonCodes: ['no_bracketing_transactions'],
        verdict: 'unlikely',
      },
      screenshotEvidence: { reason: 'trade_not_exactly_matched', status: 'unavailable' },
      status: 'partial',
      summary: 'Partial browser evidence.',
      transaction: {
        analysis: {
          assetChanges: [],
          conflicts: [],
          diagnostics: [],
          evidence: [],
          findings: [],
          skill: 'transaction_analysis',
          status: 'partial',
          summary: 'Partial browser evidence.',
          timeline: [],
          tokenTransfers: [],
          transaction: {
            blockNumber: '1',
            blockTimestamp: '1',
            chainId: '56',
            executionStatus: 'success',
            feeWei: '1',
            from: actor,
            hash: transactionId,
            inputKind: 'contract_call',
            to: router,
            valueWei: '1',
          },
          version: '1.0.0',
          warnings: [],
        },
        chainId: '56',
        diagnostics: [],
        explorerUrl: `https://bscscan.com/tx/${transactionId}`,
        family: 'evm',
        network: 'eip155:56',
        status: 'partial',
        summary: 'Partial browser evidence.',
        transactionId,
      },
      warnings: ['Explorer event logs show that this transaction was split across 2 swap pools.'],
    } satisfies DiagnoseXxyyTransactionOutput;

    const response = formatXxyyTransactionDiagnosis(output);

    expect(response.answer).toContain('当前证据不支持被夹');
    expect(response.answer).toContain('XXYY 选定分析成交腿');
    expect(response.answer).toContain(`XXYY 选定分析池：\`${poolA}\``);
    expect(response.answer).toContain('链上共执行 2 个池');
    expect(response.answer).toContain('交易传入金额：0.000000000000000001 BNB');
    expect(response.answer).toContain('**💱 金额口径对照**');
    expect(response.answer).toContain('XXYY 目标成交腿：0.1 BNB');
    expect(response.answer).toContain(
      'XXYY 显示的是完整哈希精确匹配的目标池成交腿，不是整笔交易的总传入金额',
    );
    expect(response.answer).toContain('不足以把两者差额全部归因于平台费、Token 税或用户损失');
    expect(response.answer).toContain(`${poolA}\`（日志 #970；pan4，约 $118.52；本腿约 0.1 BNB）`);
    expect(response.answer).toContain(
      `⭐ 主执行池 · \`${poolB}\`（日志 #978；XXYY 当前池列表未返回；本腿约 0.3 BNB）`,
    );
    expect(response.answer).toContain('XXYY 池列表已对应 1/2 个本笔执行池');
    expect(response.answer).toContain('Sandwich 结论：当前完整相邻成交证据不支持 Sandwich 结构');
    expect(response.answer).not.toContain('XXYY 当前发现 1 个池子');
    expect(response.answer).not.toContain('本笔成交池：未能按完整交易哈希确认');
  });
});
