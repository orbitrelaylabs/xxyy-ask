import {
  createKnowledgeAutomationController,
  createKnowledgeGovernanceService,
  createOpenAiKnowledgeCuratorModel,
  createPgKnowledgeAdminUserStore,
  createPgFeedbackStore,
  createPgKnowledgeCandidateStore,
  createPgKnowledgeGovernanceReferenceStore,
  createPgKnowledgeMatchInspector,
  createPgKnowledgePublicationJobStore,
  createPgSupportOperationsStore,
  createPgTelegramGroupRegistryStore,
  createPgTelegramGroupMessageStore,
  createTelegramInboxKnowledgeExport,
  createPgPool,
  createPgTrustedAuthorStore,
  fetchTelegramCurrentAdministratorIds,
  readTelegramKnowledgeExport,
  VectorStoreConfigurationError,
} from '@xxyy/rag-core';
import type { RagConfig } from '@xxyy/rag-core';

import type { KnowledgeAdminServices } from './knowledge-admin-api.js';

export interface KnowledgeAdminServiceEnv {
  TELEGRAM_API_BASE_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
}

export function createCachedKnowledgeAdminServicesLoader(options: {
  config: RagConfig;
  env: KnowledgeAdminServiceEnv;
}): () => Promise<KnowledgeAdminServices> {
  let cached: KnowledgeAdminServices | undefined;
  const telegramBotToken = normalizeOptionalEnvValue(options.env.TELEGRAM_BOT_TOKEN);
  const telegramApiBaseUrl = normalizeOptionalEnvValue(options.env.TELEGRAM_API_BASE_URL);

  return () => {
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    if (options.config.databaseUrl === undefined) {
      throw new VectorStoreConfigurationError(
        'Knowledge administration requires DATABASE_URL or POSTGRES_* configuration.',
      );
    }

    const pool = createPgPool(options.config.databaseUrl);
    const candidateStore = createPgKnowledgeCandidateStore({ client: pool });
    const adminUsers = createPgKnowledgeAdminUserStore({ client: pool });
    const feedback = createPgFeedbackStore({ client: pool });
    const publicationJobs = createPgKnowledgePublicationJobStore({ client: pool });
    const supportOperations = createPgSupportOperationsStore({ client: pool });
    const telegramGroups = createPgTelegramGroupRegistryStore({ client: pool });
    const telegramMessages = createPgTelegramGroupMessageStore({ client: pool });
    const trustedAuthorStore = createPgTrustedAuthorStore({ client: pool });
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
        publicationJobStore: publicationJobs,
      }),
      candidateStore,
      inspector: createPgKnowledgeMatchInspector({ candidateStore, client: pool }),
      referenceStore: createPgKnowledgeGovernanceReferenceStore({ client: pool }),
      trustedAuthorStore,
      ...(curatorModel === undefined ? {} : { curatorModel }),
    });
    async function importTelegram(input: {
      curationMode: 'auto' | 'deterministic' | 'required';
      manualReviewRequired?: boolean;
      rawExport: unknown;
      runAutomation?: boolean;
      sourceChannel?: 'telegram' | 'telegram_export';
    }) {
      const telegramExport = readTelegramKnowledgeExport(input.rawExport);
      let currentAdministratorUserIds: ReadonlySet<string> | undefined;
      let currentAdministratorVerifiedAt: string | undefined;
      if (telegramExport.chatId !== undefined && telegramBotToken !== undefined) {
        try {
          currentAdministratorUserIds = await fetchTelegramCurrentAdministratorIds({
            botToken: telegramBotToken,
            chatId: telegramExport.chatId,
            ...(telegramApiBaseUrl === undefined ? {} : { apiBaseUrl: telegramApiBaseUrl }),
          });
          currentAdministratorVerifiedAt = new Date().toISOString();
        } catch (error) {
          const trustedAuthors = await trustedAuthorStore.list({
            chatId: telegramExport.chatId,
            limit: 1,
          });
          if (trustedAuthors.length === 0) {
            throw error;
          }
        }
      }
      return governance.importTelegram({
        curationMode: input.curationMode,
        ...(input.manualReviewRequired === undefined
          ? {}
          : { manualReviewRequired: input.manualReviewRequired }),
        rawExport: input.rawExport,
        ...(input.runAutomation === undefined ? {} : { runAutomation: input.runAutomation }),
        ...(input.sourceChannel === undefined ? {} : { sourceChannel: input.sourceChannel }),
        ...(currentAdministratorUserIds === undefined ? {} : { currentAdministratorUserIds }),
        ...(currentAdministratorVerifiedAt === undefined ? {} : { currentAdministratorVerifiedAt }),
      });
    }

    cached = {
      adminUsers,
      feedback,
      governance,
      publicationJobs,
      supportOperations,
      telegramGroups,
      telegramMessages,
      importTelegram,
      async processTelegramInbox(input) {
        const unprocessedMessages = await telegramMessages.list({
          chatId: input.chatId,
          limit: 2_000,
          processingStatus: 'unprocessed',
        });
        const unprocessedIds = unprocessedMessages.map((message) => message.messageId);
        if (unprocessedIds.length === 0) {
          return {
            candidateCount: 0,
            createdCount: 0,
            duplicateCount: 0,
            processedMessageCount: 0,
          };
        }
        const messagesById = new Map(
          unprocessedMessages.map((message) => [message.messageId, message]),
        );
        let replyIds = unprocessedMessages.flatMap((message) =>
          message.replyToMessageId === undefined ? [] : [message.replyToMessageId],
        );
        for (let depth = 0; depth < 8 && replyIds.length > 0; depth += 1) {
          const missingReplyIds = [
            ...new Set(replyIds.filter((messageId) => !messagesById.has(messageId))),
          ];
          if (missingReplyIds.length === 0) break;
          const replyMessages = await telegramMessages.listByIds({
            chatId: input.chatId,
            messageIds: missingReplyIds,
          });
          for (const message of replyMessages) {
            messagesById.set(message.messageId, message);
          }
          replyIds = replyMessages.flatMap((message) =>
            message.replyToMessageId === undefined ? [] : [message.replyToMessageId],
          );
        }
        const inboxExport = createTelegramInboxKnowledgeExport({
          chatId: input.chatId,
          messages: [...messagesById.values()],
        });
        if (inboxExport.rawExport.messages.length === 0) {
          const processedMessageCount = await telegramMessages.markProcessed({
            chatId: input.chatId,
            messageIds: unprocessedIds,
            processedAt: new Date().toISOString(),
          });
          return {
            candidateCount: 0,
            createdCount: 0,
            duplicateCount: 0,
            processedMessageCount,
          };
        }
        const result = await importTelegram({
          curationMode: 'auto',
          manualReviewRequired: true,
          rawExport: inboxExport.rawExport,
          runAutomation: false,
          sourceChannel: 'telegram',
        });
        const processedMessageCount = await telegramMessages.markProcessed({
          chatId: input.chatId,
          messageIds: unprocessedIds,
          processedAt: new Date().toISOString(),
        });
        return {
          candidateCount: result.candidateCount,
          createdCount: result.created.length,
          duplicateCount: result.duplicateCount,
          processedMessageCount,
        };
      },
    };
    return Promise.resolve(cached);
  };
}

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
