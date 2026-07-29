import {
  createPublicOnchainMcpHandler as createSharedPublicOnchainMcpHandler,
  type ChainAnalysisHandler,
} from '@xxyy/chain-analysis-mcp';

import type { PublicOnchainMcpConfig } from './public-mcp-config.js';

export function createPublicOnchainMcpHandler(
  config: PublicOnchainMcpConfig,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
  } = {},
): ChainAnalysisHandler {
  return createSharedPublicOnchainMcpHandler(config, options);
}
