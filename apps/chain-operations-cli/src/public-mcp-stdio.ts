import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  CHAIN_ANALYSIS_MCP_SERVER_NAME,
  createChainAnalysisMcpServer,
} from '@xxyy/chain-analysis-mcp';

import { loadPublicOnchainMcpConfig } from './public-mcp-config.js';
import { createPublicOnchainMcpHandler } from './public-mcp-runtime.js';

async function startPublicOnchainMcp(): Promise<void> {
  const config = loadPublicOnchainMcpConfig(process.env);
  const server = createChainAnalysisMcpServer({
    handler: createPublicOnchainMcpHandler(config),
  });
  const transport = new StdioServerTransport();
  process.stderr.write(
    `${JSON.stringify({
      configuredEvmChains: config.evm.map((chain) => chain.chainId),
      profile: config.profile,
      server: CHAIN_ANALYSIS_MCP_SERVER_NAME,
      solana: config.solana !== undefined,
    })}\n`,
  );
  await server.connect(transport);

  let closing = false;
  const shutdown = async (closeServer: boolean): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    process.stdin.off('end', handleStdinEnd);
    if (closeServer) {
      await server.close().catch(() => undefined);
    }
  };
  const handleSignal = (): void => {
    process.exitCode = 0;
    void shutdown(true).catch(() => {
      process.exitCode = 1;
    });
  };
  const handleStdinEnd = (): void => {
    void shutdown(true).catch(() => {
      process.exitCode = 1;
    });
  };
  transport.onclose = () => {
    void shutdown(false).catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  process.stdin.once('end', handleStdinEnd);
}

try {
  await startPublicOnchainMcp();
} catch {
  process.stderr.write(
    `${JSON.stringify({
      code: 'startup_failed',
      message: 'Onchain-analysis development MCP startup failed without exposing provider details.',
    })}\n`,
  );
  process.exitCode = 1;
}
