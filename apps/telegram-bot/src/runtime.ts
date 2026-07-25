import { createCustomerAgentChatService } from '@xxyy/agent-core';
import { createOpenAiEmbeddingProvider } from '@xxyy/knowledge';
import type { ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  createLazyRetriever,
  createOpenAiAnswerProvider,
  createPgFeedbackStore,
  createPgPool,
  createPgVectorStore,
  noopQualityTracer,
  type AnswerProvider,
  type ChatService,
  type RagConfig,
  type QualityTracer,
  type RecordFeedbackInput,
} from '@xxyy/rag-core';

export interface TelegramChatRuntime {
  close(): Promise<void>;
  service: ChatService;
}

export function createTelegramChatRuntime(
  config: RagConfig,
  tracer: QualityTracer = noopQualityTracer,
): TelegramChatRuntime {
  let vectorPool: ReturnType<typeof createPgPool> | undefined;
  let feedbackPool: ReturnType<typeof createPgPool> | undefined;

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
    answerProvider: createLazyAnswerProvider(config, tracer),
    config,
    productCapabilityCaller: {
      channel: 'telegram',
      principal: 'service',
    },
    retriever,
    tracer,
  });
  const recordFeedback = async (input: RecordFeedbackInput): Promise<void> => {
    feedbackPool ??= createPgPool(config.databaseUrl);
    await createPgFeedbackStore({ client: feedbackPool }).recordFeedback(input);
  };

  return {
    async close() {
      const pool = vectorPool;
      vectorPool = undefined;
      const currentFeedbackPool = feedbackPool;
      feedbackPool = undefined;
      await Promise.all([pool?.end(), currentFeedbackPool?.end()]);
    },
    service: withLowEvidenceFeedback(service, recordFeedback),
  };
}

function withLowEvidenceFeedback(
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
  if (
    (response.intent !== 'product_qa' && response.intent !== 'how_to') ||
    response.citations.length > 0
  ) {
    return;
  }

  await recordFeedback({
    answer: response.answer,
    channel: 'telegram',
    citationCount: 0,
    comment: 'automatic_low_evidence',
    intent: response.intent,
    question: request.message,
    rating: 'negative',
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  }).catch(() => undefined);
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
