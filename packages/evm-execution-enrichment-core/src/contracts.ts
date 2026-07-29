import { z } from 'zod';

import { createSkillResultSchema } from '@xxyy/shared';
import {
  evmAddressSchema,
  evmChainIdSchema,
  evmHashSchema,
  evmSignedIntegerSchema,
  evmTransactionSnapshotSchema,
  evmUintSchema,
} from '@xxyy/transaction-analysis-core';

export const EVM_EXECUTION_ENRICHMENT_SKILL = 'evm_execution_enrichment' as const;
export const EVM_EXECUTION_ENRICHMENT_VERSION = '1.0.0' as const;
export const MAX_TRACE_NODES = 250;
export const MAX_TRACE_DEPTH = 32;
export const MAX_TRACE_BYTES = 8_192;
export const MAX_SWAP_EVENTS = 250;

export const UNISWAP_V2_SWAP_TOPIC =
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822' as const;
export const UNISWAP_V3_SWAP_TOPIC =
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67' as const;
export const UNISWAP_V4_SWAP_TOPIC =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as const;
export const BAGS_BONDING_CURVE_TOKENS_BOUGHT_TOPIC =
  '0x6d9c6fad0db13f6f7fca7124777996deaeb1949d0750a4874c18611ff5d436b9' as const;
export const BAGS_BONDING_CURVE_TOKENS_SOLD_TOPIC =
  '0x813ea2e4b7710a4562c34494d61d6e80fd2ba5105790f740fdcbf64f8b05b80d' as const;
export const SOLIDITY_ERROR_STRING_SELECTOR = '0x08c379a0' as const;
export const SOLIDITY_PANIC_SELECTOR = '0x4e487b71' as const;

const UINT160_MAX = (1n << 160n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const INT24_MIN = -(1n << 23n);
const INT24_MAX = (1n << 23n) - 1n;

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const payloadHashSchema = z
  .string()
  .trim()
  .regex(/^(?:0x[0-9a-fA-F]{64}|sha256:[0-9a-fA-F]{64})$/u)
  .transform((value) => value.toLowerCase());

const boundedBytesSchema = z
  .string()
  .trim()
  .max(MAX_TRACE_BYTES * 2 + 2)
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/u, 'Expected bounded even-length EVM bytes.')
  .transform((value) => value.toLowerCase());

const traceAddressSchema = z.array(z.number().int().nonnegative().max(999)).max(MAX_TRACE_DEPTH);

const traceSourceSchema = z
  .object({
    id: stableIdSchema,
    kind: z.enum(['rpc', 'indexer', 'explorer', 'fixture']),
    observedAt: z.string().datetime({ offset: true }),
    payloadHash: payloadHashSchema.optional(),
  })
  .strict();

export const evmCallTypes = [
  'call',
  'callcode',
  'create',
  'create2',
  'delegatecall',
  'selfdestruct',
  'staticcall',
] as const;

const traceNodeSchema = z
  .object({
    errorCode: stableIdSchema.optional(),
    from: evmAddressSchema,
    gasUsed: evmUintSchema.optional(),
    input: boundedBytesSchema,
    output: boundedBytesSchema.optional(),
    sourceId: stableIdSchema,
    status: z.enum(['success', 'reverted']),
    to: evmAddressSchema.nullable(),
    traceAddress: traceAddressSchema,
    type: z.enum(evmCallTypes),
    value: evmUintSchema,
  })
  .strict()
  .superRefine((node, context) => {
    const isCreation = node.type === 'create' || node.type === 'create2';
    if ((!isCreation || node.status === 'success') && node.to === null) {
      context.addIssue({
        code: 'custom',
        message: 'This trace node requires a destination address.',
        path: ['to'],
      });
    }
    if (node.status === 'success' && node.errorCode !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Successful trace nodes cannot carry an error code.',
        path: ['errorCode'],
      });
    }
  });

export const evmCallTraceSchema = z
  .object({
    chainId: evmChainIdSchema,
    nodes: z.array(traceNodeSchema).min(1).max(MAX_TRACE_NODES),
    source: traceSourceSchema,
    transactionHash: evmHashSchema,
  })
  .strict()
  .superRefine((trace, context) => {
    const paths = new Set<string>();
    let rootCount = 0;

    for (const [index, node] of trace.nodes.entries()) {
      const path = traceAddressKey(node.traceAddress);
      if (paths.has(path)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate trace address: ${path}`,
          path: ['nodes', index, 'traceAddress'],
        });
      }
      paths.add(path);
      if (node.traceAddress.length === 0) {
        rootCount += 1;
      }
      if (node.sourceId !== trace.source.id) {
        context.addIssue({
          code: 'custom',
          message: 'Trace node sourceId must match trace source id.',
          path: ['nodes', index, 'sourceId'],
        });
      }
    }

    if (rootCount !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'A call trace must contain exactly one root node.',
        path: ['nodes'],
      });
    }

    for (const [index, node] of trace.nodes.entries()) {
      if (node.traceAddress.length === 0) {
        continue;
      }
      const parent = traceAddressKey(node.traceAddress.slice(0, -1));
      if (!paths.has(parent)) {
        context.addIssue({
          code: 'custom',
          message: `Trace node is missing parent: ${parent}`,
          path: ['nodes', index, 'traceAddress'],
        });
      }
    }
  });

const poolMetadataSourceSchema = z
  .object({
    id: stableIdSchema,
    kind: z.enum(['rpc', 'indexer', 'explorer', 'fixture', 'registry']),
    observedAt: z.string().datetime({ offset: true }),
    payloadHash: payloadHashSchema.optional(),
  })
  .strict();

export const evmPoolMetadataEntrySchema = z
  .object({
    chainId: evmChainIdSchema,
    poolAddress: evmAddressSchema,
    protocol: z.enum(['uniswap_v2', 'uniswap_v3']),
    source: poolMetadataSourceSchema,
    token0: evmAddressSchema,
    token1: evmAddressSchema,
  })
  .strict()
  .refine((pool) => pool.token0 !== pool.token1, {
    message: 'Pool token0 and token1 must differ.',
    path: ['token1'],
  });

export const evmPoolMetadataSchema = z
  .array(evmPoolMetadataEntrySchema)
  .max(MAX_SWAP_EVENTS)
  .superRefine((pools, context) => {
    const identities = new Set<string>();
    for (const [index, pool] of pools.entries()) {
      const identity = `${pool.chainId}:${pool.poolAddress}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate pool metadata: ${identity}`,
          path: [index, 'poolAddress'],
        });
      }
      identities.add(identity);
    }
  });

export const evmExecutionEnrichmentInputSchema = z
  .object({
    poolMetadata: z.unknown().optional(),
    snapshot: evmTransactionSnapshotSchema,
    trace: z.unknown().optional(),
  })
  .strict();

const evidenceIdsSchema = z
  .array(stableIdSchema)
  .min(1)
  .max(1_000)
  .refine((ids) => new Set(ids).size === ids.length, 'Evidence ids must be unique.');

const internalTransferSchema = z
  .object({
    amountWei: evmUintSchema,
    evidenceId: stableIdSchema,
    from: evmAddressSchema,
    to: evmAddressSchema,
    traceAddress: traceAddressSchema,
    transferType: z.enum(['call', 'create', 'create2', 'selfdestruct']),
  })
  .strict()
  .refine((transfer) => BigInt(transfer.amountWei) > 0n, {
    message: 'Internal transfers must have a positive amount.',
    path: ['amountWei'],
  });

const nativeAssetChangeSchema = z
  .object({
    address: evmAddressSchema,
    chainId: evmChainIdSchema,
    evidenceIds: evidenceIdsSchema,
    rawDelta: evmSignedIntegerSchema,
  })
  .strict()
  .refine((change) => change.rawDelta !== '0', {
    message: 'Zero native asset changes must be omitted.',
    path: ['rawDelta'],
  });

const revertArtifactSchema = z
  .object({
    callType: z.enum(evmCallTypes),
    dataLengthBytes: z.number().int().nonnegative().max(MAX_TRACE_BYTES),
    evidenceId: stableIdSchema,
    from: evmAddressSchema,
    kind: z.enum(['custom_error', 'empty', 'error_string', 'malformed', 'panic']),
    panicCode: evmUintSchema.optional(),
    panicDescription: z.string().trim().min(1).max(500).optional(),
    reason: z
      .string()
      .max(1_000)
      .refine((value) => !/\p{Cc}/u.test(value), 'Control characters are not allowed.')
      .optional(),
    selector: z
      .string()
      .regex(/^0x[0-9a-f]{8}$/u)
      .optional(),
    to: evmAddressSchema.nullable(),
    traceAddress: traceAddressSchema,
  })
  .strict();

const swapBaseShape = {
  amount0PoolDeltaRaw: evmSignedIntegerSchema,
  amount1PoolDeltaRaw: evmSignedIntegerSchema,
  amountInRaw: evmUintSchema.optional(),
  amountOutRaw: evmUintSchema.optional(),
  direction: z.enum(['ambiguous', 'token0_to_token1', 'token1_to_token0']),
  evidenceIds: z
    .array(stableIdSchema)
    .min(2)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, 'Swap evidence ids must be unique.'),
  logIndex: z.number().int().nonnegative().max(1_000_000),
  poolAddress: evmAddressSchema,
  recipient: evmAddressSchema,
  sender: evmAddressSchema,
  token0: evmAddressSchema,
  token1: evmAddressSchema,
  tokenIn: evmAddressSchema.optional(),
  tokenOut: evmAddressSchema.optional(),
} as const;

const uniswapV2SwapSchema = z
  .object({
    ...swapBaseShape,
    amount0InRaw: evmUintSchema,
    amount0OutRaw: evmUintSchema,
    amount1InRaw: evmUintSchema,
    amount1OutRaw: evmUintSchema,
    protocol: z.literal('uniswap_v2'),
  })
  .strict();

const uniswapV3SwapSchema = z
  .object({
    ...swapBaseShape,
    liquidity: evmUintSchema,
    protocol: z.literal('uniswap_v3'),
    sqrtPriceX96: evmUintSchema,
    tick: evmSignedIntegerSchema,
  })
  .strict();

export const evmDecodedSwapSchema = z
  .discriminatedUnion('protocol', [uniswapV2SwapSchema, uniswapV3SwapSchema])
  .superRefine((swap, context) => {
    const addIssue = (message: string, path: string[]) =>
      context.addIssue({ code: 'custom', message, path });
    if (swap.token0 === swap.token1) {
      addIssue('Swap token0 and token1 must differ.', ['token1']);
    }

    const delta0 = BigInt(swap.amount0PoolDeltaRaw);
    const delta1 = BigInt(swap.amount1PoolDeltaRaw);
    if (swap.protocol === 'uniswap_v2') {
      if (delta0 !== BigInt(swap.amount0InRaw) - BigInt(swap.amount0OutRaw)) {
        addIssue('V2 amount0 pool delta does not match in minus out.', ['amount0PoolDeltaRaw']);
      }
      if (delta1 !== BigInt(swap.amount1InRaw) - BigInt(swap.amount1OutRaw)) {
        addIssue('V2 amount1 pool delta does not match in minus out.', ['amount1PoolDeltaRaw']);
      }
    } else {
      if (BigInt(swap.sqrtPriceX96) > UINT160_MAX) {
        addIssue('V3 sqrtPriceX96 exceeds uint160.', ['sqrtPriceX96']);
      }
      if (BigInt(swap.liquidity) > UINT128_MAX) {
        addIssue('V3 liquidity exceeds uint128.', ['liquidity']);
      }
      const tick = BigInt(swap.tick);
      if (tick < INT24_MIN || tick > INT24_MAX) {
        addIssue('V3 tick exceeds int24.', ['tick']);
      }
    }

    const isZeroForOne = delta0 > 0n && delta1 < 0n;
    const isOneForZero = delta1 > 0n && delta0 < 0n;
    if (!isZeroForOne && !isOneForZero) {
      if (swap.direction !== 'ambiguous') {
        addIssue('Non-opposing pool deltas require an ambiguous direction.', ['direction']);
      }
      for (const field of ['amountInRaw', 'amountOutRaw', 'tokenIn', 'tokenOut'] as const) {
        if (swap[field] !== undefined) {
          addIssue(`Ambiguous swaps must omit ${field}.`, [field]);
        }
      }
      return;
    }

    const expectedDirection = isZeroForOne ? 'token0_to_token1' : 'token1_to_token0';
    const expectedTokenIn = isZeroForOne ? swap.token0 : swap.token1;
    const expectedTokenOut = isZeroForOne ? swap.token1 : swap.token0;
    const expectedAmountIn = (isZeroForOne ? delta0 : delta1).toString();
    const expectedAmountOut = (isZeroForOne ? -delta1 : -delta0).toString();
    if (swap.direction !== expectedDirection) {
      addIssue('Swap direction does not match pool deltas.', ['direction']);
    }
    if (swap.tokenIn !== expectedTokenIn || swap.tokenOut !== expectedTokenOut) {
      addIssue('Swap token direction does not match pool deltas.', ['tokenIn']);
    }
    if (swap.amountInRaw !== expectedAmountIn || swap.amountOutRaw !== expectedAmountOut) {
      addIssue('Swap amounts do not match pool deltas.', ['amountInRaw']);
    }
  });

const coverageSchema = z
  .object({
    decodedSwapLogs: z.number().int().nonnegative().max(MAX_SWAP_EVENTS),
    receiptLogs: z.enum(['available', 'mismatched', 'missing', 'reverted']),
    recognizedSwapLogs: z.number().int().nonnegative().max(500),
    trace: z.enum(['available', 'invalid', 'mismatched', 'missing']),
    traceNodeCount: z.number().int().nonnegative().max(MAX_TRACE_NODES),
    unresolvedSwapLogs: z.number().int().nonnegative().max(500),
  })
  .strict();

const transactionFactSchema = z
  .object({
    chainId: evmChainIdSchema,
    executionStatus: z.enum(['pending', 'reverted', 'success', 'unknown']),
    hash: evmHashSchema,
  })
  .strict();

export const evmExecutionEnrichmentResultSchema = createSkillResultSchema({
  coverage: coverageSchema,
  internalTransfers: z.array(internalTransferSchema).max(MAX_TRACE_NODES - 1),
  nativeAssetChanges: z.array(nativeAssetChangeSchema).max(MAX_TRACE_NODES * 2),
  reverts: z.array(revertArtifactSchema).max(MAX_TRACE_NODES),
  skill: z.literal(EVM_EXECUTION_ENRICHMENT_SKILL),
  swaps: z.array(evmDecodedSwapSchema).max(MAX_SWAP_EVENTS),
  transaction: transactionFactSchema,
  version: z.literal(EVM_EXECUTION_ENRICHMENT_VERSION),
}).superRefine((result, context) => {
  const evidenceIds = new Set(result.evidence.map((evidence) => evidence.id));
  const checkEvidence = (id: string, path: Array<number | string>) => {
    if (!evidenceIds.has(id)) {
      context.addIssue({
        code: 'custom',
        message: `Result item references unknown evidence: ${id}`,
        path,
      });
    }
  };

  for (const [index, transfer] of result.internalTransfers.entries()) {
    checkEvidence(transfer.evidenceId, ['internalTransfers', index, 'evidenceId']);
  }
  for (const [index, change] of result.nativeAssetChanges.entries()) {
    for (const [evidenceIndex, evidenceId] of change.evidenceIds.entries()) {
      checkEvidence(evidenceId, ['nativeAssetChanges', index, 'evidenceIds', evidenceIndex]);
    }
  }
  for (const [index, revert] of result.reverts.entries()) {
    checkEvidence(revert.evidenceId, ['reverts', index, 'evidenceId']);
  }
  for (const [index, swap] of result.swaps.entries()) {
    for (const [evidenceIndex, evidenceId] of swap.evidenceIds.entries()) {
      checkEvidence(evidenceId, ['swaps', index, 'evidenceIds', evidenceIndex]);
    }
  }

  if (result.coverage.decodedSwapLogs !== result.swaps.length) {
    context.addIssue({
      code: 'custom',
      message: 'Decoded swap coverage must equal the number of swaps.',
      path: ['coverage', 'decodedSwapLogs'],
    });
  }
  if (
    result.coverage.recognizedSwapLogs !==
    result.coverage.decodedSwapLogs + result.coverage.unresolvedSwapLogs
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Recognized swap coverage must equal decoded plus unresolved swaps.',
      path: ['coverage', 'recognizedSwapLogs'],
    });
  }
  if (
    (result.coverage.trace === 'available' && result.coverage.traceNodeCount === 0) ||
    (result.coverage.trace !== 'available' && result.coverage.traceNodeCount !== 0)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Trace node coverage must be positive only when a trace is available.',
      path: ['coverage', 'traceNodeCount'],
    });
  }
  if (result.coverage.receiptLogs !== 'available' && result.coverage.recognizedSwapLogs !== 0) {
    context.addIssue({
      code: 'custom',
      message: 'Swap logs can only be recognized from an available successful receipt.',
      path: ['coverage', 'recognizedSwapLogs'],
    });
  }

  let nativeDelta = 0n;
  for (const [index, change] of result.nativeAssetChanges.entries()) {
    nativeDelta += BigInt(change.rawDelta);
    if (change.chainId !== result.transaction.chainId) {
      context.addIssue({
        code: 'custom',
        message: 'Native asset change chain must match the transaction chain.',
        path: ['nativeAssetChanges', index, 'chainId'],
      });
    }
  }
  if (nativeDelta !== 0n) {
    context.addIssue({
      code: 'custom',
      message: 'Internal native asset changes must net to zero.',
      path: ['nativeAssetChanges'],
    });
  }

  const transferPaths = new Set<string>();
  for (const [index, transfer] of result.internalTransfers.entries()) {
    const path = traceAddressKey(transfer.traceAddress);
    if (transferPaths.has(path)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate internal transfer trace address: ${path}`,
        path: ['internalTransfers', index, 'traceAddress'],
      });
    }
    transferPaths.add(path);
  }
  const revertPaths = new Set<string>();
  for (const [index, revert] of result.reverts.entries()) {
    const path = traceAddressKey(revert.traceAddress);
    if (revertPaths.has(path)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate revert trace address: ${path}`,
        path: ['reverts', index, 'traceAddress'],
      });
    }
    revertPaths.add(path);
  }
  const swapLogIndexes = new Set<number>();
  for (const [index, swap] of result.swaps.entries()) {
    if (swapLogIndexes.has(swap.logIndex)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate decoded swap log index: ${swap.logIndex}`,
        path: ['swaps', index, 'logIndex'],
      });
    }
    swapLogIndexes.add(swap.logIndex);
  }
});

export type EvmCallTrace = z.output<typeof evmCallTraceSchema>;
export type EvmTraceNode = EvmCallTrace['nodes'][number];
export type EvmPoolMetadata = z.output<typeof evmPoolMetadataSchema>;
export type EvmPoolMetadataEntry = EvmPoolMetadata[number];
export type EvmExecutionEnrichmentInput = z.input<typeof evmExecutionEnrichmentInputSchema>;
export type EvmExecutionEnrichmentResult = z.output<typeof evmExecutionEnrichmentResultSchema>;
export type EvmInternalTransfer = z.output<typeof internalTransferSchema>;
export type EvmNativeAssetChange = z.output<typeof nativeAssetChangeSchema>;
export type EvmRevertArtifact = z.output<typeof revertArtifactSchema>;
export type EvmDecodedSwap = z.output<typeof evmDecodedSwapSchema>;

export function traceAddressKey(traceAddress: readonly number[]): string {
  return traceAddress.length === 0 ? 'root' : traceAddress.join('.');
}
