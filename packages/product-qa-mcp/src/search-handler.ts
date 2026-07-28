import type { RagIndex } from '@xxyy/shared';
import {
  createCitationsFromChunks,
  createLocalRetriever,
  createMetadataReranker,
  createQuestionRelevantAttachments,
  createRerankingRetriever,
  loadRagConfig,
  sanitizeRetrievedKnowledgeChunk,
  selectGroundingChunks,
  type QualityTracer,
  type RagConfig,
  type RetrievedChunk,
  type Retriever,
} from '@xxyy/rag-core';

import {
  productSearchOutputSchema,
  type ProductSearchHandler,
  type ProductSearchOutput,
} from './contracts.js';

const DEFAULT_TOP_K = 6;
const MAX_TOP_K = 20;
const RERANK_CANDIDATE_MULTIPLIER = 8;

export interface CreateProductSearchHandlerOptions {
  config?: Partial<RagConfig>;
  index?: RagIndex;
  retriever?: Retriever;
  tracer?: QualityTracer;
}

export function createProductSearchHandler(
  options: CreateProductSearchHandlerOptions,
): ProductSearchHandler {
  const config = {
    ...loadRagConfig(),
    ...options.config,
  };
  const retriever = createConfiguredRetriever(options);

  return {
    async searchProductDocs(input, requestOptions = {}) {
      requestOptions.signal?.throwIfAborted();
      const chunks = await retriever.retrieve(input.query, {
        topK: normalizeTopK(input.topK ?? config.topK),
      });
      requestOptions.signal?.throwIfAborted();
      return toProductSearchOutput(input.question ?? input.query, chunks);
    },
  };
}

function createConfiguredRetriever(options: CreateProductSearchHandlerOptions): Retriever {
  let retriever: Retriever;
  if (options.retriever !== undefined) {
    retriever = options.retriever;
  } else if (options.index !== undefined) {
    retriever = createLocalRetriever(options.index);
  } else {
    throw new Error('createProductSearchHandler requires either index or retriever.');
  }

  return createRerankingRetriever(retriever, createMetadataReranker(), {
    candidateMultiplier: RERANK_CANDIDATE_MULTIPLIER,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
}

function toProductSearchOutput(question: string, chunks: RetrievedChunk[]): ProductSearchOutput {
  const citationChunks = selectGroundingChunks(question, chunks);
  const attachments = createQuestionRelevantAttachments(question, citationChunks);
  const output: ProductSearchOutput = {
    ...(attachments.length === 0 ? {} : { attachments }),
    chunks: chunks.map(toOutputChunk),
    citations: createCitationsFromChunks(citationChunks),
    confidence: citationChunks[0]?.score ?? chunks[0]?.score ?? 0,
  };
  return productSearchOutputSchema.parse(output);
}

function toOutputChunk(chunk: RetrievedChunk): ProductSearchOutput['chunks'][number] {
  const safeChunk = sanitizeRetrievedKnowledgeChunk(chunk);
  return {
    documentId: safeChunk.documentId,
    id: safeChunk.id,
    lexicalScore: safeChunk.lexicalScore,
    metadata: {
      ...safeChunk.metadata,
    },
    rank: safeChunk.rank,
    score: safeChunk.score,
    sourceBoost: safeChunk.sourceBoost,
    text: safeChunk.text,
    vectorScore: safeChunk.vectorScore,
  };
}

function normalizeTopK(topK: number): number {
  if (!Number.isInteger(topK) || topK <= 0) {
    return DEFAULT_TOP_K;
  }
  return Math.min(topK, MAX_TOP_K);
}
