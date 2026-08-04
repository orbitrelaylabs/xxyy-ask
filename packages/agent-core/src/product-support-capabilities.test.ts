import { describe, expect, it, vi } from 'vitest';

import type { ProductSearchOutput } from '@xxyy/product-support-runtime';
import { createInMemoryQualityTracer } from '@xxyy/rag-core';

import { CapabilityPolicyDeniedError } from './capability-registry.js';
import {
  PRODUCT_SEARCH_SKILL_CAPABILITY_ID,
  createProductSupportCapabilityRegistry,
  createProductSupportSkillTool,
} from './product-support-capabilities.js';
import { createToolRegistry } from './tool-registry.js';

describe('product support Skill capability', () => {
  it('registers one direct Skill manifest and executes the Agent tool', async () => {
    const search = vi.fn((input: { query: string }, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(createOutput(input.query));
    });
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const registry = createProductSupportCapabilityRegistry({
      caller,
      productSearch: { searchProductDocs: search },
    });
    const tools = createToolRegistry();
    tools.register(createProductSupportSkillTool({ caller, registry }));

    expect(registry.list()).toEqual([
      expect.objectContaining({ id: PRODUCT_SEARCH_SKILL_CAPABILITY_ID, source: 'skill' }),
    ]);
    await expect(
      tools.execute('search_product_docs', { query: 'XXYY Pro 权益' }, { requestId: 'req' }),
    ).resolves.toMatchObject({ chunks: [{ id: 'product-evidence' }], confidence: 0.9 });
  });

  it('remains deny-by-default and traces one redacted Skill execution', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createProductSupportCapabilityRegistry({
      caller: { channel: 'web', principal: 'anonymous' },
      productSearch: { searchProductDocs: (input) => Promise.resolve(createOutput(input.query)) },
      tracer,
    });
    await expect(
      registry.invoke(
        PRODUCT_SEARCH_SKILL_CAPABILITY_ID,
        { query: 'private-shaped phrase' },
        { channel: 'cli', principal: 'user' },
      ),
    ).rejects.toBeInstanceOf(CapabilityPolicyDeniedError);
    await registry.invoke(
      PRODUCT_SEARCH_SKILL_CAPABILITY_ID,
      { query: 'private-shaped phrase' },
      { channel: 'web', principal: 'anonymous' },
    );
    const capabilityRecords = records.filter((record) => record.name === 'agent.capability');
    expect(capabilityRecords).toHaveLength(2);
    expect(capabilityRecords.map((record) => record.metadata?.source)).toEqual(['skill', 'skill']);
    expect(JSON.stringify(capabilityRecords)).not.toContain('private-shaped phrase');
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
