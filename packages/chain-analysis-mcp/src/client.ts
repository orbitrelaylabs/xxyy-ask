import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import {
  CHAIN_ANALYSIS_MCP_SERVER_NAME,
  CHAIN_ANALYSIS_MCP_VERSION,
  DETECT_SANDWICH_TOOL_NAME,
  GET_TRANSACTION_TOOL_NAME,
  INSPECT_TRANSACTION_TOOL_NAME,
  detectSandwichOutputSchema,
  getTransactionOutputSchema,
  inspectTransactionOutputSchema,
  type ChainAnalysisHandler,
  type ChainAnalysisMcpClient,
  type DetectSandwichInput,
  type DetectSandwichOutput,
  type GetTransactionInput,
  type GetTransactionOutput,
  type InspectTransactionInput,
  type InspectTransactionOutput,
} from './contracts.js';
import { ChainAnalysisMcpToolError, decodeChainAnalysisMcpError } from './errors.js';
import { createChainAnalysisMcpServer } from './server.js';

export interface CreateInMemoryChainAnalysisMcpClientOptions {
  connectionTimeoutMs?: number;
  handler: ChainAnalysisHandler;
}

export interface CreateChainAnalysisMcpClientOptions {
  connectionTimeoutMs?: number;
  transport: Transport;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000;

export function createChainAnalysisMcpClient(
  options: CreateChainAnalysisMcpClientOptions,
): ChainAnalysisMcpClient {
  return createProtocolClient({
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: options.connectionTimeoutMs }),
    transport: options.transport,
  });
}

export function createInMemoryChainAnalysisMcpClient(
  options: CreateInMemoryChainAnalysisMcpClientOptions,
): ChainAnalysisMcpClient {
  const server = createChainAnalysisMcpServer({ handler: options.handler });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  return createProtocolClient({
    beforeConnect: () => server.connect(serverTransport),
    closeAdditional: () => server.close(),
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: options.connectionTimeoutMs }),
    transport: clientTransport,
  });
}

interface CreateProtocolClientOptions {
  beforeConnect?: () => Promise<void>;
  closeAdditional?: () => Promise<void>;
  connectionTimeoutMs?: number;
  transport: Transport;
}

function createProtocolClient(options: CreateProtocolClientOptions): ChainAnalysisMcpClient {
  const client = new Client({
    name: `${CHAIN_ANALYSIS_MCP_SERVER_NAME}-agent-bridge`,
    version: CHAIN_ANALYSIS_MCP_VERSION,
  });
  let closed = false;
  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs <= 0) {
    throw new RangeError('Chain-analysis MCP connection timeout must be a positive integer.');
  }
  const ready = withConnectionTimeout(
    (async () => {
      await options.beforeConnect?.();
      await client.connect(options.transport);
    })(),
    connectionTimeoutMs,
  );
  void ready.catch(() => undefined);

  const call = async (
    name:
      | typeof GET_TRANSACTION_TOOL_NAME
      | typeof INSPECT_TRANSACTION_TOOL_NAME
      | typeof DETECT_SANDWICH_TOOL_NAME,
    input: GetTransactionInput | InspectTransactionInput | DetectSandwichInput,
    signal: AbortSignal | undefined,
  ): Promise<unknown> => {
    if (closed) {
      throw new ChainAnalysisMcpToolError('tool_failure', 'Onchain-analysis MCP client is closed.');
    }
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      await ready;
      result = await client.callTool(
        { arguments: input, name },
        undefined,
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      if (signal?.aborted === true) {
        throw new ChainAnalysisMcpToolError('request_aborted');
      }
      if (error instanceof ChainAnalysisMcpToolError) {
        throw error;
      }
      throw new ChainAnalysisMcpToolError('tool_failure', undefined, { cause: error });
    }
    if (result.isError === true) {
      const encodedError = findFirstTextContent(result.content);
      const decodedError =
        encodedError === undefined ? undefined : decodeChainAnalysisMcpError(encodedError);
      throw decodedError ?? new ChainAnalysisMcpToolError('tool_failure');
    }
    return result.structuredContent;
  };

  return {
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await Promise.allSettled([
        client.close(),
        ...(options.closeAdditional === undefined ? [] : [options.closeAdditional()]),
      ]);
    },

    async detectSandwich(input, requestOptions = {}) {
      return detectSandwichOutputSchema.parse(
        await call(DETECT_SANDWICH_TOOL_NAME, input, requestOptions.signal),
      );
    },

    async getTransaction(input, requestOptions = {}) {
      return getTransactionOutputSchema.parse(
        await call(GET_TRANSACTION_TOOL_NAME, input, requestOptions.signal),
      );
    },

    async inspectTransaction(input, requestOptions = {}) {
      return inspectTransactionOutputSchema.parse(
        await call(INSPECT_TRANSACTION_TOOL_NAME, input, requestOptions.signal),
      );
    },
  };
}

async function withConnectionTimeout(connection: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new ChainAnalysisMcpToolError('tool_timeout'));
    }, timeoutMs);
  });
  try {
    await Promise.race([connection, timedOut]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createChainAnalysisMcpClientStub(options: {
  detectSandwich?: (
    input: DetectSandwichInput,
    signal?: AbortSignal,
  ) => Promise<DetectSandwichOutput>;
  getTransaction?: (
    input: GetTransactionInput,
    signal?: AbortSignal,
  ) => Promise<GetTransactionOutput>;
  inspectTransaction?: (
    input: InspectTransactionInput,
    signal?: AbortSignal,
  ) => Promise<InspectTransactionOutput>;
}): ChainAnalysisMcpClient {
  return {
    close() {
      return Promise.resolve();
    },
    detectSandwich(input, requestOptions) {
      if (options.detectSandwich === undefined) {
        return Promise.reject(new ChainAnalysisMcpToolError('tool_failure'));
      }
      return options.detectSandwich(input, requestOptions?.signal);
    },
    getTransaction(input, requestOptions) {
      if (options.getTransaction === undefined) {
        return Promise.reject(new ChainAnalysisMcpToolError('tool_failure'));
      }
      return options.getTransaction(input, requestOptions?.signal);
    },
    inspectTransaction(input, requestOptions) {
      if (options.inspectTransaction === undefined) {
        return Promise.reject(new ChainAnalysisMcpToolError('tool_failure'));
      }
      return options.inspectTransaction(input, requestOptions?.signal);
    },
  };
}

function findFirstTextContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value as unknown[]) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
