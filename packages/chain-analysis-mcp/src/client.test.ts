import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';

import { createChainAnalysisMcpClient, createInMemoryChainAnalysisMcpClient } from './client.js';
import { createChainAnalysisFixtureRuntime } from './fixture-handler.test-helper.js';
import { createChainAnalysisMcpServer } from './server.js';

describe('createInMemoryChainAnalysisMcpClient', () => {
  it('invokes transaction and Sandwich analysis through a real MCP transport', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.confirmed-v2');
    if (runtime.poolAddress === undefined) {
      throw new Error('Confirmed Sandwich fixture requires a pool address.');
    }
    const client = createInMemoryChainAnalysisMcpClient({ handler: runtime.handler });

    try {
      await expect(
        client.getTransaction({
          network: `eip155:${runtime.chainId}`,
          reference: runtime.transactionHash,
        }),
      ).resolves.toMatchObject({
        family: 'evm',
        transactionId: runtime.transactionHash,
      });
      await expect(
        client.inspectTransaction({
          chainId: runtime.chainId,
          transactionHash: runtime.transactionHash,
        }),
      ).resolves.toMatchObject({
        capability: {
          capability: 'chain.inspect_transaction',
          transactionHash: runtime.transactionHash,
        },
      });
      await expect(
        client.detectSandwich({
          chainId: runtime.chainId,
          poolAddress: runtime.poolAddress,
          transactionHash: runtime.transactionHash,
        }),
      ).resolves.toMatchObject({
        capability: {
          capability: 'chain.detect_sandwich',
          verdict: 'confirmed',
        },
      });
    } finally {
      await client.close();
    }
  });

  it('preserves safe dynamic-allowlist errors across MCP', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.confirmed-v2');
    const client = createInMemoryChainAnalysisMcpClient({ handler: runtime.handler });

    try {
      await expect(
        client.detectSandwich({
          chainId: runtime.chainId,
          poolAddress: '0x9999999999999999999999999999999999999999',
          transactionHash: runtime.transactionHash,
        }),
      ).rejects.toMatchObject({
        code: 'pool_not_configured',
      });
    } finally {
      await client.close();
    }
  });

  it('rejects calls after closing the bridge', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const client = createInMemoryChainAnalysisMcpClient({ handler: runtime.handler });
    await client.close();

    await expect(
      client.inspectTransaction({
        chainId: runtime.chainId,
        transactionHash: runtime.transactionHash,
      }),
    ).rejects.toThrow('closed');
  });
});

describe('createChainAnalysisMcpClient', () => {
  it('uses an injected MCP transport without bypassing the protocol', async () => {
    const runtime = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const server = createChainAnalysisMcpServer({ handler: runtime.handler });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = createChainAnalysisMcpClient({ transport: clientTransport });

    try {
      await expect(
        client.getTransaction({
          network: `eip155:${runtime.chainId}`,
          reference: runtime.transactionHash,
        }),
      ).resolves.toMatchObject({
        family: 'evm',
        transactionId: runtime.transactionHash,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('projects transport startup failures to a safe MCP error', async () => {
    const transport: Transport = {
      close: () => Promise.resolve(),
      send: () => Promise.resolve(),
      start: () => Promise.reject(new Error('secret provider detail')),
    };
    const client = createChainAnalysisMcpClient({ transport });

    try {
      await expect(
        client.getTransaction({
          network: 'eip155:1',
          reference: `0x${'12'.repeat(32)}`,
        }),
      ).rejects.toMatchObject({
        code: 'tool_failure',
        message: 'The onchain-analysis MCP tool invocation failed.',
      });
    } finally {
      await client.close();
    }
  });

  it('bounds a transport that starts without completing MCP initialization', async () => {
    let transport: Transport;
    transport = {
      async close() {
        transport.onclose?.();
      },
      send: () => Promise.resolve(),
      start: () => Promise.resolve(),
    };
    const client = createChainAnalysisMcpClient({
      connectionTimeoutMs: 10,
      transport,
    });

    try {
      await expect(
        client.getTransaction({
          network: 'eip155:1',
          reference: `0x${'12'.repeat(32)}`,
        }),
      ).rejects.toMatchObject({
        code: 'tool_timeout',
      });
    } finally {
      await client.close();
    }
  });
});
