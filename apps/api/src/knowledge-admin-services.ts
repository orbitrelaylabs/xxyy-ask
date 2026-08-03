import {
  createKnowledgeAutomationController,
  createKnowledgeGovernanceService,
  createOpenAiKnowledgeCandidateSuggestionProvider,
  createOpenAiKnowledgeCuratorModel,
  createPgKnowledgeAdminUserStore,
  createPgFeedbackStore,
  createPgKnowledgeCandidateStore,
  createPgKnowledgeGovernanceReferenceStore,
  createPgKnowledgeGraphStore,
  createPgKnowledgeMatchInspector,
  createPgKnowledgePublicationJobStore,
  createPgQualityEvaluationJobStore,
  createPgSupportOperationsStore,
  createPgTelegramGroupRegistryStore,
  createPgTelegramGroupMessageStore,
  createPgTelegramCurationJobStore,
  createPgPool,
  createPgTrustedAuthorStore,
  fetchTelegramCurrentAdministratorIds,
  InvalidKnowledgeCandidateStateError,
  readTelegramKnowledgeExport,
  processTelegramKnowledgeInbox,
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
    const knowledgeGraph = createPgKnowledgeGraphStore({ client: pool });
    const publicationJobs = createPgKnowledgePublicationJobStore({ client: pool });
    const qualityEvaluations = createPgQualityEvaluationJobStore({ client: pool });
    const supportOperations = createPgSupportOperationsStore({ client: pool });
    const telegramGroups = createPgTelegramGroupRegistryStore({ client: pool });
    const telegramMessages = createPgTelegramGroupMessageStore({ client: pool });
    const telegramCurationJobs = createPgTelegramCurationJobStore({ client: pool });
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
    const candidateSuggestionProvider =
      options.config.openAiApiKey === undefined || options.config.openAiModel === undefined
        ? undefined
        : createOpenAiKnowledgeCandidateSuggestionProvider({
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
      knowledgeGraph,
      publicationJobs,
      qualityEvaluations,
      supportOperations,
      async suggestCandidate(input) {
        const detail = await governance.getCandidateDetail(input.id);
        if (detail === undefined) return undefined;
        if (detail.candidate.status !== 'pending') {
          throw new InvalidKnowledgeCandidateStateError(input.id, 'pending');
        }
        if (candidateSuggestionProvider === undefined) {
          throw new Error('Candidate AI suggestions require OPENAI_API_KEY and OPENAI_MODEL.');
        }
        return candidateSuggestionProvider.suggest({
          candidate: {
            ...detail.candidate,
            canonicalAnswer: input.canonicalAnswer,
            question: input.question,
          },
          conflicts: detail.conflicts,
        });
      },
      telegramGroups,
      telegramCurationJobs,
      telegramMessages,
      importTelegram,
      processTelegramInbox: (input) =>
        processTelegramKnowledgeInbox({
          ...input,
          importTelegram,
          telegramMessages,
        }),
    };
    return Promise.resolve(cached);
  };
}

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
