import {
  knowledgeSourceCatalog,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamEvent,
  type KnowledgeRefreshStatus,
} from '@xxyy/shared';
import type { ChatService } from '@xxyy/rag-core';

export interface TelegramBotConfig {
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
  getUpdates(input: TelegramGetUpdatesInput): Promise<TelegramUpdate[]>;
  sendChatAction?(input: TelegramSendChatActionInput): Promise<void>;
  sendMessage(input: TelegramSendMessageInput): Promise<void>;
  sendMessageDraft?(input: TelegramSendMessageDraftInput): Promise<void>;
  sendPhoto(input: TelegramSendPhotoInput): Promise<void>;
  sendVideo?(input: TelegramSendVideoInput): Promise<void>;
  setMyCommands?(input: TelegramSetMyCommandsInput): Promise<void>;
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
}

type TelegramChatService = Pick<ChatService, 'ask'> & Partial<Pick<ChatService, 'stream'>>;

export interface TelegramBotLogger {
  error(message: string, error?: unknown): void;
  info(message: string): void;
}

export type TelegramBotEnv = Record<string, string | undefined> &
  Partial<
    Record<
      | 'TELEGRAM_BOT_TOKEN'
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
const TELEGRAM_DRAFT_UPDATE_MIN_CHARS = 80;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_TYPING_REFRESH_MS = 4000;
const HELP_TEXT = [
  '我是 XXYY 客服 Bot，可以回答产品功能、配置步骤、权益说明和官方更新相关问题。',
  '',
  '直接发送具体的 XXYY 产品问题即可。',
  '发送 /status 可查看知识库自动更新状态。',
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

  return {
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

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (message === undefined) {
      return;
    }

    const chatId = message.chat.id;
    const text = message.text?.trim();
    if (text === undefined || text.length === 0) {
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: UNSUPPORTED_MESSAGE_TEXT,
      });
      return;
    }

    if (isHelpCommand(text)) {
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: HELP_TEXT,
      });
      return;
    }

    if (isKnowledgeRefreshStatusCommand(text)) {
      await options.api.sendMessage({
        chatId,
        replyToMessageId: message.message_id,
        text: await readTelegramKnowledgeRefreshStatus(options),
      });
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

    const request = createTelegramChatRequest(message, text);
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

      await sendChatResponse(options.api, chatId, response, options.config, message.message_id);
    });
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
  config: Pick<TelegramBotConfig, 'publicBaseUrl'>,
  replyToMessageId?: number,
): Promise<void> {
  const attachmentLines = attachmentFallbackLines(
    response.attachments,
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

  for (const attachment of response.attachments ?? []) {
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
    ...citations.flatMap((citation, index) => [
      `${index + 1}. ${telegramCitationSourcePrefix(citation)}${citation.title}${
        citation.sourceUrl === undefined ? '' : ` ${citation.sourceUrl}`
      }`,
      citation.file,
      citation.excerpt,
    ]),
  ];
}

function telegramCitationLines(citations: ChatResponse['citations']): string[] {
  if (citations.length === 0) {
    return [];
  }

  return [
    '',
    '<b>来源</b>',
    ...citations.flatMap((citation, index) => [
      `${index + 1}. ${telegramCitationTitle(citation)}`,
      `<code>${escapeHtml(citation.file)}</code>`,
      escapeHtml(citation.excerpt),
    ]),
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

function readTelegramCommand(text: string): string | undefined {
  return text.split(/\s+/u)[0]?.toLowerCase().split('@')[0];
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
      `增量更新：每 ${status.schedule.incrementalEveryMinutes} 分钟`,
      `全量更新：每日 ${status.schedule.fullDailyAt}`,
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
