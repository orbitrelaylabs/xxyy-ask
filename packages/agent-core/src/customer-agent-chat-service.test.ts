import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import {
  createPublicTransactionClientStub,
  getTransactionOutputSchema,
  type GetTransactionOutput,
} from '@xxyy/transaction-skill-bridge';
import type { ProductSearchOutput } from '@xxyy/product-support-runtime';
import {
  createInMemoryQualityTracer,
  LlmConfigurationError,
  type AnswerProvider,
  type RetrievedChunk,
  type Retriever,
} from '@xxyy/rag-core';

import { createCustomerAgentChatService } from './customer-agent-chat-service.js';
import { createScriptedPlannerModel, type PlannerModel } from './planner-model.js';

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
const originalOpenAiModel = process.env.OPENAI_MODEL;

describe('createCustomerAgentChatService', () => {
  it('lets the planner route semantic self-description requests to the Agent tool', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';
    process.env.OPENAI_MODEL = 'env-model';
    let plannerTools: Array<{ name?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected planner JSON request body.');
        }
        const body = JSON.parse(init.body) as {
          messages?: Array<{ content?: string; role?: string }>;
        };
        const userMessage = body.messages?.find((message) => message.role === 'user');
        const plannerInput = JSON.parse(userMessage?.content ?? '{}') as {
          tools?: Array<{ name?: unknown }>;
        };
        plannerTools = plannerInput.tools ?? [];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      input: {},
                      kind: 'tool',
                      reason: 'The subject is the assistant itself.',
                      route: 'agent_answer',
                      toolName: 'describe_agent_capabilities',
                    }),
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }),
    );
    const service = createCustomerAgentChatService({
      answerProvider: {
        answer: () => Promise.reject(new Error('product answer should not be called')),
      },
      retriever: {
        retrieve: () => Promise.reject(new Error('product retrieval should not be called')),
      },
    });

    const response = await service.ask({
      channel: 'telegram',
      message: '如果把你当成客服助手，你的职责边界和可调用能力是什么？',
    });

    expect(plannerTools.map((tool) => tool.name)).toEqual([
      'describe_agent_capabilities',
      'search_product_docs',
    ]);
    expect(response).toMatchObject({
      agentRoute: 'agent_answer',
      citations: [],
      intent: 'agent_capabilities',
    });
  });

  afterEach(() => {
    restoreEnvValue('OPENAI_API_KEY', originalOpenAiApiKey);
    restoreEnvValue('OPENAI_BASE_URL', originalOpenAiBaseUrl);
    restoreEnvValue('OPENAI_MODEL', originalOpenAiModel);
    vi.unstubAllGlobals();
  });

  it('answers product questions through registered product tools', async () => {
    const retrieveCalls: Array<{ question: string; topK: number | undefined }> = [];
    const retriever: Retriever = {
      retrieve(question, options) {
        retrieveCalls.push({ question, topK: options.topK });
        return [createRetrievedChunk()];
      },
    };
    const answerProvider: AnswerProvider = {
      answer(input) {
        const response: ChatResponse = {
          answer: `agent answered with ${input.retrievedChunks.length} chunk`,
          citations: [
            {
              excerpt: input.retrievedChunks[0]?.text ?? '',
              file: input.retrievedChunks[0]?.metadata.file ?? '',
              title: input.retrievedChunks[0]?.metadata.title ?? '',
            },
          ],
          confidence: 0.82,
          intent: input.classification.intent,
        };
        return Promise.resolve(response);
      },
    };

    const service = createCustomerAgentChatService({
      answerProvider,
      config: { topK: 1 },
      planner: createScriptedPlannerModel([
        {
          input: { channel: 'web', question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'search_product_docs',
        },
      ]),
      retriever,
    });

    await expect(
      service.ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toMatchObject({
      answer: 'agent answered with 1 chunk',
      confidence: 0.82,
      intent: 'product_qa',
    });
    expect(retrieveCalls).toEqual([{ question: 'XXYY Pro 有哪些权益？', topK: 56 }]);
  });

  it('uses an injected product search runtime behind the Skill capability', async () => {
    const search = vi.fn((input: { query: string }, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(createProductSearchOutput(input.query));
    });
    const service = createCustomerAgentChatService({
      answerProvider: {
        answer(input) {
          return Promise.resolve({
            answer: `Skill-backed answer from ${input.retrievedChunks[0]?.id}`,
            citations: [],
            confidence: 0.8,
            intent: input.classification.intent,
          });
        },
      },
      planner: createScriptedPlannerModel([]),
      productCapabilityCaller: {
        channel: 'web',
        principal: 'anonymous',
      },
      productSearch: { searchProductDocs: search },
    });

    await expect(
      service.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？' }),
    ).resolves.toMatchObject({
      answer: 'Skill-backed answer from pro-benefits',
      agentRoute: 'product_answer',
    });
    expect(search).toHaveBeenCalledWith(
      {
        query: 'XXYY Pro 有哪些权益？',
        question: 'XXYY Pro 有哪些权益？',
        topK: 7,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('routes a public Explorer transaction through the browser Skill', async () => {
    const transaction = publicTransactionOutput();
    const service = createCustomerAgentChatService({
      answerProvider: {
        answer: () => Promise.reject(new Error('product answer should not be called')),
      },
      planner: createScriptedPlannerModel([]),
      publicChainCapabilityCaller: {
        channel: 'web',
        principal: 'anonymous',
      },
      publicTransactionClient: createPublicTransactionClientStub(async () => transaction),
      retriever: {
        retrieve: () => Promise.reject(new Error('product retrieval should not be called')),
      },
    });
    const explorerUrl = transaction.explorerUrl!;

    await expect(
      service.ask({
        channel: 'web',
        message: `查询这笔交易：${explorerUrl}`,
      }),
    ).resolves.toMatchObject({
      agentRoute: 'chain_answer',
      citations: [{ sourceUrl: explorerUrl }],
      confidence: 0.65,
      intent: 'onchain_transaction',
    });
    await expect(
      service.ask({
        channel: 'web',
        message: transaction.transactionId,
      }),
    ).resolves.toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'onchain_transaction',
    });
  });

  it('propagates one tracer through request, tool, and reranking layers', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const service = createCustomerAgentChatService({
      answerProvider: {
        answer(input) {
          return Promise.resolve({
            answer: 'XXYY Pro 权益。',
            citations: [],
            confidence: 0.8,
            intent: input.classification.intent,
          });
        },
      },
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
      retriever: {
        retrieve: () => [createRetrievedChunk()],
      },
      tracer,
    });

    await service.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？' });

    expect(records.map((record) => record.name)).toEqual([
      'chat.request',
      'agent.classify',
      'agent.guard',
      'agent.tool',
      'agent.capability',
      'rag.metadata_rerank',
      'agent.observe',
      'agent.answer_composer',
    ]);
    const root = records.find((record) => record.name === 'chat.request');
    const tool = records.find((record) => record.name === 'agent.tool');
    const rerank = records.find((record) => record.name === 'rag.metadata_rerank');
    const skillCapability = records.find(
      (record) => record.name === 'agent.capability' && record.metadata?.source === 'skill',
    );
    expect(skillCapability?.parentId).toBe(tool?.id);
    expect(rerank?.parentId).toBe(skillCapability?.id);
    expect(records.find((record) => record.name === 'agent.observe')).toMatchObject({
      outputs: { sufficient: true },
      parentId: root?.id,
    });
    expect(records.find((record) => record.name === 'agent.answer_composer')?.parentId).toBe(
      root?.id,
    );
  });

  it('pre-blocks boundary-like questions without touching planner or product retrieval', async () => {
    const retriever: Retriever = {
      retrieve() {
        throw new Error('retriever should not be called');
      },
    };
    const answerProvider: AnswerProvider = {
      answer() {
        throw new Error('answer provider should not be called');
      },
    };

    const service = createCustomerAgentChatService({
      answerProvider,
      planner: createScriptedPlannerModel([
        {
          kind: 'final',
          reason: 'The planner cannot access private account data.',
          response: {
            answer: '我无法直接查询你的钱包余额，但可以说明 XXYY 产品里的相关入口。',
            citations: [],
            confidence: 0.7,
            intent: 'realtime_account_query',
          },
          route: 'boundary',
        },
      ]),
      retriever,
    });

    const response = await service.ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
    expect(response.answer).toContain('我不能直接查询你的钱包余额');
  });

  it('keeps each request in scope while using bounded evidence follow-up queries', async () => {
    const retrieveCalls: string[] = [];
    const retriever: Retriever = {
      retrieve(question) {
        retrieveCalls.push(question);
        return [createRetrievedChunk()];
      },
    };
    const answerProvider: AnswerProvider = {
      answer(input) {
        return Promise.resolve({
          answer: `answered ${input.question}`,
          citations: [],
          confidence: 0.9,
          intent: input.classification.intent,
        });
      },
    };
    const service = createCustomerAgentChatService({
      answerProvider,
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'search_product_docs',
        },
        {
          input: { question: '怎么升级？' },
          kind: 'tool',
          reason: 'Use the current user message only.',
          route: 'product_answer',
          toolName: 'search_product_docs',
        },
      ]),
      retriever,
    });

    await service.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？', sessionId: 's1' });
    await service.ask({ channel: 'web', message: '怎么升级？', sessionId: 's1' });

    expect(retrieveCalls.at(-1)).toBe('怎么升级？ 官方文档 具体限制');

    await service.ask({
      channel: 'web',
      history: [
        { content: 'XXYY Pro 有哪些权益？', role: 'user' },
        { content: 'XXYY Pro 提供进阶会员权益。', role: 'assistant' },
      ],
      message: '那怎么升级？',
      sessionId: 's1',
    });

    expect(retrieveCalls.at(-1)).toBe('XXYY Pro 怎么升级');
  });

  it('requires LLM planner config for ambiguous requests', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;

    const service = createCustomerAgentChatService({
      answerProvider: {
        answer() {
          throw new Error('answer provider should not be called');
        },
      },
      config: { topK: 2 },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    await expect(
      service.ask({
        channel: 'web',
        message: '你好，可以介绍一下吗？',
      }),
    ).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('uses passed config values when creating the default planner', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';
    process.env.OPENAI_MODEL = 'env-model';
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: 'final',
                    reason: 'test planner response',
                    response: {
                      answer: '请补充更具体的问题。',
                      citations: [],
                      confidence: 0.45,
                      intent: 'unknown',
                    },
                    route: 'clarify',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const service = createCustomerAgentChatService({
      answerProvider: {
        answer() {
          throw new Error('answer provider should not be called');
        },
      },
      config: {
        openAiApiKey: 'config-key',
        openAiBaseUrl: 'https://config.example/v1',
        openAiModel: 'config-model',
      },
      retriever: {
        retrieve() {
          throw new Error('retriever should not be called');
        },
      },
    });

    await expect(
      service.ask({
        channel: 'web',
        message: '你好，可以介绍一下吗？',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'clarify',
      intent: 'unknown',
    });

    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('https://config.example/v1/chat/completions');
    const init = call?.[1];
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer config-key',
    });
    expect(typeof init?.body).toBe('string');
    const requestBody = JSON.parse(init?.body as string) as { model?: unknown };
    expect(requestBody.model).toBe('config-model');
  });

  it('routes deterministically classified support questions without an extra planner call', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';
    process.env.OPENAI_MODEL = 'env-model';
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    input: { question: '支持跟单么' },
                    kind: 'tool',
                    reason: 'The request concerns an XXYY product capability.',
                    route: 'product_answer',
                    toolName: 'search_product_docs',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const retrieve = vi.fn<Retriever['retrieve']>(() => [
      createRetrievedChunk({
        text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
      }),
    ]);
    const answer = vi.fn<AnswerProvider['answer']>((input) =>
      Promise.resolve({
        answer: `planner answered ${input.question} with ${input.retrievedChunks.length} chunks`,
        citations: [],
        confidence: 0.81,
        intent: input.classification.intent,
      }),
    );

    const service = createCustomerAgentChatService({
      answerProvider: { answer },
      config: { topK: 1 },
      retriever: { retrieve },
    });

    await expect(
      service.ask({
        channel: 'web',
        message: '支持跟单么',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'product_answer',
      answer: 'planner answered 支持跟单么 with 1 chunks',
      confidence: 0.81,
      intent: 'product_qa',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith(
      '支持跟单么',
      expect.objectContaining({
        policy: expect.objectContaining({
          preferredSourceTypes: ['admin_verified', 'official_docs', 'x_updates'],
          version: '1',
        }),
        topK: 48,
      }),
    );
    const answerInput = answer.mock.calls[0]?.[0];
    expect(answerInput).toBeDefined();
    expect(answerInput?.classification).toMatchObject({
      intent: 'product_qa',
      reason: 'asks whether a product capability is supported',
    });
  });

  it('uses one bounded follow-up search to cover a missing comparison facet before composing', async () => {
    const question = '请比较 XXYY Pro 权益和钱包管理上限';
    const retrieve = vi.fn<Retriever['retrieve']>((query) => {
      if (query === question) {
        return [
          createRetrievedChunk({
            documentId: 'pro',
            id: 'pro-benefits',
            metadata: {
              file: 'docs/product-features/pro.md',
              headingPath: ['XXYY Pro'],
              module: 'Pro',
              sourceType: 'official_docs',
              title: 'XXYY Pro 权益',
            },
            text: 'XXYY Pro 权益包括独享服务器和节点。',
          }),
          createRetrievedChunk({
            documentId: 'pro-extra',
            id: 'pro-extra-benefit',
            metadata: {
              file: 'docs/product-features/pro-extra.md',
              headingPath: ['XXYY Pro'],
              module: 'Pro',
              sourceType: 'official_docs',
              title: 'XXYY Pro 其他权益',
            },
            text: 'XXYY Pro 还提供更多地址监控额度。',
          }),
        ];
      }
      return [
        createRetrievedChunk({
          documentId: 'wallet',
          id: 'wallet-limit',
          metadata: {
            file: 'docs/product-features/wallet.md',
            headingPath: ['钱包管理'],
            module: '钱包管理',
            sourceType: 'official_docs',
            title: '钱包管理上限',
          },
          text: '钱包管理：每个用户每条链最多创建 100 个交易钱包。',
        }),
      ];
    });
    const plan = vi.fn<PlannerModel['plan']>((input) => {
      const summary = JSON.parse(input.stateSummary) as {
        observation?: { missingFacets?: string[]; suggestedQuery?: string };
        searchedQueries?: string[];
      };
      expect(summary.observation?.missingFacets).toEqual(['钱包管理上限']);
      expect(summary.observation?.suggestedQuery).toBe('XXYY 钱包管理上限');
      expect(summary.searchedQueries).toEqual([question]);
      return Promise.resolve({
        input: { query: 'XXYY 钱包管理上限' },
        kind: 'tool',
        reason: 'Search the missing wallet-management facet.',
        route: 'product_answer',
        toolName: 'search_product_docs',
      });
    });
    const planner: PlannerModel = { plan };
    const answer = vi.fn<AnswerProvider['answer']>((input) =>
      Promise.resolve({
        answer: `combined ${input.retrievedChunks.map((chunk) => chunk.id).join(',')}`,
        citations: input.retrievedChunks.map((chunk) => ({
          excerpt: chunk.text,
          file: chunk.metadata.file,
          title: chunk.metadata.title,
        })),
        confidence: 0.84,
        intent: input.classification.intent,
      }),
    );

    const response = await createCustomerAgentChatService({
      answerProvider: { answer },
      config: { topK: 2 },
      planner,
      retriever: { retrieve },
    }).ask({ channel: 'web', message: question });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      answer: 'combined pro-benefits,wallet-limit,pro-extra-benefit',
      intent: 'product_qa',
    });
    expect(retrieve.mock.calls.map(([query]) => query)).toEqual([question, 'XXYY 钱包管理上限']);
    expect(plan).toHaveBeenCalledOnce();
    expect(answer).toHaveBeenCalledOnce();
    expect(answer.mock.calls[0]?.[0].question).toBe(question);
  });

  it('stops when a rewritten query returns the same evidence without calling the composer', async () => {
    const question = '请比较 XXYY Pro 权益和钱包管理上限';
    const retrieve = vi.fn<Retriever['retrieve']>(() => [
      createRetrievedChunk({
        documentId: 'pro',
        id: 'pro-benefits',
        metadata: {
          file: 'docs/product-features/pro.md',
          headingPath: ['XXYY Pro'],
          module: 'Pro',
          sourceType: 'official_docs',
          title: 'XXYY Pro 权益',
        },
        text: 'XXYY Pro 权益包括独享服务器和节点。',
      }),
    ]);
    const answer = vi.fn<AnswerProvider['answer']>();
    const planner: PlannerModel = {
      plan: vi.fn<PlannerModel['plan']>(() =>
        Promise.resolve({
          input: { query: 'XXYY 钱包管理上限' },
          kind: 'tool',
          reason: 'Search the missing wallet-management facet.',
          route: 'product_answer',
          toolName: 'search_product_docs',
        }),
      ),
    };

    const response = await createCustomerAgentChatService({
      answerProvider: { answer },
      config: { topK: 1 },
      planner,
      retriever: { retrieve },
    }).ask({ channel: 'web', message: question });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
    expect(response.answer).toContain('钱包管理上限');
    expect(response.answer).toContain('没有找到新的知识库证据');
    expect(response.citations).toHaveLength(1);
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(answer).not.toHaveBeenCalled();
  });

  it('streams a normal product answer through search and the answer composer', async () => {
    const answer = vi.fn<AnswerProvider['answer']>();
    const stream = vi.fn<NonNullable<AnswerProvider['stream']>>(async function* (input) {
      const chunkId = await Promise.resolve(input.retrievedChunks[0]?.id);
      yield { type: 'answer_delta', delta: `streamed ${chunkId}` };
      yield {
        type: 'metadata',
        citations: [],
        confidence: 0.8,
        intent: input.classification.intent,
      };
    });
    const retrieve = vi.fn<Retriever['retrieve']>(() => [createRetrievedChunk()]);
    const events: ChatStreamEvent[] = [];

    for await (const event of createCustomerAgentChatService({
      answerProvider: { answer, stream },
      planner: createScriptedPlannerModel([]),
      retriever: { retrieve },
    }).stream({ channel: 'web', message: 'XXYY Pro 有哪些权益？' })) {
      events.push(event);
    }

    expect(events.slice(0, 3)).toEqual([
      { type: 'status', phase: 'planning', message: '正在分析问题…' },
      { type: 'status', phase: 'retrieving', message: '正在检索知识库…' },
      { type: 'status', phase: 'answering', message: '正在生成回答…' },
    ]);
    expect(events[3]).toEqual({ type: 'answer_delta', delta: 'streamed pro-benefits' });
    expect(events[4]).toMatchObject({
      agentRoute: 'product_answer',
      type: 'metadata',
    });
    expect(retrieve).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(answer).not.toHaveBeenCalled();
  });

  it('falls back to retrieved evidence when the answer composer fails unexpectedly', async () => {
    const service = createCustomerAgentChatService({
      answerProvider: {
        answer: () => Promise.reject(new Error('unexpected composer failure')),
      },
      planner: createScriptedPlannerModel([]),
      retriever: { retrieve: () => [createRetrievedChunk()] },
    });

    await expect(
      service.ask({ channel: 'web', message: 'XXYY Pro 有哪些权益？' }),
    ).resolves.toMatchObject({
      agentRoute: 'product_answer',
      answer: expect.stringContaining('XXYY Pro 提供更多权益'),
      citations: [
        expect.objectContaining({
          file: 'docs/product-features/pro.md',
        }),
      ],
      intent: 'product_qa',
    });
  });

  it('replaces partial provider deltas with retrieved evidence when streaming fails', async () => {
    const stream = vi.fn<NonNullable<AnswerProvider['stream']>>(async function* () {
      yield { type: 'answer_delta', delta: 'unsupported partial provider output' };
      await Promise.resolve();
      throw new Error('stream composer failed');
    });
    const events: ChatStreamEvent[] = [];

    for await (const event of createCustomerAgentChatService({
      answerProvider: {
        answer: () => Promise.reject(new Error('non-stream answer should not be called')),
        stream,
      },
      planner: createScriptedPlannerModel([]),
      retriever: { retrieve: () => [createRetrievedChunk()] },
    }).stream({ channel: 'web', message: 'XXYY Pro 有哪些权益？' })) {
      events.push(event);
    }

    const answer = events
      .filter(
        (event): event is Extract<ChatStreamEvent, { type: 'answer_delta' }> =>
          event.type === 'answer_delta',
      )
      .map((event) => event.delta)
      .join('');
    expect(answer).not.toContain('unsupported partial provider output');
    expect(answer).toContain('XXYY Pro 提供更多权益');
    expect(events.at(-1)).toMatchObject({
      agentRoute: 'product_answer',
      citations: [expect.objectContaining({ file: 'docs/product-features/pro.md' })],
      type: 'metadata',
    });
  });
});

function createRetrievedChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  const base: RetrievedChunk = {
    documentId: 'pro',
    embedding: [],
    id: 'pro-benefits',
    lexicalScore: 1,
    metadata: {
      file: 'docs/product-features/pro.md',
      headingPath: ['XXYY Pro'],
      module: 'Pro',
      sourceType: 'official_docs',
      title: 'XXYY Pro 权益',
    },
    rank: 1,
    score: 1,
    sourceBoost: 0.05,
    text: 'XXYY Pro 提供更多权益。',
    tokens: [],
    vectorScore: 0,
  };

  return {
    ...base,
    ...overrides,
    metadata: {
      ...base.metadata,
      ...overrides.metadata,
    },
  };
}

function createProductSearchOutput(query: string): ProductSearchOutput {
  const chunk = createRetrievedChunk();
  return {
    chunks: [
      {
        documentId: chunk.documentId,
        id: chunk.id,
        lexicalScore: chunk.lexicalScore,
        metadata: chunk.metadata,
        rank: chunk.rank,
        score: chunk.score,
        sourceBoost: chunk.sourceBoost,
        text: `${chunk.text} ${query}`,
        vectorScore: chunk.vectorScore,
      },
    ],
    citations: [
      {
        excerpt: chunk.text,
        file: chunk.metadata.file,
        title: chunk.metadata.title,
      },
    ],
    confidence: chunk.score,
  };
}

function publicTransactionOutput(): GetTransactionOutput {
  const hash = `0x${'1'.repeat(64)}`;
  return getTransactionOutputSchema.parse({
    analysis: {
      assetChanges: [],
      conflicts: [],
      diagnostics: [],
      evidence: [],
      findings: [],
      skill: 'transaction_analysis',
      status: 'partial',
      summary: 'Browser evidence.',
      timeline: [],
      tokenTransfers: [],
      transaction: {
        blockNumber: '1',
        blockTimestamp: '1',
        chainId: '56',
        executionStatus: 'success',
        feeWei: '1',
        from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hash,
        inputKind: 'contract_call',
        to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        valueWei: '0',
      },
      version: '1.0.0',
      warnings: [],
    },
    chainId: '56',
    diagnostics: [],
    explorerUrl: `https://bscscan.com/tx/${hash}`,
    family: 'evm',
    network: 'eip155:56',
    status: 'partial',
    summary: 'Browser evidence.',
    transactionId: hash,
  });
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
