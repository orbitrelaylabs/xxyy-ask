import { z } from 'zod';

import { evmDataAdapterConfigSchema, type EvmChainRpcConfig } from '@xxyy/evm-data-adapter';
import {
  solanaDataAdapterConfigSchema,
  type SolanaDataAdapterConfig,
} from '@xxyy/solana-data-adapter';

import { ChainOperationsCliError } from './runtime-config.js';

export const PUBLIC_ETHEREUM_RPC_ENDPOINT = 'https://ethereum-rpc.publicnode.com';
export const PUBLIC_BSC_RPC_ENDPOINT = 'https://bsc-dataseed-public.bnbchain.org';
export const PUBLIC_BASE_RPC_ENDPOINT = 'https://mainnet.base.org';
export const PUBLIC_ROBINHOOD_RPC_ENDPOINT = 'https://rpc.mainnet.chain.robinhood.com';
export const PUBLIC_STABLE_RPC_ENDPOINT = 'https://rpc.stable.xyz';
export const PUBLIC_SOLANA_RPC_ENDPOINT = 'https://api.mainnet.solana.com';

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
  profile: 'configured' | 'public_development_defaults';
  solana?: SolanaDataAdapterConfig;
}

export function loadPublicOnchainMcpConfig(env: PublicOnchainMcpEnv): PublicOnchainMcpConfig {
  const allowInsecureLocalhost = parseBoolean(env.ONCHAIN_ALLOW_INSECURE_LOCALHOST, false);
  if (allowInsecureLocalhost && env.NODE_ENV === 'production') {
    throw configurationError('Insecure localhost RPC endpoints are forbidden in production.');
  }
  const rawConfig = env.ONCHAIN_RPC_CONFIG_JSON?.trim();
  if (rawConfig === undefined || rawConfig.length === 0) {
    if (env.NODE_ENV === 'production') {
      throw configurationError(
        'ONCHAIN_RPC_CONFIG_JSON is required in production; public development defaults are disabled.',
      );
    }
    return {
      allowInsecureLocalhost,
      evm: defaultEvmConfig(),
      profile: 'public_development_defaults',
      solana: {
        network: 'solana:mainnet',
        providers: [{ endpoint: PUBLIC_SOLANA_RPC_ENDPOINT, id: 'solana_public' }],
      },
    };
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

function defaultEvmConfig(): EvmChainRpcConfig[] {
  return [
    {
      chainId: '1',
      providers: [{ endpoint: PUBLIC_ETHEREUM_RPC_ENDPOINT, id: 'ethereum_public' }],
    },
    {
      chainId: '56',
      providers: [{ endpoint: PUBLIC_BSC_RPC_ENDPOINT, id: 'bsc_public' }],
    },
    {
      chainId: '8453',
      providers: [{ endpoint: PUBLIC_BASE_RPC_ENDPOINT, id: 'base_public' }],
    },
    {
      chainId: '4663',
      providers: [{ endpoint: PUBLIC_ROBINHOOD_RPC_ENDPOINT, id: 'robinhood_public' }],
    },
    {
      chainId: '988',
      providers: [{ endpoint: PUBLIC_STABLE_RPC_ENDPOINT, id: 'stable_public' }],
    },
  ];
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
