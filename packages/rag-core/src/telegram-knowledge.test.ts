import { describe, expect, it } from 'vitest';

import {
  extractTelegramKnowledgeCandidates,
  readTelegramKnowledgeExport,
  reconstructTelegramConversationThreads,
} from './telegram-knowledge.js';
import type { TrustedAuthor } from './trusted-authors.js';

describe('Telegram knowledge normalization', () => {
  it('reconstructs reply components with bounded adjacent context', () => {
    const parsed = readTelegramKnowledgeExport({
      id: -100123,
      messages: [
        { from_id: 'user1', id: 1, text: '前一条上下文', type: 'message' },
        { from_id: 'user2', id: 2, text: 'XXYY 如何设置提醒？', type: 'message' },
        {
          from_id: 'user9',
          id: 3,
          reply_to_message_id: 2,
          text: '在设置页开启提醒。',
          type: 'message',
        },
        {
          from_id: 'user2',
          id: 4,
          reply_to_message_id: 3,
          text: '明白了',
          type: 'message',
        },
        { from_id: 'user5', id: 5, text: '后一条上下文', type: 'message' },
      ],
    });

    const threads = reconstructTelegramConversationThreads(parsed, 1);
    const replyThread = threads.find((thread) => thread.rootMessageId === '2');

    expect(replyThread).toMatchObject({
      contextMessageIds: ['1', '2', '3', '4', '5'],
      messageIds: ['2', '3', '4'],
      rootMessageId: '2',
    });
  });

  it('uses the author role valid at the answer timestamp', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          {
            date: '2026-07-15T01:00:00Z',
            from_id: 'user456',
            id: 10,
            text: 'XXYY 如何设置提醒？',
          },
          {
            date: '2026-07-15T01:02:00Z',
            from_id: 'user123',
            id: 11,
            reply_to_message_id: 10,
            text: '在设置页打开提醒开关，保存后即可生效。https://docs.xxyy.io/alerts',
          },
        ],
      },
      { trustedAuthors: [trustedAuthor()] },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      authorVerification: {
        role: 'knowledge_editor',
        source: 'manual',
        status: 'trusted_author',
        userId: '123',
        validFrom: '2026-07-01T00:00:00.000Z',
        validTo: '2026-08-01T00:00:00.000Z',
      },
      extractionMethod: 'deterministic_direct_reply',
      proposedModule: '操作指南',
      riskFlags: [],
    });
  });

  it('recognizes an adjacent administrator answer without requiring Telegram Reply', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          {
            date: '2026-07-15T01:00:00Z',
            from_id: 'user456',
            id: 10,
            text: 'XXYY 如何设置提醒？',
          },
          {
            date: '2026-07-15T01:02:00Z',
            from_id: 'user123',
            id: 11,
            text: '进入设置页打开提醒开关，保存后即可生效。',
          },
        ],
      },
      { trustedAuthors: [trustedAuthor()] },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      extractionMethod: 'deterministic_adjacent_admin_message',
      sourceAnswerMessageId: '11',
      sourceQuestionMessageId: '10',
    });
    expect(result.candidates[0]?.evidence).toContain('adjacent administrator message');
  });

  it('pairs adjacent administrator answers without a time limit', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          {
            date: '2026-07-15T01:00:00Z',
            from_id: 'user456',
            id: 10,
            text: 'XXYY 如何设置提醒？',
          },
          {
            date: '2026-07-16T08:30:00Z',
            from_id: 'user123',
            id: 11,
            text: '进入设置页打开提醒开关，保存后即可生效。',
          },
        ],
      },
      { trustedAuthors: [trustedAuthor()] },
    );

    expect(result.candidates[0]).toMatchObject({
      extractionMethod: 'deterministic_adjacent_admin_message',
      sourceAnswerMessageId: '11',
      sourceQuestionMessageId: '10',
    });
  });

  it('does not infer an administrator outside the recorded validity interval', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          { date: '2026-08-02T01:00:00Z', from_id: 'user456', id: 10, text: 'XXYY 支持吗？' },
          {
            date: '2026-08-02T01:02:00Z',
            from_id: 'user123',
            id: 11,
            reply_to_message_id: 10,
            text: '已经支持。',
          },
        ],
      },
      { trustedAuthors: [trustedAuthor()] },
    );

    expect(result.candidates).toEqual([]);
    expect(result.verifiedAuthorMessageCount).toBe(0);
    expect(result.unverifiedAuthorMessageCount).toBe(2);
  });

  it('marks Telegram API current roles as historically unverified', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          { date: '2026-06-01T01:00:00Z', from_id: 'user456', id: 10, text: 'XXYY 支持吗？' },
          {
            date: '2026-06-01T01:02:00Z',
            from_id: 'user123',
            id: 11,
            reply_to_message_id: 10,
            text: '已经支持这个产品功能。',
          },
        ],
      },
      { currentAdministratorUserIds: new Set(['123']) },
    );

    expect(result.candidates[0]).toMatchObject({
      authorVerification: { status: 'telegram_api_current' },
      riskFlags: ['historical_role_unverified', 'missing_official_source', 'short_answer'],
    });
  });

  it('treats a Telegram administrator lookup made at message time as current evidence', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          { date: '2026-07-24T01:00:00Z', from_id: 'user456', id: 10, text: 'XXYY 支持吗？' },
          {
            date: '2026-07-24T01:02:00Z',
            from_id: 'user123',
            id: 11,
            reply_to_message_id: 10,
            text: '已经支持这个产品功能。',
          },
        ],
      },
      {
        currentAdministratorUserIds: new Set(['123']),
        currentAdministratorVerifiedAt: '2026-07-24T01:03:00Z',
      },
    );

    expect(result.candidates[0]?.riskFlags).not.toContain('historical_role_unverified');
    expect(result.candidates[0]?.authorVerification).toMatchObject({
      status: 'telegram_api_current',
      verifiedAt: '2026-07-24T01:03:00.000Z',
    });
  });

  it('redacts sensitive content before returning an in-memory candidate', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          {
            date: '2026-07-15T01:00:00Z',
            from_id: 'user456',
            id: 10,
            text: 'XXYY 如何设置手机号 +86 138 0013 8000？',
          },
          {
            date: '2026-07-15T01:02:00Z',
            from_id: 'user123',
            id: 11,
            reply_to_message_id: 10,
            text: '联系 @support_admin 完成设置。',
          },
        ],
      },
      { trustedAuthors: [trustedAuthor()] },
    );

    expect(result.candidates[0]?.question).toContain('[phone]');
    expect(result.candidates[0]?.canonicalAnswer).toContain('[telegram_user]');
    expect(result.candidates[0]?.riskFlags).toContain('redacted_sensitive_data');
    expect(JSON.stringify(result.candidates)).not.toContain('138 0013 8000');
    expect(JSON.stringify(result.candidates)).not.toContain('@support_admin');
  });

  it('flags an account-specific answer even when the question is about a product feature', () => {
    const result = extractTelegramKnowledgeCandidates(
      {
        id: -100123,
        messages: [
          {
            date: '2026-07-15T01:00:00Z',
            from_id: 'user456',
            id: 10,
            text: 'XXYY 如何设置价格提醒？',
          },
          {
            date: '2026-07-15T01:02:00Z',
            from_id: 'user123',
            id: 11,
            reply_to_message_id: 10,
            text: '你的账户余额是 10 SOL，请先处理这个用户个案。',
          },
        ],
      },
      { trustedAuthors: [trustedAuthor()] },
    );

    expect(result.candidates[0]?.riskFlags).toContain('possible_user_specific_case');
    expect(result.candidates[0]?.qualityScore).toBeLessThan(0.7);
  });
});

function trustedAuthor(): TrustedAuthor {
  return {
    chatId: '-100123',
    createdAt: '2026-07-01T00:00:00.000Z',
    id: 'trusted_author_123',
    role: 'knowledge_editor',
    updatedAt: '2026-07-01T00:00:00.000Z',
    userId: '123',
    validFrom: '2026-07-01T00:00:00.000Z',
    validTo: '2026-08-01T00:00:00.000Z',
    verificationSource: 'manual',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    verifiedBy: 'operator:alice',
  };
}
