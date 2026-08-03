import { describe, expect, it, vi } from 'vitest';

import { UnverifiedTelegramKnowledgeAuthorError } from './knowledge-governance-service.js';
import type {
  PgTelegramGroupMessageStore,
  TelegramGroupMessageRecord,
} from './telegram-group-messages.js';
import { processTelegramKnowledgeInbox } from './telegram-inbox-processor.js';

const messages: TelegramGroupMessageRecord[] = [
  {
    authorIsBot: false,
    authorUserId: '100',
    capturedAt: '2026-08-03T01:00:00.000Z',
    chatId: '-100123',
    messageId: '10',
    sentAt: '2026-08-03T01:00:00.000Z',
    text: 'XXYY 支持哪些链？',
  },
  {
    authorIsBot: false,
    authorUserId: '200',
    capturedAt: '2026-08-03T01:01:00.000Z',
    chatId: '-100123',
    messageId: '11',
    replyToMessageId: '10',
    sentAt: '2026-08-03T01:01:00.000Z',
    text: '支持 BSC 和 Solana。',
  },
];

describe('processTelegramKnowledgeInbox', () => {
  it('creates pending candidates and marks the source messages processed', async () => {
    const markProcessed = vi.fn().mockResolvedValue(2);
    const importTelegram = vi.fn().mockResolvedValue(importResult());

    const result = await processTelegramKnowledgeInbox({
      chatId: '-100123',
      importTelegram,
      telegramMessages: messageStore({ markProcessed }),
    });

    expect(result).toMatchObject({ createdCount: 1, processedMessageCount: 2 });
    expect(importTelegram).toHaveBeenCalledWith(
      expect.objectContaining({ manualReviewRequired: true, runAutomation: false }),
    );
  });

  it('retains messages when no administrator author can be verified', async () => {
    const markProcessed = vi.fn();

    const result = await processTelegramKnowledgeInbox({
      chatId: '-100123',
      importTelegram: () => Promise.reject(new UnverifiedTelegramKnowledgeAuthorError()),
      telegramMessages: messageStore({ markProcessed }),
    });

    expect(result.retainedMessageCount).toBe(2);
    expect(result.unverifiedAuthorMessageCount).toBeGreaterThan(0);
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('propagates model failures so the durable worker can retry', async () => {
    await expect(
      processTelegramKnowledgeInbox({
        chatId: '-100123',
        importTelegram: () => Promise.reject(new Error('model unavailable')),
        telegramMessages: messageStore(),
      }),
    ).rejects.toThrow('model unavailable');
  });
});

function importResult() {
  return {
    agentCandidateCount: 1,
    agentRunStats: { attemptedThreadCount: 1, failedThreadCount: 0, proposedCandidateCount: 1 },
    adminReplyCount: 1,
    candidateCount: 1,
    created: [{ id: 'candidate-1' }],
    curationMode: 'auto' as const,
    deterministicCandidateCount: 0,
    duplicateCount: 0,
    messageCount: 2,
    rejectedAgentProposalCount: 0,
    runId: 'run-1',
    skippedBoundaryCount: 0,
    skippedMissingReplyCount: 0,
    threadCount: 1,
    unverifiedAuthorMessageCount: 0,
    verifiedAuthorMessageCount: 1,
  };
}

function messageStore(
  overrides: Partial<PgTelegramGroupMessageStore> = {},
): PgTelegramGroupMessageStore {
  return {
    capture: () => Promise.resolve(),
    countUnprocessed: () => Promise.resolve(messages.length),
    list: () => Promise.resolve(messages),
    listByIds: () => Promise.resolve([]),
    markProcessed: () => Promise.resolve(messages.length),
    markUnprocessed: () => Promise.resolve(0),
    migrate: () => Promise.resolve(),
    purgeOlderThan: () => Promise.resolve(0),
    ...overrides,
  };
}
