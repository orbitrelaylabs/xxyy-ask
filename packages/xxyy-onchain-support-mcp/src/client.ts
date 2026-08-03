import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  DIAGNOSE_XXYY_TRANSACTION_TOOL_NAME,
  XXYY_ONCHAIN_SUPPORT_MCP_SERVER_NAME,
  XXYY_ONCHAIN_SUPPORT_MCP_VERSION,
  diagnoseXxyyTransactionOutputSchema,
  type XxyyOnchainSupportMcpClient,
  type XxyyTransactionDiagnosisHandler,
} from './contracts.js';
import { createXxyyOnchainSupportMcpServer } from './server.js';

export function createInMemoryXxyyOnchainSupportMcpClient(options: {
  handler: XxyyTransactionDiagnosisHandler;
}): XxyyOnchainSupportMcpClient {
  const server = createXxyyOnchainSupportMcpServer({ handler: options.handler });
  const client = new Client({
    name: `${XXYY_ONCHAIN_SUPPORT_MCP_SERVER_NAME}-agent-bridge`,
    version: XXYY_ONCHAIN_SUPPORT_MCP_VERSION,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let closed = false;
  const ready = (async () => {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  })();
  return {
    async close() {
      if (closed) return;
      closed = true;
      await ready.catch(() => undefined);
      await Promise.allSettled([client.close(), server.close()]);
    },
    async diagnoseXxyyTransaction(input, requestOptions = {}) {
      if (closed) throw new Error('XXYY onchain support MCP client is closed.');
      await ready;
      const result = await client.callTool(
        { arguments: input, name: DIAGNOSE_XXYY_TRANSACTION_TOOL_NAME },
        undefined,
        requestOptions.signal === undefined ? {} : { signal: requestOptions.signal },
      );
      if (result.isError === true) throw new Error('XXYY onchain support MCP tool failed.');
      return diagnoseXxyyTransactionOutputSchema.parse(result.structuredContent);
    },
  };
}

export function createXxyyOnchainSupportMcpClientStub(
  diagnose: XxyyTransactionDiagnosisHandler['diagnoseXxyyTransaction'],
): XxyyOnchainSupportMcpClient {
  return {
    close: () => Promise.resolve(),
    diagnoseXxyyTransaction: diagnose,
  };
}
