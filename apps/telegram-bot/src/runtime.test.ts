import { describe, expect, it } from 'vitest';

import {
  createChainAnalysisMcpClientStub,
  createInMemoryChainAnalysisMcpClient,
} from '@xxyy/chain-analysis-mcp';
import { createChainAnalysisFixtureRuntime } from '@xxyy/chain-analysis-mcp/test-fixtures';
import { createInMemoryQualityTracer, loadRagConfig } from '@xxyy/rag-core';

import { createTelegramChatRuntime } from './runtime.js';

describe('createTelegramChatRuntime', () => {
  it('injects the supplied tracer into the customer runtime', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const runtime = createTelegramChatRuntime(loadRagConfig({}), tracer);
    try {
      const response = await runtime.service.ask({
        channel: 'telegram',
        message: '帮我查一下钱包余额',
        requestId: 'telegram:1:1',
      });

      expect(response.agentRoute).toBe('boundary');
      expect(records.map((record) => record.name)).toEqual([
        'chat.request',
        'agent.classify',
        'agent.guard',
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('queries a public Explorer transaction through the Telegram grant', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const explorerUrl = `https://etherscan.io/tx/${fixture.transactionHash}`;
    const runtime = createTelegramChatRuntime(loadRagConfig({}), undefined, {
      publicChainMcpClient: createChainAnalysisMcpClientStub({
        getTransaction: (input, signal) =>
          fixture.handler.getTransaction(input, signal === undefined ? {} : { signal }),
      }),
    });

    try {
      await expect(
        runtime.service.ask({
          channel: 'telegram',
          message: explorerUrl,
          requestId: 'telegram:chain:1',
        }),
      ).resolves.toMatchObject({
        agentRoute: 'chain_answer',
        citations: [{ sourceUrl: explorerUrl }],
        intent: 'onchain_transaction',
      });
    } finally {
      await runtime.close();
    }
  });

  it('exposes governed deep read-only analysis through the Telegram grant', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const explorerUrl = `https://etherscan.io/tx/${fixture.transactionHash}`;
    const client = createInMemoryChainAnalysisMcpClient({ handler: fixture.handler });
    const runtime = createTelegramChatRuntime(loadRagConfig({}), undefined, {
      publicChainMcpClient: client,
    });

    try {
      const response = await runtime.service.ask({
        channel: 'telegram',
        message: `调用追踪 ${explorerUrl}`,
        requestId: 'telegram:chain:trace:1',
      });

      expect(response).toMatchObject({
        agentRoute: 'chain_answer',
        citations: [{ sourceUrl: explorerUrl }],
        intent: 'onchain_transaction',
      });
      expect(response.answer).toContain('调用追踪：可用（6 个调用节点）');
    } finally {
      await runtime.close();
    }
  });
});
