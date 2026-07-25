import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import {
  PRODUCT_QA_MCP_SEARCH_TOOL_NAME,
  PRODUCT_QA_MCP_SERVER_NAME,
  PRODUCT_QA_MCP_VERSION,
  productSearchOutputSchema,
  type ProductSearchOutput,
} from './contracts.js';
import { createProductQaMcpServer } from './server.js';
import { PRODUCT_SUPPORT_SKILL_PROMPT_NAME, PRODUCT_SUPPORT_SKILL_RESOURCE_URI } from './skill.js';

describe('createProductQaMcpServer', () => {
  it('discovers and invokes the read-only tool, Skill resource, and Skill prompt', async () => {
    const server = createProductQaMcpServer({
      handler: {
        searchProductDocs: (input) => Promise.resolve(createOutput(input.query)),
      },
    });
    const client = new Client({
      name: 'product-qa-mcp-test',
      version: PRODUCT_QA_MCP_VERSION,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getServerVersion()).toMatchObject({
        name: PRODUCT_QA_MCP_SERVER_NAME,
        version: PRODUCT_QA_MCP_VERSION,
      });
      expect(client.getInstructions()).toContain('public XXYY product support');

      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);
      expect(tools.tools[0]?.name).toBe(PRODUCT_QA_MCP_SEARCH_TOOL_NAME);
      expect(tools.tools[0]?.title).toBe('Search XXYY Product Knowledge');
      expect(tools.tools[0]?.annotations?.destructiveHint).toBe(false);
      expect(tools.tools[0]?.annotations?.readOnlyHint).toBe(true);

      const toolResult = await client.callTool({
        arguments: { query: 'Telegram 通知' },
        name: PRODUCT_QA_MCP_SEARCH_TOOL_NAME,
      });
      const output = productSearchOutputSchema.parse(toolResult.structuredContent);
      expect(output.chunks[0]?.id).toBe('telegram-support');
      expect(output.confidence).toBe(0.9);

      const resources = await client.listResources();
      expect(resources.resources).toHaveLength(1);
      expect(resources.resources[0]?.mimeType).toBe('text/markdown');
      expect(resources.resources[0]?.uri).toBe(PRODUCT_SUPPORT_SKILL_RESOURCE_URI);
      const resource = await client.readResource({ uri: PRODUCT_SUPPORT_SKILL_RESOURCE_URI });
      const resourceContent = resource.contents[0];
      expect(resourceContent).toBeDefined();
      expect('text' in (resourceContent ?? {})).toBe(true);
      if (resourceContent !== undefined && 'text' in resourceContent) {
        expect(resourceContent.text).toContain('search_product_docs');
      }

      const prompts = await client.listPrompts();
      expect(prompts.prompts).toHaveLength(1);
      expect(prompts.prompts[0]?.name).toBe(PRODUCT_SUPPORT_SKILL_PROMPT_NAME);
      const prompt = await client.getPrompt({
        arguments: { question: 'XXYY Pro 有哪些权益？' },
        name: PRODUCT_SUPPORT_SKILL_PROMPT_NAME,
      });
      expect(prompt.messages).toHaveLength(1);
      const promptContent = prompt.messages[0]?.content;
      expect(promptContent?.type).toBe('text');
      if (promptContent?.type === 'text') {
        expect(promptContent.text).toContain('XXYY Pro 有哪些权益？');
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});

function createOutput(query: string): ProductSearchOutput {
  return {
    chunks: [
      {
        documentId: 'telegram',
        id: 'telegram-support',
        lexicalScore: 1,
        metadata: {
          file: 'docs/product-features/telegram.md',
          headingPath: ['Telegram'],
          module: 'Monitor',
          sourceType: 'official_docs',
          title: 'Telegram 通知',
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
        file: 'docs/product-features/telegram.md',
        sourceType: 'official_docs',
        title: 'Telegram 通知',
      },
    ],
    confidence: 0.9,
  };
}
