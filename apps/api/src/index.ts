import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createCustomerAgentChatService } from '@xxyy/agent-core';
import { createOpenAiEmbeddingProvider, EmbeddingConfigurationError } from '@xxyy/knowledge';
import {
  createOpenAiAnswerProvider,
  createPgFeedbackStore,
  createQualityTracerFromEnv,
  createLazyRetriever,
  createPgPool,
  createPgVectorStore,
  LlmConfigurationError,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from '@xxyy/rag-core';
import type { ChatRequest, ChatChannel, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import { supportedChannels, supportedIntents } from '@xxyy/shared';
import type {
  AnswerProvider,
  ChatService,
  QualityTracer,
  RagEnv,
  RecordFeedbackInput,
} from '@xxyy/rag-core';
import { renderAdminPage, renderChatPage } from '@xxyy/web';

import {
  createKnowledgeAdminAuthenticator,
  type KnowledgeAdminAuthenticator,
} from './knowledge-admin-auth.js';
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
      | 'NODE_ENV'
      | 'APP_REVISION'
      | 'LANGSMITH_API_KEY'
      | 'LANGSMITH_ENDPOINT'
      | 'LANGSMITH_PROJECT'
      | 'LANGSMITH_TRACING'
      | 'KNOWLEDGE_ADMIN_MAX_BODY_BYTES'
      | 'KNOWLEDGE_ADMIN_RATE_LIMIT_MAX'
      | 'KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS'
      | 'KNOWLEDGE_ADMIN_TOKENS_JSON'
      | 'PORT'
      | 'QUALITY_TRACE_SAMPLE_RATE'
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
  createRequestId?: () => string;
  cwd?: string;
  env?: ApiEnv;
  getChatService?: () => Promise<ChatService>;
  getHealthStatus?: () => Promise<DeepHealthStatus>;
  getKnowledgeAdminServices?: () => Promise<KnowledgeAdminServices>;
  knowledgeAdminAuthenticator?: KnowledgeAdminAuthenticator;
  logger?: ApiLogger;
  now?: () => number;
  recordFeedback?: FeedbackRecorder;
  renderHtml?: () => string;
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
  maxBodyBytes: number;
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
  vectorExtension?: boolean;
}

interface DeepHealthStatus {
  status: 'ok' | 'degraded';
  checks: {
    config: HealthCheck;
    embedding: HealthCheck;
    llm: HealthCheck;
    vectorStore: HealthCheck;
  };
}

export function createRequestHandler(options: CreateRequestHandlerOptions = {}): ApiRequestHandler {
  const env = options.env ?? createDefaultApiEnv(options);
  const config = loadRagConfig(env);
  const apiConfig = loadApiRuntimeConfig(env);
  const tracer = createQualityTracerFromEnv({ ...env });
  const renderHtml = options.renderHtml ?? renderChatPage;
  const renderKnowledgeAdminHtml = options.renderKnowledgeAdminHtml ?? renderAdminPage;
  const getChatService = options.getChatService ?? createCachedChatServiceLoader(config, tracer);
  const getHealthStatus = options.getHealthStatus ?? (() => createDeepHealthStatus(config));
  const getKnowledgeAdminServices =
    options.getKnowledgeAdminServices ?? createCachedKnowledgeAdminServicesLoader({ config, env });
  const knowledgeAdminAuthenticator =
    options.knowledgeAdminAuthenticator ??
    createKnowledgeAdminAuthenticator(env.KNOWLEDGE_ADMIN_TOKENS_JSON);
  const recordFeedback =
    options.recordFeedback ??
    (isTestRuntime(env) ? noopFeedbackRecorder : createCachedFeedbackRecorder(config));
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? Date.now;
  const createRequestId = options.createRequestId ?? randomUUID;
  const staticAssetsDir = options.staticAssetsDir ?? createDefaultStaticAssetsDir(options, env);
  const webAssetsDir = options.webAssetsDir ?? createDefaultWebAssetsDir(options, env);
  const rateLimiter = createRateLimiter(apiConfig, now);
  const adminRateLimiter = createRateLimiter(
    {
      rateLimitMax: apiConfig.adminRateLimitMax,
      rateLimitWindowMs: apiConfig.adminRateLimitWindowMs,
    },
    now,
  );

  return async function handleRequest(request, response): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const corsResult = applyCors(request, response, requestUrl, apiConfig);
    if (corsResult === 'handled') {
      return;
    }

    if (isKnowledgeAdminApiPath(requestUrl.pathname)) {
      const rateLimitResult = adminRateLimiter.check(clientAddress(request, apiConfig));
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

    if (isRateLimitedPostApiRoute(requestUrl.pathname) && request.method === 'POST') {
      const rateLimitResult = rateLimiter.check(clientAddress(request, apiConfig));
      if (!rateLimitResult.allowed) {
        response.setHeader('Retry-After', String(Math.ceil(rateLimitResult.retryAfterMs / 1000)));
        sendJson(response, 429, {
          error: 'rate_limited',
          message: 'Too many requests. Please try again later.',
        });
        return;
      }
    }

    try {
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
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

      if (request.method === 'GET' && requestUrl.pathname === '/') {
        sendHtml(response, 200, renderHtml());
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
          authenticator: knowledgeAdminAuthenticator,
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
        await sendStaticAsset(response, webAssetsDir, requestUrl.pathname);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/chat') {
        await handleChatRequest({
          getChatService,
          logger,
          createRequestId,
          maxBodyBytes: apiConfig.maxBodyBytes,
          now,
          recordFeedback,
          request,
          response,
          route: '/api/chat',
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/chat/stream') {
        await handleChatRequest({
          getChatService,
          logger,
          createRequestId,
          maxBodyBytes: apiConfig.maxBodyBytes,
          now,
          recordFeedback,
          request,
          response,
          route: '/api/chat/stream',
        });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/feedback') {
        const payload = parseFeedbackPayload(await readJsonBody(request, apiConfig.maxBodyBytes));
        await recordFeedback(payload);
        response.statusCode = 204;
        response.end();
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
  createRequestId: () => string;
  getChatService: () => Promise<ChatService>;
  logger: ApiLogger;
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
  const startedAt = options.now();
  const chatRequest = toChatRequest(requestPayload);

  try {
    const service = await options.getChatService();

    if (options.route === '/api/chat') {
      const chatResponse = await service.ask(chatRequest);
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

    const summary = await sendChatStream(options.response, service.stream(chatRequest));
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

async function recordAutomaticLowEvidence(
  recordFeedback: FeedbackRecorder,
  request: ChatRequest,
  response: ChatResponse,
): Promise<void> {
  if (!isLowEvidenceProductAnswer(response.intent, response.citations.length)) {
    return;
  }

  await recordFeedback({
    answer: response.answer,
    channel: request.channel,
    citationCount: response.citations.length,
    comment: 'automatic_low_evidence',
    intent: response.intent,
    question: request.message,
    rating: 'negative',
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
    !isLowEvidenceProductAnswer(summary.intent, summary.citationCount ?? 0)
  ) {
    return;
  }

  await recordFeedback({
    answer: summary.answer ?? '',
    channel: request.channel,
    citationCount: summary.citationCount ?? 0,
    comment: 'automatic_low_evidence',
    intent: summary.intent,
    question: request.message,
    rating: 'negative',
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  }).catch(() => undefined);
}

function isLowEvidenceProductAnswer(
  intent: ChatResponse['intent'],
  citationCount: number,
): boolean {
  return (intent === 'product_qa' || intent === 'how_to') && citationCount === 0;
}

function loadApiRuntimeConfig(env: ApiEnv): ApiRuntimeConfig {
  return {
    adminMaxBodyBytes: parsePositiveInteger(env.KNOWLEDGE_ADMIN_MAX_BODY_BYTES, 5 * 1024 * 1024),
    adminRateLimitMax: parsePositiveInteger(env.KNOWLEDGE_ADMIN_RATE_LIMIT_MAX, 30),
    adminRateLimitWindowMs: parsePositiveInteger(env.KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS, 60_000),
    corsOrigins: parseCsv(env.API_CORS_ORIGIN),
    enableDeepHealth: parseBoolean(env.API_ENABLE_DEEP_HEALTH, true),
    maxBodyBytes: parsePositiveInteger(env.API_MAX_BODY_BYTES, 64 * 1024),
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
    pathname === '/api/chat' || pathname === '/api/chat/stream' || pathname === '/api/feedback'
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
): Promise<DeepHealthStatus> {
  const checks: DeepHealthStatus['checks'] = {
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
): () => Promise<ChatService> {
  let cachedService: ChatService | undefined;

  return () => {
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
    cachedService = createCustomerAgentChatService({
      answerProvider: createLazyAnswerProvider(config, tracer),
      config,
      productCapabilityCaller: {
        channel: 'web',
        principal: 'anonymous',
      },
      retriever,
      tracer,
    });
    return Promise.resolve(cachedService);
  };
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
  const sessionId = parseOptionalString(record.sessionId, 'sessionId')?.trim();
  return {
    answer,
    channel,
    citationCount: record.citationCount,
    intent: record.intent as RecordFeedbackInput['intent'],
    question,
    rating: record.rating,
    ...(comment === undefined || comment.length === 0 ? {} : { comment }),
    ...(sessionId === undefined || sessionId.length === 0 ? {} : { sessionId }),
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
): Promise<void> {
  const assetName = decodeURIComponent(pathname.replace(/^\/(?:assets|web-assets)\//u, ''));
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
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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
  agentRoute?: ChatResponse['agentRoute'];
  attachmentCount?: number;
  citationCount?: number;
  confidence?: number;
  error?: string;
  intent?: ChatResponse['intent'];
}

async function sendChatStream(
  response: ApiResponseLike,
  events: AsyncIterable<ChatStreamEvent>,
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
      }
    }
    return {
      answer,
      attachmentCount: metadata?.attachments?.length ?? 0,
      ...(metadata?.agentRoute === undefined ? {} : { agentRoute: metadata.agentRoute }),
      citationCount: metadata?.citations.length ?? 0,
      ...(metadata?.confidence === undefined ? {} : { confidence: metadata.confidence }),
      ...(metadata?.intent === undefined ? {} : { intent: metadata.intent }),
      outcome: 'success',
      statusCode: 200,
    };
  } catch (error) {
    const payload = createApiErrorResponse(error).body;
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

function createConsoleApiLogger(): ApiLogger {
  return (entry) => {
    process.stdout.write(`${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`);
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
