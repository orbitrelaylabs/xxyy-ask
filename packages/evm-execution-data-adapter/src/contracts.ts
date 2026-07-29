import { z } from 'zod';

import { evmRpcProviderConfigSchema, evmRpcProviderIdSchema } from '@xxyy/evm-data-adapter';
import {
  MAX_SWAP_EVENTS,
  evmCallTraceSchema,
  evmPoolMetadataSchema,
} from '@xxyy/evm-execution-enrichment-core';
import {
  EVM_ZERO_ADDRESS,
  evmAddressSchema,
  evmChainIdSchema,
  evmHashSchema,
  evmUintSchema,
} from '@xxyy/transaction-analysis-core';

export const EVM_EXECUTION_DATA_ADAPTER_VERSION = '0.1.0' as const;
export const MAX_EXECUTION_PROVIDERS = 4;
export const MAX_CONFIGURED_FACTORIES_PER_PROTOCOL = 32;
export const ABSOLUTE_MAX_POOL_CANDIDATES = MAX_SWAP_EVENTS;

export const POOL_FACTORY_SELECTOR = '0xc45a0155' as const;
export const POOL_TOKEN0_SELECTOR = '0x0dfe1681' as const;
export const POOL_TOKEN1_SELECTOR = '0xd21220a7' as const;
export const UNISWAP_V3_FEE_SELECTOR = '0xddca3f43' as const;
export const UNISWAP_V2_GET_PAIR_SELECTOR = '0xe6a43905' as const;
export const UNISWAP_V3_GET_POOL_SELECTOR = '0x1698ee82' as const;

export const executionRpcOperations = [
  'chain_id',
  'trace',
  'pool_code',
  'pool_factory',
  'pool_token0',
  'pool_token1',
  'pool_fee',
  'factory_code',
  'factory_lookup',
] as const;

export const executionRpcMethods = [
  'debug_traceTransaction',
  'eth_call',
  'eth_chainId',
  'eth_getCode',
] as const;

export const evmExecutionDataAdapterDiagnosticCodes = [
  'chain_id_mismatch',
  'chain_id_unavailable',
  'explorer_trace_partial_evidence',
  'factory_code_missing',
  'factory_lookup_mismatch',
  'http_error',
  'invalid_chain_id_payload',
  'invalid_json',
  'invalid_jsonrpc',
  'pool_call_failed',
  'pool_code_missing',
  'pool_factory_not_allowed',
  'pool_fee_invalid',
  'pool_protocol_not_configured',
  'pool_response_invalid',
  'pool_token_address_invalid',
  'pool_token_order_invalid',
  'request_timeout',
  'response_too_large',
  'rpc_error',
  'trace_bytes_limit_exceeded',
  'trace_depth_limit_exceeded',
  'trace_invalid',
  'trace_node_limit_exceeded',
  'trace_not_found',
  'transport_error',
] as const;

export type ExecutionRpcOperation = (typeof executionRpcOperations)[number];
export type ExecutionRpcMethod = (typeof executionRpcMethods)[number];
export type EvmExecutionDataAdapterDiagnosticCode =
  (typeof evmExecutionDataAdapterDiagnosticCodes)[number];

const uniqueAddressesSchema = z
  .array(evmAddressSchema)
  .max(MAX_CONFIGURED_FACTORIES_PER_PROTOCOL)
  .refine((addresses) => addresses.every((address) => address !== EVM_ZERO_ADDRESS), {
    message: 'Factory addresses cannot be the zero address.',
  })
  .refine((addresses) => new Set(addresses).size === addresses.length, {
    message: 'Factory addresses must be unique.',
  });

export const evmBlockscoutTraceSourceConfigSchema = z
  .object({
    endpoint: z.string().trim().max(2_048).url(),
    id: evmRpcProviderIdSchema,
    kind: z.literal('blockscout_v2'),
  })
  .strict();

export const evmExecutionProviderConfigSchema = evmRpcProviderConfigSchema.extend({
  traceSource: evmBlockscoutTraceSourceConfigSchema.optional(),
});

export const evmExecutionFactoryAllowlistSchema = z
  .object({
    uniswapV2: uniqueAddressesSchema.default([]),
    uniswapV3: uniqueAddressesSchema.default([]),
  })
  .strict()
  .superRefine((factories, context) => {
    const v2 = new Set(factories.uniswapV2);
    for (const [index, address] of factories.uniswapV3.entries()) {
      if (v2.has(address)) {
        context.addIssue({
          code: 'custom',
          message: 'A factory cannot be allowlisted as both Uniswap V2 and V3.',
          path: ['uniswapV3', index],
        });
      }
    }
  });

export const evmExecutionChainConfigSchema = z
  .object({
    chainId: evmChainIdSchema,
    factories: evmExecutionFactoryAllowlistSchema,
    providers: z
      .array(evmExecutionProviderConfigSchema)
      .min(1)
      .max(MAX_EXECUTION_PROVIDERS)
      .refine(
        (providers) => new Set(providers.map((provider) => provider.id)).size === providers.length,
        { message: 'Provider ids must be unique within a chain.' },
      )
      .refine(
        (providers) =>
          new Set(
            providers.map((provider) => provider.traceSource?.id).filter((id) => id !== undefined),
          ).size === providers.filter((provider) => provider.traceSource !== undefined).length,
        { message: 'Trace source ids must be unique within a chain.' },
      ),
  })
  .strict();

export const evmExecutionDataAdapterConfigSchema = z
  .array(evmExecutionChainConfigSchema)
  .min(1)
  .max(64)
  .refine((chains) => new Set(chains.map((chain) => chain.chainId)).size === chains.length, {
    message: 'Chain ids must be unique.',
  });

export const evmPoolCandidateSchema = z
  .object({
    poolAddress: evmAddressSchema,
    protocol: z.enum(['uniswap_v2', 'uniswap_v3']),
  })
  .strict()
  .refine((pool) => pool.poolAddress !== EVM_ZERO_ADDRESS, {
    message: 'Pool address cannot be the zero address.',
    path: ['poolAddress'],
  });

export const loadEvmExecutionDataInputSchema = z
  .object({
    blockNumber: evmUintSchema,
    chainId: evmChainIdSchema,
    pools: z
      .array(evmPoolCandidateSchema)
      .max(ABSOLUTE_MAX_POOL_CANDIDATES)
      .refine((pools) => new Set(pools.map((pool) => pool.poolAddress)).size === pools.length, {
        message: 'Pool candidate addresses must be unique.',
      })
      .default([]),
    providerIds: z
      .array(evmRpcProviderIdSchema)
      .min(1)
      .max(MAX_EXECUTION_PROVIDERS)
      .refine((providerIds) => new Set(providerIds).size === providerIds.length, {
        message: 'Provider ids must be unique.',
      })
      .optional(),
    transactionHash: evmHashSchema,
  })
  .strict();

const payloadHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, 'Expected a SHA-256 payload fingerprint.');

const observedSourceSchema = z
  .object({
    id: evmRpcProviderIdSchema,
    kind: z.literal('rpc'),
    observedAt: z.string().datetime({ offset: true }),
    payloadHash: payloadHashSchema,
  })
  .strict();

export const evmVerifiedPoolSchema = z
  .object({
    chainId: evmChainIdSchema,
    factoryAddress: evmAddressSchema,
    factoryCodeHash: payloadHashSchema,
    fee: evmUintSchema.optional(),
    poolAddress: evmAddressSchema,
    poolCodeHash: payloadHashSchema,
    protocol: z.enum(['uniswap_v2', 'uniswap_v3']),
    source: observedSourceSchema,
    token0: evmAddressSchema,
    token1: evmAddressSchema,
  })
  .strict()
  .superRefine((pool, context) => {
    for (const field of ['factoryAddress', 'poolAddress', 'token0', 'token1'] as const) {
      if (pool[field] === EVM_ZERO_ADDRESS) {
        context.addIssue({
          code: 'custom',
          message: `${field} cannot be the zero address.`,
          path: [field],
        });
      }
    }
    if (pool.token0 >= pool.token1) {
      context.addIssue({
        code: 'custom',
        message: 'Verified pool tokens must be strictly address-sorted.',
        path: ['token1'],
      });
    }
    if (pool.protocol === 'uniswap_v2' && pool.fee !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Uniswap V2 pool verification must omit fee.',
        path: ['fee'],
      });
    }
    if (pool.protocol === 'uniswap_v3' && pool.fee === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Uniswap V3 pool verification requires fee.',
        path: ['fee'],
      });
    }
  });

const conflictObservationSchema = z
  .object({
    fingerprint: payloadHashSchema,
    providerId: evmRpcProviderIdSchema,
  })
  .strict();

export const evmExecutionDataConflictSchema = z
  .object({
    field: z.enum(['pool_metadata', 'trace']),
    observations: z
      .array(conflictObservationSchema)
      .min(2)
      .max(MAX_EXECUTION_PROVIDERS)
      .refine(
        (observations) =>
          new Set(observations.map((observation) => observation.providerId)).size ===
          observations.length,
        'Conflict observations require unique providers.',
      )
      .refine(
        (observations) =>
          new Set(observations.map((observation) => observation.fingerprint)).size >= 2,
        'Conflict observations require distinct values.',
      ),
    subject: z.union([evmAddressSchema, evmHashSchema]),
  })
  .strict();

export const evmExecutionDataAdapterDiagnosticSchema = z
  .object({
    attempts: z.number().int().positive().max(3).optional(),
    code: z.enum(evmExecutionDataAdapterDiagnosticCodes),
    httpStatus: z.number().int().min(100).max(599).optional(),
    operation: z.enum(executionRpcOperations).optional(),
    poolAddress: evmAddressSchema.optional(),
    providerId: evmRpcProviderIdSchema.optional(),
    retryable: z.boolean(),
    rpcCode: z.number().int().optional(),
  })
  .strict();

export const evmExecutionDataAdapterResultSchema = z
  .object({
    conflicts: z.array(evmExecutionDataConflictSchema).max(ABSOLUTE_MAX_POOL_CANDIDATES + 1),
    diagnostics: z.array(evmExecutionDataAdapterDiagnosticSchema).max(5_000),
    poolMetadata: evmPoolMetadataSchema,
    status: z.enum(['success', 'partial', 'insufficient_data']),
    trace: evmCallTraceSchema.optional(),
    verifiedPools: z.array(evmVerifiedPoolSchema).max(ABSOLUTE_MAX_POOL_CANDIDATES),
    version: z.literal(EVM_EXECUTION_DATA_ADAPTER_VERSION),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.poolMetadata.length !== result.verifiedPools.length) {
      context.addIssue({
        code: 'custom',
        message: 'Pool metadata and verification counts must match.',
        path: ['verifiedPools'],
      });
    }
    for (const [index, verification] of result.verifiedPools.entries()) {
      const metadata = result.poolMetadata[index];
      if (
        metadata === undefined ||
        metadata.chainId !== verification.chainId ||
        metadata.poolAddress !== verification.poolAddress ||
        metadata.protocol !== verification.protocol ||
        metadata.token0 !== verification.token0 ||
        metadata.token1 !== verification.token1 ||
        metadata.source.id !== verification.source.id ||
        metadata.source.kind !== verification.source.kind ||
        metadata.source.observedAt !== verification.source.observedAt ||
        metadata.source.payloadHash !== verification.source.payloadHash
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Pool metadata must match its verified pool fact.',
          path: ['poolMetadata', index],
        });
      }
    }
    if (
      result.status === 'success' &&
      (result.diagnostics.length > 0 || result.conflicts.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Successful adapter results cannot contain diagnostics or conflicts.',
        path: ['status'],
      });
    }
    if (
      result.status === 'insufficient_data' &&
      (result.trace !== undefined || result.poolMetadata.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Insufficient adapter results cannot contain usable execution data.',
        path: ['status'],
      });
    }
  });

export type EvmExecutionChainConfig = z.output<typeof evmExecutionChainConfigSchema>;
export type EvmBlockscoutTraceSourceConfig = z.output<typeof evmBlockscoutTraceSourceConfigSchema>;
export type EvmExecutionProviderConfig = z.output<typeof evmExecutionProviderConfigSchema>;
export type EvmExecutionFactoryAllowlist = z.output<typeof evmExecutionFactoryAllowlistSchema>;
export type EvmPoolCandidate = z.output<typeof evmPoolCandidateSchema>;
export type LoadEvmExecutionDataInput = z.output<typeof loadEvmExecutionDataInputSchema>;
export type EvmVerifiedPool = z.output<typeof evmVerifiedPoolSchema>;
export type EvmExecutionDataConflict = z.output<typeof evmExecutionDataConflictSchema>;
export type EvmExecutionDataAdapterDiagnostic = z.output<
  typeof evmExecutionDataAdapterDiagnosticSchema
>;
export type EvmExecutionDataAdapterResult = z.output<typeof evmExecutionDataAdapterResultSchema>;
