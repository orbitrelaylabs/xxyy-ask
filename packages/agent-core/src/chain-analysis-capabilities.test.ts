import { describe, expect, it } from 'vitest';

import {
  createChainAnalysisMcpClientStub,
  createInMemoryChainAnalysisMcpClient,
} from '@xxyy/chain-analysis-mcp';
import { createChainAnalysisFixtureRuntime } from '@xxyy/chain-analysis-mcp/test-fixtures';
import { createInMemoryQualityTracer } from '@xxyy/rag-core';

import { CapabilityPolicyDeniedError } from './capability-registry.js';
import {
  CHAIN_GET_MCP_CAPABILITY_ID,
  CHAIN_GET_SKILL_CAPABILITY_ID,
  CHAIN_INSPECT_MCP_CAPABILITY_ID,
  CHAIN_INSPECT_SKILL_CAPABILITY_ID,
  CHAIN_SANDWICH_MCP_CAPABILITY_ID,
  CHAIN_SANDWICH_SKILL_CAPABILITY_ID,
  createInternalChainAnalysisCapabilityRegistry,
  createInternalChainAnalysisTools,
  type InternalChainAnalysisCaller,
} from './chain-analysis-capabilities.js';
import { createToolRegistry } from './tool-registry.js';

describe('internal chain-analysis MCP and Skill capability bridge', () => {
  it('executes an internal Tool through exact Skill and MCP capabilities', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const { records, tracer } = createInMemoryQualityTracer();
    const caller = { channel: 'internal' as const, principal: 'service' as const };
    const mcpClient = createInMemoryChainAnalysisMcpClient({
      handler: fixture.handler,
    });
    const registry = createInternalChainAnalysisCapabilityRegistry({
      caller,
      mcpClient,
      tracer,
    });
    const tools = createToolRegistry();
    for (const tool of createInternalChainAnalysisTools({ caller, registry })) {
      tools.register(tool);
    }

    try {
      await expect(
        tools.execute(
          'inspect_transaction',
          {
            chainId: fixture.chainId,
            transactionHash: fixture.transactionHash,
          },
          { channel: 'untrusted-request-value', requestId: 'req-chain-internal' },
        ),
      ).resolves.toMatchObject({
        capability: {
          capability: 'chain.inspect_transaction',
          transactionHash: fixture.transactionHash,
        },
      });
      expect(registry.list().map((manifest) => manifest.id)).toEqual([
        CHAIN_SANDWICH_MCP_CAPABILITY_ID,
        CHAIN_GET_MCP_CAPABILITY_ID,
        CHAIN_INSPECT_MCP_CAPABILITY_ID,
        CHAIN_SANDWICH_SKILL_CAPABILITY_ID,
        CHAIN_GET_SKILL_CAPABILITY_ID,
        CHAIN_INSPECT_SKILL_CAPABILITY_ID,
      ]);
      const capabilityRecords = records.filter((record) => record.name === 'agent.capability');
      expect(capabilityRecords).toHaveLength(2);
      expect(capabilityRecords.map((record) => record.metadata?.source).sort()).toEqual([
        'mcp',
        'skill',
      ]);
      expect(JSON.stringify(capabilityRecords)).not.toContain(fixture.transactionHash);
    } finally {
      await mcpClient.close();
    }
  });

  it('denies the same capability under a different caller identity', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const registry = createInternalChainAnalysisCapabilityRegistry({
      caller: { channel: 'internal', principal: 'service' },
      mcpClient: createChainAnalysisMcpClientStub({
        inspectTransaction: (input, signal) =>
          fixture.handler.inspectTransaction(input, signal === undefined ? {} : { signal }),
      }),
    });

    await expect(
      registry.invoke(
        CHAIN_INSPECT_SKILL_CAPABILITY_ID,
        {
          chainId: fixture.chainId,
          transactionHash: fixture.transactionHash,
        },
        { channel: 'web', principal: 'anonymous' },
      ),
    ).rejects.toBeInstanceOf(CapabilityPolicyDeniedError);
  });

  it('rejects public callers before constructing any grants', () => {
    expect(() =>
      createInternalChainAnalysisCapabilityRegistry({
        caller: {
          channel: 'web',
          principal: 'anonymous',
        } as unknown as InternalChainAnalysisCaller,
        mcpClient: createChainAnalysisMcpClientStub({}),
      }),
    ).toThrow('internal-only trusted caller');
  });
});
