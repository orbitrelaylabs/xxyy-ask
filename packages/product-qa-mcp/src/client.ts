import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  PRODUCT_QA_MCP_SEARCH_TOOL_NAME,
  PRODUCT_QA_MCP_SERVER_NAME,
  PRODUCT_QA_MCP_VERSION,
  productSearchOutputSchema,
  type ProductQaMcpClient,
  type ProductSearchHandler,
  type ProductSearchInput,
  type ProductSearchOutput,
} from './contracts.js';
import { decodeProductQaMcpError } from './errors.js';
import { createProductQaMcpServer } from './server.js';

export class ProductQaMcpToolError extends Error {
  constructor(message = 'XXYY product MCP tool invocation failed.') {
    super(message);
    this.name = 'ProductQaMcpToolError';
  }
}

export interface CreateInMemoryProductQaMcpClientOptions {
  handler: ProductSearchHandler;
}

export function createInMemoryProductQaMcpClient(
  options: CreateInMemoryProductQaMcpClientOptions,
): ProductQaMcpClient {
  const server = createProductQaMcpServer({ handler: options.handler });
  const client = new Client({
    name: `${PRODUCT_QA_MCP_SERVER_NAME}-agent-bridge`,
    version: PRODUCT_QA_MCP_VERSION,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let closed = false;
  const ready = (async () => {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  })();

  return {
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await ready.catch(() => undefined);
      await Promise.allSettled([client.close(), server.close()]);
    },

    async searchProductDocs(input, requestOptions = {}) {
      if (closed) {
        throw new ProductQaMcpToolError('XXYY product MCP client is closed.');
      }
      await ready;
      let result: Awaited<ReturnType<Client['callTool']>>;
      try {
        result = await client.callTool(
          {
            arguments: input,
            name: PRODUCT_QA_MCP_SEARCH_TOOL_NAME,
          },
          undefined,
          {
            ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          },
        );
      } catch {
        throw new ProductQaMcpToolError();
      }
      if (result.isError === true) {
        const encodedError = findFirstTextContent(result.content);
        if (encodedError !== undefined) {
          const decodedError = decodeProductQaMcpError(encodedError);
          if (decodedError !== undefined) {
            throw decodedError;
          }
        }
        throw new ProductQaMcpToolError();
      }
      return parseStructuredOutput(result.structuredContent);
    },
  };
}

function parseStructuredOutput(value: unknown): ProductSearchOutput {
  const parsed = productSearchOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProductQaMcpToolError('XXYY product MCP returned invalid structured output.');
  }
  return parsed.data;
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

export function createProductQaMcpClientStub(
  search: (input: ProductSearchInput, signal?: AbortSignal) => Promise<ProductSearchOutput>,
): ProductQaMcpClient {
  return {
    close() {
      return Promise.resolve();
    },
    searchProductDocs(input, options) {
      return search(input, options?.signal);
    },
  };
}
