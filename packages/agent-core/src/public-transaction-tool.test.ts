import { describe, expect, it, vi } from 'vitest';

import {
  createChainAnalysisMcpClientStub,
  createInMemoryChainAnalysisMcpClient,
} from '@xxyy/chain-analysis-mcp';
import { createChainAnalysisFixtureRuntime } from '@xxyy/chain-analysis-mcp/test-fixtures';

import { createPublicChainAnalysisCapabilityRegistry } from './chain-analysis-capabilities.js';
import {
  PUBLIC_TRANSACTION_TOOL_NAME,
  createPublicChainTransactionTool,
} from './public-transaction-tool.js';
import { createToolRegistry } from './tool-registry.js';

describe('public transaction customer Tool', () => {
  it('deduplicates Explorer links and renders bounded public transaction facts', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const getTransaction = vi.fn((input, signal?: AbortSignal) =>
      fixture.handler.getTransaction(input, signal === undefined ? {} : { signal }),
    );
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const capabilities = createPublicChainAnalysisCapabilityRegistry({
      caller,
      mcpClient: createChainAnalysisMcpClientStub({ getTransaction }),
    });
    const tools = createToolRegistry();
    tools.register(createPublicChainTransactionTool({ caller, registry: capabilities }));
    const explorerUrl = `https://etherscan.io/tx/${fixture.transactionHash}`;

    await expect(
      tools.execute(
        PUBLIC_TRANSACTION_TOOL_NAME,
        { query: `查询 ${explorerUrl}、${explorerUrl}` },
        { requestId: 'public-chain-1' },
      ),
    ).resolves.toMatchObject({
      agentRoute: 'chain_answer',
      citations: [{ sourceUrl: explorerUrl }],
      intent: 'onchain_transaction',
    });
    expect(getTransaction).toHaveBeenCalledTimes(1);
    const response = await tools.execute(PUBLIC_TRANSACTION_TOOL_NAME, {
      query: explorerUrl,
    });
    expect(response).toMatchObject({
      agentRoute: 'chain_answer',
      confidence: 0.95,
      intent: 'onchain_transaction',
    });
    expect((response as { answer: string }).answer).toContain(fixture.transactionHash);
  });

  it('renders governed call-trace evidence for one public EVM transaction', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const mcpClient = createInMemoryChainAnalysisMcpClient({ handler: fixture.handler });
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const capabilities = createPublicChainAnalysisCapabilityRegistry({
      caller,
      mcpClient,
    });
    const tool = createPublicChainTransactionTool({ caller, registry: capabilities });
    const explorerUrl = `https://etherscan.io/tx/${fixture.transactionHash}`;

    try {
      const response = await tool.execute({ query: `调用追踪 ${explorerUrl}` }, {});
      expect(response).toMatchObject({
        agentRoute: 'chain_answer',
        citations: [{ sourceUrl: explorerUrl }],
        intent: 'onchain_transaction',
      });
      expect(response.answer).toContain('调用追踪：可用（6 个调用节点）');
      expect(response.answer).toContain('内部原生币转账：3 条');
      expect(response.answer).toContain('回滚调用 1');
    } finally {
      await mcpClient.close();
    }
  });

  it('does not report deep analysis as successful when trace evidence is unavailable', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const inspected = await fixture.handler.inspectTransaction({
      chainId: fixture.chainId,
      transactionHash: fixture.transactionHash,
    });
    const { execution: _execution, ...withoutExecution } = inspected;
    const { executionEnrichmentStatus: _executionEnrichmentStatus, ...withoutExecutionStatus } =
      inspected.capability;
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const capabilities = createPublicChainAnalysisCapabilityRegistry({
      caller,
      mcpClient: createChainAnalysisMcpClientStub({
        inspectTransaction: () =>
          Promise.resolve({
            ...withoutExecution,
            capability: {
              ...withoutExecutionStatus,
              internalTransferCount: 0,
              refusalCodes: [],
              status: 'success',
              swapCount: 0,
              traceCoverage: 'not_provided',
            },
            status: 'success',
            warnings: [],
          }),
      }),
    });
    const tool = createPublicChainTransactionTool({ caller, registry: capabilities });

    const response = await tool.execute(
      {
        query: `调用追踪 https://etherscan.io/tx/${fixture.transactionHash}`,
      },
      {},
    );

    expect(response).toMatchObject({
      agentRoute: 'chain_answer',
      confidence: 0.65,
      intent: 'onchain_transaction',
    });
    expect(response.answer).toContain('分析状态：部分数据');
    expect(response.answer).toContain('调用追踪：未配置 trace Provider');
    expect(response.answer).toContain('不能据此分析内部调用路径');
  });

  it('renders partial Explorer and Uniswap V4 evidence as user-facing limitations', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const inspected = await fixture.handler.inspectTransaction({
      chainId: fixture.chainId,
      transactionHash: fixture.transactionHash,
    });
    if (inspected.execution === undefined) {
      throw new Error('Expected execution fixture.');
    }
    const execution = inspected.execution;
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const capabilities = createPublicChainAnalysisCapabilityRegistry({
      caller,
      mcpClient: createChainAnalysisMcpClientStub({
        inspectTransaction: () =>
          Promise.resolve({
            ...inspected,
            capability: {
              ...inspected.capability,
              refusalCodes: ['execution_data_partial'],
              status: 'partial',
            },
            execution: {
              ...execution,
              coverage: {
                ...execution.coverage,
                recognizedSwapLogs: execution.coverage.decodedSwapLogs + 1,
                unresolvedSwapLogs: 1,
              },
              status: 'partial',
              warnings: [
                ...execution.warnings,
                'trace_source_partial',
                'uniswap_v4_pool_key_not_configured',
              ],
            },
            status: 'partial',
            warnings: ['chain.inspect_transaction:partial'],
          }),
      }),
    });
    const tool = createPublicChainTransactionTool({ caller, registry: capabilities });

    const response = await tool.execute(
      {
        query: `调用追踪 https://etherscan.io/tx/${fixture.transactionHash}`,
      },
      {},
    );

    expect(response.answer).toContain('识别但未安全解码的 Swap：1 条');
    expect(response.answer).toContain('调用追踪来自公开 Explorer 单一数据源');
    expect(response.answer).toContain('检测到 Uniswap V4 格式 Swap');
    expect(response.answer).toContain('调用追踪或 Swap 执行证据不完整');
    expect(response.answer).not.toContain('trace_source_partial');
    expect(response.answer).not.toContain('uniswap_v4_pool_key_not_configured');
  });

  it('renders a bounded Sandwich/MEV verdict for an allowlisted pool', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.confirmed-v2');
    const mcpClient = createInMemoryChainAnalysisMcpClient({ handler: fixture.handler });
    const caller = { channel: 'telegram' as const, principal: 'service' as const };
    const capabilities = createPublicChainAnalysisCapabilityRegistry({
      caller,
      mcpClient,
    });
    const tool = createPublicChainTransactionTool({ caller, registry: capabilities });
    const explorerUrl = `https://etherscan.io/tx/${fixture.transactionHash}`;

    try {
      const response = await tool.execute(
        {
          query: `这笔交易是不是被夹了？ ${explorerUrl} 池子地址 ${fixture.poolAddress}`,
        },
        {},
      );
      expect(response).toMatchObject({
        agentRoute: 'chain_answer',
        citations: [{ sourceUrl: explorerUrl }],
        confidence: 0.92,
        intent: 'onchain_transaction',
      });
      expect(response.answer).toContain('Sandwich 结论：已确认');
      expect(response.answer).toContain('目标交易价格影响：4.9907%');
      expect(response.answer).toContain(fixture.poolAddress);
    } finally {
      await mcpClient.close();
    }
  });

  it('recognizes Chinese sandwich-attack wording as a read-only verdict request', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.confirmed-v2');
    const mcpClient = createInMemoryChainAnalysisMcpClient({ handler: fixture.handler });
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const capabilities = createPublicChainAnalysisCapabilityRegistry({
      caller,
      mcpClient,
    });
    const tool = createPublicChainTransactionTool({ caller, registry: capabilities });
    const explorerUrl = `https://etherscan.io/tx/${fixture.transactionHash}`;

    try {
      const response = await tool.execute(
        {
          query: `这笔交易是不是三明治攻击？${explorerUrl} 池子地址 ${fixture.poolAddress}`,
        },
        {},
      );
      expect(response).toMatchObject({
        agentRoute: 'chain_answer',
        intent: 'onchain_transaction',
      });
      expect(response.answer).toContain('Sandwich 结论：已确认');
    } finally {
      await mcpClient.close();
    }
  });

  it('explains that a Bags bonding-curve event cannot be analyzed as a generic DEX pool', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const inspected = await fixture.handler.inspectTransaction({
      chainId: fixture.chainId,
      transactionHash: fixture.transactionHash,
    });
    if (inspected.execution === undefined) {
      throw new Error('Expected execution fixture.');
    }
    const inspectTransaction = vi.fn(() =>
      Promise.resolve({
        ...inspected,
        execution: {
          ...inspected.execution!,
          swaps: [],
          warnings: [
            ...inspected.execution!.warnings,
            'bags_bonding_curve_metadata_not_configured',
          ],
        },
      }),
    );
    const detectSandwich = vi.fn();
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const capabilities = createPublicChainAnalysisCapabilityRegistry({
      caller,
      mcpClient: createChainAnalysisMcpClientStub({
        detectSandwich,
        inspectTransaction,
      }),
    });
    const tool = createPublicChainTransactionTool({ caller, registry: capabilities });

    const response = await tool.execute(
      {
        query: `这笔交易是不是三明治攻击？ https://etherscan.io/tx/${fixture.transactionHash}`,
      },
      {},
    );

    expect(response).toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'onchain_transaction',
    });
    expect(response.answer).toContain('Bags 发射台内盘事件');
    expect(response.answer).toContain('无需继续补普通 DEX 池子地址');
    expect(detectSandwich).not.toHaveBeenCalled();
  });

  it('does not invoke MCP for an ambiguous raw hash', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const getTransaction = vi.fn();
    const inspectTransaction = vi.fn();
    const detectSandwich = vi.fn();
    const caller = { channel: 'telegram' as const, principal: 'service' as const };
    const capabilities = createPublicChainAnalysisCapabilityRegistry({
      caller,
      mcpClient: createChainAnalysisMcpClientStub({
        detectSandwich,
        getTransaction,
        inspectTransaction,
      }),
    });
    const tool = createPublicChainTransactionTool({ caller, registry: capabilities });

    await expect(tool.execute({ query: fixture.transactionHash }, {})).resolves.toMatchObject({
      agentRoute: 'clarify',
      citations: [],
      intent: 'onchain_transaction',
    });
    expect(getTransaction).not.toHaveBeenCalled();
    expect(inspectTransaction).not.toHaveBeenCalled();
    expect(detectSandwich).not.toHaveBeenCalled();
  });
});
