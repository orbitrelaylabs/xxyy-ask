import type { XxyyMarketDataClient, XxyyTradeLookupResult } from '../xxyy-market-data/index.js';
import {
  assessXxyyPoolSelection,
  assessXxyySandwichPattern,
  xxyyPoolPolicySchema,
  type XxyyPairCandidate,
  type XxyyTradeObservation,
} from '../xxyy-diagnosis-core/index.js';

import {
  diagnoseXxyyTransactionInputSchema,
  diagnoseXxyyTransactionOutputSchema,
  type XxyyDiagnosisPoolPolicy,
  type XxyyScreenshotEvidence,
  type XxyyScreenshotEvidenceProvider,
  type XxyySurroundingTrade,
  type XxyyTransactionDiagnosisHandler,
} from './contracts.js';
import type {
  GetTransactionOutput,
  PublicTransactionClient,
} from './public-transaction-contracts.js';

export interface CreateXxyyTransactionDiagnosisServiceOptions {
  canonicalPoolResolver?: (input: {
    candidates: readonly XxyyPairCandidate[];
    chain: string;
    targetTokenAddresses: readonly string[];
  }) => Promise<string | undefined> | string | undefined;
  chainAnalysis: PublicTransactionClient;
  marketData: XxyyMarketDataClient;
  poolPolicy: XxyyDiagnosisPoolPolicy;
  screenshotProvider?: XxyyScreenshotEvidenceProvider;
}

export function createXxyyTransactionDiagnosisService(
  options: CreateXxyyTransactionDiagnosisServiceOptions,
): XxyyTransactionDiagnosisHandler {
  const poolPolicy = xxyyPoolPolicySchema.parse(options.poolPolicy);
  return {
    async diagnoseXxyyTransaction(rawInput, requestOptions = {}) {
      const input = diagnoseXxyyTransactionInputSchema.parse(rawInput);
      const transaction = await options.chainAnalysis.getTransaction(
        {
          ...(input.network === undefined ? {} : { network: input.network }),
          reference: input.reference,
        },
        requestOptions.signal === undefined ? {} : { signal: requestOptions.signal },
      );
      const context = extractLookupContext(transaction);
      const executionPools = extractExecutionPools(transaction);
      const warnings: string[] = [];
      if (
        (transaction.family === 'solana' &&
          transaction.analysis?.sources.some((source) => source.kind === 'explorer_browser')) ||
        (transaction.family === 'evm' && transaction.status === 'partial')
      ) {
        warnings.push(
          'Transaction facts came from a fixed Explorer browser page and are partial, single-source evidence.',
        );
      }
      const market =
        context.targetTokenAddresses.length === 0
          ? undefined
          : await options.marketData.findTrade(
              {
                ...(context.actor === undefined ? {} : { actor: context.actor }),
                chain: context.chain,
                ...(executionPools.length === 0
                  ? {}
                  : {
                      executionPools: executionPools.map((pool) => ({
                        ...(pool.amount0Raw === undefined ? {} : { amount0Raw: pool.amount0Raw }),
                        ...(pool.amount1Raw === undefined ? {} : { amount1Raw: pool.amount1Raw }),
                        ...(pool.isPrimary === undefined ? {} : { isPrimary: pool.isPrimary }),
                        poolIdentifier: pool.poolIdentifier,
                      })),
                    }),
                targetTokenAddresses: context.targetTokenAddresses,
                ...(context.timestampMs === undefined ? {} : { timestampMs: context.timestampMs }),
                ...(context.transactionAccountAddresses.length === 0
                  ? {}
                  : { transactionAccountAddresses: context.transactionAccountAddresses }),
                transactionId: transaction.transactionId,
              },
              requestOptions.signal === undefined ? {} : { signal: requestOptions.signal },
            );

      if (context.targetTokenAddresses.length === 0) {
        warnings.push('No token address or mint was available for an XXYY market lookup.');
      } else if (!hasSelectedMarketTrade(market)) {
        warnings.push('XXYY did not return one exact full transaction-hash match.');
      } else if (market?.status === 'multi_exact') {
        warnings.push('XXYY matched multiple execution legs and selected one pool for analysis.');
      }
      if (executionPools.length > 1) {
        warnings.push(
          `Explorer event logs show that this transaction was split across ${executionPools.length} swap pools.`,
        );
      }

      let poolAssessment;
      if (input.checks.includes('pool') && hasSelectedMarketTrade(market)) {
        const canonicalPoolAddress = await options.canonicalPoolResolver?.({
          candidates: market.candidatePairs,
          chain: context.chain,
          targetTokenAddresses: context.targetTokenAddresses,
        });
        poolAssessment = assessXxyyPoolSelection({
          actualPoolAddress: market.matchedPair!.pairAddress,
          candidatePools: market.candidatePairs,
          ...(canonicalPoolAddress === undefined ? {} : { canonicalPoolAddress }),
          policy: poolPolicy,
        });
      }

      const surroundingTrades =
        input.checks.includes('sandwich') && hasSelectedMarketTrade(market)
          ? await resolveSurroundingTrades(
              market,
              context.chain,
              options.chainAnalysis,
              requestOptions.signal,
            )
          : [];
      if (surroundingTrades.some((trade) => trade.chainStatus === 'unavailable')) {
        warnings.push('Some surrounding XXYY trades could not be resolved to a block or slot.');
      }

      let sandwichAssessment;
      if (input.checks.includes('sandwich')) {
        if (hasSelectedMarketTrade(market)) {
          sandwichAssessment = assessMarketSandwichEvidence(transaction, market, surroundingTrades);
          warnings.push(
            'Browser and XXYY rows can support a same-block/slot structural pattern, but pool-state and profit/loss evidence remain unavailable for confirmation.',
          );
        } else {
          warnings.push('Sandwich analysis requires one exact XXYY trade match.');
        }
      }

      let screenshotEvidence: XxyyScreenshotEvidence = {
        reason: 'trade_not_exactly_matched' as const,
        status: 'unavailable' as const,
      };
      if (hasSelectedMarketTrade(market)) {
        if (options.screenshotProvider === undefined) {
          screenshotEvidence = { reason: 'not_configured', status: 'unavailable' };
        } else {
          try {
            const artifact = await options.screenshotProvider.capture(
              {
                ...(market.trade!.blockNumber === undefined
                  ? {}
                  : { blockNumber: market.trade!.blockNumber }),
                chain: context.chain,
                ...(market.trade!.logIndex === undefined
                  ? {}
                  : { logIndex: market.trade!.logIndex }),
                maker: market.trade!.maker,
                nativeAmount: market.trade!.nativeAmount,
                pairAddress: market.matchedPair!.pairAddress,
                timestamp: market.trade!.timestamp,
                tokenAmount: market.trade!.tokenAmount,
                transactionId: transaction.transactionId,
                type: market.trade!.type,
                ...(market.trade!.usdAmount === undefined
                  ? {}
                  : { usdAmount: market.trade!.usdAmount }),
              },
              requestOptions.signal === undefined ? {} : { signal: requestOptions.signal },
            );
            return diagnoseXxyyTransactionOutputSchema.parse({
              checks: input.checks,
              ...(executionPools.length === 0 ? {} : { executionPools }),
              market,
              ...(poolAssessment === undefined ? {} : { poolAssessment }),
              ...(sandwichAssessment === undefined ? {} : { sandwichAssessment }),
              screenshotEvidence: { artifact, status: 'ready' },
              status: diagnosisStatus({
                marketStatus: market.status,
                poolAssessment,
                sandwichAssessment,
                screenshotReady: true,
                transaction,
              }),
              summary: buildSummary(transaction, market.status, true),
              ...(surroundingTrades.length === 0 ? {} : { surroundingTrades }),
              transaction,
              warnings,
            });
          } catch {
            screenshotEvidence = { reason: 'capture_failed', status: 'unavailable' };
          }
        }
      }

      return diagnoseXxyyTransactionOutputSchema.parse({
        checks: input.checks,
        ...(executionPools.length === 0 ? {} : { executionPools }),
        ...(market === undefined ? {} : { market }),
        ...(poolAssessment === undefined ? {} : { poolAssessment }),
        ...(sandwichAssessment === undefined ? {} : { sandwichAssessment }),
        screenshotEvidence,
        status: diagnosisStatus({
          marketStatus: market?.status,
          poolAssessment,
          sandwichAssessment,
          screenshotReady: false,
          transaction,
        }),
        summary: buildSummary(transaction, market?.status, false),
        ...(surroundingTrades.length === 0 ? {} : { surroundingTrades }),
        transaction,
        warnings,
      });
    },
  };
}

function extractExecutionPools(transaction: GetTransactionOutput) {
  if (transaction.family !== 'evm') return [];
  const seen = new Set<string>();
  const pools = transaction.analysis.evidence.flatMap((evidence) => {
    const data = evidence.structuredData;
    if (!isRecord(data) || !Array.isArray(data.swapPools)) return [];
    return data.swapPools.flatMap((value) => {
      if (!isRecord(value)) return [];
      const emitterAddress = value.emitterAddress;
      const amount0Raw = value.amount0Raw;
      const amount1Raw = value.amount1Raw;
      const logIndex = value.logIndex;
      const poolIdentifier = value.poolIdentifier;
      if (
        typeof emitterAddress !== 'string' ||
        (amount0Raw !== undefined && typeof amount0Raw !== 'string') ||
        (amount1Raw !== undefined && typeof amount1Raw !== 'string') ||
        typeof logIndex !== 'number' ||
        !Number.isSafeInteger(logIndex) ||
        logIndex < 0 ||
        typeof poolIdentifier !== 'string'
      ) {
        return [];
      }
      const key = `${logIndex}:${poolIdentifier.toLowerCase()}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          ...(amount0Raw === undefined ? {} : { amount0Raw }),
          ...(amount1Raw === undefined ? {} : { amount1Raw }),
          emitterAddress,
          logIndex,
          poolIdentifier,
          source: 'explorer_event_log' as const,
        },
      ];
    });
  });
  return markPrimaryExecutionPool(pools);
}

function markPrimaryExecutionPool<T extends { amount0Raw?: string; amount1Raw?: string }>(
  pools: T[],
): Array<T & { isPrimary?: boolean }> {
  if (pools.length < 2 || pools.some((pool) => !pool.amount0Raw || !pool.amount1Raw)) return pools;
  const largest0 = uniqueLargestIndex(pools.map((pool) => absoluteBigInt(pool.amount0Raw!)));
  const largest1 = uniqueLargestIndex(pools.map((pool) => absoluteBigInt(pool.amount1Raw!)));
  if (largest0 === undefined || largest0 !== largest1) return pools;
  return pools.map((pool, index) => (index === largest0 ? { ...pool, isPrimary: true } : pool));
}

function uniqueLargestIndex(values: bigint[]): number | undefined {
  const largest = values.reduce((current, value) => (value > current ? value : current), -1n);
  const matches = values.flatMap((value, index) => (value === largest ? [index] : []));
  return matches.length === 1 ? matches[0] : undefined;
}

function absoluteBigInt(value: string): bigint {
  const parsed = BigInt(value);
  return parsed < 0n ? -parsed : parsed;
}

function extractLookupContext(transaction: GetTransactionOutput): {
  actor?: string;
  chain: string;
  targetTokenAddresses: string[];
  timestampMs?: number;
  transactionAccountAddresses: string[];
} {
  if (transaction.family === 'evm') {
    const browserEvidence = transaction.analysis.evidence.flatMap((item) => {
      const data = item.structuredData;
      return isRecord(data) ? [data] : [];
    });
    const tokenAddresses = unique([
      ...transaction.analysis.tokenTransfers.map((item) => item.tokenAddress),
      ...transaction.analysis.assetChanges.flatMap((change) =>
        change.asset.kind === 'erc20' ? [change.asset.contractAddress] : [],
      ),
      ...browserEvidence.flatMap((item) => stringArray(item.tokenAddresses)),
    ]);
    const timestamp = transaction.analysis.transaction.blockTimestamp;
    return {
      ...(transaction.analysis.transaction.from === undefined
        ? {}
        : { actor: transaction.analysis.transaction.from }),
      chain: transaction.network,
      targetTokenAddresses: tokenAddresses.slice(0, 8),
      transactionAccountAddresses: unique([
        ...transaction.analysis.assetChanges.map((change) => change.address),
        ...transaction.analysis.tokenTransfers.flatMap((transfer) => [transfer.from, transfer.to]),
        ...(transaction.analysis.transaction.to === undefined ||
        transaction.analysis.transaction.to === null
          ? []
          : [transaction.analysis.transaction.to]),
        ...browserEvidence.flatMap((item) => stringArray(item.accountAddresses)),
      ]),
      ...(timestamp === undefined ? {} : { timestampMs: Number(BigInt(timestamp) * 1_000n) }),
    };
  }

  const snapshot = transaction.analysis;
  if (snapshot === undefined) {
    return {
      chain: transaction.network,
      targetTokenAddresses: [],
      transactionAccountAddresses: [],
    };
  }
  const changes = snapshot.tokenBalanceChanges.filter((item) => item.deltaRaw !== '0');
  const owners = unique(changes.flatMap((item) => (item.owner === undefined ? [] : [item.owner])));
  const timestampMs = snapshot.blockTime === undefined ? undefined : Date.parse(snapshot.blockTime);
  return {
    ...(owners.length === 1 ? { actor: owners[0] } : {}),
    chain: transaction.network,
    targetTokenAddresses: unique(changes.map((item) => item.mint)).slice(0, 8),
    transactionAccountAddresses: snapshot.accountKeys,
    ...(timestampMs === undefined || Number.isNaN(timestampMs) ? {} : { timestampMs }),
  };
}

function targetObservation(
  transaction: GetTransactionOutput,
  poolAddress: string,
  trade: { blockNumber?: string | undefined; maker: string; type: 'buy' | 'sell' },
): XxyyTradeObservation {
  return {
    actor: trade.maker,
    ...(transaction.family === 'evm'
      ? trade.blockNumber === undefined &&
        transaction.analysis.transaction.blockNumber === undefined
        ? {}
        : { blockNumber: trade.blockNumber ?? transaction.analysis.transaction.blockNumber }
      : transaction.analysis === undefined
        ? {}
        : { slot: transaction.analysis.slot }),
    poolAddress,
    side: trade.type,
    transactionId: transaction.transactionId,
  };
}

function diagnosisStatus(input: {
  marketStatus: 'conflict' | 'exact' | 'multi_exact' | 'not_found' | undefined;
  poolAssessment: ReturnType<typeof assessXxyyPoolSelection> | undefined;
  sandwichAssessment: ReturnType<typeof assessXxyySandwichPattern> | undefined;
  screenshotReady: boolean;
  transaction: GetTransactionOutput;
}): 'insufficient_data' | 'partial' | 'success' {
  if (input.transaction.status === 'insufficient_data' || input.marketStatus === undefined) {
    return 'insufficient_data';
  }
  const conclusionIncomplete =
    input.sandwichAssessment?.verdict === 'insufficient_data' ||
    input.sandwichAssessment?.verdict === 'likely' ||
    input.poolAssessment?.liquidityClass === 'unknown';
  return input.transaction.status === 'success' &&
    (input.marketStatus === 'exact' || input.marketStatus === 'multi_exact') &&
    input.screenshotReady &&
    !conclusionIncomplete
    ? 'success'
    : 'partial';
}

function assessMarketSandwichEvidence(
  transaction: GetTransactionOutput,
  market: XxyyTradeLookupResult,
  surroundingTrades: readonly XxyySurroundingTrade[],
) {
  const target = {
    ...targetObservation(transaction, market.matchedPair!.pairAddress, market.trade!),
    transactionIndex: 1,
  };
  const earlier = [...surroundingTrades]
    .filter((trade) => trade.relation === 'earlier')
    .sort((left, right) => compareTradeOrder(right, left))[0];
  const later = [...surroundingTrades]
    .filter((trade) => trade.relation === 'later')
    .sort(compareTradeOrder)[0];
  const observations: XxyyTradeObservation[] = [
    ...(earlier === undefined
      ? []
      : [surroundingObservation(earlier, market.matchedPair!.pairAddress, 0)]),
    target,
    ...(later === undefined
      ? []
      : [surroundingObservation(later, market.matchedPair!.pairAddress, 2)]),
  ];
  const neighborhoodComplete =
    (market.contextComplete === true &&
      surroundingTrades.every((trade) => trade.chainStatus === 'resolved')) ||
    (earlier !== undefined &&
      later !== undefined &&
      earlier.chainStatus === 'resolved' &&
      later.chainStatus === 'resolved' &&
      ((target.blockNumber !== undefined &&
        earlier.blockNumber !== undefined &&
        later.blockNumber !== undefined) ||
        (target.slot !== undefined && earlier.slot !== undefined && later.slot !== undefined)));
  return assessXxyySandwichPattern({
    coverage: {
      actorAssetDeltas: 'missing',
      neighborhood: neighborhoodComplete ? 'complete' : 'partial',
      poolState: 'missing',
      sourceConflicts: market.diagnostics.some((item) => item.code.includes('conflict')) ? 1 : 0,
    },
    observations,
    targetTransactionId: transaction.transactionId,
  });
}

function compareTradeOrder(
  left: Pick<XxyySurroundingTrade, 'blockNumber' | 'logIndex' | 'timestamp'>,
  right: Pick<XxyySurroundingTrade, 'blockNumber' | 'logIndex' | 'timestamp'>,
): number {
  if (left.blockNumber !== undefined && right.blockNumber !== undefined) {
    const leftBlock = BigInt(left.blockNumber);
    const rightBlock = BigInt(right.blockNumber);
    if (leftBlock !== rightBlock) return leftBlock < rightBlock ? -1 : 1;
    if (left.logIndex !== undefined && right.logIndex !== undefined) {
      return left.logIndex - right.logIndex;
    }
  }
  return left.timestamp - right.timestamp;
}

function surroundingObservation(
  trade: XxyySurroundingTrade,
  poolAddress: string,
  transactionIndex: number,
): XxyyTradeObservation {
  return {
    actor: trade.maker,
    ...(trade.blockNumber === undefined ? {} : { blockNumber: trade.blockNumber }),
    ...(trade.slot === undefined ? {} : { slot: trade.slot }),
    poolAddress,
    side: trade.type,
    transactionId: trade.transactionId,
    transactionIndex,
  };
}

async function resolveSurroundingTrades(
  market: XxyyTradeLookupResult,
  network: string,
  chainAnalysis: PublicTransactionClient,
  signal: AbortSignal | undefined,
): Promise<XxyySurroundingTrade[]> {
  return await Promise.all(
    (market.contextTrades ?? []).map(async (trade): Promise<XxyySurroundingTrade> => {
      if (network.startsWith('eip155:') && trade.blockNumber !== undefined) {
        return { ...trade, chainStatus: 'resolved' };
      }
      try {
        const transaction = await chainAnalysis.getTransaction(
          { network, reference: trade.transactionId },
          signal === undefined ? {} : { signal },
        );
        if (transaction.family === 'evm') {
          const blockNumber = transaction.analysis.transaction.blockNumber;
          return {
            ...trade,
            ...(blockNumber === undefined ? {} : { blockNumber }),
            chainStatus: blockNumber === undefined ? 'unavailable' : 'resolved',
          };
        }
        const slot = transaction.analysis?.slot;
        return {
          ...trade,
          ...(slot === undefined ? {} : { slot }),
          chainStatus: slot === undefined ? 'unavailable' : 'resolved',
        };
      } catch {
        return { ...trade, chainStatus: 'unavailable' };
      }
    }),
  );
}

function buildSummary(
  transaction: GetTransactionOutput,
  marketStatus: 'conflict' | 'exact' | 'multi_exact' | 'not_found' | undefined,
  screenshotReady: boolean,
): string {
  const match =
    marketStatus === 'exact'
      ? 'XXYY returned one exact trade match.'
      : marketStatus === 'multi_exact'
        ? 'XXYY returned multiple execution-leg matches and selected one pool for analysis.'
        : marketStatus === 'conflict'
          ? 'XXYY evidence conflicted with the normalized transaction.'
          : 'No exact XXYY trade match was available.';
  return `${transaction.summary} ${match} Screenshot evidence is ${screenshotReady ? 'ready' : 'unavailable'}.`;
}

function hasSelectedMarketTrade(
  market: XxyyTradeLookupResult | undefined,
): market is XxyyTradeLookupResult & {
  matchedPair: NonNullable<XxyyTradeLookupResult['matchedPair']>;
  trade: NonNullable<XxyyTradeLookupResult['trade']>;
} {
  return (
    (market?.status === 'exact' || market?.status === 'multi_exact') &&
    market.matchedPair !== undefined &&
    market.trade !== undefined
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
