import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { CreateCustomerAgentChatServiceOptions } from '@xxyy/agent-core';
import { EmbeddingConfigurationError } from '@xxyy/knowledge';
import type { ChatRequest, ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  LlmConfigurationError,
  QualityTracingConfigurationError,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
} from '@xxyy/rag-core';

import {
  createRateLimiter,
  createDefaultApiEnv,
  createRequestHandler,
  startServer,
  type ApiRequestHandler,
} from './index.js';
import type { ApiLogEntry } from './index.js';

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  rawBody: Buffer;
}

async function callHandler(
  handler: ApiRequestHandler,
  input: {
    method: string;
    url: string;
    body?: unknown;
    bodyChunks?: Buffer[];
    headers?: Record<string, string>;
    remoteAddress?: string;
  },
): Promise<CapturedResponse> {
  const chunks =
    input.bodyChunks ??
    (input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body), 'utf8')]);
  const request = {
    method: input.method,
    ...(input.remoteAddress === undefined
      ? {}
      : { socket: { remoteAddress: input.remoteAddress } }),
    url: input.url,
    headers: input.headers ?? {},
    [Symbol.asyncIterator]() {
      return Readable.from(chunks)[Symbol.asyncIterator]();
    },
  };
  const response: CapturedResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    rawBody: Buffer.alloc(0),
  };
  const bodyChunks: Buffer[] = [];

  await handler(request, {
    get statusCode() {
      return response.statusCode;
    },
    set statusCode(statusCode: number) {
      response.statusCode = statusCode;
    },
    setHeader(name: string, value: string) {
      response.headers[name] = value;
    },
    write(body: string) {
      bodyChunks.push(Buffer.from(body, 'utf8'));
      response.body += body;
      return true;
    },
    end(body?: string | Uint8Array) {
      if (body === undefined) {
        return;
      }
      const chunk = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
      bodyChunks.push(chunk);
      response.body += typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
    },
  });

  response.rawBody = Buffer.concat(bodyChunks);
  return response;
}

function createRuntimeConfigForTest(): Record<string, unknown> {
  return {
    databaseUrl: 'postgres://xxyy:secret@example.test/xxyy_ask',
    embeddingApiKey: 'embedding-test-key',
    embeddingBaseUrl: 'https://embedding.test/v1',
    embeddingDimension: 1536,
    openAiApiKey: 'test-key',
    openAiBaseUrl: 'https://api.openai.test/v1',
    openAiEmbeddingModel: 'text-embedding-3-small',
    openAiMaxRetries: 1,
    openAiModel: 'test-model',
    openAiRequestTimeoutMs: 30000,
    topK: 6,
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createBlockedPortWithFreeSuccessor(): Promise<{
  blockedPort: number;
  server: Server;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const blocker = createServer();
    await listen(blocker, 0);
    const blockedPort = (blocker.address() as AddressInfo).port;
    const probe = createServer();
    try {
      await listen(probe, blockedPort + 1);
      await closeServer(probe);
      return { blockedPort, server: blocker };
    } catch {
      await closeServer(probe);
      await closeServer(blocker);
    }
  }

  throw new Error('Unable to reserve adjacent test ports.');
}

function waitForServerListening(server: Server): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for server to listen.'));
    }, 1000);
    server.once('listening', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe('startServer', () => {
  it('automatically retries the next port in local mode when the requested port is busy', async () => {
    const blocker = await createBlockedPortWithFreeSuccessor();
    let apiServer: Server | undefined;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      apiServer = startServer({
        env: { NODE_ENV: 'development' },
        port: blocker.blockedPort,
      });
      await waitForServerListening(apiServer);

      expect((apiServer.address() as AddressInfo).port).toBe(blocker.blockedPort + 1);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      if (apiServer !== undefined) {
        await closeServer(apiServer);
      }
      await closeServer(blocker.server);
    }
  });
});

describe('createRequestHandler', () => {
  it('serves the management shell with strict browser security headers', async () => {
    const handler = createRequestHandler({
      renderKnowledgeAdminHtml: () => '<!doctype html><title>Knowledge Admin</title>',
    });

    const response = await callHandler(handler, { method: 'GET', url: '/admin' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Knowledge Admin');
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(response.headers['X-Frame-Options']).toBe('DENY');
  });

  it('rate limits the protected management namespace independently', async () => {
    const handler = createRequestHandler({
      env: {
        KNOWLEDGE_ADMIN_RATE_LIMIT_MAX: '1',
        KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS: '60000',
      },
    });

    const first = await callHandler(handler, {
      method: 'GET',
      remoteAddress: '203.0.113.10',
      url: '/admin/api/me',
    });
    const second = await callHandler(handler, {
      method: 'GET',
      remoteAddress: '203.0.113.10',
      url: '/admin/api/me',
    });

    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(429);
    expect(second.headers['Retry-After']).toBe('60');
  });

  it('loads workspace .env values for the default API environment', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-env-'));
    await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeFile(
      path.join(workspaceRoot, '.env'),
      [
        'POSTGRES_DB=xxyy_ask',
        'POSTGRES_HOST=localhost',
        'POSTGRES_PORT=5432',
        'POSTGRES_USER=xxyy',
        'POSTGRES_PASSWORD=from_file',
        'OPENAI_MODEL=openrouter/free',
      ].join('\n'),
    );

    const env = createDefaultApiEnv({
      cwd: workspaceRoot,
      env: {
        POSTGRES_PASSWORD: 'from_shell',
      },
    });

    expect(env.POSTGRES_DB).toBe('xxyy_ask');
    expect(env.POSTGRES_PASSWORD).toBe('from_shell');
    expect(env.OPENAI_MODEL).toBe('openrouter/free');
  });

  it('returns JSON health status', async () => {
    const handler = createRequestHandler();

    const response = await callHandler(handler, { method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  it('returns the public automatic knowledge refresh status without scheduler internals', async () => {
    const getKnowledgeRefreshStatus = vi.fn(() =>
      Promise.resolve({
        enabled: true,
        lastRun: {
          finishedAt: '2026-07-27T06:48:33.456Z',
          mode: 'incremental' as const,
          status: 'succeeded' as const,
        },
        schedule: {
          fullDailyAt: '03:30',
          incrementalEveryMinutes: 30,
          timeZone: 'Asia/Shanghai',
        },
        state: 'healthy' as const,
      }),
    );
    const handler = createRequestHandler({ env: {}, getKnowledgeRefreshStatus });

    const response = await callHandler(handler, {
      method: 'GET',
      url: '/api/knowledge-refresh-status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(response.body)).toEqual({
      enabled: true,
      lastRun: {
        finishedAt: '2026-07-27T06:48:33.456Z',
        mode: 'incremental',
        status: 'succeeded',
      },
      schedule: {
        fullDailyAt: '03:30',
        incrementalEveryMinutes: 30,
        timeZone: 'Asia/Shanghai',
      },
      state: 'healthy',
    });
    expect(getKnowledgeRefreshStatus).toHaveBeenCalledOnce();
  });

  it('returns 404 for the removed ops dashboard route', async () => {
    const handler = createRequestHandler();

    const response = await callHandler(handler, { method: 'GET', url: '/' + 'ops' });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: 'not_found',
      message: 'Route not found.',
    });
  });

  it('returns deep health status with dependency details', async () => {
    const handler = createRequestHandler({
      env: {},
      getHealthStatus: () =>
        Promise.resolve({
          checks: {
            config: { status: 'ok' },
            embedding: { model: 'text-embedding-3-small', status: 'ok' },
            llm: { model: 'gpt-test', status: 'ok' },
            vectorStore: { chunkCount: 42, status: 'ok', vectorExtension: true },
          },
          status: 'ok',
        }),
    });

    const response = await callHandler(handler, { method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      checks: {
        config: { status: 'ok' },
        embedding: { model: 'text-embedding-3-small', status: 'ok' },
        llm: { model: 'gpt-test', status: 'ok' },
        vectorStore: { chunkCount: 42, status: 'ok', vectorExtension: true },
      },
      status: 'ok',
    });
  });

  it('returns deep health in production without authorization', async () => {
    const getHealthStatus = vi.fn(() =>
      Promise.resolve({
        checks: {
          config: { status: 'ok' as const },
          embedding: { model: 'text-embedding-3-small', status: 'ok' as const },
          llm: { model: 'gpt-test', status: 'ok' as const },
          vectorStore: { chunkCount: 42, status: 'ok' as const, vectorExtension: true },
        },
        status: 'ok' as const,
      }),
    );
    const handler = createRequestHandler({
      env: { NODE_ENV: 'production' },
      getHealthStatus,
    });

    const response = await callHandler(handler, { method: 'GET', url: '/health/deep' });

    expect(response.statusCode).toBe(200);
    expect(getHealthStatus).toHaveBeenCalledOnce();
  });

  it('reports missing production configuration in deep health status', async () => {
    const handler = createRequestHandler({ env: {} });

    const response = await callHandler(handler, { method: 'GET', url: '/health/deep' });
    const payload = JSON.parse(response.body) as {
      checks: {
        config: { missing: string[]; status: string };
        embedding: { message: string; status: string };
        llm: { message: string; status: string };
        vectorStore: { message: string; status: string };
      };
      status: string;
    };

    expect(response.statusCode).toBe(503);
    expect(payload.status).toBe('degraded');
    expect(payload.checks.config).toEqual({
      missing: ['DATABASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL'],
      status: 'error',
    });
    expect(payload.checks.vectorStore.message).toBe(
      'DATABASE_URL is required for pgvector retrieval.',
    );
    expect(payload.checks.embedding.message).toBe(
      'EMBEDDING_API_KEY or OPENAI_API_KEY is required for embedding generation.',
    );
    expect(payload.checks.llm.message).toBe(
      'OPENAI_API_KEY and OPENAI_MODEL are required for LLM answer generation.',
    );
  });

  it('handles allowed CORS preflight requests for chat APIs', async () => {
    const handler = createRequestHandler({
      env: {
        API_CORS_ORIGIN: 'https://app.example',
      },
    });

    const response = await callHandler(handler, {
      headers: {
        'access-control-request-headers': 'Content-Type',
        origin: 'https://app.example',
      },
      method: 'OPTIONS',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, POST, PATCH, OPTIONS');
    expect(response.headers['Access-Control-Allow-Headers']).toBe('Content-Type');
    expect(response.body).toBe('');
  });

  it('accepts feedback without an authorization token', async () => {
    const recordFeedback = vi.fn(() => Promise.resolve());
    const handler = createRequestHandler({
      env: {
        API_CORS_ORIGIN: 'https://app.example',
      },
      recordFeedback,
    });

    const response = await callHandler(handler, {
      body: {
        answer: '根据知识库，支持设置挂单。',
        channel: 'web',
        citationCount: 1,
        intent: 'how_to',
        question: '怎么设置挂单？',
        rating: 'positive',
        sessionId: 'session-1',
      },
      method: 'POST',
      url: '/api/feedback',
    });

    expect(response.statusCode).toBe(204);
    expect(recordFeedback).toHaveBeenCalledWith({
      answer: '根据知识库，支持设置挂单。',
      channel: 'web',
      citationCount: 1,
      intent: 'how_to',
      question: '怎么设置挂单？',
      rating: 'positive',
      sessionId: 'session-1',
    });
  });

  it('records uncited product answers as a review backlog signal', async () => {
    const recordFeedback = vi.fn(() => Promise.resolve());
    const handler = createRequestHandler({
      recordFeedback,
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '当前知识库没有找到直接相关资料。',
              citations: [],
              confidence: 0.25,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { message: '一个尚未覆盖的产品问题', sessionId: 'session-low-evidence' },
      method: 'POST',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(200);
    expect(recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        citationCount: 0,
        comment: 'automatic_low_evidence',
        question: '一个尚未覆盖的产品问题',
        rating: 'negative',
        sessionId: 'session-low-evidence',
      }),
    );
  });

  it('adds CORS headers to allowed chat responses', async () => {
    const handler = createRequestHandler({
      env: {
        API_CORS_ORIGIN: 'https://app.example',
      },
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [],
              confidence: 0.8,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { origin: 'https://app.example' },
      method: 'POST',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('https://app.example');
  });

  it('rejects oversized JSON request bodies before invoking chat service', async () => {
    const handler = createRequestHandler({
      env: {
        API_MAX_BODY_BYTES: '32',
      },
      getChatService: () =>
        Promise.resolve({
          ask() {
            throw new Error('ask should not be called for oversized bodies');
          },
          stream() {
            throw new Error('stream should not be called for oversized bodies');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { message: '这个请求体会超过三十二个字节' },
      method: 'POST',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      error: 'payload_too_large',
      message: 'Request body exceeds the configured size limit.',
    });
  });

  it('decodes UTF-8 only after all request bytes are buffered', async () => {
    const body = Buffer.from(JSON.stringify({ channel: 'web', message: '你' }), 'utf8');
    const splitAt = body.indexOf(Buffer.from('你', 'utf8')) + 1;
    const ask = vi.fn(() =>
      Promise.resolve({
        answer: 'ok',
        citations: [],
        confidence: 0.8,
        intent: 'product_qa' as const,
      }),
    );
    const handler = createRequestHandler({
      env: {},
      getChatService: () =>
        Promise.resolve({
          ask,
          async *stream() {
            await Promise.resolve();
            yield {
              type: 'metadata' as const,
              citations: [],
              confidence: 0.8,
              intent: 'product_qa' as const,
            };
          },
        }),
    });

    const response = await callHandler(handler, {
      bodyChunks: [body.subarray(0, splitAt), body.subarray(splitAt)],
      method: 'POST',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(200);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ message: '你' }));
  });

  it('allows chat requests without authorization in production', async () => {
    const handler = createRequestHandler({
      env: {
        NODE_ENV: 'production',
      },
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [],
              confidence: 0.8,
              intent: 'product_qa' as const,
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      method: 'POST',
      remoteAddress: '198.51.100.10',
      url: '/api/chat',
    });

    expect(response.statusCode).toBe(200);
  });

  it('rate limits chat requests by socket address unless proxy headers are trusted', async () => {
    const handler = createRequestHandler({
      env: {
        API_RATE_LIMIT_MAX: '1',
        API_RATE_LIMIT_WINDOW_MS: '1000',
      },
      now: () => 100,
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [],
              confidence: 0.8,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const first = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { 'x-forwarded-for': '203.0.113.1' },
      method: 'POST',
      remoteAddress: '198.51.100.10',
      url: '/api/chat',
    });
    const second = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { 'x-forwarded-for': '203.0.113.2' },
      method: 'POST',
      remoteAddress: '198.51.100.10',
      url: '/api/chat',
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.headers['Retry-After']).toBe('1');
    expect(JSON.parse(second.body)).toEqual({
      error: 'rate_limited',
      message: 'Too many requests. Please try again later.',
    });
  });

  it('uses x-forwarded-for for rate limiting only when TRUST_PROXY is true', async () => {
    const handler = createRequestHandler({
      env: {
        API_RATE_LIMIT_MAX: '1',
        API_RATE_LIMIT_WINDOW_MS: '1000',
        TRUST_PROXY: 'true',
      },
      now: () => 100,
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [],
              confidence: 0.8,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const first = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { 'x-forwarded-for': '203.0.113.1' },
      method: 'POST',
      remoteAddress: '198.51.100.10',
      url: '/api/chat',
    });
    const second = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { 'x-forwarded-for': '203.0.113.2' },
      method: 'POST',
      remoteAddress: '198.51.100.10',
      url: '/api/chat',
    });
    const third = await callHandler(handler, {
      body: { message: 'XXYY Pro 有哪些权益？' },
      headers: { 'x-forwarded-for': '203.0.113.1' },
      method: 'POST',
      remoteAddress: '198.51.100.10',
      url: '/api/chat',
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it('cleans up expired rate limit buckets during checks', () => {
    let currentTime = 100;
    const limiter = createRateLimiter(
      {
        rateLimitMax: 1,
        rateLimitWindowMs: 1000,
      },
      () => currentTime,
    );

    expect(limiter.check('198.51.100.1').allowed).toBe(true);
    expect(limiter.check('198.51.100.2').allowed).toBe(true);
    expect(limiter.size()).toBe(2);

    currentTime = 1200;
    expect(limiter.check('198.51.100.3').allowed).toBe(true);
    expect(limiter.size()).toBe(1);
  });

  it('serves only explicitly approved product assets', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-assets-'));
    const assetsDir = path.join(workspaceRoot, 'docs', 'product-features', 'assets');
    await mkdir(assetsDir, { recursive: true });
    await writeFile(path.join(assetsDir, 'xxyy-add-to-home.mp4'), Buffer.from('video-bytes'));
    await writeFile(path.join(assetsDir, 'xxyy-docs-AssetOne.png'), Buffer.from('image-bytes'));
    await writeFile(
      path.join(assetsDir, 'tx-analysis-report-index.jsonl'),
      Buffer.from('{"private":true}\n'),
    );
    const handler = createRequestHandler({ cwd: workspaceRoot, staticAssetsDir: assetsDir });

    const videoResponse = await callHandler(handler, {
      method: 'GET',
      url: '/assets/xxyy-add-to-home.mp4',
    });

    expect(videoResponse.statusCode).toBe(200);
    expect(videoResponse.headers['Content-Type']).toBe('video/mp4');
    expect(videoResponse.rawBody).toEqual(Buffer.from('video-bytes'));

    const docsImageResponse = await callHandler(handler, {
      method: 'GET',
      url: '/assets/xxyy-docs-AssetOne.png',
    });

    expect(docsImageResponse.statusCode).toBe(200);
    expect(docsImageResponse.headers['Content-Type']).toBe('image/png');
    expect(docsImageResponse.rawBody).toEqual(Buffer.from('image-bytes'));

    const blockedResponse = await callHandler(handler, {
      method: 'GET',
      url: '/assets/tx-analysis-report-index.jsonl',
    });

    expect(blockedResponse.statusCode).toBe(404);
    expect(blockedResponse.body).not.toContain('private');
  });

  it('serves Vite web app assets separately from product media assets', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-api-web-assets-'));
    const webAssetsDir = path.join(workspaceRoot, 'apps', 'web', 'dist', 'web-assets');
    await mkdir(webAssetsDir, { recursive: true });
    await writeFile(path.join(webAssetsDir, 'index.js'), 'console.log("xxyy web");');
    await writeFile(path.join(webAssetsDir, 'index.css'), '.app-shell{display:grid}');
    const handler = createRequestHandler({ cwd: workspaceRoot, webAssetsDir });

    const script = await callHandler(handler, {
      method: 'GET',
      url: '/web-assets/index.js',
    });
    const styles = await callHandler(handler, {
      method: 'GET',
      url: '/web-assets/index.css',
    });

    expect(script.statusCode).toBe(200);
    expect(script.body).toBe('console.log("xxyy web");');
    expect(script.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
    expect(styles.statusCode).toBe(200);
    expect(styles.body).toBe('.app-shell{display:grid}');
    expect(styles.headers['Content-Type']).toBe('text/css; charset=utf-8');
  });

  it('passes chat requests through ChatService', async () => {
    const chatResponse: ChatResponse = {
      answer: '产品功能截图如下。',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/svg+xml',
          title: '产品功能截图',
          url: '/assets/xxyy-feature-card.svg',
        },
      ],
      confidence: 0.8,
      intent: 'product_qa',
      citations: [],
    };
    const handler = createRequestHandler({
      createRequestId: () => 'req-pass-1',
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            expect(request).toEqual({
              channel: 'web',
              message: 'XXYY Pro 有哪些权益？',
              requestId: 'req-pass-1',
              sessionId: 'session-1',
              userId: 'user-1',
            });
            return Promise.resolve(chatResponse);
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-1',
        userId: 'user-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(chatResponse);
  });

  it('builds the default chat service from the Customer Agent Runtime factory', async () => {
    vi.resetModules();

    const agentAsk = vi.fn(() =>
      Promise.resolve({
        answer: 'agent runtime response',
        citations: [],
        confidence: 0.7,
        intent: 'product_qa' as const,
      }),
    );
    const createCustomerAgentChatService = vi.fn(
      (_options: CreateCustomerAgentChatServiceOptions) => ({
        ask: agentAsk,
        stream: vi.fn(),
      }),
    );
    const createLegacyChatService = vi.fn(() => ({
      ask: vi.fn(() =>
        Promise.resolve({
          answer: 'legacy response',
          citations: [],
          confidence: 0.1,
          intent: 'product_qa' as const,
        }),
      ),
      stream: vi.fn(),
    }));
    const retriever = { retrieve: vi.fn() };
    const createLazyRetriever = vi.fn(() => retriever);

    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createCustomerAgentChatService,
      };
    });
    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn() })),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createChatService: createLegacyChatService,
        createLazyRetriever,
        loadRagConfig: vi.fn(() => createRuntimeConfigForTest()),
      };
    });

    try {
      const { createRequestHandler: createRequestHandlerWithMocks } = await import('./index.js');
      const handler = createRequestHandlerWithMocks({
        createRequestId: () => 'req-agent-1',
        env: {
          DATABASE_URL: 'postgres://xxyy:secret@example.test/xxyy_ask',
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'test-model',
        },
      });

      const response = await callHandler(handler, {
        body: {
          channel: 'web',
          message: 'XXYY Pro 有哪些权益？',
        },
        method: 'POST',
        url: '/api/chat',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        answer: 'agent runtime response',
        intent: 'product_qa',
      });
      expect(createLegacyChatService).not.toHaveBeenCalled();
      expect(createCustomerAgentChatService).toHaveBeenCalledTimes(1);
      const serviceOptions = createCustomerAgentChatService.mock.calls[0]?.[0];
      expect(serviceOptions).toBeDefined();
      if (serviceOptions === undefined) {
        throw new Error('Expected Customer Agent service options to be captured.');
      }
      expect(Object.keys(serviceOptions).sort()).toEqual([
        'answerProvider',
        'config',
        'productCapabilityCaller',
        'retriever',
        'tracer',
      ]);
      expect(serviceOptions.productCapabilityCaller).toEqual({
        channel: 'web',
        principal: 'anonymous',
      });
      expect(serviceOptions.retriever).toBe(retriever);
      expect(typeof serviceOptions.answerProvider.answer).toBe('function');
      expect(createLazyRetriever).toHaveBeenCalledTimes(1);
      expect(agentAsk).toHaveBeenCalledWith({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        requestId: 'req-agent-1',
      });
    } finally {
      vi.doUnmock('@xxyy/agent-core');
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('logs completed chat requests with RAG response metrics', async () => {
    const logs: ApiLogEntry[] = [];
    const nowValues = [100, 100, 145];
    const handler = createRequestHandler({
      createRequestId: () => 'req-log-1',
      logger: (entry) => {
        logs.push(entry);
      },
      now: () => nowValues.shift() ?? 145,
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              agentRoute: 'product_answer',
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [
                {
                  excerpt: 'Pro 用户可以使用更多产品权益。',
                  file: 'docs/pro.md',
                  title: 'XXYY Pro 权益',
                },
              ],
              confidence: 0.8,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 'session-1',
        userId: 'user-1',
      },
    });

    expect(logs).toEqual([
      {
        agentRoute: 'product_answer',
        attachmentCount: 0,
        channel: 'web',
        citationCount: 1,
        confidence: 0.8,
        durationMs: 45,
        event: 'chat_request',
        intent: 'product_qa',
        messageLength: 15,
        messagePreview: 'XXYY Pro 有哪些权益？',
        outcome: 'success',
        requestId: 'req-log-1',
        route: '/api/chat',
        sessionIdPresent: true,
        statusCode: 200,
        userIdPresent: true,
      },
    ]);
  });

  it('passes a generated requestId to the chat service and request log', async () => {
    const logs: ApiLogEntry[] = [];
    const requests: ChatRequest[] = [];
    const handler = createRequestHandler({
      createRequestId: () => 'req-test-1',
      logger: (entry) => {
        logs.push(entry);
      },
      getChatService: () =>
        Promise.resolve({
          ask(request) {
            requests.push(request);
            return Promise.resolve({
              answer: '根据知识库，XXYY Pro 提供更多权益。',
              citations: [],
              confidence: 0.8,
              intent: 'product_qa',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(requests[0]).toMatchObject({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      requestId: 'req-test-1',
    });
    expect(logs[0]).toMatchObject({
      requestId: 'req-test-1',
    });
  });

  it('redacts pasted secrets from chat request log previews', async () => {
    const logs: ApiLogEntry[] = [];
    const handler = createRequestHandler({
      createRequestId: () => 'req-stream-log-1',
      logger: (entry) => {
        logs.push(entry);
      },
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.resolve({
              answer: '不要发送私钥、助记词或 seed phrase。',
              citations: [],
              confidence: 0.35,
              intent: 'unknown',
            });
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: {
        message: '我的密码是 hunter2 api key: sk-test-123456',
      },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      messagePreview: '我的密码是 [sensitive_credential] api key: [sensitive_credential]',
      outcome: 'success',
      route: '/api/chat',
    });
    expect(JSON.stringify(logs)).not.toContain('hunter2');
    expect(JSON.stringify(logs)).not.toContain('sk-test-123456');
  });

  it('streams chat responses as server-sent events', async () => {
    const streamEvents: ChatStreamEvent[] = [
      { type: 'answer_delta', delta: 'XXYY Pro' },
      { type: 'answer_delta', delta: ' 有长期权益。' },
      {
        type: 'metadata',
        agentRoute: 'product_answer',
        citations: [],
        confidence: 0.8,
        intent: 'product_qa',
      },
    ];
    const handler = createRequestHandler({
      createRequestId: () => 'req-stream-1',
      getChatService: () =>
        Promise.resolve({
          ask() {
            throw new Error('ask should not be used for stream requests');
          },
          async *stream(request) {
            await Promise.resolve();
            expect(request).toEqual({
              channel: 'web',
              message: 'XXYY Pro 有哪些权益？',
              requestId: 'req-stream-1',
            });
            yield* streamEvents;
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat/stream',
      body: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(response.headers['X-Accel-Buffering']).toBe('no');
    expect(response.body).toContain('event: answer_delta\n');
    expect(response.body).toContain('data: {"type":"answer_delta","delta":"XXYY Pro"}\n\n');
    expect(response.body).toContain('event: metadata\n');
    expect(response.body).toContain(
      'data: {"type":"metadata","agentRoute":"product_answer","citations":[],"confidence":0.8,"intent":"product_qa"}\n\n',
    );
  });

  it('logs streamed chat requests when metadata is emitted', async () => {
    const logs: ApiLogEntry[] = [];
    const nowValues = [200, 200, 260];
    const streamEvents: ChatStreamEvent[] = [
      { type: 'answer_delta', delta: 'XXYY Pro' },
      {
        type: 'metadata',
        agentRoute: 'product_answer',
        citations: [
          {
            excerpt: 'Pro 用户可以使用更多产品权益。',
            file: 'docs/pro.md',
            title: 'XXYY Pro 权益',
          },
        ],
        confidence: 0.8,
        intent: 'product_qa',
      },
    ];
    const handler = createRequestHandler({
      createRequestId: () => 'req-stream-log-1',
      logger: (entry) => {
        logs.push(entry);
      },
      now: () => nowValues.shift() ?? 260,
      getChatService: () =>
        Promise.resolve({
          ask() {
            throw new Error('ask should not be used for stream requests');
          },
          async *stream() {
            await Promise.resolve();
            yield* streamEvents;
          },
        }),
    });

    await callHandler(handler, {
      method: 'POST',
      url: '/api/chat/stream',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(logs).toEqual([
      {
        agentRoute: 'product_answer',
        attachmentCount: 0,
        channel: 'web',
        citationCount: 1,
        confidence: 0.8,
        durationMs: 60,
        event: 'chat_request',
        intent: 'product_qa',
        messageLength: 15,
        messagePreview: 'XXYY Pro 有哪些权益？',
        outcome: 'success',
        requestId: 'req-stream-log-1',
        route: '/api/chat/stream',
        sessionIdPresent: false,
        statusCode: 200,
        userIdPresent: false,
      },
    ]);
  });

  it('returns a useful 503 when LLM configuration is missing', async () => {
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(
              new LlmConfigurationError('OPENAI_API_KEY is required for LLM answer generation.'),
            );
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'llm_configuration_missing',
      message: 'OPENAI_API_KEY is required for LLM answer generation.',
    });
  });

  it('logs chat request errors with the public API error code', async () => {
    const logs: ApiLogEntry[] = [];
    const nowValues = [300, 300, 325];
    const handler = createRequestHandler({
      createRequestId: () => 'req-error-log-1',
      logger: (entry) => {
        logs.push(entry);
      },
      now: () => nowValues.shift() ?? 325,
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(
              new LlmConfigurationError('OPENAI_API_KEY is required for LLM answer generation.'),
            );
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(logs).toEqual([
      {
        channel: 'web',
        durationMs: 25,
        error: 'llm_configuration_missing',
        event: 'chat_request',
        messageLength: 15,
        messagePreview: 'XXYY Pro 有哪些权益？',
        outcome: 'error',
        requestId: 'req-error-log-1',
        route: '/api/chat',
        sessionIdPresent: false,
        statusCode: 503,
        userIdPresent: false,
      },
    ]);
  });

  it('returns boundary answers for obvious private lookups without planner configuration', async () => {
    const handler = createRequestHandler({ env: {} });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: '帮我查一下钱包余额' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
  });

  it('returns a useful 503 when pgvector configuration is missing', async () => {
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(
              new VectorStoreConfigurationError('DATABASE_URL is required for pgvector retrieval.'),
            );
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'vector_store_configuration_missing',
      message: 'DATABASE_URL is required for pgvector retrieval.',
    });
  });

  it('returns a useful 503 when embedding configuration is missing', async () => {
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(
              new EmbeddingConfigurationError(
                'EMBEDDING_API_KEY or OPENAI_API_KEY is required for embedding generation.',
              ),
            );
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'embedding_configuration_missing',
      message: 'EMBEDDING_API_KEY or OPENAI_API_KEY is required for embedding generation.',
    });
  });

  it('returns a useful 503 when default agent planner configuration is missing', async () => {
    const handler = createRequestHandler({
      env: {
        DATABASE_URL: 'postgres://xxyy:password@localhost:5432/xxyy_ask',
        OPENAI_MODEL: 'test-model',
      },
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: '你好，可以介绍一下吗？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'llm_configuration_missing',
      message: 'OPENAI_API_KEY is required for agent planning.',
    });
  });

  it('fails fast when explicitly enabled tracing is missing its API key', () => {
    expect(() => createRequestHandler({ env: { LANGSMITH_TRACING: 'true' } })).toThrow(
      QualityTracingConfigurationError,
    );
  });

  it('returns a useful 503 when vector store runtime is unavailable', async () => {
    const handler = createRequestHandler({
      getChatService: () =>
        Promise.resolve({
          ask() {
            return Promise.reject(new VectorStoreUnavailableError(new Error('connect refused')));
          },
          stream() {
            throw new Error('stream should not be used for non-stream requests');
          },
        }),
    });

    const response = await callHandler(handler, {
      method: 'POST',
      url: '/api/chat',
      body: { message: 'XXYY Pro 有哪些权益？' },
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: 'vector_store_unavailable',
      message: 'Vector store is unavailable. Check DATABASE_URL and database connectivity.',
    });
  });
});
