import { createHash } from 'node:crypto';

import {
  decimalToRpcQuantity,
  rpcHexQuantitySchema,
  rpcQuantityToDecimal,
} from '@xxyy/evm-data-adapter';
import {
  evmPoolMetadataEntrySchema,
  type EvmCallTrace,
  type EvmPoolMetadataEntry,
} from '@xxyy/evm-execution-enrichment-core';
import {
  EVM_ZERO_ADDRESS,
  evmAddressSchema,
  evmBytesSchema,
} from '@xxyy/transaction-analysis-core';

import {
  ABSOLUTE_MAX_POOL_CANDIDATES,
  EVM_EXECUTION_DATA_ADAPTER_VERSION,
  POOL_FACTORY_SELECTOR,
  POOL_TOKEN0_SELECTOR,
  POOL_TOKEN1_SELECTOR,
  UNISWAP_V2_GET_PAIR_SELECTOR,
  UNISWAP_V3_FEE_SELECTOR,
  UNISWAP_V3_GET_POOL_SELECTOR,
  evmExecutionDataAdapterConfigSchema,
  evmExecutionDataAdapterResultSchema,
  evmVerifiedPoolSchema,
  loadEvmExecutionDataInputSchema,
  type EvmExecutionChainConfig,
  type EvmExecutionDataAdapterDiagnostic,
  type EvmExecutionDataAdapterResult,
  type EvmExecutionDataConflict,
  type EvmPoolCandidate,
  type EvmVerifiedPool,
  type LoadEvmExecutionDataInput,
} from './contracts.js';
import {
  createBlockscoutTraceClient,
  type BlockscoutTraceClient,
} from './blockscout-trace-client.js';
import {
  EvmExecutionDataAdapterConfigurationError,
  EvmExecutionRpcRequestError,
  EvmTraceNormalizationError,
} from './errors.js';
import {
  createExecutionJsonRpcClient,
  type CreateExecutionJsonRpcClientOptions,
  type ExecutionJsonRpcClient,
  type ExecutionRpcCallOutcome,
} from './execution-json-rpc-client.js';
import { fingerprintCallTrace, normalizeCallTracerResult } from './normalize-call-trace.js';
import { CALL_TRACER_SERVER_TIMEOUT, type ExecutionRpcCall } from './rpc-contracts.js';

const DEFAULT_MAX_POOL_CANDIDATES = 25;

interface ConfiguredProvider {
  client: ExecutionJsonRpcClient;
  config: EvmExecutionChainConfig['providers'][number];
  traceClient?: BlockscoutTraceClient | undefined;
}

interface ConfiguredChain {
  config: EvmExecutionChainConfig;
  providers: ConfiguredProvider[];
}

interface PoolObservation {
  fingerprint: string;
  metadata: EvmPoolMetadataEntry;
  verification: EvmVerifiedPool;
}

interface ProviderObservation {
  diagnostics: EvmExecutionDataAdapterDiagnostic[];
  pools: Map<string, PoolObservation>;
  trace?: EvmCallTrace | undefined;
  traceFingerprint?: string | undefined;
}

export interface EvmExecutionDataAdapter {
  listConfiguredChains(): Array<{
    chainId: string;
    providerIds: string[];
    protocols: Array<'uniswap_v2' | 'uniswap_v3'>;
  }>;
  loadExecutionData(
    input: LoadEvmExecutionDataInput,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<EvmExecutionDataAdapterResult>;
}

export interface CreateEvmExecutionDataAdapterOptions extends Omit<
  CreateExecutionJsonRpcClientOptions,
  'provider'
> {
  chains: readonly EvmExecutionChainConfig[];
  maxPoolCandidates?: number;
  now?: () => Date;
}

export function createEvmExecutionDataAdapter(
  options: CreateEvmExecutionDataAdapterOptions,
): EvmExecutionDataAdapter {
  let chainConfigs: EvmExecutionChainConfig[];
  try {
    chainConfigs = evmExecutionDataAdapterConfigSchema.parse(options.chains);
  } catch (cause) {
    throw new EvmExecutionDataAdapterConfigurationError(
      'invalid_configuration',
      'EVM execution data adapter chain configuration is invalid.',
      { cause },
    );
  }
  if (options.maxBatchSize !== undefined && options.maxBatchSize < 5) {
    throw new EvmExecutionDataAdapterConfigurationError(
      'invalid_limits',
      'maxBatchSize must allow the five fixed Uniswap V3 pool reads.',
    );
  }
  const maxPoolCandidates = boundedPoolCandidateLimit(options.maxPoolCandidates);
  const now = options.now ?? (() => new Date());
  const configuredChains = new Map<string, ConfiguredChain>();

  for (const chain of chainConfigs) {
    configuredChains.set(chain.chainId, {
      config: chain,
      providers: chain.providers.map((provider) => {
        const { traceSource, ...rpcProvider } = provider;
        const sharedClientOptions = {
          ...(options.allowInsecureLocalhost === undefined
            ? {}
            : { allowInsecureLocalhost: options.allowInsecureLocalhost }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.maxResponseBytes === undefined
            ? {}
            : { maxResponseBytes: options.maxResponseBytes }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
        };
        return {
          client: createExecutionJsonRpcClient({
            ...sharedClientOptions,
            ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
            ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
            provider: rpcProvider,
            ...(options.retryBaseDelayMs === undefined
              ? {}
              : { retryBaseDelayMs: options.retryBaseDelayMs }),
            ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
          }),
          config: provider,
          ...(traceSource === undefined
            ? {}
            : {
                traceClient: createBlockscoutTraceClient({
                  ...sharedClientOptions,
                  source: traceSource,
                }),
              }),
        };
      }),
    });
  }

  return {
    listConfiguredChains() {
      return chainConfigs.map((chain) => ({
        chainId: chain.chainId,
        providerIds: chain.providers.map((provider) => provider.id),
        protocols: [
          ...(chain.factories.uniswapV2.length > 0 ? (['uniswap_v2'] as const) : ([] as const)),
          ...(chain.factories.uniswapV3.length > 0 ? (['uniswap_v3'] as const) : ([] as const)),
        ],
      }));
    },

    async loadExecutionData(input, loadOptions = {}) {
      let parsedInput: LoadEvmExecutionDataInput;
      try {
        parsedInput = loadEvmExecutionDataInputSchema.parse(input);
      } catch (cause) {
        throw new EvmExecutionDataAdapterConfigurationError(
          'invalid_configuration',
          'EVM execution data request is invalid.',
          { cause },
        );
      }
      if (parsedInput.pools.length > maxPoolCandidates) {
        throw new EvmExecutionDataAdapterConfigurationError(
          'invalid_limits',
          `EVM execution data request exceeds the configured ${maxPoolCandidates} pool limit.`,
        );
      }

      const chain = configuredChains.get(parsedInput.chainId);
      if (chain === undefined) {
        throw new EvmExecutionDataAdapterConfigurationError(
          'chain_not_configured',
          `EVM chain ${parsedInput.chainId} is not configured for execution data.`,
        );
      }
      const selectedProviders = selectProviders(chain.providers, parsedInput.providerIds);
      const observedAt = createObservedAt(now);
      const { eligiblePools, diagnostics: configurationDiagnostics } = selectEligiblePools(
        parsedInput.pools,
        chain.config,
      );
      const observations = await Promise.all(
        selectedProviders.map((provider) =>
          loadProviderObservation({
            chain: chain.config,
            client: provider.client,
            input: parsedInput,
            observedAt,
            pools: eligiblePools,
            signal: loadOptions.signal,
            traceClient: provider.traceClient,
          }),
        ),
      );

      const trace = firstDefined(observations.map((observation) => observation.trace));
      const canonicalPools = collectCanonicalPools(parsedInput.pools, observations);
      const conflicts = collectConflicts(parsedInput, observations);
      const diagnostics = [
        ...configurationDiagnostics,
        ...observations.flatMap((observation) => observation.diagnostics),
      ];
      const poolMetadata = canonicalPools.map((pool) => pool.metadata);
      const verifiedPools = canonicalPools.map((pool) => pool.verification);
      const hasUsableData = trace !== undefined || poolMetadata.length > 0;
      const isComplete =
        trace !== undefined &&
        poolMetadata.length === parsedInput.pools.length &&
        diagnostics.length === 0 &&
        conflicts.length === 0;

      return evmExecutionDataAdapterResultSchema.parse({
        conflicts,
        diagnostics,
        poolMetadata,
        status: isComplete ? 'success' : hasUsableData ? 'partial' : 'insufficient_data',
        ...(trace === undefined ? {} : { trace }),
        verifiedPools,
        version: EVM_EXECUTION_DATA_ADAPTER_VERSION,
      });
    },
  };
}

function selectProviders(
  providers: readonly ConfiguredProvider[],
  providerIds: readonly string[] | undefined,
): ConfiguredProvider[] {
  if (providerIds === undefined) {
    return [...providers];
  }
  const selectedIds = new Set(providerIds);
  for (const providerId of selectedIds) {
    if (!providers.some((provider) => provider.config.id === providerId)) {
      throw new EvmExecutionDataAdapterConfigurationError(
        'provider_not_configured',
        `EVM execution RPC provider ${providerId} is not configured for the selected chain.`,
      );
    }
  }
  return providers.filter((provider) => selectedIds.has(provider.config.id));
}

function selectEligiblePools(
  pools: readonly EvmPoolCandidate[],
  chain: EvmExecutionChainConfig,
): {
  diagnostics: EvmExecutionDataAdapterDiagnostic[];
  eligiblePools: EvmPoolCandidate[];
} {
  const diagnostics: EvmExecutionDataAdapterDiagnostic[] = [];
  const eligiblePools: EvmPoolCandidate[] = [];
  for (const pool of pools) {
    const factories = factoryAllowlistForProtocol(chain, pool.protocol);
    if (factories.length === 0) {
      diagnostics.push({
        code: 'pool_protocol_not_configured',
        poolAddress: pool.poolAddress,
        retryable: false,
      });
    } else {
      eligiblePools.push(pool);
    }
  }
  return { diagnostics, eligiblePools };
}

async function loadProviderObservation(input: {
  chain: EvmExecutionChainConfig;
  client: ExecutionJsonRpcClient;
  input: LoadEvmExecutionDataInput;
  observedAt: string;
  pools: readonly EvmPoolCandidate[];
  signal?: AbortSignal | undefined;
  traceClient?: BlockscoutTraceClient | undefined;
}): Promise<ProviderObservation> {
  const diagnostics: EvmExecutionDataAdapterDiagnostic[] = [];
  const pools = new Map<string, PoolObservation>();
  let trace: EvmCallTrace | undefined;
  let traceFingerprint: string | undefined;
  let chainResponse;

  try {
    chainResponse = await input.client.requestBatch(
      [{ method: 'eth_chainId', operation: 'chain_id', params: [] }],
      { signal: input.signal },
    );
  } catch (error) {
    if (error instanceof EvmExecutionRpcRequestError) {
      if (error.code === 'request_aborted') {
        throw error;
      }
      diagnostics.push(requestDiagnostic(error, undefined, 'chain_id'));
      return { diagnostics, pools };
    }
    throw error;
  }

  const chainValid = validateChainOutcome(
    findOutcome(chainResponse.outcomes, 'chain_id'),
    input.input.chainId,
    input.client.providerId,
    chainResponse.attempts,
    diagnostics,
  );
  if (!chainValid) {
    return { diagnostics, pools };
  }

  if (input.traceClient !== undefined) {
    const traceResponse = await input.traceClient.requestTrace(input.input.transactionHash, {
      signal: input.signal,
    });
    if (!traceResponse.ok) {
      diagnostics.push({
        attempts: traceResponse.attempts,
        code: traceResponse.code,
        operation: 'trace',
        providerId: input.traceClient.providerId,
        retryable: traceResponse.retryable,
        ...(traceResponse.httpStatus === undefined ? {} : { httpStatus: traceResponse.httpStatus }),
      });
    } else {
      try {
        trace = normalizeCallTracerResult(traceResponse.result, {
          chainId: input.input.chainId,
          observedAt: input.observedAt,
          payloadHash: traceResponse.payloadHash,
          providerId: input.traceClient.providerId,
          sourceKind: 'explorer',
          transactionHash: input.input.transactionHash,
        });
        traceFingerprint = fingerprintCallTrace(trace);
        diagnostics.push({
          attempts: traceResponse.attempts,
          code: 'explorer_trace_partial_evidence',
          operation: 'trace',
          providerId: input.traceClient.providerId,
          retryable: false,
        });
      } catch (error) {
        if (!(error instanceof EvmTraceNormalizationError)) {
          throw error;
        }
        diagnostics.push({
          attempts: traceResponse.attempts,
          code: error.code,
          operation: 'trace',
          providerId: input.traceClient.providerId,
          retryable: false,
        });
      }
    }
  } else {
    try {
      const traceResponse = await input.client.requestBatch(
        [
          {
            method: 'debug_traceTransaction',
            operation: 'trace',
            params: [
              input.input.transactionHash,
              {
                timeout: CALL_TRACER_SERVER_TIMEOUT,
                tracer: 'callTracer',
                tracerConfig: { onlyTopCall: false, withLog: false },
              },
            ],
          },
        ],
        { signal: input.signal },
      );
      const traceOutcome = findOutcome(traceResponse.outcomes, 'trace');
      if (traceOutcome === undefined || !traceOutcome.ok) {
        diagnostics.push({
          attempts: traceResponse.attempts,
          code: 'rpc_error',
          operation: 'trace',
          providerId: input.client.providerId,
          retryable: false,
          ...(traceOutcome?.ok === false ? { rpcCode: traceOutcome.error.code } : {}),
        });
      } else if (traceOutcome.result === null || traceOutcome.result === undefined) {
        diagnostics.push({
          attempts: traceResponse.attempts,
          code: 'trace_not_found',
          operation: 'trace',
          providerId: input.client.providerId,
          retryable: false,
        });
      } else {
        try {
          trace = normalizeCallTracerResult(traceOutcome.result, {
            chainId: input.input.chainId,
            observedAt: input.observedAt,
            payloadHash: combinePayloadHashes([
              chainResponse.payloadHash,
              traceResponse.payloadHash,
            ]),
            providerId: input.client.providerId,
            transactionHash: input.input.transactionHash,
          });
          traceFingerprint = fingerprintCallTrace(trace);
        } catch (error) {
          if (!(error instanceof EvmTraceNormalizationError)) {
            throw error;
          }
          diagnostics.push({
            attempts: traceResponse.attempts,
            code: error.code,
            operation: 'trace',
            providerId: input.client.providerId,
            retryable: false,
          });
        }
      }
    } catch (error) {
      if (error instanceof EvmExecutionRpcRequestError) {
        if (error.code === 'request_aborted') {
          throw error;
        }
        diagnostics.push(requestDiagnostic(error, undefined, 'trace'));
      } else {
        throw error;
      }
    }
  }

  const blockTag = decimalToRpcQuantity(input.input.blockNumber);
  for (const pool of input.pools) {
    const observation = await loadPoolObservation({
      blockTag,
      chain: input.chain,
      chainPayloadHash: chainResponse.payloadHash,
      client: input.client,
      observedAt: input.observedAt,
      pool,
      signal: input.signal,
    });
    diagnostics.push(...observation.diagnostics);
    if (observation.pool !== undefined) {
      pools.set(pool.poolAddress, observation.pool);
    }
  }

  return { diagnostics, pools, trace, traceFingerprint };
}

async function loadPoolObservation(input: {
  blockTag: string;
  chain: EvmExecutionChainConfig;
  chainPayloadHash: string;
  client: ExecutionJsonRpcClient;
  observedAt: string;
  pool: EvmPoolCandidate;
  signal?: AbortSignal | undefined;
}): Promise<{
  diagnostics: EvmExecutionDataAdapterDiagnostic[];
  pool?: PoolObservation | undefined;
}> {
  const diagnostics: EvmExecutionDataAdapterDiagnostic[] = [];
  const phaseOneCalls = poolReadCalls(input.pool, input.blockTag);
  let phaseOne;
  try {
    phaseOne = await input.client.requestBatch(phaseOneCalls, { signal: input.signal });
  } catch (error) {
    if (error instanceof EvmExecutionRpcRequestError) {
      if (error.code === 'request_aborted') {
        throw error;
      }
      diagnostics.push(requestDiagnostic(error, input.pool.poolAddress));
      return { diagnostics };
    }
    throw error;
  }

  const failedPoolCall = firstFailedOutcome(phaseOne.outcomes);
  if (failedPoolCall !== undefined) {
    diagnostics.push(
      outcomeDiagnostic(
        failedPoolCall,
        'pool_call_failed',
        input.client.providerId,
        phaseOne.attempts,
        failedPoolCall.call.operation,
        input.pool.poolAddress,
      ),
    );
    return { diagnostics };
  }

  const code = parseBytecode(resultFor(phaseOne.outcomes, 'pool_code'));
  if (code === undefined) {
    diagnostics.push(
      poolDiagnostic('pool_response_invalid', input, phaseOne.attempts, 'pool_code'),
    );
    return { diagnostics };
  }
  if (code === '0x') {
    diagnostics.push(poolDiagnostic('pool_code_missing', input, phaseOne.attempts, 'pool_code'));
    return { diagnostics };
  }
  const factoryAddress = decodeAbiAddress(resultFor(phaseOne.outcomes, 'pool_factory'));
  if (factoryAddress === undefined) {
    diagnostics.push(
      poolDiagnostic('pool_response_invalid', input, phaseOne.attempts, 'pool_factory'),
    );
    return { diagnostics };
  }
  const token0 = decodeAbiAddress(resultFor(phaseOne.outcomes, 'pool_token0'));
  if (token0 === undefined) {
    diagnostics.push(
      poolDiagnostic('pool_response_invalid', input, phaseOne.attempts, 'pool_token0'),
    );
    return { diagnostics };
  }
  const token1 = decodeAbiAddress(resultFor(phaseOne.outcomes, 'pool_token1'));
  if (token1 === undefined) {
    diagnostics.push(
      poolDiagnostic('pool_response_invalid', input, phaseOne.attempts, 'pool_token1'),
    );
    return { diagnostics };
  }
  if (token0 === EVM_ZERO_ADDRESS || token1 === EVM_ZERO_ADDRESS) {
    diagnostics.push(
      poolDiagnostic('pool_token_address_invalid', input, phaseOne.attempts, 'pool_token0'),
    );
    return { diagnostics };
  }
  if (token0 >= token1) {
    diagnostics.push(
      poolDiagnostic('pool_token_order_invalid', input, phaseOne.attempts, 'pool_token0'),
    );
    return { diagnostics };
  }
  const allowedFactories = factoryAllowlistForProtocol(input.chain, input.pool.protocol);
  if (!allowedFactories.includes(factoryAddress)) {
    diagnostics.push(
      poolDiagnostic('pool_factory_not_allowed', input, phaseOne.attempts, 'pool_factory'),
    );
    return { diagnostics };
  }

  let fee: string | undefined;
  if (input.pool.protocol === 'uniswap_v3') {
    fee = decodeAbiUint24(resultFor(phaseOne.outcomes, 'pool_fee'));
    if (fee === undefined || fee === '0' || BigInt(fee) >= 1_000_000n) {
      diagnostics.push(poolDiagnostic('pool_fee_invalid', input, phaseOne.attempts, 'pool_fee'));
      return { diagnostics };
    }
  }

  const phaseTwoCalls = factoryVerificationCalls({
    blockTag: input.blockTag,
    factoryAddress,
    fee,
    pool: input.pool,
    token0,
    token1,
  });
  let phaseTwo;
  try {
    phaseTwo = await input.client.requestBatch(phaseTwoCalls, { signal: input.signal });
  } catch (error) {
    if (error instanceof EvmExecutionRpcRequestError) {
      if (error.code === 'request_aborted') {
        throw error;
      }
      diagnostics.push(requestDiagnostic(error, input.pool.poolAddress));
      return { diagnostics };
    }
    throw error;
  }

  const failedFactoryCall = firstFailedOutcome(phaseTwo.outcomes);
  if (failedFactoryCall !== undefined) {
    diagnostics.push(
      outcomeDiagnostic(
        failedFactoryCall,
        'pool_call_failed',
        input.client.providerId,
        phaseTwo.attempts,
        failedFactoryCall.call.operation,
        input.pool.poolAddress,
      ),
    );
    return { diagnostics };
  }
  const factoryCode = parseBytecode(resultFor(phaseTwo.outcomes, 'factory_code'));
  if (factoryCode === undefined) {
    diagnostics.push(
      poolDiagnostic('pool_response_invalid', input, phaseTwo.attempts, 'factory_code'),
    );
    return { diagnostics };
  }
  if (factoryCode === '0x') {
    diagnostics.push(
      poolDiagnostic('factory_code_missing', input, phaseTwo.attempts, 'factory_code'),
    );
    return { diagnostics };
  }
  const registeredPool = decodeAbiAddress(resultFor(phaseTwo.outcomes, 'factory_lookup'));
  if (registeredPool === undefined) {
    diagnostics.push(
      poolDiagnostic('pool_response_invalid', input, phaseTwo.attempts, 'factory_lookup'),
    );
    return { diagnostics };
  }
  if (registeredPool !== input.pool.poolAddress) {
    diagnostics.push(
      poolDiagnostic('factory_lookup_mismatch', input, phaseTwo.attempts, 'factory_lookup'),
    );
    return { diagnostics };
  }

  const source = {
    id: input.client.providerId,
    kind: 'rpc' as const,
    observedAt: input.observedAt,
    payloadHash: combinePayloadHashes([
      input.chainPayloadHash,
      phaseOne.payloadHash,
      phaseTwo.payloadHash,
    ]),
  };
  const verification = evmVerifiedPoolSchema.parse({
    chainId: input.chain.chainId,
    factoryAddress,
    factoryCodeHash: hashBytecode(factoryCode),
    ...(fee === undefined ? {} : { fee }),
    poolAddress: input.pool.poolAddress,
    poolCodeHash: hashBytecode(code),
    protocol: input.pool.protocol,
    source,
    token0,
    token1,
  });
  const metadata = evmPoolMetadataEntrySchema.parse({
    chainId: verification.chainId,
    poolAddress: verification.poolAddress,
    protocol: verification.protocol,
    source,
    token0: verification.token0,
    token1: verification.token1,
  });

  return {
    diagnostics,
    pool: {
      fingerprint: fingerprintVerifiedPool(verification),
      metadata,
      verification,
    },
  };
}

function validateChainOutcome(
  outcome: ExecutionRpcCallOutcome | undefined,
  expectedChainId: string,
  providerId: string,
  attempts: number,
  diagnostics: EvmExecutionDataAdapterDiagnostic[],
): boolean {
  if (outcome === undefined || !outcome.ok) {
    diagnostics.push(
      outcomeDiagnostic(outcome, 'chain_id_unavailable', providerId, attempts, 'chain_id'),
    );
    return false;
  }
  let actualChainId: string;
  try {
    actualChainId = rpcQuantityToDecimal(rpcHexQuantitySchema.parse(outcome.result));
  } catch {
    diagnostics.push({
      attempts,
      code: 'invalid_chain_id_payload',
      operation: 'chain_id',
      providerId,
      retryable: false,
    });
    return false;
  }
  if (actualChainId !== expectedChainId) {
    diagnostics.push({
      attempts,
      code: 'chain_id_mismatch',
      operation: 'chain_id',
      providerId,
      retryable: false,
    });
    return false;
  }
  return true;
}

function poolReadCalls(pool: EvmPoolCandidate, blockTag: string): ExecutionRpcCall[] {
  return [
    {
      method: 'eth_getCode',
      operation: 'pool_code',
      params: [pool.poolAddress, blockTag],
      poolAddress: pool.poolAddress,
    },
    poolCall('pool_factory', POOL_FACTORY_SELECTOR, pool.poolAddress, blockTag),
    poolCall('pool_token0', POOL_TOKEN0_SELECTOR, pool.poolAddress, blockTag),
    poolCall('pool_token1', POOL_TOKEN1_SELECTOR, pool.poolAddress, blockTag),
    ...(pool.protocol === 'uniswap_v3'
      ? [poolCall('pool_fee', UNISWAP_V3_FEE_SELECTOR, pool.poolAddress, blockTag)]
      : []),
  ];
}

function poolCall(
  operation: 'pool_factory' | 'pool_token0' | 'pool_token1' | 'pool_fee',
  data: string,
  poolAddress: string,
  blockTag: string,
): ExecutionRpcCall {
  return {
    method: 'eth_call',
    operation,
    params: [{ data, to: poolAddress }, blockTag],
    poolAddress,
  };
}

function factoryVerificationCalls(input: {
  blockTag: string;
  factoryAddress: string;
  fee: string | undefined;
  pool: EvmPoolCandidate;
  token0: string;
  token1: string;
}): ExecutionRpcCall[] {
  return [
    {
      factoryAddress: input.factoryAddress,
      method: 'eth_getCode',
      operation: 'factory_code',
      params: [input.factoryAddress, input.blockTag],
      poolAddress: input.pool.poolAddress,
    },
    {
      factoryAddress: input.factoryAddress,
      method: 'eth_call',
      operation: 'factory_lookup',
      params: [
        {
          data:
            input.pool.protocol === 'uniswap_v2'
              ? encodeV2GetPair(input.token0, input.token1)
              : encodeV3GetPool(input.token0, input.token1, requireFee(input.fee)),
          to: input.factoryAddress,
        },
        input.blockTag,
      ],
      poolAddress: input.pool.poolAddress,
    },
  ];
}

function encodeV2GetPair(token0: string, token1: string): string {
  return `${UNISWAP_V2_GET_PAIR_SELECTOR}${encodeAddressWord(token0)}${encodeAddressWord(token1)}`;
}

function encodeV3GetPool(token0: string, token1: string, fee: string): string {
  return `${UNISWAP_V3_GET_POOL_SELECTOR}${encodeAddressWord(token0)}${encodeAddressWord(token1)}${encodeUintWord(fee)}`;
}

function encodeAddressWord(address: string): string {
  return evmAddressSchema.parse(address).slice(2).padStart(64, '0');
}

function encodeUintWord(value: string): string {
  return BigInt(value).toString(16).padStart(64, '0');
}

function requireFee(fee: string | undefined): string {
  if (fee === undefined) {
    throw new EvmExecutionDataAdapterConfigurationError(
      'invalid_configuration',
      'Uniswap V3 factory verification requires a decoded fee.',
    );
  }
  return fee;
}

function decodeAbiAddress(input: unknown): string | undefined {
  if (typeof input !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/u.test(input)) {
    return undefined;
  }
  try {
    return evmAddressSchema.parse(`0x${input.slice(-40)}`);
  } catch {
    return undefined;
  }
}

function decodeAbiUint24(input: unknown): string | undefined {
  if (typeof input !== 'string' || !/^0x0{58}[0-9a-fA-F]{6}$/u.test(input)) {
    return undefined;
  }
  return BigInt(input).toString(10);
}

function parseBytecode(input: unknown): string | undefined {
  try {
    return evmBytesSchema.parse(input);
  } catch {
    return undefined;
  }
}

function hashBytecode(bytecode: string): string {
  return `sha256:${createHash('sha256')
    .update(Buffer.from(bytecode.slice(2), 'hex'))
    .digest('hex')}`;
}

function combinePayloadHashes(hashes: readonly string[]): string {
  return `sha256:${createHash('sha256').update(hashes.join('\n')).digest('hex')}`;
}

function fingerprintVerifiedPool(pool: EvmVerifiedPool): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        chainId: pool.chainId,
        factoryAddress: pool.factoryAddress,
        factoryCodeHash: pool.factoryCodeHash,
        fee: pool.fee ?? null,
        poolAddress: pool.poolAddress,
        poolCodeHash: pool.poolCodeHash,
        protocol: pool.protocol,
        token0: pool.token0,
        token1: pool.token1,
      }),
    )
    .digest('hex')}`;
}

function collectCanonicalPools(
  requestedPools: readonly EvmPoolCandidate[],
  observations: readonly ProviderObservation[],
): PoolObservation[] {
  const canonical: PoolObservation[] = [];
  for (const requestedPool of requestedPools) {
    const value = firstDefined(
      observations.map((observation) => observation.pools.get(requestedPool.poolAddress)),
    );
    if (value !== undefined) {
      canonical.push(value);
    }
  }
  return canonical;
}

function collectConflicts(
  input: LoadEvmExecutionDataInput,
  observations: readonly ProviderObservation[],
): EvmExecutionDataConflict[] {
  const conflicts: EvmExecutionDataConflict[] = [];
  const traceObservations = observations.flatMap((observation) =>
    observation.traceFingerprint === undefined || observation.trace === undefined
      ? []
      : [
          {
            fingerprint: observation.traceFingerprint,
            providerId: observation.trace.source.id,
          },
        ],
  );
  if (new Set(traceObservations.map((observation) => observation.fingerprint)).size >= 2) {
    conflicts.push({
      field: 'trace',
      observations: traceObservations,
      subject: input.transactionHash,
    });
  }

  for (const pool of input.pools) {
    const poolObservations = observations.flatMap((observation) => {
      const observedPool = observation.pools.get(pool.poolAddress);
      return observedPool === undefined
        ? []
        : [
            {
              fingerprint: observedPool.fingerprint,
              providerId: observedPool.metadata.source.id,
            },
          ];
    });
    if (new Set(poolObservations.map((observation) => observation.fingerprint)).size >= 2) {
      conflicts.push({
        field: 'pool_metadata',
        observations: poolObservations,
        subject: pool.poolAddress,
      });
    }
  }
  return conflicts;
}

function findOutcome(
  outcomes: readonly ExecutionRpcCallOutcome[],
  operation: ExecutionRpcCall['operation'],
): ExecutionRpcCallOutcome | undefined {
  return outcomes.find((outcome) => outcome.call.operation === operation);
}

function resultFor(
  outcomes: readonly ExecutionRpcCallOutcome[],
  operation: ExecutionRpcCall['operation'],
): unknown {
  const outcome = findOutcome(outcomes, operation);
  return outcome?.ok === true ? outcome.result : undefined;
}

function firstFailedOutcome(
  outcomes: readonly ExecutionRpcCallOutcome[],
): Extract<ExecutionRpcCallOutcome, { ok: false }> | undefined {
  return outcomes.find(
    (outcome): outcome is Extract<ExecutionRpcCallOutcome, { ok: false }> => !outcome.ok,
  );
}

function outcomeDiagnostic(
  outcome: ExecutionRpcCallOutcome | undefined,
  code: 'chain_id_unavailable' | 'pool_call_failed' | 'rpc_error',
  providerId: string,
  attempts: number,
  operation: ExecutionRpcCall['operation'],
  poolAddress?: string,
): EvmExecutionDataAdapterDiagnostic {
  return {
    attempts,
    code,
    operation,
    ...(poolAddress === undefined ? {} : { poolAddress }),
    providerId,
    retryable: false,
    ...(outcome?.ok === false ? { rpcCode: outcome.error.code } : {}),
  };
}

function requestDiagnostic(
  error: EvmExecutionRpcRequestError,
  poolAddress?: string,
  operation?: ExecutionRpcCall['operation'],
): EvmExecutionDataAdapterDiagnostic {
  if (error.code === 'request_aborted') {
    throw error;
  }
  return {
    attempts: error.attempts,
    code: error.code,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(operation === undefined ? {} : { operation }),
    ...(poolAddress === undefined ? {} : { poolAddress }),
    providerId: error.providerId,
    retryable: error.retryable,
  };
}

function poolDiagnostic(
  code:
    | 'factory_code_missing'
    | 'factory_lookup_mismatch'
    | 'pool_code_missing'
    | 'pool_factory_not_allowed'
    | 'pool_fee_invalid'
    | 'pool_response_invalid'
    | 'pool_token_address_invalid'
    | 'pool_token_order_invalid',
  input: { client: ExecutionJsonRpcClient; pool: EvmPoolCandidate },
  attempts: number,
  operation: ExecutionRpcCall['operation'],
): EvmExecutionDataAdapterDiagnostic {
  return {
    attempts,
    code,
    operation,
    poolAddress: input.pool.poolAddress,
    providerId: input.client.providerId,
    retryable: false,
  };
}

function factoryAllowlistForProtocol(
  chain: EvmExecutionChainConfig,
  protocol: EvmPoolCandidate['protocol'],
): string[] {
  return protocol === 'uniswap_v2' ? chain.factories.uniswapV2 : chain.factories.uniswapV3;
}

function boundedPoolCandidateLimit(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_POOL_CANDIDATES;
  if (
    !Number.isInteger(normalized) ||
    normalized < 0 ||
    normalized > ABSOLUTE_MAX_POOL_CANDIDATES
  ) {
    throw new EvmExecutionDataAdapterConfigurationError(
      'invalid_limits',
      `maxPoolCandidates must be an integer between 0 and ${ABSOLUTE_MAX_POOL_CANDIDATES}.`,
    );
  }
  return normalized;
}

function createObservedAt(now: () => Date): string {
  const observedAt = now();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    throw new EvmExecutionDataAdapterConfigurationError(
      'invalid_configuration',
      'EVM execution data adapter clock returned an invalid date.',
    );
  }
  return observedAt.toISOString();
}

function firstDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}
