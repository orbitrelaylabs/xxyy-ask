import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ChatResponse, ChatStreamEvent } from '@xxyy/shared';
import { createInMemoryQualityTracer, LlmConfigurationError } from '@xxyy/rag-core';

import { createLangGraphCustomerRuntime } from './langgraph-customer-runtime.js';
import {
  PlannerModelParseError,
  PlannerModelRequestError,
  createScriptedPlannerModel,
} from './planner-model.js';
import { createToolRegistry } from './tool-registry.js';
import { createAgentTools } from './tools/agent-tools.js';

describe('createLangGraphCustomerRuntime', () => {
  it('answers product questions through the planner-selected product tool', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY Pro 提供更高监控上限。',
      citations: [
        {
          excerpt: 'XXYY Pro 提供更高监控上限。',
          file: 'docs/product-features/pro.md',
          title: 'XXYY Pro',
        },
      ],
      confidence: 0.82,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute,
    });

    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    });

    await expect(
      runtime.ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        requestId: 'req-runtime-1',
        sessionId: 'session-1',
        userId: 'user-1',
      }),
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
    expect(execute).toHaveBeenCalledWith(
      { question: 'XXYY Pro 有哪些权益？' },
      {
        channel: 'web',
        requestId: 'req-runtime-1',
        sessionId: 'session-1',
        userIdPresent: true,
      },
    );
  });

  it('uses the original user message for planner-selected product question tools', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY 支持跟单功能。',
      citations: [],
      confidence: 0.82,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute,
    });

    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'Does XXYY support generic Copy Trading?' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    });

    await expect(
      runtime.ask({
        channel: 'telegram',
        message: 'xxyy支持跟单么',
      }),
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
    expect(execute).toHaveBeenCalledWith(
      { question: 'xxyy支持跟单么' },
      { channel: 'telegram', sessionId: undefined, userIdPresent: false },
    );
  });

  it('routes deterministic product questions before an incorrect planner clarification', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'P1/P2/P3 是交易设置档位，可为买卖/挂单配置不同 gas 与滑点。',
      citations: [
        {
          excerpt: '交易设置多档位切换 P1 P2 P3，买卖/挂单支持不同gas与滑点。',
          file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
          sourceUrl: 'https://x.com/useXXYYio/status/2026285686907883612',
          title: 'X Post 2026285686907883612',
        },
      ],
      confidence: 0.82,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute,
    });

    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          kind: 'final',
          reason: 'Planner incorrectly declined a product feature question.',
          response: {
            answer: '当前无法回答该交易设置问题。',
            citations: [],
            confidence: 0.3,
            intent: 'unknown',
          },
          route: 'clarify',
        },
      ]),
      registry,
    });

    await expect(
      runtime.ask({
        channel: 'web',
        message: 'P1/P2/P3 是什么交易设置？',
      }),
    ).resolves.toEqual({ ...response, agentRoute: 'product_answer' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('clarifies instead of guessing a tool when planner parsing repeatedly fails', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY 支持跟单功能。',
      citations: [
        {
          excerpt: 'XXYY 跟单支持 SOL 和 BSC。',
          file: 'docs/product-features/xxyy-x-updates.md',
          title: '跟单支持链',
        },
      ],
      confidence: 0.82,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));
    const planner = {
      plan: vi.fn(() => Promise.reject(new PlannerModelParseError('invalid planner JSON'))),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute,
    });

    await expect(
      createLangGraphCustomerRuntime({ planner, registry }).ask({
        channel: 'web',
        message: '你好，可以介绍一下吗？',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'unknown',
    });
    expect(planner.plan).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns boundary answers before planner execution for obvious private lookup requests', async () => {
    const registry = createToolRegistry();
    const planner = {
      plan: vi.fn(() => Promise.reject(new LlmConfigurationError('planner unavailable'))),
    };

    const response = await createLangGraphCustomerRuntime({
      planner,
      registry,
    }).ask({
      channel: 'web',
      message: '帮我查一下我的钱包余额',
    });

    expect(response).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
    expect(response.answer).toContain('我不能直接查询你的钱包余额');
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('answers explicit agent capability questions deterministically', async () => {
    const registry = createToolRegistry();
    for (const tool of createAgentTools()) {
      registry.register(tool);
    }
    const planner = createScriptedPlannerModel([
      {
        input: {},
        kind: 'tool',
        reason: 'The user asks about the Agent itself.',
        route: 'agent_answer',
        toolName: 'describe_agent_capabilities',
      },
    ]);

    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'telegram',
      message: '你支持哪些功能？',
    });

    expect(response).toMatchObject({
      agentRoute: 'agent_answer',
      citations: [],
      intent: 'agent_capabilities',
    });
    expect(response.answer).toContain('我是 XXYY 产品客服 Agent');
  });

  it('rewrites broad product capability overviews before the first search', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createToolRegistry({ tracer });
    const execute = vi.fn(() =>
      Promise.resolve({
        chunks: [
          { id: 'official-trading', text: 'XXYY 支持交易和钱包功能。' },
          { id: 'official-monitoring', text: '支持钱包监控和移动端登录。' },
        ],
        citations: [
          {
            excerpt: 'XXYY 支持交易和钱包功能。',
            file: 'docs/product-features/pages/trading.md',
            sourceType: 'official_docs' as const,
            title: '交易代币',
          },
          {
            excerpt: '支持钱包监控和移动端登录。',
            file: 'docs/product-features/pages/monitoring.md',
            sourceType: 'official_docs' as const,
            title: '监控管理',
          },
        ],
        confidence: 0.88,
      }),
    );

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            sourceType: z.literal('official_docs'),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: {
        plan: vi.fn(() => Promise.reject(new Error('planner should not run'))),
      },
      registry,
      tracer,
    }).ask({
      channel: 'telegram',
      message: '支持哪些功能',
    });

    expect(execute).toHaveBeenCalledWith(
      {
        query: 'XXYY 当前支持的产品功能总览 交易 钱包监控 数据分析 移动端',
      },
      { channel: 'telegram', sessionId: undefined, userIdPresent: false },
    );
    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
    expect(records.find((record) => record.name === 'agent.classify')?.outputs).toMatchObject({
      fineGrainedIntent: 'capability_overview',
      subject: 'xxyy_product',
      temporalScope: 'current',
    });
    expect(records.find((record) => record.name === 'agent.observe')?.outputs).toMatchObject({
      authoritativeCitationCount: 2,
      questionKind: 'capability_overview',
      sufficient: true,
      xCitationCount: 0,
    });
  });

  it('uses the bounded query plan to search only missing overview facets', async () => {
    const registry = createToolRegistry();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [{ id: 'official-trading', text: 'XXYY 支持交易和数据分析。' }],
        citations: [
          {
            excerpt: 'XXYY 支持交易和数据分析。',
            file: 'docs/product-features/pages/trading.md',
            sourceType: 'official_docs' as const,
            title: '交易与数据分析',
          },
        ],
        confidence: 0.75,
      })
      .mockResolvedValueOnce({
        chunks: [{ id: 'official-wallet', text: 'XXYY 支持钱包、钱包监控和移动端。' }],
        citations: [
          {
            excerpt: 'XXYY 支持钱包、钱包监控和移动端。',
            file: 'docs/product-features/pages/wallet.md',
            sourceType: 'official_docs' as const,
            title: '钱包与监控',
          },
        ],
        confidence: 0.82,
      });

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            sourceType: z.literal('official_docs'),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: {
        plan: vi.fn(() => Promise.reject(new Error('planner should not run'))),
      },
      registry,
    }).ask({
      channel: 'telegram',
      message: '支持哪些功能',
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toEqual({
      query: 'XXYY 当前钱包管理 钱包监控 Telegram 通知 移动端支持功能 官方文档',
    });
    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
  });

  it('decomposes a compound product question and answers every subquestion from separate evidence', async () => {
    const registry = createToolRegistry();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(searchOutput('pro-rights', 'XXYY Pro 权益包括独享节点。'))
      .mockResolvedValueOnce(
        searchOutput('pro-upgrade', '进入会员页面，点击升级 XXYY Pro，并通过交易获得积分。'),
      )
      .mockResolvedValueOnce(searchOutput('pro-permanent', 'XXYY 永久 Pro 权益长期有效。'));

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string(), topK: z.number().int().min(1).max(12) }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            sourceType: z.literal('official_docs'),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const planner = { plan: vi.fn(() => Promise.reject(new Error('planner should not run'))) };
    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'web',
      message: 'XXYY Pro 有什么权益，怎么升级，升级后是否永久有效？',
    });

    expect(execute.mock.calls.map(([input]) => input)).toEqual([
      { query: 'XXYY Pro 有什么权益', topK: 6 },
      { query: 'XXYY Pro 怎么升级', topK: 8 },
      { query: 'XXYY Pro 升级后是否永久有效', topK: 6 },
    ]);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      answerStatus: 'complete',
      intent: 'how_to',
    });
    expect(response.answer).toContain('1. XXYY Pro 权益');
    expect(response.answer).toContain('2. XXYY Pro 升级');
    expect(response.answer).toContain('3. XXYY Pro 永久有效');
  });

  it('fails closed when current numeric evidence conflicts in the same scope', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createToolRegistry({ tracer });
    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.unknown()),
        citations: z.array(z.unknown()),
        confidence: z.number(),
      }),
      execute: () =>
        Promise.resolve({
          chunks: [
            conflictChunk('monitor-2000', 'XXYY Pro 当前最多可以监控 2000 个钱包。'),
            conflictChunk('monitor-3000', 'XXYY Pro 当前最多可以监控 3000 个钱包。'),
          ],
          citations: [
            {
              excerpt: 'XXYY Pro 当前最多可以监控 2000 个钱包。',
              file: 'docs/monitor-2000.md',
              sourceType: 'official_docs',
              title: 'Pro 钱包监控上限',
            },
            {
              excerpt: 'XXYY Pro 当前最多可以监控 3000 个钱包。',
              file: 'docs/monitor-3000.md',
              sourceType: 'official_docs',
              title: 'Pro 钱包监控上限',
            },
          ],
          confidence: 0.8,
        }),
    });

    const response = await createLangGraphCustomerRuntime({
      maxSteps: 1,
      planner: {
        plan: vi.fn(() => Promise.reject(new Error('planner should not run'))),
      },
      registry,
      tracer,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 钱包监控最多支持多少个钱包？',
    });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      answerStatus: 'conflict',
      confidence: 0.2,
      intent: 'product_qa',
    });
    expect(response.answer).toContain('2000、3000');
    expect(response.answer).toContain('无法可靠给出唯一结论');
    expect(records.find((record) => record.name === 'agent.observe')?.outputs).toMatchObject({
      conflictCount: 1,
      nextAction: 'partial_answer',
      sufficient: false,
    });
  });

  it('does not block product capability questions that mention wallet balances', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY 产品界面提供钱包相关入口说明。',
      citations: [],
      confidence: 0.82,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({
        question: z.string(),
      }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute,
    });

    await expect(
      createLangGraphCustomerRuntime({
        planner: createScriptedPlannerModel([
          {
            input: { question: 'XXYY 支持查看钱包余额吗？' },
            kind: 'tool',
            reason: 'Use product docs.',
            route: 'product_answer',
            toolName: 'answer_product_question',
          },
        ]),
        registry,
      }).ask({
        channel: 'web',
        message: 'XXYY 支持查看钱包余额吗？',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
    expect(execute).toHaveBeenCalled();
  });

  it('pre-blocks realtime account requests instead of asking the planner', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool should not be called');
    });
    const planner = {
      plan: vi.fn(() =>
        Promise.resolve({
          kind: 'final' as const,
          reason: 'The agent cannot access private wallet balances.',
          response: {
            answer: '我无法直接查询你的私有钱包余额，但可以说明 XXYY 支持哪些公开功能。',
            citations: [],
            confidence: 0.72,
            intent: 'realtime_account_query' as const,
          },
          route: 'boundary' as const,
        }),
      ),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'cli',
      message: '帮我查一下钱包余额',
    });

    expect(response).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'realtime_account_query',
    });
    expect(response.answer).toContain('我不能直接查询你的钱包余额');
    expect(planner.plan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['unsafe attack request', 'How to hack XXYY account?', '不能帮助攻击'],
    ['business action request', '帮我取消订单并退款', '不能代你开通、取消、修改'],
    ['private credential request', '我的私钥是 test-secret-key', '发送私钥'],
  ])('pre-blocks %s instead of asking the planner', async (_name, message, expectedText) => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool should not be called');
    });
    const planner = {
      plan: vi.fn(() =>
        Promise.resolve({
          kind: 'final' as const,
          reason: 'The planner chose a final support boundary response.',
          response: {
            answer: expectedText,
            citations: [],
            confidence: 0.64,
            intent: 'unknown' as const,
          },
          route: 'boundary' as const,
        }),
      ),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
      channel: 'web',
      message,
    });

    expect(response).toMatchObject({
      agentRoute: 'boundary',
      citations: [],
      intent: 'unknown',
    });
    expect(response.answer).toContain(expectedText);
    expect(planner.plan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    '这个 tx hash 是不是被夹了，有 MEV sandwich 吗？',
    '帮我查这个池子有没有夹子',
    '分析一下这笔链上交易',
  ])(
    'pre-blocks unsupported transaction analysis before planner execution: %s',
    async (message) => {
      const registry = createToolRegistry();
      const execute = vi.fn(() => {
        throw new Error('tool should not be called');
      });
      const planner = {
        plan: vi.fn(() =>
          Promise.resolve({
            kind: 'final' as const,
            reason: 'Planner-authored boundary.',
            response: {
              answer: 'planner response',
              citations: [],
              confidence: 0.5,
              intent: 'unknown' as const,
            },
            route: 'boundary' as const,
          }),
        ),
      };

      registry.register({
        name: 'answer_product_question',
        description: 'Answer a product question.',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute,
      });

      const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
        channel: 'web',
        message,
      });

      expect(response).toMatchObject({
        agentRoute: 'boundary',
        citations: [],
        intent: 'unknown',
      });
      expect(response.answer).toContain('公开 EVM 交易');
      expect(response.answer).toContain('trace Provider');
      expect(planner.plan).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('clarifies when a public transaction reference is supplied without the chain Tool', async () => {
    const planner = {
      plan: vi.fn(() => {
        throw new Error('planner should not be called');
      }),
    };

    const response = await createLangGraphCustomerRuntime({
      planner,
      registry: createToolRegistry(),
    }).ask({
      channel: 'web',
      message: '分析 https://solscan.io/tx/abc',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'onchain_transaction',
    });
    expect(response.answer).toContain('ONCHAIN_RPC_CONFIG_JSON');
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('returns clarification when the planner requests an unauthorized tool', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool should not be called');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: {},
          kind: 'tool',
          reason: 'Invalid tool request.',
          route: 'product_answer',
          toolName: 'delete_user_account' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: '你好，可以介绍一下吗？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns clarification when an allowed planner tool is not registered', async () => {
    const registry = createToolRegistry();

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product knowledge.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'unknown',
    });
  });

  it('composes a product answer from planner-selected search evidence', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() =>
      Promise.resolve({
        chunks: [
          {
            id: 'chunk-1',
            text: 'XXYY 跟单支持 SOL 和 BSC。',
          },
        ],
        citations: [
          {
            excerpt: 'XXYY 跟单支持 SOL 和 BSC。',
            file: 'docs/product-features/xxyy-x-updates.md',
            title: '跟单支持链',
          },
        ],
        confidence: 12,
      }),
    );

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: 'XXYY 跟单 支持 哪些链' },
          kind: 'tool',
          reason: 'Search product docs first.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY 跟单支持哪些链？',
    });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      citations: [
        {
          excerpt: 'XXYY 跟单支持 SOL 和 BSC。',
          file: 'docs/product-features/xxyy-x-updates.md',
          title: '跟单支持链',
        },
      ],
      intent: 'product_qa',
    });
    expect(response.answer).toContain('XXYY 跟单支持 SOL 和 BSC');
    expect(execute).toHaveBeenCalledWith(
      { query: 'XXYY 跟单支持哪些链？' },
      { channel: 'web', userIdPresent: false },
    );
  });

  it('composes concise support answers from planner-selected search evidence', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() =>
      Promise.resolve({
        chunks: [
          {
            id: 'copy-trading-summary',
            text: '- FourMeme Agentic 模式支持：在 XXYY 完成 BSC 代币交易后可自动 mint Agent NFT。 - 跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链，可查看地址利润和胜率，自定义跟单金额、卖出比例、gas、滑点和过滤条件。 - 开放交易 API。',
          },
          {
            id: 'copy-trading-post',
            text: '🔗支持6大公链，#SOL #BSC #Base #ETH #XLayer #Plasma 📈输入地址即可查看利润、胜率数据，判断是否值得跟单 ⚙️自定义跟单金额、卖出比例、gas/滑点/交易设置，速度更快',
          },
        ],
        citations: [
          {
            excerpt:
              '- FourMeme Agentic 模式支持：在 XXYY 完成 BSC 代币交易后可自动 mint Agent NFT。 - 跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链，可查看地址利润和胜率，自定义跟单金额、卖出比例、gas、滑点和过滤条件。 - 开放交易 API。',
            file: 'docs/product-features/xxyy-x-updates.md',
            title: 'XXYY X 历史推文产品更新汇总',
          },
          {
            excerpt:
              '🔗支持6大公链，#SOL #BSC #Base #ETH #XLayer #Plasma 📈输入地址即可查看利润、胜率数据，判断是否值得跟单 ⚙️自定义跟单金额、卖出比例、gas/滑点/交易设置，速度更快',
            file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
            sourceUrl: 'https://x.com/useXXYYio/status/2029522365408067746',
            title: 'X Post 2029522365408067746',
          },
        ],
        confidence: 12,
      }),
    );

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            sourceUrl: z.string().optional(),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: '支持跟单么' },
          kind: 'tool',
          reason: 'Search product docs first.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: '支持跟单么',
    });

    expect(response.answer).toBe(
      '支持。跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链，可查看地址利润和胜率，自定义跟单金额、卖出比例、gas、滑点和过滤条件。',
    );
    expect(response.answer).not.toContain('FourMeme');
    expect(response.answer).not.toContain('🔗');
    expect(response.citations).toHaveLength(2);
  });

  it('passes attachments through composed search evidence responses', async () => {
    const registry = createToolRegistry();
    const attachments = [
      {
        kind: 'video' as const,
        mediaType: 'video/mp4',
        title: '添加到桌面演示',
        url: '/assets/xxyy-add-to-home.mp4',
      },
    ];
    const execute = vi.fn(() =>
      Promise.resolve({
        attachments,
        chunks: [
          {
            id: 'mobile-app',
            text: '标准客服回答：可以添加到桌面，和 App 体验差不多。',
          },
        ],
        citations: [
          {
            excerpt: '可以添加到桌面，和 App 体验差不多。',
            file: 'docs/product-features/pages/64-getting-started__mobile-app.md',
            title: '移动端桌面入口',
          },
        ],
        confidence: 8,
      }),
    );

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        attachments: z.array(z.unknown()).optional(),
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: 'XXYY 有 APP 吗？有添加到桌面的演示视频吗？' },
          kind: 'tool',
          reason: 'Search mobile app docs.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY 有 APP 吗？有添加到桌面的演示视频吗？',
    });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      attachments,
      intent: 'product_qa',
    });
  });

  it('keeps the original question as the first docs query', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() =>
      Promise.resolve({
        chunks: [
          {
            id: 'chunk-1',
            text: 'XXYY Pro 支持独享服务器和节点。',
          },
        ],
        citations: [
          {
            excerpt: 'XXYY Pro 支持独享服务器和节点。',
            file: 'docs/product-features/pages/59-getting-started__xxyy-pro-quan-yi.md',
            title: 'XXYY Pro 权益',
          },
        ],
        confidence: 10,
      }),
    );

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 权益' },
          kind: 'tool',
          reason: 'Search product docs first.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
    expect(execute).toHaveBeenCalledWith(
      { query: 'XXYY Pro 有哪些权益？' },
      { channel: 'web', userIdPresent: false },
    );
  });

  it('accumulates multi-module search evidence before composing an answer', async () => {
    const registry = createToolRegistry();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [
          {
            id: 'pro-chunk',
            text: 'XXYY Pro 支持独享服务器和节点、监控2000个钱包。',
          },
        ],
        citations: [
          {
            excerpt: 'XXYY Pro 支持独享服务器和节点、监控2000个钱包。',
            file: 'docs/product-features/pages/59-getting-started__xxyy-pro-quan-yi.md',
            title: 'XXYY Pro 权益',
          },
        ],
        confidence: 11,
      })
      .mockResolvedValueOnce({
        chunks: [
          {
            id: 'wallet-chunk',
            text: 'XXYY 每个用户每条链最多创建100个交易钱包，Pro 用户最多创建500个交易钱包。',
          },
        ],
        citations: [
          {
            excerpt: 'XXYY 每个用户每条链最多创建100个交易钱包，Pro 用户最多创建500个交易钱包。',
            file: 'docs/product-features/pages/58-getting-started__qian-bao-guan-li.md',
            title: '钱包管理',
          },
        ],
        confidence: 10,
      });

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: 'XXYY Pro 权益' },
          kind: 'tool',
          reason: 'Search the Pro benefits evidence first.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
        {
          input: { query: '钱包管理 创建 交易钱包 上限' },
          kind: 'tool',
          reason: 'Search wallet management limits before answering the comparison.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: '请比较 XXYY Pro 权益和钱包管理上限',
    });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      citations: [
        {
          file: 'docs/product-features/pages/59-getting-started__xxyy-pro-quan-yi.md',
          title: 'XXYY Pro 权益',
        },
        {
          file: 'docs/product-features/pages/58-getting-started__qian-bao-guan-li.md',
          title: '钱包管理',
        },
      ],
      intent: 'product_qa',
    });
    expect(response.answer).toContain('独享服务器和节点');
    expect(response.answer).toContain('每条链最多创建100个交易钱包');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('streams accumulated multi-module search evidence with ask parity', async () => {
    const registry = createToolRegistry();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [{ id: 'pro-chunk', text: 'XXYY Pro 支持独享服务器和节点。' }],
        citations: [
          {
            excerpt: 'XXYY Pro 支持独享服务器和节点。',
            file: 'docs/product-features/pro.md',
            title: 'XXYY Pro 权益',
          },
        ],
        confidence: 11,
      })
      .mockResolvedValueOnce({
        chunks: [{ id: 'wallet-chunk', text: '每条链最多创建100个交易钱包。' }],
        citations: [
          {
            excerpt: '每条链最多创建100个交易钱包。',
            file: 'docs/product-features/wallet.md',
            title: '钱包管理',
          },
        ],
        confidence: 10,
      });

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(z.object({ excerpt: z.string(), file: z.string(), title: z.string() })),
        confidence: z.number(),
      }),
      execute,
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: 'XXYY Pro 权益' },
          kind: 'tool',
          reason: 'Search Pro benefits.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
        {
          input: { query: '钱包管理上限' },
          kind: 'tool',
          reason: 'Search wallet limits.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).stream({
      channel: 'web',
      message: '请比较 XXYY Pro 权益和钱包管理上限',
    })) {
      events.push(event);
    }

    const answer = events
      .filter((event): event is Extract<ChatStreamEvent, { type: 'answer_delta' }> => {
        return event.type === 'answer_delta';
      })
      .map((event) => event.delta)
      .join('');
    const metadata = events.find(
      (event): event is Extract<ChatStreamEvent, { type: 'metadata' }> => {
        return event.type === 'metadata';
      },
    );

    expect(answer).toContain('独享服务器和节点');
    expect(answer).toContain('每条链最多创建100个交易钱包');
    expect(metadata?.citations.map((citation) => citation.file)).toEqual([
      'docs/product-features/pro.md',
      'docs/product-features/wallet.md',
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('stops before executing a repeated planner tool input', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() =>
      Promise.resolve({
        chunks: [],
        citations: [],
        confidence: 0,
      }),
    );

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.unknown()),
        citations: z.array(z.unknown()),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: '这个不存在的功能怎么用？' },
          kind: 'tool',
          reason: 'Search product docs.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
        {
          input: { query: ' 这个不存在的功能，怎么用 ', topK: 20 },
          kind: 'tool',
          reason: 'Repeat the same search.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: '这个不存在的功能怎么用？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'unknown',
    });
    expect(response.answer).toContain('重复检索');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('streams clarification before executing a repeated planner tool input', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => Promise.resolve({ chunks: [], citations: [], confidence: 0 }));

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.unknown()),
        citations: z.array(z.unknown()),
        confidence: z.number(),
      }),
      execute,
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: '这个不存在的功能怎么用？' },
          kind: 'tool',
          reason: 'Search product docs.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
        {
          input: { query: '不存在的功能' },
          kind: 'tool',
          reason: 'Repeat the same search.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).stream({
      channel: 'web',
      message: '这个不存在的功能怎么用？',
    })) {
      events.push(event);
    }

    const answer = events
      .filter((event): event is Extract<ChatStreamEvent, { type: 'answer_delta' }> => {
        return event.type === 'answer_delta';
      })
      .map((event) => event.delta)
      .join('');
    expect(answer).toContain('重复检索');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns a concise no-evidence answer when repeated searches cannot prove support', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() =>
      Promise.resolve({
        chunks: [],
        citations: [],
        confidence: 0,
      }),
    );

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.unknown()),
        citations: z.array(z.unknown()),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: '当前支持robinhood么' },
          kind: 'tool',
          reason: 'Search product docs.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
        {
          input: { query: 'robinhood 支持' },
          kind: 'tool',
          reason: 'Repeat the same search.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: '当前支持robinhood么',
    });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      citations: [],
      intent: 'product_qa',
    });
    expect(response.answer).toBe('当前知识库没有明确说明 XXYY 支持 robinhood，不能确认已支持。');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops after consecutive searches produce no new evidence', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() =>
      Promise.resolve({
        chunks: [],
        citations: [],
        confidence: 0,
      }),
    );

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.unknown()),
        citations: z.array(z.unknown()),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: '不存在的功能' },
          kind: 'tool',
          reason: 'Search product docs.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
        {
          input: { query: '不存在的功能 配置步骤' },
          kind: 'tool',
          reason: 'Try a rewritten query.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: '这个不存在的功能怎么配置？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'unknown',
    });
    expect(response.answer).toContain('没有找到新的知识库证据');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('streams clarification after two distinct searches produce no evidence', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => Promise.resolve({ chunks: [], citations: [], confidence: 0 }));

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.unknown()),
        citations: z.array(z.unknown()),
        confidence: z.number(),
      }),
      execute,
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { query: '不存在的模块一' },
          kind: 'tool',
          reason: 'Search the first module.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
        {
          input: { query: '不存在的模块二' },
          kind: 'tool',
          reason: 'Search the second module.',
          route: 'product_answer',
          toolName: 'search_product_docs' as never,
        },
      ]),
      registry,
    }).stream({
      channel: 'web',
      message: '这个不存在的功能怎么用？',
    })) {
      events.push(event);
    }

    const answer = events
      .filter((event): event is Extract<ChatStreamEvent, { type: 'answer_delta' }> => {
        return event.type === 'answer_delta';
      })
      .map((event) => event.delta)
      .join('');
    expect(answer).toContain('连续检索后没有找到新的知识库证据');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['parse', new PlannerModelParseError('invalid planner json')],
    ['request', new PlannerModelRequestError('planner request failed')],
  ])(
    'returns clarification when planner has an expected %s failure twice',
    async (_name, error) => {
      const registry = createToolRegistry();
      const planner = {
        plan: vi.fn(() => Promise.reject(error)),
      };

      const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
        channel: 'web',
        message: '你好，可以介绍一下吗？',
      });

      expect(response).toMatchObject({
        agentRoute: 'clarify',
        citations: [],
        intent: 'unknown',
      });
      expect(planner.plan).toHaveBeenCalledTimes(2);
    },
  );

  it('retries planner parsing failure and uses the repaired product tool plan', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY 支持跟单相关产品能力说明。',
      citations: [],
      confidence: 0.81,
      intent: 'product_qa',
    };
    const execute = vi.fn(() => Promise.resolve(response));
    const planner = {
      plan: vi
        .fn()
        .mockRejectedValueOnce(new PlannerModelParseError('invalid route'))
        .mockResolvedValueOnce({
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool' as const,
          reason: 'Use product docs after retry.',
          route: 'product_answer' as const,
          toolName: 'answer_product_question' as const,
        }),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute,
    });

    await expect(
      createLangGraphCustomerRuntime({ planner, registry }).ask({
        channel: 'cli',
        message: '你好，可以介绍一下吗？',
      }),
    ).resolves.toEqual({
      ...response,
      agentRoute: 'product_answer',
    });
    expect(planner.plan).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      { question: '你好，可以介绍一下吗？' },
      { channel: 'cli', sessionId: undefined, userIdPresent: false },
    );
  });

  it('returns clarification when a tool throws', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool failed');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'unknown',
    });
    expect(response.answer).toContain('知识库检索或 AI 服务暂时不可用');
    expect(response.answer).not.toContain('请补充一个具体的 XXYY 产品问题');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('retries one transient read-only product search failure', async () => {
    const registry = createToolRegistry();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary search failure'))
      .mockResolvedValueOnce({
        chunks: [{ id: 'pro-retry', text: 'XXYY Pro 支持独享服务器和节点。' }],
        citations: [
          {
            excerpt: 'XXYY Pro 支持独享服务器和节点。',
            file: 'docs/product-features/pro.md',
            title: 'XXYY Pro 权益',
          },
        ],
        confidence: 10,
      });

    registry.register({
      name: 'search_product_docs',
      description: 'Search product docs.',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        chunks: z.array(z.object({ id: z.string(), text: z.string() })),
        citations: z.array(
          z.object({
            excerpt: z.string(),
            file: z.string(),
            title: z.string(),
          }),
        ),
        confidence: z.number(),
      }),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([]),
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
    expect(response.answer).toContain('独享服务器和节点');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('derives the final route from the executed product tool when planner route mismatches', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: 'XXYY Pro 提供更高监控上限。',
      citations: [],
      confidence: 0.82,
      intent: 'product_qa',
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute: () => Promise.resolve(response),
    });

    await expect(
      createLangGraphCustomerRuntime({
        planner: createScriptedPlannerModel([
          {
            input: { question: 'XXYY Pro 有哪些权益？' },
            kind: 'tool',
            reason: 'Mismatched route.',
            route: 'unsupported',
            toolName: 'answer_product_question',
          },
        ]),
        registry,
      }).ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      }),
    ).resolves.toMatchObject({
      agentRoute: 'product_answer',
      intent: 'product_qa',
    });
  });

  it.each(['product_answer'] as const)(
    'normalizes unsafe final %s planner routes without tool evidence',
    async (route) => {
      const registry = createToolRegistry();
      const planner = {
        plan: vi.fn(() =>
          Promise.resolve({
            kind: 'final',
            reason: 'malicious planner route',
            response: {
              answer: 'I claim a tool-backed route without evidence.',
              citations: [],
              confidence: 0.99,
              intent: 'product_qa',
            },
            route,
          } as never),
        ),
      };

      const response = await createLangGraphCustomerRuntime({ planner, registry }).ask({
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
      });

      expect(response).toMatchObject({
        agentRoute: 'clarify',
        citations: [],
        intent: 'unknown',
      });
      expect(response.answer).not.toContain('tool-backed route');
      expect(planner.plan).toHaveBeenCalledOnce();
    },
  );

  it('streams metadata from the composed response', async () => {
    const registry = createToolRegistry();
    const response: ChatResponse = {
      answer: '带附件回答',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/png',
          title: '截图',
          url: '/assets/screenshot.png',
        },
      ],
      citations: [],
      confidence: 0.82,
      intent: 'product_qa',
      tokenUsage: {
        completionTokens: 3,
        promptTokens: 7,
        totalTokens: 10,
      },
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute: () => Promise.resolve(response),
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    }).stream({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        message: '正在分析问题…',
        phase: 'planning',
        type: 'status',
      },
      {
        message: '正在生成回答…',
        phase: 'answering',
        type: 'status',
      },
      {
        delta: '带附件回答',
        type: 'answer_delta',
      },
      {
        agentRoute: 'product_answer',
        attachments: response.attachments,
        citations: [],
        confidence: 0.82,
        intent: 'product_qa',
        tokenUsage: response.tokenUsage,
        type: 'metadata',
      },
    ]);
  });

  it('streams planner-selected product tool events without using the non-streaming execute path', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('execute should not be used when the tool has a stream path');
    });

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute,
      async *stream() {
        await Promise.resolve();
        yield { type: 'answer_delta' as const, delta: 'streamed ' };
        yield {
          type: 'metadata' as const,
          citations: [],
          confidence: 0.84,
          intent: 'product_qa' as const,
        };
      },
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product docs.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
    }).stream({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        message: '正在分析问题…',
        phase: 'planning',
        type: 'status',
      },
      { type: 'answer_delta', delta: 'streamed ' },
      {
        agentRoute: 'product_answer',
        citations: [],
        confidence: 0.84,
        intent: 'product_qa',
        type: 'metadata',
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns clarification at the step limit without executing tools', async () => {
    const registry = createToolRegistry();
    const execute = vi.fn(() => {
      throw new Error('tool should not be called');
    });
    const planner = {
      plan: vi.fn(() => {
        throw new Error('planner should not be called');
      }),
    };

    registry.register({
      name: 'answer_product_question',
      description: 'Answer a product question.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute,
    });

    const response = await createLangGraphCustomerRuntime({
      maxSteps: 0,
      planner,
      registry,
    }).ask({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
    });

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
    });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('traces root classification and deterministic guard for boundary requests', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product knowledge.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry: createToolRegistry({ tracer }),
      tracer,
    });

    const response = await runtime.ask({
      channel: 'web',
      message: '帮我查一下钱包余额 alice@example.com',
      requestId: 'req-boundary',
      sessionId: 'session-secret',
      userId: 'user-secret',
    });

    expect(response.agentRoute).toBe('boundary');
    expect(records.map((record) => record.name)).toEqual([
      'chat.request',
      'agent.classify',
      'agent.guard',
    ]);
    expect(records[1]?.parentId).toBe(records[0]?.id);
    expect(records[2]?.parentId).toBe(records[0]?.id);
    expect(records[0]).toMatchObject({
      inputs: {
        channel: 'web',
        messageLength: 27,
        sessionIdPresent: true,
        userIdPresent: true,
      },
      metadata: { requestId: 'req-boundary' },
      outputs: {
        agentRoute: 'boundary',
        attachmentCount: 0,
        citationCount: 0,
        intent: 'realtime_account_query',
      },
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('session-secret');
    expect(serialized).not.toContain('user-secret');
  });

  it('keeps streamed request and tool spans nested without retaining deltas', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createToolRegistry({ tracer });
    registry.register({
      name: 'answer_product_question',
      description: 'Answer products.',
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.custom<ChatResponse>(() => true),
      execute: () =>
        ({
          answer: '',
          citations: [],
          confidence: 0.8,
          intent: 'product_qa',
        }) satisfies ChatResponse,
      async *stream() {
        await Promise.resolve();
        yield { type: 'answer_delta', delta: 'secret product delta' };
        yield { type: 'metadata', citations: [], confidence: 0.8, intent: 'product_qa' };
      },
    });
    const runtime = createLangGraphCustomerRuntime({
      planner: createScriptedPlannerModel([
        {
          input: { question: 'XXYY Pro 有哪些权益？' },
          kind: 'tool',
          reason: 'Use product knowledge.',
          route: 'product_answer',
          toolName: 'answer_product_question',
        },
      ]),
      registry,
      tracer,
    });

    const events: ChatStreamEvent[] = [];
    for await (const event of runtime.stream({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      requestId: 'req-stream',
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === 'answer_delta')).toBe(true);
    const root = records.find((record) => record.name === 'chat.request');
    const tool = records.find((record) => record.name === 'agent.tool');
    expect(root).toMatchObject({
      outputs: {
        eventCount: 3,
        eventTypes: ['status', 'answer_delta', 'metadata'],
      },
      status: 'success',
    });
    expect(tool?.parentId).toBe(root?.id);
    expect(JSON.stringify(records)).not.toContain('secret product delta');
  });
});

function conflictChunk(id: string, text: string) {
  return {
    documentId: `document-${id}`,
    id,
    lexicalScore: 1,
    metadata: {
      file: `docs/${id}.md`,
      headingPath: ['钱包监控'],
      module: '会员',
      sourceType: 'official_docs' as const,
      status: 'current' as const,
      title: 'XXYY Pro 权益',
    },
    rank: 1,
    score: 1,
    sourceBoost: 0,
    text,
    vectorScore: 1,
  };
}

function searchOutput(id: string, text: string) {
  return {
    chunks: [{ id, text }],
    citations: [
      {
        excerpt: text,
        file: `docs/product-features/${id}.md`,
        sourceType: 'official_docs' as const,
        title: id,
      },
    ],
    confidence: 0.82,
  };
}
