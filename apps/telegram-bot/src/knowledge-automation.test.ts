import { describe, expect, it } from 'vitest';

import type { TelegramMessage } from './bot.js';
import {
  createLiveTelegramKnowledgeExport,
  createTelegramConversationBuffer,
} from './knowledge-automation.js';

describe('live Telegram knowledge capture', () => {
  it('converts a direct group reply into the bounded import shape', () => {
    expect(
      createLiveTelegramKnowledgeExport({
        chat: { id: -100123, type: 'supergroup' },
        date: 1_774_490_520,
        from: { id: 123 },
        message_id: 11,
        reply_to_message: {
          chat: { id: -100123, type: 'supergroup' },
          date: 1_774_490_400,
          from: { id: 456 },
          message_id: 10,
          text: 'XXYY 如何设置价格提醒？',
        },
        text: '在提醒设置中开启价格提醒，保存后生效。',
      }),
    ).toEqual({
      id: -100123,
      messages: [
        {
          date: '2026-03-26T02:00:00.000Z',
          from_id: 'user456',
          id: 10,
          text: 'XXYY 如何设置价格提醒？',
        },
        {
          date: '2026-03-26T02:02:00.000Z',
          from_id: 'user123',
          id: 11,
          reply_to_message_id: 10,
          text: '在提醒设置中开启价格提醒，保存后生效。',
        },
      ],
    });
  });

  it('rejects anonymous, bot-authored, and non-reply messages', () => {
    const base = {
      chat: { id: -100123, type: 'supergroup' as const },
      from: { id: 123 },
      message_id: 11,
      text: '回答',
    };

    expect(createLiveTelegramKnowledgeExport(base)).toBeUndefined();
    expect(
      createLiveTelegramKnowledgeExport({
        ...base,
        from: { id: 123, is_bot: true },
        reply_to_message: { chat: base.chat, message_id: 10, text: '问题' },
      }),
    ).toBeUndefined();
    expect(
      createLiveTelegramKnowledgeExport({
        ...base,
        reply_to_message: { chat: base.chat, message_id: 10, text: '问题' },
        sender_chat: { id: -100123 },
      }),
    ).toBeUndefined();
    expect(
      createLiveTelegramKnowledgeExport({
        ...base,
        reply_to_message: {
          chat: base.chat,
          from: { id: 999, is_bot: true },
          message_id: 10,
          text: 'Bot 生成的回答',
        },
      }),
    ).toBeUndefined();
  });

  it('reconstructs a bounded multi-turn administrator and user reply chain', () => {
    const chat = { id: -100123, type: 'supergroup' as const };
    const root: TelegramMessage = {
      chat,
      date: 1_774_490_400,
      from: { id: 456 },
      message_id: 10,
      text: 'XXYY 如何设置价格提醒？',
    };
    const firstAnswer: TelegramMessage = {
      chat,
      date: 1_774_490_460,
      from: { id: 123 },
      message_id: 11,
      reply_to_message: root,
      text: '先进入提醒设置。',
    };
    const firstAnswerReference: TelegramMessage = {
      chat,
      date: 1_774_490_460,
      from: { id: 123 },
      message_id: 11,
      text: '先进入提醒设置。',
    };
    const followUp: TelegramMessage = {
      chat,
      date: 1_774_490_500,
      from: { id: 456 },
      message_id: 12,
      reply_to_message: firstAnswerReference,
      text: '进入之后还需要做什么？',
    };
    const finalAnswer: TelegramMessage = {
      chat,
      date: 1_774_490_520,
      from: { id: 123 },
      message_id: 13,
      reply_to_message: followUp,
      text: '开启价格提醒并保存，保存后立即生效。',
    };
    const buffer = createTelegramConversationBuffer(4);
    const seenAt = new Date('2026-03-26T02:03:00.000Z');
    for (const message of [root, firstAnswer, followUp, finalAnswer]) {
      buffer.remember(message, seenAt);
    }

    const rawExport = createLiveTelegramKnowledgeExport(
      finalAnswer,
      buffer.getReplyChain(finalAnswer),
    );

    expect(rawExport).toMatchObject({
      id: -100123,
      messages: [
        { id: 10, text: root.text },
        { id: 11, reply_to_message_id: 10, text: firstAnswer.text },
        { id: 12, reply_to_message_id: 11, text: followUp.text },
        { id: 13, reply_to_message_id: 12, text: finalAnswer.text },
      ],
    });
  });

  it('limits retained reply context and tolerates cyclic external input', () => {
    const chat = { id: -100123, type: 'supergroup' as const };
    const root: TelegramMessage = {
      chat,
      from: { id: 456 },
      message_id: 1,
      text: '问题',
    };
    const answer: TelegramMessage = {
      chat,
      from: { id: 123 },
      message_id: 2,
      reply_to_message: root,
      text: '回答',
    };
    root.reply_to_message = answer;
    const buffer = createTelegramConversationBuffer(2);

    expect(() => buffer.remember(answer, new Date())).not.toThrow();
    expect(buffer.getReplyChain(answer)).toHaveLength(2);
  });
});
