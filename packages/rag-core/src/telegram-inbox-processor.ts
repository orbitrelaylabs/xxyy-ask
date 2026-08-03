import type { ImportTelegramKnowledgeResult } from './knowledge-governance-service.js';
import { UnverifiedTelegramKnowledgeAuthorError } from './knowledge-governance-service.js';
import { createTelegramInboxKnowledgeExport } from './telegram-inbox.js';
import type { PgTelegramGroupMessageStore } from './telegram-group-messages.js';

export interface TelegramInboxProcessingResult {
  agentFailedThreadCount: number;
  candidateCount: number;
  createdCount: number;
  duplicateCount: number;
  processedMessageCount: number;
  requeuedMessageCount: number;
  retainedMessageCount: number;
  skippedBoundaryCount: number;
  skippedMissingReplyCount: number;
  unverifiedAuthorMessageCount: number;
}

export async function processTelegramKnowledgeInbox(input: {
  chatId: string;
  importTelegram(input: {
    curationMode: 'auto';
    manualReviewRequired: true;
    rawExport: unknown;
    runAutomation: false;
    sourceChannel: 'telegram';
  }): Promise<ImportTelegramKnowledgeResult>;
  telegramMessages: PgTelegramGroupMessageStore;
  reprocess?: boolean;
}): Promise<TelegramInboxProcessingResult> {
  let requeuedMessageCount = 0;
  if (input.reprocess === true) {
    const processedMessages = await input.telegramMessages.list({
      chatId: input.chatId,
      limit: 2_000,
      processingStatus: 'processed',
    });
    requeuedMessageCount = await input.telegramMessages.markUnprocessed({
      chatId: input.chatId,
      messageIds: processedMessages.map((message) => message.messageId),
    });
  }
  const unprocessedMessages = await input.telegramMessages.list({
    chatId: input.chatId,
    limit: 2_000,
    processingStatus: 'unprocessed',
  });
  const unprocessedIds = unprocessedMessages.map((message) => message.messageId);
  if (unprocessedIds.length === 0) return emptyResult(requeuedMessageCount);

  const messagesById = new Map(unprocessedMessages.map((message) => [message.messageId, message]));
  let replyIds = unprocessedMessages.flatMap((message) =>
    message.replyToMessageId === undefined ? [] : [message.replyToMessageId],
  );
  for (let depth = 0; depth < 8 && replyIds.length > 0; depth += 1) {
    const missingReplyIds = [
      ...new Set(replyIds.filter((messageId) => !messagesById.has(messageId))),
    ];
    if (missingReplyIds.length === 0) break;
    const replyMessages = await input.telegramMessages.listByIds({
      chatId: input.chatId,
      messageIds: missingReplyIds,
    });
    for (const message of replyMessages) messagesById.set(message.messageId, message);
    replyIds = replyMessages.flatMap((message) =>
      message.replyToMessageId === undefined ? [] : [message.replyToMessageId],
    );
  }
  const inboxExport = createTelegramInboxKnowledgeExport({
    chatId: input.chatId,
    messages: [...messagesById.values()],
  });
  if (inboxExport.rawExport.messages.length === 0) {
    const processedMessageCount = await input.telegramMessages.markProcessed({
      chatId: input.chatId,
      messageIds: unprocessedIds,
      processedAt: new Date().toISOString(),
    });
    return { ...emptyResult(requeuedMessageCount), processedMessageCount };
  }
  let result: ImportTelegramKnowledgeResult;
  try {
    result = await input.importTelegram({
      curationMode: 'auto',
      manualReviewRequired: true,
      rawExport: inboxExport.rawExport,
      runAutomation: false,
      sourceChannel: 'telegram',
    });
  } catch (error) {
    if (!(error instanceof UnverifiedTelegramKnowledgeAuthorError)) throw error;
    return {
      ...emptyResult(requeuedMessageCount),
      retainedMessageCount: unprocessedIds.length,
      unverifiedAuthorMessageCount: inboxExport.rawExport.messages.length,
    };
  }
  const shouldMarkProcessed =
    result.created.length > 0 ||
    result.duplicateCount > 0 ||
    (result.verifiedAuthorMessageCount > 0 && result.agentRunStats.failedThreadCount === 0);
  const processedMessageCount = shouldMarkProcessed
    ? await input.telegramMessages.markProcessed({
        chatId: input.chatId,
        messageIds: unprocessedIds,
        processedAt: new Date().toISOString(),
      })
    : 0;
  return {
    agentFailedThreadCount: result.agentRunStats.failedThreadCount,
    candidateCount: result.candidateCount,
    createdCount: result.created.length,
    duplicateCount: result.duplicateCount,
    processedMessageCount,
    requeuedMessageCount,
    retainedMessageCount: shouldMarkProcessed ? 0 : unprocessedIds.length,
    skippedBoundaryCount: result.skippedBoundaryCount,
    skippedMissingReplyCount: result.skippedMissingReplyCount,
    unverifiedAuthorMessageCount: result.unverifiedAuthorMessageCount,
  };
}

function emptyResult(requeuedMessageCount: number): TelegramInboxProcessingResult {
  return {
    agentFailedThreadCount: 0,
    candidateCount: 0,
    createdCount: 0,
    duplicateCount: 0,
    processedMessageCount: 0,
    requeuedMessageCount,
    retainedMessageCount: 0,
    skippedBoundaryCount: 0,
    skippedMissingReplyCount: 0,
    unverifiedAuthorMessageCount: 0,
  };
}
