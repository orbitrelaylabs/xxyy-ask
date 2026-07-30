import { describe, expect, it } from 'vitest';

import {
  createPgVectorStore,
  toPgVectorLiteral,
  type EmbeddedKnowledgeChunk,
  VectorStoreUnavailableError,
} from './pgvector-store.js';
import { createInMemoryQualityTracer } from './quality-trace.js';

class FakePgClient {
  failSqlIncludes: string | undefined;
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  releaseCount = 0;
  rows: unknown[] = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    if (this.failSqlIncludes !== undefined && sql.includes(this.failSqlIncludes)) {
      return Promise.reject(new Error(`forced query failure: ${this.failSqlIncludes}`));
    }
    const rows = this.queuedRows.length > 0 ? (this.queuedRows.shift() ?? []) : this.rows;
    return Promise.resolve({ rows: rows as T[] });
  }

  connect() {
    return Promise.resolve({
      query: this.query.bind(this),
      release: () => {
        this.releaseCount += 1;
      },
    });
  }
}

describe('toPgVectorLiteral', () => {
  it('formats vectors for pgvector parameters', () => {
    const vector = embedding1536({ 0: 0.1, 1: -0.2 });

    expect(toPgVectorLiteral(vector)).toBe(`[${vector.join(',')}]`);
  });
});

describe('createPgVectorStore', () => {
  it('migrates the knowledge chunk schema', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.migrate();

    expect(client.queries.map((query) => query.sql).join('\n')).toContain(
      'create table if not exists knowledge_chunks',
    );
    expect(client.queries.map((query) => query.sql).join('\n')).toContain(
      'create table if not exists rag_ingestion_runs',
    );
    expect(client.queries.map((query) => query.sql).join('\n')).not.toContain(
      'tx_analysis_reports',
    );
  });

  it('uses the configured embedding dimension in the knowledge chunk schema', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingDimension: 3,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.migrate();

    expect(client.queries.map((query) => query.sql).join('\n')).toContain('embedding vector(3)');
  });

  it('rejects ordinary migration when the existing vector dimension differs', async () => {
    const client = new FakePgClient();
    client.rows = [{ embedding_type: 'vector(1536)' }];
    const store = createPgVectorStore({
      client,
      embeddingDimension: 3072,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await expect(store.migrate()).rejects.toThrow('--rebuild-embedding-schema');
  });

  it('allows dimension mismatch inspection only for an explicit rebuild flow', async () => {
    const client = new FakePgClient();
    client.rows = [{ embedding_type: 'vector(1536)' }];
    const store = createPgVectorStore({
      client,
      embeddingDimension: 3072,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await expect(store.migrate({ allowEmbeddingDimensionMismatch: true })).resolves.toBeUndefined();
  });

  it('records ingestion runs for production knowledge versioning', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.recordIngestionRun({
      chunkCount: 64,
      contentHash: 'content-hash-1',
      documentCount: 12,
      runId: 'ingest_20260606T010203Z_abcd1234',
      source: 'cli',
      sourceCounts: {
        official_docs: 48,
        x_updates: 16,
      },
    });

    expect(client.queries[0]?.sql).toContain('insert into rag_ingestion_runs');
    expect(client.queries[0]?.values).toEqual([
      'ingest_20260606T010203Z_abcd1234',
      'cli',
      12,
      64,
      JSON.stringify({ official_docs: 48, x_updates: 16 }),
      'content-hash-1',
    ]);
  });

  it('records chat feedback for answer quality operations', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.recordFeedback({
      answer: '根据知识库，XXYY Pro 提供更多权益。',
      answerStatus: 'partial',
      channel: 'web',
      citationCount: 2,
      comment: '没有讲清楚监控数量上限',
      intent: 'product_qa',
      question: 'XXYY Pro 有哪些权益？',
      rating: 'negative',
      sessionId: 'session-1',
      sourceTypes: ['official_docs', 'x_updates', 'official_docs'],
    });

    expect(client.queries[0]?.sql).toContain('insert into rag_feedback');
    expect(client.queries[0]?.values).toEqual([
      'web',
      'session-1',
      'negative',
      'XXYY Pro 有哪些权益？',
      '根据知识库，XXYY Pro 提供更多权益。',
      'product_qa',
      2,
      '没有讲清楚监控数量上限',
      'partial',
      ['official_docs', 'x_updates'],
    ]);
  });

  it('redacts sensitive support data before recording chat feedback', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.recordFeedback({
      answer: '不要发送私钥、助记词或 seed phrase。api key: sk-answer-123',
      channel: 'web',
      citationCount: 0,
      comment: '我的密码是 hunter2',
      intent: 'unknown',
      question:
        '我的密码是 hunter2 api key: sk-test-123456 邮箱 test@example.com 手机 +1 415-555-0100',
      rating: 'negative',
      sessionId: 'session-1',
    });

    const values = client.queries[0]?.values ?? [];
    expect(values[3]).toBe(
      '我的密码是 [sensitive_credential] api key: [sensitive_credential] 邮箱 [email] 手机 [phone]',
    );
    expect(values[4]).toBe('不要发送私钥、助记词或 seed phrase。api key: [sensitive_credential]');
    expect(values[7]).toBe('我的密码是 [sensitive_credential]');
    expect(JSON.stringify(values)).not.toContain('hunter2');
    expect(JSON.stringify(values)).not.toContain('sk-test-123456');
    expect(JSON.stringify(values)).not.toContain('sk-answer-123');
    expect(JSON.stringify(values)).not.toContain('test@example.com');
    expect(JSON.stringify(values)).not.toContain('415-555-0100');
  });

  it('returns feedback stats for quality operations', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [{ negative_count: 1, positive_count: 2, total_count: 3 }],
      [
        {
          answer: '根据知识库，XXYY Pro 提供更多权益。',
          answer_status: 'partial',
          channel: 'web',
          citation_count: 2,
          comment: '没有讲清楚监控数量上限',
          created_at: '2026-06-06T02:03:04.000Z',
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'negative',
          session_id: 'session-1',
          source_types: ['official_docs'],
        },
      ],
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    const stats = await store.getFeedbackStats({ limit: 5 });

    expect(stats).toEqual({
      latest: [
        {
          answer: '根据知识库，XXYY Pro 提供更多权益。',
          answerStatus: 'partial',
          channel: 'web',
          citationCount: 2,
          comment: '没有讲清楚监控数量上限',
          createdAt: '2026-06-06T02:03:04.000Z',
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'negative',
          sessionId: 'session-1',
          sourceTypes: ['official_docs'],
        },
      ],
      negativeCount: 1,
      positiveCount: 2,
      totalCount: 3,
    });
    expect(client.queries[1]?.sql).toContain('from rag_feedback');
    expect(client.queries[1]?.values).toEqual([5]);
  });

  it('filters feedback stats by rating for operations review queues', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [{ negative_count: 1, positive_count: 0, total_count: 1 }],
      [
        {
          answer: '根据知识库，XXYY Pro 提供更多权益。',
          channel: 'web',
          citation_count: 2,
          comment: '没有讲清楚监控数量上限',
          created_at: '2026-06-06T02:03:04.000Z',
          intent: 'product_qa',
          question: 'XXYY Pro 有哪些权益？',
          rating: 'negative',
          session_id: 'session-1',
        },
      ],
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    const stats = await store.getFeedbackStats({ limit: 25, rating: 'negative' });

    expect(stats.negativeCount).toBe(1);
    expect(stats.latest).toHaveLength(1);
    expect(client.queries[0]?.sql).toContain('where rating = $1');
    expect(client.queries[0]?.values).toEqual(['negative']);
    expect(client.queries[1]?.sql).toContain('where rating = $1');
    expect(client.queries[1]?.values).toEqual(['negative', 25]);
  });

  it('returns knowledge stats for operations visibility', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          chunk_count: 64,
          document_count: 12,
          latest_chunk_updated_at: '2026-06-06T01:02:03.000Z',
          source_url_count: 8,
        },
      ],
      [
        { chunk_count: 48, document_count: 10, source_type: 'official_docs' },
        { chunk_count: 16, document_count: 2, source_type: 'x_updates' },
      ],
      [
        {
          chunk_count: 64,
          content_hash: 'content-hash-1',
          created_at: '2026-06-06T01:03:04.000Z',
          document_count: 12,
          run_id: 'ingest_20260606T010203Z_abcd1234',
          source: 'cli',
          source_counts: { official_docs: 48, x_updates: 16 },
        },
      ],
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    const stats = await store.getStats();

    expect(stats).toEqual({
      chunkCount: 64,
      documentCount: 12,
      latestChunkUpdatedAt: '2026-06-06T01:02:03.000Z',
      latestIngestionRun: {
        chunkCount: 64,
        contentHash: 'content-hash-1',
        createdAt: '2026-06-06T01:03:04.000Z',
        documentCount: 12,
        runId: 'ingest_20260606T010203Z_abcd1234',
        source: 'cli',
        sourceCounts: { official_docs: 48, x_updates: 16 },
      },
      sourceStats: [
        { chunkCount: 48, documentCount: 10, sourceType: 'official_docs' },
        { chunkCount: 16, documentCount: 2, sourceType: 'x_updates' },
      ],
      sourceUrlCount: 8,
    });
  });

  it('upserts embedded chunks', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.upsertChunks([
      createChunk({
        embedding: embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 }),
        metadata: {
          attachments: [
            {
              kind: 'image',
              mediaType: 'image/png',
              title: 'Pro 权益截图',
              url: '/assets/pro.png',
            },
          ],
          effectiveAt: '2026-03-16T11:12:30.350Z',
          retrievedAt: '2026-05-24T06:41:04.265Z',
          status: 'current',
          supersedes: ['x_updates:old-pro'],
        },
      }),
      createChunk({
        contentHash: 'hash-2',
        documentId: 'official_docs:basic',
        id: 'official_docs:basic:chunk:0001',
        metadata: {
          file: 'docs/basic.md',
          headingPath: ['XXYY Basic'],
          module: 'XXYY Basic',
          title: 'XXYY Basic',
        },
      }),
    ]);

    expect(client.queries[0]?.sql).toContain('insert into knowledge_chunks');
    expect(client.queries[0]?.sql).toContain(
      'retrieved_at = coalesce(excluded.retrieved_at, knowledge_chunks.retrieved_at)',
    );
    expect(client.queries[0]?.values).toContain(
      toPgVectorLiteral(embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })),
    );
    expect(client.queries[0]?.values[9]).toBe('2026-05-24T06:41:04.265Z');
    expect(client.queries[0]?.values).toContain('2026-03-16T11:12:30.350Z');
    expect(client.queries[0]?.values).toContain('current');
    expect(client.queries[0]?.values).toContain(JSON.stringify(['x_updates:old-pro']));
    expect(client.queries[0]?.values).toContain(
      JSON.stringify([
        {
          kind: 'image',
          mediaType: 'image/png',
          title: 'Pro 权益截图',
          url: '/assets/pro.png',
        },
      ]),
    );
    expect(client.queries[1]?.values[9]).toBeNull();
  });

  it('returns content hashes for selected chunks', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content_hash: 'hash-1',
        id: 'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
      },
      {
        content_hash: 'hash-2',
        id: 'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
      },
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    const hashes = await store.getChunkContentHashes([
      'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
      'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
      'x_updates:sources/usexxyyio-x-posts/3:chunk:0001',
    ]);

    expect(client.queries[0]?.sql).toContain('select id, content_hash');
    expect(client.queries[0]?.values).toEqual([
      [
        'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
        'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
        'x_updates:sources/usexxyyio-x-posts/3:chunk:0001',
      ],
    ]);
    expect(hashes).toEqual(
      new Map([
        ['x_updates:sources/usexxyyio-x-posts/1:chunk:0001', 'hash-1'],
        ['x_updates:sources/usexxyyio-x-posts/2:chunk:0001', 'hash-2'],
      ]),
    );
  });

  it('atomically replaces stale chunks and records the ingestion run', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.replaceChunks(
      [
        createChunk({
          id: 'official_docs:pro:chunk:0001',
        }),
        createChunk({
          contentHash: 'hash-2',
          id: 'official_docs:pro:chunk:0002',
        }),
      ],
      createIngestionRunInput(),
    );

    const sql = client.queries.map((query) => query.sql.trim().toLowerCase());
    expect(sql[0]).toBe('begin');
    expect(sql[1]).toContain('insert into knowledge_chunks');
    expect(sql[2]).toContain('insert into knowledge_chunks');
    expect(sql[3]).toContain('delete from knowledge_chunks');
    expect(client.queries[3]?.values).toEqual([
      ['official_docs:pro:chunk:0001', 'official_docs:pro:chunk:0002'],
    ]);
    expect(sql[4]).toContain('insert into rag_ingestion_runs');
    expect(sql[5]).toBe('commit');
    expect(client.releaseCount).toBe(1);
  });

  it.each(['insert into knowledge_chunks', 'insert into rag_ingestion_runs'])(
    'rolls back atomic replacement when %s fails',
    async (failedSql) => {
      const client = new FakePgClient();
      client.failSqlIncludes = failedSql;
      const store = createPgVectorStore({
        client,
        embeddingProvider: { embedTexts: () => Promise.resolve([]) },
      });

      await expect(
        store.replaceChunks([createChunk()], createIngestionRunInput()),
      ).rejects.toBeInstanceOf(VectorStoreUnavailableError);

      const sql = client.queries.map((query) => query.sql.trim().toLowerCase());
      expect(sql).toContain('rollback');
      expect(sql).not.toContain('commit');
      expect(client.releaseCount).toBe(1);
    },
  );

  it('rolls back replacement when its transactional finalizer fails', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await expect(
      store.replaceChunks([createChunk()], createIngestionRunInput(), {
        afterReplace: () => Promise.reject(new Error('candidate state changed')),
      }),
    ).rejects.toThrow('candidate state changed');

    const sql = client.queries.map((query) => query.sql.trim().toLowerCase());
    expect(sql).toContain('rollback');
    expect(sql).not.toContain('commit');
    expect(client.releaseCount).toBe(1);
  });

  it('rebuilds the embedding column inside the atomic replacement transaction', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingDimension: 3,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.replaceChunks(
      [createChunk({ embedding: [0.1, 0.2, 0.3] })],
      createIngestionRunInput(),
      {
        rebuildEmbeddingSchema: true,
      },
    );

    const sql = client.queries.map((query) => query.sql.trim().toLowerCase()).join('\n');
    expect(sql).toContain('truncate table knowledge_chunks');
    expect(sql).toContain('drop index if exists knowledge_chunks_embedding_idx');
    expect(sql).toContain('alter table knowledge_chunks drop column embedding');
    expect(sql).toContain('alter table knowledge_chunks add column embedding vector(3) not null');
    expect(sql).toContain('create index knowledge_chunks_embedding_idx');
    expect(client.queries.at(-1)?.sql.trim().toLowerCase()).toBe('commit');
    expect(client.releaseCount).toBe(1);
  });

  it('rejects upsert chunk embeddings with the wrong dimension', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await expect(store.upsertChunks([createChunk({ embedding: [0.1, 0.2, 0.3] })])).rejects.toThrow(
      'Expected embedding dimension 1536, got 3.',
    );
  });

  it('accepts upsert chunk embeddings that match a configured dimension', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingDimension: 3,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await store.upsertChunks([createChunk({ embedding: [0.1, 0.2, 0.3] })]);

    expect(client.queries[0]?.sql).toContain('insert into knowledge_chunks');
  });

  it('rejects upsert chunk embeddings with non-finite values', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([]) },
    });

    await expect(
      store.upsertChunks([createChunk({ embedding: embedding1536({ 0: Number.NaN }) })]),
    ).rejects.toThrow('Embedding contains a non-finite value.');
  });

  it('retrieves and maps pgvector rows into RetrievedChunk results', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: 'XXYY Pro 支持 Telegram 钱包监控。',
        document_id: 'official_docs:pro',
        embedding_distance: 0.1,
        file: 'docs/pro.md',
        heading_path: ['XXYY Pro 权益'],
        id: 'official_docs:pro:chunk:0001',
        module: 'XXYY Pro',
        order_index: null,
        retrieved_at: null,
        effective_at: '2026-03-16T11:12:30.350Z',
        status: 'current',
        supersedes: ['x_updates:old-pro'],
        attachments: [
          {
            kind: 'image',
            mediaType: 'image/png',
            title: 'Pro 权益截图',
            url: '/assets/pro.png',
          },
        ],
        source_type: 'official_docs',
        source_url: null,
        title: 'XXYY Pro 权益',
        tokens: ['xxyy', 'pro', 'telegram'],
      },
    ];
    const embeddedTexts: string[][] = [];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts(texts) {
          embeddedTexts.push(texts);
          return Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]);
        },
      },
    });

    const results = await store.retrieve('XXYY Pro 支持什么？', { topK: 1 });

    expect(embeddedTexts).toEqual([['XXYY Pro 支持什么？\nXXYY Pro 权益 会员权益']]);
    expect(client.queries.at(-1)?.sql).toContain('embedding <=> $1::vector');
    expect(client.queries.at(-1)?.sql).toContain('active_supersedes');
    expect(client.queries.at(-1)?.sql).toContain('knowledge_source_tombstones');
    expect(client.queries.at(-1)?.values[5]).toBe(false);
    expect(results[0]).toMatchObject({
      id: 'official_docs:pro:chunk:0001',
      rank: 1,
      sourceBoost: 0.05,
      metadata: {
        file: 'docs/pro.md',
        effectiveAt: '2026-03-16T11:12:30.350Z',
        sourceType: 'official_docs',
        status: 'current',
        supersedes: ['x_updates:old-pro'],
        attachments: [
          {
            kind: 'image',
            mediaType: 'image/png',
            title: 'Pro 权益截图',
            url: '/assets/pro.png',
          },
        ],
        title: 'XXYY Pro 权益',
      },
      text: 'XXYY Pro 支持 Telegram 钱包监控。',
    });
  });

  it('allows superseded knowledge candidates for historical questions', async () => {
    const client = new FakePgClient();
    client.rows = [createKnowledgeRow({ tokens: ['以前', '钱包'] })];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    await store.retrieve('以前钱包监控支持多少地址？', { topK: 1 });

    expect(client.queries.at(-1)?.values[5]).toBe(true);
  });

  it('selects and pins governed anchor documents outside ordinary relevance candidates', async () => {
    const client = new FakePgClient();
    client.rows = [
      createKnowledgeRow({
        content: '钱包监控支持 Telegram 通知。',
        document_id: 'official_docs:wallet-monitor',
        id: 'official_docs:wallet-monitor:chunk:0001',
        tokens: ['钱包', '监控', 'telegram', '通知'],
      }),
      createKnowledgeRow({
        content: '经治理的当前产品能力目录。',
        document_id: 'official_docs:capability-overview',
        embedding_distance: 2,
        id: 'official_docs:capability-overview:chunk:0001',
        title: '当前功能目录',
        tokens: ['能力目录'],
      }),
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    const results = await store.retrieve('钱包监控 Telegram 通知', {
      policy: {
        anchorDocumentIds: ['official_docs:capability-overview'],
        diversity: 'balanced',
        preferredSourceTypes: ['official_docs'],
        temporalScope: 'current',
        version: '1',
      },
      topK: 1,
    });

    expect(client.queries.at(-1)?.sql).toContain('anchor_candidates');
    expect(client.queries.at(-1)?.values[11]).toEqual(['official_docs:capability-overview']);
    expect(results.map((chunk) => chunk.id)).toEqual([
      'official_docs:capability-overview:chunk:0001',
    ]);
  });

  it('filters API reference rows unless the question explicitly asks about the API', async () => {
    const client = new FakePgClient();
    client.rows = [
      createKnowledgeRow({
        id: 'official_docs:api:chunk:0001',
        module: 'XXYY API',
        source_url: 'https://docs.xxyy.io/xxyy-api-can-kao-wen-dang',
        title: 'XXYY API 参考文档',
        tokens: ['买入', '代币', 'api'],
      }),
      createKnowledgeRow({
        id: 'official_docs:swap:chunk:0001',
        module: '交易代币',
        title: 'Swap 交易',
        tokens: ['买入', '代币'],
      }),
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    const productResults = await store.retrieve('如何买入代币？', { topK: 2 });

    expect(client.queries.at(-1)?.values[6]).toBe(false);
    expect(productResults.map((result) => result.id)).toEqual(['official_docs:swap:chunk:0001']);

    client.rows = [
      createKnowledgeRow({
        id: 'official_docs:api:chunk:0001',
        module: 'XXYY API',
        source_url: 'https://docs.xxyy.io/xxyy-api-can-kao-wen-dang',
        title: 'XXYY API 参考文档',
        tokens: ['买入', '代币', 'api'],
      }),
    ];
    const apiResults = await store.retrieve('如何通过 API 买入代币？', { topK: 1 });

    expect(client.queries.at(-1)?.values[6]).toBe(true);
    expect(apiResults[0]?.id).toBe('official_docs:api:chunk:0001');

    client.rows = [
      createKnowledgeRow({
        id: 'official_docs:api:chunk:0001',
        module: 'XXYY API',
        source_url: 'https://docs.xxyy.io/xxyy-api-can-kao-wen-dang',
        title: 'XXYY API 参考文档',
        tokens: ['交易', 'api'],
      }),
      createKnowledgeRow({
        content: '2026 年 XXYY 开放交易 API，并将交易 API 封装为 Agent Skill。',
        document_id: 'x_updates:api-launch',
        id: 'x_updates:api-launch:chunk:0001',
        source_type: 'x_updates',
        source_url: 'https://x.com/useXXYYio/status/2029875008730976415',
        title: 'X Post 2029875008730976415',
        tokens: ['2026', '交易', 'api', 'agent', 'skill', '开放'],
      }),
    ];
    const historyResults = await store.retrieve('交易 API 和 Agent Skill 是什么时候开放的？', {
      topK: 2,
    });

    expect(client.queries.at(-1)?.values[5]).toBe(true);
    expect(client.queries.at(-1)?.values[6]).toBe(false);
    expect(historyResults.map((result) => result.id)).toEqual(['x_updates:api-launch:chunk:0001']);
  });

  it('filters external Agent Skill rows unless the question has developer scope', async () => {
    const client = new FakePgClient();
    const externalRow = createKnowledgeRow({
      content: 'Agent Skill 通过 GitHub 安装，并调用 XXYY API。',
      id: 'official_docs:external-skill:chunk:0001',
      module: 'Developer / Agent Skill',
      source_url: 'https://github.com/Jimmy-Holiday/xxyy-trade-skill/blob/abc/SKILL.md',
      title: 'XXYY Trade Skill',
      tokens: ['agent', 'skill', 'github', '交易'],
    });
    const productRow = createKnowledgeRow({
      content: '在产品页面选择钱包和金额，然后买入或卖出代币。',
      id: 'official_docs:swap:chunk:0001',
      module: '交易代币',
      title: 'Swap 交易',
      tokens: ['买入', '代币'],
    });
    client.rows = [externalRow, productRow];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    const productResults = await store.retrieve('如何买入代币？', { topK: 2 });

    expect(client.queries.at(-1)?.values[10]).toBe(false);
    expect(productResults.map((result) => result.id)).toEqual(['official_docs:swap:chunk:0001']);

    client.rows = [externalRow];
    const skillResults = await store.retrieve('Agent Skill 如何从 GitHub 安装？', { topK: 1 });

    expect(client.queries.at(-1)?.values[10]).toBe(true);
    expect(skillResults[0]).toMatchObject({
      id: 'official_docs:external-skill:chunk:0001',
      sourceBoost: 6.05,
    });
  });

  it('traces embedding and pgvector candidates without raw query, vectors, or content', async () => {
    const client = new FakePgClient();
    client.rows = [createKnowledgeRow({ id: 'chunk-current', tokens: ['xxyy', 'pro'] })];
    const { records, tracer } = createInMemoryQualityTracer();
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
      tracer,
    });

    await store.retrieve('XXYY Pro secret raw query', { topK: 1 });

    expect(records.map((record) => record.name)).toEqual([
      'rag.query_embedding',
      'rag.pgvector_candidates',
    ]);
    expect(records[0]).toMatchObject({
      inputs: { questionLength: 25 },
      outputs: { embeddingDimension: 1536 },
      runType: 'embedding',
    });
    expect(records[1]).toMatchObject({
      inputs: { topK: 1 },
      outputs: {
        chunks: [expect.objectContaining({ id: 'chunk-current', rank: 1, status: 'current' })],
      },
      runType: 'retriever',
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('secret raw query');
    expect(serialized).not.toContain('knowledge content');
    expect(serialized).not.toContain('[0.1');
  });

  it('drops nearest-neighbor rows without lexical or minimum vector relevance', async () => {
    const client = new FakePgClient();
    client.rows = [createKnowledgeRow({ embedding_distance: 2, tokens: ['xxyy'] })];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    await expect(store.retrieve('unrelated request', { topK: 1 })).resolves.toEqual([]);
  });

  it('keeps rows with lexical overlap even when vector relevance is below threshold', async () => {
    const client = new FakePgClient();
    client.rows = [createKnowledgeRow({ embedding_distance: 2, tokens: ['robinhood'] })];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    const results = await store.retrieve('robinhood', { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.lexicalScore).toBe(1);
  });

  it('keeps rows above the minimum vector relevance without lexical overlap', async () => {
    const client = new FakePgClient();
    client.rows = [createKnowledgeRow({ embedding_distance: 0.7, tokens: ['xxyy'] })];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    const results = await store.retrieve('unrelated request', { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.vectorScore).toBeCloseTo(0.3);
  });

  it('includes token-overlap candidates for short feature questions', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
        document_id: 'x_updates:xxyy-x-updates',
        embedding_distance: 0.9,
        file: 'docs/product-features/xxyy-x-updates.md',
        heading_path: ['2026 年 3 月至 4 月'],
        id: 'x_updates:xxyy-x-updates:chunk:0001',
        module: 'X Updates',
        order_index: null,
        retrieved_at: null,
        source_type: 'x_updates',
        source_url: null,
        title: 'XXYY X 历史推文产品更新汇总',
        tokens: ['跟单功能上线', '跟', '跟单', '单', '功能', '上线'],
      },
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]),
      },
    });

    const results = await store.retrieve('XXYY支持跟单么', { topK: 1 });

    const lastQuery = client.queries.at(-1);
    expect(lastQuery?.sql).toContain('tokens && $3::text[]');
    expect(lastQuery?.values[2]).toContain('跟单');
    expect(results[0]?.id).toBe('x_updates:xxyy-x-updates:chunk:0001');
    expect(results[0]?.lexicalScore).toBeGreaterThan(0);
  });

  it('expands product synonym query tokens before lexical candidate retrieval', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: 'XXYY Pro 可监控 2000 个钱包，并支持提醒频率。',
        document_id: 'official_docs:pro-limits',
        embedding_distance: 0.6,
        file: 'docs/product-features/pro.md',
        heading_path: ['XXYY Pro 权益'],
        id: 'official_docs:pro-limits:chunk:0001',
        module: 'XXYY Pro',
        order_index: null,
        retrieved_at: null,
        source_type: 'official_docs',
        source_url: null,
        title: 'XXYY Pro 权益',
        tokens: ['xxyy', 'pro', '监控', '钱包'],
      },
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]),
      },
    });

    const results = await store.retrieve('付费套餐能追踪多少地址？', { topK: 1 });

    const queryTokens = client.queries.at(-1)?.values[2];
    expect(queryTokens).toEqual(expect.arrayContaining(['pro', '监控', '钱包']));
    expect(results[0]).toMatchObject({
      id: 'official_docs:pro-limits:chunk:0001',
      lexicalScore: 3,
    });
  });

  it('prioritizes direct X post source rows for tweet-source questions', async () => {
    const client = new FakePgClient();
    client.rows = [
      {
        content: '钱包备注支持最多 1 万条（来源：2030954722350575916）。',
        document_id: 'x_updates:xxyy-x-updates',
        embedding_distance: 0.1,
        file: 'docs/product-features/xxyy-x-updates.md',
        heading_path: ['2026 年 3 月至 4 月'],
        id: 'x_updates:xxyy-x-updates:chunk:0013',
        module: 'X Updates',
        order_index: null,
        retrieved_at: null,
        source_type: 'x_updates',
        source_url: null,
        title: 'XXYY X 历史推文产品更新汇总',
        tokens: ['钱包', '备注', '支持', '最多', '1', '万条'],
      },
      {
        content: '钱包备注支持最多 1 万条，快速捕捉前排地址。',
        document_id: 'x_updates:sources/usexxyyio-x-posts/2030954722350575916',
        embedding_distance: 0.4,
        file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
        heading_path: ['X Post 2030954722350575916', 'Text'],
        id: 'x_updates:sources/usexxyyio-x-posts/2030954722350575916:chunk:0003',
        module: 'X / @useXXYYio / 2026-03',
        order_index: null,
        retrieved_at: null,
        source_type: 'x_updates',
        source_url: 'https://x.com/useXXYYio/status/2030954722350575916',
        title: 'X Post 2030954722350575916',
        tokens: ['钱包', '备注', '支持', '最多', '1', '万条'],
      },
    ];
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]),
      },
    });

    const results = await store.retrieve('钱包备注支持最多 1 万条是哪条推文？', { topK: 2 });

    expect(results[0]?.id).toBe(
      'x_updates:sources/usexxyyio-x-posts/2030954722350575916:chunk:0003',
    );
    expect(results[0]?.metadata.sourceUrl).toBe(
      'https://x.com/useXXYYio/status/2030954722350575916',
    );
    expect(results[0]?.sourceBoost).toBe(6);
  });

  it('wraps pgvector query failures as vector store unavailability', async () => {
    const store = createPgVectorStore({
      client: {
        query: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
      },
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1 })]),
      },
    });

    await expect(store.retrieve('XXYY Pro 支持什么？', { topK: 1 })).rejects.toBeInstanceOf(
      VectorStoreUnavailableError,
    );
  });

  it('rejects query embeddings with the wrong dimension', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: { embedTexts: () => Promise.resolve([[0.1, 0.2, 0.3]]) },
    });

    await expect(store.retrieve('XXYY Pro 支持什么？', { topK: 1 })).rejects.toThrow(
      'Expected embedding dimension 1536, got 3.',
    );
  });

  it('rejects query embeddings with non-finite values', async () => {
    const client = new FakePgClient();
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: Number.POSITIVE_INFINITY })]),
      },
    });

    await expect(store.retrieve('XXYY Pro 支持什么？', { topK: 1 })).rejects.toThrow(
      'Embedding contains a non-finite value.',
    );
  });

  it.each([0, -2])('normalizes invalid topK %s to the default', async (topK) => {
    const client = new FakePgClient();
    client.rows = Array.from({ length: 8 }, (_, index) => ({
      content: `XXYY Pro chunk ${index}`,
      document_id: 'official_docs:pro',
      embedding_distance: index / 100,
      file: 'docs/pro.md',
      heading_path: ['XXYY Pro 权益'],
      id: `official_docs:pro:chunk:${String(index + 1).padStart(4, '0')}`,
      module: 'XXYY Pro',
      order_index: null,
      retrieved_at: null,
      source_type: 'official_docs',
      source_url: null,
      title: 'XXYY Pro 权益',
      tokens: ['xxyy', 'pro'],
    }));
    const store = createPgVectorStore({
      client,
      embeddingProvider: {
        embedTexts: () => Promise.resolve([embedding1536({ 0: 0.1, 1: 0.2, 2: 0.3 })]),
      },
    });

    const results = await store.retrieve('XXYY Pro 支持什么？', { topK });

    expect(client.queries.at(-1)?.values[1]).toBe(24);
    expect(results).toHaveLength(6);
  });
});

type TestChunk = EmbeddedKnowledgeChunk & {
  metadata: EmbeddedKnowledgeChunk['metadata'] & {
    effectiveAt?: string;
    retrievedAt?: string;
    status?: 'current' | 'historical' | 'deprecated';
    supersedes?: string[];
  };
};

type TestChunkOverrides = Partial<Omit<TestChunk, 'metadata'>> & {
  metadata?: Partial<TestChunk['metadata']>;
};

function embedding1536(overrides: Record<number, number> = {}): number[] {
  const vector = Array.from({ length: 1536 }, () => 0);
  for (const [index, value] of Object.entries(overrides)) {
    vector[Number(index)] = value;
  }
  return vector;
}

function createChunk(overrides: TestChunkOverrides = {}): TestChunk {
  const { metadata: metadataOverrides, ...chunkOverrides } = overrides;

  return {
    contentHash: 'hash-1',
    documentId: 'official_docs:pro',
    embedding: embedding1536(),
    id: 'official_docs:pro:chunk:0001',
    metadata: {
      file: 'docs/pro.md',
      headingPath: ['XXYY Pro 权益'],
      module: 'XXYY Pro',
      sourceType: 'official_docs',
      title: 'XXYY Pro 权益',
      ...metadataOverrides,
    },
    searchableText: 'XXYY Pro 权益\nXXYY Pro 支持 Telegram 钱包监控。',
    text: 'XXYY Pro 支持 Telegram 钱包监控。',
    tokens: ['xxyy', 'pro', 'telegram'],
    ...chunkOverrides,
  };
}

function createKnowledgeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: 'XXYY product information.',
    document_id: 'official_docs:product',
    embedding_distance: 0.1,
    effective_at: '2026-03-16T11:12:30.350Z',
    file: 'docs/product.md',
    heading_path: ['XXYY Product'],
    id: 'official_docs:product:chunk:0001',
    module: 'XXYY Product',
    order_index: null,
    retrieved_at: null,
    source_type: 'official_docs',
    source_url: null,
    status: 'current',
    supersedes: [],
    title: 'XXYY Product',
    tokens: ['xxyy'],
    ...overrides,
  };
}

function createIngestionRunInput() {
  return {
    chunkCount: 2,
    contentHash: 'content-hash-1',
    documentCount: 1,
    runId: 'ingest_20260606T010203Z_abcd1234',
    source: 'cli',
    sourceCounts: { official_docs: 2 },
  };
}
