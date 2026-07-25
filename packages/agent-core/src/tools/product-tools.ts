import type { RagIndex } from '@xxyy/shared';
import {
  createProductSearchHandler,
  productSearchInputSchema,
  productSearchOutputSchema,
} from '@xxyy/product-qa-mcp';
import type { QualityTracer, RagConfig, Retriever } from '@xxyy/rag-core';

import type { ToolDefinition } from '../tool-registry.js';

export const PRODUCT_TOOL_NAMES = ['search_product_docs'] as const;

export type ProductToolName = (typeof PRODUCT_TOOL_NAMES)[number];

export interface CreateProductToolsOptions {
  config?: Partial<RagConfig>;
  index?: RagIndex;
  retriever?: Retriever;
  tracer?: QualityTracer;
}

export const searchProductDocsInputSchema = productSearchInputSchema;
export const searchProductDocsOutputSchema = productSearchOutputSchema;

export function createProductTools(
  options: CreateProductToolsOptions,
): ToolDefinition<ProductToolName>[] {
  const handler = createProductSearchHandler(options);
  return [
    {
      name: 'search_product_docs',
      description: 'Search XXYY product documentation and return matching chunks with citations.',
      inputSchema: searchProductDocsInputSchema,
      outputSchema: searchProductDocsOutputSchema,
      execute(input) {
        return handler.searchProductDocs(searchProductDocsInputSchema.parse(input));
      },
    },
  ];
}
