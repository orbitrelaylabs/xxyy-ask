import {
  xxyyPoolAssessmentInputSchema,
  xxyyPoolAssessmentSchema,
  type XxyyPoolAssessment,
  type XxyyPoolAssessmentInput,
} from './contracts.js';

interface DecimalValue {
  coefficient: bigint;
  scale: number;
}

export function assessXxyyPoolSelection(input: unknown): XxyyPoolAssessment {
  const parsed = xxyyPoolAssessmentInputSchema.parse(input) as XxyyPoolAssessmentInput;
  const actual = parsed.candidatePools.find(
    (candidate) => candidate.pairAddress === parsed.actualPoolAddress,
  );
  const withLiquidity = parsed.candidatePools.flatMap((candidate) =>
    candidate.liquidityUsd === undefined
      ? []
      : [{ candidate, liquidity: parseDecimal(candidate.liquidityUsd) }],
  );
  const dominant = withLiquidity.reduce<(typeof withLiquidity)[number] | undefined>(
    (current, candidate) =>
      current === undefined || compareDecimal(candidate.liquidity, current.liquidity) > 0
        ? candidate
        : current,
    undefined,
  );

  const canonicalMatch =
    parsed.canonicalPoolAddress === undefined
      ? ('unknown' as const)
      : parsed.actualPoolAddress === parsed.canonicalPoolAddress
        ? ('matches' as const)
        : ('does_not_match' as const);
  const reasonCodes: XxyyPoolAssessment['reasonCodes'] = [
    ...(actual === undefined ? (['actual_pool_not_in_candidates'] as const) : []),
    ...(canonicalMatch === 'unknown'
      ? (['canonical_pool_not_declared'] as const)
      : canonicalMatch === 'matches'
        ? (['matches_canonical_pool'] as const)
        : (['non_canonical_pool'] as const)),
  ];

  if (actual?.liquidityUsd === undefined || dominant === undefined) {
    return xxyyPoolAssessmentSchema.parse({
      canonicalMatch,
      ...(dominant === undefined
        ? {}
        : {
            dominantLiquidityUsd: dominant.candidate.liquidityUsd,
            dominantPoolAddress: dominant.candidate.pairAddress,
          }),
      liquidityClass: 'unknown',
      policyVersion: parsed.policy.version,
      reasonCodes: [...reasonCodes, 'liquidity_missing'],
    });
  }

  const actualLiquidity = parseDecimal(actual.liquidityUsd);
  const relativeLiquidityPpm = ratioPpm(actualLiquidity, dominant.liquidity);
  const belowAbsolute =
    compareDecimal(actualLiquidity, parseDecimal(parsed.policy.maxSmallPoolLiquidityUsd)) <= 0;
  const belowRelative = relativeLiquidityPpm <= parsed.policy.maxSmallPoolRelativeLiquidityPpm;
  const liquidityClass = belowAbsolute && belowRelative ? ('small' as const) : ('normal' as const);
  reasonCodes.push(
    liquidityClass === 'small' ? 'relative_and_absolute_liquidity_small' : 'sufficient_liquidity',
  );

  return xxyyPoolAssessmentSchema.parse({
    actualLiquidityUsd: actual.liquidityUsd,
    canonicalMatch,
    dominantLiquidityUsd: dominant.candidate.liquidityUsd,
    dominantPoolAddress: dominant.candidate.pairAddress,
    liquidityClass,
    policyVersion: parsed.policy.version,
    reasonCodes,
    relativeLiquidityPpm,
  });
}

function parseDecimal(value: string): DecimalValue {
  const [whole = '0', fraction = ''] = value.split('.');
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function compareDecimal(left: DecimalValue, right: DecimalValue): number {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
}

function ratioPpm(numerator: DecimalValue, denominator: DecimalValue): number {
  if (denominator.coefficient === 0n) {
    return numerator.coefficient === 0n ? 0 : 1_000_000;
  }
  const scaledNumerator = numerator.coefficient * 10n ** BigInt(denominator.scale);
  const scaledDenominator = denominator.coefficient * 10n ** BigInt(numerator.scale);
  const ratio = (scaledNumerator * 1_000_000n) / scaledDenominator;
  return Number(ratio > 1_000_000n ? 1_000_000n : ratio);
}
