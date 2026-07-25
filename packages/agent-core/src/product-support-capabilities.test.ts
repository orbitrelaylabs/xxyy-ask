import { describe, expect, it, vi } from 'vitest';

import { createProductQaMcpClientStub, type ProductSearchOutput } from '@xxyy/product-qa-mcp';
import { createInMemoryQualityTracer } from '@xxyy/rag-core';

import { CapabilityPolicyDeniedError } from './capability-registry.js';
import {
  PRODUCT_SEARCH_MCP_CAPABILITY_ID,
  PRODUCT_SEARCH_SKILL_CAPABILITY_ID,
  createProductSupportCapabilityRegistry,
  createProductSupportSkillTool,
} from './product-support-capabilities.js';
import { createToolRegistry } from './tool-registry.js';

describe('product support MCP and Skill capability bridge', () => {
  it('registers exact MCP and Skill manifests and executes the Agent tool through both layers', async () => {
    const search = vi.fn((input: { query: string }, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(createOutput(input.query));
    });
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const registry = createProductSupportCapabilityRegistry({
      caller,
      mcpClient: createProductQaMcpClientStub(search),
    });
    const toolRegistry = createToolRegistry();
    toolRegistry.register(createProductSupportSkillTool({ caller, registry }));

    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: PRODUCT_SEARCH_MCP_CAPABILITY_ID,
        source: 'mcp',
      }),
      expect.objectContaining({
        id: PRODUCT_SEARCH_SKILL_CAPABILITY_ID,
        source: 'skill',
      }),
    ]);
    await expect(
      toolRegistry.execute(
        'search_product_docs',
        { query: 'XXYY Pro 权益' },
        { channel: 'untrusted-client-value', requestId: 'req-product-skill' },
      ),
    ).resolves.toMatchObject({
      chunks: [{ id: 'product-evidence' }],
      confidence: 0.9,
    });
    expect(search).toHaveBeenCalledWith({ query: 'XXYY Pro 权益' }, expect.any(AbortSignal));
  });

  it('keeps both nested capability invocations deny-by-default outside the trusted caller', async () => {
    const registry = createProductSupportCapabilityRegistry({
      caller: { channel: 'web', principal: 'anonymous' },
      mcpClient: createProductQaMcpClientStub(() => Promise.resolve(createOutput('unused'))),
    });

    await expect(
      registry.invoke(
        PRODUCT_SEARCH_SKILL_CAPABILITY_ID,
        { query: 'XXYY Pro' },
        { channel: 'cli', principal: 'user' },
      ),
    ).rejects.toBeInstanceOf(CapabilityPolicyDeniedError);
  });

  it('traces MCP and Skill execution without recording the query or result text', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const caller = { channel: 'telegram' as const, principal: 'service' as const };
    const registry = createProductSupportCapabilityRegistry({
      caller,
      mcpClient: createProductQaMcpClientStub((input) =>
        Promise.resolve(createOutput(input.query)),
      ),
      tracer,
    });
    const tool = createProductSupportSkillTool({ caller, registry });

    await tool.execute(
      { query: 'private-shaped test phrase' },
      { channel: 'telegram', requestId: 'req-redacted' },
    );

    const capabilityRecords = records.filter((record) => record.name === 'agent.capability');
    expect(capabilityRecords).toHaveLength(2);
    expect(capabilityRecords.map((record) => record.metadata?.source).sort()).toEqual([
      'mcp',
      'skill',
    ]);
    expect(JSON.stringify(capabilityRecords)).not.toContain('private-shaped test phrase');
    expect(JSON.stringify(capabilityRecords)).not.toContain('Evidence for');
  });
});

function createOutput(query: string): ProductSearchOutput {
  return {
    chunks: [
      {
        documentId: 'product',
        id: 'product-evidence',
        lexicalScore: 1,
        metadata: {
          file: 'docs/product-features/product.md',
          headingPath: ['Product'],
          module: 'Product',
          sourceType: 'official_docs',
          title: 'XXYY Product',
        },
        rank: 1,
        score: 0.9,
        sourceBoost: 0.1,
        text: `Evidence for ${query}`,
        vectorScore: 0.8,
      },
    ],
    citations: [
      {
        excerpt: `Evidence for ${query}`,
        file: 'docs/product-features/product.md',
        title: 'XXYY Product',
      },
    ],
    confidence: 0.9,
  };
}
