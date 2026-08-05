import { describe, expect, it, vi } from 'vitest';

import type { ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';

import {
  TelegramBotConfigurationError,
  createTelegramBot,
  formatTelegramKnowledgeLearningStatus,
  isGroupCustomerRequest,
  loadTelegramBotConfig,
  resolveTelegramAttachmentUrl,
  splitTelegramHtmlMessage,
  splitTelegramMessage,
  stripTelegramBotMention,
  type TelegramKnowledgeLearningStatus,
  type TelegramSendMessageInput,
} from './bot.js';

function createResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    answer: 'XXYY Pro 支持更多监控额度。',
    citations: [],
    confidence: 0.8,
    intent: 'product_qa',
    ...overrides,
  };
}

function createSendMessageMock(): ReturnType<
  typeof vi.fn<(input: TelegramSendMessageInput) => Promise<void>>
> {
  return vi.fn(() => Promise.resolve());
}

function createGroupResponsesEnabledConfig() {
  return loadTelegramBotConfig({
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_GROUP_RESPONSES_ENABLED: 'true',
  });
}

function createLearningStatus(
  overrides: Partial<TelegramKnowledgeLearningStatus> = {},
): TelegramKnowledgeLearningStatus {
  return {
    contextMessageLimit: 12,
    enabled: true,
    progress: {
      approvedCount: 1,
      candidateCount: 4,
      pendingCount: 0,
      publishedCount: 2,
      rejectedCount: 1,
      lastAnalyzedAt: '2026-07-27T09:10:00.000Z',
    },
    settingSource: 'chat_override',
    updatedAt: '2026-07-27T09:00:00.000Z',
    ...overrides,
  };
}

describe('loadTelegramBotConfig', () => {
  it('requires a bot token', () => {
    expect(() => loadTelegramBotConfig({})).toThrow(TelegramBotConfigurationError);
  });

  it('parses polling and public URL settings', () => {
    const config = loadTelegramBotConfig({
      TELEGRAM_AUTO_LEARNING_CONTEXT_MESSAGES: '18',
      TELEGRAM_AUTO_LEARNING_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_GROUP_RESPONSES_ENABLED: 'true',
      TELEGRAM_POLL_TIMEOUT_SECONDS: '12',
      TELEGRAM_PUBLIC_BASE_URL: 'https://ask.example.com/base/',
      TELEGRAM_UPDATES_LIMIT: '25',
    });

    expect(config.botToken).toBe('bot-token');
    expect(config.autoLearningContextMessages).toBe(18);
    expect(config.autoLearningDefaultEnabled).toBe(true);
    expect(config.groupResponsesEnabled).toBe(true);
    expect(config.pollTimeoutSeconds).toBe(12);
    expect(config.publicBaseUrl).toBe('https://ask.example.com/base/');
    expect(config.updatesLimit).toBe(25);
  });

  it('fails closed for an invalid automatic learning flag', () => {
    expect(() =>
      loadTelegramBotConfig({
        TELEGRAM_AUTO_LEARNING_ENABLED: 'sometimes',
        TELEGRAM_BOT_TOKEN: 'bot-token',
      }),
    ).toThrow('TELEGRAM_AUTO_LEARNING_ENABLED must be true or false');
  });

  it('disables group responses by default and validates the explicit override', () => {
    expect(loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }).groupResponsesEnabled).toBe(
      false,
    );
    expect(() =>
      loadTelegramBotConfig({
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_GROUP_RESPONSES_ENABLED: 'sometimes',
      }),
    ).toThrow('TELEGRAM_GROUP_RESPONSES_ENABLED must be true or false');
  });

  it('bounds automatic learning context between two and fifty messages', () => {
    expect(
      loadTelegramBotConfig({
        TELEGRAM_AUTO_LEARNING_CONTEXT_MESSAGES: '1',
        TELEGRAM_BOT_TOKEN: 'bot-token',
      }).autoLearningContextMessages,
    ).toBe(2);
    expect(
      loadTelegramBotConfig({
        TELEGRAM_AUTO_LEARNING_CONTEXT_MESSAGES: '500',
        TELEGRAM_BOT_TOKEN: 'bot-token',
      }).autoLearningContextMessages,
    ).toBe(50);
  });
});

describe('createTelegramBot', () => {
  it('registers group membership and message activity without invoking the chat model', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const observeMembership = vi.fn(() => Promise.resolve());
    const observeMessage = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage: createSendMessageMock(),
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
      groupRegistry: { observeMembership, observeMessage },
    });

    await bot.handleUpdate({
      my_chat_member: {
        chat: { id: -100123, title: 'XXYY Support', type: 'supergroup' },
        date: 1_775_001_600,
        new_chat_member: { status: 'member' },
      },
      update_id: 9,
    });
    await bot.handleUpdate({
      message: {
        chat: { id: -100123, title: 'XXYY Support', type: 'supergroup' },
        date: 1_775_001_660,
        from: { id: 456 },
        message_id: 1,
        text: '普通群消息',
      },
      update_id: 10,
    });

    expect(observeMembership).toHaveBeenCalledWith({
      chatId: '-100123',
      chatType: 'supergroup',
      membershipStatus: 'active',
      observedAt: '2026-04-01T00:00:00.000Z',
      title: 'XXYY Support',
    });
    expect(observeMessage).toHaveBeenCalledWith({
      chatId: '-100123',
      chatType: 'supergroup',
      observedAt: '2026-04-01T00:01:00.000Z',
      title: 'XXYY Support',
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it('marks a group inactive when Telegram reports that the bot left', async () => {
    const observeMembership = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage: createSendMessageMock(),
        sendPhoto: vi.fn(),
      },
      chatService: { ask: vi.fn(() => Promise.resolve(createResponse())) },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
      groupRegistry: { observeMembership, observeMessage: vi.fn(() => Promise.resolve()) },
    });

    await bot.handleUpdate({
      my_chat_member: {
        chat: { id: -456, title: 'Former group', type: 'group' },
        date: 1_775_001_600,
        new_chat_member: { status: 'left' },
      },
      update_id: 11,
    });

    expect(observeMembership).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '-456', membershipStatus: 'left' }),
    );
  });

  it('shows automatic knowledge refresh status without calling the chat model', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
      getKnowledgeRefreshStatus: () =>
        Promise.resolve({
          enabled: true,
          lastRun: {
            finishedAt: '2026-07-27T06:48:33.456Z',
            mode: 'incremental',
            status: 'succeeded',
          },
          schedule: {
            fullMode: 'manual',
            incrementalDailyAt: '08:00',
            timeZone: 'Asia/Shanghai',
          },
          state: 'healthy',
        }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        message_id: 1,
        text: '/status@xxyy_ask_bot',
      },
      update_id: 10,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: 123,
      replyToMessageId: 1,
      text: expect.stringContaining('知识库自动更新：✅ 已开启，运行正常'),
    });
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('增量更新：每日 08:00');
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('计划时区：Asia/Shanghai');
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('全量更新：仅手动执行');
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('最近结果：成功（增量）');
  });

  it('passes text messages to chat with telegram channel and replies in the same chat', async () => {
    const ask = vi.fn(() =>
      Promise.resolve(
        createResponse({
          answer: '**XXYY Pro** 支持更多监控额度。',
        }),
      ),
    );
    const sendMessage = createSendMessageMock();
    const sendChatAction = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendChatAction,
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        from: { id: 456 },
        message_id: 1,
        text: 'XXYY Pro 有哪些权益？',
      },
      update_id: 10,
    });

    expect(ask).toHaveBeenCalledWith({
      channel: 'telegram',
      message: 'XXYY Pro 有哪些权益？',
      requestId: 'telegram:123:1',
      sessionId: 'telegram:123',
      userId: 'telegram:456',
    });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: 123,
      parseMode: 'HTML',
      replyToMessageId: 1,
      text: '<b>XXYY Pro</b> 支持更多监控额度。',
    });
    expect(sendChatAction).toHaveBeenCalledWith({
      action: 'typing',
      chatId: 123,
    });
  });

  it('silently archives group replies without running real-time knowledge governance', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const captureReply = vi.fn(() => Promise.resolve(true));
    const capture = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
      groupMessageArchive: { capture },
      knowledgeAutomation: {
        captureReply,
        getLearningStatus: vi.fn(() => Promise.resolve(createLearningStatus())),
        setLearningEnabled: vi.fn(),
      },
    });
    const message = {
      chat: { id: -100123, type: 'supergroup' as const },
      date: 1_774_490_520,
      from: { id: 123 },
      message_id: 11,
      reply_to_message: {
        chat: { id: -100123, type: 'supergroup' as const },
        date: 1_774_490_400,
        from: { id: 456 },
        message_id: 10,
        text: 'XXYY 如何设置价格提醒？',
      },
      text: '在提醒设置中开启价格提醒，保存后生效。',
    };

    await bot.handleUpdate({ message, update_id: 10 });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: '11', replyToMessageId: '10' }),
    );
    expect(captureReply).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('updates the local inbox for edited group replies without real-time curation', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const captureReply = vi.fn(() => Promise.resolve(false));
    const capture = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
      groupMessageArchive: { capture },
      knowledgeAutomation: {
        captureReply,
        getLearningStatus: vi.fn(() => Promise.resolve(createLearningStatus())),
        setLearningEnabled: vi.fn(),
      },
    });
    const editedMessage = {
      chat: { id: -100123, type: 'supergroup' as const },
      from: { id: 123 },
      message_id: 11,
      reply_to_message: {
        chat: { id: -100123, type: 'supergroup' as const },
        from: { id: 456 },
        message_id: 10,
        text: 'XXYY 如何设置价格提醒？',
      },
      text: '编辑后的管理员答案。',
    };

    await bot.handleUpdate({ edited_message: editedMessage, update_id: 11 });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: '11', text: '编辑后的管理员答案。' }),
    );
    expect(captureReply).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('archives ordinary group messages without answering or curating them', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const captureReply = vi.fn(() => Promise.resolve(false));
    const capture = vi.fn(() => Promise.resolve());
    const getMe = vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' }));
    const bot = createTelegramBot({
      api: {
        getMe,
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
      groupMessageArchive: { capture },
      knowledgeAutomation: {
        captureReply,
        getLearningStatus: vi.fn(),
        setLearningEnabled: vi.fn(),
      },
    });
    const message = {
      chat: { id: -100123, type: 'supergroup' as const },
      from: { id: 456 },
      message_id: 30,
      text: '大家今天使用 XXYY 感觉怎么样？',
    };

    await bot.handleUpdate({ message, update_id: 30 });

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: '30', text: message.text }),
    );
    expect(captureReply).not.toHaveBeenCalled();
    expect(getMe).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps group mentions and commands silent while preserving read-only observation', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const sendChatAction = vi.fn(() => Promise.resolve());
    const sendPhoto = vi.fn(() => Promise.resolve());
    const captureReply = vi.fn(() => Promise.resolve(false));
    const capture = vi.fn(() => Promise.resolve());
    const getMe = vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' }));
    const bot = createTelegramBot({
      api: {
        getMe,
        getUpdates: vi.fn(),
        sendChatAction,
        sendMessage,
        sendPhoto,
      },
      chatService: { ask },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
      groupMessageArchive: { capture },
      knowledgeAutomation: {
        captureReply,
        getLearningStatus: vi.fn(),
        setLearningEnabled: vi.fn(),
      },
    });
    const mentionedMessage = {
      chat: { id: -100123, type: 'supergroup' as const },
      from: { id: 456 },
      message_id: 31,
      text: '@xxyy_ask_bot XXYY Pro 有哪些权益？',
    };

    await bot.handleUpdate({ message: mentionedMessage, update_id: 31 });
    await bot.handleUpdate({
      message: {
        chat: mentionedMessage.chat,
        from: { id: 456 },
        message_id: 32,
        text: '/status@xxyy_ask_bot',
      },
      update_id: 32,
    });

    expect(capture).toHaveBeenCalledTimes(2);
    expect(captureReply).not.toHaveBeenCalled();
    expect(getMe).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(sendChatAction).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendPhoto).not.toHaveBeenCalled();
  });

  it('answers an explicit group mention and removes its own username from the question', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: {
        getMe: vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' })),
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
      knowledgeAutomation: {
        captureReply: vi.fn(() => Promise.resolve(false)),
        getLearningStatus: vi.fn(),
        setLearningEnabled: vi.fn(),
      },
    });

    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 456 },
        message_id: 31,
        text: '@XXYY_Ask_Bot XXYY Pro 有哪些权益？',
      },
      update_id: 31,
    });

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'XXYY Pro 有哪些权益？',
        requestId: 'telegram:-100123:31',
        sessionId: 'telegram:-100123:topic:main:user:456',
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: -100123,
        replyToMessageId: 31,
      }),
    );
  });

  it('answers a direct reply to this bot but ignores a reply to another bot', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: {
        getMe: vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' })),
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
      knowledgeAutomation: {
        captureReply: vi.fn(() => Promise.resolve(false)),
        getLearningStatus: vi.fn(),
        setLearningEnabled: vi.fn(),
      },
    });

    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'group' },
        from: { id: 456 },
        message_id: 32,
        reply_to_message: {
          chat: { id: -100123, type: 'group' },
          from: { id: 999, is_bot: true },
          message_id: 20,
          text: '上一次回答',
        },
        text: '还支持哪些功能？',
      },
      update_id: 32,
    });
    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'group' },
        from: { id: 456 },
        message_id: 33,
        reply_to_message: {
          chat: { id: -100123, type: 'group' },
          from: { id: 888, is_bot: true },
          message_id: 21,
          text: '其他 Bot 的回答',
        },
        text: '继续说说',
      },
      update_id: 33,
    });

    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ message: '还支持哪些功能？' }));
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('isolates group history sessions by topic and user', async () => {
    const ask = vi.fn((_request: ChatRequest) => Promise.resolve(createResponse()));
    const bot = createTelegramBot({
      api: {
        getMe: vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' })),
        getUpdates: vi.fn(),
        sendMessage: createSendMessageMock(),
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 456 },
        message_id: 34,
        message_thread_id: 7,
        text: '@xxyy_ask_bot 支持哪些功能？',
      },
      update_id: 34,
    });
    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 789 },
        message_id: 35,
        message_thread_id: 7,
        text: '@xxyy_ask_bot 支持哪些功能？',
      },
      update_id: 35,
    });
    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 456 },
        message_id: 36,
        message_thread_id: 8,
        text: '@xxyy_ask_bot 支持哪些功能？',
      },
      update_id: 36,
    });

    expect(ask.mock.calls.map(([request]) => request.sessionId)).toEqual([
      'telegram:-100123:topic:7:user:456',
      'telegram:-100123:topic:7:user:789',
      'telegram:-100123:topic:8:user:456',
    ]);
  });

  it('adds a bounded same-user reply chain to the request history', async () => {
    const ask = vi.fn((_request: ChatRequest) => Promise.resolve(createResponse()));
    const bot = createTelegramBot({
      api: {
        getMe: vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' })),
        getUpdates: vi.fn(),
        sendMessage: createSendMessageMock(),
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
    });
    const originalQuestion = {
      chat: { id: -100123, type: 'supergroup' as const },
      from: { id: 456 },
      message_id: 40,
      text: 'XXYY Pro 有哪些权益？api key: sk-sensitive123',
    };
    const botAnswer = {
      chat: originalQuestion.chat,
      from: { id: 999, is_bot: true },
      message_id: 41,
      reply_to_message: originalQuestion,
      text: 'XXYY Pro 提供进阶权益。',
    };

    await bot.handleUpdate({
      message: {
        chat: originalQuestion.chat,
        from: { id: 456 },
        message_id: 42,
        reply_to_message: botAnswer,
        text: '那免费版呢？',
      },
      update_id: 42,
    });

    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [
          {
            content: 'XXYY Pro 有哪些权益？api key: [sensitive_credential]',
            role: 'user',
          },
          { content: 'XXYY Pro 提供进阶权益。', role: 'assistant' },
        ],
        sessionId: 'telegram:-100123:topic:main:user:456',
      }),
    );
  });

  it('does not import another group member reply chain into the current user history', async () => {
    const ask = vi.fn((_request: ChatRequest) => Promise.resolve(createResponse()));
    const bot = createTelegramBot({
      api: {
        getMe: vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' })),
        getUpdates: vi.fn(),
        sendMessage: createSendMessageMock(),
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
    });
    const otherUserQuestion = {
      chat: { id: -100123, type: 'supergroup' as const },
      from: { id: 456 },
      message_id: 43,
      text: 'XXYY Pro 有哪些权益？',
    };

    await bot.handleUpdate({
      message: {
        chat: otherUserQuestion.chat,
        from: { id: 789 },
        message_id: 45,
        reply_to_message: {
          chat: otherUserQuestion.chat,
          from: { id: 999, is_bot: true },
          message_id: 44,
          reply_to_message: otherUserQuestion,
          text: 'XXYY Pro 提供进阶权益。',
        },
        text: '那免费版呢？',
      },
      update_id: 45,
    });

    expect(ask).toHaveBeenCalledWith(
      expect.not.objectContaining({
        history: expect.anything(),
      }),
    );
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'telegram:-100123:topic:main:user:789',
      }),
    );
  });

  it('does not answer an edited customer message a second time', async () => {
    const ask = vi.fn((_request: ChatRequest) => Promise.resolve(createResponse()));
    const getMe = vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' }));
    const bot = createTelegramBot({
      api: {
        getMe,
        getUpdates: vi.fn(),
        sendMessage: createSendMessageMock(),
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
    });

    await bot.handleUpdate({
      edited_message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 456 },
        message_id: 46,
        text: '@xxyy_ask_bot 支持哪些功能？',
      },
      update_id: 46,
    });

    expect(ask).not.toHaveBeenCalled();
  });

  it('ignores commands addressed to another bot in a group', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: {
        getMe: vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' })),
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 456 },
        message_id: 34,
        text: '/help@another_bot',
      },
      update_id: 34,
    });
    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 456 },
        message_id: 35,
        text: '/help@XXYY_ASK_BOT',
      },
      update_id: 35,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: -100123, replyToMessageId: 35 }),
    );
  });

  it('keeps ordinary group media silent but explains unsupported media replied to the bot', async () => {
    const sendMessage = createSendMessageMock();
    const captureReply = vi.fn(() => Promise.resolve(false));
    const capture = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getMe: vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' })),
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask: vi.fn(() => Promise.resolve(createResponse())) },
      config: createGroupResponsesEnabledConfig(),
      groupMessageArchive: { capture },
      knowledgeAutomation: {
        captureReply,
        getLearningStatus: vi.fn(),
        setLearningEnabled: vi.fn(),
      },
    });

    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'group' },
        from: { id: 456 },
        message_id: 36,
      },
      update_id: 36,
    });
    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'group' },
        from: { id: 456 },
        message_id: 37,
        reply_to_message: {
          chat: { id: -100123, type: 'group' },
          from: { id: 999, is_bot: true },
          message_id: 25,
          text: '请继续提问',
        },
      },
      update_id: 37,
    });

    expect(capture).not.toHaveBeenCalled();
    expect(captureReply).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -100123,
      replyToMessageId: 37,
      text: '目前只支持文本消息，请直接发送具体的 XXYY 产品问题。',
    });
  });

  it('fails closed on a bot identity error and retries on the next group request', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const getMe = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ id: 999, username: 'xxyy_ask_bot' });
    const logger = { error: vi.fn(), info: vi.fn() };
    const bot = createTelegramBot({
      api: {
        getMe,
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
      logger,
    });

    for (const messageId of [38, 39]) {
      await bot.handleUpdate({
        message: {
          chat: { id: -100123, type: 'supergroup' },
          from: { id: 456 },
          message_id: messageId,
          text: '@xxyy_ask_bot XXYY Pro 有哪些权益？',
        },
        update_id: messageId,
      });
    }

    expect(getMe).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      'Telegram bot identity lookup failed; group replies remain disabled.',
    );
    expect(ask).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('shows group automatic learning status without calling the chat model', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const getLearningStatus = vi.fn(() => Promise.resolve(createLearningStatus()));
    const bot = createTelegramBot({
      api: {
        getMe: vi.fn(() => Promise.resolve({ id: 999, username: 'xxyy_ask_bot' })),
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
      knowledgeAutomation: {
        captureReply: vi.fn(),
        getLearningStatus,
        setLearningEnabled: vi.fn(),
      },
    });

    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 456 },
        message_id: 20,
        text: '/learning@xxyy_ask_bot',
      },
      update_id: 20,
    });

    expect(getLearningStatus).toHaveBeenCalledWith(-100123);
    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -100123,
      replyToMessageId: 20,
      text: expect.stringContaining('对话自动学习：✅ 已开启'),
    });
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('候选 4，已发布 2');
  });

  it('lets a verified group administrator enable automatic learning', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const setLearningEnabled = vi.fn(() =>
      Promise.resolve({
        authorized: true as const,
        changed: true,
        status: createLearningStatus(),
      }),
    );
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
      knowledgeAutomation: {
        captureReply: vi.fn(),
        getLearningStatus: vi.fn(),
        setLearningEnabled,
      },
    });

    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 456 },
        message_id: 21,
        text: '/learning_on',
      },
      update_id: 21,
    });

    expect(setLearningEnabled).toHaveBeenCalledWith({
      chatId: -100123,
      enabled: true,
      requestedByUserId: 456,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls[0]?.[0].text).toContain('设置已更新');
  });

  it('refuses an automatic learning change when the sender is not an administrator', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const sendMessage = createSendMessageMock();
    const setLearningEnabled = vi.fn(() =>
      Promise.resolve({
        authorized: false as const,
        reason: 'not_administrator' as const,
      }),
    );
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: { ask },
      config: createGroupResponsesEnabledConfig(),
      knowledgeAutomation: {
        captureReply: vi.fn(),
        getLearningStatus: vi.fn(),
        setLearningEnabled,
      },
    });

    await bot.handleUpdate({
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 789 },
        message_id: 22,
        text: '/learning_off',
      },
      update_id: 22,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: -100123,
      replyToMessageId: 22,
      text: '只有当前群管理员可以开启或关闭自动学习。',
    });
  });

  it('streams answer deltas through Telegram message drafts before sending the final reply', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const stream = vi.fn(() =>
      streamEvents([
        { type: 'status', phase: 'planning', message: '正在分析问题…' },
        { type: 'status', phase: 'retrieving', message: '正在检索知识库…' },
        { type: 'answer_delta', delta: 'A'.repeat(90) },
        { type: 'answer_delta', delta: 'B'.repeat(90) },
        {
          type: 'metadata',
          agentRoute: 'product_answer',
          citations: [],
          confidence: 0.8,
          intent: 'product_qa',
        },
      ]),
    );
    const sendMessage = createSendMessageMock();
    const sendMessageDraft = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendMessageDraft,
        sendPhoto: vi.fn(),
      },
      chatService: { ask, stream },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123, type: 'private' },
        from: { id: 456 },
        message_id: 1,
        text: 'XXYY Pro 有哪些权益？',
      },
      update_id: 10,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledWith({
      channel: 'telegram',
      message: 'XXYY Pro 有哪些权益？',
      requestId: 'telegram:123:1',
      sessionId: 'telegram:123',
      userId: 'telegram:456',
    });
    expect(sendMessageDraft).toHaveBeenNthCalledWith(1, {
      chatId: 123,
      draftId: 10,
      text: '⏳ 正在分析问题…',
    });
    expect(sendMessageDraft).toHaveBeenNthCalledWith(2, {
      chatId: 123,
      draftId: 10,
      text: '⏳ 正在检索知识库…',
    });
    expect(sendMessageDraft).toHaveBeenNthCalledWith(3, {
      chatId: 123,
      draftId: 10,
      text: 'A'.repeat(90),
    });
    expect(sendMessageDraft).toHaveBeenNthCalledWith(4, {
      chatId: 123,
      draftId: 10,
      text: `${'A'.repeat(90)}${'B'.repeat(90)}`,
    });
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: 123,
      parseMode: 'HTML',
      replyToMessageId: 1,
      text: `${'A'.repeat(90)}${'B'.repeat(90)}`,
    });
  });

  it('keeps streaming final delivery when Telegram draft updates fail', async () => {
    const ask = vi.fn(() => Promise.resolve(createResponse()));
    const stream = vi.fn(() =>
      streamEvents([
        { type: 'answer_delta', delta: 'partial answer' },
        {
          type: 'metadata',
          citations: [],
          confidence: 0.7,
          intent: 'product_qa',
        },
      ]),
    );
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendMessageDraft: vi.fn(() => Promise.reject(new Error('draft unsupported'))),
        sendPhoto: vi.fn(),
      },
      chatService: { ask, stream },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123, type: 'private' },
        from: { id: 456 },
        message_id: 1,
        text: 'XXYY Pro 有哪些权益？',
      },
      update_id: 10,
    });

    expect(ask).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: 123,
      parseMode: 'HTML',
      replyToMessageId: 1,
      text: 'partial answer',
    });
  });

  it('sends image attachments as Telegram photos when a public URL is available', async () => {
    const ask = vi.fn(() =>
      Promise.resolve(
        createResponse({
          answer: '这个产品功能截图如下。',
          attachments: [
            {
              kind: 'image',
              mediaType: 'image/png',
              title: '产品功能截图',
              url: '/assets/xxyy-feature/example.png',
            },
          ],
          intent: 'product_qa',
        }),
      ),
    );
    const sendPhoto = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage: vi.fn(() => Promise.resolve()),
        sendPhoto,
      },
      chatService: { ask },
      config: loadTelegramBotConfig({
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_PUBLIC_BASE_URL: 'https://ask.example.com',
      }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        from: { id: 456 },
        message_id: 1,
        text: '给我看产品功能截图',
      },
      update_id: 10,
    });

    expect(sendPhoto).toHaveBeenCalledWith({
      caption: '产品功能截图',
      chatId: 123,
      photo: 'https://ask.example.com/assets/xxyy-feature/example.png',
      replyToMessageId: 1,
    });
  });

  it('always returns required chain evidence screenshots even when the question does not ask for an image', async () => {
    const sendPhoto = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage: createSendMessageMock(),
        sendPhoto,
      },
      chatService: {
        ask: vi.fn(() =>
          Promise.resolve(
            createResponse({
              agentRoute: 'chain_answer',
              answer: '池子判断：small。Sandwich 判断：likely。已附上 XXYY 截图。',
              attachments: [
                {
                  delivery: 'required',
                  kind: 'image',
                  mediaType: 'image/png',
                  title: 'XXYY 成交查证截图',
                  url: `/xxyy-evidence/${'a'.repeat(64)}.png`,
                },
              ],
              intent: 'onchain_transaction',
            }),
          ),
        ),
      },
      config: loadTelegramBotConfig({
        TELEGRAM_BOT_TOKEN: 'bot-token',
        XXYY_SCREENSHOT_DIRECTORY: '/var/lib/xxyy-evidence',
      }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        from: { id: 456 },
        message_id: 1,
        text: '这笔交易是不是小池子，是否被夹？0xabc',
      },
      update_id: 10,
    });

    expect(sendPhoto).toHaveBeenCalledWith({
      caption: 'XXYY 成交查证截图',
      chatId: 123,
      photo: {
        filePath: `/var/lib/xxyy-evidence/${'a'.repeat(64)}.png`,
        filename: `${'a'.repeat(64)}.png`,
        mediaType: 'image/png',
      },
      replyToMessageId: 1,
    });
  });

  it('does not send promotional attachments for a factual product question', async () => {
    const sendMessage = createSendMessageMock();
    const sendPhoto = vi.fn(() => Promise.resolve());
    const sendVideo = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto,
        sendVideo,
      },
      chatService: {
        ask: vi.fn(() =>
          Promise.resolve(
            createResponse({
              answer: '当前知识库没有明确说明返佣的具体到账时间。',
              attachments: [
                {
                  kind: 'image',
                  mediaType: 'image/jpeg',
                  title: '@useXXYYio 更新 1997871585991229871 图片 1',
                  url: 'https://pbs.twimg.com/media/rebate.jpg',
                },
                {
                  kind: 'video',
                  mediaType: 'text/html',
                  title: '@useXXYYio 更新 2049204239633903983 视频 1',
                  url: 'https://x.com/useXXYYio/status/2049204239633903983/video/1',
                },
              ],
            }),
          ),
        ),
      },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        message_id: 1,
        text: 'XXYY 返佣到账时间是什么时候？',
      },
      update_id: 10,
    });

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: 123,
      parseMode: 'HTML',
      replyToMessageId: 1,
      text: '当前知识库没有明确说明返佣的具体到账时间。',
    });
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(sendVideo).not.toHaveBeenCalled();
  });

  it('sends local MP4 attachments through Telegram sendVideo', async () => {
    const sendVideo = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage: createSendMessageMock(),
        sendPhoto: vi.fn(),
        sendVideo,
      },
      chatService: {
        ask: vi.fn(() =>
          Promise.resolve(
            createResponse({
              attachments: [
                {
                  kind: 'video',
                  mediaType: 'video/mp4',
                  title: '添加到桌面演示',
                  url: '/assets/xxyy-add-to-home.mp4',
                },
              ],
            }),
          ),
        ),
      },
      config: loadTelegramBotConfig({
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_PUBLIC_BASE_URL: 'https://ask.example.com',
      }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        message_id: 1,
        text: '有添加到桌面的演示吗？',
      },
      update_id: 10,
    });

    expect(sendVideo).toHaveBeenCalledWith({
      caption: '添加到桌面演示',
      chatId: 123,
      replyToMessageId: 1,
      video: 'https://ask.example.com/assets/xxyy-add-to-home.mp4',
    });
  });

  it('returns external video links in the Telegram message', async () => {
    const sendMessage = createSendMessageMock();
    const sendVideo = vi.fn(() => Promise.resolve());
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
        sendVideo,
      },
      chatService: {
        ask: vi.fn(() =>
          Promise.resolve(
            createResponse({
              answer: '这是官方更新演示。',
              attachments: [
                {
                  kind: 'video',
                  mediaType: 'text/html',
                  title: '官方 X 演示视频',
                  url: 'https://x.com/useXXYYio/status/1/video/1',
                },
              ],
            }),
          ),
        ),
      },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        message_id: 1,
        text: '官方更新视频在哪里？',
      },
      update_id: 10,
    });

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: 123,
      parseMode: 'HTML',
      replyToMessageId: 1,
      text: '这是官方更新演示。\n视频：官方 X 演示视频 https://x.com/useXXYYio/status/1/video/1',
    });
    expect(sendVideo).not.toHaveBeenCalled();
  });

  it('formats citations for Telegram HTML messages', async () => {
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: {
        getUpdates: vi.fn(),
        sendMessage,
        sendPhoto: vi.fn(),
      },
      chatService: {
        ask: vi.fn(() =>
          Promise.resolve(
            createResponse({
              answer: 'XXYY 支持跟单。',
              citations: [
                {
                  excerpt: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
                  file: 'docs/product-features/xxyy-x-updates.md',
                  title: 'XXYY X 历史推文产品更新汇总',
                },
              ],
            }),
          ),
        ),
      },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.handleUpdate({
      message: {
        chat: { id: 123 },
        from: { id: 456 },
        message_id: 1,
        text: 'xxyy支持跟单么',
      },
      update_id: 10,
    });

    expect(sendMessage).toHaveBeenCalledWith({
      chatId: 123,
      parseMode: 'HTML',
      replyToMessageId: 1,
      text: ['XXYY 支持跟单。', '', '<b>来源</b>', '1. <b>XXYY X 历史推文产品更新汇总</b>'].join(
        '\n',
      ),
    });
  });

  it('advances the polling offset after handling updates', async () => {
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([
        {
          message: {
            chat: { id: 123 },
            from: { id: 456 },
            message_id: 1,
            text: '/help',
          },
          update_id: 41,
        },
      ])
      .mockResolvedValueOnce([]);
    const bot = createTelegramBot({
      api: {
        getUpdates,
        sendMessage: vi.fn(() => Promise.resolve()),
        sendPhoto: vi.fn(),
      },
      chatService: { ask: vi.fn(() => Promise.resolve(createResponse())) },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.pollOnce();
    await bot.pollOnce();

    expect(getUpdates).toHaveBeenNthCalledWith(1, {
      limit: 100,
      offset: undefined,
      timeout: 30,
    });
    expect(getUpdates).toHaveBeenNthCalledWith(2, {
      limit: 100,
      offset: 42,
      timeout: 30,
    });
  });

  it('logs and skips a poison update without blocking later updates', async () => {
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([
        {
          message: { chat: { id: 123 }, message_id: 1, text: '/help' },
          update_id: 41,
        },
        {
          message: { chat: { id: 123 }, message_id: 2, text: '/help' },
          update_id: 42,
        },
      ])
      .mockResolvedValueOnce([]);
    const sendMessage = createSendMessageMock()
      .mockRejectedValueOnce(new Error('permanent send failure'))
      .mockResolvedValueOnce();
    const logger = {
      error: vi.fn(),
      info: vi.fn(),
    };
    const bot = createTelegramBot({
      api: { getUpdates, sendMessage, sendPhoto: vi.fn() },
      chatService: { ask: vi.fn(() => Promise.resolve(createResponse())) },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
      logger,
    });

    await bot.pollOnce();
    await bot.pollOnce();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'Telegram update 41 failed.',
      expect.objectContaining({ message: 'permanent send failure' }),
    );
    expect(getUpdates).toHaveBeenNthCalledWith(2, {
      limit: 100,
      offset: 43,
      timeout: 30,
    });
  });

  it('sends oversized formatted answers as valid plain-text chunks', async () => {
    const sendMessage = createSendMessageMock();
    const bot = createTelegramBot({
      api: { getUpdates: vi.fn(), sendMessage, sendPhoto: vi.fn() },
      chatService: {
        ask: vi.fn(() =>
          Promise.resolve(
            createResponse({
              answer: `**${'A'.repeat(5000)}**`,
            }),
          ),
        ),
      },
      config: loadTelegramBotConfig({ TELEGRAM_BOT_TOKEN: 'bot-token' }),
    });

    await bot.handleUpdate({
      message: { chat: { id: 123 }, message_id: 1, text: 'XXYY Pro 权益' },
      update_id: 10,
    });

    const messages = sendMessage.mock.calls.map(([message]) => message);
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.text.length <= 4096)).toBe(true);
    expect(messages.every((message) => message.parseMode === undefined)).toBe(true);
    expect(messages.map((message) => message.text).join('')).not.toContain('<b>');
  });
});

describe('message formatting helpers', () => {
  it('recognizes only exact bot mentions and strips them safely', () => {
    const identity = { id: 999, username: 'xxyy_ask_bot' };
    const message = {
      chat: { id: -100123, type: 'supergroup' as const },
      message_id: 1,
    };

    expect(isGroupCustomerRequest(message, '你好 @xxyy_ask_bot，请介绍 Pro', identity)).toBe(true);
    expect(isGroupCustomerRequest(message, '@xxyy_ask_bot_extra 你好', identity)).toBe(false);
    expect(stripTelegramBotMention('你好 @XXYY_ASK_BOT，请介绍 Pro', identity.username)).toBe(
      '你好 ，请介绍 Pro',
    );
  });

  it('formats automatic learning status without exposing raw conversation content', () => {
    const formatted = formatTelegramKnowledgeLearningStatus(createLearningStatus());

    expect(formatted).toContain('同一对话链（最多 12 条消息）');
    expect(formatted).toContain('严格自动治理');
    expect(formatted).toContain('候选 4，已发布 2，待发布 1，处理中 0，已拒绝 1');
    expect(formatted).not.toContain('source_question_text');
  });

  it('resolves relative attachment URLs against the configured public base URL', () => {
    expect(resolveTelegramAttachmentUrl('/assets/a.png', 'https://ask.example.com/base/')).toBe(
      'https://ask.example.com/assets/a.png',
    );
    expect(resolveTelegramAttachmentUrl('https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    );
    expect(resolveTelegramAttachmentUrl('/assets/a.png')).toBeUndefined();
  });

  it('splits long Telegram messages without exceeding the requested size', () => {
    expect(splitTelegramMessage('abc\ndefgh', 5)).toEqual(['abc', 'defgh']);
    expect(splitTelegramMessage('abcdef', 3)).toEqual(['abc', 'def']);
  });

  it('splits Telegram HTML only between balanced lines', () => {
    expect(splitTelegramHtmlMessage('<b>one</b>\n<code>two</code>', 16)).toEqual([
      '<b>one</b>',
      '<code>two</code>',
    ]);
    expect(splitTelegramHtmlMessage(`<code>${'x'.repeat(20)}</code>`, 10)).toBeUndefined();
  });
});

async function* streamEvents(events: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}
