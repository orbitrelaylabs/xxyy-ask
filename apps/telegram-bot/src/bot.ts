import path from 'node:path';

import {
  knowledgeSourceCatalog,
  type ChatRequest,
  type ChatResponse,
  type ChatHistoryMessage,
  type ChatStreamEvent,
  type KnowledgeRefreshStatus,
} from '@xxyy/shared';
import {
  filterQuestionRelevantAttachments,
  redactSensitiveSupportText,
  type ChatService,
} from '@xxyy/rag-core';

export interface TelegramBotConfig {
  autoLearningContextMessages: number;
  autoLearningDefaultEnabled: boolean;
  botToken: string;
  groupResponsesEnabled: boolean;
  pollErrorRetryMs: number;
  pollTimeoutSeconds: number;
  publicBaseUrl?: string;
  screenshotDirectory?: string;
  updatesLimit: number;
}

export interface TelegramUpdate {
  update_id: number;
  edited_message?: TelegramMessage;
  message?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdated;
}

export interface TelegramMessage {
  chat: {
    id: number;
    title?: string;
    type?: 'channel' | 'group' | 'private' | 'supergroup';
  };
  date?: number;
  from?: {
    first_name?: string;
    id: number;
    is_bot?: boolean;
    last_name?: string;
    username?: string;
  };
  message_id: number;
  message_thread_id?: number;
  reply_to_message?: TelegramMessage;
  sender_chat?: {
    id: number;
  };
  text?: string;
}

export interface TelegramChatMemberUpdated {
  chat: {
    id: number;
    title?: string;
    type?: 'channel' | 'group' | 'private' | 'supergroup';
  };
  date: number;
  new_chat_member: {
    status: 'administrator' | 'creator' | 'kicked' | 'left' | 'member' | 'restricted';
  };
}

export interface TelegramApi {
  getMe?(): Promise<TelegramBotIdentity>;
  getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramUpdate[]>;
  sendChatAction?(input: TelegramSendChatActionInput): Promise<void>;
  sendMessage(input: TelegramSendMessageInput): Promise<void>;
  sendMessageDraft?(input: TelegramSendMessageDraftInput): Promise<void>;
  sendPhoto(input: TelegramSendPhotoInput): Promise<void>;
  sendVideo?(input: TelegramSendVideoInput): Promise<void>;
  setMyCommands?(input: TelegramSetMyCommandsInput): Promise<void>;
}

export interface TelegramBotIdentity {
  id: number;
  username: string;
}

export interface TelegramGetUpdatesInput {
  limit: number;
  offset?: number;
  timeout: number;
}

export interface TelegramSendMessageInput {
  chatId: number;
  parseMode?: 'HTML';
  replyToMessageId?: number;
  text: string;
}

export interface TelegramSendChatActionInput {
  action: 'typing';
  chatId: number;
}

export interface TelegramSendMessageDraftInput {
  chatId: number;
  draftId: number;
  text: string;
}

export interface TelegramSendPhotoInput {
  caption?: string;
  chatId: number;
  photo:
    | string
    | {
        filePath: string;
        filename: string;
        mediaType: 'image/jpeg' | 'image/png';
      };
  replyToMessageId?: number;
}

export interface TelegramSendVideoInput {
  caption?: string;
  chatId: number;
  replyToMessageId?: number;
  video: string;
}

export interface TelegramSetMyCommandsInput {
  commands: Array<{
    command: string;
    description: string;
  }>;
}

export interface TelegramBot {
  handleUpdate(update: TelegramUpdate): Promise<void>;
  pollOnce(): Promise<void>;
}

export interface CreateTelegramBotOptions {
  api: TelegramApi;
  chatService: TelegramChatService;
  config: TelegramBotConfig;
  getKnowledgeRefreshStatus?: () => Promise<KnowledgeRefreshStatus>;
  groupMessageArchive?: TelegramGroupMessageArchive;
  groupRegistry?: TelegramGroupRegistry;
  knowledgeAutomation?: TelegramKnowledgeAutomation;
  logger?: TelegramBotLogger;
  userDirectory?: TelegramUserDirectory;
}

export interface TelegramUserDirectory {
  observeUser(input: {
    displayName?: string;
    telegramUserId: string;
    username?: string;
  }): Promise<void>;
}

export interface TelegramGroupRegistry {
  observeMembership(input: {
    chatId: string;
    chatType: 'group' | 'supergroup';
    membershipStatus: 'active' | 'kicked' | 'left' | 'unknown';
    observedAt: string;
    title?: string;
  }): Promise<unknown>;
  observeMessage(input: {
    chatId: string;
    chatType: 'group' | 'supergroup';
    observedAt: string;
    title?: string;
  }): Promise<unknown>;
}

export interface TelegramGroupMessageArchive {
  capture(input: {
    authorIsBot: boolean;
    chatId: string;
    messageId: string;
    sentAt: string;
    text: string;
    authorUserId?: string;
    replyToMessageId?: string;
    senderChatId?: string;
  }): Promise<void>;
}

export interface TelegramKnowledgeAutomation {
  captureReply(message: TelegramMessage, options?: { edited?: boolean }): Promise<boolean>;
  getLearningStatus(chatId: number): Promise<TelegramKnowledgeLearningStatus>;
  setLearningEnabled(input: {
    chatId: number;
    enabled: boolean;
    requestedByUserId?: number;
  }): Promise<TelegramKnowledgeLearningChangeResult>;
}

export interface TelegramKnowledgeLearningStatus {
  contextMessageLimit: number;
  enabled: boolean;
  progress: {
    approvedCount: number;
    candidateCount: number;
    pendingCount: number;
    publishedCount: number;
    rejectedCount: number;
    lastAnalyzedAt?: string;
  };
  settingSource: 'chat_override' | 'environment_default';
  updatedAt?: string;
}

export type TelegramKnowledgeLearningChangeResult =
  | {
      authorized: true;
      changed: boolean;
      status: TelegramKnowledgeLearningStatus;
    }
  | {
      authorized: false;
      reason: 'administrator_verification_unavailable' | 'invalid_actor' | 'not_administrator';
    };

type TelegramChatService = Pick<ChatService, 'ask'> & Partial<Pick<ChatService, 'stream'>>;

export interface TelegramBotLogger {
  error(message: string, error?: unknown): void;
  info(message: string): void;
}

export type TelegramBotEnv = Record<string, string | undefined> &
  Partial<
    Record<
      | 'TELEGRAM_BOT_TOKEN'
      | 'TELEGRAM_AUTO_LEARNING_CONTEXT_MESSAGES'
      | 'TELEGRAM_AUTO_LEARNING_ENABLED'
      | 'TELEGRAM_GROUP_RESPONSES_ENABLED'
      | 'XXYY_SCREENSHOT_DIRECTORY'
      | 'TELEGRAM_POLL_ERROR_RETRY_MS'
      | 'TELEGRAM_POLL_TIMEOUT_SECONDS'
      | 'TELEGRAM_PUBLIC_BASE_URL'
      | 'TELEGRAM_UPDATES_LIMIT',
      string
    >
  >;

export class TelegramBotConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramBotConfigurationError';
  }
}

const DEFAULT_UPDATES_LIMIT = 100;
const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_ERROR_RETRY_MS = 3000;
const DEFAULT_AUTO_LEARNING_CONTEXT_MESSAGES = 12;
const MAX_AUTO_LEARNING_CONTEXT_MESSAGES = 50;
const TELEGRAM_DRAFT_UPDATE_MIN_CHARS = 80;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_TYPING_REFRESH_MS = 4000;
const HELP_TEXT = [
  '我是 XXYY 客服 Bot，可以回答产品功能、配置步骤、权益说明和官方更新，也可以查询公开 Explorer 交易链接。',
  '',
  '私聊直接发送问题；群聊回复默认关闭，Bot 只读取允许接收的消息。',
  '发送一笔公开 Explorer 交易链接可以查询基础事实；询问是否被夹、买错池或小池时，会核对 XXYY 前后成交并在证据就绪时返回真实标注截图。',
  '浏览器证据不包含 EVM 调用追踪、archive 状态或确定性 MEV/损失证明。',
  '不查询账户、钱包私有记录、任意地址历史，也不代用户执行交易。',
  '发送 /status 可查看知识库自动更新状态。',
  '群消息只保存在本地知识收件箱；请在管理后台整理并审批后入库。',
].join('\n');
const UNSUPPORTED_MESSAGE_TEXT = '目前只支持文本消息，请直接发送具体的 XXYY 产品问题。';
export const TELEGRAM_BOT_COMMANDS = [
  { command: 'start', description: '开始使用 XXYY 客服' },
  { command: 'help', description: '查看客服能力说明' },
  { command: 'status', description: '查看知识库自动更新状态' },
] as const;

export function loadTelegramBotConfig(env: TelegramBotEnv): TelegramBotConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (botToken === undefined || botToken.length === 0) {
    throw new TelegramBotConfigurationError('TELEGRAM_BOT_TOKEN is required.');
  }

  const publicBaseUrl = normalizeOptionalString(env.TELEGRAM_PUBLIC_BASE_URL);
  const screenshotDirectory = normalizeOptionalString(env.XXYY_SCREENSHOT_DIRECTORY);

  return {
    autoLearningContextMessages: parseBoundedPositiveInteger(
      env.TELEGRAM_AUTO_LEARNING_CONTEXT_MESSAGES,
      DEFAULT_AUTO_LEARNING_CONTEXT_MESSAGES,
      2,
      MAX_AUTO_LEARNING_CONTEXT_MESSAGES,
    ),
    autoLearningDefaultEnabled: parseBoolean(
      env.TELEGRAM_AUTO_LEARNING_ENABLED,
      false,
      'TELEGRAM_AUTO_LEARNING_ENABLED',
    ),
    botToken,
    groupResponsesEnabled: parseBoolean(
      env.TELEGRAM_GROUP_RESPONSES_ENABLED,
      false,
      'TELEGRAM_GROUP_RESPONSES_ENABLED',
    ),
    pollErrorRetryMs: parsePositiveInteger(
      env.TELEGRAM_POLL_ERROR_RETRY_MS,
      DEFAULT_POLL_ERROR_RETRY_MS,
    ),
    pollTimeoutSeconds: parsePositiveInteger(
      env.TELEGRAM_POLL_TIMEOUT_SECONDS,
      DEFAULT_POLL_TIMEOUT_SECONDS,
    ),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    ...(screenshotDirectory === undefined ? {} : { screenshotDirectory }),
    updatesLimit: parsePositiveInteger(env.TELEGRAM_UPDATES_LIMIT, DEFAULT_UPDATES_LIMIT),
  };
}

export function createTelegramBot(options: CreateTelegramBotOptions): TelegramBot {
  let offset: number | undefined;
  let botIdentity: TelegramBotIdentity | undefined;
  let botIdentityRequest: Promise<TelegramBotIdentity | undefined> | undefined;

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.my_chat_member !== undefined) {
      await recordTelegramGroupMembership(options, update.my_chat_member);
    }
    const edited = update.edited_message !== undefined;
    const message = update.message ?? update.edited_message;
    if (message === undefined) {
      return;
    }

    await observeTelegramUser(options, message);

    const chatId = message.chat.id;
    const text = message.text?.trim();
    const groupChat = isGroupChat(message);

    if (groupChat) {
      await recordTelegramGroupMessage(options, message);
    }

    if (groupChat && !options.config.groupResponsesEnabled) {
      return;
    }

    if (text !== undefined && text.length > 0 && groupChat) {
      const commandTarget = readTelegramCommandTarget(text);
      if (commandTarget !== undefined) {
        const identity = await readBotIdentity();
        if (
          identity === undefined ||
          commandTarget.toLowerCase() !==
            normalizeTelegramBotUsername(identity.username).toLowerCase()
        ) {
          return;
        }
      }
    }

    if (text !== undefined && text.length > 0 && isHelpCommand(text)) {
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: HELP_TEXT,
      });
      return;
    }

    if (text !== undefined && text.length > 0 && isKnowledgeRefreshStatusCommand(text)) {
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: await readTelegramKnowledgeRefreshStatus(options),
      });
      return;
    }

    const learningCommand =
      text === undefined || text.length === 0 ? undefined : readKnowledgeLearningCommand(text);
    if (learningCommand !== undefined) {
      await handleTelegramKnowledgeLearningCommand(options, message, learningCommand);
      return;
    }

    if (edited) {
      return;
    }

    let customerQuestion = text;
    let requestBotIdentity: TelegramBotIdentity | undefined;
    if (groupChat) {
      const identity = await readBotIdentity();
      if (identity === undefined || !isGroupCustomerRequest(message, text, identity)) {
        return;
      }
      requestBotIdentity = identity;
      if (customerQuestion !== undefined && customerQuestion.length > 0) {
        customerQuestion = stripTelegramBotMention(customerQuestion, identity.username);
      }
    }

    if (customerQuestion === undefined || customerQuestion.length === 0) {
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: UNSUPPORTED_MESSAGE_TEXT,
      });
      return;
    }

    const request = createTelegramChatRequest(message, customerQuestion, requestBotIdentity);
    await withTelegramTyping(options.api, chatId, async () => {
      if (canStreamToDraft(message, options)) {
        const streamed = await trySendStreamingChatResponse({
          api: options.api,
          chatId,
          config: options.config,
          draftId: createTelegramDraftId(update.update_id),
          replyToMessageId: message.message_id,
          request,
          stream: options.chatService.stream,
        });
        if (streamed) {
          return;
        }
      }

      const response = await options.chatService.ask(request);

      await sendChatResponse(
        options.api,
        chatId,
        response,
        request.message,
        options.config,
        message.message_id,
      );
    });
  }

  async function readBotIdentity(): Promise<TelegramBotIdentity | undefined> {
    if (botIdentity !== undefined) {
      return botIdentity;
    }
    if (options.api.getMe === undefined) {
      return undefined;
    }
    botIdentityRequest ??= options.api
      .getMe()
      .then((identity) => {
        botIdentity = identity;
        options.logger?.info(`Telegram bot identity loaded for @${identity.username}.`);
        return identity;
      })
      .catch(() => {
        options.logger?.error(
          'Telegram bot identity lookup failed; group replies remain disabled.',
        );
        return undefined;
      })
      .finally(() => {
        botIdentityRequest = undefined;
      });
    return botIdentityRequest;
  }

  return {
    handleUpdate,

    async pollOnce(): Promise<void> {
      const updates = await options.api.getUpdates({
        limit: options.config.updatesLimit,
        ...(offset === undefined ? {} : { offset }),
        timeout: options.config.pollTimeoutSeconds,
      });

      for (const update of updates) {
        try {
          await handleUpdate(update);
        } catch (error) {
          options.logger?.error(`Telegram update ${update.update_id} failed.`, error);
        } finally {
          offset = update.update_id + 1;
        }
      }
    },
  };
}

async function observeTelegramUser(
  options: CreateTelegramBotOptions,
  message: TelegramMessage,
): Promise<void> {
  const sender = message.from;
  if (sender === undefined || sender.is_bot === true || options.userDirectory === undefined) return;
  const displayName = [sender.first_name, sender.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();
  try {
    await options.userDirectory.observeUser({
      ...(displayName.length === 0 ? {} : { displayName }),
      telegramUserId: String(sender.id),
      ...(sender.username === undefined ? {} : { username: sender.username }),
    });
  } catch (error) {
    options.logger?.error('Telegram user identity observation failed.', error);
  }
}

function isGroupChat(
  message: TelegramMessage,
): message is TelegramMessage & { chat: { type: 'group' | 'supergroup' } } {
  return message.chat.type === 'group' || message.chat.type === 'supergroup';
}

async function recordTelegramGroupMessage(
  options: CreateTelegramBotOptions,
  message: TelegramMessage,
): Promise<void> {
  if (!isGroupChat(message)) {
    return;
  }
  if (options.groupRegistry !== undefined) {
    try {
      await options.groupRegistry.observeMessage({
        chatId: String(message.chat.id),
        chatType: message.chat.type,
        observedAt: telegramUnixTimestamp(message.date),
        ...(message.chat.title === undefined ? {} : { title: message.chat.title }),
      });
    } catch {
      options.logger?.error(`Telegram group ${message.chat.id} registry update failed.`);
    }
  }
  if (options.groupMessageArchive !== undefined) {
    try {
      await archiveTelegramMessage(options.groupMessageArchive, message, new Set(), 8);
    } catch {
      options.logger?.error(`Telegram group ${message.chat.id} message archive update failed.`);
    }
  }
}

async function archiveTelegramMessage(
  archive: TelegramGroupMessageArchive,
  message: TelegramMessage,
  visited: Set<number>,
  remainingDepth: number,
): Promise<void> {
  const text = message.text?.trim();
  if (
    remainingDepth <= 0 ||
    visited.has(message.message_id) ||
    !isGroupChat(message) ||
    text === undefined ||
    text.length === 0
  ) {
    return;
  }
  visited.add(message.message_id);
  if (message.reply_to_message !== undefined) {
    await archiveTelegramMessage(archive, message.reply_to_message, visited, remainingDepth - 1);
  }
  await archive.capture({
    authorIsBot: message.from?.is_bot === true,
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    sentAt: telegramUnixTimestamp(message.date),
    text,
    ...(message.from?.id === undefined ? {} : { authorUserId: String(message.from.id) }),
    ...(message.reply_to_message === undefined
      ? {}
      : { replyToMessageId: String(message.reply_to_message.message_id) }),
    ...(message.sender_chat?.id === undefined
      ? {}
      : { senderChatId: String(message.sender_chat.id) }),
  });
}

async function recordTelegramGroupMembership(
  options: CreateTelegramBotOptions,
  update: TelegramChatMemberUpdated,
): Promise<void> {
  if (
    options.groupRegistry === undefined ||
    (update.chat.type !== 'group' && update.chat.type !== 'supergroup')
  ) {
    return;
  }
  try {
    await options.groupRegistry.observeMembership({
      chatId: String(update.chat.id),
      chatType: update.chat.type,
      membershipStatus: telegramMembershipStatus(update.new_chat_member.status),
      observedAt: telegramUnixTimestamp(update.date),
      ...(update.chat.title === undefined ? {} : { title: update.chat.title }),
    });
  } catch {
    options.logger?.error(`Telegram group ${update.chat.id} membership registry update failed.`);
  }
}

function telegramMembershipStatus(
  status: TelegramChatMemberUpdated['new_chat_member']['status'],
): 'active' | 'kicked' | 'left' | 'unknown' {
  if (status === 'kicked' || status === 'left') {
    return status;
  }
  if (
    status === 'administrator' ||
    status === 'creator' ||
    status === 'member' ||
    status === 'restricted'
  ) {
    return 'active';
  }
  return 'unknown';
}

function telegramUnixTimestamp(value: number | undefined): string {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return new Date().toISOString();
  }
  return new Date(value * 1_000).toISOString();
}

export function isGroupCustomerRequest(
  message: TelegramMessage,
  text: string | undefined,
  identity: TelegramBotIdentity,
): boolean {
  if (message.reply_to_message?.from?.id === identity.id) {
    return true;
  }
  return text !== undefined && hasTelegramBotMention(text, identity.username);
}

export function stripTelegramBotMention(text: string, username: string): string {
  const normalizedUsername = normalizeTelegramBotUsername(username);
  if (normalizedUsername.length === 0) {
    return text.trim();
  }
  const escapedUsername = escapeRegularExpression(normalizedUsername);
  return text
    .replace(new RegExp(`(^|[^A-Za-z0-9_])@${escapedUsername}(?=$|[^A-Za-z0-9_])`, 'giu'), '$1')
    .trim();
}

function hasTelegramBotMention(text: string, username: string): boolean {
  const normalizedUsername = normalizeTelegramBotUsername(username);
  if (normalizedUsername.length === 0) {
    return false;
  }
  const escapedUsername = escapeRegularExpression(normalizedUsername);
  return new RegExp(`(^|[^A-Za-z0-9_])@${escapedUsername}(?=$|[^A-Za-z0-9_])`, 'iu').test(text);
}

function normalizeTelegramBotUsername(username: string): string {
  return username.trim().replace(/^@/u, '');
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function createTelegramChatRequest(
  message: TelegramMessage,
  text: string,
  botIdentity?: TelegramBotIdentity,
): ChatRequest {
  const replyHistory = createTelegramReplyHistory(message, botIdentity);
  return {
    channel: 'telegram',
    ...(replyHistory.length === 0 ? {} : { history: replyHistory }),
    message: text,
    requestId: `telegram:${message.chat.id}:${message.message_id}`,
    sessionId: createTelegramSessionId(message),
    ...(message.from?.id === undefined ? {} : { userId: `telegram:${message.from.id}` }),
  };
}

const TELEGRAM_REPLY_HISTORY_LIMIT = 6;
const TELEGRAM_REPLY_HISTORY_TEXT_LIMIT = 2_000;

function createTelegramReplyHistory(
  message: TelegramMessage,
  botIdentity: TelegramBotIdentity | undefined,
): ChatHistoryMessage[] {
  const chain: TelegramMessage[] = [];
  const seenMessageIds = new Set<number>();
  let current = message.reply_to_message;
  while (
    current !== undefined &&
    chain.length < TELEGRAM_REPLY_HISTORY_LIMIT &&
    !seenMessageIds.has(current.message_id)
  ) {
    seenMessageIds.add(current.message_id);
    chain.push(current);
    current = current.reply_to_message;
  }
  if (chain.length === 0) {
    return [];
  }

  const currentUserId = message.from?.id;
  if (
    isGroupChat(message) &&
    (currentUserId === undefined ||
      !chain.some((candidate) => candidate.from?.id === currentUserId) ||
      chain.some(
        (candidate) =>
          candidate.from?.is_bot !== true &&
          candidate.from?.id !== undefined &&
          candidate.from.id !== currentUserId,
      ))
  ) {
    return [];
  }

  return chain.reverse().flatMap<ChatHistoryMessage>((candidate) => {
    const content = sanitizeTelegramReplyHistoryText(candidate.text);
    if (content === undefined) {
      return [];
    }
    if (
      candidate.from?.is_bot === true &&
      (botIdentity === undefined || candidate.from.id === botIdentity.id)
    ) {
      return [{ content, role: 'assistant' as const }];
    }
    if (currentUserId !== undefined && candidate.from?.id === currentUserId) {
      return [{ content, role: 'user' as const }];
    }
    return [];
  });
}

function sanitizeTelegramReplyHistoryText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const sanitized = redactSensitiveSupportText(text.trim()).slice(
    0,
    TELEGRAM_REPLY_HISTORY_TEXT_LIMIT,
  );
  return sanitized.length === 0 ? undefined : sanitized;
}

function createTelegramSessionId(message: TelegramMessage): string {
  if (!isGroupChat(message)) {
    return `telegram:${message.chat.id}`;
  }

  const topic = message.message_thread_id ?? 'main';
  const participant =
    message.from?.id !== undefined
      ? `user:${message.from.id}`
      : message.sender_chat?.id !== undefined
        ? `sender-chat:${message.sender_chat.id}`
        : 'unknown';
  return `telegram:${message.chat.id}:topic:${topic}:${participant}`;
}

function canStreamToDraft(message: TelegramMessage, options: CreateTelegramBotOptions): boolean {
  return (
    options.chatService.stream !== undefined &&
    options.api.sendMessageDraft !== undefined &&
    (message.chat.type === undefined || message.chat.type === 'private')
  );
}

async function trySendStreamingChatResponse(options: {
  api: Pick<TelegramApi, 'sendMessage' | 'sendMessageDraft' | 'sendPhoto' | 'sendVideo'>;
  chatId: number;
  config: Pick<TelegramBotConfig, 'publicBaseUrl'>;
  draftId: number;
  replyToMessageId?: number;
  request: ChatRequest;
  stream: ChatService['stream'] | undefined;
}): Promise<boolean> {
  if (options.stream === undefined || options.api.sendMessageDraft === undefined) {
    return false;
  }

  let answer = '';
  let draftFailed = false;
  let lastDraftLength = 0;
  let lastStatusMessage: string | undefined;
  let metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined;

  try {
    for await (const event of options.stream(options.request)) {
      if (event.type === 'status') {
        if (answer.length > 0 || draftFailed || event.message === lastStatusMessage) {
          continue;
        }
        lastStatusMessage = event.message;
        try {
          await options.api.sendMessageDraft({
            chatId: options.chatId,
            draftId: options.draftId,
            text: formatTelegramStatusDraft(event.message),
          });
        } catch {
          draftFailed = true;
        }
        continue;
      }

      if (event.type === 'answer_delta') {
        answer += event.delta;
        if (!draftFailed && shouldSendTelegramDraft(answer, lastDraftLength)) {
          try {
            await options.api.sendMessageDraft({
              chatId: options.chatId,
              draftId: options.draftId,
              text: answer,
            });
            lastDraftLength = answer.length;
          } catch {
            draftFailed = true;
          }
        }
        continue;
      }

      if (event.type === 'metadata') {
        metadata = event;
      }
    }
  } catch {
    return false;
  }

  if (metadata === undefined) {
    return false;
  }

  await sendChatResponse(
    options.api,
    options.chatId,
    {
      answer,
      citations: metadata.citations,
      confidence: metadata.confidence,
      intent: metadata.intent,
      ...(metadata.agentRoute === undefined ? {} : { agentRoute: metadata.agentRoute }),
      ...(metadata.attachments === undefined ? {} : { attachments: metadata.attachments }),
      ...(metadata.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
    },
    options.request.message,
    options.config,
    options.replyToMessageId,
  );
  return true;
}

async function withTelegramTyping<T>(
  api: Pick<TelegramApi, 'sendChatAction'>,
  chatId: number,
  task: () => Promise<T>,
): Promise<T> {
  if (api.sendChatAction === undefined) {
    return task();
  }

  await sendTypingAction(api, chatId);
  const timer = setInterval(() => {
    void sendTypingAction(api, chatId);
  }, TELEGRAM_TYPING_REFRESH_MS);
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }

  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

async function sendTypingAction(
  api: Pick<TelegramApi, 'sendChatAction'>,
  chatId: number,
): Promise<void> {
  try {
    await api.sendChatAction?.({ action: 'typing', chatId });
  } catch {
    // Typing indicators are best-effort; never fail the support response because of them.
  }
}

function shouldSendTelegramDraft(answer: string, lastDraftLength: number): boolean {
  return (
    answer.length > 0 &&
    (lastDraftLength === 0 || answer.length - lastDraftLength >= TELEGRAM_DRAFT_UPDATE_MIN_CHARS)
  );
}

function formatTelegramStatusDraft(message: string): string {
  return `⏳ ${message}`;
}

function createTelegramDraftId(updateId: number): number {
  return Math.max(1, updateId);
}

export async function runTelegramBot(
  bot: Pick<TelegramBot, 'pollOnce'>,
  options: {
    abortSignal?: AbortSignal;
    errorRetryMs: number;
    logger?: TelegramBotLogger;
  },
): Promise<void> {
  while (options.abortSignal?.aborted !== true) {
    try {
      await bot.pollOnce();
    } catch (error) {
      options.logger?.error('Telegram polling failed.', error);
      await sleep(options.errorRetryMs, options.abortSignal);
    }
  }
}

async function sendChatResponse(
  api: Pick<TelegramApi, 'sendMessage' | 'sendPhoto' | 'sendVideo'>,
  chatId: number,
  response: ChatResponse,
  question: string,
  config: Pick<TelegramBotConfig, 'publicBaseUrl' | 'screenshotDirectory'>,
  replyToMessageId?: number,
): Promise<void> {
  const attachments = userVisibleAttachments(question, response.attachments);
  const attachmentLines = attachmentFallbackLines(
    attachments,
    config.publicBaseUrl,
    config.screenshotDirectory,
    api.sendVideo !== undefined,
  );
  const htmlMessage = formatTelegramChatResponse(response, attachmentLines);
  const htmlChunks = splitTelegramHtmlMessage(htmlMessage, TELEGRAM_MESSAGE_LIMIT);
  if (htmlChunks !== undefined) {
    for (const chunk of htmlChunks) {
      await api.sendMessage({
        chatId,
        parseMode: 'HTML',
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        text: chunk,
      });
    }
  } else {
    const plainText = formatTelegramPlainTextResponse(response, attachmentLines);
    for (const chunk of splitTelegramMessage(plainText, TELEGRAM_MESSAGE_LIMIT)) {
      await api.sendMessage({
        chatId,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
        text: chunk,
      });
    }
  }

  for (const attachment of attachments) {
    if (attachment.kind === 'video') {
      if (attachment.mediaType !== 'video/mp4' || api.sendVideo === undefined) {
        continue;
      }
      const video = resolveTelegramAttachmentUrl(attachment.url, config.publicBaseUrl);
      if (video === undefined) {
        continue;
      }
      await api.sendVideo({
        caption: attachment.title,
        chatId,
        video,
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      });
      continue;
    }
    if (!isTelegramPhotoMediaType(attachment.mediaType)) {
      continue;
    }
    const photo = resolveTelegramPhotoAttachment(
      attachment.url,
      attachment.mediaType,
      config.publicBaseUrl,
      config.screenshotDirectory,
    );
    if (photo === undefined) {
      continue;
    }
    await api.sendPhoto({
      caption: attachment.title,
      chatId,
      photo,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    });
  }
}

function userVisibleAttachments(
  question: string,
  attachments: ChatResponse['attachments'],
): NonNullable<ChatResponse['attachments']> {
  const required = (attachments ?? []).filter((attachment) => attachment.delivery === 'required');
  const onRequest = filterQuestionRelevantAttachments(
    question,
    (attachments ?? []).filter((attachment) => attachment.delivery !== 'required'),
  );
  return [...required, ...onRequest];
}

function formatTelegramChatResponse(response: ChatResponse, attachmentLines: string[]): string {
  const lines = [
    markdownToTelegramHtml(response.answer),
    ...attachmentLines.map(escapeHtml),
    ...telegramCitationLines(response.citations),
  ];
  return lines.join('\n').trim();
}

function formatTelegramPlainTextResponse(
  response: ChatResponse,
  attachmentLines: string[],
): string {
  const lines = [
    markdownToPlainText(response.answer),
    ...attachmentLines,
    ...telegramPlainTextCitationLines(response.citations),
  ];
  return lines.join('\n').trim();
}

function telegramPlainTextCitationLines(citations: ChatResponse['citations']): string[] {
  if (citations.length === 0) {
    return [];
  }

  return [
    '',
    '来源',
    ...citations.map(
      (citation, index) =>
        `${index + 1}. ${telegramCitationSourcePrefix(citation)}${citation.title}${
          citation.sourceUrl === undefined ? '' : ` ${citation.sourceUrl}`
        }`,
    ),
  ];
}

function telegramCitationLines(citations: ChatResponse['citations']): string[] {
  if (citations.length === 0) {
    return [];
  }

  return [
    '',
    '<b>来源</b>',
    ...citations.map((citation, index) => `${index + 1}. ${telegramCitationTitle(citation)}`),
  ];
}

function telegramCitationTitle(citation: ChatResponse['citations'][number]): string {
  const title = escapeHtml(`${telegramCitationSourcePrefix(citation)}${citation.title}`);
  if (citation.sourceUrl === undefined) {
    return `<b>${title}</b>`;
  }
  return `<a href="${escapeHtmlAttribute(citation.sourceUrl)}">${title}</a>`;
}

function telegramCitationSourcePrefix(citation: ChatResponse['citations'][number]): string {
  return citation.sourceType === undefined
    ? ''
    : `[${knowledgeSourceCatalog[citation.sourceType].label}] `;
}

function markdownToTelegramHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*\n][^*]*?)\*\*/gu, '<b>$1</b>')
    .replace(/`([^`\n]+?)`/gu, '<code>$1</code>');
}

function markdownToPlainText(text: string): string {
  return text.replace(/\*\*([^*\n][^*]*?)\*\*/gu, '$1').replace(/`([^`\n]+?)`/gu, '$1');
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/gu, '&quot;');
}

export function resolveTelegramAttachmentUrl(
  url: string,
  publicBaseUrl?: string,
): string | undefined {
  if (/^https?:\/\//iu.test(url)) {
    return url;
  }
  if (publicBaseUrl === undefined) {
    return undefined;
  }
  return new URL(url, publicBaseUrl).toString();
}

export function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const newlineIndex = remaining.lastIndexOf('\n', limit);
    const splitIndex = newlineIndex > 0 ? newlineIndex : limit;
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/u, '');
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export function splitTelegramHtmlMessage(
  text: string,
  limit = TELEGRAM_MESSAGE_LIMIT,
): string[] | undefined {
  const lines = text.split('\n');
  if (lines.some((line) => line.length > limit)) {
    return undefined;
  }

  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    chunks.push(current);
    current = line;
  }
  if (current.length > 0 || chunks.length === 0) {
    chunks.push(current);
  }
  return chunks;
}

function isHelpCommand(text: string): boolean {
  const command = readTelegramCommand(text);
  return command === '/start' || command === '/help';
}

function isKnowledgeRefreshStatusCommand(text: string): boolean {
  return readTelegramCommand(text) === '/status';
}

type KnowledgeLearningCommand = 'disable' | 'enable' | 'status';

function readKnowledgeLearningCommand(text: string): KnowledgeLearningCommand | undefined {
  switch (readTelegramCommand(text)) {
    case '/learning':
      return 'status';
    case '/learning_on':
      return 'enable';
    case '/learning_off':
      return 'disable';
    default:
      return undefined;
  }
}

function readTelegramCommand(text: string): string | undefined {
  return text.split(/\s+/u)[0]?.toLowerCase().split('@')[0];
}

function readTelegramCommandTarget(text: string): string | undefined {
  const token = text.split(/\s+/u)[0];
  const match = token?.match(/^\/[A-Za-z0-9_]+@([A-Za-z0-9_]+)$/u);
  return match?.[1];
}

async function handleTelegramKnowledgeLearningCommand(
  options: CreateTelegramBotOptions,
  message: TelegramMessage,
  command: KnowledgeLearningCommand,
): Promise<void> {
  const chatId = message.chat.id;
  if (!isGroupChat(message)) {
    await options.api.sendMessage({
      chatId,
      replyToMessageId: message.message_id,
      text: '自动学习仅支持 Telegram 客服群，请在目标群聊中使用该命令。',
    });
    return;
  }
  if (options.knowledgeAutomation === undefined) {
    await options.api.sendMessage({
      chatId,
      replyToMessageId: message.message_id,
      text: '对话自动学习：⚠️ 当前服务未配置。',
    });
    return;
  }

  if (command === 'status') {
    try {
      const status = await options.knowledgeAutomation.getLearningStatus(chatId);
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: formatTelegramKnowledgeLearningStatus(status),
      });
    } catch {
      options.logger?.error(`Telegram knowledge learning status read failed for ${chatId}.`);
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: '对话自动学习状态：暂时无法读取，请稍后再试。',
      });
    }
    return;
  }

  let result: TelegramKnowledgeLearningChangeResult;
  try {
    result = await options.knowledgeAutomation.setLearningEnabled({
      chatId,
      enabled: command === 'enable',
      ...(message.from?.id === undefined || message.from.is_bot === true || message.sender_chat
        ? {}
        : { requestedByUserId: message.from.id }),
    });
  } catch {
    options.logger?.error(`Telegram knowledge learning setting update failed for ${chatId}.`);
    await options.api.sendMessage({
      chatId,
      replyToMessageId: message.message_id,
      text: '对话自动学习设置失败，请稍后再试。',
    });
    return;
  }

  if (!result.authorized) {
    const text =
      result.reason === 'administrator_verification_unavailable'
        ? '暂时无法验证群管理员身份，自动学习设置未更改。'
        : '只有当前群管理员可以开启或关闭自动学习。';
    await options.api.sendMessage({
      chatId,
      replyToMessageId: message.message_id,
      text,
    });
    return;
  }

  await options.api.sendMessage({
    chatId,
    replyToMessageId: message.message_id,
    text: `${result.changed ? '设置已更新。\n' : ''}${formatTelegramKnowledgeLearningStatus(
      result.status,
    )}`,
  });
}

export function formatTelegramKnowledgeLearningStatus(
  status: TelegramKnowledgeLearningStatus,
): string {
  const lines = [
    `对话自动学习：${status.enabled ? '✅ 已开启' : '⏸ 已关闭'}`,
    `设置来源：${status.settingSource === 'chat_override' ? '本群管理员设置' : '服务默认配置'}`,
  ];
  if (status.enabled) {
    lines.push(
      `分析范围：管理员回复用户的同一对话链（最多 ${status.contextMessageLimit} 条消息）`,
      '进化方式：生成知识候选 → 严格自动治理 → 独立刷新任务发布',
    );
  }
  lines.push(
    `知识进度：候选 ${status.progress.candidateCount}，已发布 ${status.progress.publishedCount}，待发布 ${status.progress.approvedCount}，处理中 ${status.progress.pendingCount}，已拒绝 ${status.progress.rejectedCount}`,
  );
  if (status.progress.lastAnalyzedAt !== undefined) {
    lines.push(`最近分析：${formatTelegramLearningTime(status.progress.lastAnalyzedAt)}`);
  }
  lines.push('管理员命令：/learning_on 开启，/learning_off 关闭');
  return lines.join('\n');
}

async function readTelegramKnowledgeRefreshStatus(
  options: CreateTelegramBotOptions,
): Promise<string> {
  if (options.getKnowledgeRefreshStatus === undefined) {
    return '知识库自动更新状态：暂时无法读取，请稍后再试。';
  }
  try {
    return formatTelegramKnowledgeRefreshStatus(await options.getKnowledgeRefreshStatus());
  } catch {
    options.logger?.error('Telegram knowledge refresh status read failed.');
    return '知识库自动更新状态：暂时无法读取，请稍后再试。';
  }
}

export function formatTelegramKnowledgeRefreshStatus(status: KnowledgeRefreshStatus): string {
  const lines = [`知识库自动更新：${telegramRefreshStateLabel(status)}`];
  if (status.enabled) {
    lines.push(
      `增量更新：每日 ${status.schedule.incrementalDailyAt}`,
      '全量更新：仅手动执行',
      `计划时区：${status.schedule.timeZone}`,
    );
  }
  if (status.lastRun !== undefined) {
    lines.push(
      `最近刷新：${formatTelegramRefreshTime(status.lastRun.finishedAt, status.schedule.timeZone)}`,
      `最近结果：${status.lastRun.status === 'succeeded' ? '成功' : '失败'}（${
        status.lastRun.mode === 'full' ? '全量' : '增量'
      }）`,
    );
  }
  return lines.join('\n');
}

function telegramRefreshStateLabel(status: KnowledgeRefreshStatus): string {
  switch (status.state) {
    case 'healthy':
      return '✅ 已开启，运行正常';
    case 'pending':
      return '🕓 已开启，等待首次刷新';
    case 'stale':
      return '⚠️ 已开启，刷新延迟';
    case 'failed':
      return '❌ 已开启，最近刷新失败';
    case 'unavailable':
      return '⚠️ 已开启，状态暂不可用';
    case 'disabled':
      return '⏸ 未开启';
  }
}

function formatTelegramRefreshTime(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      month: '2-digit',
      timeZone,
      year: 'numeric',
    }).format(date);
  } catch {
    return value;
  }
}

function attachmentFallbackLines(
  attachments: ChatResponse['attachments'],
  publicBaseUrl: string | undefined,
  screenshotDirectory: string | undefined,
  canSendVideo: boolean,
): string[] {
  return (attachments ?? []).flatMap((attachment) => {
    const url = resolveTelegramAttachmentUrl(attachment.url, publicBaseUrl);
    if (attachment.kind === 'image') {
      const photo = resolveTelegramPhotoAttachment(
        attachment.url,
        attachment.mediaType,
        publicBaseUrl,
        screenshotDirectory,
      );
      return photo === undefined || !isTelegramPhotoMediaType(attachment.mediaType)
        ? [`附件：${attachment.title} ${url ?? attachment.url}`]
        : [];
    }
    if (attachment.mediaType === 'video/mp4' && canSendVideo && url !== undefined) {
      return [];
    }
    return [`视频：${attachment.title} ${url ?? attachment.url}`];
  });
}

function resolveTelegramPhotoAttachment(
  url: string,
  mediaType: string,
  publicBaseUrl: string | undefined,
  screenshotDirectory: string | undefined,
): TelegramSendPhotoInput['photo'] | undefined {
  const match = url.match(/^\/xxyy-evidence\/([0-9a-f]{64}\.png)$/u);
  if (match?.[1] !== undefined && screenshotDirectory !== undefined && mediaType === 'image/png') {
    return {
      filePath: path.join(path.resolve(screenshotDirectory), match[1]),
      filename: match[1],
      mediaType: 'image/png',
    };
  }
  return resolveTelegramAttachmentUrl(url, publicBaseUrl);
}

function isTelegramPhotoMediaType(mediaType: string): boolean {
  return mediaType === 'image/jpeg' || mediaType === 'image/png';
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(parsePositiveInteger(value, fallback), maximum));
}

function parseBoolean(value: string | undefined, fallback: boolean, field: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) {
    return fallback;
  }
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  throw new TelegramBotConfigurationError(`${field} must be true or false.`);
}

function formatTelegramLearningTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(date);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function sleep(ms: number, abortSignal: AbortSignal | undefined): Promise<void> {
  if (abortSignal?.aborted === true) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
