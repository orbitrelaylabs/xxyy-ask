import { describe, expect, it, vi } from 'vitest';

import { VectorStoreConfigurationError } from '@xxyy/rag-core';

import type { ProductSearchHandler, ProductSearchOutput } from './contracts.js';
import { ProductQaMcpToolError, createInMemoryProductQaMcpClient } from './client.js';

describe('createInMemoryProductQaMcpClient', () => {
  it('calls search_product_docs through a real MCP client/server transport', async () => {
    const searchProductDocs = vi.fn<ProductSearchHandler['searchProductDocs']>((input, options) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(createOutput(input.query));
    });
    const client = createInMemoryProductQaMcpClient({
      handler: { searchProductDocs },
    });

    try {
      await expect(
        client.searchProductDocs({
          question: 'XXYY Pro 有哪些权益？',
          query: 'XXYY Pro 权益',
          topK: 2,
        }),
      ).resolves.toMatchObject({
        chunks: [{ id: 'pro-benefits' }],
        citations: [{ title: 'XXYY Pro' }],
        confidence: 0.9,
      });
      expect(searchProductDocs).toHaveBeenCalledOnce();
      expect(searchProductDocs.mock.calls[0]?.[0]).toEqual({
        question: 'XXYY Pro 有哪些权益？',
        query: 'XXYY Pro 权益',
        topK: 2,
      });
      expect(searchProductDocs.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await client.close();
    }
  });

  it('fails closed when MCP returns invalid structured output', async () => {
    const handler = {
      searchProductDocs: () => Promise.resolve({ raw: 'invalid output' }),
    } as unknown as ProductSearchHandler;
    const client = createInMemoryProductQaMcpClient({ handler });

    try {
      await expect(client.searchProductDocs({ query: 'XXYY Pro' })).rejects.toBeInstanceOf(
        ProductQaMcpToolError,
      );
    } finally {
      await client.close();
    }
  });

  it('preserves stable product configuration error categories across MCP', async () => {
    const client = createInMemoryProductQaMcpClient({
      handler: {
        searchProductDocs() {
          throw new VectorStoreConfigurationError(
            'DATABASE_URL is required for pgvector retrieval.',
          );
        },
      },
    });

    try {
      await expect(client.searchProductDocs({ query: 'XXYY Pro' })).rejects.toBeInstanceOf(
        VectorStoreConfigurationError,
      );
    } finally {
      await client.close();
    }
  });

  it('does not accept calls after the MCP bridge is closed', async () => {
    const client = createInMemoryProductQaMcpClient({
      handler: {
        searchProductDocs: (input) => Promise.resolve(createOutput(input.query)),
      },
    });
    await client.close();

    await expect(client.searchProductDocs({ query: 'XXYY Pro' })).rejects.toThrow(
      'XXYY product MCP client is closed.',
    );
  });
});

function createOutput(query: string): ProductSearchOutput {
  return {
    chunks: [
      {
        documentId: 'pro',
        id: 'pro-benefits',
        lexicalScore: 1,
        metadata: {
          file: 'docs/product-features/pro.md',
          headingPath: ['XXYY Pro'],
          module: 'Pro',
          sourceType: 'official_docs',
          sourceUrl: 'https://docs.xxyy.io/pro',
          title: 'XXYY Pro',
        },
        rank: 1,
        score: 0.9,
        sourceBoost: 0.1,
        text: `Evidence for ${query}`,
        vectorScore: 0.8,
      },
    ],
    citations: [
      {
        excerpt: `Evidence for ${query}`,
        file: 'docs/product-features/pro.md',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/pro',
        title: 'XXYY Pro',
      },
    ],
    confidence: 0.9,
  };
}
