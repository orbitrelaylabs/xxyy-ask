import type { DiagnoseXxyyTransactionOutput } from '@xxyy/transaction-skill-bridge';

type RelatedFinding = 'sandwich' | 'small_pool';

interface ComparableTrade {
  nativeAmount: number;
  relation?: 'earlier' | 'later' | 'same_time';
  timestamp: number;
  tokenAmount: number;
  transactionId: string;
  type: 'buy' | 'sell';
  usdAmount?: number;
}

interface LossEstimateBasis {
  actualUnitPriceNative: number;
  benchmarkTransactionId: string;
  benchmarkUnitPriceNative: number;
  expectedNativeAmount: number;
  relatedFindings: RelatedFinding[];
  scope: 'selected_trade' | 'selected_trade_leg';
  side: 'buy' | 'sell';
}

export type TransactionLossEstimate =
  | ({
      status: 'estimated';
      lossNativeAmount: number;
      lossPpm: number;
      lossUsdAmount?: number;
    } & LossEstimateBasis)
  | ({ status: 'no_adverse_deviation' } & LossEstimateBasis)
  | {
      status: 'insufficient_data';
      reason: 'invalid_trade_amounts' | 'missing_prior_same_side_trade';
      relatedFindings: RelatedFinding[];
      scope: 'selected_trade' | 'selected_trade_leg';
    };

export function estimateTransactionExecutionLoss(
  output: DiagnoseXxyyTransactionOutput,
): TransactionLossEstimate | undefined {
  const relatedFindings: RelatedFinding[] = [
    ...(output.poolAssessment?.liquidityClass === 'small' ? (['small_pool'] as const) : []),
    ...(output.sandwichAssessment?.verdict === 'likely' ||
    output.sandwichAssessment?.verdict === 'confirmed'
      ? (['sandwich'] as const)
      : []),
  ];
  if (relatedFindings.length === 0) return undefined;

  const scope =
    output.market?.status === 'multi_exact'
      ? ('selected_trade_leg' as const)
      : ('selected_trade' as const);
  const target = comparableTrade(output.market?.trade);
  if (target === undefined) {
    return { reason: 'invalid_trade_amounts', relatedFindings, scope, status: 'insufficient_data' };
  }

  const candidates = uniqueTrades([
    ...(Array.isArray(output.surroundingTrades) ? output.surroundingTrades : []),
    ...(Array.isArray(output.market?.contextTrades) ? output.market.contextTrades : []),
  ])
    .map(comparableTrade)
    .filter((trade): trade is ComparableTrade => trade !== undefined)
    .filter((trade) => trade.relation === 'earlier' && trade.type === target.type);
  const frontTransactionId = output.sandwichAssessment?.frontTransactionId;
  const benchmark =
    candidates.find((trade) => trade.transactionId === frontTransactionId) ??
    candidates.sort((left, right) => right.timestamp - left.timestamp)[0];
  if (benchmark === undefined) {
    return {
      reason: 'missing_prior_same_side_trade',
      relatedFindings,
      scope,
      status: 'insufficient_data',
    };
  }

  const actualUnitPriceNative = target.nativeAmount / target.tokenAmount;
  const benchmarkUnitPriceNative = benchmark.nativeAmount / benchmark.tokenAmount;
  const expectedNativeAmount = target.tokenAmount * benchmarkUnitPriceNative;
  if (
    ![actualUnitPriceNative, benchmarkUnitPriceNative, expectedNativeAmount].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return { reason: 'invalid_trade_amounts', relatedFindings, scope, status: 'insufficient_data' };
  }

  const lossNativeAmount =
    target.type === 'buy'
      ? target.nativeAmount - expectedNativeAmount
      : expectedNativeAmount - target.nativeAmount;
  const basis: LossEstimateBasis = {
    actualUnitPriceNative,
    benchmarkTransactionId: benchmark.transactionId,
    benchmarkUnitPriceNative,
    expectedNativeAmount,
    relatedFindings,
    scope,
    side: target.type,
  };
  if (!Number.isFinite(lossNativeAmount) || lossNativeAmount <= 0) {
    return { ...basis, status: 'no_adverse_deviation' };
  }

  const lossPpm = Math.max(0, Math.round((lossNativeAmount / expectedNativeAmount) * 1_000_000));
  const nativeUsdPrice =
    target.usdAmount === undefined ? undefined : target.usdAmount / target.nativeAmount;
  const lossUsdAmount =
    nativeUsdPrice === undefined || !Number.isFinite(nativeUsdPrice) || nativeUsdPrice <= 0
      ? undefined
      : lossNativeAmount * nativeUsdPrice;
  return {
    ...basis,
    lossNativeAmount,
    lossPpm,
    ...(lossUsdAmount === undefined ? {} : { lossUsdAmount }),
    status: 'estimated',
  };
}

function comparableTrade(value: unknown): ComparableTrade | undefined {
  if (!isRecord(value) || (value.type !== 'buy' && value.type !== 'sell')) return undefined;
  const nativeAmount = positiveNumber(value.nativeAmount);
  const tokenAmount = positiveNumber(value.tokenAmount);
  if (
    nativeAmount === undefined ||
    tokenAmount === undefined ||
    typeof value.timestamp !== 'number' ||
    !Number.isFinite(value.timestamp) ||
    typeof value.transactionId !== 'string'
  ) {
    return undefined;
  }
  const relation =
    value.relation === 'earlier' || value.relation === 'later' || value.relation === 'same_time'
      ? value.relation
      : undefined;
  const usdAmount = positiveNumber(value.usdAmount);
  return {
    nativeAmount,
    ...(relation === undefined ? {} : { relation }),
    timestamp: value.timestamp,
    tokenAmount,
    transactionId: value.transactionId,
    type: value.type,
    ...(usdAmount === undefined ? {} : { usdAmount }),
  };
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function uniqueTrades(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!isRecord(value) || typeof value.transactionId !== 'string') return true;
    if (seen.has(value.transactionId)) return false;
    seen.add(value.transactionId);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
