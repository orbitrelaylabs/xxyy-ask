import { classifyQuestion } from './classify.js';
import {
  sanitizeKnowledgeCandidateText,
  type CreateKnowledgeCandidateInput,
  type KnowledgeAuthorVerification,
} from './knowledge-candidates.js';
import { normalizeTelegramUserId, type TrustedAuthor } from './trusted-authors.js';

export interface TelegramKnowledgeMessage {
  id: string;
  index: number;
  text: string;
  authorUserId?: string;
  replyToMessageId?: string;
  timestamp?: string;
}

export interface TelegramKnowledgeExport {
  messages: TelegramKnowledgeMessage[];
  chatId?: string;
}

export interface TelegramConversationThread {
  contextMessageIds: string[];
  messageIds: string[];
  messages: TelegramKnowledgeMessage[];
  rootMessageId: string;
}

export interface ExtractTelegramCandidateOptions {
  /** @deprecated Use explicitAdminUserIds. */
  adminUserIds?: ReadonlySet<string>;
  explicitAdminUserIds?: ReadonlySet<string>;
  currentAdministratorUserIds?: ReadonlySet<string>;
  currentAdministratorVerifiedAt?: string;
  trustedAuthors?: readonly TrustedAuthor[];
  adjacentContextMessages?: number;
  curatorPromptVersion?: string;
  curatorRunId?: string;
  productContext?: 'xxyy';
}

export interface ExtractTelegramCandidateResult {
  authorVerifications: Record<string, KnowledgeAuthorVerification>;
  candidates: CreateKnowledgeCandidateInput[];
  threads: TelegramConversationThread[];
  adminReplyCount: number;
  messageCount: number;
  skippedBoundaryCount: number;
  skippedMissingReplyCount: number;
  unverifiedAuthorMessageCount: number;
  verifiedAuthorMessageCount: number;
}

interface RawTelegramExportMessage {
  date?: string;
  date_unixtime?: string;
  from_id?: string;
  id: number | string;
  reply_to_message_id?: number | string;
  text?: unknown;
  type?: string;
}

interface RawTelegramExport {
  id?: number | string;
  messages: RawTelegramExportMessage[];
}

interface ResolvedKnowledgeAuthor {
  isVerified: boolean;
  verification: KnowledgeAuthorVerification;
}

const DEFAULT_ADJACENT_CONTEXT_MESSAGES = 1;
const MAX_CURRENT_ADMIN_VERIFICATION_AGE_MS = 10 * 60 * 1_000;
const KNOWLEDGE_ROLES = new Set(['administrator', 'knowledge_editor', 'owner']);
const OFFICIAL_SOURCE_HOSTS = new Set(['docs.xxyy.io', 'x.com']);
const IMPLICIT_XXYY_PRODUCT_SIGNAL =
  /(?:\b(?:bsc|bnb|base|solana|sol|usdt|usdc|evm|swap|token|wallet|launchpad)\b|链|币|交易|钱包|发射台|止盈|止损|监控|提醒|挂单|订单|代币|池子)/iu;

export function readTelegramKnowledgeExport(value: unknown): TelegramKnowledgeExport {
  const rawExport = readRawTelegramExport(value);
  const messages = rawExport.messages
    .filter(isOrdinaryMessage)
    .map((message, index): TelegramKnowledgeMessage => {
      const text = flattenTelegramText(message.text).trim();
      const authorUserId = normalizeOptionalTelegramUserId(message.from_id);
      const timestamp = readMessageTimestamp(message);
      return {
        id: String(message.id),
        index,
        text,
        ...(authorUserId === undefined ? {} : { authorUserId }),
        ...(message.reply_to_message_id === undefined
          ? {}
          : { replyToMessageId: String(message.reply_to_message_id) }),
        ...(timestamp === undefined ? {} : { timestamp }),
      };
    });
  const messageIds = new Set<string>();
  for (const message of messages) {
    if (messageIds.has(message.id)) {
      throw new Error(`Telegram export contains duplicate message id ${message.id}.`);
    }
    messageIds.add(message.id);
  }

  return {
    messages,
    ...(rawExport.id === undefined ? {} : { chatId: String(rawExport.id) }),
  };
}

export function reconstructTelegramConversationThreads(
  input: TelegramKnowledgeExport,
  adjacentContextMessages = DEFAULT_ADJACENT_CONTEXT_MESSAGES,
): TelegramConversationThread[] {
  const messagesById = new Map(input.messages.map((message) => [message.id, message]));
  const rootByMessageId = new Map<string, string>();
  for (const message of input.messages) {
    rootByMessageId.set(message.id, findThreadRoot(message, messagesById));
  }

  const grouped = new Map<string, TelegramKnowledgeMessage[]>();
  for (const message of input.messages) {
    const rootId = rootByMessageId.get(message.id) ?? message.id;
    const group = grouped.get(rootId) ?? [];
    group.push(message);
    grouped.set(rootId, group);
  }

  const contextRadius = normalizeContextRadius(adjacentContextMessages);
  return [...grouped.entries()]
    .map(([rootMessageId, group]): TelegramConversationThread => {
      const sortedGroup = [...group].sort(compareTelegramMessages);
      const contextIds = new Set(sortedGroup.map((message) => message.id));
      for (const message of sortedGroup) {
        const lower = Math.max(0, message.index - contextRadius);
        const upper = Math.min(input.messages.length - 1, message.index + contextRadius);
        for (let index = lower; index <= upper; index += 1) {
          const contextMessage = input.messages[index];
          if (contextMessage !== undefined) {
            contextIds.add(contextMessage.id);
          }
        }
      }
      const messages = input.messages.filter((message) => contextIds.has(message.id));
      return {
        contextMessageIds: messages.map((message) => message.id),
        messageIds: sortedGroup.map((message) => message.id),
        messages,
        rootMessageId,
      };
    })
    .sort((left, right) => {
      const leftIndex = messagesById.get(left.rootMessageId)?.index ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = messagesById.get(right.rootMessageId)?.index ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
}

export function extractTelegramKnowledgeCandidates(
  rawExport: unknown,
  options: ExtractTelegramCandidateOptions = {},
): ExtractTelegramCandidateResult {
  const telegramExport = readTelegramKnowledgeExport(rawExport);
  const threads = reconstructTelegramConversationThreads(
    telegramExport,
    options.adjacentContextMessages,
  );
  const threadByMessageId = new Map<string, TelegramConversationThread>();
  for (const thread of threads) {
    for (const messageId of thread.messageIds) {
      threadByMessageId.set(messageId, thread);
    }
  }
  const messagesById = new Map(
    telegramExport.messages.map((message) => [message.id, message] as const),
  );
  const explicitAdminUserIds = normalizeUserIdSet(
    new Set([...(options.adminUserIds ?? []), ...(options.explicitAdminUserIds ?? [])]),
  );
  const currentAdministratorUserIds = normalizeUserIdSet(options.currentAdministratorUserIds);
  const candidates: CreateKnowledgeCandidateInput[] = [];
  const authorVerifications: Record<string, KnowledgeAuthorVerification> = {};
  let adminReplyCount = 0;
  let skippedBoundaryCount = 0;
  let skippedMissingReplyCount = 0;
  let unverifiedAuthorMessageCount = 0;
  let verifiedAuthorMessageCount = 0;

  for (const answerMessage of telegramExport.messages) {
    if (answerMessage.text.length === 0) {
      continue;
    }
    const author = resolveKnowledgeAuthor(answerMessage, telegramExport.chatId, {
      currentAdministratorUserIds,
      currentAdministratorVerifiedAt: options.currentAdministratorVerifiedAt,
      explicitAdminUserIds,
      trustedAuthors: options.trustedAuthors ?? [],
    });
    if (!author.isVerified) {
      unverifiedAuthorMessageCount += 1;
      continue;
    }
    verifiedAuthorMessageCount += 1;
    authorVerifications[answerMessage.id] = author.verification;
    adminReplyCount += 1;

    const directQuestionMessage =
      answerMessage.replyToMessageId === undefined
        ? undefined
        : messagesById.get(answerMessage.replyToMessageId);
    const adjacentQuestionMessage =
      answerMessage.replyToMessageId === undefined
        ? findAdjacentQuestionMessage(answerMessage, telegramExport.messages)
        : undefined;
    const questionMessage = directQuestionMessage ?? adjacentQuestionMessage;
    if (questionMessage === undefined || questionMessage.text.length === 0) {
      skippedMissingReplyCount += 1;
      continue;
    }
    const questionAuthor = resolveKnowledgeAuthor(questionMessage, telegramExport.chatId, {
      currentAdministratorUserIds,
      currentAdministratorVerifiedAt: options.currentAdministratorVerifiedAt,
      explicitAdminUserIds,
      trustedAuthors: options.trustedAuthors ?? [],
    });
    if (questionAuthor.isVerified) {
      skippedMissingReplyCount += 1;
      continue;
    }

    const rawQuestion = sanitizeKnowledgeCandidateText(questionMessage.text, 'question');
    const canonicalAnswer = sanitizeKnowledgeCandidateText(answerMessage.text, 'canonicalAnswer');
    const { classification, question } = classifyTelegramKnowledgeQuestion(
      rawQuestion,
      options.productContext,
    );
    if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
      skippedBoundaryCount += 1;
      continue;
    }

    const sourceUrl = firstHttpsUrl(canonicalAnswer);
    const riskFlags = createRiskFlags({
      answer: canonicalAnswer,
      authorVerification: author.verification,
      question,
      sourceUrl,
      timestamp: answerMessage.timestamp,
    });
    const thread = threadByMessageId.get(answerMessage.id);
    const adjacentPair =
      directQuestionMessage === undefined && adjacentQuestionMessage !== undefined;
    candidates.push({
      authorVerification: author.verification,
      canonicalAnswer: normalizeKnowledgeAnswer(canonicalAnswer),
      contextMessageIds: thread?.contextMessageIds ?? [questionMessage.id, answerMessage.id],
      extractionMethod: adjacentPair
        ? 'deterministic_adjacent_admin_message'
        : 'deterministic_direct_reply',
      question: normalizeKnowledgeQuestion(question),
      qualityScore: calculateCandidateQuality(riskFlags),
      riskFlags,
      sourceChannel: 'telegram_export',
      ...(answerMessage.timestamp === undefined ? {} : { effectiveAt: answerMessage.timestamp }),
      evidence: adjacentPair
        ? `Telegram adjacent administrator message ${answerMessage.id} after user message ${questionMessage.id}.`
        : `Telegram export reply ${answerMessage.id} to message ${questionMessage.id}.`,
      proposedModule: classification.intent === 'how_to' ? '操作指南' : '产品功能',
      proposedTitle: createProposedTitle(question),
      sourceAnswerMessageId: answerMessage.id,
      sourceAnswerText: canonicalAnswer,
      ...(telegramExport.chatId === undefined ? {} : { sourceChatId: telegramExport.chatId }),
      sourceQuestionMessageId: questionMessage.id,
      sourceQuestionText: question,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(answerMessage.authorUserId === undefined
        ? {}
        : { submittedBy: answerMessage.authorUserId }),
      ...(options.curatorPromptVersion === undefined
        ? {}
        : { curatorPromptVersion: options.curatorPromptVersion }),
      ...(options.curatorRunId === undefined ? {} : { curatorRunId: options.curatorRunId }),
    });
  }

  return {
    adminReplyCount,
    authorVerifications,
    candidates,
    messageCount: telegramExport.messages.length,
    skippedBoundaryCount,
    skippedMissingReplyCount,
    threads,
    unverifiedAuthorMessageCount,
    verifiedAuthorMessageCount,
  };
}

function classifyTelegramKnowledgeQuestion(
  question: string,
  productContext: ExtractTelegramCandidateOptions['productContext'],
): { classification: ReturnType<typeof classifyQuestion>; question: string } {
  const classification = classifyQuestion(question);
  if (
    productContext !== 'xxyy' ||
    !IMPLICIT_XXYY_PRODUCT_SIGNAL.test(question) ||
    classification.intent === 'product_qa' ||
    classification.intent === 'how_to'
  ) {
    return { classification, question };
  }
  const contextualizedQuestion = `关于 XXYY，${question}`;
  const contextualizedClassification = classifyQuestion(contextualizedQuestion);
  return contextualizedClassification.intent === 'product_qa' ||
    contextualizedClassification.intent === 'how_to'
    ? { classification: contextualizedClassification, question: contextualizedQuestion }
    : { classification, question };
}

function findAdjacentQuestionMessage(
  answerMessage: TelegramKnowledgeMessage,
  messages: readonly TelegramKnowledgeMessage[],
): TelegramKnowledgeMessage | undefined {
  if (answerMessage.replyToMessageId !== undefined || answerMessage.index <= 0) {
    return undefined;
  }
  const previous = messages[answerMessage.index - 1];
  if (previous === undefined || previous.text.length === 0 || previous.authorUserId === undefined) {
    return undefined;
  }
  return previous;
}

function resolveKnowledgeAuthor(
  message: TelegramKnowledgeMessage,
  chatId: string | undefined,
  options: {
    currentAdministratorUserIds: ReadonlySet<string>;
    currentAdministratorVerifiedAt: string | undefined;
    explicitAdminUserIds: ReadonlySet<string>;
    trustedAuthors: readonly TrustedAuthor[];
  },
): ResolvedKnowledgeAuthor {
  if (message.authorUserId === undefined) {
    return {
      isVerified: false,
      verification: { source: 'unknown', status: 'anonymous' },
    };
  }

  const trustedAuthor = findTrustedAuthor(
    options.trustedAuthors,
    chatId,
    message.authorUserId,
    message.timestamp,
  );
  if (trustedAuthor !== undefined && KNOWLEDGE_ROLES.has(trustedAuthor.role)) {
    return {
      isVerified: true,
      verification: {
        role: trustedAuthor.role,
        source: trustedAuthor.verificationSource,
        status: 'trusted_author',
        userId: trustedAuthor.userId,
        validFrom: trustedAuthor.validFrom,
        ...(trustedAuthor.validTo === undefined ? {} : { validTo: trustedAuthor.validTo }),
        verifiedAt: trustedAuthor.verifiedAt,
      },
    };
  }

  if (options.explicitAdminUserIds.has(message.authorUserId)) {
    return {
      isVerified: true,
      verification: {
        role: 'administrator',
        source: 'explicit_admin_id',
        status: 'explicit_admin_id',
        userId: message.authorUserId,
      },
    };
  }

  if (options.currentAdministratorUserIds.has(message.authorUserId)) {
    return {
      isVerified: true,
      verification: {
        role: 'administrator',
        source: 'telegram_api',
        status: 'telegram_api_current',
        userId: message.authorUserId,
        verifiedAt: normalizeVerificationTimestamp(options.currentAdministratorVerifiedAt),
      },
    };
  }

  return {
    isVerified: false,
    verification: {
      source: 'unknown',
      status: 'unverified',
      userId: message.authorUserId,
    },
  };
}

function normalizeVerificationTimestamp(value: string | undefined): string {
  if (value === undefined) {
    return new Date().toISOString();
  }
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error('currentAdministratorVerifiedAt must be a valid timestamp.');
  }
  return new Date(value).toISOString();
}

function findTrustedAuthor(
  authors: readonly TrustedAuthor[],
  chatId: string | undefined,
  userId: string,
  timestamp: string | undefined,
): TrustedAuthor | undefined {
  if (chatId === undefined || timestamp === undefined) {
    return undefined;
  }
  const at = Date.parse(timestamp);
  return authors
    .filter(
      (author) =>
        author.chatId === chatId &&
        author.userId === userId &&
        Date.parse(author.validFrom) <= at &&
        (author.validTo === undefined || at < Date.parse(author.validTo)),
    )
    .sort((left, right) => Date.parse(right.validFrom) - Date.parse(left.validFrom))[0];
}

function createRiskFlags(input: {
  answer: string;
  authorVerification: KnowledgeAuthorVerification;
  question: string;
  sourceUrl: string | undefined;
  timestamp: string | undefined;
}): string[] {
  const flags = new Set<string>();
  if (input.timestamp === undefined) {
    flags.add('missing_message_timestamp');
  }
  if (
    input.authorVerification.status === 'telegram_api_current' &&
    !isContemporaneousAdministratorVerification(
      input.timestamp,
      input.authorVerification.verifiedAt,
    )
  ) {
    flags.add('historical_role_unverified');
  }
  if (input.authorVerification.status === 'explicit_admin_id') {
    flags.add('unversioned_explicit_admin');
  }
  if (input.answer.length < 12) {
    flags.add('short_answer');
  }
  if (/可能|大概|应该|不确定|maybe|probably|i think/iu.test(input.answer)) {
    flags.add('uncertain_language');
  }
  if (hasUserSpecificKnowledgeSignal(`${input.question}\n${input.answer}`)) {
    flags.add('possible_user_specific_case');
  }
  if (
    /\[(?:email|evm_address|phone|sensitive_credential|solana_signature|telegram_user|transaction_hash)\]/u.test(
      `${input.question}\n${input.answer}`,
    )
  ) {
    flags.add('redacted_sensitive_data');
  }
  if (input.sourceUrl === undefined) {
    flags.add('missing_official_source');
  } else if (!isOfficialSourceUrl(input.sourceUrl)) {
    flags.add('non_official_source');
  }
  return [...flags].sort();
}

function isContemporaneousAdministratorVerification(
  messageTimestamp: string | undefined,
  verifiedAt: string | undefined,
): boolean {
  if (messageTimestamp === undefined || verifiedAt === undefined) {
    return false;
  }
  const ageMs = Math.abs(Date.parse(verifiedAt) - Date.parse(messageTimestamp));
  return Number.isFinite(ageMs) && ageMs <= MAX_CURRENT_ADMIN_VERIFICATION_AGE_MS;
}

function calculateCandidateQuality(riskFlags: readonly string[]): number {
  const penalties: Record<string, number> = {
    historical_role_unverified: 0.2,
    missing_message_timestamp: 0.1,
    missing_official_source: 0.08,
    non_official_source: 0.12,
    possible_user_specific_case: 0.25,
    redacted_sensitive_data: 0.25,
    short_answer: 0.12,
    uncertain_language: 0.18,
    unversioned_explicit_admin: 0.05,
  };
  const score = riskFlags.reduce((value, flag) => value - (penalties[flag] ?? 0.04), 0.95);
  return Math.round(Math.max(0, Math.min(1, score)) * 10_000) / 10_000;
}

function hasUserSpecificKnowledgeSignal(value: string): boolean {
  return /你的|您的|该用户|这个用户|订单号|余额(?:是|为)|账户(?:是|为)|your\s+(?:account|balance|order)|this\s+user/iu.test(
    value,
  );
}

function normalizeKnowledgeQuestion(question: string): string {
  return question
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function normalizeKnowledgeAnswer(answer: string): string {
  return answer
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function createProposedTitle(question: string): string {
  const title = question.replace(/[?？!！。\s]+$/gu, '').trim();
  return title.length <= 80 ? title : `${title.slice(0, 77)}...`;
}

function isOfficialSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!OFFICIAL_SOURCE_HOSTS.has(url.hostname.toLowerCase())) {
      return false;
    }
    return url.hostname.toLowerCase() !== 'x.com' || url.pathname.startsWith('/useXXYYio');
  } catch {
    return false;
  }
}

function findThreadRoot(
  message: TelegramKnowledgeMessage,
  messagesById: ReadonlyMap<string, TelegramKnowledgeMessage>,
): string {
  const visited = new Set<string>([message.id]);
  let current = message;
  while (current.replyToMessageId !== undefined) {
    if (visited.has(current.replyToMessageId)) {
      return [...visited].sort()[0] ?? message.id;
    }
    const parent = messagesById.get(current.replyToMessageId);
    if (parent === undefined) {
      return current.replyToMessageId;
    }
    visited.add(parent.id);
    current = parent;
  }
  return current.id;
}

function compareTelegramMessages(
  left: TelegramKnowledgeMessage,
  right: TelegramKnowledgeMessage,
): number {
  return left.index - right.index || left.id.localeCompare(right.id);
}

function normalizeContextRadius(value: number): number {
  return Number.isInteger(value) && value >= 0
    ? Math.min(value, 5)
    : DEFAULT_ADJACENT_CONTEXT_MESSAGES;
}

function normalizeUserIdSet(values: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (values === undefined) {
    return new Set();
  }
  return new Set([...values].map(normalizeTelegramUserId));
}

function normalizeOptionalTelegramUserId(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return normalizeTelegramUserId(value);
}

function readRawTelegramExport(value: unknown): RawTelegramExport {
  if (!isObject(value) || !Array.isArray(value.messages)) {
    throw new Error('Telegram export must be a JSON object with a messages array.');
  }

  const messages: RawTelegramExportMessage[] = [];
  value.messages.forEach((message, index) => {
    if (!isObject(message) || !isMessageId(message.id)) {
      throw new Error(`Invalid Telegram export message at index ${index}.`);
    }
    messages.push({
      id: message.id,
      ...(typeof message.date === 'string' ? { date: message.date } : {}),
      ...(typeof message.date_unixtime === 'string'
        ? { date_unixtime: message.date_unixtime }
        : {}),
      ...(typeof message.from_id === 'string' ? { from_id: message.from_id } : {}),
      ...(isMessageId(message.reply_to_message_id)
        ? { reply_to_message_id: message.reply_to_message_id }
        : {}),
      ...('text' in message ? { text: message.text } : {}),
      ...(typeof message.type === 'string' ? { type: message.type } : {}),
    });
  });

  return {
    messages,
    ...(isMessageId(value.id) ? { id: value.id } : {}),
  };
}

function isOrdinaryMessage(message: RawTelegramExportMessage): boolean {
  return message.type === undefined || message.type === 'message';
}

function flattenTelegramText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (isObject(part) && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

function readMessageTimestamp(message: RawTelegramExportMessage): string | undefined {
  if (message.date_unixtime !== undefined && /^\d+$/u.test(message.date_unixtime)) {
    const timestamp = Number(message.date_unixtime) * 1000;
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }
  if (
    message.date !== undefined &&
    /(?:Z|[+-]\d{2}:?\d{2})$/u.test(message.date) &&
    Number.isFinite(Date.parse(message.date))
  ) {
    return new Date(message.date).toISOString();
  }
  return undefined;
}

function firstHttpsUrl(text: string): string | undefined {
  const match = /https:\/\/[^\s<>()]+/u.exec(text);
  return match?.[0]?.replace(/[.,，。；;!?！？]+$/u, '');
}

function isMessageId(value: unknown): value is number | string {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.trim().length > 0)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
