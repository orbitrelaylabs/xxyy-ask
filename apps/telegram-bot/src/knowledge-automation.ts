import {
  createKnowledgeAutomationController,
  createKnowledgeGovernanceService,
  createOpenAiKnowledgeCuratorModel,
  createPgKnowledgeCandidateStore,
  createPgKnowledgeMatchInspector,
  createPgKnowledgePublicationJobStore,
  createPgTelegramKnowledgeLearningSettingsStore,
  createPgPool,
  createPgTrustedAuthorStore,
  fetchTelegramCurrentAdministratorIds,
  normalizeTelegramUserId,
  UnverifiedTelegramKnowledgeAuthorError,
  type RagConfig,
} from '@xxyy/rag-core';

import type { TelegramKnowledgeAutomation, TelegramMessage } from './bot.js';

export interface TelegramKnowledgeAutomationRuntime {
  automation: TelegramKnowledgeAutomation;
  close(): Promise<void>;
}

const TELEGRAM_ADMIN_CACHE_TTL_MS = 5 * 60 * 1_000;

export function createTelegramKnowledgeAutomationRuntime(options: {
  botToken: string;
  config: RagConfig;
  contextMessageLimit: number;
  defaultEnabled: boolean;
  now?: () => Date;
  telegramApiBaseUrl?: string;
}): TelegramKnowledgeAutomationRuntime {
  const pool = createPgPool(options.config.databaseUrl);
  const candidateStore = createPgKnowledgeCandidateStore({ client: pool });
  const publicationJobStore = createPgKnowledgePublicationJobStore({ client: pool });
  const trustedAuthorStore = createPgTrustedAuthorStore({ client: pool });
  const learningSettingsStore = createPgTelegramKnowledgeLearningSettingsStore({ client: pool });
  const curatorModel =
    options.config.openAiApiKey === undefined || options.config.openAiModel === undefined
      ? undefined
      : createOpenAiKnowledgeCuratorModel({
          apiKey: options.config.openAiApiKey,
          baseUrl: options.config.openAiBaseUrl,
          model: options.config.openAiModel,
          requestTimeoutMs: options.config.openAiRequestTimeoutMs,
        });
  const governance = createKnowledgeGovernanceService({
    automation: createKnowledgeAutomationController({
      candidateStore,
      publicationJobStore,
    }),
    candidateStore,
    inspector: createPgKnowledgeMatchInspector({ candidateStore, client: pool }),
    trustedAuthorStore,
    ...(curatorModel === undefined ? {} : { curatorModel }),
  });
  const now = options.now ?? (() => new Date());
  const administratorCache = new Map<string, { ids: ReadonlySet<string>; verifiedAt: string }>();
  const learningSettingCache = new Map<
    string,
    {
      enabled: boolean;
      settingSource: 'chat_override' | 'environment_default';
      updatedAt?: string;
      verifiedAtMs: number;
    }
  >();
  const conversationBuffer = createTelegramConversationBuffer(options.contextMessageLimit);

  async function readLearningSetting(chatId: string): Promise<{
    enabled: boolean;
    settingSource: 'chat_override' | 'environment_default';
    updatedAt?: string;
  }> {
    const checkedAt = now().getTime();
    const cached = learningSettingCache.get(chatId);
    if (
      cached !== undefined &&
      checkedAt - cached.verifiedAtMs <= TELEGRAM_LEARNING_SETTING_CACHE_TTL_MS
    ) {
      return {
        enabled: cached.enabled,
        settingSource: cached.settingSource,
        ...(cached.updatedAt === undefined ? {} : { updatedAt: cached.updatedAt }),
      };
    }
    const setting = await learningSettingsStore.get(chatId);
    const resolved = {
      enabled: setting?.enabled ?? options.defaultEnabled,
      settingSource:
        setting === undefined ? ('environment_default' as const) : ('chat_override' as const),
      ...(setting === undefined ? {} : { updatedAt: setting.updatedAt }),
    };
    learningSettingCache.set(chatId, { ...resolved, verifiedAtMs: checkedAt });
    return resolved;
  }

  async function readAdministratorSnapshot(
    chatId: string,
    checkedAt: Date,
  ): Promise<{ ids: ReadonlySet<string>; verifiedAt: string } | undefined> {
    const cached = administratorCache.get(chatId);
    if (
      cached !== undefined &&
      checkedAt.getTime() - Date.parse(cached.verifiedAt) <= TELEGRAM_ADMIN_CACHE_TTL_MS
    ) {
      return cached;
    }
    try {
      const ids = await fetchTelegramCurrentAdministratorIds({
        botToken: options.botToken,
        chatId,
        ...(options.telegramApiBaseUrl === undefined
          ? {}
          : { apiBaseUrl: options.telegramApiBaseUrl }),
      });
      const snapshot = { ids, verifiedAt: checkedAt.toISOString() };
      administratorCache.set(chatId, snapshot);
      return snapshot;
    } catch {
      return undefined;
    }
  }

  return {
    automation: {
      async captureReply(message, captureOptions): Promise<boolean> {
        const chatId = String(message.chat.id);
        const learningSetting = await readLearningSetting(chatId);
        if (!learningSetting.enabled) {
          conversationBuffer.clear(chatId);
          return false;
        }
        const checkedAt = now();
        conversationBuffer.remember(message, checkedAt);
        const rawExport = createLiveTelegramKnowledgeExport(
          message,
          conversationBuffer.getReplyChain(message),
        );
        if (rawExport === undefined) {
          return false;
        }
        if (captureOptions?.edited === true && candidateStore.retractTelegramSource !== undefined) {
          await candidateStore.retractTelegramSource({
            actor: 'system:telegram-edit',
            messageId: String(message.message_id),
            sourceChatId: chatId,
          });
        }
        const administratorSnapshot = await readAdministratorSnapshot(chatId, checkedAt);
        try {
          const result = await governance.importTelegram({
            curationMode: 'auto',
            rawExport,
            runId: `telegram_live_${message.chat.id}_${message.message_id}`,
            sourceChannel: 'telegram',
            ...(administratorSnapshot === undefined
              ? {}
              : {
                  currentAdministratorUserIds: administratorSnapshot.ids,
                  currentAdministratorVerifiedAt: administratorSnapshot.verifiedAt,
                }),
          });
          return result.verifiedAuthorMessageCount > 0;
        } catch (error) {
          if (error instanceof UnverifiedTelegramKnowledgeAuthorError) {
            return false;
          }
          throw error;
        }
      },

      async getLearningStatus(chatId) {
        const normalizedChatId = String(chatId);
        const [setting, progress] = await Promise.all([
          readLearningSetting(normalizedChatId),
          learningSettingsStore.getProgress(normalizedChatId),
        ]);
        return {
          contextMessageLimit: options.contextMessageLimit,
          ...setting,
          progress,
        };
      },

      async setLearningEnabled(input) {
        if (
          input.requestedByUserId === undefined ||
          !Number.isSafeInteger(input.requestedByUserId)
        ) {
          return { authorized: false, reason: 'invalid_actor' };
        }
        const chatId = String(input.chatId);
        const checkedAt = now();
        const userId = normalizeTelegramUserId(String(input.requestedByUserId));
        const administratorSnapshot = await readAdministratorSnapshot(chatId, checkedAt);
        const trustedAuthor = await trustedAuthorStore.resolve({
          at: checkedAt.toISOString(),
          chatId,
          userId,
        });
        const isTrustedAdministrator =
          trustedAuthor?.role === 'administrator' || trustedAuthor?.role === 'owner';
        if (administratorSnapshot?.ids.has(userId) !== true && !isTrustedAdministrator) {
          return {
            authorized: false,
            reason:
              administratorSnapshot === undefined
                ? 'administrator_verification_unavailable'
                : 'not_administrator',
          };
        }

        const previous = await readLearningSetting(chatId);
        const setting = await learningSettingsStore.set({
          chatId,
          enabled: input.enabled,
          updatedBy: `telegram:${userId}`,
        });
        learningSettingCache.set(chatId, {
          enabled: setting.enabled,
          settingSource: 'chat_override',
          updatedAt: setting.updatedAt,
          verifiedAtMs: checkedAt.getTime(),
        });
        if (!setting.enabled) {
          conversationBuffer.clear(chatId);
        }
        const progress = await learningSettingsStore.getProgress(chatId);
        return {
          authorized: true,
          changed: previous.enabled !== setting.enabled,
          status: {
            contextMessageLimit: options.contextMessageLimit,
            enabled: setting.enabled,
            progress,
            settingSource: 'chat_override',
            updatedAt: setting.updatedAt,
          },
        };
      },
    },
    close() {
      return pool.end();
    },
  };
}

export function createLiveTelegramKnowledgeExport(
  message: TelegramMessage,
  contextMessages: readonly TelegramMessage[] = [],
): Record<string, unknown> | undefined {
  const question = message.reply_to_message;
  if (
    question === undefined ||
    question.text?.trim().length === 0 ||
    question.from?.is_bot === true ||
    message.text?.trim().length === 0 ||
    message.from === undefined ||
    message.from.is_bot === true ||
    message.sender_chat !== undefined
  ) {
    return undefined;
  }
  const messages = uniqueTelegramMessages([...contextMessages, question, message]).filter(
    (candidate) =>
      candidate.chat.id === message.chat.id &&
      candidate.text !== undefined &&
      candidate.text.trim().length > 0,
  );
  return {
    id: message.chat.id,
    messages: messages.map((candidate) => ({
      ...(candidate.date === undefined ? {} : { date: unixTimestamp(candidate.date) }),
      ...(candidate.from === undefined || candidate.sender_chat !== undefined
        ? {}
        : { from_id: `user${candidate.from.id}` }),
      id: candidate.message_id,
      ...(candidate.reply_to_message === undefined
        ? {}
        : { reply_to_message_id: candidate.reply_to_message.message_id }),
      text: candidate.text,
    })),
  };
}

export interface TelegramConversationBuffer {
  clear(chatId: string): void;
  getReplyChain(message: TelegramMessage): TelegramMessage[];
  remember(message: TelegramMessage, seenAt: Date): void;
}

interface BufferedTelegramMessage {
  message: TelegramMessage;
  seenAtMs: number;
}

const TELEGRAM_LEARNING_SETTING_CACHE_TTL_MS = 30 * 1_000;
const TELEGRAM_CONVERSATION_BUFFER_TTL_MS = 60 * 60 * 1_000;
const TELEGRAM_CONVERSATION_BUFFER_MAX_MESSAGES = 200;

export function createTelegramConversationBuffer(
  contextMessageLimit: number,
): TelegramConversationBuffer {
  const chats = new Map<string, Map<number, BufferedTelegramMessage>>();
  const limit = Math.max(2, Math.min(contextMessageLimit, 50));

  return {
    clear(chatId) {
      chats.delete(chatId);
    },

    getReplyChain(message) {
      const chat = chats.get(String(message.chat.id));
      const chain: TelegramMessage[] = [];
      let current: TelegramMessage | undefined = chat?.get(message.message_id)?.message ?? message;
      const visited = new Set<number>();
      while (current !== undefined && chain.length < limit && !visited.has(current.message_id)) {
        visited.add(current.message_id);
        chain.push(current);
        const parent: TelegramMessage | undefined = current.reply_to_message;
        current =
          parent === undefined ? undefined : (chat?.get(parent.message_id)?.message ?? parent);
      }
      return chain.reverse();
    },

    remember(message, seenAt) {
      const chatId = String(message.chat.id);
      const chat = chats.get(chatId) ?? new Map<number, BufferedTelegramMessage>();
      chats.set(chatId, chat);
      pruneBufferedMessages(chat, seenAt.getTime());
      rememberTelegramMessage(chat, message, seenAt.getTime(), new Set(), limit);
      while (chat.size > TELEGRAM_CONVERSATION_BUFFER_MAX_MESSAGES) {
        const oldestId = chat.keys().next().value as number | undefined;
        if (oldestId === undefined) {
          break;
        }
        chat.delete(oldestId);
      }
    },
  };
}

function rememberTelegramMessage(
  chat: Map<number, BufferedTelegramMessage>,
  message: TelegramMessage,
  seenAtMs: number,
  visited: Set<number>,
  remainingDepth: number,
): void {
  if (remainingDepth <= 0 || visited.has(message.message_id)) {
    return;
  }
  visited.add(message.message_id);
  const parent = message.reply_to_message;
  if (parent !== undefined) {
    rememberTelegramMessage(chat, parent, seenAtMs, visited, remainingDepth - 1);
  }
  const existing = chat.get(message.message_id);
  const preservedMessage =
    existing?.message.reply_to_message !== undefined && message.reply_to_message === undefined
      ? existing.message
      : message;
  chat.delete(message.message_id);
  chat.set(message.message_id, { message: preservedMessage, seenAtMs });
}

function pruneBufferedMessages(
  chat: Map<number, BufferedTelegramMessage>,
  currentTimeMs: number,
): void {
  for (const [messageId, entry] of chat) {
    if (currentTimeMs - entry.seenAtMs > TELEGRAM_CONVERSATION_BUFFER_TTL_MS) {
      chat.delete(messageId);
    }
  }
}

function uniqueTelegramMessages(messages: readonly TelegramMessage[]): TelegramMessage[] {
  const byId = new Map<number, TelegramMessage>();
  for (const message of messages) {
    const existing = byId.get(message.message_id);
    if (existing?.reply_to_message !== undefined && message.reply_to_message === undefined) {
      continue;
    }
    byId.set(message.message_id, message);
  }
  return [...byId.values()];
}

function unixTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Telegram message date must be a positive Unix timestamp.');
  }
  return new Date(value * 1_000).toISOString();
}
