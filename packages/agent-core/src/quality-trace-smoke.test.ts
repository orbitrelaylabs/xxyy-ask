import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryQualityTracer,
  createOpenAiAnswerProvider,
  createPgVectorStore,
  type PgClientLike,
} from '@xxyy/rag-core';

import { createCustomerAgentChatService } from './customer-agent-chat-service.js';
import { createScriptedPlannerModel } from './planner-model.js';

describe('quality trace end-to-end smoke', () => {
  it('captures the full product path while a boundary request stops before dependencies', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const embedding = vi.fn(() => Promise.resolve([[0.1, 0.2, 0.3]]));
    const database = createFakePgClient();
    const llm = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'XXYY Pro 提供独享服务器和节点。' } }],
            usage: { total_tokens: 42 },
          }),
          { headers: { 'Content-Type': 'application/json' }, status: 200 },
        ),
      ),
    );
    const retriever = createPgVectorStore({
      client: database,
      embeddingDimension: 3,
      embeddingProvider: { embedTexts: embedding },
      tracer,
    });
    const service = createCustomerAgentChatService({
      answerProvider: createOpenAiAnswerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1',
        fetchImpl: llm,
        model: 'test-model',
        tracer,
      }),
      config: { topK: 1 },
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product knowledge.',
          route: 'product_answer',
          toolName: 'search_product_docs',
        },
      ]),
      retriever,
      tracer,
    });

    const product = await service.ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      requestId: 'smoke-product',
    });

    expect(product.answer).toContain('独享服务器和节点');
    expect(records.map((record) => record.name)).toEqual([
      'chat.request',
      'agent.classify',
      'agent.guard',
      'agent.tool',
      'agent.capability',
      'agent.capability',
      'rag.query_embedding',
      'rag.pgvector_candidates',
      'rag.metadata_rerank',
      'agent.observe',
      'agent.answer_composer',
      'rag.grounding_selection',
      'rag.fact_extraction',
      'llm.answer',
      'rag.claim_grounding',
    ]);
    const productRoot = records[0];
    const tool = records.find((record) => record.name === 'agent.tool');
    const skillCapability = records.find(
      (record) => record.name === 'agent.capability' && record.metadata?.source === 'skill',
    );
    const mcpCapability = records.find(
      (record) => record.name === 'agent.capability' && record.metadata?.source === 'mcp',
    );
    expect(tool?.parentId).toBe(productRoot?.id);
    expect(skillCapability?.parentId).toBe(tool?.id);
    expect(mcpCapability?.parentId).toBe(skillCapability?.id);
    for (const dependency of records.filter((record) =>
      ['rag.query_embedding', 'rag.pgvector_candidates', 'rag.metadata_rerank'].includes(
        record.name,
      ),
    )) {
      expect(dependency.parentId).toBe(mcpCapability?.id);
    }
    const observe = records.find((record) => record.name === 'agent.observe');
    const composer = records.find((record) => record.name === 'agent.answer_composer');
    expect(observe).toMatchObject({
      outputs: { shouldContinue: false, sufficient: true },
      parentId: productRoot?.id,
    });
    expect(composer?.parentId).toBe(productRoot?.id);
    expect(records.find((record) => record.name === 'rag.grounding_selection')?.parentId).toBe(
      composer?.id,
    );
    const answer = records.find((record) => record.name === 'llm.answer');
    expect(answer?.parentId).toBe(composer?.id);
    expect(records.find((record) => record.name === 'rag.claim_grounding')).toMatchObject({
      outputs: { grounded: true, unsupportedClaimCount: 0 },
      parentId: answer?.id,
    });
    expect(embedding).toHaveBeenCalledTimes(1);
    expect(database.queryCount).toBe(1);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(records)).not.toContain('raw private chunk content');

    const beforeBoundary = records.length;
    const boundary = await service.ask({
      channel: 'web',
      message: '帮我查一下钱包余额',
      requestId: 'smoke-boundary',
    });
    const boundaryRecords = records.slice(beforeBoundary);

    expect(boundary.agentRoute).toBe('boundary');
    expect(boundaryRecords.map((record) => record.name)).toEqual([
      'chat.request',
      'agent.classify',
      'agent.guard',
    ]);
    expect(embedding).toHaveBeenCalledTimes(1);
    expect(database.queryCount).toBe(1);
    expect(llm).toHaveBeenCalledTimes(1);
  });
});

function createFakePgClient(): PgClientLike & { queryCount: number } {
  return new (class implements PgClientLike {
    queryCount = 0;

    query<T>(): Promise<{ rows: T[] }> {
      this.queryCount += 1;
      return Promise.resolve({
        rows: [
          {
            content: 'raw private chunk content：XXYY Pro 提供独享服务器和节点。',
            document_id: 'official_docs:pro',
            effective_at: '2026-07-11T00:00:00.000Z',
            embedding_distance: 0.1,
            file: 'docs/product-features/pro.md',
            heading_path: ['XXYY Pro 权益'],
            id: 'official_docs:pro:chunk:0001',
            module: 'XXYY Pro',
            order_index: null,
            retrieved_at: null,
            source_type: 'official_docs',
            source_url: null,
            status: 'current',
            supersedes: [],
            title: 'XXYY Pro 权益',
            tokens: ['xxyy', 'pro', '权益'],
          } as unknown as T,
        ],
      });
    }
  })();
}
