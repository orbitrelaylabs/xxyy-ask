import { EmbeddingConfigurationError } from '@xxyy/knowledge';
import { VectorStoreConfigurationError, VectorStoreUnavailableError } from '@xxyy/rag-core';

export const productQaMcpErrorCodes = [
  'embedding_configuration_missing',
  'vector_store_configuration_missing',
  'vector_store_unavailable',
  'tool_failure',
] as const;

export type ProductQaMcpErrorCode = (typeof productQaMcpErrorCodes)[number];

export function classifyProductQaMcpError(error: unknown): ProductQaMcpErrorCode {
  if (
    error instanceof EmbeddingConfigurationError ||
    (error instanceof Error && error.constructor.name === 'EmbeddingConfigurationError')
  ) {
    return 'embedding_configuration_missing';
  }
  if (error instanceof VectorStoreConfigurationError) {
    return 'vector_store_configuration_missing';
  }
  if (error instanceof VectorStoreUnavailableError) {
    return 'vector_store_unavailable';
  }
  return 'tool_failure';
}

export function encodeProductQaMcpError(error: unknown): string {
  return JSON.stringify({ error: classifyProductQaMcpError(error) });
}

export function decodeProductQaMcpError(text: string): Error | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isProductQaMcpErrorCode(value.error)) {
    return undefined;
  }
  switch (value.error) {
    case 'embedding_configuration_missing':
      return new EmbeddingConfigurationError(
        'EMBEDDING_API_KEY or OPENAI_API_KEY is required for embedding generation.',
      );
    case 'vector_store_configuration_missing':
      return new VectorStoreConfigurationError('DATABASE_URL is required for pgvector retrieval.');
    case 'vector_store_unavailable':
      return new VectorStoreUnavailableError(undefined);
    case 'tool_failure':
      return undefined;
  }
}

function isProductQaMcpErrorCode(value: unknown): value is ProductQaMcpErrorCode {
  return (
    typeof value === 'string' && productQaMcpErrorCodes.includes(value as ProductQaMcpErrorCode)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
