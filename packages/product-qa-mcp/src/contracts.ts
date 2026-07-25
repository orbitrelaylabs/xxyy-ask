import { z } from 'zod';

import { supportedSourceTypes } from '@xxyy/shared';

export const PRODUCT_QA_MCP_SERVER_NAME = 'xxyy-product-support';
export const PRODUCT_QA_MCP_VERSION = '1.0.0';
export const PRODUCT_QA_MCP_SEARCH_TOOL_NAME = 'search_product_docs';

const nonEmptyStringSchema = z.string().trim().min(1);

const citationSchema = z.object({
  excerpt: z.string(),
  file: z.string(),
  sourceType: z.enum(supportedSourceTypes).optional(),
  sourceUrl: z.string().optional(),
  title: z.string(),
});

const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('video'),
    mediaType: z.enum(['video/mp4', 'text/html']),
    posterUrl: z.string().optional(),
    title: z.string(),
    url: z.string(),
  }),
  z.object({
    kind: z.literal('image'),
    mediaType: z.enum([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/svg+xml',
      'image/gif',
      'image/avif',
    ]),
    title: z.string(),
    url: z.string(),
  }),
]);

const retrievedChunkSchema = z.object({
  documentId: z.string(),
  id: z.string(),
  lexicalScore: z.number(),
  metadata: z.object({
    attachments: z.array(attachmentSchema).optional(),
    effectiveAt: z.string().optional(),
    file: z.string(),
    headingPath: z.array(z.string()),
    module: z.string(),
    order: z.number().optional(),
    retrievedAt: z.string().optional(),
    sourceType: z.enum(supportedSourceTypes),
    sourceUrl: z.string().optional(),
    status: z.enum(['current', 'historical', 'deprecated']).optional(),
    supersedes: z.array(z.string()).optional(),
    title: z.string(),
  }),
  rank: z.number(),
  score: z.number(),
  sourceBoost: z.number(),
  text: z.string(),
  vectorScore: z.number(),
});

export const productSearchInputSchema = z
  .object({
    question: nonEmptyStringSchema.optional(),
    query: nonEmptyStringSchema,
    topK: z.number().int().positive().optional(),
  })
  .strict();

export const productSearchOutputSchema = z
  .object({
    attachments: z.array(attachmentSchema).optional(),
    chunks: z.array(retrievedChunkSchema),
    citations: z.array(citationSchema),
    confidence: z.number(),
  })
  .strict();

export type ProductSearchInput = z.output<typeof productSearchInputSchema>;
export type ProductSearchOutput = z.output<typeof productSearchOutputSchema>;

export interface ProductSearchHandler {
  searchProductDocs(
    input: ProductSearchInput,
    options?: { signal?: AbortSignal },
  ): Promise<ProductSearchOutput>;
}

export interface ProductQaMcpClient {
  close(): Promise<void>;
  searchProductDocs(
    input: ProductSearchInput,
    options?: { signal?: AbortSignal },
  ): Promise<ProductSearchOutput>;
}
