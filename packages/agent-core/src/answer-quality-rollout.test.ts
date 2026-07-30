import { describe, expect, it, vi } from 'vitest';

import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import { createInMemoryQualityTracer } from '@xxyy/rag-core';

import {
  AnswerQualityRolloutConfigurationError,
  createAnswerQualityRolloutRuntime,
  loadAnswerQualityRolloutConfig,
} from './answer-quality-rollout.js';
import type { CustomerAgentRuntime } from './langgraph-customer-runtime.js';

describe('answer quality rollout', () => {
  it('defaults every channel to the optimized runtime', async () => {
    const optimized = runtime(response('optimized'));
    const legacy = runtime(response('legacy'));
    const service = createAnswerQualityRolloutRuntime({
      config: loadAnswerQualityRolloutConfig({}),
      legacy,
      optimized,
    });

    await expect(
      service.ask({ channel: 'web', message: '支持哪些功能', requestId: 'request-1' }),
    ).resolves.toMatchObject({ answer: 'optimized' });
    expect(optimized.ask).toHaveBeenCalledOnce();
    expect(legacy.ask).not.toHaveBeenCalled();
  });

  it('emits a bounded observation for a non-shadow request', async () => {
    const optimized = runtime({
      ...response('customer answer'),
      agentRoute: 'product_answer',
      tokenUsage: { totalTokens: 12 },
    });
    const observer = vi.fn();
    const service = createAnswerQualityRolloutRuntime({
      config: loadAnswerQualityRolloutConfig({}),
      legacy: runtime(response('legacy')),
      now: () => 1_000,
      observer,
      optimized,
    });

    await service.ask({ channel: 'web', message: '支持哪些功能' });

    expect(observer).toHaveBeenCalledWith({
      answerStatus: 'complete',
      channel: 'web',
      citationCount: 0,
      configVersion: '1',
      intent: 'product_qa',
      mode: 'optimized',
      observedAt: '1970-01-01T00:00:01.000Z',
      optimizedPercentage: 100,
      outcome: 'success',
      primaryLatencyMs: 0,
      primaryRoute: 'product_answer',
      primaryVariant: 'optimized',
      schemaVersion: '1',
      totalTokens: 12,
    });
    expect(JSON.stringify(observer.mock.calls)).not.toContain('customer answer');
  });

  it('runs both variants in shadow mode and returns only the selected primary', async () => {
    const optimized = runtime({
      ...response('optimized secret answer', 'complete'),
      citations: [
        {
          excerpt: '官网证据',
          file: 'docs/feature.md',
          sourceType: 'official_docs',
          title: '功能',
        },
      ],
      tokenUsage: { totalTokens: 30 },
    });
    const legacy = runtime({
      ...response('legacy secret answer', 'partial'),
      citations: [
        {
          excerpt: '更新证据',
          file: 'docs/update.md',
          sourceType: 'x_updates',
          title: '更新',
        },
      ],
      tokenUsage: { totalTokens: 20 },
    });
    const { records, tracer } = createInMemoryQualityTracer();
    const observer = vi.fn();
    const service = createAnswerQualityRolloutRuntime({
      config: loadAnswerQualityRolloutConfig({
        ANSWER_QUALITY_WEB_MODE: 'shadow',
        ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE: '100',
      }),
      legacy,
      observer,
      optimized,
      tracer,
    });

    await expect(
      service.ask({ channel: 'web', message: '支持哪些功能', requestId: 'request-2' }),
    ).resolves.toMatchObject({ answer: 'optimized secret answer' });
    expect(optimized.ask).toHaveBeenCalledOnce();
    expect(legacy.ask).toHaveBeenCalledOnce();
    expect(records.at(-1)).toMatchObject({
      name: 'agent.answer_quality_shadow',
      outputs: {
        answerEqual: false,
        primaryAnswerStatus: 'complete',
        primarySourceTypes: ['official_docs'],
        primaryVariant: 'optimized',
        shadowAnswerStatus: 'partial',
        shadowSourceTypes: ['x_updates'],
        shadowVariant: 'legacy',
        sourceTypesEqual: false,
        totalTokenDelta: 10,
      },
    });
    expect(JSON.stringify(records)).not.toContain('optimized secret answer');
    expect(JSON.stringify(records)).not.toContain('legacy secret answer');
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        answerFingerprintEqual: false,
        citationCount: 1,
        citationCountDelta: 0,
        intentEqual: true,
        primarySourceTypes: ['official_docs'],
        shadowCitationCount: 1,
        shadowSourceTypes: ['x_updates'],
        shadowTotalTokens: 20,
        sourceTypesEqual: false,
        totalTokenDelta: 10,
        totalTokens: 30,
      }),
    );
    expect(JSON.stringify(observer.mock.calls)).not.toContain('optimized secret answer');
    expect(JSON.stringify(observer.mock.calls)).not.toContain('legacy secret answer');
  });

  it('supports independent channel rollback', async () => {
    const optimized = runtime(response('optimized'));
    const legacy = runtime(response('legacy'));
    const config = loadAnswerQualityRolloutConfig({
      ANSWER_QUALITY_TELEGRAM_MODE: 'legacy',
      ANSWER_QUALITY_WEB_MODE: 'optimized',
    });
    const service = createAnswerQualityRolloutRuntime({ config, legacy, optimized });

    await expect(service.ask({ channel: 'telegram', message: '功能' })).resolves.toMatchObject({
      answer: 'legacy',
    });
    await expect(service.ask({ channel: 'web', message: '功能' })).resolves.toMatchObject({
      answer: 'optimized',
    });
  });

  it('streams only the primary variant while comparing the shadow answer', async () => {
    const optimized = runtime(response('primary stream answer', 'complete'));
    const legacy = runtime(response('shadow-only answer', 'partial'));
    const { records, tracer } = createInMemoryQualityTracer();
    const service = createAnswerQualityRolloutRuntime({
      config: loadAnswerQualityRolloutConfig({
        ANSWER_QUALITY_TELEGRAM_MODE: 'shadow',
        ANSWER_QUALITY_TELEGRAM_OPTIMIZED_PERCENTAGE: '100',
      }),
      legacy,
      optimized,
      tracer,
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.stream({
      channel: 'telegram',
      message: '支持哪些功能',
      requestId: 'stream-request',
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ delta: 'primary stream answer', type: 'answer_delta' });
    expect(JSON.stringify(events)).not.toContain('shadow-only answer');
    expect(legacy.ask).toHaveBeenCalledOnce();
    expect(records.at(-1)).toMatchObject({
      name: 'agent.answer_quality_shadow',
      outputs: {
        primaryAnswerStatus: 'complete',
        shadowAnswerStatus: 'partial',
      },
    });
    expect(JSON.stringify(records)).not.toContain('primary stream answer');
    expect(JSON.stringify(records)).not.toContain('shadow-only answer');
  });

  it('fails closed for invalid rollout configuration', () => {
    expect(() => loadAnswerQualityRolloutConfig({ ANSWER_QUALITY_WEB_MODE: 'maybe' })).toThrow(
      AnswerQualityRolloutConfigurationError,
    );
    expect(() =>
      loadAnswerQualityRolloutConfig({
        ANSWER_QUALITY_WEB_MODE: 'shadow',
        ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE: '101',
      }),
    ).toThrow(AnswerQualityRolloutConfigurationError);
  });

  it('does not fail a customer response when the observation sink is unavailable', async () => {
    const service = createAnswerQualityRolloutRuntime({
      config: loadAnswerQualityRolloutConfig({}),
      legacy: runtime(response('legacy')),
      observer: () => Promise.reject(new Error('metrics sink unavailable')),
      optimized: runtime(response('optimized')),
    });

    await expect(service.ask({ channel: 'web', message: '功能' })).resolves.toMatchObject({
      answer: 'optimized',
    });
  });
});

function response(answer: string, answerStatus: ChatResponse['answerStatus'] = 'complete') {
  return {
    answer,
    answerStatus,
    citations: [],
    confidence: 0.8,
    intent: 'product_qa' as const,
  };
}

function runtime(chatResponse: ChatResponse): CustomerAgentRuntime & {
  ask: ReturnType<typeof vi.fn<CustomerAgentRuntime['ask']>>;
} {
  return {
    ask: vi.fn(() => Promise.resolve(chatResponse)),
    async *stream() {
      yield { type: 'answer_delta' as const, delta: chatResponse.answer };
      yield {
        type: 'metadata' as const,
        ...(chatResponse.answerStatus === undefined
          ? {}
          : { answerStatus: chatResponse.answerStatus }),
        citations: chatResponse.citations,
        confidence: chatResponse.confidence,
        intent: chatResponse.intent,
      };
    },
  };
}
