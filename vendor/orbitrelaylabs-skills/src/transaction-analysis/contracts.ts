import { z } from 'zod';

import { createSkillResultSchema } from '../shared/domain-contract.js';

export const TRANSACTION_ANALYSIS_SKILL = 'transaction_analysis' as const;
export const TRANSACTION_ANALYSIS_VERSION = '1.0.0' as const;
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
export const EVM_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const EVM_UINT256_MAX = (1n << 256n) - 1n;

const canonicalUintPattern = /^(?:0|[1-9]\d*)$/u;
const positiveUintPattern = /^[1-9]\d*$/u;

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const evmChainIdSchema = z
  .string()
  .trim()
  .max(78)
  .regex(positiveUintPattern, 'EVM chain id must be a positive decimal integer.')
  .refine(
    (value) => positiveUintPattern.test(value) && BigInt(value) <= EVM_UINT256_MAX,
    'EVM chain id exceeds uint256.',
  );

export const evmUintSchema = z
  .string()
  .trim()
  .max(78)
  .regex(canonicalUintPattern, 'Expected an unsigned decimal integer.')
  .refine(
    (value) => canonicalUintPattern.test(value) && BigInt(value) <= EVM_UINT256_MAX,
    'Unsigned integer exceeds uint256.',
  );

export const evmSignedIntegerSchema = z
  .string()
  .trim()
  .max(160)
  .regex(/^(?:0|-?[1-9]\d*)$/u, 'Expected a canonical signed decimal integer.');

export const evmAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/u, 'Expected a 20-byte EVM address.')
  .transform((value) => value.toLowerCase());

export const evmHashSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/u, 'Expected a 32-byte EVM hash.')
  .transform((value) => value.toLowerCase());

export const evmBytesSchema = z
  .string()
  .trim()
  .max(262_146)
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/u, 'Expected even-length hex bytes.')
  .transform((value) => value.toLowerCase());

const sourceSchema = z
  .object({
    id: stableIdSchema,
    kind: z.enum(['rpc', 'indexer', 'explorer', 'fixture']),
    observedAt: z.string().datetime({ offset: true }),
    payloadHash: z
      .string()
      .trim()
      .regex(/^(?:0x[0-9a-fA-F]{64}|sha256:[0-9a-fA-F]{64})$/u)
      .optional(),
    url: z.string().url().optional(),
  })
  .strict();

const transactionSchema = z
  .object({
    blockNumber: evmUintSchema.optional(),
    from: evmAddressSchema,
    hash: evmHashSchema,
    input: evmBytesSchema,
    nonce: evmUintSchema,
    sourceId: stableIdSchema,
    to: evmAddressSchema.nullable(),
    transactionIndex: z.number().int().nonnegative().max(1_000_000).optional(),
    value: evmUintSchema,
  })
  .strict();

const logSchema = z
  .object({
    address: evmAddressSchema,
    data: evmBytesSchema,
    logIndex: z.number().int().nonnegative().max(1_000_000),
    removed: z.boolean().optional(),
    sourceId: stableIdSchema,
    topics: z.array(evmHashSchema).max(4),
  })
  .strict();

const receiptSchema = z
  .object({
    blockNumber: evmUintSchema,
    contractAddress: evmAddressSchema.nullable().optional(),
    effectiveGasPrice: evmUintSchema,
    gasUsed: evmUintSchema,
    logs: z.array(logSchema).max(500),
    sourceId: stableIdSchema,
    status: z.enum(['success', 'reverted']),
    transactionHash: evmHashSchema,
    transactionIndex: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict()
  .refine(
    (receipt) =>
      !isUint256(receipt.gasUsed) ||
      !isUint256(receipt.effectiveGasPrice) ||
      BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) <= EVM_UINT256_MAX,
    {
      message: 'gasUsed * effectiveGasPrice exceeds uint256.',
      path: ['effectiveGasPrice'],
    },
  );

const blockSchema = z
  .object({
    hash: evmHashSchema,
    number: evmUintSchema,
    sourceId: stableIdSchema,
    timestamp: evmUintSchema,
  })
  .strict();

const sourceConflictSchema = z
  .object({
    field: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z][A-Za-z0-9_.[\]-]*$/u),
    observations: z
      .array(
        z
          .object({
            sourceId: stableIdSchema,
            value: z.string().max(1_000),
          })
          .strict(),
      )
      .min(2)
      .max(8)
      .refine(
        (observations) =>
          new Set(observations.map((observation) => observation.sourceId)).size >= 2,
        'Conflicts require at least two distinct sources.',
      )
      .refine(
        (observations) => new Set(observations.map((observation) => observation.value)).size >= 2,
        'Conflicts require at least two distinct values.',
      ),
  })
  .strict();

export const evmTransactionSnapshotSchema = z
  .object({
    block: blockSchema.optional(),
    chainId: evmChainIdSchema,
    conflicts: z.array(sourceConflictSchema).max(50).optional(),
    observedAt: z.string().datetime({ offset: true }),
    receipt: receiptSchema.optional(),
    requestedTransactionHash: evmHashSchema,
    sources: z
      .array(sourceSchema)
      .min(1)
      .max(8)
      .refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length, {
        message: 'Source ids must be unique.',
      }),
    transaction: transactionSchema.optional(),
  })
  .strict();

export const transactionExecutionStatuses = ['success', 'reverted', 'pending', 'unknown'] as const;
export const transactionTimelineKinds = [
  'execution',
  'native_transfer',
  'token_transfer',
  'fee',
  'block_context',
] as const;

const evidenceIdsSchema = z
  .array(stableIdSchema)
  .min(1)
  .max(1_000)
  .refine((evidenceIds) => new Set(evidenceIds).size === evidenceIds.length, {
    message: 'Evidence ids must be unique.',
  });

const assetChangeSchema = z
  .object({
    address: evmAddressSchema,
    asset: z.discriminatedUnion('kind', [
      z.object({ chainId: evmChainIdSchema, kind: z.literal('native') }).strict(),
      z.object({ contractAddress: evmAddressSchema, kind: z.literal('erc20') }).strict(),
    ]),
    evidenceIds: evidenceIdsSchema,
    rawDelta: evmSignedIntegerSchema,
  })
  .strict();

const tokenTransferSchema = z
  .object({
    amountRaw: evmUintSchema,
    evidenceId: stableIdSchema,
    from: evmAddressSchema,
    logIndex: z.number().int().nonnegative(),
    to: evmAddressSchema,
    tokenAddress: evmAddressSchema,
    transferType: z.enum(['transfer', 'mint', 'burn']),
  })
  .strict();

const timelineItemSchema = z
  .object({
    amountRaw: evmUintSchema.optional(),
    assetAddress: evmAddressSchema.optional(),
    evidenceIds: evidenceIdsSchema,
    from: evmAddressSchema.optional(),
    kind: z.enum(transactionTimelineKinds),
    logIndex: z.number().int().nonnegative().optional(),
    sequence: z.number().int().positive(),
    statement: z.string().trim().min(1).max(1_000),
    to: evmAddressSchema.optional(),
  })
  .strict();

const unresolvedConflictSchema = z
  .object({
    evidenceId: stableIdSchema,
    field: z.string().trim().min(1).max(256),
    sourceIds: z.array(stableIdSchema).min(2).max(8),
  })
  .strict();

const transactionFactSchema = z
  .object({
    blockNumber: evmUintSchema.optional(),
    blockTimestamp: evmUintSchema.optional(),
    chainId: evmChainIdSchema,
    executionStatus: z.enum(transactionExecutionStatuses),
    failureReason: z.string().trim().min(1).max(1_000).optional(),
    feeWei: evmUintSchema.optional(),
    from: evmAddressSchema.optional(),
    hash: evmHashSchema,
    inputKind: z.enum(['native_transfer', 'contract_call', 'contract_creation', 'unknown']),
    to: evmAddressSchema.nullable().optional(),
    valueWei: evmUintSchema.optional(),
  })
  .strict();

export const transactionAnalysisResultSchema = createSkillResultSchema({
  assetChanges: z.array(assetChangeSchema).max(1_100),
  conflicts: z.array(unresolvedConflictSchema).max(50),
  skill: z.literal(TRANSACTION_ANALYSIS_SKILL),
  timeline: z.array(timelineItemSchema).max(1_000),
  tokenTransfers: z.array(tokenTransferSchema).max(500),
  transaction: transactionFactSchema,
  version: z.literal(TRANSACTION_ANALYSIS_VERSION),
}).superRefine((result, context) => {
  const evidenceIds = new Set(result.evidence.map((evidence) => evidence.id));

  for (const [changeIndex, change] of result.assetChanges.entries()) {
    for (const [evidenceIndex, evidenceId] of change.evidenceIds.entries()) {
      if (!evidenceIds.has(evidenceId)) {
        context.addIssue({
          code: 'custom',
          message: `Asset change references unknown evidence: ${evidenceId}`,
          path: ['assetChanges', changeIndex, 'evidenceIds', evidenceIndex],
        });
      }
    }
  }

  for (const [timelineIndex, item] of result.timeline.entries()) {
    if (item.sequence !== timelineIndex + 1) {
      context.addIssue({
        code: 'custom',
        message: `Timeline sequence must be contiguous from 1; expected ${timelineIndex + 1}.`,
        path: ['timeline', timelineIndex, 'sequence'],
      });
    }

    for (const [evidenceIndex, evidenceId] of item.evidenceIds.entries()) {
      if (!evidenceIds.has(evidenceId)) {
        context.addIssue({
          code: 'custom',
          message: `Timeline item references unknown evidence: ${evidenceId}`,
          path: ['timeline', timelineIndex, 'evidenceIds', evidenceIndex],
        });
      }
    }
  }

  for (const [transferIndex, transfer] of result.tokenTransfers.entries()) {
    if (!evidenceIds.has(transfer.evidenceId)) {
      context.addIssue({
        code: 'custom',
        message: `Token transfer references unknown evidence: ${transfer.evidenceId}`,
        path: ['tokenTransfers', transferIndex, 'evidenceId'],
      });
    }
  }

  for (const [conflictIndex, conflict] of result.conflicts.entries()) {
    if (!evidenceIds.has(conflict.evidenceId)) {
      context.addIssue({
        code: 'custom',
        message: `Conflict references unknown evidence: ${conflict.evidenceId}`,
        path: ['conflicts', conflictIndex, 'evidenceId'],
      });
    }
  }
});

export type EvmTransactionSnapshot = z.output<typeof evmTransactionSnapshotSchema>;
export type EvmSnapshotSource = EvmTransactionSnapshot['sources'][number];
export type EvmTransaction = NonNullable<EvmTransactionSnapshot['transaction']>;
export type EvmTransactionReceipt = NonNullable<EvmTransactionSnapshot['receipt']>;
export type EvmTransactionLog = EvmTransactionReceipt['logs'][number];
export type TransactionAnalysisResult = z.output<typeof transactionAnalysisResultSchema>;
export type TransactionAssetChange = z.output<typeof assetChangeSchema>;
export type TransactionTokenTransfer = z.output<typeof tokenTransferSchema>;
export type TransactionTimelineItem = z.output<typeof timelineItemSchema>;

function isUint256(value: string): boolean {
  return canonicalUintPattern.test(value) && BigInt(value) <= EVM_UINT256_MAX;
}
