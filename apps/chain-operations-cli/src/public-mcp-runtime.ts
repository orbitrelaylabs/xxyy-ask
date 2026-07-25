import { createChainAnalysisHandler, type ChainAnalysisHandler } from '@xxyy/chain-analysis-mcp';
import { createEvmDataAdapter } from '@xxyy/evm-data-adapter';
import { createSolanaDataAdapter } from '@xxyy/solana-data-adapter';

import type { PublicOnchainMcpConfig } from './public-mcp-config.js';

export function createPublicOnchainMcpHandler(
  config: PublicOnchainMcpConfig,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
  } = {},
): ChainAnalysisHandler {
  const snapshot = createEvmDataAdapter({
    allowInsecureLocalhost: config.allowInsecureLocalhost,
    chains: config.evm,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const solana =
    config.solana === undefined
      ? undefined
      : createSolanaDataAdapter({
          allowInsecureLocalhost: config.allowInsecureLocalhost,
          config: config.solana,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  return createChainAnalysisHandler({
    dataPlane: {
      execution: {
        listConfiguredChains: () => [],
        loadExecutionData: () =>
          Promise.reject(new TypeError('Execution enrichment is not configured.')),
      },
      mevObservation: {
        listConfiguredChains: () => [],
        loadObservation: () => Promise.reject(new TypeError('MEV observation is not configured.')),
      },
      ...(solana === undefined ? {} : { solana }),
      snapshot,
    },
    runtimeStatus: 'internal',
  });
}
