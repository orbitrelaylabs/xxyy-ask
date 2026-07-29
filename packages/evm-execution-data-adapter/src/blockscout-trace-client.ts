import { createHash } from 'node:crypto';

import type { EvmBlockscoutTraceSourceConfig } from './contracts.js';
import { EvmExecutionDataAdapterConfigurationError } from './errors.js';

const DEFAULT_MAX_RESPONSE_BYTES = 4_194_304;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 16_777_216;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

export type BlockscoutTraceFailureCode =
  | 'http_error'
  | 'invalid_json'
  | 'request_timeout'
  | 'response_too_large'
  | 'trace_invalid'
  | 'trace_not_found'
  | 'transport_error';

export type BlockscoutTraceResult =
  | {
      attempts: 1;
      ok: true;
      payloadHash: string;
      result: unknown;
    }
  | {
      attempts: 1;
      code: BlockscoutTraceFailureCode;
      httpStatus?: number;
      ok: false;
      retryable: boolean;
    };

export interface BlockscoutTraceClient {
  readonly providerId: string;
  requestTrace(
    transactionHash: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<BlockscoutTraceResult>;
}

export interface CreateBlockscoutTraceClientOptions {
  allowInsecureLocalhost?: boolean;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  source: EvmBlockscoutTraceSourceConfig;
}

export function createBlockscoutTraceClient(
  options: CreateBlockscoutTraceClientOptions,
): BlockscoutTraceClient {
  const endpoint = parseAllowedEndpoint(
    options.source.endpoint,
    options.allowInsecureLocalhost ?? false,
    options.source.id,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const requestTimeoutMs = boundedPositiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  );

  return {
    providerId: options.source.id,
    async requestTrace(transactionHash, requestOptions = {}) {
      requestOptions.signal?.throwIfAborted();
      const url = traceUrl(endpoint, transactionHash);
      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(new DOMException('Request timed out.', 'TimeoutError')),
        requestTimeoutMs,
      );
      const signal =
        requestOptions.signal === undefined
          ? timeoutController.signal
          : AbortSignal.any([requestOptions.signal, timeoutController.signal]);

      try {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/json' },
          method: 'GET',
          redirect: 'error',
          signal,
        });
        if (!response.ok) {
          return {
            attempts: 1,
            code: response.status === 404 ? 'trace_not_found' : 'http_error',
            httpStatus: response.status,
            ok: false,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          };
        }
        const text = await readBoundedText(response, maxResponseBytes, signal);
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          return {
            attempts: 1,
            code: 'invalid_json',
            ok: false,
            retryable: false,
          };
        }
        const result = extractRootCall(payload);
        if (result === undefined) {
          return {
            attempts: 1,
            code: 'trace_not_found',
            ok: false,
            retryable: false,
          };
        }
        return {
          attempts: 1,
          ok: true,
          payloadHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
          result,
        };
      } catch (error) {
        if (requestOptions.signal?.aborted === true) {
          requestOptions.signal.throwIfAborted();
        }
        if (error instanceof ResponseTooLargeError) {
          return {
            attempts: 1,
            code: 'response_too_large',
            ok: false,
            retryable: false,
          };
        }
        if (timeoutController.signal.aborted) {
          return {
            attempts: 1,
            code: 'request_timeout',
            ok: false,
            retryable: true,
          };
        }
        return {
          attempts: 1,
          code: 'transport_error',
          ok: false,
          retryable: true,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

class ResponseTooLargeError extends Error {}

async function readBoundedText(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw new ResponseTooLargeError();
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    signal.throwIfAborted();
    const item = await reader.read();
    if (item.done) {
      return `${text}${decoder.decode()}`;
    }
    bytes += item.value.byteLength;
    if (bytes > maxResponseBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError();
    }
    text += decoder.decode(item.value, { stream: true });
  }
}

function extractRootCall(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.type !== 'string') {
    return undefined;
  }
  return payload;
}

function traceUrl(endpoint: URL, transactionHash: string): URL {
  const result = new URL(endpoint);
  result.pathname = `${result.pathname.replace(/\/+$/u, '')}/api/v2/transactions/${transactionHash}/raw-trace`;
  return result;
}

function parseAllowedEndpoint(
  value: string,
  allowInsecureLocalhost: boolean,
  providerId: string,
): URL {
  const url = new URL(value);
  const allowedHttp =
    url.protocol === 'http:' && allowInsecureLocalhost && isLoopbackHostname(url.hostname);
  if (
    (url.protocol !== 'https:' && !allowedHttp) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.search.length > 0
  ) {
    throw new EvmExecutionDataAdapterConfigurationError(
      'invalid_configuration',
      `Blockscout trace endpoint is not allowed for source ${providerId}.`,
    );
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === 'localhost'
  );
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new EvmExecutionDataAdapterConfigurationError(
      'invalid_limits',
      `${name} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return resolved;
}
