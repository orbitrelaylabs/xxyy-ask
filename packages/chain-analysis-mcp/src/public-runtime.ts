import { z } from 'zod';

import {
  createEvmDataAdapter,
  evmDataAdapterConfigSchema,
  type EvmChainRpcConfig,
} from '@xxyy/evm-data-adapter';
import {
  createEvmExecutionDataAdapter,
  evmExecutionDataAdapterConfigSchema,
  type EvmExecutionChainConfig,
} from '@xxyy/evm-execution-data-adapter';
import {
  createEvmMevObservationDataAdapter,
  evmMevObservationDataAdapterConfigSchema,
  type EvmMevObservationChainConfig,
} from '@xxyy/evm-mev-observation-data-adapter';
import {
  createSolanaDataAdapter,
  solanaDataAdapterConfigSchema,
  type SolanaDataAdapterConfig,
} from '@xxyy/solana-data-adapter';

import { createInMemoryChainAnalysisMcpClient } from './client.js';
import type { ChainAnalysisHandler, ChainAnalysisMcpClient } from './contracts.js';
import { createChainAnalysisHandler } from './service.js';

const MAX_CONFIG_JSON_BYTES = 131_072;

const publicOnchainMcpConfigSchema = z
  .object({
    evm: evmDataAdapterConfigSchema,
    execution: evmExecutionDataAdapterConfigSchema.optional(),
    mevObservation: evmMevObservationDataAdapterConfigSchema.optional(),
    solana: solanaDataAdapterConfigSchema.optional(),
  })
  .strict();

export type PublicOnchainMcpEnv = Partial<
  Record<'NODE_ENV' | 'ONCHAIN_ALLOW_INSECURE_LOCALHOST' | 'ONCHAIN_RPC_CONFIG_JSON', string>
>;

export interface PublicOnchainMcpConfig {
  allowInsecureLocalhost: boolean;
  evm: EvmChainRpcConfig[];
  execution?: EvmExecutionChainConfig[];
  mevObservation?: EvmMevObservationChainConfig[];
  profile: 'configured';
  solana?: SolanaDataAdapterConfig;
}

export interface CreatePublicOnchainMcpHandlerOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface CreatePublicOnchainMcpClientOptions extends CreatePublicOnchainMcpHandlerOptions {
  connectionTimeoutMs?: number;
  env: PublicOnchainMcpEnv;
}

export class PublicOnchainMcpConfigurationError extends Error {
  readonly code = 'configuration_error';

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'PublicOnchainMcpConfigurationError';
  }
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
    throw configurationError('ONCHAIN_RPC_CONFIG_JSON must contain valid JSON.', cause);
  }

  const result = publicOnchainMcpConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw configurationError(
      'ONCHAIN_RPC_CONFIG_JSON failed strict provider validation.',
      result.error,
    );
  }
  if (env.NODE_ENV === 'production' && result.data.mevObservation !== undefined) {
    throw configurationError(
      'Production MEV data must use the readiness-gated chain-analysis composition.',
    );
  }
  if (
    env.NODE_ENV === 'production' &&
    result.data.execution !== undefined &&
    !result.data.execution.every((chain) =>
      chain.providers.every((provider) => provider.traceSource?.kind === 'blockscout_v2'),
    )
  ) {
    throw configurationError(
      'Production RPC call tracing must use the readiness-gated chain-analysis composition; the public runtime only accepts explicitly configured Blockscout partial evidence.',
    );
  }

  return {
    allowInsecureLocalhost,
    evm: result.data.evm,
    ...(result.data.execution === undefined ? {} : { execution: result.data.execution }),
    ...(result.data.mevObservation === undefined
      ? {}
      : { mevObservation: result.data.mevObservation }),
    profile: 'configured',
    ...(result.data.solana === undefined ? {} : { solana: result.data.solana }),
  };
}

export function createPublicOnchainMcpHandler(
  config: PublicOnchainMcpConfig,
  options: CreatePublicOnchainMcpHandlerOptions = {},
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
  const execution =
    config.execution === undefined
      ? {
          listConfiguredChains: () => [],
          loadExecutionData: () =>
            Promise.reject(new TypeError('Execution enrichment is not configured.')),
        }
      : createEvmExecutionDataAdapter({
          allowInsecureLocalhost: config.allowInsecureLocalhost,
          chains: config.execution,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  const mevObservation =
    config.mevObservation === undefined
      ? {
          listConfiguredChains: () => [],
          loadObservation: () =>
            Promise.reject(new TypeError('MEV observation is not configured.')),
        }
      : createEvmMevObservationDataAdapter({
          allowInsecureLocalhost: config.allowInsecureLocalhost,
          chains: config.mevObservation,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });

  return createChainAnalysisHandler({
    dataPlane: {
      execution,
      mevObservation,
      ...(solana === undefined ? {} : { solana }),
      snapshot,
    },
    runtimeStatus: 'internal',
  });
}

export function createPublicOnchainMcpClient(
  options: CreatePublicOnchainMcpClientOptions,
): ChainAnalysisMcpClient {
  const config = loadPublicOnchainMcpConfig(options.env);
  return createInMemoryChainAnalysisMcpClient({
    handler: createPublicOnchainMcpHandler(config, options),
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: options.connectionTimeoutMs }),
  });
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

function configurationError(message: string, cause?: unknown): PublicOnchainMcpConfigurationError {
  return new PublicOnchainMcpConfigurationError(message, cause === undefined ? {} : { cause });
}
