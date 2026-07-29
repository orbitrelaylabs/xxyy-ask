import { describe, expect, it } from 'vitest';

import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';

import type { AnswerProvider } from './answer-provider.js';
import { createChatService } from './chat-service.js';
import { createFixtureIndex } from './test-fixtures.js';

describe('createChatService', () => {
  it('classifies, retrieves, and delegates grounded product questions to the answer provider', async () => {
    const calls: string[] = [];
    const answerProvider: AnswerProvider = {
      answer({ question, retrievedChunks }) {
        calls.push(question);
        const response: ChatResponse = {
          answer: '可以通过 Telegram 钱包监控页面设置提醒。',
          citations: retrievedChunks.map((chunk) => ({
            excerpt: chunk.text,
            file: 'docs/telegram.md',
            title: chunk.metadata.title,
          })),
          confidence: 0.88,
          intent: 'how_to',
        };
        return Promise.resolve(response);
      },
    };
    const service = createChatService({
      answerProvider,
      config: { topK: 1 },
      index: createFixtureIndex([
        {
          id: 'official_docs:telegram:chunk:0001',
          title: 'Telegram 钱包监控',
          sourceType: 'official_docs',
          file: '/docs/telegram.md',
          text: 'XXYY 支持通过 Telegram 设置钱包监控提醒。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'web',
      message: '如何设置 Telegram 钱包监控？',
      sessionId: 'session-1',
    });

    expect(response.intent).toBe('how_to');
    expect(response.answer).toContain('Telegram 钱包监控');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.file).toBe('docs/telegram.md');
    expect(calls).toEqual(['如何设置 Telegram 钱包监控？']);
  });

  it('does not retrieve factual answers for realtime account lookup requests', async () => {
    const service = createChatService({
      index: createFixtureIndex([
        {
          id: 'official_docs:wallet:chunk:0001',
          title: '钱包余额',
          sourceType: 'official_docs',
          text: '你的钱包余额是 100 SOL。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response.intent).toBe('realtime_account_query');
    expect(response.answer).not.toContain('100 SOL');
    expect(response.citations).toEqual([]);
  });

  it('returns a chain clarification for transaction questions without invoking product retrieval', async () => {
    const service = createChatService({
      answerProvider: {
        answer() {
          throw new Error('answer provider should not be called');
        },
      },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    const response = await service.ask({
      channel: 'web',
      message:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 这个交易是不是被夹了？',
    });

    expect(response.intent).toBe('onchain_transaction');
    expect(response.answer).toContain('公开 Explorer 交易链接');
    expect(response.citations).toEqual([]);
    expect(response.attachments).toBeUndefined();
  });

  it('uses an async retriever for grounded product questions', async () => {
    const retrievedQuestions: string[] = [];
    const answerProvider: AnswerProvider = {
      answer({ retrievedChunks }) {
        return Promise.resolve({
          answer: 'XXYY Pro 支持 Telegram 钱包监控。',
          citations: retrievedChunks.map((chunk) => ({
            excerpt: chunk.text,
            file: chunk.metadata.file,
            title: chunk.metadata.title,
          })),
          confidence: 0.9,
          intent: 'product_qa',
        });
      },
    };
    const service = createChatService({
      answerProvider,
      retriever: {
        retrieve(question) {
          retrievedQuestions.push(question);
          const fixtureEntry = createFixtureIndex([
            {
              id: 'official_docs:pro:chunk:0001',
              title: 'XXYY Pro 权益',
              sourceType: 'official_docs',
              file: 'docs/pro.md',
              text: 'XXYY Pro 支持 Telegram 钱包监控。',
            },
          ]).entries[0];
          if (fixtureEntry === undefined) {
            throw new Error('Expected fixture entry to exist');
          }

          return Promise.resolve([
            {
              ...fixtureEntry,
              lexicalScore: 1,
              rank: 1,
              score: 1,
              sourceBoost: 0.05,
              vectorScore: 1,
            },
          ]);
        },
      },
    });

    const response = await service.ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response.answer).toContain('XXYY Pro');
    expect(response.citations[0]?.file).toBe('docs/pro.md');
    expect(retrievedQuestions).toEqual(['XXYY Pro 有哪些权益？']);
  });

  it('streams grounded product questions through the answer provider', async () => {
    const service = createChatService({
      answerProvider: {
        answer() {
          throw new Error('answer should not be called when stream is implemented');
        },
        async *stream() {
          await Promise.resolve();
          yield { type: 'answer_delta', delta: 'streamed answer' };
          yield {
            type: 'metadata',
            citations: [],
            confidence: 0.91,
            intent: 'product_qa',
          };
        },
      },
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          text: 'XXYY Pro 支持更多提醒。',
        },
      ]),
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.stream({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'answer_delta', delta: 'streamed answer' },
      { type: 'metadata', citations: [], confidence: 0.91, intent: 'product_qa' },
    ]);
  });

  it('streams boundary responses without retrieval', async () => {
    const service = createChatService({
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.stream({
      channel: 'web',
      message: '帮我查一下钱包余额',
    })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: 'answer_delta',
    });
    expect(events.at(-1)).toMatchObject({
      citations: [],
      intent: 'realtime_account_query',
      type: 'metadata',
    });
  });

  it('does not call the async retriever for boundary questions', async () => {
    const service = createChatService({
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    const response = await service.ask({
      channel: 'web',
      message: '帮我查一下钱包余额',
    });

    expect(response.intent).toBe('realtime_account_query');
  });

  it('requires LLM configuration for grounded product questions when no provider is injected', async () => {
    const service = createChatService({
      config: {
        openAiModel: undefined,
      },
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          text: 'XXYY Pro 支持更多提醒。',
        },
      ]),
    });

    await expect(
      service.ask({
        channel: 'cli',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).rejects.toThrow('OPENAI_API_KEY is required');
  });

  it('still returns fixed boundary responses without LLM configuration', async () => {
    const service = createChatService({
      config: {
        openAiModel: undefined,
      },
      index: createFixtureIndex([]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response.intent).toBe('realtime_account_query');
    expect(response.citations).toEqual([]);
  });

  it('keeps investment boundary when a profit promise is mixed into a product operation question', async () => {
    const answerProvider: AnswerProvider = {
      answer() {
        throw new Error('Answer provider should not be called for investment advice');
      },
    };
    const service = createChatService({
      answerProvider,
      index: createFixtureIndex([
        {
          id: 'official_docs:swap:chunk:0001',
          title: 'Swap 交易',
          sourceType: 'official_docs',
          text: 'XXYY 支持一键买卖代币。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '如何在 XXYY 买入能保证盈利的 token？',
    });

    expect(response.intent).toBe('investment_advice');
    expect(response.answer).not.toContain('一键买卖代币');
    expect(response.citations).toEqual([]);
  });

  it('keeps business-action boundaries out of the legacy product answer path', async () => {
    const answerProvider: AnswerProvider = {
      answer() {
        throw new Error('Answer provider should not be called for business actions');
      },
    };
    const service = createChatService({
      answerProvider,
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro',
          sourceType: 'official_docs',
          text: 'XXYY Pro 有更多权益。',
        },
      ]),
    });

    const response = await service.ask({
      channel: 'cli',
      message: '帮我开通 XXYY Pro',
    });

    expect(response.intent).toBe('unknown');
    expect(response.answer).toContain('不能代你开通、取消、修改');
    expect(response.answer).toContain('退款、赔偿');
    expect(response.answer).not.toContain('更多权益');
    expect(response.citations).toEqual([]);
  });
});
