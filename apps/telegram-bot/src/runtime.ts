import {
  createCustomerAgentChatService,
  type AnswerQualityRolloutConfig,
  type AnswerQualityRolloutObserver,
} from '@xxyy/agent-core';
import type {
  PublicTransactionClient,
  XxyyTransactionDiagnosisHandler,
} from '@xxyy/transaction-skill-bridge';
import { createOpenAiEmbeddingProvider } from '@xxyy/knowledge';
import type {
  ChatHistoryMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  SourceType,
} from '@xxyy/shared';
import {
  createLazyRetriever,
  createOpenAiAnswerProvider,
  createPgFeedbackStore,
  createPgTelegramBotAccessStore,
  createPgPool,
  createPgSupportOperationsStore,
  createPgVectorStore,
  noopQualityTracer,
  redactSensitiveSupportText,
  type AnswerProvider,
  type ChatService,
  type PgSupportOperationsStore,
  type PgTelegramBotAccessStore,
  type RagConfig,
  type QualityTracer,
  type RecordFeedbackInput,
  type SupportMessageRole,
} from '@xxyy/rag-core';

const TELEGRAM_HISTORY_MESSAGE_LIMIT = 12;

export interface TelegramChatRuntime {
  close(): Promise<void>;
  service: ChatService;
  userDirectory: Pick<PgTelegramBotAccessStore, 'observeUser'>;
}

export function createTelegramChatRuntime(
  config: RagConfig,
  tracer: QualityTracer = noopQualityTracer,
  options: {
    answerQualityRollout?: AnswerQualityRolloutConfig;
    answerQualityRolloutObserver?: AnswerQualityRolloutObserver;
    publicTransactionClient?: PublicTransactionClient;
    supportOperationsStore?: PgSupportOperationsStore;
    telegramAccessStore?: PgTelegramBotAccessStore;
    telegramDailyQuotaTimeZone?: string;
    xxyyTransactionDiagnosis?: XxyyTransactionDiagnosisHandler;
  } = {},
): TelegramChatRuntime {
  let vectorPool: ReturnType<typeof createPgPool> | undefined;
  let feedbackPool: ReturnType<typeof createPgPool> | undefined;
  let supportPool: ReturnType<typeof createPgPool> | undefined;
  let supportStore = options.supportOperationsStore;
  let telegramAccessStore = options.telegramAccessStore;

  const retriever = createLazyRetriever(async () => {
    const nextPool = createPgPool(config.databaseUrl);

    try {
      const embeddingProvider = createOpenAiEmbeddingProvider({
        apiKey: config.embeddingApiKey,
        baseUrl: config.embeddingBaseUrl,
        maxRetries: config.openAiMaxRetries,
        model: config.openAiEmbeddingModel,
        requestTimeoutMs: config.openAiRequestTimeoutMs,
      });
      vectorPool = nextPool;
      return createPgVectorStore({
        client: nextPool,
        embeddingDimension: config.embeddingDimension,
        embeddingProvider,
        tracer,
      });
    } catch (error) {
      await nextPool.end();
      throw error;
    }
  });

  const service = createCustomerAgentChatService({
    ...(options.answerQualityRollout === undefined
      ? {}
      : { answerQualityRollout: options.answerQualityRollout }),
    ...(options.answerQualityRolloutObserver === undefined
      ? {}
      : { answerQualityRolloutObserver: options.answerQualityRolloutObserver }),
    answerProvider: createLazyAnswerProvider(config, tracer),
    config,
    productCapabilityCaller: {
      channel: 'telegram',
      principal: 'service',
    },
    ...(options.publicTransactionClient === undefined
      ? {}
      : {
          publicChainCapabilityCaller: {
            channel: 'telegram' as const,
            principal: 'service' as const,
          },
          publicTransactionClient: options.publicTransactionClient,
        }),
    ...(options.xxyyTransactionDiagnosis === undefined
      ? {}
      : {
          xxyyDiagnosisCapabilityCaller: {
            channel: 'telegram' as const,
            principal: 'service' as const,
          },
          xxyyTransactionDiagnosis: options.xxyyTransactionDiagnosis,
        }),
    retriever,
    tracer,
  });
  const recordFeedback = async (input: RecordFeedbackInput): Promise<void> => {
    feedbackPool ??= createPgPool(config.databaseUrl);
    await createPgFeedbackStore({ client: feedbackPool }).recordFeedback(input);
  };
  const getSupportOperationsStore = async (): Promise<PgSupportOperationsStore> => {
    if (supportStore !== undefined) {
      return supportStore;
    }
    supportPool ??= createPgPool(config.databaseUrl);
    supportStore = createPgSupportOperationsStore({ client: supportPool });
    return supportStore;
  };
  const getTelegramAccessStore = async (): Promise<PgTelegramBotAccessStore> => {
    if (telegramAccessStore !== undefined) return telegramAccessStore;
    supportPool ??= createPgPool(config.databaseUrl);
    telegramAccessStore = createPgTelegramBotAccessStore({ client: supportPool });
    return telegramAccessStore;
  };

  const persistedService = withLowEvidenceFeedback(
    withPersistentTelegramHistory(service, getSupportOperationsStore, tracer),
    recordFeedback,
  );

  return {
    async close() {
      const pool = vectorPool;
      vectorPool = undefined;
      const currentFeedbackPool = feedbackPool;
      feedbackPool = undefined;
      const currentSupportPool = supportPool;
      supportPool = undefined;
      supportStore = options.supportOperationsStore;
      telegramAccessStore = options.telegramAccessStore;
      await Promise.all([
        pool?.end(),
        currentFeedbackPool?.end(),
        currentSupportPool?.end(),
        options.publicTransactionClient?.close(),
      ]);
    },
    service: withTelegramBotAccessControl(persistedService, getTelegramAccessStore, {
      timeZone: options.telegramDailyQuotaTimeZone ?? 'Asia/Shanghai',
    }),
    userDirectory: {
      async observeUser(input) {
        await (await getTelegramAccessStore()).observeUser(input);
      },
    },
  };
}

export function withTelegramBotAccessControl(
  service: ChatService,
  getStore: () => Promise<PgTelegramBotAccessStore>,
  config: { timeZone: string },
): ChatService {
  const requestDecisions = new Map<string, Awaited<ReturnType<typeof consumeTelegramAccess>>>();
  const authorize = async (request: ChatRequest) => {
    const requestId = request.requestId;
    if (requestId !== undefined) {
      const existing = requestDecisions.get(requestId);
      if (existing !== undefined) return existing;
    }
    const decision = await consumeTelegramAccess(request, getStore, config);
    if (requestId !== undefined) {
      requestDecisions.set(requestId, decision);
      if (requestDecisions.size > 1_000) {
        const oldest = requestDecisions.keys().next().value;
        if (oldest !== undefined) requestDecisions.delete(oldest);
      }
    }
    return decision;
  };
  return {
    async ask(request) {
      const access = await authorize(request);
      return access.allowed ? service.ask(request) : telegramAccessDeniedResponse(access);
    },
    async *stream(request) {
      const access = await authorize(request);
      if (access.allowed) {
        yield* service.stream(request);
        return;
      }
      const response = telegramAccessDeniedResponse(access);
      yield { delta: response.answer, type: 'answer_delta' };
      yield {
        citations: response.citations,
        confidence: response.confidence,
        intent: response.intent,
        type: 'metadata',
      };
    },
  };
}

async function consumeTelegramAccess(
  request: ChatRequest,
  getStore: () => Promise<PgTelegramBotAccessStore>,
  config: { timeZone: string },
) {
  if (request.userId === undefined) {
    return {
      allowed: false,
      dailyLimit: null,
      quotaDate: '',
      reason: 'not_allowed' as const,
      remaining: null,
      used: 0,
    };
  }
  return (await getStore()).authorizeAndConsume({
    telegramUserId: request.userId,
    timeZone: config.timeZone,
  });
}

function telegramAccessDeniedResponse(input: {
  dailyLimit: number | null;
  reason: 'allowed' | 'not_allowed' | 'quota_exhausted';
}): ChatResponse {
  return {
    answer:
      input.reason === 'quota_exhausted' && input.dailyLimit !== null
        ? `今天的对话次数已用完（每天最多 ${input.dailyLimit} 次），请明天再试。`
        : '当前 Telegram 账号未获授权使用此客服 Bot，请联系管理员开通。',
    citations: [],
    confidence: 1,
    intent: 'unknown',
  };
}

export function withPersistentTelegramHistory(
  service: ChatService,
  getStore: () => Promise<PgSupportOperationsStore>,
  tracer: QualityTracer = noopQualityTracer,
): ChatService {
  return {
    async ask(request) {
      const prepared = await prepareTelegramHistory(request, getStore, tracer);
      const response = await service.ask(prepared.request);
      await persistTelegramExchange(prepared, response, getStore, tracer);
      return response;
    },
    async *stream(request) {
      const prepared = await prepareTelegramHistory(request, getStore, tracer);
      let answer = '';
      let metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined;

      for await (const event of service.stream(prepared.request)) {
        if (event.type === 'answer_delta') {
          answer += event.delta;
        } else if (event.type === 'metadata') {
          metadata = event;
        }
        yield event;
      }

      if (metadata !== undefined) {
        await persistTelegramExchange(
          prepared,
          {
            answer,
            ...(metadata.answerStatus === undefined ? {} : { answerStatus: metadata.answerStatus }),
            citations: metadata.citations,
            confidence: metadata.confidence,
            intent: metadata.intent,
            ...(metadata.agentRoute === undefined ? {} : { agentRoute: metadata.agentRoute }),
            ...(metadata.attachments === undefined ? {} : { attachments: metadata.attachments }),
            ...(metadata.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
          },
          getStore,
          tracer,
        );
      }
    },
  };
}

interface PreparedTelegramHistory {
  request: ChatRequest;
  conversationId?: string;
}

async function prepareTelegramHistory(
  request: ChatRequest,
  getStore: () => Promise<PgSupportOperationsStore>,
  tracer: QualityTracer,
): Promise<PreparedTelegramHistory> {
  if (request.sessionId === undefined) {
    return { request };
  }

  try {
    return await tracer.run(
      {
        inputs: {
          channel: request.channel,
          hasSession: true,
          historyLimit: TELEGRAM_HISTORY_MESSAGE_LIMIT,
        },
        name: 'telegram.history.load',
        output: (prepared) => ({
          historyCount: prepared.request.history?.length ?? 0,
          loaded: prepared.conversationId !== undefined,
        }),
        runType: 'tool',
      },
      async () => {
        const store = await getStore();
        const conversation = await store.ensureConversation({
          channel: request.channel,
          externalSessionId: request.sessionId as string,
          ...(request.userId === undefined ? {} : { userId: request.userId }),
        });
        const messages = await store.getRecentMessages(conversation.id, {
          limit: TELEGRAM_HISTORY_MESSAGE_LIMIT,
        });
        const storedHistory = messages.flatMap((message) => {
          const historyMessage = toChatHistoryMessage(message.content, message.role);
          return historyMessage === undefined ? [] : [historyMessage];
        });
        return {
          conversationId: conversation.id,
          request: {
            ...request,
            history: mergeTelegramHistory(storedHistory, request.history ?? []),
          },
        };
      },
    );
  } catch {
    return { request };
  }
}

function mergeTelegramHistory(
  storedHistory: readonly ChatHistoryMessage[],
  replyHistory: readonly ChatHistoryMessage[],
): ChatHistoryMessage[] {
  const merged: ChatHistoryMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...storedHistory, ...replyHistory]) {
    const content = redactSensitiveSupportText(message.content.trim()).slice(0, 2_000);
    if (content.length === 0) {
      continue;
    }
    const key = `${message.role}\u0000${content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({ content, role: message.role });
  }
  return merged.slice(-TELEGRAM_HISTORY_MESSAGE_LIMIT);
}

async function persistTelegramExchange(
  prepared: PreparedTelegramHistory,
  response: ChatResponse,
  getStore: () => Promise<PgSupportOperationsStore>,
  tracer: QualityTracer,
): Promise<void> {
  if (prepared.conversationId === undefined) {
    return;
  }

  await tracer
    .run(
      {
        inputs: {
          citationCount: response.citations.length,
          hasConversation: true,
          intent: response.intent,
        },
        name: 'telegram.history.persist',
        output: () => ({ persistedMessageCount: 2 }),
        runType: 'tool',
      },
      async () => {
        const store = await getStore();
        await store.appendMessage({
          content: prepared.request.message,
          conversationId: prepared.conversationId as string,
          role: 'user',
          ...(prepared.request.requestId === undefined
            ? {}
            : { requestId: prepared.request.requestId }),
        });
        await store.appendMessage({
          citationCount: response.citations.length,
          content: response.answer,
          conversationId: prepared.conversationId as string,
          intent: response.intent,
          role: 'assistant',
          ...(prepared.request.requestId === undefined
            ? {}
            : { requestId: prepared.request.requestId }),
        });
      },
    )
    .catch(() => undefined);
}

function toChatHistoryMessage(
  content: string,
  role: SupportMessageRole,
): ChatHistoryMessage | undefined {
  return role === 'assistant' || role === 'support_agent' || role === 'user'
    ? { content, role }
    : undefined;
}

export function withLowEvidenceFeedback(
  service: ChatService,
  recordFeedback: (input: RecordFeedbackInput) => Promise<void>,
): ChatService {
  return {
    async ask(request) {
      const response = await service.ask(request);
      await recordTelegramLowEvidence(recordFeedback, request, response);
      return response;
    },
    async *stream(request) {
      let answer = '';
      let metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined;
      for await (const event of service.stream(request)) {
        if (event.type === 'answer_delta') {
          answer += event.delta;
        } else if (event.type === 'metadata') {
          metadata = event;
        }
        yield event;
      }
      if (metadata !== undefined) {
        await recordTelegramLowEvidence(recordFeedback, request, {
          answer,
          ...(metadata.answerStatus === undefined ? {} : { answerStatus: metadata.answerStatus }),
          citations: metadata.citations,
          confidence: metadata.confidence,
          intent: metadata.intent,
          ...(metadata.agentRoute === undefined ? {} : { agentRoute: metadata.agentRoute }),
          ...(metadata.attachments === undefined ? {} : { attachments: metadata.attachments }),
          ...(metadata.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
        });
      }
    },
  };
}

async function recordTelegramLowEvidence(
  recordFeedback: (input: RecordFeedbackInput) => Promise<void>,
  request: ChatRequest,
  response: ChatResponse,
): Promise<void> {
  const comment =
    response.answerStatus === 'conflict'
      ? 'automatic_evidence_conflict'
      : response.answerStatus === 'partial'
        ? 'automatic_partial_answer'
        : 'automatic_low_evidence';
  if (
    (response.intent !== 'product_qa' && response.intent !== 'how_to') ||
    (response.citations.length > 0 &&
      response.answerStatus !== 'conflict' &&
      response.answerStatus !== 'partial')
  ) {
    return;
  }

  await recordFeedback({
    answer: response.answer,
    ...(response.answerStatus === undefined ? {} : { answerStatus: response.answerStatus }),
    channel: 'telegram',
    citationCount: response.citations.length,
    comment,
    intent: response.intent,
    question: request.message,
    rating: 'negative',
    sourceTypes: telegramFeedbackSourceTypes(response),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  }).catch(() => undefined);
}

function telegramFeedbackSourceTypes(response: ChatResponse): SourceType[] {
  return [
    ...new Set(
      response.citations.flatMap((citation) =>
        citation.sourceType === undefined ? [] : [citation.sourceType],
      ),
    ),
  ];
}

function createLazyAnswerProvider(config: RagConfig, tracer: QualityTracer): AnswerProvider {
  let cachedProvider: AnswerProvider | undefined;

  function getProvider(): AnswerProvider {
    cachedProvider ??= createOpenAiAnswerProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
      tracer,
    });
    return cachedProvider;
  }

  return {
    answer(input) {
      return getProvider().answer(input);
    },
    stream(input) {
      const provider = getProvider();
      if (provider.stream === undefined) {
        throw new Error('Answer provider does not support streaming.');
      }
      return provider.stream(input);
    },
  };
}
