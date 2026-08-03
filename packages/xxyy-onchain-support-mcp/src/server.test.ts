import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  XXYY_TRANSACTION_DIAGNOSIS_PROMPT_NAME,
  XXYY_TRANSACTION_DIAGNOSIS_SKILL_RESOURCE_URI,
} from './skill.js';
import { createXxyyOnchainSupportMcpServer } from './server.js';

describe('createXxyyOnchainSupportMcpServer', () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(close.splice(0).map((item) => item())));

  it('publishes the diagnosis Skill resource and prompt', async () => {
    const server = createXxyyOnchainSupportMcpServer({
      handler: {
        diagnoseXxyyTransaction: async () => {
          throw new Error('not called');
        },
      },
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(
      () => client.close(),
      () => server.close(),
    );

    const resources = await client.listResources();
    expect(resources.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: XXYY_TRANSACTION_DIAGNOSIS_SKILL_RESOURCE_URI }),
      ]),
    );
    const prompts = await client.listPrompts();
    expect(prompts.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: XXYY_TRANSACTION_DIAGNOSIS_PROMPT_NAME }),
      ]),
    );
  });
});
