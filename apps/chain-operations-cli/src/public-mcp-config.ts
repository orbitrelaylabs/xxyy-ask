import {
  PublicOnchainMcpConfigurationError,
  loadPublicOnchainMcpConfig as loadSharedPublicOnchainMcpConfig,
  type PublicOnchainMcpConfig,
  type PublicOnchainMcpEnv,
} from '@xxyy/chain-analysis-mcp';

import { ChainOperationsCliError } from './runtime-config.js';

export type { PublicOnchainMcpConfig, PublicOnchainMcpEnv };

export function loadPublicOnchainMcpConfig(env: PublicOnchainMcpEnv): PublicOnchainMcpConfig {
  try {
    return loadSharedPublicOnchainMcpConfig(env);
  } catch (cause) {
    if (cause instanceof PublicOnchainMcpConfigurationError) {
      throw new ChainOperationsCliError('configuration_error', cause.message, { cause });
    }
    throw cause;
  }
}
