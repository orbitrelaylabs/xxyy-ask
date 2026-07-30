import { describe, expect, it } from 'vitest';

import {
  evaluateAnswerQualityRolloutGate,
  parseAnswerQualityRolloutGateInput,
  type AnswerQualityRolloutGateInput,
} from './answer-quality-rollout-gate.js';

describe('evaluateAnswerQualityRolloutGate', () => {
  it('passes a fully approved, observed, reviewed, and budgeted window', () => {
    const report = evaluateAnswerQualityRolloutGate(fixture(), new Date('2026-07-31T00:00:00Z'));

    expect(report).toMatchObject({
      metrics: {
        averageCostUsd: 0.01,
        averageModelTokens: 500,
        boundaryRegressionCount: 0,
        reviewedPassRate: 1,
        reviewedSamples: 2,
        sampleSize: 4,
        windowMinutes: 60,
      },
      passed: true,
      reasons: [],
      schemaVersion: '1',
    });
    expect(report.channels).toEqual([
      {
        answerDifferenceRate: 1,
        channel: 'web',
        completeRate: 1,
        errorRate: 0,
        p95LatencyMs: 1200,
        sampleSize: 2,
        shadowErrorRate: 0,
        sourceTypeDifferenceRate: 1,
      },
      {
        answerDifferenceRate: 1,
        channel: 'telegram',
        completeRate: 1,
        errorRate: 0,
        p95LatencyMs: 1100,
        sampleSize: 2,
        shadowErrorRate: 0,
        sourceTypeDifferenceRate: 1,
      },
    ]);
  });

  it('fails closed when approvals, samples, review, safety, latency, or billing are insufficient', () => {
    const input = fixture();
    input.policy.approvalId = '';
    input.policy.approvedBy = '';
    input.policy.approvedAt = '2026-07-30T00:30:00Z';
    input.policy.minSampleSizePerChannel = 3;
    input.policy.maxP95LatencyMs = 1_000;
    input.observations[0] = {
      ...input.observations[0]!,
      optimizedPercentage: 50,
      outcome: 'error',
    };
    input.observations[1] = {
      ...input.observations[1]!,
      shadowErrorName: 'ProviderError',
    };
    input.review = { boundaryRegressionCount: 1, passedSamples: 0, reviewedSamples: 1 };
    input.billing = {
      measurementSource: '',
      requestCount: 1,
      totalCostUsd: 1,
      totalModelTokens: 20_000,
    };

    const report = evaluateAnswerQualityRolloutGate(input, new Date('2026-07-31T00:00:00Z'));

    expect(report.passed).toBe(false);
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        'rollout policy requires a non-empty approvalId and approvedBy',
        'policy approval occurred after the observation window started',
        'billing evidence requires a measurement source',
        'channel web sample size 2 is below 3',
        'channel web observations do not match the approved mode and percentage',
        'boundary regression count 1 is above zero',
        'billing customer request count 1 does not exactly match 4 observations',
      ]),
    );
  });

  it('rejects observations outside the declared window', () => {
    const input = fixture();
    input.observations[0] = {
      ...input.observations[0]!,
      observedAt: '2026-07-29T23:59:59Z',
    };

    expect(
      evaluateAnswerQualityRolloutGate(input, new Date('2026-07-31T00:00:00Z')).reasons,
    ).toContain('one or more rollout observations fall outside the declared window');
  });

  it('treats successful boundary responses without an evidence status as complete', () => {
    const input = fixture();
    const boundaryObservation: AnswerQualityRolloutGateInput['observations'][number] = {
      ...input.observations[0]!,
      primaryRoute: 'boundary',
    };
    delete boundaryObservation.answerStatus;
    input.observations[0] = boundaryObservation;

    expect(
      evaluateAnswerQualityRolloutGate(input, new Date('2026-07-31T00:00:00Z')).channels[0],
    ).toMatchObject({ completeRate: 1 });
  });

  it('rejects untrusted evidence with unknown or privacy-sensitive fields', () => {
    expect(() =>
      parseAnswerQualityRolloutGateInput({
        ...fixture(),
        observations: [
          {
            ...fixture().observations[0],
            answer: 'must not be persisted in rollout evidence',
          },
        ],
      }),
    ).toThrow(/Invalid answer-quality rollout gate observations\.0/);
  });
});

function fixture(): AnswerQualityRolloutGateInput {
  return {
    billing: {
      measurementSource: 'provider-billing-export',
      requestCount: 4,
      totalCostUsd: 0.04,
      totalModelTokens: 2_000,
    },
    observations: [
      observation('web', 1_000, '2026-07-30T00:10:00Z'),
      observation('web', 1_200, '2026-07-30T00:20:00Z'),
      observation('telegram', 900, '2026-07-30T00:30:00Z'),
      observation('telegram', 1_100, '2026-07-30T00:40:00Z'),
    ],
    policy: {
      approvalId: 'approval-1',
      approvedAt: '2026-07-29T23:00:00Z',
      approvedBy: 'support-owner',
      channels: ['web', 'telegram'],
      expectedMode: 'shadow',
      expectedOptimizedPercentage: { telegram: 5, web: 5 },
      maxAverageCostUsd: 0.02,
      maxAverageModelTokens: 1_000,
      maxP95LatencyMs: 2_000,
      maxPrimaryErrorRate: 0.01,
      maxShadowErrorRate: 0.01,
      minCompleteRate: 0.95,
      minReviewedPassRate: 0.95,
      minReviewedSamples: 2,
      minSampleSizePerChannel: 2,
      minWindowMinutes: 60,
    },
    review: {
      boundaryRegressionCount: 0,
      passedSamples: 2,
      reviewedSamples: 2,
    },
    schemaVersion: '1',
    windowEndedAt: '2026-07-30T01:00:00Z',
    windowStartedAt: '2026-07-30T00:00:00Z',
  };
}

function observation(
  channel: 'telegram' | 'web',
  latencyMs: number,
  observedAt: string,
): AnswerQualityRolloutGateInput['observations'][number] {
  return {
    answerFingerprintEqual: false,
    answerStatus: 'complete',
    channel,
    citationCount: 1,
    citationCountDelta: 0,
    configVersion: '1',
    intent: 'product_qa',
    intentEqual: true,
    mode: 'shadow',
    observedAt,
    optimizedPercentage: 5,
    outcome: 'success',
    primaryLatencyMs: latencyMs,
    primaryRoute: 'product_answer',
    primarySourceTypes: ['official_docs'],
    primaryVariant: 'legacy',
    schemaVersion: '1',
    shadowAnswerStatus: 'complete',
    shadowLatencyMs: latencyMs + 100,
    shadowRoute: 'product_answer',
    shadowSourceTypes: ['x_updates'],
    shadowVariant: 'optimized',
    sourceTypesEqual: false,
  };
}
