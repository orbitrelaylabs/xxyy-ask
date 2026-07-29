import {
  knowledgeSourceCatalog,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamEvent,
  type KnowledgeRefreshStatus,
} from '@xxyy/shared';
import { filterQuestionRelevantAttachments, type ChatService } from '@xxyy/rag-core';

export interface TelegramBotConfig {
  autoLearningContextMessages: number;
  autoLearningDefaultEnabled: boolean;
  botToken: string;
  pollErrorRetryMs: number;
  pollTimeoutSeconds: number;
  publicBaseUrl?: string;
  updatesLimit: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  chat: {
    id: number;
    type?: 'channel' | 'group' | 'private' | 'supergroup';
  };
  date?: number;
  from?: {
    id: number;
    is_bot?: boolean;
  };
  message_id: number;
  reply_to_message?: TelegramMessage;
  sender_chat?: {
    id: number;
  };
  text?: string;
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
  photo: string;
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
  knowledgeAutomation?: TelegramKnowledgeAutomation;
  logger?: TelegramBotLogger;
}

export interface TelegramKnowledgeAutomation {
  captureReply(message: TelegramMessage): Promise<boolean>;
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
  '私聊直接发送问题；群聊请 @本 Bot 或直接回复 Bot 的消息。',
  '链上能力支持公开交易基础查询、单笔 EVM 调用追踪和受控 Sandwich/MEV 分析；深度结果取决于 trace/archive Provider、readiness 与池子 allowlist。',
  '不查询账户、钱包私有记录、任意地址历史，也不代用户执行交易。',
  '发送 /status 可查看知识库自动更新状态。',
  '群聊发送 /learning 可查看自动学习状态；管理员可用 /learning_on 和 /learning_off 开关。',
].join('\n');
const UNSUPPORTED_MESSAGE_TEXT = '目前只支持文本消息，请直接发送具体的 XXYY 产品问题。';
export const TELEGRAM_BOT_COMMANDS = [
  { command: 'start', description: '开始使用 XXYY 客服' },
  { command: 'help', description: '查看客服能力说明' },
  { command: 'status', description: '查看知识库自动更新状态' },
  { command: 'learning', description: '查看群聊自动学习状态' },
  { command: 'learning_on', description: '管理员开启群聊自动学习' },
  { command: 'learning_off', description: '管理员关闭群聊自动学习' },
] as const;

export function loadTelegramBotConfig(env: TelegramBotEnv): TelegramBotConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (botToken === undefined || botToken.length === 0) {
    throw new TelegramBotConfigurationError('TELEGRAM_BOT_TOKEN is required.');
  }

  const publicBaseUrl = normalizeOptionalString(env.TELEGRAM_PUBLIC_BASE_URL);

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
    pollErrorRetryMs: parsePositiveInteger(
      env.TELEGRAM_POLL_ERROR_RETRY_MS,
      DEFAULT_POLL_ERROR_RETRY_MS,
    ),
    pollTimeoutSeconds: parsePositiveInteger(
      env.TELEGRAM_POLL_TIMEOUT_SECONDS,
      DEFAULT_POLL_TIMEOUT_SECONDS,
    ),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    updatesLimit: parsePositiveInteger(env.TELEGRAM_UPDATES_LIMIT, DEFAULT_UPDATES_LIMIT),
  };
}

export function createTelegramBot(options: CreateTelegramBotOptions): TelegramBot {
  let offset: number | undefined;
  let botIdentity: TelegramBotIdentity | undefined;
  let botIdentityRequest: Promise<TelegramBotIdentity | undefined> | undefined;

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message === undefined) {
      return;
    }

    const chatId = message.chat.id;
    const text = message.text?.trim();

    if (text !== undefined && text.length > 0 && isGroupChat(message)) {
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

    if (options.knowledgeAutomation !== undefined && isGroupChat(message)) {
      try {
        if (await options.knowledgeAutomation.captureReply(message)) {
          options.logger?.info(
            `Telegram knowledge reply ${message.chat.id}:${message.message_id} was processed.`,
          );
          return;
        }
      } catch {
        options.logger?.error(
          `Telegram knowledge automation failed for ${message.chat.id}:${message.message_id}.`,
        );
      }
    }

    let customerQuestion = text;
    if (isGroupChat(message)) {
      const identity = await readBotIdentity();
      if (identity === undefined || !isGroupCustomerRequest(message, text, identity)) {
        return;
      }
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

    const request = createTelegramChatRequest(message, customerQuestion);
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

function isGroupChat(message: TelegramMessage): boolean {
  return message.chat.type === 'group' || message.chat.type === 'supergroup';
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

function createTelegramChatRequest(message: TelegramMessage, text: string): ChatRequest {
  return {
    channel: 'telegram',
    message: text,
    requestId: `telegram:${message.chat.id}:${message.message_id}`,
    sessionId: `telegram:${message.chat.id}`,
    ...(message.from?.id === undefined ? {} : { userId: `telegram:${message.from.id}` }),
  };
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
  config: Pick<TelegramBotConfig, 'publicBaseUrl'>,
  replyToMessageId?: number,
): Promise<void> {
  const attachments = filterQuestionRelevantAttachments(question, response.attachments);
  const attachmentLines = attachmentFallbackLines(
    attachments,
    config.publicBaseUrl,
    api.sendVideo !== undefined,
  );
  const htmlMessage = formatTelegramChatResponse(response, attachmentLines);
  if (htmlMessage.length <= TELEGRAM_MESSAGE_LIMIT) {
    await api.sendMessage({
      chatId,
      parseMode: 'HTML',
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      text: htmlMessage,
    });
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
    const photo = resolveTelegramAttachmentUrl(attachment.url, config.publicBaseUrl);
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
  canSendVideo: boolean,
): string[] {
  return (attachments ?? []).flatMap((attachment) => {
    const url = resolveTelegramAttachmentUrl(attachment.url, publicBaseUrl);
    if (attachment.kind === 'image') {
      return url === undefined || !isTelegramPhotoMediaType(attachment.mediaType)
        ? [`附件：${attachment.title} ${url ?? attachment.url}`]
        : [];
    }
    if (attachment.mediaType === 'video/mp4' && canSendVideo && url !== undefined) {
      return [];
    }
    return [`视频：${attachment.title} ${url ?? attachment.url}`];
  });
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
