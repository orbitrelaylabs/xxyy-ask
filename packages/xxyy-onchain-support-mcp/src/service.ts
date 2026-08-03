import type { ChainAnalysisMcpClient, GetTransactionOutput } from '@xxyy/chain-analysis-mcp';
import type { XxyyMarketDataClient, XxyyTradeLookupResult } from '@xxyy/xxyy-market-data-adapter';
import {
  assessXxyyPoolSelection,
  assessXxyySandwichPattern,
  xxyyPoolPolicySchema,
  type XxyyPairCandidate,
  type XxyyTradeObservation,
} from '@xxyy/xxyy-transaction-diagnosis-core';

import {
  diagnoseXxyyTransactionInputSchema,
  diagnoseXxyyTransactionOutputSchema,
  type XxyyDiagnosisPoolPolicy,
  type XxyyScreenshotEvidence,
  type XxyyScreenshotEvidenceProvider,
  type XxyySurroundingTrade,
  type XxyyTransactionDiagnosisHandler,
} from './contracts.js';

export interface CreateXxyyTransactionDiagnosisServiceOptions {
  canonicalPoolResolver?: (input: {
    candidates: readonly XxyyPairCandidate[];
    chain: string;
    targetTokenAddresses: readonly string[];
  }) => Promise<string | undefined> | string | undefined;
  chainAnalysis: ChainAnalysisMcpClient;
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
      } else if (market?.status !== 'exact') {
        warnings.push('XXYY did not return one exact full transaction-hash match.');
      }

      let poolAssessment;
      if (input.checks.includes('pool') && market?.status === 'exact') {
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
        input.checks.includes('sandwich') && market?.status === 'exact'
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
        if (market?.status === 'exact') {
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
      if (market?.status === 'exact') {
        if (options.screenshotProvider === undefined) {
          screenshotEvidence = { reason: 'not_configured', status: 'unavailable' };
        } else {
          try {
            const artifact = await options.screenshotProvider.capture(
              {
                chain: context.chain,
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
  trade: { maker: string; type: 'buy' | 'sell' },
): XxyyTradeObservation {
  return {
    actor: trade.maker,
    ...(transaction.family === 'evm'
      ? transaction.analysis.transaction.blockNumber === undefined
        ? {}
        : { blockNumber: transaction.analysis.transaction.blockNumber }
      : transaction.analysis === undefined
        ? {}
        : { slot: transaction.analysis.slot }),
    poolAddress,
    side: trade.type,
    transactionId: transaction.transactionId,
  };
}

function diagnosisStatus(input: {
  marketStatus: 'conflict' | 'exact' | 'not_found' | undefined;
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
    input.marketStatus === 'exact' &&
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
    .sort((left, right) => right.timestamp - left.timestamp)[0];
  const later = [...surroundingTrades]
    .filter((trade) => trade.relation === 'later')
    .sort((left, right) => left.timestamp - right.timestamp)[0];
  const observations: XxyyTradeObservation[] = [
    ...(earlier === undefined
      ? []
      : [surroundingObservation(earlier, market.matchedPair!.pairAddress, 0)]),
    target,
    ...(later === undefined
      ? []
      : [surroundingObservation(later, market.matchedPair!.pairAddress, 2)]),
  ];
  return assessXxyySandwichPattern({
    coverage: {
      actorAssetDeltas: 'missing',
      neighborhood: 'partial',
      poolState: 'missing',
      sourceConflicts: market.diagnostics.some((item) => item.code.includes('conflict')) ? 1 : 0,
    },
    observations,
    targetTransactionId: transaction.transactionId,
  });
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
  chainAnalysis: ChainAnalysisMcpClient,
  signal: AbortSignal | undefined,
): Promise<XxyySurroundingTrade[]> {
  return await Promise.all(
    (market.contextTrades ?? []).map(async (trade): Promise<XxyySurroundingTrade> => {
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
  marketStatus: 'conflict' | 'exact' | 'not_found' | undefined,
  screenshotReady: boolean,
): string {
  const match =
    marketStatus === 'exact'
      ? 'XXYY returned one exact trade match.'
      : marketStatus === 'conflict'
        ? 'XXYY evidence conflicted with the normalized transaction.'
        : 'No exact XXYY trade match was available.';
  return `${transaction.summary} ${match} Screenshot evidence is ${screenshotReady ? 'ready' : 'unavailable'}.`;
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
