import { z } from 'zod';

export const XXYY_TRANSACTION_DIAGNOSIS_CORE_VERSION = '0.1.0' as const;

const identifierSchema = z.string().trim().min(1).max(256);
const unsignedDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const decimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);

export const xxyyTradeSideSchema = z.enum(['buy', 'sell', 'swap', 'unknown']);

export const xxyyTradeObservationSchema = z
  .object({
    actor: identifierSchema.optional(),
    blockNumber: unsignedDecimalSchema.optional(),
    inputAmountRaw: unsignedDecimalSchema.optional(),
    inputAsset: identifierSchema.optional(),
    outputAmountRaw: unsignedDecimalSchema.optional(),
    outputAsset: identifierSchema.optional(),
    poolAddress: identifierSchema,
    side: xxyyTradeSideSchema,
    slot: unsignedDecimalSchema.optional(),
    transactionId: identifierSchema,
    transactionIndex: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.blockNumber !== undefined && value.slot !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A trade observation cannot contain both an EVM block number and a Solana slot.',
        path: ['slot'],
      });
    }
  });

export const xxyyPairCandidateSchema = z
  .object({
    baseToken: identifierSchema,
    chain: z.string().trim().min(2).max(96),
    dexId: z.string().trim().min(1).max(64).optional(),
    liquidityUsd: decimalAmountSchema.optional(),
    pairAddress: identifierSchema,
    quoteToken: identifierSchema,
  })
  .strict();

export const xxyyPoolPolicySchema = z
  .object({
    maxSmallPoolLiquidityUsd: decimalAmountSchema,
    maxSmallPoolRelativeLiquidityPpm: z.number().int().min(0).max(1_000_000),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  })
  .strict();

export const xxyyPoolAssessmentInputSchema = z
  .object({
    actualPoolAddress: identifierSchema,
    candidatePools: z.array(xxyyPairCandidateSchema).min(1).max(64),
    canonicalPoolAddress: identifierSchema.optional(),
    policy: xxyyPoolPolicySchema,
  })
  .strict();

export const xxyyPoolAssessmentSchema = z
  .object({
    actualLiquidityUsd: decimalAmountSchema.optional(),
    canonicalMatch: z.enum(['matches', 'does_not_match', 'unknown']),
    dominantLiquidityUsd: decimalAmountSchema.optional(),
    dominantPoolAddress: identifierSchema.optional(),
    liquidityClass: z.enum(['normal', 'small', 'unknown']),
    policyVersion: z.string(),
    reasonCodes: z.array(
      z.enum([
        'actual_pool_not_in_candidates',
        'canonical_pool_not_declared',
        'liquidity_missing',
        'matches_canonical_pool',
        'non_canonical_pool',
        'relative_and_absolute_liquidity_small',
        'sufficient_liquidity',
      ]),
    ),
    relativeLiquidityPpm: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const xxyySandwichCoverageSchema = z
  .object({
    actorAssetDeltas: z.enum(['complete', 'partial', 'missing']),
    neighborhood: z.enum(['complete', 'partial']),
    poolState: z.enum(['complete', 'partial', 'missing']),
    sourceConflicts: z.number().int().nonnegative().max(100),
  })
  .strict();

export const xxyySandwichCalculationSchema = z
  .object({
    actorAssetLoopVerified: z.boolean().optional(),
    attackerProfitRaw: unsignedDecimalSchema.optional(),
    victimLossRaw: unsignedDecimalSchema.optional(),
  })
  .strict();

export const xxyySandwichAssessmentInputSchema = z
  .object({
    calculation: xxyySandwichCalculationSchema.optional(),
    coverage: xxyySandwichCoverageSchema,
    observations: z.array(xxyyTradeObservationSchema).min(1).max(1_000),
    targetTransactionId: identifierSchema,
  })
  .strict();

const criterionSchema = z.enum(['yes', 'no', 'unknown']);

export const xxyySandwichAssessmentSchema = z
  .object({
    attackerProfitRaw: unsignedDecimalSchema.optional(),
    backTransactionId: identifierSchema.optional(),
    candidateActor: identifierSchema.optional(),
    counterfactualAmountOutRaw: unsignedDecimalSchema.optional(),
    criteria: z
      .object({
        actorLoop: criterionSchema,
        adverseVictimImpact: criterionSchema,
        profitableActor: criterionSchema,
        sameBlockOrSlot: criterionSchema,
        samePool: criterionSchema,
        transactionOrder: criterionSchema,
        twoSidedDirection: criterionSchema,
      })
      .strict(),
    frontTransactionId: identifierSchema.optional(),
    profitToken: identifierSchema.optional(),
    reasonCodes: z.array(
      z.enum([
        'actor_mismatch',
        'actor_loop_contradicted',
        'actor_same_as_target',
        'candidate_pattern_complete',
        'direction_mismatch',
        'loss_or_profit_missing',
        'neighborhood_incomplete',
        'no_bracketing_transactions',
        'not_profitable',
        'ordering_missing',
        'pool_mismatch',
        'pool_state_discontinuity',
        'quote_mismatch',
        'same_block_or_slot_missing',
        'source_conflict',
        'target_not_adversely_affected',
        'unsupported_observation',
      ]),
    ),
    verdict: z.enum(['confirmed', 'likely', 'unlikely', 'insufficient_data']),
    victimLossPpm: unsignedDecimalSchema.optional(),
    victimLossRaw: unsignedDecimalSchema.optional(),
  })
  .strict();

export type XxyyTradeObservation = z.output<typeof xxyyTradeObservationSchema>;
export type XxyyPairCandidate = z.output<typeof xxyyPairCandidateSchema>;
export type XxyyPoolAssessmentInput = z.output<typeof xxyyPoolAssessmentInputSchema>;
export type XxyyPoolAssessment = z.output<typeof xxyyPoolAssessmentSchema>;
export type XxyySandwichAssessmentInput = z.output<typeof xxyySandwichAssessmentInputSchema>;
export type XxyySandwichAssessment = z.output<typeof xxyySandwichAssessmentSchema>;
