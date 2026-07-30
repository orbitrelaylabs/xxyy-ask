import {
  supportedAgentRoutes,
  supportedAnswerStatuses,
  supportedChannels,
  supportedIntents,
  supportedSourceTypes,
  type ChatChannel,
} from '@xxyy/shared';
import { z } from 'zod';

import type {
  AnswerQualityMode,
  AnswerQualityRolloutObservation,
} from './answer-quality-rollout.js';

export interface AnswerQualityRolloutGatePolicy {
  approvalId: string;
  approvedAt: string;
  approvedBy: string;
  channels: ChatChannel[];
  expectedMode: AnswerQualityMode;
  expectedOptimizedPercentage: Partial<Record<ChatChannel, number>>;
  maxAverageCostUsd: number;
  maxAverageModelTokens: number;
  maxP95LatencyMs: number;
  maxPrimaryErrorRate: number;
  maxShadowErrorRate: number;
  minCompleteRate: number;
  minReviewedPassRate: number;
  minReviewedSamples: number;
  minSampleSizePerChannel: number;
  minWindowMinutes: number;
}

export interface AnswerQualityRolloutBillingEvidence {
  measurementSource: string;
  requestCount: number;
  totalCostUsd: number;
  totalModelTokens: number;
}

export interface AnswerQualityRolloutReviewEvidence {
  boundaryRegressionCount: number;
  passedSamples: number;
  reviewedSamples: number;
}

export interface AnswerQualityRolloutGateInput {
  billing: AnswerQualityRolloutBillingEvidence;
  observations: AnswerQualityRolloutObservation[];
  policy: AnswerQualityRolloutGatePolicy;
  review: AnswerQualityRolloutReviewEvidence;
  schemaVersion: '1';
  windowEndedAt: string;
  windowStartedAt: string;
}

export interface AnswerQualityRolloutChannelMetrics {
  answerDifferenceRate: number;
  channel: ChatChannel;
  completeRate: number;
  errorRate: number;
  p95LatencyMs: number;
  sampleSize: number;
  shadowErrorRate: number;
  sourceTypeDifferenceRate: number;
}

export interface AnswerQualityRolloutGateReport {
  channels: AnswerQualityRolloutChannelMetrics[];
  generatedAt: string;
  metrics: {
    averageCostUsd: number;
    averageModelTokens: number;
    boundaryRegressionCount: number;
    reviewedPassRate: number;
    reviewedSamples: number;
    sampleSize: number;
    windowMinutes: number;
  };
  passed: boolean;
  policy: {
    approvalId: string;
    approvedAt: string;
    approvedBy: string;
  };
  reasons: string[];
  schemaVersion: '1';
}

const nonNegativeFiniteNumberSchema = z.number().finite().nonnegative();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const rateSchema = z.number().finite().min(0).max(1);
const answerQualityModeSchema = z.enum(['legacy', 'optimized', 'shadow']);
const answerQualityVariantSchema = z.enum(['legacy', 'optimized']);

const rolloutObservationSchema = z.strictObject({
  answerFingerprintEqual: z.boolean().optional(),
  answerStatus: z.enum(supportedAnswerStatuses).optional(),
  channel: z.enum(supportedChannels),
  citationCount: nonNegativeIntegerSchema.optional(),
  citationCountDelta: z.number().int().optional(),
  configVersion: z.literal('1'),
  errorName: z.string().min(1).optional(),
  event: z.literal('answer_quality_rollout').optional(),
  intent: z.enum(supportedIntents).optional(),
  intentEqual: z.boolean().optional(),
  mode: answerQualityModeSchema,
  observedAt: z.iso.datetime({ offset: true }),
  optimizedPercentage: z.number().finite().min(0).max(100),
  outcome: z.enum(['error', 'success']),
  primaryLatencyMs: nonNegativeFiniteNumberSchema,
  primaryRoute: z.enum(supportedAgentRoutes).optional(),
  primarySourceTypes: z.array(z.enum(supportedSourceTypes)).optional(),
  primaryVariant: answerQualityVariantSchema,
  schemaVersion: z.literal('1'),
  shadowAnswerStatus: z.enum(supportedAnswerStatuses).optional(),
  shadowCitationCount: nonNegativeIntegerSchema.optional(),
  shadowErrorName: z.string().min(1).optional(),
  shadowLatencyMs: nonNegativeFiniteNumberSchema.optional(),
  shadowRoute: z.enum(supportedAgentRoutes).optional(),
  shadowSourceTypes: z.array(z.enum(supportedSourceTypes)).optional(),
  shadowTotalTokens: nonNegativeIntegerSchema.optional(),
  shadowVariant: answerQualityVariantSchema.optional(),
  sourceTypesEqual: z.boolean().optional(),
  totalTokenDelta: z.number().int().optional(),
  totalTokens: nonNegativeIntegerSchema.optional(),
});

const rolloutGateInputSchema = z.strictObject({
  billing: z.strictObject({
    measurementSource: z.string(),
    requestCount: nonNegativeIntegerSchema,
    totalCostUsd: nonNegativeFiniteNumberSchema,
    totalModelTokens: nonNegativeIntegerSchema,
  }),
  observations: z.array(rolloutObservationSchema),
  policy: z.strictObject({
    approvalId: z.string(),
    approvedAt: z.iso.datetime({ offset: true }),
    approvedBy: z.string(),
    channels: z.array(z.enum(supportedChannels)),
    expectedMode: answerQualityModeSchema,
    expectedOptimizedPercentage: z.partialRecord(
      z.enum(supportedChannels),
      z.number().finite().min(0).max(100),
    ),
    maxAverageCostUsd: nonNegativeFiniteNumberSchema,
    maxAverageModelTokens: nonNegativeFiniteNumberSchema,
    maxP95LatencyMs: nonNegativeFiniteNumberSchema,
    maxPrimaryErrorRate: rateSchema,
    maxShadowErrorRate: rateSchema,
    minCompleteRate: rateSchema,
    minReviewedPassRate: rateSchema,
    minReviewedSamples: nonNegativeIntegerSchema,
    minSampleSizePerChannel: nonNegativeIntegerSchema,
    minWindowMinutes: nonNegativeFiniteNumberSchema,
  }),
  review: z.strictObject({
    boundaryRegressionCount: nonNegativeIntegerSchema,
    passedSamples: nonNegativeIntegerSchema,
    reviewedSamples: nonNegativeIntegerSchema,
  }),
  schemaVersion: z.literal('1'),
  windowEndedAt: z.iso.datetime({ offset: true }),
  windowStartedAt: z.iso.datetime({ offset: true }),
});

export function parseAnswerQualityRolloutObservation(
  value: unknown,
): AnswerQualityRolloutObservation {
  const parsed = rolloutObservationSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length === 0 ? 'observation' : issue?.path.join('.');
    throw new Error(
      `Invalid answer-quality rollout observation ${location ?? 'observation'}: ${issue?.message ?? 'unknown validation error'}.`,
    );
  }
  const { event: _event, ...observation } = parsed.data;
  return observation as AnswerQualityRolloutObservation;
}

export function parseAnswerQualityRolloutGateInput(value: unknown): AnswerQualityRolloutGateInput {
  const parsed = rolloutGateInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length === 0 ? 'input' : issue?.path.join('.');
    throw new Error(
      `Invalid answer-quality rollout gate ${location ?? 'input'}: ${issue?.message ?? 'unknown validation error'}.`,
    );
  }
  return parsed.data as AnswerQualityRolloutGateInput;
}

export function evaluateAnswerQualityRolloutGate(
  input: AnswerQualityRolloutGateInput,
  now: Date = new Date(),
): AnswerQualityRolloutGateReport {
  const reasons: string[] = [];
  validateGateInput(input, reasons);
  const startedAt = parseTimestamp(input.windowStartedAt);
  const endedAt = parseTimestamp(input.windowEndedAt);
  const windowMinutes =
    startedAt === undefined || endedAt === undefined || endedAt < startedAt
      ? 0
      : (endedAt - startedAt) / 60_000;

  if (endedAt !== undefined && endedAt > now.getTime()) {
    reasons.push('observation window end timestamp is in the future');
  }
  if (windowMinutes < input.policy.minWindowMinutes) {
    reasons.push(
      `observation window ${formatMetric(windowMinutes)} minutes is below ${formatMetric(input.policy.minWindowMinutes)}`,
    );
  }
  const approvedAt = parseTimestamp(input.policy.approvedAt);
  if (approvedAt === undefined) {
    reasons.push('policy approvedAt is not a valid timestamp');
  } else {
    if (startedAt !== undefined && approvedAt > startedAt) {
      reasons.push('policy approval occurred after the observation window started');
    }
    if (approvedAt > now.getTime()) {
      reasons.push('policy approval timestamp is in the future');
    }
  }

  for (const observation of input.observations) {
    const observedAt = parseTimestamp(observation.observedAt);
    if (
      observedAt === undefined ||
      startedAt === undefined ||
      endedAt === undefined ||
      observedAt < startedAt ||
      observedAt > endedAt
    ) {
      reasons.push('one or more rollout observations fall outside the declared window');
      break;
    }
  }
  if (
    input.observations.some((observation) => !input.policy.channels.includes(observation.channel))
  ) {
    reasons.push('one or more rollout observations use a channel outside the approved policy');
  }

  const channelMetrics = input.policy.channels.map((channel) =>
    evaluateChannel(channel, input, reasons),
  );
  const reviewedPassRate =
    input.review.reviewedSamples === 0
      ? 0
      : input.review.passedSamples / input.review.reviewedSamples;
  if (input.review.reviewedSamples < input.policy.minReviewedSamples) {
    reasons.push(
      `reviewed sample size ${input.review.reviewedSamples} is below ${input.policy.minReviewedSamples}`,
    );
  }
  if (reviewedPassRate < input.policy.minReviewedPassRate) {
    reasons.push(
      `reviewed pass rate ${formatMetric(reviewedPassRate)} is below ${formatMetric(input.policy.minReviewedPassRate)}`,
    );
  }
  if (input.review.boundaryRegressionCount > 0) {
    reasons.push(`boundary regression count ${input.review.boundaryRegressionCount} is above zero`);
  }
  if (input.review.reviewedSamples > input.observations.length) {
    reasons.push('reviewed sample count cannot exceed the rollout observation count');
  }

  const averageCostUsd =
    input.billing.requestCount === 0
      ? Number.POSITIVE_INFINITY
      : input.billing.totalCostUsd / input.billing.requestCount;
  const averageModelTokens =
    input.billing.requestCount === 0
      ? Number.POSITIVE_INFINITY
      : input.billing.totalModelTokens / input.billing.requestCount;
  if (input.billing.requestCount !== input.observations.length) {
    reasons.push(
      `billing customer request count ${input.billing.requestCount} does not exactly match ${input.observations.length} observations`,
    );
  }
  if (averageCostUsd > input.policy.maxAverageCostUsd) {
    reasons.push(
      `average cost ${formatMetric(averageCostUsd)} USD exceeds ${formatMetric(input.policy.maxAverageCostUsd)} USD`,
    );
  }
  if (averageModelTokens > input.policy.maxAverageModelTokens) {
    reasons.push(
      `average model tokens ${formatMetric(averageModelTokens)} exceeds ${formatMetric(input.policy.maxAverageModelTokens)}`,
    );
  }

  return {
    channels: channelMetrics,
    generatedAt: now.toISOString(),
    metrics: {
      averageCostUsd,
      averageModelTokens,
      boundaryRegressionCount: input.review.boundaryRegressionCount,
      reviewedPassRate,
      reviewedSamples: input.review.reviewedSamples,
      sampleSize: input.observations.length,
      windowMinutes,
    },
    passed: reasons.length === 0,
    policy: {
      approvalId: input.policy.approvalId,
      approvedAt: input.policy.approvedAt,
      approvedBy: input.policy.approvedBy,
    },
    reasons: [...new Set(reasons)],
    schemaVersion: '1',
  };
}

function evaluateChannel(
  channel: ChatChannel,
  input: AnswerQualityRolloutGateInput,
  reasons: string[],
): AnswerQualityRolloutChannelMetrics {
  const observations = input.observations.filter((observation) => observation.channel === channel);
  const expectedPercentage = input.policy.expectedOptimizedPercentage[channel];
  if (expectedPercentage === undefined) {
    reasons.push(`channel ${channel} has no approved optimized percentage`);
  }
  if (observations.length < input.policy.minSampleSizePerChannel) {
    reasons.push(
      `channel ${channel} sample size ${observations.length} is below ${input.policy.minSampleSizePerChannel}`,
    );
  }
  if (
    observations.some(
      (observation) =>
        observation.mode !== input.policy.expectedMode ||
        observation.optimizedPercentage !== expectedPercentage,
    )
  ) {
    reasons.push(`channel ${channel} observations do not match the approved mode and percentage`);
  }
  if (
    input.policy.expectedMode === 'shadow' &&
    observations.some(
      (observation) => observation.outcome === 'success' && observation.shadowVariant === undefined,
    )
  ) {
    reasons.push(`channel ${channel} has successful shadow observations without shadow results`);
  }
  if (
    input.policy.expectedMode === 'shadow' &&
    observations.some(
      (observation) =>
        observation.outcome === 'success' &&
        (observation.answerFingerprintEqual === undefined ||
          observation.citationCountDelta === undefined ||
          observation.intentEqual === undefined ||
          observation.primarySourceTypes === undefined ||
          observation.shadowSourceTypes === undefined ||
          observation.sourceTypesEqual === undefined),
    )
  ) {
    reasons.push(`channel ${channel} has incomplete bounded shadow comparisons`);
  }

  const errors = observations.filter((observation) => observation.outcome === 'error').length;
  const successes = observations.filter((observation) => observation.outcome === 'success');
  const complete = successes.filter(
    (observation) =>
      observation.answerStatus === undefined || observation.answerStatus === 'complete',
  ).length;
  const shadowSamples = observations.filter(
    (observation) => observation.shadowVariant !== undefined,
  );
  const shadowErrors = shadowSamples.filter(
    (observation) => observation.shadowErrorName !== undefined,
  ).length;
  const answerComparisons = successes.filter(
    (observation) => observation.answerFingerprintEqual !== undefined,
  );
  const sourceTypeComparisons = successes.filter(
    (observation) => observation.sourceTypesEqual !== undefined,
  );
  const answerDifferenceRate =
    answerComparisons.length === 0
      ? input.policy.expectedMode === 'shadow'
        ? 1
        : 0
      : answerComparisons.filter((observation) => observation.answerFingerprintEqual === false)
          .length / answerComparisons.length;
  const sourceTypeDifferenceRate =
    sourceTypeComparisons.length === 0
      ? input.policy.expectedMode === 'shadow'
        ? 1
        : 0
      : sourceTypeComparisons.filter((observation) => observation.sourceTypesEqual === false)
          .length / sourceTypeComparisons.length;
  const errorRate = observations.length === 0 ? 1 : errors / observations.length;
  const completeRate = successes.length === 0 ? 0 : complete / successes.length;
  const shadowErrorRate =
    shadowSamples.length === 0
      ? input.policy.expectedMode === 'shadow'
        ? 1
        : 0
      : shadowErrors / shadowSamples.length;
  const p95LatencyMs = percentile(
    observations.map((observation) => observation.primaryLatencyMs),
    0.95,
  );
  if (errorRate > input.policy.maxPrimaryErrorRate) {
    reasons.push(
      `channel ${channel} error rate ${formatMetric(errorRate)} exceeds ${formatMetric(input.policy.maxPrimaryErrorRate)}`,
    );
  }
  if (shadowErrorRate > input.policy.maxShadowErrorRate) {
    reasons.push(
      `channel ${channel} shadow error rate ${formatMetric(shadowErrorRate)} exceeds ${formatMetric(input.policy.maxShadowErrorRate)}`,
    );
  }
  if (completeRate < input.policy.minCompleteRate) {
    reasons.push(
      `channel ${channel} complete rate ${formatMetric(completeRate)} is below ${formatMetric(input.policy.minCompleteRate)}`,
    );
  }
  if (p95LatencyMs > input.policy.maxP95LatencyMs) {
    reasons.push(
      `channel ${channel} P95 latency ${formatMetric(p95LatencyMs)} ms exceeds ${formatMetric(input.policy.maxP95LatencyMs)} ms`,
    );
  }

  return {
    answerDifferenceRate,
    channel,
    completeRate,
    errorRate,
    p95LatencyMs,
    sampleSize: observations.length,
    shadowErrorRate,
    sourceTypeDifferenceRate,
  };
}

function validateGateInput(input: AnswerQualityRolloutGateInput, reasons: string[]): void {
  if (input.schemaVersion !== '1') {
    reasons.push('rollout gate input schemaVersion must be 1');
  }
  if (input.policy.approvalId.trim().length === 0 || input.policy.approvedBy.trim().length === 0) {
    reasons.push('rollout policy requires a non-empty approvalId and approvedBy');
  }
  if (input.policy.channels.length === 0) {
    reasons.push('rollout policy requires at least one channel');
  }
  if (new Set(input.policy.channels).size !== input.policy.channels.length) {
    reasons.push('rollout policy channels must be unique');
  }
  if (input.billing.measurementSource.trim().length === 0) {
    reasons.push('billing evidence requires a measurement source');
  }
  for (const value of [
    input.policy.maxPrimaryErrorRate,
    input.policy.maxShadowErrorRate,
    input.policy.minCompleteRate,
    input.policy.minReviewedPassRate,
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      reasons.push('rollout rate thresholds must be finite values from 0 to 1');
      break;
    }
  }
  for (const value of [
    input.policy.maxAverageCostUsd,
    input.policy.maxAverageModelTokens,
    input.policy.maxP95LatencyMs,
    input.policy.minReviewedSamples,
    input.policy.minSampleSizePerChannel,
    input.policy.minWindowMinutes,
    input.billing.requestCount,
    input.billing.totalCostUsd,
    input.billing.totalModelTokens,
    input.review.boundaryRegressionCount,
    input.review.passedSamples,
    input.review.reviewedSamples,
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      reasons.push(
        'rollout counts, budgets, durations, and costs must be finite non-negative values',
      );
      break;
    }
  }
  if (input.review.passedSamples > input.review.reviewedSamples) {
    reasons.push('passed review samples cannot exceed reviewed samples');
  }
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

function parseTimestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatMetric(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : 'infinity';
}
