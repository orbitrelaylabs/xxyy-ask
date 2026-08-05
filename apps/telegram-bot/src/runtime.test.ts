import { describe, expect, it, vi } from 'vitest';

import {
  createPublicTransactionClientStub,
  type GetTransactionOutput,
} from '@orbitrelaylabs/xxyy-transaction-agent-kit/runtime';
import type { ChatRequest, ChatResponse } from '@xxyy/shared';
import {
  createInMemoryQualityTracer,
  loadRagConfig,
  type ChatService,
  type PgSupportOperationsStore,
  type PgDailyChatQuotaStore,
  type SupportConversationMessage,
} from '@xxyy/rag-core';

import {
  createTelegramChatRuntime,
  withLowEvidenceFeedback,
  withDailyTelegramChatQuota,
  withPersistentTelegramHistory,
} from './runtime.js';

describe('createTelegramChatRuntime', () => {
  it('injects the supplied tracer into the customer runtime', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const runtime = createTelegramChatRuntime(loadRagConfig({}), tracer);
    try {
      const response = await runtime.service.ask({
        channel: 'telegram',
        message: '帮我查一下钱包余额',
        requestId: 'telegram:1:1',
      });

      expect(response.agentRoute).toBe('boundary');
      expect(records.map((record) => record.name)).toEqual([
        'chat.request',
        'agent.classify',
        'agent.guard',
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('queries a public Explorer transaction through the Telegram grant', async () => {
    const transaction = publicTransactionOutput();
    const explorerUrl = transaction.explorerUrl!;
    const runtime = createTelegramChatRuntime(loadRagConfig({}), undefined, {
      publicTransactionClient: createPublicTransactionClientStub(async () => transaction),
    });

    try {
      await expect(
        runtime.service.ask({
          channel: 'telegram',
          message: explorerUrl,
          requestId: 'telegram:chain:1',
        }),
      ).resolves.toMatchObject({
        agentRoute: 'chain_answer',
        citations: [{ sourceUrl: explorerUrl }],
        intent: 'onchain_transaction',
      });
    } finally {
      await runtime.close();
    }
  });
});

function publicTransactionOutput(): GetTransactionOutput {
  const signature = '4'.repeat(88);
  return {
    analysis: {
      accountKeys: [],
      executionStatus: 'success',
      logCount: 0,
      nativeBalanceChanges: [],
      network: 'solana:mainnet',
      programIds: [],
      slot: '1',
      sources: [
        {
          id: 'solscan_browser',
          kind: 'explorer_browser',
          observedAt: '2026-08-04T00:00:00.000Z',
          payloadHash: `sha256:${'a'.repeat(64)}`,
          provenanceUrl: `https://solscan.io/tx/${signature}`,
        },
      ],
      tokenBalanceChanges: [],
      transactionId: signature,
    },
    diagnostics: [],
    explorerUrl: `https://solscan.io/tx/${signature}`,
    family: 'solana',
    network: 'solana:mainnet',
    status: 'partial',
    summary: 'Browser evidence.',
    transactionId: signature,
  };
}

describe('withPersistentTelegramHistory', () => {
  it('loads a bounded safe history and persists the completed exchange', async () => {
    const requestSeen: ChatRequest[] = [];
    const response: ChatResponse = {
      answer: '还支持钱包监控。',
      citations: [],
      confidence: 0.8,
      intent: 'product_qa',
    };
    const service: ChatService = {
      async ask(request) {
        requestSeen.push(request);
        return response;
      },
      async *stream() {
        throw new Error('not used');
      },
    };
    const appendMessage = vi.fn(() => Promise.resolve(createStoredMessage('assistant', 'saved')));
    const getRecentMessages = vi.fn(() =>
      Promise.resolve([
        createStoredMessage('user', '支持哪些功能？'),
        createStoredMessage('assistant', '支持交易和数据分析。'),
        createStoredMessage('system', 'internal'),
        createStoredMessage('support_agent', '还支持钱包管理。'),
      ]),
    );
    const store = {
      appendMessage,
      ensureConversation: vi.fn(() =>
        Promise.resolve({
          channel: 'telegram' as const,
          createdAt: '2026-07-30T00:00:00.000Z',
          externalSessionId: 'telegram:-100:topic:7:user:1',
          id: 'conversation-1',
          lastMessageAt: '2026-07-30T00:00:00.000Z',
          status: 'open' as const,
          updatedAt: '2026-07-30T00:00:00.000Z',
        }),
      ),
      getRecentMessages,
    } as unknown as PgSupportOperationsStore;
    const { records, tracer } = createInMemoryQualityTracer();
    const wrapped = withPersistentTelegramHistory(service, async () => store, tracer);

    await expect(
      wrapped.ask({
        channel: 'telegram',
        history: [
          { content: '支持交易和数据分析。', role: 'assistant' },
          { content: 'api key: sk-secret123', role: 'user' },
        ],
        message: '还有呢？',
        requestId: 'telegram:-100:2',
        sessionId: 'telegram:-100:topic:7:user:1',
        userId: 'telegram:1',
      }),
    ).resolves.toEqual(response);

    expect(getRecentMessages).toHaveBeenCalledWith('conversation-1', { limit: 12 });
    expect(requestSeen[0]?.history).toEqual([
      { content: '支持哪些功能？', role: 'user' },
      { content: '支持交易和数据分析。', role: 'assistant' },
      { content: '还支持钱包管理。', role: 'support_agent' },
      { content: 'api key: [sensitive_credential]', role: 'user' },
    ]);
    expect(appendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: '还有呢？',
        conversationId: 'conversation-1',
        role: 'user',
      }),
    );
    expect(appendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: '还支持钱包监控。',
        conversationId: 'conversation-1',
        role: 'assistant',
      }),
    );
    expect(records.map((record) => record.name)).toEqual([
      'telegram.history.load',
      'telegram.history.persist',
    ]);
  });

  it('does not persist an incomplete stream', async () => {
    const service: ChatService = {
      async ask() {
        throw new Error('not used');
      },
      async *stream() {
        yield { type: 'answer_delta', delta: 'partial' };
        throw new Error('stream failed');
      },
    };
    const appendMessage = vi.fn();
    const store = {
      appendMessage,
      ensureConversation: vi.fn(() =>
        Promise.resolve({
          channel: 'telegram' as const,
          createdAt: '2026-07-30T00:00:00.000Z',
          externalSessionId: 'telegram:1',
          id: 'conversation-1',
          lastMessageAt: '2026-07-30T00:00:00.000Z',
          status: 'open' as const,
          updatedAt: '2026-07-30T00:00:00.000Z',
        }),
      ),
      getRecentMessages: vi.fn(() => Promise.resolve([])),
    } as unknown as PgSupportOperationsStore;
    const wrapped = withPersistentTelegramHistory(service, async () => store);

    const consume = async () => {
      for await (const _event of wrapped.stream({
        channel: 'telegram',
        message: '支持哪些功能？',
        sessionId: 'telegram:1',
      })) {
        // Consume until the source fails.
      }
    };

    await expect(consume()).rejects.toThrow('stream failed');
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('keeps only the newest twelve sanitized history messages', async () => {
    const requestSeen: ChatRequest[] = [];
    const service: ChatService = {
      async ask(request) {
        requestSeen.push(request);
        return {
          answer: '回答',
          citations: [],
          confidence: 0.8,
          intent: 'product_qa',
        };
      },
      async *stream() {
        throw new Error('not used');
      },
    };
    const store = {
      appendMessage: vi.fn(() => Promise.resolve(createStoredMessage('assistant', 'saved'))),
      ensureConversation: vi.fn(() =>
        Promise.resolve({
          channel: 'telegram' as const,
          createdAt: '2026-07-30T00:00:00.000Z',
          externalSessionId: 'telegram:1',
          id: 'conversation-1',
          lastMessageAt: '2026-07-30T00:00:00.000Z',
          status: 'open' as const,
          updatedAt: '2026-07-30T00:00:00.000Z',
        }),
      ),
      getRecentMessages: vi.fn(() =>
        Promise.resolve(
          Array.from({ length: 20 }, (_, index) =>
            createStoredMessage(index % 2 === 0 ? 'user' : 'assistant', `history-${index}`),
          ),
        ),
      ),
    } as unknown as PgSupportOperationsStore;

    await withPersistentTelegramHistory(service, async () => store).ask({
      channel: 'telegram',
      message: '继续',
      sessionId: 'telegram:1',
    });

    expect(requestSeen[0]?.history).toHaveLength(12);
    expect(requestSeen[0]?.history?.at(0)?.content).toBe('history-8');
    expect(requestSeen[0]?.history?.at(-1)?.content).toBe('history-19');
  });
});

describe('withLowEvidenceFeedback', () => {
  it('records evidence conflicts as a distinct quality signal', async () => {
    const response: ChatResponse = {
      answer: '当前知识库存在同范围数值冲突。',
      answerStatus: 'conflict',
      citations: [
        {
          excerpt: '最多 2000 个。',
          file: 'docs/monitor.md',
          sourceType: 'official_docs',
          title: '钱包监控',
        },
      ],
      confidence: 0.2,
      intent: 'product_qa',
    };
    const recordFeedback = vi.fn(() => Promise.resolve());
    const service: ChatService = {
      async ask() {
        return response;
      },
      async *stream() {
        throw new Error('not used');
      },
    };

    await withLowEvidenceFeedback(service, recordFeedback).ask({
      channel: 'telegram',
      message: '钱包监控上限是多少？',
      sessionId: 'telegram:1',
    });

    expect(recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        citationCount: 1,
        comment: 'automatic_evidence_conflict',
        rating: 'negative',
      }),
    );
  });
});

describe('withDailyTelegramChatQuota', () => {
  it('returns a user-visible limit response without invoking the underlying service', async () => {
    const ask = vi.fn();
    const service: ChatService = {
      ask,
      async *stream() {
        throw new Error('not used');
      },
    };
    const consume = vi.fn(() =>
      Promise.resolve({
        allowed: false,
        limit: 10,
        quotaDate: '2026-08-04',
        remaining: 0,
        used: 10,
      }),
    );
    const store = { consume } as unknown as PgDailyChatQuotaStore;
    const response = await withDailyTelegramChatQuota(service, async () => store, {
      limit: 10,
      timeZone: 'Asia/Shanghai',
    }).ask({
      channel: 'telegram',
      message: '第十一次提问',
      sessionId: 'telegram:123',
      userId: 'telegram:456',
    });
    expect(response.answer).toContain('每天最多 10 次');
    expect(consume).toHaveBeenCalledWith({
      identity: 'telegram:telegram:456',
      limit: 10,
      timeZone: 'Asia/Shanghai',
    });
    expect(ask).not.toHaveBeenCalled();
  });
});

function createStoredMessage(
  role: SupportConversationMessage['role'],
  content: string,
): SupportConversationMessage {
  return {
    content,
    conversationId: 'conversation-1',
    createdAt: '2026-07-30T00:00:00.000Z',
    id: `${role}-${content}`,
    role,
  };
}
