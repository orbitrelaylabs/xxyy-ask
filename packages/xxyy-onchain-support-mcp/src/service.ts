import type {
  ChainAnalysisMcpClient,
  DetectSandwichOutput,
  GetTransactionOutput,
} from '@xxyy/chain-analysis-mcp';
import type { XxyyMarketDataClient, XxyyTradeLookupResult } from '@xxyy/xxyy-market-data-adapter';
import {
  assessXxyyPoolSelection,
  assessXxyySandwichPattern,
  xxyyPoolPolicySchema,
  xxyySandwichAssessmentSchema,
  type XxyyPairCandidate,
  type XxyyTradeObservation,
} from '@xxyy/xxyy-transaction-diagnosis-core';

import {
  diagnoseXxyyTransactionInputSchema,
  diagnoseXxyyTransactionOutputSchema,
  type XxyyDiagnosisPoolPolicy,
  type XxyyScreenshotEvidence,
  type XxyyScreenshotEvidenceProvider,
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
      const market =
        context.targetTokenAddresses.length === 0
          ? undefined
          : await options.marketData.findTrade(
              {
                ...(context.actor === undefined ? {} : { actor: context.actor }),
                chain: context.chain,
                targetTokenAddresses: context.targetTokenAddresses,
                ...(context.timestampMs === undefined ? {} : { timestampMs: context.timestampMs }),
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

      let sandwichAssessment;
      if (input.checks.includes('sandwich')) {
        if (market?.status === 'exact') {
          if (transaction.family === 'evm') {
            try {
              const deepResult = await options.chainAnalysis.detectSandwich(
                {
                  chainId: transaction.chainId,
                  poolAddress: market.matchedPair!.pairAddress,
                  transactionHash: transaction.transactionId,
                },
                requestOptions.signal === undefined ? {} : { signal: requestOptions.signal },
              );
              sandwichAssessment = projectEvmSandwich(deepResult);
            } catch {
              sandwichAssessment = insufficientPublicSandwich(transaction, market);
              warnings.push(
                'The EVM archive/MEV data plane or verified pool allowlist was unavailable.',
              );
            }
          } else {
            sandwichAssessment = insufficientPublicSandwich(transaction, market);
            warnings.push(
              'Same-slot neighboring swaps and profit/loss evidence are not available from the current Solana public data plane.',
            );
          }
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
                pairAddress: market.matchedPair!.pairAddress,
                transactionId: transaction.transactionId,
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
} {
  if (transaction.family === 'evm') {
    const tokenAddresses = unique(
      transaction.analysis.tokenTransfers.map((item) => item.tokenAddress),
    );
    const timestamp = transaction.analysis.transaction.blockTimestamp;
    return {
      ...(transaction.analysis.transaction.from === undefined
        ? {}
        : { actor: transaction.analysis.transaction.from }),
      chain: transaction.network,
      targetTokenAddresses: tokenAddresses.slice(0, 8),
      ...(timestamp === undefined ? {} : { timestampMs: Number(BigInt(timestamp) * 1_000n) }),
    };
  }

  const snapshot = transaction.analysis;
  if (snapshot === undefined) {
    return { chain: transaction.network, targetTokenAddresses: [] };
  }
  const changes = snapshot.tokenBalanceChanges.filter((item) => item.deltaRaw !== '0');
  const owners = unique(changes.flatMap((item) => (item.owner === undefined ? [] : [item.owner])));
  const timestampMs = snapshot.blockTime === undefined ? undefined : Date.parse(snapshot.blockTime);
  return {
    ...(owners.length === 1 ? { actor: owners[0] } : {}),
    chain: transaction.network,
    targetTokenAddresses: unique(changes.map((item) => item.mint)).slice(0, 8),
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
    input.poolAssessment?.liquidityClass === 'unknown';
  return input.transaction.status === 'success' &&
    input.marketStatus === 'exact' &&
    input.screenshotReady &&
    !conclusionIncomplete
    ? 'success'
    : 'partial';
}

function insufficientPublicSandwich(
  transaction: GetTransactionOutput,
  market: XxyyTradeLookupResult,
) {
  const target = targetObservation(transaction, market.matchedPair!.pairAddress, market.trade!);
  return assessXxyySandwichPattern({
    coverage: {
      actorAssetDeltas: 'missing',
      neighborhood: 'partial',
      poolState: 'missing',
      sourceConflicts: market.diagnostics.some((item) => item.code.includes('conflict')) ? 1 : 0,
    },
    observations: [target],
    targetTransactionId: transaction.transactionId,
  });
}

function projectEvmSandwich(output: DetectSandwichOutput) {
  const sandwich = output.mev?.sandwich;
  if (sandwich === undefined) {
    return xxyySandwichAssessmentSchema.parse({
      criteria: unknownCriteria(),
      reasonCodes: ['neighborhood_incomplete'],
      verdict: 'insufficient_data',
    });
  }
  const positiveCandidate = sandwich.verdict === 'confirmed' || sandwich.verdict === 'likely';
  return xxyySandwichAssessmentSchema.parse({
    ...(sandwich.backTransactionHash === undefined
      ? {}
      : { backTransactionId: sandwich.backTransactionHash }),
    ...(sandwich.attacker === undefined ? {} : { candidateActor: sandwich.attacker }),
    criteria: {
      actorLoop: sandwich.assetLoopVerified
        ? 'yes'
        : sandwich.reasonCodes.includes('actor_deltas_contradict_loop')
          ? 'no'
          : 'unknown',
      adverseVictimImpact:
        sandwich.victimLossRaw === undefined
          ? sandwich.reasonCodes.includes('target_not_adversely_affected')
            ? 'no'
            : 'unknown'
          : sandwich.victimLossRaw === '0'
            ? 'no'
            : 'yes',
      profitableActor:
        sandwich.attackerProfitRaw === undefined
          ? sandwich.reasonCodes.includes('attacker_not_profitable')
            ? 'no'
            : 'unknown'
          : sandwich.attackerProfitRaw === '0'
            ? 'no'
            : 'yes',
      sameBlockOrSlot: positiveCandidate ? 'yes' : 'unknown',
      samePool: positiveCandidate ? 'yes' : 'unknown',
      transactionOrder: positiveCandidate ? 'yes' : 'unknown',
      twoSidedDirection: positiveCandidate ? 'yes' : 'unknown',
    },
    ...(sandwich.frontTransactionHash === undefined
      ? {}
      : { frontTransactionId: sandwich.frontTransactionHash }),
    reasonCodes: projectEvmReasonCodes(sandwich.reasonCodes, sandwich.verdict),
    verdict: sandwich.verdict,
  });
}

function projectEvmReasonCodes(
  codes: readonly string[],
  verdict: 'confirmed' | 'likely' | 'unlikely' | 'insufficient_data',
) {
  const mapped = new Set<
    | 'actor_loop_contradicted'
    | 'actor_mismatch'
    | 'candidate_pattern_complete'
    | 'direction_mismatch'
    | 'loss_or_profit_missing'
    | 'neighborhood_incomplete'
    | 'no_bracketing_transactions'
    | 'not_profitable'
    | 'pool_state_discontinuity'
    | 'quote_mismatch'
    | 'source_conflict'
    | 'target_not_adversely_affected'
    | 'unsupported_observation'
  >();
  if (verdict === 'confirmed' || verdict === 'likely') mapped.add('candidate_pattern_complete');
  for (const code of codes) {
    if (code === 'actor_mismatch') mapped.add('actor_mismatch');
    if (code === 'actor_deltas_contradict_loop') mapped.add('actor_loop_contradicted');
    if (code === 'bracketing_direction_mismatch') mapped.add('direction_mismatch');
    if (code === 'actor_deltas_missing') mapped.add('loss_or_profit_missing');
    if (code === 'neighborhood_incomplete') mapped.add('neighborhood_incomplete');
    if (code === 'no_adjacent_bracketing_transactions') mapped.add('no_bracketing_transactions');
    if (code === 'attacker_not_profitable') mapped.add('not_profitable');
    if (code === 'pool_state_discontinuity') mapped.add('pool_state_discontinuity');
    if (code === 'quote_mismatch') mapped.add('quote_mismatch');
    if (code === 'source_conflict') mapped.add('source_conflict');
    if (code === 'target_not_adversely_affected') mapped.add('target_not_adversely_affected');
    if (code === 'unsupported_observation') mapped.add('unsupported_observation');
  }
  if (mapped.size === 0) mapped.add('neighborhood_incomplete');
  return [...mapped];
}

function unknownCriteria() {
  return {
    actorLoop: 'unknown' as const,
    adverseVictimImpact: 'unknown' as const,
    profitableActor: 'unknown' as const,
    sameBlockOrSlot: 'unknown' as const,
    samePool: 'unknown' as const,
    transactionOrder: 'unknown' as const,
    twoSidedDirection: 'unknown' as const,
  };
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
