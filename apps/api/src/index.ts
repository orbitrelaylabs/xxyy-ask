import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createCustomerAgentChatService,
  loadAnswerQualityRolloutConfig,
  type AnswerQualityRolloutObservation,
  type AnswerQualityRolloutObserver,
} from '@xxyy/agent-core';
import {
  createTransactionSkillDiagnosisHandler,
  createTransactionSkillPublicClient,
  resolveEgoBrowserExecutable,
} from '@xxyy/transaction-skill-bridge';
import { createOpenAiEmbeddingProvider, EmbeddingConfigurationError } from '@xxyy/knowledge';
import {
  createOpenAiAnswerProvider,
  createPgApiObservabilityStore,
  createPgDailyChatQuotaStore,
  feedbackFailureReasons,
  createPgFeedbackStore,
  createPgSupportOperationsStore,
  createLazyRetriever,
  createPgPool,
  createPgVectorStore,
  LlmConfigurationError,
  loadRagConfig,
  loadWorkspaceEnv,
  noopQualityTracer,
  quotaDateInTimeZone,
  readKnowledgeRefreshStatus,
  resolveWorkspaceCwd,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from '@xxyy/rag-core';
import type {
  ChatRequest,
  ChatChannel,
  ChatHistoryMessage,
  ChatResponse,
  ChatStreamEvent,
  ChatTokenUsage,
  KnowledgeRefreshStatus,
  SourceType,
} from '@xxyy/shared';
import { supportedChannels, supportedIntents } from '@xxyy/shared';
import type {
  AnswerProvider,
  ChatService,
  QualityTracer,
  ApiCallObservation,
  DailyChatQuotaResult,
  PgSupportOperationsStore,
  RagEnv,
  RecordFeedbackInput,
  SupportMessageRole,
  SupportEscalationReason,
} from '@xxyy/rag-core';
import { renderAdminPage } from '@xxyy/web';

import { createAgentApiAuthenticator, type AgentApiAuthenticator } from './agent-api-auth.js';
import {
  handleKnowledgeAdminApi,
  isKnowledgeAdminApiPath,
  type KnowledgeAdminServices,
} from './knowledge-admin-api.js';
import { createCachedKnowledgeAdminServicesLoader } from './knowledge-admin-services.js';

const PRODUCT_ASSET_NAMES: ReadonlySet<string> = new Set(['xxyy-add-to-home.mp4']);
const PRODUCT_DOC_ASSET_NAME_PATTERN =
  /^xxyy-docs-[A-Za-z0-9_-]+\.(?:avif|gif|jpe?g|png|svg|webp)$/u;

type ApiEnv = RagEnv &
  Partial<
    Record<
      | 'API_CORS_ORIGIN'
      | 'API_ENABLE_DEEP_HEALTH'
      | 'API_MAX_BODY_BYTES'
      | 'API_RATE_LIMIT_MAX'
      | 'API_RATE_LIMIT_WINDOW_MS'
      | 'OBSERVABILITY_PROMPT_COST_PER_1M_TOKENS'
      | 'OBSERVABILITY_COMPLETION_COST_PER_1M_TOKENS'
      | 'OBSERVABILITY_ALERT_COST_USD'
      | 'OBSERVABILITY_ALERT_RATE_LIMITED_RATIO'
      | 'OBSERVABILITY_ALERT_SERVER_ERROR_RATIO'
      | 'OBSERVABILITY_CLIENT_HASH_SALT'
      | 'DAILY_CHAT_LIMIT'
      | 'DAILY_CHAT_LIMIT_TIME_ZONE'
      | 'DAILY_CHAT_LIMIT_HASH_SALT'
      | 'TELEGRAM_DAILY_QUOTA_TIME_ZONE'
      | 'ANSWER_QUALITY_CLI_MODE'
      | 'ANSWER_QUALITY_CLI_OPTIMIZED_PERCENTAGE'
      | 'ANSWER_QUALITY_TELEGRAM_MODE'
      | 'ANSWER_QUALITY_TELEGRAM_OPTIMIZED_PERCENTAGE'
      | 'ANSWER_QUALITY_WEB_MODE'
      | 'ANSWER_QUALITY_OBSERVABILITY_ENABLED'
      | 'ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE'
      | 'XXYY_AGENT_API_KEYS_JSON'
      | 'NODE_ENV'
      | 'PATH'
      | 'XXYY_SMALL_POOL_MAX_LIQUIDITY_USD'
      | 'XXYY_SMALL_POOL_MAX_RELATIVE_LIQUIDITY_PPM'
      | 'XXYY_CANONICAL_POOL_CONFIG_JSON'
      | 'XXYY_SCREENSHOT_CHROME_EXECUTABLE'
      | 'XXYY_SCREENSHOT_DIRECTORY'
      | 'XXYY_BROWSER_PROFILE_DIRECTORY'
      | 'KNOWLEDGE_ADMIN_MAX_BODY_BYTES'
      | 'KNOWLEDGE_ADMIN_RATE_LIMIT_MAX'
      | 'KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS'
      | 'KNOWLEDGE_AUTO_REFRESH_ENABLED'
      | 'KNOWLEDGE_AUTO_REFRESH_INCREMENTAL_DAILY_AT'
      | 'KNOWLEDGE_AUTO_REFRESH_RECEIPT_FILE'
      | 'KNOWLEDGE_AUTO_REFRESH_STALE_AFTER_MINUTES'
      | 'KNOWLEDGE_AUTO_REFRESH_TIME_ZONE'
      | 'PORT'
      | 'TRUST_PROXY'
      | 'TELEGRAM_API_BASE_URL'
      | 'TELEGRAM_BOT_TOKEN',
      string
    >
  >;

export interface ApiRequestLike {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  socket?: {
    remoteAddress?: string;
  };
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
}

export interface ApiResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  write(body: string): void;
  end(body?: string | Uint8Array): void;
  flushHeaders?(): void;
  flush?(): void;
}

export type ApiRequestHandler = (
  request: ApiRequestLike,
  response: ApiResponseLike,
) => Promise<void>;

export interface CreateRequestHandlerOptions {
  answerQualityRolloutObserver?: AnswerQualityRolloutObserver;
  createRequestId?: () => string;
  cwd?: string;
  env?: ApiEnv;
  getChatService?: () => Promise<ChatService>;
  getHealthStatus?: () => Promise<DeepHealthStatus>;
  getKnowledgeRefreshStatus?: () => Promise<KnowledgeRefreshStatus>;
  getKnowledgeAdminServices?: () => Promise<KnowledgeAdminServices>;
  getSupportOperationsStore?: () => Promise<PgSupportOperationsStore>;
  recordApiCall?: (input: ApiCallObservation) => Promise<void>;
  consumeDailyChatQuota?: (identity: string) => Promise<DailyChatQuotaResult>;
  agentApiAuthenticator?: AgentApiAuthenticator;
  logger?: ApiLogger;
  now?: () => number;
  recordFeedback?: FeedbackRecorder;
  renderKnowledgeAdminHtml?: () => string;
  staticAssetsDir?: string;
  webAssetsDir?: string;
}

export interface StartServerOptions extends CreateRequestHandlerOptions {
  port?: number;
  portRetryLimit?: number;
}

const DEFAULT_LOCAL_PORT_RETRY_LIMIT = 20;

interface ApiRuntimeConfig {
  adminMaxBodyBytes: number;
  adminRateLimitMax: number;
  adminRateLimitWindowMs: number;
  corsOrigins: string[];
  enableDeepHealth: boolean;
  enableRolloutObservability: boolean;
  maxBodyBytes: number;
  promptCostPerMillionTokens: number;
  completionCostPerMillionTokens: number;
  dailyChatLimit: number;
  dailyChatLimitTimeZone: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  trustProxy: boolean;
}

interface ChatPayload {
  message: string;
  channel?: ChatChannel;
  requestId?: string;
  sessionId?: string;
  userId?: string;
}

interface ApiObservationDraft {
  apiKeyId?: string;
  channel?: ChatChannel;
  completionTokens?: number;
  errorCode?: string;
  estimatedCostUsd?: number;
  modelCallCount?: number;
  model?: string;
  promptTokens?: number;
  requestId?: string;
  totalTokens?: number;
}

type FeedbackRecorder = (input: RecordFeedbackInput) => Promise<void>;

export interface ApiLogEntry {
  event: 'chat_request';
  route: '/api/chat' | '/api/chat/stream';
  channel: ChatChannel;
  durationMs: number;
  messageLength: number;
  messagePreview: string;
  outcome: 'success' | 'error';
  requestId: string;
  sessionIdPresent: boolean;
  statusCode: number;
  userIdPresent: boolean;
  agentRoute?: ChatResponse['agentRoute'];
  attachmentCount?: number;
  citationCount?: number;
  confidence?: number;
  error?: string;
  intent?: ChatResponse['intent'];
}

export type ApiLogger = (entry: ApiLogEntry) => void;

interface HealthCheck {
  status: 'ok' | 'error';
  message?: string;
  missing?: string[];
  model?: string;
  dimension?: number;
  chunkCount?: number;
  configured?: boolean;
  driver?: string;
  vectorExtension?: boolean;
}

interface DeepHealthStatus {
  status: 'ok' | 'degraded';
  checks: {
    config: HealthCheck;
    embedding: HealthCheck;
    llm: HealthCheck;
    vectorStore: HealthCheck;
    browser?: HealthCheck;
  };
}

export function createRequestHandler(options: CreateRequestHandlerOptions = {}): ApiRequestHandler {
  const env = options.env ?? createDefaultApiEnv(options);
  const config = loadRagConfig(env);
  const apiConfig = loadApiRuntimeConfig(env);
  const tracer = noopQualityTracer;
  const answerQualityRolloutObserver =
    options.answerQualityRolloutObserver ??
    (apiConfig.enableRolloutObservability ? createConsoleAnswerQualityObserver() : undefined);
  const renderKnowledgeAdminHtml = options.renderKnowledgeAdminHtml ?? renderAdminPage;
  const getChatService =
    options.getChatService ??
    createCachedChatServiceLoader(config, tracer, env, answerQualityRolloutObserver);
  const getHealthStatus = options.getHealthStatus ?? (() => createDeepHealthStatus(config, env));
  const getKnowledgeAdminServices =
    options.getKnowledgeAdminServices ?? createCachedKnowledgeAdminServicesLoader({ config, env });
  const getSupportOperationsStore =
    options.getSupportOperationsStore ??
    (isTestRuntime(env) ? undefined : createCachedSupportOperationsStoreLoader(config));
  const agentApiAuthenticator =
    options.agentApiAuthenticator ?? createAgentApiAuthenticator(env.XXYY_AGENT_API_KEYS_JSON);
  const recordFeedback =
    options.recordFeedback ??
    (isTestRuntime(env) ? noopFeedbackRecorder : createCachedFeedbackRecorder(config));
  const recordApiCall =
    options.recordApiCall ??
    (isTestRuntime(env) ? noopApiCallRecorder : createCachedApiCallRecorder(config, env));
  const consumeDailyChatQuota =
    options.consumeDailyChatQuota ??
    (isTestRuntime(env)
      ? createUnlimitedDailyChatQuota(apiConfig.dailyChatLimit, apiConfig.dailyChatLimitTimeZone)
      : createCachedDailyChatQuotaConsumer(config, env, apiConfig));
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const getKnowledgeRefreshStatus =
    options.getKnowledgeRefreshStatus ??
    (() =>
      readKnowledgeRefreshStatus({
        cwd: resolveWorkspaceCwd(options.cwd ?? process.cwd(), env),
        env,
        now: () => new Date(now()),
      }));
  const createRequestId = options.createRequestId ?? randomUUID;
  const staticAssetsDir = options.staticAssetsDir ?? createDefaultStaticAssetsDir(options, env);
  const webAssetsDir = options.webAssetsDir ?? createDefaultWebAssetsDir(options, env);
  const xxyyEvidenceDir = env.XXYY_SCREENSHOT_DIRECTORY?.trim();
  const rateLimiter = createRateLimiter(apiConfig, now);
  const adminMutationRateLimiter = createRateLimiter(
    {
      rateLimitMax: apiConfig.adminRateLimitMax,
      rateLimitWindowMs: apiConfig.adminRateLimitWindowMs,
    },
    now,
  );
  const adminReadRateLimiter = createRateLimiter(
    {
      rateLimitMax: Math.min(Number.MAX_SAFE_INTEGER, apiConfig.adminRateLimitMax * 10),
      rateLimitWindowMs: apiConfig.adminRateLimitWindowMs,
    },
    now,
  );

  return async function handleRequest(request, response): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const observation: ApiObservationDraft = {};
    const observationStartedAt = Date.now();
    const clientIp = clientAddress(request, apiConfig);
    const apiPrincipal = requestUrl.pathname.startsWith('/api/v1/')
      ? agentApiAuthenticator.authenticate(headerValue(request.headers.authorization))
      : undefined;
    if (apiPrincipal !== undefined) observation.apiKeyId = apiPrincipal.id;
    if (
      config.openAiModel !== undefined &&
      (requestUrl.pathname === '/api/chat' ||
        requestUrl.pathname === '/api/chat/stream' ||
        requestUrl.pathname === '/api/v1/chat' ||
        requestUrl.pathname === '/api/v1/chat/stream')
    ) {
      observation.model = config.openAiModel;
    }
    if (request.method !== 'OPTIONS' && isObservedApiPath(requestUrl.pathname)) {
      instrumentApiResponse({
        draft: observation,
        method: request.method ?? 'GET',
        now: Date.now,
        path: requestUrl.pathname,
        record: recordApiCall,
        remoteAddress: clientIp,
        response,
        startedAt: observationStartedAt,
      });
    }
    const corsResult = applyCors(request, response, requestUrl, apiConfig);
    if (corsResult === 'handled') {
      return;
    }

    if (isKnowledgeAdminApiPath(requestUrl.pathname)) {
      const adminRateLimiter =
        request.method === 'GET' ? adminReadRateLimiter : adminMutationRateLimiter;
      const rateLimitResult = adminRateLimiter.check(clientIp);
      if (!rateLimitResult.allowed) {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Retry-After', String(Math.ceil(rateLimitResult.retryAfterMs / 1000)));
        sendJson(response, 429, {
          error: 'rate_limited',
          message: 'Too many knowledge administration requests. Please try again later.',
        });
        return;
      }
    }

    if (
      (isRateLimitedPostApiRoute(requestUrl.pathname) && request.method === 'POST') ||
      (requestUrl.pathname === '/api/support/status' && request.method === 'GET')
    ) {
      const rateLimitResult = rateLimiter.check(
        apiPrincipal === undefined ? clientIp : `api-key:${apiPrincipal.id}`,
      );
      if (!rateLimitResult.allowed) {
        response.setHeader('Retry-After', String(Math.ceil(rateLimitResult.retryAfterMs / 1000)));
        sendJson(response, 429, {
          error: 'rate_limited',
          message: 'Too many requests. Please try again later.',
        });
        return;
      }
    }

    if (
      requestUrl.pathname.startsWith('/api/v1/') &&
      requestUrl.pathname !== '/api/v1/openapi.json'
    ) {
      if (!agentApiAuthenticator.configured) {
        sendJson(response, 503, {
          error: 'agent_api_not_configured',
          message: 'The versioned Agent API is not configured.',
        });
        return;
      }
      if (apiPrincipal === undefined) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        sendJson(response, 401, {
          error: 'unauthorized',
          message: 'A valid Agent API bearer token is required.',
        });
        return;
      }
    }

    try {
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/v1/openapi.json') {
        sendJson(response, 200, createAgentApiOpenApiDocument());
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/health/deep') {
        if (!apiConfig.enableDeepHealth) {
          sendJson(response, 404, { error: 'not_found', message: 'Route not found.' });
          return;
        }

        const healthStatus = await getHealthStatus();
        sendJson(response, healthStatus.status === 'ok' ? 200 : 503, healthStatus);
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/knowledge-refresh-status') {
        response.setHeader('Cache-Control', 'no-store');
        sendJson(response, 200, await getKnowledgeRefreshStatus());
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        response.statusCode = 302;
        response.setHeader('Location', '/admin');
        response.end();
        return;
      }

      if (
        request.method === 'GET' &&
        (requestUrl.pathname === '/admin' || requestUrl.pathname === '/admin/')
      ) {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', adminContentSecurityPolicy());
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Referrer-Policy', 'no-referrer');
        sendHtml(response, 200, renderKnowledgeAdminHtml());
        return;
      }

      if (isKnowledgeAdminApiPath(requestUrl.pathname)) {
        await handleKnowledgeAdminApi({
          getServices: getKnowledgeAdminServices,
          maxBodyBytes: apiConfig.adminMaxBodyBytes,
          request,
          requestUrl,
          response,
        });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/assets/')) {
        await sendStaticAsset(
          response,
          staticAssetsDir,
          requestUrl.pathname,
          isAllowedProductAssetName,
        );
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/web-assets/')) {
        await sendStaticAsset(response, webAssetsDir, requestUrl.pathname, undefined, 'no-cache');
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname.startsWith('/xxyy-evidence/')) {
        if (xxyyEvidenceDir === undefined || xxyyEvidenceDir.length === 0) {
          sendJson(response, 404, { error: 'not_found', message: 'Asset not found.' });
          return;
        }
        await sendStaticAsset(response, xxyyEvidenceDir, requestUrl.pathname, (assetName) =>
          /^[0-9a-f]{64}\.png$/u.test(assetName),
        );
        return;
      }

      if (
        request.method === 'POST' &&
        (requestUrl.pathname === '/api/chat' || requestUrl.pathname === '/api/v1/chat')
      ) {
        await handleChatRequest({
          getChatService,
          logger,
          observation,
          promptCostPerMillionTokens: apiConfig.promptCostPerMillionTokens,
          completionCostPerMillionTokens: apiConfig.completionCostPerMillionTokens,
          consumeDailyChatQuota,
          clientAddress: clientIp,
          createRequestId,
          maxBodyBytes: apiConfig.maxBodyBytes,
          now,
          recordFeedback,
          ...(getSupportOperationsStore === undefined ? {} : { getSupportOperationsStore }),
          request,
          response,
          route: '/api/chat',
        });
        return;
      }

      if (
        request.method === 'POST' &&
        (requestUrl.pathname === '/api/chat/stream' ||
          requestUrl.pathname === '/api/v1/chat/stream')
      ) {
        await handleChatRequest({
          getChatService,
          logger,
          observation,
          promptCostPerMillionTokens: apiConfig.promptCostPerMillionTokens,
          completionCostPerMillionTokens: apiConfig.completionCostPerMillionTokens,
          consumeDailyChatQuota,
          clientAddress: clientIp,
          createRequestId,
          maxBodyBytes: apiConfig.maxBodyBytes,
          now,
          recordFeedback,
          ...(getSupportOperationsStore === undefined ? {} : { getSupportOperationsStore }),
          request,
          response,
          route: '/api/chat/stream',
        });
        return;
      }

      if (
        request.method === 'POST' &&
        (requestUrl.pathname === '/api/feedback' || requestUrl.pathname === '/api/v1/feedback')
      ) {
        const payload = parseFeedbackPayload(await readJsonBody(request, apiConfig.maxBodyBytes));
        await recordFeedback(payload);
        response.statusCode = 204;
        response.end();
        return;
      }

      if (
        request.method === 'POST' &&
        (requestUrl.pathname === '/api/support/escalate' ||
          requestUrl.pathname === '/api/v1/support/escalate')
      ) {
        if (getSupportOperationsStore === undefined) {
          sendJson(response, 503, {
            error: 'support_operations_unavailable',
            message: 'Support escalation is not configured.',
          });
          return;
        }
        const payload = parseSupportEscalationPayload(
          await readJsonBody(request, apiConfig.maxBodyBytes),
        );
        const store = await getSupportOperationsStore();
        const conversation = await store.ensureConversation({
          channel: payload.channel,
          externalSessionId: payload.sessionId,
          ...(payload.userId === undefined ? {} : { userId: payload.userId }),
        });
        const ticket = await store.createTicket({
          conversationId: conversation.id,
          priority: payload.priority,
          reason: payload.reason,
          subject: payload.subject,
        });
        sendJson(response, 201, { ticket });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/api/support/status') {
        if (getSupportOperationsStore === undefined) {
          sendJson(response, 503, {
            error: 'support_operations_unavailable',
            message: 'Support operations are not configured.',
          });
          return;
        }
        const sessionId = requestUrl.searchParams.get('sessionId')?.trim();
        if (sessionId === undefined || !isHighEntropySupportSessionId(sessionId)) {
          throw new BadRequestError('sessionId must be a high-entropy opaque identifier.');
        }
        const store = await getSupportOperationsStore();
        const conversation = await store.getConversationByExternalSessionId(sessionId);
        if (conversation === undefined) {
          sendJson(response, 404, {
            error: 'support_conversation_not_found',
            message: 'Support conversation was not found.',
          });
          return;
        }
        const messages = await store.getRecentMessages(conversation.id, { limit: 50 });
        sendJson(response, 200, {
          conversation: { status: conversation.status },
          messages: messages.filter((message) => message.role === 'support_agent'),
        });
        return;
      }

      sendJson(response, 404, { error: 'not_found', message: 'Route not found.' });
    } catch (error) {
      const apiError = createApiErrorResponse(error);
      sendJson(response, apiError.statusCode, apiError.body);
    }
  };
}

interface HandleChatRequestOptions {
  clientAddress: string;
  createRequestId: () => string;
  getChatService: () => Promise<ChatService>;
  getSupportOperationsStore?: () => Promise<PgSupportOperationsStore>;
  logger: ApiLogger;
  observation: ApiObservationDraft;
  promptCostPerMillionTokens: number;
  completionCostPerMillionTokens: number;
  consumeDailyChatQuota: (identity: string) => Promise<DailyChatQuotaResult>;
  maxBodyBytes: number;
  now: () => number;
  recordFeedback: FeedbackRecorder;
  request: ApiRequestLike;
  response: ApiResponseLike;
  route: ApiLogEntry['route'];
}

async function handleChatRequest(options: HandleChatRequestOptions): Promise<void> {
  const payload = parseChatPayload(await readJsonBody(options.request, options.maxBodyBytes));
  const requestPayload = {
    ...payload,
    requestId: payload.requestId ?? options.createRequestId(),
  };
  options.observation.channel = requestPayload.channel ?? 'web';
  options.observation.requestId = requestPayload.requestId;
  options.response.setHeader('X-Request-Id', requestPayload.requestId);
  const quota = await options.consumeDailyChatQuota(
    dailyChatQuotaIdentity(requestPayload, options.observation.apiKeyId, options.clientAddress),
  );
  if (!quota.allowed) {
    options.observation.errorCode = 'daily_chat_limit_exceeded';
    sendJson(options.response, 429, {
      error: 'daily_chat_limit_exceeded',
      limit: quota.limit,
      message: `Daily chat limit reached. Each user can start at most ${quota.limit} conversations per day.`,
      quotaDate: quota.quotaDate,
    });
    return;
  }
  const startedAt = options.now();
  let chatRequest = toChatRequest(requestPayload);
  let supportConversationId: string | undefined;

  try {
    if (chatRequest.sessionId !== undefined && options.getSupportOperationsStore !== undefined) {
      const supportStore = await options.getSupportOperationsStore();
      const conversation = await supportStore.ensureConversation({
        channel: chatRequest.channel,
        externalSessionId: chatRequest.sessionId,
        ...(chatRequest.userId === undefined ? {} : { userId: chatRequest.userId }),
      });
      supportConversationId = conversation.id;
      const previousMessages = await supportStore.getRecentMessages(conversation.id, { limit: 12 });
      chatRequest = {
        ...chatRequest,
        history: previousMessages.flatMap((message) => {
          const historyMessage = toChatHistoryMessage(message.content, message.role);
          return historyMessage === undefined ? [] : [historyMessage];
        }),
      };
      await supportStore.appendMessage({
        content: chatRequest.message,
        conversationId: conversation.id,
        role: 'user',
        ...(chatRequest.requestId === undefined ? {} : { requestId: chatRequest.requestId }),
      });
    }
    const service = await options.getChatService();

    if (options.route === '/api/chat') {
      const chatResponse = await service.ask(chatRequest);
      enrichObservationWithTokenUsage(options, chatResponse.tokenUsage);
      await persistAssistantResponse(
        options.getSupportOperationsStore,
        supportConversationId,
        chatRequest,
        chatResponse,
      );
      sendJson(options.response, 200, chatResponse);
      await recordAutomaticLowEvidence(options.recordFeedback, chatRequest, chatResponse);
      options.logger(
        createChatSuccessLogEntry({
          durationMs: options.now() - startedAt,
          payload: requestPayload,
          response: chatResponse,
          route: options.route,
          statusCode: 200,
        }),
      );
      return;
    }

    const summary = await sendChatStream(options.response, service.stream(chatRequest), (event) => {
      enrichObservationWithTokenUsage(options, event.tokenUsage);
      if (event.errorCode !== undefined) options.observation.errorCode = event.errorCode;
    });
    await persistAssistantStreamSummary(
      options.getSupportOperationsStore,
      supportConversationId,
      chatRequest,
      summary,
    );
    await recordAutomaticLowEvidenceFromStream(options.recordFeedback, chatRequest, summary);
    options.logger(
      createChatStreamLogEntry({
        durationMs: options.now() - startedAt,
        payload: requestPayload,
        route: options.route,
        summary,
      }),
    );
  } catch (error) {
    const apiError = createApiErrorResponse(error);
    options.logger(
      createChatErrorLogEntry({
        durationMs: options.now() - startedAt,
        error: apiError.body.error,
        payload: requestPayload,
        route: options.route,
        statusCode: apiError.statusCode,
      }),
    );
    throw error;
  }
}

function toChatHistoryMessage(
  content: string,
  role: SupportMessageRole,
): ChatHistoryMessage | undefined {
  return role === 'assistant' || role === 'support_agent' || role === 'user'
    ? { content, role }
    : undefined;
}

async function persistAssistantResponse(
  getStore: (() => Promise<PgSupportOperationsStore>) | undefined,
  conversationId: string | undefined,
  request: ChatRequest,
  response: ChatResponse,
): Promise<void> {
  if (getStore === undefined || conversationId === undefined) {
    return;
  }
  const store = await getStore();
  await store.appendMessage({
    citationCount: response.citations.length,
    content: response.answer,
    conversationId,
    intent: response.intent,
    role: 'assistant',
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
  });
}

async function persistAssistantStreamSummary(
  getStore: (() => Promise<PgSupportOperationsStore>) | undefined,
  conversationId: string | undefined,
  request: ChatRequest,
  summary: ChatStreamSummary,
): Promise<void> {
  if (
    getStore === undefined ||
    conversationId === undefined ||
    summary.outcome !== 'success' ||
    summary.answer === undefined ||
    summary.intent === undefined
  ) {
    return;
  }
  const store = await getStore();
  await store.appendMessage({
    citationCount: summary.citationCount ?? 0,
    content: summary.answer,
    conversationId,
    intent: summary.intent,
    role: 'assistant',
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
  });
}

async function recordAutomaticLowEvidence(
  recordFeedback: FeedbackRecorder,
  request: ChatRequest,
  response: ChatResponse,
): Promise<void> {
  const comment = automaticQualityComment(
    response.intent,
    response.citations.length,
    response.answerStatus,
  );
  if (comment === undefined) {
    return;
  }

  await recordFeedback({
    answer: response.answer,
    ...(response.answerStatus === undefined ? {} : { answerStatus: response.answerStatus }),
    channel: request.channel,
    citationCount: response.citations.length,
    comment,
    failureReason: automaticFailureReason(response.citations.length, response.answerStatus),
    intent: response.intent,
    question: request.message,
    rating: 'negative',
    sourceTypes: feedbackSourceTypes(response.citations),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  }).catch(() => undefined);
}

async function recordAutomaticLowEvidenceFromStream(
  recordFeedback: FeedbackRecorder,
  request: ChatRequest,
  summary: ChatStreamSummary,
): Promise<void> {
  if (
    summary.outcome !== 'success' ||
    summary.intent === undefined ||
    automaticQualityComment(summary.intent, summary.citationCount ?? 0, summary.answerStatus) ===
      undefined
  ) {
    return;
  }
  const comment = automaticQualityComment(
    summary.intent,
    summary.citationCount ?? 0,
    summary.answerStatus,
  );
  if (comment === undefined) {
    return;
  }

  await recordFeedback({
    answer: summary.answer ?? '',
    ...(summary.answerStatus === undefined ? {} : { answerStatus: summary.answerStatus }),
    channel: request.channel,
    citationCount: summary.citationCount ?? 0,
    comment,
    failureReason: automaticFailureReason(summary.citationCount ?? 0, summary.answerStatus),
    intent: summary.intent,
    question: request.message,
    rating: 'negative',
    sourceTypes: summary.sourceTypes ?? [],
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  }).catch(() => undefined);
}

function feedbackSourceTypes(
  citations: readonly ChatResponse['citations'][number][],
): SourceType[] {
  return [
    ...new Set(
      citations.flatMap((citation) =>
        citation.sourceType === undefined ? [] : [citation.sourceType],
      ),
    ),
  ];
}

function isLowEvidenceProductAnswer(
  intent: ChatResponse['intent'],
  citationCount: number,
): boolean {
  return (intent === 'product_qa' || intent === 'how_to') && citationCount === 0;
}

function automaticQualityComment(
  intent: ChatResponse['intent'],
  citationCount: number,
  answerStatus: ChatResponse['answerStatus'],
):
  | 'automatic_evidence_conflict'
  | 'automatic_low_evidence'
  | 'automatic_partial_answer'
  | undefined {
  if (answerStatus === 'conflict') {
    return 'automatic_evidence_conflict';
  }
  if (answerStatus === 'partial') {
    return 'automatic_partial_answer';
  }
  return isLowEvidenceProductAnswer(intent, citationCount) ? 'automatic_low_evidence' : undefined;
}

function automaticFailureReason(
  citationCount: number,
  answerStatus: ChatResponse['answerStatus'],
): NonNullable<RecordFeedbackInput['failureReason']> {
  if (answerStatus === 'conflict') return 'knowledge_conflict';
  if (answerStatus === 'partial') return 'incomplete';
  return citationCount === 0 ? 'knowledge_missing' : 'other';
}

function loadApiRuntimeConfig(env: ApiEnv): ApiRuntimeConfig {
  return {
    adminMaxBodyBytes: parsePositiveInteger(env.KNOWLEDGE_ADMIN_MAX_BODY_BYTES, 5 * 1024 * 1024),
    adminRateLimitMax: parsePositiveInteger(env.KNOWLEDGE_ADMIN_RATE_LIMIT_MAX, 30),
    adminRateLimitWindowMs: parsePositiveInteger(env.KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS, 60_000),
    corsOrigins: parseCsv(env.API_CORS_ORIGIN),
    enableDeepHealth: parseBoolean(env.API_ENABLE_DEEP_HEALTH, true),
    enableRolloutObservability: parseBoolean(env.ANSWER_QUALITY_OBSERVABILITY_ENABLED, false),
    maxBodyBytes: parsePositiveInteger(env.API_MAX_BODY_BYTES, 64 * 1024),
    promptCostPerMillionTokens: parseNonNegativeNumber(
      env.OBSERVABILITY_PROMPT_COST_PER_1M_TOKENS,
      0,
    ),
    completionCostPerMillionTokens: parseNonNegativeNumber(
      env.OBSERVABILITY_COMPLETION_COST_PER_1M_TOKENS,
      0,
    ),
    dailyChatLimit: parsePositiveInteger(env.DAILY_CHAT_LIMIT, 10),
    dailyChatLimitTimeZone: parseTimeZone(env.DAILY_CHAT_LIMIT_TIME_ZONE, 'Asia/Shanghai'),
    rateLimitMax: parsePositiveInteger(env.API_RATE_LIMIT_MAX, 60),
    rateLimitWindowMs: parsePositiveInteger(env.API_RATE_LIMIT_WINDOW_MS, 60_000),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
  };
}

function parseCsv(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseTimeZone(value: string | undefined, fallback: string): string {
  const timeZone = value?.trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return fallback;
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallback;
  }
}

type CorsResult = 'continue' | 'handled';

function applyCors(
  request: ApiRequestLike,
  response: ApiResponseLike,
  requestUrl: URL,
  config: ApiRuntimeConfig,
): CorsResult {
  if (!isApiRoute(requestUrl.pathname)) {
    return 'continue';
  }

  const origin = headerValue(request.headers.origin);
  if (origin !== undefined && isCorsOriginAllowed(origin, config.corsOrigins)) {
    const allowedOrigin = config.corsOrigins.includes('*') ? '*' : origin;
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    response.setHeader(
      'Access-Control-Allow-Headers',
      headerValue(request.headers['access-control-request-headers']) ?? 'Content-Type',
    );
    response.setHeader('Access-Control-Max-Age', '600');
    if (allowedOrigin !== '*') {
      response.setHeader('Vary', 'Origin');
    }
  }

  if (request.method === 'OPTIONS') {
    if (origin !== undefined && !isCorsOriginAllowed(origin, config.corsOrigins)) {
      sendJson(response, 403, {
        error: 'cors_origin_forbidden',
        message: 'CORS origin is not allowed.',
      });
      return 'handled';
    }
    response.statusCode = 204;
    response.end();
    return 'handled';
  }

  return 'continue';
}

function isCorsOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

function isApiRoute(pathname: string): boolean {
  return (
    pathname === '/api/chat' ||
    pathname === '/api/chat/stream' ||
    pathname === '/api/feedback' ||
    pathname === '/api/support/escalate' ||
    pathname === '/api/support/status' ||
    pathname === '/api/v1/chat' ||
    pathname === '/api/v1/chat/stream' ||
    pathname === '/api/v1/feedback' ||
    pathname === '/api/v1/openapi.json' ||
    pathname === '/api/v1/support/escalate'
  );
}

function isRateLimitedPostApiRoute(pathname: string): boolean {
  return isApiRoute(pathname);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export function createRateLimiter(
  config: { rateLimitMax: number; rateLimitWindowMs: number },
  now: () => number,
): { check(key: string): RateLimitResult; size(): number } {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key) {
      const currentTime = now();
      removeExpiredBuckets(buckets, currentTime);
      const currentBucket = buckets.get(key);
      if (currentBucket === undefined || currentBucket.resetAt <= currentTime) {
        buckets.set(key, {
          count: 1,
          resetAt: currentTime + config.rateLimitWindowMs,
        });
        return { allowed: true, retryAfterMs: 0 };
      }

      if (currentBucket.count >= config.rateLimitMax) {
        return {
          allowed: false,
          retryAfterMs: Math.max(1, currentBucket.resetAt - currentTime),
        };
      }

      currentBucket.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
    size() {
      return buckets.size;
    },
  };
}

function removeExpiredBuckets(
  buckets: Map<string, { count: number; resetAt: number }>,
  currentTime: number,
): void {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= currentTime) {
      buckets.delete(key);
    }
  }
}

function clientAddress(
  request: ApiRequestLike,
  config: Pick<ApiRuntimeConfig, 'trustProxy'>,
): string {
  if (config.trustProxy) {
    const forwardedFor = headerValue(request.headers['x-forwarded-for']);
    if (forwardedFor !== undefined && forwardedFor.trim().length > 0) {
      return forwardedFor.split(',')[0]?.trim() ?? 'unknown';
    }

    const realIp = headerValue(request.headers['x-real-ip']);
    if (realIp !== undefined && realIp.trim().length > 0) {
      return realIp.trim();
    }
  }

  return request.socket?.remoteAddress?.trim() || 'unknown';
}

function createChatSuccessLogEntry(input: {
  durationMs: number;
  payload: ChatPayload;
  response: ChatResponse;
  route: ApiLogEntry['route'];
  statusCode: number;
}): ApiLogEntry {
  return {
    ...createChatLogBase(input.payload, input.route, input.durationMs, input.statusCode),
    ...(input.response.agentRoute === undefined ? {} : { agentRoute: input.response.agentRoute }),
    attachmentCount: input.response.attachments?.length ?? 0,
    citationCount: input.response.citations.length,
    confidence: input.response.confidence,
    intent: input.response.intent,
    outcome: 'success',
  };
}

function createChatStreamLogEntry(input: {
  durationMs: number;
  payload: ChatPayload;
  route: ApiLogEntry['route'];
  summary: ChatStreamSummary;
}): ApiLogEntry {
  const base = createChatLogBase(
    input.payload,
    input.route,
    input.durationMs,
    input.summary.statusCode,
  );

  if (input.summary.outcome === 'error') {
    return {
      ...base,
      error: input.summary.error ?? 'internal_error',
      outcome: 'error',
    };
  }

  return {
    ...base,
    ...(input.summary.agentRoute === undefined ? {} : { agentRoute: input.summary.agentRoute }),
    attachmentCount: input.summary.attachmentCount ?? 0,
    citationCount: input.summary.citationCount ?? 0,
    ...(input.summary.confidence === undefined ? {} : { confidence: input.summary.confidence }),
    ...(input.summary.intent === undefined ? {} : { intent: input.summary.intent }),
    outcome: 'success',
  };
}

function createChatErrorLogEntry(input: {
  durationMs: number;
  error: string;
  payload: ChatPayload;
  route: ApiLogEntry['route'];
  statusCode: number;
}): ApiLogEntry {
  return {
    ...createChatLogBase(input.payload, input.route, input.durationMs, input.statusCode),
    error: input.error,
    outcome: 'error',
  };
}

function createChatLogBase(
  payload: ChatPayload,
  route: ApiLogEntry['route'],
  durationMs: number,
  statusCode: number,
): Omit<ApiLogEntry, 'outcome'> {
  return {
    channel: payload.channel ?? 'web',
    durationMs,
    event: 'chat_request',
    messageLength: payload.message.length,
    messagePreview: createMessagePreview(payload.message),
    requestId: payload.requestId ?? 'unknown',
    route,
    sessionIdPresent: payload.sessionId !== undefined,
    statusCode,
    userIdPresent: payload.userId !== undefined,
  };
}

function createMessagePreview(message: string): string {
  const normalized = sanitizeLogPreviewText(message).replace(/\s+/gu, ' ').trim();
  if (normalized.length <= 160) {
    return normalized;
  }
  return `${normalized.slice(0, 159)}…`;
}

function sanitizeLogPreviewText(text: string): string {
  return redactSensitiveCredentials(text)
    .replace(/\b0x[a-fA-F0-9]{64}\b/gu, '[evm_tx_hash]')
    .replace(/\b0x[a-fA-F0-9]{40}\b/gu, '[evm_address]')
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/gu, '[solana_signature]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[phone]')
    .trim();
}

function redactSensitiveCredentials(text: string): string {
  return text
    .replace(
      /((?:私钥|助记词|恢复词|密钥)\s*(?:是|为|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:private\s+key|seed\s+phrase|mnemonic|secret\s+recovery\s+phrase)\s*(?:is|:|：)?\s*)((?:0x)?[a-fA-F0-9]{64}\b|(?:[a-z]{3,}\s+){11,23}[a-z]{3,})/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:我的)?(?:密码|登录密码)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
      '$1[sensitive_credential]',
    )
    .replace(
      /((?:api\s*key|access\s*token|auth\s*token|访问令牌)\s*(?:是|为|:|：|=)\s*)[^\s,，。；;]+/giu,
      '$1[sensitive_credential]',
    )
    .replace(/(\b(?:my\s+)?password\s*(?:is|:|=)\s*)[^\s,，。；;]+/giu, '$1[sensitive_credential]');
}

async function createDeepHealthStatus(
  config: ReturnType<typeof loadRagConfig>,
  env: ApiEnv,
): Promise<DeepHealthStatus> {
  const checks: DeepHealthStatus['checks'] = {
    browser: await checkBrowserRuntime(env),
    config: checkRequiredConfig(config),
    embedding: await checkEmbedding(config),
    llm: await checkLlm(config),
    vectorStore: await checkVectorStore(config),
  };

  return {
    checks,
    status: Object.values(checks).every((check) => check.status === 'ok') ? 'ok' : 'degraded',
  };
}

async function checkBrowserRuntime(env: ApiEnv): Promise<HealthCheck> {
  const chromeExecutable = env.XXYY_SCREENSHOT_CHROME_EXECUTABLE?.trim();
  const profileDirectory = env.XXYY_BROWSER_PROFILE_DIRECTORY?.trim();
  const screenshotDirectory = env.XXYY_SCREENSHOT_DIRECTORY?.trim();
  const configuredValues = [chromeExecutable, profileDirectory, screenshotDirectory];

  if (configuredValues.every((value) => value === undefined || value.length === 0)) {
    return { configured: false, status: 'ok' };
  }

  const missing = [
    ['XXYY_SCREENSHOT_CHROME_EXECUTABLE', chromeExecutable],
    ['XXYY_BROWSER_PROFILE_DIRECTORY', profileDirectory],
    ['XXYY_SCREENSHOT_DIRECTORY', screenshotDirectory],
  ]
    .filter((entry) => entry[1] === undefined || entry[1]!.length === 0)
    .map((entry) => entry[0]!);
  if (missing.length > 0) {
    return { configured: true, missing, status: 'error' };
  }

  try {
    await access(chromeExecutable!, fsConstants.X_OK);
    await access(profileDirectory!, fsConstants.R_OK | fsConstants.W_OK);
    await access(screenshotDirectory!, fsConstants.R_OK | fsConstants.W_OK);
    const egoBrowserExecutable = await resolveEgoBrowserExecutable(env.PATH ?? process.env.PATH);
    if (egoBrowserExecutable === undefined) {
      return {
        configured: true,
        driver: 'ego-browser-unavailable',
        message: 'ego-browser is unavailable; public Explorer queries are disabled.',
        status: 'error',
      };
    }
    return { configured: true, driver: 'ego-browser', status: 'ok' };
  } catch {
    return {
      configured: true,
      message: 'Browser executable or evidence directories are unavailable.',
      status: 'error',
    };
  }
}

function checkRequiredConfig(config: ReturnType<typeof loadRagConfig>): HealthCheck {
  const missing: string[] = [];

  if (config.databaseUrl === undefined || config.databaseUrl.trim().length === 0) {
    missing.push('DATABASE_URL');
  }
  if (config.openAiApiKey === undefined || config.openAiApiKey.trim().length === 0) {
    missing.push('OPENAI_API_KEY');
  }
  if (config.openAiModel === undefined || config.openAiModel.trim().length === 0) {
    missing.push('OPENAI_MODEL');
  }

  if (missing.length > 0) {
    return { missing, status: 'error' };
  }

  return { status: 'ok' };
}

async function checkVectorStore(config: ReturnType<typeof loadRagConfig>): Promise<HealthCheck> {
  if (config.databaseUrl === undefined || config.databaseUrl.trim().length === 0) {
    return {
      message: 'DATABASE_URL is required for pgvector retrieval.',
      status: 'error',
    };
  }

  const pool = createPgPool(config.databaseUrl);
  try {
    const result = await pool.query<{
      chunk_count: number;
      vector_extension: boolean;
    }>(`
      select
        exists(select 1 from pg_extension where extname = 'vector') as vector_extension,
        (select count(*)::integer from knowledge_chunks) as chunk_count
    `);
    const row = result.rows[0];
    if (row === undefined) {
      return { message: 'Vector store health query returned no rows.', status: 'error' };
    }
    return {
      chunkCount: row.chunk_count,
      status: row.vector_extension ? 'ok' : 'error',
      vectorExtension: row.vector_extension,
      ...(row.vector_extension ? {} : { message: 'pgvector extension is not enabled.' }),
    };
  } catch (error) {
    return { message: healthErrorMessage(error), status: 'error' };
  } finally {
    await pool.end();
  }
}

async function checkEmbedding(config: ReturnType<typeof loadRagConfig>): Promise<HealthCheck> {
  try {
    const provider = createOpenAiEmbeddingProvider({
      apiKey: config.embeddingApiKey,
      baseUrl: config.embeddingBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiEmbeddingModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    const [embedding] = await provider.embedTexts(['XXYY health check']);
    if (embedding === undefined) {
      return { message: 'Embedding response did not include an embedding.', status: 'error' };
    }
    return {
      dimension: embedding.length,
      model: config.openAiEmbeddingModel,
      status: 'ok',
    };
  } catch (error) {
    return { message: healthErrorMessage(error), status: 'error' };
  }
}

async function checkLlm(config: ReturnType<typeof loadRagConfig>): Promise<HealthCheck> {
  const apiKey = config.openAiApiKey;
  const model = config.openAiModel;
  const missingApiKey = apiKey === undefined || apiKey.trim().length === 0;
  const missingModel = model === undefined || model.trim().length === 0;

  if (missingApiKey && missingModel) {
    return {
      message: 'OPENAI_API_KEY and OPENAI_MODEL are required for LLM answer generation.',
      status: 'error',
    };
  }
  if (missingApiKey) {
    return {
      message: 'OPENAI_API_KEY is required for LLM answer generation.',
      status: 'error',
    };
  }
  if (missingModel) {
    return {
      message: 'OPENAI_MODEL is required for LLM answer generation.',
      status: 'error',
    };
  }

  const resolvedApiKey = apiKey;
  const resolvedModel = model;

  try {
    const response = await fetchWithHealthTimeout(
      `${config.openAiBaseUrl.replace(/\/+$/u, '')}/chat/completions`,
      {
        body: JSON.stringify({
          messages: [
            { content: 'Reply with OK only.', role: 'system' },
            { content: 'health check', role: 'user' },
          ],
          model: resolvedModel,
          temperature: 0,
        }),
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      },
      config.openAiRequestTimeoutMs,
    );

    if (!response.ok) {
      return {
        message: `LLM health request failed with status ${response.status}${await readHealthErrorDetail(response)}`,
        model: resolvedModel,
        status: 'error',
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return {
        message: 'LLM health response did not include message content.',
        model: resolvedModel,
        status: 'error',
      };
    }

    return { model: resolvedModel, status: 'ok' };
  } catch (error) {
    return {
      message: healthErrorMessage(error),
      model: resolvedModel,
      status: 'error',
    };
  }
}

async function fetchWithHealthTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readHealthErrorDetail(response: Response): Promise<string> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return '';
  }

  try {
    const payload = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = payload.error?.message ?? payload.message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return `: ${message.trim()}`;
    }
  } catch {
    return `: ${truncateHealthError(text)}`;
  }

  return `: ${truncateHealthError(text)}`;
}

function truncateHealthError(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 300);
}

function healthErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDefaultApiEnv(
  options: Pick<CreateRequestHandlerOptions, 'cwd' | 'env'> = {},
): ApiEnv {
  return loadWorkspaceEnv({
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });
}

export function startServer(options: StartServerOptions = {}): ReturnType<typeof createServer> {
  const env = options.env ?? createDefaultApiEnv(options);
  void logExplorerBrowserStartup(env);
  const port = Number(options.port ?? env.PORT ?? 3000);
  const portRetryLimit =
    options.portRetryLimit ?? (env.NODE_ENV === 'production' ? 0 : DEFAULT_LOCAL_PORT_RETRY_LIMIT);
  const handler = createRequestHandler({
    ...options,
    env,
    logger: options.logger ?? createConsoleApiLogger(),
  });
  const server = createServer((request, response) => {
    void handler(request as ApiRequestLike, response);
  });

  listenWithPortRetry(server, port, portRetryLimit);

  return server;
}

async function logExplorerBrowserStartup(env: ApiEnv): Promise<void> {
  const executable = await resolveEgoBrowserExecutable(env.PATH ?? process.env.PATH);
  process.stdout.write(
    executable === undefined
      ? 'Explorer browser: ego-browser not found. Install ego lite from https://lite.ego.app/ for public transaction queries; product Q&A remains available.\n'
      : `Explorer browser: ego-browser ready for all supported chains (${executable}).\n`,
  );
}

function listenWithPortRetry(
  server: ReturnType<typeof createServer>,
  initialPort: number,
  retryLimit: number,
): void {
  let currentPort = initialPort;
  let remainingRetries = normalizePortRetryLimit(retryLimit);
  const onError = (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE' || remainingRetries <= 0 || currentPort >= 65535) {
      if (server.listenerCount('error') <= 1) {
        throw error;
      }
      return;
    }

    const nextPort = currentPort + 1;
    remainingRetries -= 1;
    process.stderr.write(`Port ${currentPort} is already in use; trying ${nextPort}.\n`);
    currentPort = nextPort;
    server.listen(currentPort);
  };

  server.on('error', onError);
  server.listen(currentPort, () => {
    server.off('error', onError);
    process.stdout.write(`XXYY RAG API listening on http://localhost:${currentPort}\n`);
  });
}

function normalizePortRetryLimit(retryLimit: number): number {
  if (!Number.isFinite(retryLimit) || retryLimit <= 0) {
    return 0;
  }

  return Math.floor(retryLimit);
}

function createCachedChatServiceLoader(
  config: ReturnType<typeof loadRagConfig>,
  tracer: QualityTracer,
  env: ApiEnv,
  answerQualityRolloutObserver: AnswerQualityRolloutObserver | undefined,
): () => Promise<ChatService> {
  let cachedService: ChatService | undefined;

  return async () => {
    if (cachedService !== undefined) {
      return Promise.resolve(cachedService);
    }

    const retriever = createLazyRetriever(async () => {
      const pool = createPgPool(config.databaseUrl);

      try {
        const embeddingProvider = createOpenAiEmbeddingProvider({
          apiKey: config.embeddingApiKey,
          baseUrl: config.embeddingBaseUrl,
          maxRetries: config.openAiMaxRetries,
          model: config.openAiEmbeddingModel,
          requestTimeoutMs: config.openAiRequestTimeoutMs,
        });
        return createPgVectorStore({
          client: pool,
          embeddingDimension: config.embeddingDimension,
          embeddingProvider,
          tracer,
        });
      } catch (error) {
        await pool.end();
        throw error;
      }
    });
    const publicTransactionClient = await createOptionalTransactionSkillClient(env);
    const xxyyTransactionDiagnosis =
      publicTransactionClient === undefined
        ? undefined
        : createTransactionSkillDiagnosisHandler({
            env,
            ...(env.XXYY_SCREENSHOT_DIRECTORY?.trim()
              ? { outputDirectory: env.XXYY_SCREENSHOT_DIRECTORY.trim() }
              : {}),
          });
    cachedService = createCustomerAgentChatService({
      answerQualityRollout: loadAnswerQualityRolloutConfig(env),
      ...(answerQualityRolloutObserver === undefined ? {} : { answerQualityRolloutObserver }),
      answerProvider: createLazyAnswerProvider(config, tracer),
      config,
      productCapabilityCaller: {
        channel: 'web',
        principal: 'anonymous',
      },
      ...(publicTransactionClient === undefined
        ? {}
        : {
            publicChainCapabilityCaller: {
              channel: 'web' as const,
              principal: 'anonymous' as const,
            },
            publicTransactionClient,
          }),
      ...(xxyyTransactionDiagnosis === undefined
        ? {}
        : {
            xxyyDiagnosisCapabilityCaller: {
              channel: 'web' as const,
              principal: 'anonymous' as const,
            },
            xxyyTransactionDiagnosis,
          }),
      retriever,
      tracer,
    });
    return Promise.resolve(cachedService);
  };
}

async function createOptionalTransactionSkillClient(env: ApiEnv) {
  const egoBrowserExecutable = await resolveEgoBrowserExecutable(env.PATH ?? process.env.PATH);
  return egoBrowserExecutable === undefined
    ? undefined
    : createTransactionSkillPublicClient({ env });
}

function createCachedFeedbackRecorder(config: ReturnType<typeof loadRagConfig>): FeedbackRecorder {
  let recorder: FeedbackRecorder | undefined;

  return async (input) => {
    if (recorder === undefined) {
      const pool = createPgPool(config.databaseUrl);
      const store = createPgFeedbackStore({ client: pool });
      recorder = (record) => store.recordFeedback(record);
    }
    await recorder(input);
  };
}

function createCachedApiCallRecorder(
  config: ReturnType<typeof loadRagConfig>,
  env: ApiEnv,
): (input: ApiCallObservation) => Promise<void> {
  let recorder: ((input: ApiCallObservation) => Promise<void>) | undefined;
  return async (input) => {
    if (recorder === undefined) {
      const pool = createPgPool(config.databaseUrl);
      const store = createPgApiObservabilityStore({
        client: pool,
        ...(env.OBSERVABILITY_CLIENT_HASH_SALT === undefined
          ? {}
          : { hashSalt: env.OBSERVABILITY_CLIENT_HASH_SALT }),
      });
      recorder = (record) => store.record(record);
    }
    await recorder(input);
  };
}

function createCachedDailyChatQuotaConsumer(
  config: ReturnType<typeof loadRagConfig>,
  env: ApiEnv,
  apiConfig: Pick<ApiRuntimeConfig, 'dailyChatLimit' | 'dailyChatLimitTimeZone'>,
): (identity: string) => Promise<DailyChatQuotaResult> {
  let consume: ((identity: string) => Promise<DailyChatQuotaResult>) | undefined;
  return async (identity) => {
    if (consume === undefined) {
      const pool = createPgPool(config.databaseUrl);
      const hashSalt = env.DAILY_CHAT_LIMIT_HASH_SALT ?? env.OBSERVABILITY_CLIENT_HASH_SALT;
      const store = createPgDailyChatQuotaStore({
        client: pool,
        ...(hashSalt === undefined ? {} : { hashSalt }),
      });
      consume = (nextIdentity) =>
        store.consume({
          identity: nextIdentity,
          limit: apiConfig.dailyChatLimit,
          timeZone: apiConfig.dailyChatLimitTimeZone,
        });
    }
    return consume(identity);
  };
}

function createUnlimitedDailyChatQuota(
  limit: number,
  timeZone: string,
): (identity: string) => Promise<DailyChatQuotaResult> {
  return () =>
    Promise.resolve({
      allowed: true,
      limit,
      quotaDate: quotaDateInTimeZone(new Date(), timeZone),
      remaining: limit,
      used: 0,
    });
}

function dailyChatQuotaIdentity(
  payload: ChatPayload,
  apiKeyId: string | undefined,
  clientAddressValue: string,
): string {
  if (payload.userId !== undefined) return `user:${payload.channel ?? 'web'}:${payload.userId}`;
  if (apiKeyId !== undefined) return `api-key:${apiKeyId}`;
  if (payload.sessionId !== undefined)
    return `session:${payload.channel ?? 'web'}:${payload.sessionId}`;
  return `client:${clientAddressValue}`;
}

function createCachedSupportOperationsStoreLoader(
  config: ReturnType<typeof loadRagConfig>,
): () => Promise<PgSupportOperationsStore> {
  let store: PgSupportOperationsStore | undefined;
  return async () => {
    if (store === undefined) {
      const pool = createPgPool(config.databaseUrl);
      store = createPgSupportOperationsStore({ client: pool });
    }
    return store;
  };
}

function isTestRuntime(env: ApiEnv): boolean {
  return (
    env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
  );
}

const noopFeedbackRecorder: FeedbackRecorder = () => Promise.resolve();

function createLazyAnswerProvider(
  config: ReturnType<typeof loadRagConfig>,
  tracer: QualityTracer,
): AnswerProvider {
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

async function readJsonBody(request: ApiRequestLike, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    byteLength += bytes.length;
    if (byteLength > maxBodyBytes) {
      throw new PayloadTooLargeError();
    }
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks, byteLength).toString('utf8');

  if (body.trim().length === 0) {
    throw new BadRequestError('Request body must be JSON.');
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (_error) {
    throw new BadRequestError('Request body must be valid JSON.');
  }
}

function parseChatPayload(value: unknown): ChatPayload {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message !== 'string' || record.message.trim().length === 0) {
    throw new BadRequestError('message must be a non-empty string.');
  }

  const channel = parseOptionalChannel(record.channel);

  return withOptionalFields(
    {
      message: record.message.trim(),
      ...(channel === undefined ? {} : { channel }),
    },
    record,
  );
}

function parseFeedbackPayload(value: unknown): RecordFeedbackInput {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestError('Request body must be a JSON object.');
  }

  const record = value as Record<string, unknown>;
  const question = parseRequiredString(record.question, 'question');
  const answer = parseRequiredString(record.answer, 'answer');
  const channel = parseOptionalChannel(record.channel) ?? 'web';
  if (record.rating !== 'positive' && record.rating !== 'negative') {
    throw new BadRequestError('rating must be positive or negative.');
  }
  if (
    typeof record.intent !== 'string' ||
    !supportedIntents.includes(record.intent as (typeof supportedIntents)[number])
  ) {
    throw new BadRequestError(`intent must be one of: ${supportedIntents.join(', ')}.`);
  }
  if (
    typeof record.citationCount !== 'number' ||
    !Number.isInteger(record.citationCount) ||
    record.citationCount < 0
  ) {
    throw new BadRequestError('citationCount must be a non-negative integer.');
  }

  const comment = parseOptionalString(record.comment, 'comment')?.trim();
  const failureReason = parseOptionalString(record.failureReason, 'failureReason')?.trim();
  if (
    failureReason !== undefined &&
    !feedbackFailureReasons.includes(failureReason as (typeof feedbackFailureReasons)[number])
  ) {
    throw new BadRequestError(
      `failureReason must be one of: ${feedbackFailureReasons.join(', ')}.`,
    );
  }
  if (record.rating === 'positive' && failureReason !== undefined) {
    throw new BadRequestError('failureReason is only valid for negative feedback.');
  }
  const sessionId = parseOptionalString(record.sessionId, 'sessionId')?.trim();
  return {
    answer,
    channel,
    citationCount: record.citationCount,
    intent: record.intent as RecordFeedbackInput['intent'],
    question,
    rating: record.rating,
    ...(comment === undefined || comment.length === 0 ? {} : { comment }),
    ...(failureReason === undefined
      ? {}
      : {
          failureReason: failureReason as NonNullable<RecordFeedbackInput['failureReason']>,
        }),
    ...(sessionId === undefined || sessionId.length === 0 ? {} : { sessionId }),
  };
}

function parseSupportEscalationPayload(value: unknown): {
  channel: ChatChannel;
  priority: 'high' | 'low' | 'normal' | 'urgent';
  reason: SupportEscalationReason;
  sessionId: string;
  subject: string;
  userId?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestError('Request body must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const sessionId = parseRequiredString(record.sessionId, 'sessionId');
  if (!isHighEntropySupportSessionId(sessionId)) {
    throw new BadRequestError('sessionId must be a high-entropy opaque identifier.');
  }
  const subject = parseRequiredString(record.subject, 'subject');
  const channel = parseOptionalChannel(record.channel) ?? 'web';
  const reasons: readonly SupportEscalationReason[] = [
    'account_or_private_data',
    'explicit_human_request',
    'low_evidence',
    'negative_feedback',
    'repeated_unresolved',
    'other',
  ];
  if (
    typeof record.reason !== 'string' ||
    !reasons.includes(record.reason as SupportEscalationReason)
  ) {
    throw new BadRequestError(`reason must be one of: ${reasons.join(', ')}.`);
  }
  const priorities = ['low', 'normal', 'high', 'urgent'] as const;
  const priority =
    record.priority === undefined
      ? 'normal'
      : priorities.includes(record.priority as (typeof priorities)[number])
        ? (record.priority as (typeof priorities)[number])
        : undefined;
  if (priority === undefined) {
    throw new BadRequestError(`priority must be one of: ${priorities.join(', ')}.`);
  }
  const userId = parseOptionalString(record.userId, 'userId')?.trim();
  return {
    channel,
    priority,
    reason: record.reason as SupportEscalationReason,
    sessionId,
    subject,
    ...(userId === undefined || userId.length === 0 ? {} : { userId }),
  };
}

function isHighEntropySupportSessionId(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) ||
    /^[A-Za-z0-9_-]{32,256}$/u.test(value)
  );
}

function createAgentApiOpenApiDocument(): Record<string, unknown> {
  const bearerSecurity = [{ bearerAuth: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'XXYY Agent API',
      version: '1.0.0',
      description:
        'Versioned API for product support chat, streaming, quality feedback, and explicit human escalation.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: { scheme: 'bearer', type: 'http' },
      },
      schemas: {
        ChatRequest: {
          type: 'object',
          required: ['message'],
          properties: {
            channel: { enum: supportedChannels, type: 'string' },
            message: { minLength: 1, type: 'string' },
            requestId: { type: 'string' },
            sessionId: { type: 'string' },
            userId: { type: 'string' },
          },
        },
        FeedbackRequest: {
          type: 'object',
          required: ['answer', 'citationCount', 'intent', 'question', 'rating'],
          properties: {
            answer: { minLength: 1, type: 'string' },
            channel: { enum: supportedChannels, type: 'string' },
            citationCount: { minimum: 0, type: 'integer' },
            comment: { type: 'string' },
            failureReason: { enum: feedbackFailureReasons, type: 'string' },
            intent: { enum: supportedIntents, type: 'string' },
            question: { minLength: 1, type: 'string' },
            rating: { enum: ['positive', 'negative'], type: 'string' },
            sessionId: { type: 'string' },
          },
        },
        Error: {
          type: 'object',
          required: ['error', 'message'],
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        },
      },
    },
    paths: {
      '/chat': {
        post: {
          operationId: 'ask',
          security: bearerSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } },
            },
          },
          responses: {
            '200': { description: 'Agent answer with citations and confidence.' },
            '401': { description: 'Invalid API key.' },
          },
        },
      },
      '/chat/stream': {
        post: {
          operationId: 'stream',
          security: bearerSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } },
            },
          },
          responses: {
            '200': { description: 'Server-sent Agent status, answer delta, and metadata events.' },
          },
        },
      },
      '/feedback': {
        post: {
          operationId: 'recordFeedback',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/FeedbackRequest' } },
            },
          },
          security: bearerSecurity,
          responses: { '204': { description: 'Feedback recorded.' } },
        },
      },
      '/support/escalate': {
        post: {
          operationId: 'escalate',
          security: bearerSecurity,
          responses: { '201': { description: 'Idempotent support ticket created or returned.' } },
        },
      },
    },
  };
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function withOptionalFields(
  payload: { message: string; channel?: ChatChannel },
  record: Record<string, unknown>,
): ChatPayload {
  const sessionId = parseOptionalString(record.sessionId, 'sessionId');
  const userId = parseOptionalString(record.userId, 'userId');
  const requestId = parseOptionalString(record.requestId, 'requestId');

  return {
    ...payload,
    ...(requestId === undefined ? {} : { requestId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(userId === undefined ? {} : { userId }),
  };
}

function parseOptionalChannel(value: unknown): ChatChannel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !supportedChannels.includes(value as ChatChannel)) {
    throw new BadRequestError('channel must be one of: cli, web, telegram.');
  }

  return value as ChatChannel;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new BadRequestError(`${fieldName} must be a string.`);
  }

  return value;
}

function toChatRequest(payload: ChatPayload): ChatRequest {
  return {
    channel: payload.channel ?? 'web',
    message: payload.message,
    ...(payload.requestId === undefined ? {} : { requestId: payload.requestId }),
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    ...(payload.userId === undefined ? {} : { userId: payload.userId }),
  };
}

function sendJson(response: ApiResponseLike, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload)}\n`);
}

function createDefaultStaticAssetsDir(
  options: Pick<CreateRequestHandlerOptions, 'cwd'>,
  env: ApiEnv,
): string {
  const workspaceCwd = resolveWorkspaceCwd(options.cwd ?? process.cwd(), env);
  return path.join(workspaceCwd, 'docs', 'product-features', 'assets');
}

function createDefaultWebAssetsDir(
  options: Pick<CreateRequestHandlerOptions, 'cwd'>,
  env: ApiEnv,
): string {
  const workspaceCwd = resolveWorkspaceCwd(options.cwd ?? process.cwd(), env);
  return path.join(workspaceCwd, 'apps', 'web', 'dist', 'web-assets');
}

async function sendStaticAsset(
  response: ApiResponseLike,
  assetsDir: string,
  pathname: string,
  isAllowedAssetName?: (assetName: string) => boolean,
  cacheControl = 'public, max-age=31536000, immutable',
): Promise<void> {
  const assetName = decodeURIComponent(
    pathname.replace(/^\/(?:assets|web-assets|xxyy-evidence)\//u, ''),
  );
  if (
    !/^[A-Za-z0-9._-]+$/u.test(assetName) ||
    (isAllowedAssetName !== undefined && !isAllowedAssetName(assetName))
  ) {
    sendJson(response, 404, { error: 'not_found', message: 'Asset not found.' });
    return;
  }

  try {
    const body = await readFile(path.join(assetsDir, assetName));
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypeForAsset(assetName));
    response.setHeader('Cache-Control', cacheControl);
    response.end(body);
  } catch (error) {
    if (isMissingFileError(error)) {
      sendJson(response, 404, { error: 'not_found', message: 'Asset not found.' });
      return;
    }
    throw error;
  }
}

function isAllowedProductAssetName(assetName: string): boolean {
  return PRODUCT_ASSET_NAMES.has(assetName) || PRODUCT_DOC_ASSET_NAME_PATTERN.test(assetName);
}

function contentTypeForAsset(assetName: string): string {
  const lower = assetName.toLowerCase();
  if (lower.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.avif')) {
    return 'image/avif';
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lower.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (lower.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (lower.endsWith('.js')) {
    return 'application/javascript; charset=utf-8';
  }
  if (lower.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }

  return 'application/octet-stream';
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

interface ChatStreamSummary {
  outcome: 'success' | 'error';
  statusCode: number;
  answer?: string;
  answerStatus?: ChatResponse['answerStatus'];
  agentRoute?: ChatResponse['agentRoute'];
  attachmentCount?: number;
  citationCount?: number;
  confidence?: number;
  error?: string;
  intent?: ChatResponse['intent'];
  sourceTypes?: SourceType[];
  tokenUsage?: ChatTokenUsage;
}

async function sendChatStream(
  response: ApiResponseLike,
  events: AsyncIterable<ChatStreamEvent>,
  observe?: (event: { errorCode?: string; tokenUsage?: ChatTokenUsage }) => void,
): Promise<ChatStreamSummary> {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();

  let metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined;
  let answer = '';

  try {
    for await (const event of events) {
      writeSseEvent(response, event.type, event);
      if (event.type === 'answer_delta') {
        answer += event.delta;
      }
      if (event.type === 'metadata') {
        metadata = event;
        observe?.(event.tokenUsage === undefined ? {} : { tokenUsage: event.tokenUsage });
      }
    }
    return {
      answer,
      ...(metadata?.answerStatus === undefined ? {} : { answerStatus: metadata.answerStatus }),
      attachmentCount: metadata?.attachments?.length ?? 0,
      ...(metadata?.agentRoute === undefined ? {} : { agentRoute: metadata.agentRoute }),
      citationCount: metadata?.citations.length ?? 0,
      ...(metadata?.confidence === undefined ? {} : { confidence: metadata.confidence }),
      ...(metadata?.intent === undefined ? {} : { intent: metadata.intent }),
      ...(metadata === undefined ? {} : { sourceTypes: feedbackSourceTypes(metadata.citations) }),
      ...(metadata?.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
      outcome: 'success',
      statusCode: 200,
    };
  } catch (error) {
    const payload = createApiErrorResponse(error).body;
    observe?.({ errorCode: payload.error });
    writeSseEvent(response, 'error', payload);
    return {
      error: payload.error,
      outcome: 'error',
      statusCode: 200,
    };
  } finally {
    response.end();
  }
}

function writeSseEvent(response: ApiResponseLike, eventName: string, payload: unknown): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.flush?.();
}

function createApiErrorResponse(error: unknown): {
  body: { error: string; message: string };
  statusCode: number;
} {
  if (error instanceof BadRequestError) {
    return {
      body: { error: 'bad_request', message: error.message },
      statusCode: 400,
    };
  }

  if (error instanceof PayloadTooLargeError) {
    return {
      body: {
        error: 'payload_too_large',
        message: 'Request body exceeds the configured size limit.',
      },
      statusCode: 413,
    };
  }

  if (error instanceof LlmConfigurationError) {
    return {
      body: { error: 'llm_configuration_missing', message: error.message },
      statusCode: 503,
    };
  }

  if (error instanceof EmbeddingConfigurationError) {
    return {
      body: { error: 'embedding_configuration_missing', message: error.message },
      statusCode: 503,
    };
  }

  if (error instanceof VectorStoreConfigurationError) {
    return {
      body: { error: 'vector_store_configuration_missing', message: error.message },
      statusCode: 503,
    };
  }

  if (error instanceof VectorStoreUnavailableError) {
    return {
      body: { error: 'vector_store_unavailable', message: error.message },
      statusCode: 503,
    };
  }

  return {
    body: { error: 'internal_error', message: 'Unable to process request.' },
    statusCode: 500,
  };
}

function noopLogger(_entry: ApiLogEntry): void {}

async function noopApiCallRecorder(_entry: ApiCallObservation): Promise<void> {}

function isObservedApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname.startsWith('/admin/api/');
}

function instrumentApiResponse(input: {
  draft: ApiObservationDraft;
  method: string;
  now: () => number;
  path: string;
  record: (observation: ApiCallObservation) => Promise<void>;
  remoteAddress: string;
  response: ApiResponseLike;
  startedAt: number;
}): void {
  const originalEnd = input.response.end.bind(input.response);
  let ended = false;
  input.response.end = (body?: string | Uint8Array): void => {
    if (!ended) {
      ended = true;
      const errorCode = input.draft.errorCode ?? readErrorCode(body);
      const statusCode = input.response.statusCode;
      void input
        .record({
          ...input.draft,
          clientAddress: input.remoteAddress,
          durationMs: Math.max(0, input.now() - input.startedAt),
          ...(errorCode === undefined ? {} : { errorCode }),
          method: input.method,
          path: input.path,
          rateLimited: statusCode === 429,
          statusCode,
        })
        .catch(() => undefined);
    }
    originalEnd(body);
  };
}

function readErrorCode(body: string | Uint8Array | undefined): string | undefined {
  if (typeof body !== 'string' || body.length > 16_384) return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error.slice(0, 160)
      : undefined;
  } catch {
    return undefined;
  }
}

function enrichObservationWithTokenUsage(
  options: Pick<
    HandleChatRequestOptions,
    'completionCostPerMillionTokens' | 'observation' | 'promptCostPerMillionTokens'
  >,
  usage: ChatTokenUsage | undefined,
): void {
  if (usage === undefined) return;
  if (usage.promptTokens !== undefined) options.observation.promptTokens = usage.promptTokens;
  if (usage.completionTokens !== undefined) {
    options.observation.completionTokens = usage.completionTokens;
  }
  options.observation.totalTokens = usage.totalTokens;
  options.observation.modelCallCount = 1;
  options.observation.estimatedCostUsd =
    ((usage.promptTokens ?? 0) * options.promptCostPerMillionTokens +
      (usage.completionTokens ?? 0) * options.completionCostPerMillionTokens) /
    1_000_000;
}

function createConsoleApiLogger(): ApiLogger {
  return (entry) => {
    process.stdout.write(`${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`);
  };
}

function createConsoleAnswerQualityObserver(): AnswerQualityRolloutObserver {
  return (observation: AnswerQualityRolloutObservation) => {
    process.stdout.write(
      `${JSON.stringify({ event: 'answer_quality_rollout', ...observation })}\n`,
    );
  };
}

function sendHtml(response: ApiResponseLike, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(html);
}

function adminContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join('; ');
}

class BadRequestError extends Error {}

class PayloadTooLargeError extends Error {}

function isDirectRun(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  startServer();
}
