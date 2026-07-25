import { z } from 'zod';

import { evmDataAdapterConfigSchema, type EvmChainRpcConfig } from '@xxyy/evm-data-adapter';
import {
  solanaDataAdapterConfigSchema,
  type SolanaDataAdapterConfig,
} from '@xxyy/solana-data-adapter';

import { ChainOperationsCliError } from './runtime-config.js';

const MAX_CONFIG_JSON_BYTES = 131_072;

const publicMcpConfigSchema = z
  .object({
    evm: evmDataAdapterConfigSchema,
    solana: solanaDataAdapterConfigSchema.optional(),
  })
  .strict();

export type PublicOnchainMcpEnv = Partial<
  Record<'NODE_ENV' | 'ONCHAIN_ALLOW_INSECURE_LOCALHOST' | 'ONCHAIN_RPC_CONFIG_JSON', string>
>;

export interface PublicOnchainMcpConfig {
  allowInsecureLocalhost: boolean;
  evm: EvmChainRpcConfig[];
  profile: 'configured';
  solana?: SolanaDataAdapterConfig;
}

export function loadPublicOnchainMcpConfig(env: PublicOnchainMcpEnv): PublicOnchainMcpConfig {
  const allowInsecureLocalhost = parseBoolean(env.ONCHAIN_ALLOW_INSECURE_LOCALHOST, false);
  if (allowInsecureLocalhost && env.NODE_ENV === 'production') {
    throw configurationError('Insecure localhost RPC endpoints are forbidden in production.');
  }
  const rawConfig = env.ONCHAIN_RPC_CONFIG_JSON?.trim();
  if (rawConfig === undefined || rawConfig.length === 0) {
    throw configurationError(
      'ONCHAIN_RPC_CONFIG_JSON is required; define it in the workspace .env or process environment.',
    );
  }
  if (Buffer.byteLength(rawConfig, 'utf8') > MAX_CONFIG_JSON_BYTES) {
    throw configurationError('ONCHAIN_RPC_CONFIG_JSON exceeds the configured size limit.');
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawConfig) as unknown;
  } catch (cause) {
    throw new ChainOperationsCliError(
      'configuration_error',
      'ONCHAIN_RPC_CONFIG_JSON must contain valid JSON.',
      { cause },
    );
  }
  const result = publicMcpConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new ChainOperationsCliError(
      'configuration_error',
      'ONCHAIN_RPC_CONFIG_JSON failed strict provider validation.',
      { cause: result.error },
    );
  }
  return {
    allowInsecureLocalhost,
    evm: result.data.evm,
    profile: 'configured',
    ...(result.data.solana === undefined ? {} : { solana: result.data.solana }),
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw configurationError('Boolean configuration values must be true or false.');
}

function configurationError(message: string): ChainOperationsCliError {
  return new ChainOperationsCliError('configuration_error', message);
}
