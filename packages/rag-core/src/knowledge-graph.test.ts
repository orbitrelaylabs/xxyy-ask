import { describe, expect, it, vi } from 'vitest';

import {
  createPgKnowledgeGraphStore,
  extractKnowledgeGraphRelations,
  migrateKnowledgeGraph,
  replaceChunkKnowledgeGraph,
} from './knowledge-graph.js';
import type { PgClientLike } from './pgvector-store.js';

describe('extractKnowledgeGraphRelations', () => {
  it('extracts evidence-bound product chain support facts', () => {
    const relations = extractKnowledgeGraphRelations({
      title: 'XXYY 当前支持的公链',
      text: '如果问题是“XXYY 整体产品目前支持哪些链”，现有官方资料明确覆盖 Solana、BSC、Ethereum、Base、Robinhood Chain 和 Stable Chain。',
    });
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object: expect.objectContaining({ canonicalName: 'Stable Chain' }),
          predicate: 'supports_chain',
          subject: expect.objectContaining({ canonicalName: 'XXYY' }),
        }),
      ]),
    );
  });

  it('extracts launchpad-to-chain relationships from ordered chain sections', () => {
    const relations = extractKnowledgeGraphRelations({
      title: 'XXYY 当前支持的发射平台',
      text: '按链整理如下：Solana：Pump、LetsBonk。BSC：Four.meme。Ethereum：Klik。Robinhood Chain：Noxa、Varo。',
    });
    expect(relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object: expect.objectContaining({ canonicalName: 'BSC' }),
          subject: expect.objectContaining({ canonicalName: 'Four.meme' }),
        }),
        expect.objectContaining({
          object: expect.objectContaining({ canonicalName: 'Robinhood Chain' }),
          subject: expect.objectContaining({ canonicalName: 'Varo' }),
        }),
      ]),
    );
  });

  it('requires feature and chain support evidence in the same scoped statement', () => {
    const unrelated = extractKnowledgeGraphRelations({
      title: '产品更新汇总',
      text: '扫链页面升级。Base 新增交易能力。钱包监控支持备注。',
    });
    const copyTrading = extractKnowledgeGraphRelations({
      title: '跟单',
      text: '跟单功能可实时镜像目标钱包。支持 5 大公链：SOL、BSC、Base、ETH、Robinhood。',
    });

    expect(unrelated).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object: expect.objectContaining({ canonicalName: 'Base' }),
          subject: expect.objectContaining({ canonicalName: '扫链' }),
        }),
      ]),
    );
    expect(copyTrading).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object: expect.objectContaining({ canonicalName: 'Robinhood Chain' }),
          subject: expect.objectContaining({ canonicalName: '跟单' }),
        }),
      ]),
    );
  });
});

describe('PostgreSQL knowledge graph', () => {
  it('migrates graph tables and indexes', async () => {
    const query = vi.fn<PgClientLike['query']>().mockResolvedValue({ rows: [] });
    await migrateKnowledgeGraph({ query: query as unknown as PgClientLike['query'] });
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).toContain('knowledge_graph_entities');
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).toContain('knowledge_graph_relations');
  });

  it('publishes extracted facts only through a stored knowledge chunk', async () => {
    const query = vi.fn<PgClientLike['query']>().mockResolvedValue({ rows: [] });
    await replaceChunkKnowledgeGraph({
      client: { query: query as unknown as PgClientLike['query'] },
      chunk: {
        documentId: 'x_updates:current-chains',
        id: 'x_updates:current-chains:chunk:0001',
        metadata: {
          sourceType: 'x_updates',
          status: 'current',
          title: 'XXYY 当前支持的公链',
        },
        text: 'XXYY 整体产品目前支持哪些链：Solana、BSC。',
      },
    });
    expect(query.mock.calls.map(([sql]) => sql).join('\n')).toContain(
      'insert into knowledge_graph_relations',
    );
  });

  it('lists and governs relations without accepting arbitrary status values', async () => {
    const query = vi
      .fn<PgClientLike['query']>()
      .mockResolvedValueOnce({ rows: [{ id: 'relation-1' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            confidence: 0.95,
            evidence: 'XXYY 支持 Solana',
            id: 'relation-1',
            object_name: 'Solana',
            object_type: 'chain',
            predicate: 'supports_chain',
            source_chunk_id: 'chunk-1',
            source_document_id: 'document-1',
            source_type: 'official_docs',
            source_url: null,
            status: 'rejected',
            subject_name: 'XXYY',
            subject_type: 'product',
            updated_at: '2026-08-01T00:00:00.000Z',
          },
        ],
      });
    const store = createPgKnowledgeGraphStore({
      client: { query: query as unknown as PgClientLike['query'] },
    });
    await expect(
      store.setRelationStatus({ id: 'relation-1', status: 'rejected' }),
    ).resolves.toMatchObject({
      id: 'relation-1',
      status: 'rejected',
    });
  });
});
