import { describe, expect, it } from 'vitest';

import { createTelegramInboxKnowledgeExport } from './telegram-inbox.js';
import type { TelegramGroupMessageRecord } from './telegram-group-messages.js';

describe('Telegram knowledge inbox assembly', () => {
  it('merges consecutive messages from the same author into one answer turn', () => {
    const result = createTelegramInboxKnowledgeExport({
      chatId: '-100123',
      messages: [
        message({ authorUserId: '456', messageId: '10', text: 'XXYY 如何设置止盈止损？' }),
        message({
          authorUserId: '123',
          messageId: '11',
          sentAt: '2026-07-31T01:10:00.000Z',
          text: '先打开持仓页面。',
        }),
        message({
          authorUserId: '123',
          messageId: '12',
          sentAt: '2026-07-31T09:30:00.000Z',
          text: '再填写触发价格并保存。',
        }),
      ],
    });

    expect(result.rawExport.messages).toEqual([
      expect.objectContaining({ from_id: 'user456', id: '10' }),
      expect.objectContaining({
        from_id: 'user123',
        id: '11',
        text: '先打开持仓页面。\n再填写触发价格并保存。',
      }),
    ]);
    expect(result.messageIds).toEqual(['10', '11', '12']);
  });

  it('filters bot and anonymous sender-chat content before curation', () => {
    const anonymousSender = message({ messageId: '2', senderChatId: '-100123' });
    delete anonymousSender.authorUserId;
    const result = createTelegramInboxKnowledgeExport({
      chatId: '-100123',
      messages: [
        message({ authorIsBot: true, authorUserId: '99', messageId: '1' }),
        anonymousSender,
      ],
    });

    expect(result.rawExport.messages).toEqual([]);
  });
});

function message(overrides: Partial<TelegramGroupMessageRecord> = {}): TelegramGroupMessageRecord {
  return {
    authorIsBot: false,
    authorUserId: '123',
    capturedAt: '2026-07-31T01:00:00.000Z',
    chatId: '-100123',
    messageId: '1',
    sentAt: '2026-07-31T01:00:00.000Z',
    text: '消息',
    ...overrides,
  };
}
