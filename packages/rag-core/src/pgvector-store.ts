import { Pool } from 'pg';

import type { BatchEmbeddingProvider, PreparedKnowledgeChunk } from '@xxyy/knowledge';
import type {
  AnswerStatus,
  ChatChannel,
  ChatAttachment,
  ChunkMetadata,
  IndexEntry,
  Intent,
  KnowledgeStatus,
  SourceType,
} from '@xxyy/shared';

import {
  createLexicalRetrieveQueryTokens,
  createSemanticRetrieveQuery,
  isApiReferenceDocument,
  isChangelogDocumentationQuestion,
  isDocumentationScopeEligible,
  isExternalDeveloperDocument,
  isHistoricalOrTweetQuestion,
  isLegalDocumentationQuestion,
  pinRetrievalPolicyAnchors,
  shouldIncludeEnglishDocumentation,
  shouldIncludeApiReferenceDocumentation,
  shouldIncludeExternalDeveloperDocumentation,
  type RetrieveOptions,
  type RetrievedChunk,
} from './retrieve.js';
import type { Retriever } from './retriever.js';
import {
  noopQualityTracer,
  summarizeRetrievedChunks,
  type QualityTracer,
} from './quality-trace.js';
import { extractSupportEntityTokens, supportEntityEvidenceBoost } from './support-entity.js';
import { migrateKnowledgePublicationJobs } from './knowledge-publication-jobs.js';
import { reciprocalRankFusionScore } from './hybrid-rank.js';
import { migrateSupportOperations } from './support-operations.js';
import { createKnowledgeAliasQueryTokens, matchKnowledgeAliases } from './knowledge-aliases.js';
import { migrateKnowledgeGraph, replaceChunkKnowledgeGraph } from './knowledge-graph.js';

export interface PgClientLike {
  connect?(): Promise<PgTransactionClientLike>;
  query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
  release?(): void;
}

interface PgTransactionClientLike {
  query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

interface PgVectorChunkMetadata extends ChunkMetadata {
  retrievedAt?: string;
}

export interface EmbeddedKnowledgeChunk extends Omit<PreparedKnowledgeChunk, 'metadata'> {
  metadata: PgVectorChunkMetadata;
  embedding: number[];
}

export interface PgVectorStore extends Retriever {
  getChunkContentHashes(chunkIds: readonly string[]): Promise<Map<string, string>>;
  getFeedbackStats(options?: GetFeedbackStatsOptions): Promise<FeedbackStats>;
  getStats(): Promise<KnowledgeStats>;
  migrate(options?: PgVectorMigrationOptions): Promise<void>;
  recordFeedback(input: RecordFeedbackInput): Promise<void>;
  recordIngestionRun(input: RecordIngestionRunInput): Promise<void>;
  replaceChunks(
    chunks: EmbeddedKnowledgeChunk[],
    ingestionRun: RecordIngestionRunInput,
    options?: ReplaceChunksOptions,
  ): Promise<void>;
  upsertChunks(chunks: EmbeddedKnowledgeChunk[]): Promise<void>;
}

interface PgVectorMigrationOptions {
  allowEmbeddingDimensionMismatch?: boolean;
}

export interface ReplaceChunksOptions {
  afterReplace?: (client: PgClientLike) => Promise<void>;
  rebuildEmbeddingSchema?: boolean;
}

export interface PgVectorStoreOptions {
  client: PgClientLike;
  embeddingDimension?: number;
  embeddingProvider: BatchEmbeddingProvider;
  tracer?: QualityTracer;
}

export interface PgFeedbackStore {
  getFeedbackStats(options?: GetFeedbackStatsOptions): Promise<FeedbackStats>;
  recordFeedback(input: RecordFeedbackInput): Promise<void>;
}

export interface PgFeedbackStoreOptions {
  client: PgClientLike;
}

interface KnowledgeChunkRow {
  id: string;
  document_id: string;
  title: string;
  module: string;
  source_type: SourceType;
  source_url: string | null;
  file: string;
  heading_path: string[];
  order_index: number | null;
  retrieved_at: string | null;
  effective_at: string | null;
  status: KnowledgeStatus;
  supersedes: string[] | null;
  attachments: ChatAttachment[] | null;
  content: string;
  tokens: string[];
  embedding_distance: number;
  entity_rank?: number | null;
  lexical_rank?: number | null;
  vector_rank?: number | null;
}

interface KnowledgeChunkHashRow {
  content_hash: string;
  id: string;
}

interface RecordIngestionRunInput {
  runId: string;
  source: string;
  documentCount: number;
  chunkCount: number;
  sourceCounts: Partial<Record<SourceType, number>>;
  contentHash: string;
}

export type FeedbackRating = 'positive' | 'negative';

export const feedbackFailureReasons = [
  'off_topic',
  'incomplete',
  'outdated',
  'incorrect',
  'incorrect_steps',
  'unsupported_citation',
  'too_verbose',
  'context_misunderstood',
  'knowledge_missing',
  'knowledge_conflict',
  'other',
] as const;

export type FeedbackFailureReason = (typeof feedbackFailureReasons)[number];

export interface RecordFeedbackInput {
  answer: string;
  channel: ChatChannel;
  citationCount: number;
  intent: Intent;
  question: string;
  rating: FeedbackRating;
  answerStatus?: AnswerStatus;
  comment?: string;
  failureReason?: FeedbackFailureReason;
  sessionId?: string;
  sourceTypes?: SourceType[];
}

export interface GetFeedbackStatsOptions {
  limit?: number;
  rating?: FeedbackRating;
}

export interface FeedbackStats {
  totalCount: number;
  positiveCount: number;
  negativeCount: number;
  latest: FeedbackRecord[];
}

export interface FeedbackRecord {
  answer: string;
  channel: ChatChannel;
  citationCount: number;
  createdAt: string;
  intent: Intent;
  question: string;
  rating: FeedbackRating;
  answerStatus?: AnswerStatus;
  comment?: string;
  failureReason?: FeedbackFailureReason;
  sessionId?: string;
  sourceTypes?: SourceType[];
}

interface KnowledgeSourceStats {
  sourceType: SourceType;
  documentCount: number;
  chunkCount: number;
}

interface KnowledgeIngestionRun {
  runId: string;
  source: string;
  documentCount: number;
  chunkCount: number;
  sourceCounts: Partial<Record<SourceType, number>>;
  contentHash: string;
  createdAt: string;
}

export interface KnowledgeStats {
  documentCount: number;
  chunkCount: number;
  sourceUrlCount: number;
  sourceStats: KnowledgeSourceStats[];
  latestChunkUpdatedAt?: string;
  latestIngestionRun?: KnowledgeIngestionRun;
}

interface KnowledgeStatsRow {
  document_count: number;
  chunk_count: number;
  source_url_count: number;
  latest_chunk_updated_at: string | null;
}

interface KnowledgeSourceStatsRow {
  source_type: SourceType;
  document_count: number;
  chunk_count: number;
}

interface KnowledgeIngestionRunRow {
  run_id: string;
  source: string;
  document_count: number;
  chunk_count: number;
  source_counts: Partial<Record<SourceType, number>>;
  content_hash: string;
  created_at: string;
}

interface FeedbackStatsRow {
  total_count: number;
  positive_count: number;
  negative_count: number;
}

interface FeedbackRecordRow {
  answer: string;
  answer_status: AnswerStatus | null;
  channel: ChatChannel;
  citation_count: number;
  comment: string | null;
  created_at: string;
  failure_reason: FeedbackFailureReason | null;
  intent: Intent;
  question: string;
  rating: FeedbackRating;
  session_id: string | null;
  source_types: SourceType[] | null;
}

const DEFAULT_PGVECTOR_EMBEDDING_DIMENSION = 1536;
const DEFAULT_TOP_K = 6;
const MIN_VECTOR_SCORE = 0.25;
const DIRECT_X_POST_SOURCE_BOOST = 6;
const DIRECT_API_REFERENCE_BOOST = 6;
const DIRECT_EXTERNAL_DEVELOPER_BOOST = 6;
const CURRENT_STATUS_BOOST = 0.2;
const CURRENT_X_UPDATE_BOOST = 0.25;
const HISTORICAL_STATUS_PENALTY = -0.45;
const DEPRECATED_STATUS_PENALTY = -8;
const EFFECTIVE_AT_EPOCH = Date.UTC(2024, 0, 1);
const FRESHNESS_BOOST_PER_YEAR = 0.08;
const MAX_FRESHNESS_BOOST = 0.4;

export class VectorStoreConfigurationError extends Error {}

export class VectorStoreUnavailableError extends Error {
  constructor(public readonly originalError: unknown) {
    super('Vector store is unavailable. Check DATABASE_URL and database connectivity.');
  }
}

export function createPgPool(databaseUrl: string | undefined): Pool {
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new VectorStoreConfigurationError('DATABASE_URL is required for pgvector retrieval.');
  }

  return new Pool({ connectionString: databaseUrl });
}

export function createPgFeedbackStore(options: PgFeedbackStoreOptions): PgFeedbackStore {
  return {
    async getFeedbackStats(input: GetFeedbackStatsOptions = {}): Promise<FeedbackStats> {
      return getFeedbackStats(options.client, input);
    },

    async recordFeedback(input: RecordFeedbackInput): Promise<void> {
      await recordFeedback(options.client, input);
    },
  };
}

export function createPgVectorStore(options: PgVectorStoreOptions): PgVectorStore {
  const embeddingDimension = normalizeEmbeddingDimension(options.embeddingDimension);
  const tracer = options.tracer ?? noopQualityTracer;
  const upsertChunksWithClient = async (
    client: PgClientLike,
    chunks: EmbeddedKnowledgeChunk[],
  ): Promise<void> => {
    for (const chunk of chunks) {
      validateEmbedding(chunk.embedding, embeddingDimension);

      await queryDatabase(
        client,
        `
        insert into knowledge_chunks (
          id, document_id, title, module, source_type, source_url, file,
          heading_path, order_index, retrieved_at, effective_at, status, supersedes,
          attachments, content, tokens, search_vector, embedding, content_hash, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
          $13::jsonb, $14::jsonb, $15, $16,
          to_tsvector('simple', array_to_string($16::text[], ' ')), $17::vector, $18, now()
        )
        on conflict (id) do update set
          document_id = excluded.document_id,
          title = excluded.title,
          module = excluded.module,
          source_type = excluded.source_type,
          source_url = excluded.source_url,
          file = excluded.file,
          heading_path = excluded.heading_path,
          order_index = excluded.order_index,
          retrieved_at = coalesce(excluded.retrieved_at, knowledge_chunks.retrieved_at),
          effective_at = coalesce(excluded.effective_at, knowledge_chunks.effective_at),
          status = excluded.status,
          supersedes = excluded.supersedes,
          attachments = excluded.attachments,
          content = excluded.content,
          tokens = excluded.tokens,
          search_vector = excluded.search_vector,
          embedding = excluded.embedding,
          content_hash = excluded.content_hash,
          updated_at = now()
        `,
        [
          chunk.id,
          chunk.documentId,
          chunk.metadata.title,
          chunk.metadata.module,
          chunk.metadata.sourceType,
          chunk.metadata.sourceUrl,
          chunk.metadata.file,
          JSON.stringify(chunk.metadata.headingPath),
          chunk.metadata.order,
          chunk.metadata.retrievedAt ?? null,
          chunk.metadata.effectiveAt ?? null,
          chunk.metadata.status ?? defaultKnowledgeStatus(chunk.metadata.sourceType),
          JSON.stringify(chunk.metadata.supersedes ?? []),
          JSON.stringify(chunk.metadata.attachments ?? []),
          chunk.text,
          chunk.tokens,
          toPgVectorLiteral(chunk.embedding),
          chunk.contentHash,
        ],
      );
      await replaceChunkKnowledgeGraph({ client, chunk });
    }
  };
  const upsertChunks = (chunks: EmbeddedKnowledgeChunk[]): Promise<void> =>
    upsertChunksWithClient(options.client, chunks);

  return {
    async getChunkContentHashes(chunkIds: readonly string[]): Promise<Map<string, string>> {
      if (chunkIds.length === 0) {
        return new Map();
      }

      const response = await queryDatabase<KnowledgeChunkHashRow>(
        options.client,
        `
        select id, content_hash
        from knowledge_chunks
        where id = any($1::text[])
        `,
        [chunkIds],
      );

      return new Map(response.rows.map((row) => [row.id, row.content_hash]));
    },

    async getFeedbackStats(input: GetFeedbackStatsOptions = {}): Promise<FeedbackStats> {
      return getFeedbackStats(options.client, input);
    },

    async getStats(): Promise<KnowledgeStats> {
      const [totals, sourceStats, latestIngestionRun] = await Promise.all([
        getKnowledgeTotals(options.client),
        getKnowledgeSourceStats(options.client),
        getLatestIngestionRun(options.client),
      ]);

      return {
        chunkCount: totals.chunk_count,
        documentCount: totals.document_count,
        sourceStats,
        sourceUrlCount: totals.source_url_count,
        ...(totals.latest_chunk_updated_at === null
          ? {}
          : { latestChunkUpdatedAt: totals.latest_chunk_updated_at }),
        ...(latestIngestionRun === undefined ? {} : { latestIngestionRun }),
      };
    },

    async migrate(migrationOptions: PgVectorMigrationOptions = {}): Promise<void> {
      await queryDatabase(options.client, 'create extension if not exists vector');
      await queryDatabase(options.client, 'create extension if not exists pg_trgm');
      await queryDatabase(
        options.client,
        `
        create table if not exists knowledge_chunks (
          id text primary key,
          document_id text not null,
          title text not null,
          module text not null,
          source_type text not null check (
            source_type in ('admin_verified', 'official_docs', 'x_updates')
          ),
          source_url text,
          file text not null,
          heading_path jsonb not null,
          order_index integer,
          retrieved_at timestamptz,
          effective_at timestamptz,
          status text not null default 'current'
            check (status in ('current', 'historical', 'deprecated')),
          supersedes jsonb not null default '[]'::jsonb,
          attachments jsonb not null default '[]'::jsonb,
          content text not null,
          tokens text[] not null,
          search_vector tsvector,
          embedding vector(${embeddingDimension}) not null,
          content_hash text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `,
      );
      await assertEmbeddingDimensionMatches(
        options.client,
        embeddingDimension,
        migrationOptions.allowEmbeddingDimensionMismatch === true,
      );
      await queryDatabase(
        options.client,
        `
        alter table knowledge_chunks
          drop constraint if exists knowledge_chunks_source_type_check
        `,
      );
      await queryDatabase(
        options.client,
        `
        alter table knowledge_chunks
          add constraint knowledge_chunks_source_type_check check (
            source_type in ('admin_verified', 'official_docs', 'x_updates')
          )
        `,
      );
      await queryDatabase(
        options.client,
        `
        alter table knowledge_chunks
          add column if not exists effective_at timestamptz
        `,
      );
      await queryDatabase(
        options.client,
        `
        alter table knowledge_chunks
          add column if not exists status text not null default 'current'
            check (status in ('current', 'historical', 'deprecated'))
        `,
      );
      await queryDatabase(
        options.client,
        `
        alter table knowledge_chunks
          add column if not exists supersedes jsonb not null default '[]'::jsonb
        `,
      );
      await queryDatabase(
        options.client,
        `
        alter table knowledge_chunks
          add column if not exists attachments jsonb not null default '[]'::jsonb
        `,
      );
      await queryDatabase(
        options.client,
        `alter table knowledge_chunks add column if not exists search_vector tsvector`,
      );
      await queryDatabase(
        options.client,
        `update knowledge_chunks
         set search_vector=to_tsvector('simple', array_to_string(tokens, ' '))
         where search_vector is null`,
      );
      await queryDatabase(
        options.client,
        `create index if not exists knowledge_chunks_search_vector_idx
         on knowledge_chunks using gin (search_vector)`,
      );
      await queryDatabase(
        options.client,
        `create index if not exists knowledge_chunks_title_trgm_idx
         on knowledge_chunks using gin (lower(title) gin_trgm_ops)`,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists knowledge_chunks_embedding_idx
          on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists knowledge_chunks_tokens_idx
          on knowledge_chunks using gin (tokens)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists knowledge_chunks_source_type_idx
          on knowledge_chunks (source_type)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create table if not exists rag_ingestion_runs (
          id bigserial primary key,
          run_id text not null unique,
          source text not null,
          document_count integer not null,
          chunk_count integer not null,
          source_counts jsonb not null,
          content_hash text not null,
          created_at timestamptz not null default now()
        )
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists rag_ingestion_runs_created_at_idx
          on rag_ingestion_runs (created_at desc)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create table if not exists rag_feedback (
          id bigserial primary key,
          channel text not null check (channel in ('cli', 'web', 'telegram')),
          session_id text,
          rating text not null check (rating in ('positive', 'negative')),
          question text not null,
          answer text not null,
          intent text not null check (
            intent in (
              'agent_capabilities',
              'product_qa',
              'how_to',
              'onchain_transaction',
              'realtime_account_query',
              'investment_advice',
              'unknown'
            )
          ),
          citation_count integer not null check (citation_count >= 0),
          answer_status text check (
            answer_status in ('complete', 'partial', 'insufficient', 'conflict')
          ),
          source_types jsonb,
          comment text,
          failure_reason text,
          created_at timestamptz not null default now()
        )
      `,
      );
      await queryDatabase(
        options.client,
        `
        alter table rag_feedback
          add column if not exists answer_status text
            check (answer_status in ('complete', 'partial', 'insufficient', 'conflict')),
          add column if not exists source_types jsonb,
          add column if not exists failure_reason text
      `,
      );
      await queryDatabase(
        options.client,
        `
        alter table rag_feedback
          drop constraint if exists rag_feedback_failure_reason_check,
          add constraint rag_feedback_failure_reason_check check (
            failure_reason is null or failure_reason in (
              'off_topic',
              'incomplete',
              'outdated',
              'incorrect',
              'incorrect_steps',
              'unsupported_citation',
              'too_verbose',
              'context_misunderstood',
              'knowledge_missing',
              'knowledge_conflict',
              'other'
            )
          )
      `,
      );
      await queryDatabase(
        options.client,
        `
        alter table rag_feedback
          drop constraint if exists rag_feedback_source_types_check,
          add constraint rag_feedback_source_types_check check (
            source_types is null
            or (
              jsonb_typeof(source_types) = 'array'
              and source_types <@ '["admin_verified", "official_docs", "x_updates"]'::jsonb
            )
          )
      `,
      );
      await queryDatabase(
        options.client,
        `
        alter table rag_feedback
          drop constraint if exists rag_feedback_intent_check
      `,
      );
      await queryDatabase(
        options.client,
        `
        alter table rag_feedback
          add constraint rag_feedback_intent_check check (
            intent in (
              'agent_capabilities',
              'product_qa',
              'how_to',
              'onchain_transaction',
              'realtime_account_query',
              'investment_advice',
              'unknown'
            )
          )
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists rag_feedback_created_at_idx
          on rag_feedback (created_at desc)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists rag_feedback_rating_idx
          on rag_feedback (rating)
      `,
      );
      await queryDatabase(
        options.client,
        `
        create index if not exists rag_feedback_session_id_idx
          on rag_feedback (session_id)
          where session_id is not null
        `,
      );
      await migrateKnowledgePublicationJobs(options.client);
      await migrateSupportOperations(options.client);
      await migrateKnowledgeGraph(options.client);
    },

    async recordFeedback(input: RecordFeedbackInput): Promise<void> {
      await recordFeedback(options.client, input);
    },

    async recordIngestionRun(input: RecordIngestionRunInput): Promise<void> {
      await recordIngestionRun(options.client, input);
    },

    async replaceChunks(
      chunks: EmbeddedKnowledgeChunk[],
      ingestionRun: RecordIngestionRunInput,
      replaceOptions: ReplaceChunksOptions = {},
    ): Promise<void> {
      await withTransaction(options.client, async (client) => {
        if (replaceOptions.rebuildEmbeddingSchema === true) {
          await rebuildEmbeddingSchema(client, embeddingDimension);
        }

        await upsertChunksWithClient(client, chunks);
        if (replaceOptions.rebuildEmbeddingSchema !== true) {
          await pruneStaleChunks(
            client,
            chunks.map((chunk) => chunk.id),
          );
        }
        await recordIngestionRun(client, ingestionRun);
        await replaceOptions.afterReplace?.(client);
      });
    },

    upsertChunks,

    async retrieve(question: string, retrieveOptions: RetrieveOptions): Promise<RetrievedChunk[]> {
      const [queryEmbedding] = await tracer.run(
        {
          inputs: { questionLength: question.length },
          name: 'rag.query_embedding',
          output: (embeddings) => ({ embeddingDimension: embeddings[0]?.length ?? 0 }),
          runType: 'embedding',
        },
        () => options.embeddingProvider.embedTexts([createSemanticRetrieveQuery(question)]),
      );
      if (queryEmbedding === undefined) {
        return [];
      }

      validateEmbedding(queryEmbedding, embeddingDimension);

      const topK = normalizeTopK(retrieveOptions.topK);
      const lexicalQueryTokens = Array.from(
        new Set([
          ...createLexicalRetrieveQueryTokens(question),
          ...createKnowledgeAliasQueryTokens(question),
        ]),
      );
      const fullTextQuery = createKnowledgeAliasQueryTokens(question).join(' ');
      const graphEntityNames = matchKnowledgeAliases(question).map((match) => match.canonical);
      const supportEntities = extractSupportEntityTokens(question);
      const includeApiReferenceDocs = shouldIncludeApiReferenceDocumentation(question);
      const isChangelogQuestion = isChangelogDocumentationQuestion(question);
      const isLegalQuestion = isLegalDocumentationQuestion(question);
      const includeEnglishDocs = shouldIncludeEnglishDocumentation(question);
      const includeExternalDeveloperDocs = shouldIncludeExternalDeveloperDocumentation(question);
      const entityPrefixPatterns = supportEntities
        .filter((entity) => entity.length >= 6)
        .map((entity) => `%${entity.slice(0, 6)}%`);
      const anchorDocumentIds = retrieveOptions.policy?.anchorDocumentIds ?? [];
      const candidateLimit = Math.max(topK * 4, topK);
      return tracer.run(
        {
          inputs: {
            candidateLimit,
            entityCount: supportEntities.length,
            anchorDocumentCount: anchorDocumentIds.length,
            queryTokenCount: lexicalQueryTokens.length,
            topK,
          },
          name: 'rag.pgvector_candidates',
          output: (chunks) => ({ chunks: summarizeRetrievedChunks(chunks) }),
          runType: 'retriever',
        },
        async () => {
          const response = await queryDatabase<KnowledgeChunkRow>(
            options.client,
            `
        with active_supersedes as (
          select distinct jsonb_array_elements_text(supersedes) as knowledge_id
          from knowledge_chunks
          where
            status = 'current'
            and jsonb_array_length(supersedes) > 0
            and not exists (
              select 1
              from knowledge_source_tombstones
              where knowledge_source_tombstones.document_id = knowledge_chunks.document_id
            )
        ),
        eligible_knowledge_chunks as (
          select knowledge_chunks.*
          from knowledge_chunks
          where
            not exists (
              select 1
              from knowledge_source_tombstones
              where knowledge_source_tombstones.document_id = knowledge_chunks.document_id
            )
            and (
              $6::boolean
              or not exists (
                select 1
                from active_supersedes
                where
                  active_supersedes.knowledge_id = knowledge_chunks.id
                  or active_supersedes.knowledge_id = knowledge_chunks.document_id
              )
            )
            and (
              $7::boolean
              or not (
                lower(module) like '%api%'
                or lower(title) like '%api%'
                or source_url like '%/xxyy-api-can-kao-wen-dang'
              )
            )
            and (
              $8::boolean
              or source_url is null
              or (
                source_url not like '%/changelog'
                and source_url not like '%/en/feature-updates'
              )
            )
            and (
              $9::boolean
              or source_url is null
              or (
                source_url not like '%/wang-zhan-xie-yi/%'
                and source_url not like '%/en/xxyy-terms/%'
              )
            )
            and (
              $10::boolean
              or source_url is null
              or (
                source_url not like '%/en'
                and source_url not like '%/en/%'
              )
            )
            and (
              $11::boolean
              or not (
                source_url like '%github.com/Jimmy-Holiday/xxyy-trade-skill/%'
                or lower(module) like '%developer / agent skill%'
              )
            )
        ),
        vector_candidates as (
          select
            id, document_id, title, module, source_type, source_url, file,
            heading_path, order_index, retrieved_at::text as retrieved_at,
            effective_at::text as effective_at, status, supersedes, attachments, content, tokens,
            embedding <=> $1::vector as embedding_distance,
            0::integer as token_overlap,
            row_number() over (order by embedding <=> $1::vector)::integer as vector_rank,
            null::integer as lexical_rank,
            null::integer as entity_rank
          from eligible_knowledge_chunks
          order by embedding <=> $1::vector
          limit $2
        ),
        lexical_candidates as (
          select
            id, document_id, title, module, source_type, source_url, file,
            heading_path, order_index, retrieved_at::text as retrieved_at,
            effective_at::text as effective_at, status, supersedes, attachments, content, tokens,
            embedding <=> $1::vector as embedding_distance,
            (
              select count(*)::integer
              from unnest(tokens) as token(value)
              where token.value = any($3::text[])
            ) as token_overlap
            ,null::integer as vector_rank
            ,row_number() over (
              order by (
                select count(*)::integer
                from unnest(tokens) as token(value)
                where token.value = any($3::text[])
              ) desc, embedding <=> $1::vector asc
            )::integer as lexical_rank
            ,null::integer as entity_rank
          from eligible_knowledge_chunks
          where
            tokens && $3::text[]
            or (
              length($13::text) > 0
              and search_vector @@ plainto_tsquery('simple', $13::text)
            )
            or similarity(lower(title), lower($13::text)) >= 0.25
          order by
            token_overlap desc,
            ts_rank_cd(search_vector, plainto_tsquery('simple', $13::text)) desc,
            similarity(lower(title), lower($13::text)) desc,
            embedding_distance asc
          limit $2
        ),
        entity_candidates as (
          select
            id, document_id, title, module, source_type, source_url, file,
            heading_path, order_index, retrieved_at::text as retrieved_at,
            effective_at::text as effective_at, status, supersedes, attachments, content, tokens,
            embedding <=> $1::vector as embedding_distance,
            (
              select count(*)::integer
              from unnest(tokens) as token(value)
              where token.value = any($4::text[])
            ) as token_overlap
            ,null::integer as vector_rank
            ,null::integer as lexical_rank
            ,row_number() over (
              order by (
                select count(*)::integer
                from unnest(tokens) as token(value)
                where token.value = any($4::text[])
              ) desc, embedding <=> $1::vector asc
            )::integer as entity_rank
          from eligible_knowledge_chunks
          where
            cardinality($4::text[]) > 0
            and (
              tokens && $4::text[]
              or (
                cardinality($5::text[]) > 0
                and lower(content) like any ($5::text[])
              )
            )
          order by token_overlap desc, embedding_distance asc
          limit $2
        ),
        anchor_candidates as (
          select
            id, document_id, title, module, source_type, source_url, file,
            heading_path, order_index, retrieved_at::text as retrieved_at,
            effective_at::text as effective_at, status, supersedes, attachments, content, tokens,
            embedding <=> $1::vector as embedding_distance,
            0::integer as token_overlap,
            null::integer as vector_rank,
            null::integer as lexical_rank,
            null::integer as entity_rank
          from eligible_knowledge_chunks
          where
            cardinality($12::text[]) > 0
            and document_id = any($12::text[])
          order by document_id, order_index nulls last, id
          limit $2
        ),
        graph_candidates as (
          select distinct
            k.id, k.document_id, k.title, k.module, k.source_type, k.source_url, k.file,
            k.heading_path, k.order_index, k.retrieved_at::text as retrieved_at,
            k.effective_at::text as effective_at, k.status, k.supersedes, k.attachments,
            k.content, k.tokens,
            k.embedding <=> $1::vector as embedding_distance,
            0::integer as token_overlap,
            null::integer as vector_rank,
            null::integer as lexical_rank,
            row_number() over (
              order by r.confidence desc, k.embedding <=> $1::vector
            )::integer as entity_rank
          from eligible_knowledge_chunks k
          join knowledge_graph_relations r
            on r.source_chunk_id=k.id and r.status='approved'
          join knowledge_graph_entities s on s.id=r.subject_entity_id
          join knowledge_graph_entities o on o.id=r.object_entity_id
          where
            cardinality($14::text[]) > 0
            and (s.canonical_name=any($14::text[]) or o.canonical_name=any($14::text[]))
          limit $2
        ),
        combined_candidates as (
          select * from vector_candidates
          union all
          select * from lexical_candidates
          union all
          select * from entity_candidates
          union all
          select * from anchor_candidates
          union all
          select * from graph_candidates
        )
        select distinct on (id)
          id, document_id, title, module, source_type, source_url, file,
          heading_path, order_index, retrieved_at, effective_at, status, supersedes,
          attachments, content, tokens,
          embedding_distance,
          min(vector_rank) over (partition by id) as vector_rank,
          min(lexical_rank) over (partition by id) as lexical_rank,
          min(entity_rank) over (partition by id) as entity_rank
        from combined_candidates
        order by id, token_overlap desc, embedding_distance asc
        `,
            [
              toPgVectorLiteral(queryEmbedding),
              candidateLimit,
              lexicalQueryTokens,
              supportEntities,
              entityPrefixPatterns,
              isHistoricalOrTweetQuestion(question),
              includeApiReferenceDocs,
              isChangelogQuestion,
              isLegalQuestion,
              includeEnglishDocs,
              includeExternalDeveloperDocs,
              anchorDocumentIds,
              fullTextQuery,
              graphEntityNames,
            ],
          );

          const ranked = response.rows
            .filter((row) =>
              isDocumentationScopeEligible(question, {
                module: row.module,
                title: row.title,
                ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
              }),
            )
            .map((row) => mapRow(row, question, lexicalQueryTokens, supportEntities))
            .filter(
              (chunk) =>
                anchorDocumentIds.includes(chunk.documentId) || hasMinimumRetrievalEvidence(chunk),
            )
            .sort(compareRetrievedChunks);
          return pinRetrievalPolicyAnchors(ranked, anchorDocumentIds, topK).map((chunk, index) => ({
            ...chunk,
            rank: index + 1,
          }));
        },
      );
    },
  };
}

async function getFeedbackStats(
  client: PgClientLike,
  options: GetFeedbackStatsOptions,
): Promise<FeedbackStats> {
  const [totals, latest] = await Promise.all([
    getFeedbackTotals(client, options.rating),
    getLatestFeedback(client, options.limit, options.rating),
  ]);

  return {
    latest,
    negativeCount: totals.negative_count,
    positiveCount: totals.positive_count,
    totalCount: totals.total_count,
  };
}

async function getFeedbackTotals(
  client: PgClientLike,
  rating: FeedbackRating | undefined,
): Promise<FeedbackStatsRow> {
  const whereClause = rating === undefined ? '' : 'where rating = $1';
  const values = rating === undefined ? [] : [rating];
  const response = await queryDatabase<FeedbackStatsRow>(
    client,
    `
    select
      count(*)::integer as total_count,
      count(*) filter (where rating = 'positive')::integer as positive_count,
      count(*) filter (where rating = 'negative')::integer as negative_count
    from rag_feedback
    ${whereClause}
    `,
    values,
  );

  return (
    response.rows[0] ?? {
      negative_count: 0,
      positive_count: 0,
      total_count: 0,
    }
  );
}

async function getLatestFeedback(
  client: PgClientLike,
  limit: number | undefined,
  rating: FeedbackRating | undefined,
): Promise<FeedbackRecord[]> {
  const normalizedLimit = normalizeFeedbackLimit(limit);
  const whereClause = rating === undefined ? '' : 'where rating = $1';
  const values = rating === undefined ? [normalizedLimit] : [rating, normalizedLimit];
  const response = await queryDatabase<FeedbackRecordRow>(
    client,
    `
    select
      answer,
      answer_status,
      channel,
      citation_count,
      comment,
      created_at::text as created_at,
      failure_reason,
      intent,
      question,
      rating,
      session_id,
      source_types
    from rag_feedback
    ${whereClause}
    order by created_at desc
    limit $${values.length}
    `,
    values,
  );

  return response.rows.map((row) => ({
    answer: row.answer,
    ...(row.answer_status === null || row.answer_status === undefined
      ? {}
      : { answerStatus: row.answer_status }),
    channel: row.channel,
    citationCount: row.citation_count,
    createdAt: row.created_at,
    intent: row.intent,
    question: row.question,
    rating: row.rating,
    ...(row.comment === null ? {} : { comment: row.comment }),
    ...(row.failure_reason === null || row.failure_reason === undefined
      ? {}
      : { failureReason: row.failure_reason }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.source_types === null || row.source_types === undefined
      ? {}
      : { sourceTypes: row.source_types }),
  }));
}

async function recordFeedback(client: PgClientLike, input: RecordFeedbackInput): Promise<void> {
  const question = sanitizeFeedbackText(input.question);
  const answer = sanitizeFeedbackText(input.answer);
  const comment = input.comment === undefined ? null : sanitizeFeedbackText(input.comment);

  await queryDatabase(
    client,
    `
    insert into rag_feedback (
      channel, session_id, rating, question, answer, intent, citation_count, comment,
      answer_status, source_types, failure_reason
    )
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      input.channel,
      input.sessionId ?? null,
      input.rating,
      question,
      answer,
      input.intent,
      input.citationCount,
      comment,
      input.answerStatus ?? null,
      input.sourceTypes === undefined ? null : [...new Set(input.sourceTypes)],
      input.failureReason ?? null,
    ],
  );
}

async function recordIngestionRun(
  client: PgClientLike,
  input: RecordIngestionRunInput,
): Promise<void> {
  await queryDatabase(
    client,
    `
    insert into rag_ingestion_runs (
      run_id, source, document_count, chunk_count, source_counts, content_hash
    )
    values ($1, $2, $3, $4, $5::jsonb, $6)
    on conflict (run_id) do nothing
    `,
    [
      input.runId,
      input.source,
      input.documentCount,
      input.chunkCount,
      JSON.stringify(input.sourceCounts),
      input.contentHash,
    ],
  );
}

function sanitizeFeedbackText(text: string): string {
  return redactFeedbackCredentials(text)
    .replace(/\b0x[a-fA-F0-9]{64}\b/gu, '[evm_tx_hash]')
    .replace(/\b0x[a-fA-F0-9]{40}\b/gu, '[evm_address]')
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/gu, '[solana_signature]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[phone]')
    .trim();
}

function redactFeedbackCredentials(text: string): string {
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

async function getKnowledgeTotals(client: PgClientLike): Promise<KnowledgeStatsRow> {
  const response = await queryDatabase<KnowledgeStatsRow>(
    client,
    `
    select
      count(distinct document_id)::integer as document_count,
      count(*)::integer as chunk_count,
      (count(distinct source_url) filter (where source_url is not null))::integer as source_url_count,
      max(updated_at)::text as latest_chunk_updated_at
    from knowledge_chunks
    where not exists (
      select 1
      from knowledge_source_tombstones
      where knowledge_source_tombstones.document_id = knowledge_chunks.document_id
    )
    `,
  );

  return (
    response.rows[0] ?? {
      chunk_count: 0,
      document_count: 0,
      latest_chunk_updated_at: null,
      source_url_count: 0,
    }
  );
}

async function getKnowledgeSourceStats(client: PgClientLike): Promise<KnowledgeSourceStats[]> {
  const response = await queryDatabase<KnowledgeSourceStatsRow>(
    client,
    `
    select
      source_type,
      count(distinct document_id)::integer as document_count,
      count(*)::integer as chunk_count
    from knowledge_chunks
    where not exists (
      select 1
      from knowledge_source_tombstones
      where knowledge_source_tombstones.document_id = knowledge_chunks.document_id
    )
    group by source_type
    order by source_type
    `,
  );

  return response.rows.map((row) => ({
    chunkCount: row.chunk_count,
    documentCount: row.document_count,
    sourceType: row.source_type,
  }));
}

async function getLatestIngestionRun(
  client: PgClientLike,
): Promise<KnowledgeIngestionRun | undefined> {
  const response = await queryDatabase<KnowledgeIngestionRunRow>(
    client,
    `
    select
      run_id,
      source,
      document_count,
      chunk_count,
      source_counts,
      content_hash,
      created_at::text as created_at
    from rag_ingestion_runs
    order by created_at desc
    limit 1
    `,
  );
  const row = response.rows[0];
  if (row === undefined) {
    return undefined;
  }

  return {
    chunkCount: row.chunk_count,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    documentCount: row.document_count,
    runId: row.run_id,
    source: row.source,
    sourceCounts: row.source_counts,
  };
}

async function pruneStaleChunks(client: PgClientLike, retainedChunkIds: string[]): Promise<void> {
  await queryDatabase(
    client,
    `
    with deleted_graph_relations as (
      delete from knowledge_graph_relations
      where not (source_chunk_id = any($1::text[]))
    )
    delete from knowledge_chunks
    where not (id = any($1::text[]))
    `,
    [retainedChunkIds],
  );
}

async function assertEmbeddingDimensionMatches(
  client: PgClientLike,
  embeddingDimension: number,
  allowMismatch: boolean,
): Promise<void> {
  const response = await queryDatabase<{ embedding_type: string }>(
    client,
    `
    select format_type(atttypid, atttypmod) as embedding_type
    from pg_attribute
    where attrelid = 'knowledge_chunks'::regclass
      and attname = 'embedding'
      and not attisdropped
    `,
  );
  const embeddingType = response.rows[0]?.embedding_type;
  if (embeddingType === undefined) {
    return;
  }
  const existingDimension = parseVectorDimension(embeddingType);
  if (existingDimension === embeddingDimension) {
    return;
  }
  if (allowMismatch) {
    return;
  }

  throw new VectorStoreConfigurationError(
    `knowledge_chunks.embedding is ${embeddingType ?? 'missing'}, but EMBEDDING_DIMENSION is ${embeddingDimension}. Run pnpm rag:ingest -- --rebuild-embedding-schema for an intentional dimension change.`,
  );
}

function parseVectorDimension(embeddingType: string | undefined): number | undefined {
  const match = /^vector\((\d+)\)$/u.exec(embeddingType ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

async function rebuildEmbeddingSchema(
  client: PgClientLike,
  embeddingDimension: number,
): Promise<void> {
  await queryDatabase(client, 'truncate table knowledge_chunks');
  await queryDatabase(client, 'drop index if exists knowledge_chunks_embedding_idx');
  await queryDatabase(client, 'alter table knowledge_chunks drop column embedding');
  await queryDatabase(
    client,
    `alter table knowledge_chunks add column embedding vector(${embeddingDimension}) not null`,
  );
  await queryDatabase(
    client,
    `
    create index knowledge_chunks_embedding_idx
      on knowledge_chunks using ivfflat (embedding vector_cosine_ops)
    `,
  );
}

async function withTransaction<T>(
  pool: PgClientLike,
  operation: (client: PgClientLike) => Promise<T>,
): Promise<T> {
  if (pool.connect === undefined) {
    throw new VectorStoreConfigurationError(
      'Atomic knowledge replacement requires a PostgreSQL Pool connection.',
    );
  }

  let client: PgTransactionClientLike;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new VectorStoreUnavailableError(error);
  }

  try {
    await queryDatabase(client, 'begin');
    const result = await operation(client);
    await queryDatabase(client, 'commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Preserve the operation error; rollback failure is secondary.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function queryDatabase<T>(
  client: PgClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  try {
    return await client.query<T>(sql, values);
  } catch (error) {
    throw new VectorStoreUnavailableError(error);
  }
}

export function toPgVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function validateEmbedding(embedding: number[], embeddingDimension: number): void {
  if (embedding.length !== embeddingDimension) {
    throw new Error(`Expected embedding dimension ${embeddingDimension}, got ${embedding.length}.`);
  }

  for (let index = 0; index < embeddingDimension; index += 1) {
    if (!Number.isFinite(embedding[index])) {
      throw new Error('Embedding contains a non-finite value.');
    }
  }
}

function normalizeEmbeddingDimension(embeddingDimension: number | undefined): number {
  if (
    embeddingDimension === undefined ||
    !Number.isInteger(embeddingDimension) ||
    embeddingDimension <= 0
  ) {
    return DEFAULT_PGVECTOR_EMBEDDING_DIMENSION;
  }

  return embeddingDimension;
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined) {
    return DEFAULT_TOP_K;
  }

  if (!Number.isInteger(topK) || topK <= 0) {
    return DEFAULT_TOP_K;
  }

  return topK;
}

function normalizeFeedbackLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 10;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    return 10;
  }

  return Math.min(limit, 100);
}

function mapRow(
  row: KnowledgeChunkRow,
  question: string,
  queryTokens: string[],
  supportEntities: string[] = [],
): RetrievedChunk {
  const lexicalScore = queryTokens.filter((token) => row.tokens.includes(token)).length;
  const vectorScore = Math.max(0, 1 - row.embedding_distance);
  const fusionScore = reciprocalRankFusionScore([
    row.vector_rank,
    row.lexical_rank,
    row.entity_rank,
  ]);
  const rowSourceBoost =
    sourceBoost(row.source_type) +
    directXPostSourceBoost(question, row) +
    directApiReferenceBoost(question, row) +
    directExternalDeveloperBoost(question, row);
  const status = row.status ?? defaultKnowledgeStatus(row.source_type);
  const freshnessBoost = freshnessScore(
    question,
    row.source_type,
    status,
    row.effective_at ?? undefined,
  );
  const entityBoost = supportEntityEvidenceBoost(
    [row.title, row.module, ...(row.heading_path ?? []), row.content].join(' '),
    supportEntities,
  );
  const score = Number((fusionScore + rowSourceBoost + freshnessBoost + entityBoost).toFixed(8));
  const entry: IndexEntry = {
    documentId: row.document_id,
    embedding: [],
    id: row.id,
    metadata: {
      file: row.file,
      headingPath: row.heading_path,
      module: row.module,
      sourceType: row.source_type,
      title: row.title,
      ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
      ...(row.order_index === null ? {} : { order: row.order_index }),
      ...(row.retrieved_at === null ? {} : { retrievedAt: row.retrieved_at }),
      ...(row.effective_at === null || row.effective_at === undefined
        ? {}
        : { effectiveAt: row.effective_at }),
      status,
      ...(row.supersedes === null || row.supersedes === undefined || row.supersedes.length === 0
        ? {}
        : { supersedes: row.supersedes }),
      ...(row.attachments === null || row.attachments === undefined || row.attachments.length === 0
        ? {}
        : { attachments: row.attachments }),
    },
    text: row.content,
    tokens: row.tokens,
  };

  return {
    ...entry,
    lexicalScore,
    freshnessBoost: Number(freshnessBoost.toFixed(8)),
    fusionScore,
    ...(row.entity_rank === null || row.entity_rank === undefined
      ? {}
      : { entityRank: row.entity_rank }),
    ...(row.lexical_rank === null || row.lexical_rank === undefined
      ? {}
      : { lexicalRank: row.lexical_rank }),
    rank: 0,
    score,
    sourceBoost: Number(rowSourceBoost.toFixed(8)),
    vectorScore,
    ...(row.vector_rank === null || row.vector_rank === undefined
      ? {}
      : { vectorRank: row.vector_rank }),
  };
}

function hasMinimumRetrievalEvidence(chunk: RetrievedChunk): boolean {
  return chunk.lexicalScore > 0 || chunk.vectorScore >= MIN_VECTOR_SCORE;
}

function sourceBoost(sourceType: SourceType): number {
  return sourceType === 'x_updates' ? 0 : 0.05;
}

function defaultKnowledgeStatus(sourceType: SourceType): KnowledgeStatus {
  return sourceType === 'x_updates' ? 'historical' : 'current';
}

function freshnessScore(
  question: string,
  sourceType: SourceType,
  status: KnowledgeStatus,
  effectiveAt: string | undefined,
): number {
  const isHistoryQuestion = isHistoricalOrTweetQuestion(question);
  let score = 0;

  if (status === 'deprecated') {
    score += DEPRECATED_STATUS_PENALTY;
  } else if (status === 'historical') {
    score += isHistoryQuestion ? 0 : HISTORICAL_STATUS_PENALTY;
  } else {
    score += isHistoryQuestion ? 0 : CURRENT_STATUS_BOOST;
    if (!isHistoryQuestion && sourceType === 'x_updates') {
      score += CURRENT_X_UPDATE_BOOST;
    }
  }

  if (!isHistoryQuestion && status === 'current') {
    score += effectiveAtFreshnessBoost(effectiveAt);
  }

  return score;
}

function effectiveAtFreshnessBoost(effectiveAt: string | undefined): number {
  if (effectiveAt === undefined) {
    return 0;
  }

  const timestamp = Date.parse(effectiveAt);
  if (!Number.isFinite(timestamp) || timestamp <= EFFECTIVE_AT_EPOCH) {
    return 0;
  }

  const yearsSinceEpoch = (timestamp - EFFECTIVE_AT_EPOCH) / (365 * 24 * 60 * 60 * 1000);
  return Math.min(MAX_FRESHNESS_BOOST, yearsSinceEpoch * FRESHNESS_BOOST_PER_YEAR);
}

function directXPostSourceBoost(question: string, row: KnowledgeChunkRow): number {
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  if (!/哪条推文|哪条推特|推文|推特|tweet|x\s*post/u.test(normalizedQuestion)) {
    return 0;
  }

  if (
    row.source_type === 'x_updates' &&
    row.title.startsWith('X Post ') &&
    row.source_url !== null &&
    /^https:\/\/x\.com\/useXXYYio\/status\/\d+$/iu.test(row.source_url)
  ) {
    return DIRECT_X_POST_SOURCE_BOOST;
  }

  return 0;
}

function directApiReferenceBoost(question: string, row: KnowledgeChunkRow): number {
  if (!shouldIncludeApiReferenceDocumentation(question)) {
    return 0;
  }
  return isApiReferenceDocument({
    module: row.module,
    title: row.title,
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
  })
    ? DIRECT_API_REFERENCE_BOOST
    : 0;
}

function directExternalDeveloperBoost(question: string, row: KnowledgeChunkRow): number {
  if (!shouldIncludeExternalDeveloperDocumentation(question)) {
    return 0;
  }
  return isExternalDeveloperDocument({
    module: row.module,
    title: row.title,
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
  })
    ? DIRECT_EXTERNAL_DEVELOPER_BOOST
    : 0;
}

function compareRetrievedChunks(left: RetrievedChunk, right: RetrievedChunk): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.id.localeCompare(right.id);
}
