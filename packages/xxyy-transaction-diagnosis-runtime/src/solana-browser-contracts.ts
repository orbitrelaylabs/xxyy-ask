import { z } from 'zod';

export const solanaAddressSchema = z
  .string()
  .trim()
  .min(32)
  .max(64)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/u, 'Expected a base58 Solana address.');

export const solanaSignatureSchema = z
  .string()
  .trim()
  .min(64)
  .max(128)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/u, 'Expected a base58 Solana transaction signature.');

const decimalIntegerSchema = z.string().regex(/^-?(?:0|[1-9]\d*)$/u);
const unsignedDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const solanaTransactionSnapshotSchema = z
  .object({
    accountKeys: z.array(solanaAddressSchema).max(512),
    blockTime: z.string().datetime({ offset: true }).optional(),
    computeUnitsConsumed: unsignedDecimalSchema.optional(),
    executionStatus: z.enum(['reverted', 'success', 'unknown']),
    feeLamports: unsignedDecimalSchema.optional(),
    logCount: z.number().int().nonnegative().max(2_048),
    nativeBalanceChanges: z
      .array(
        z
          .object({
            account: solanaAddressSchema,
            accountIndex: z.number().int().nonnegative().max(511),
            deltaLamports: decimalIntegerSchema,
          })
          .strict(),
      )
      .max(512),
    network: z.literal('solana:mainnet'),
    programIds: z.array(solanaAddressSchema).max(512),
    slot: unsignedDecimalSchema,
    sources: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64),
            kind: z.literal('explorer_browser'),
            observedAt: z.string().datetime({ offset: true }),
            payloadHash: fingerprintSchema,
            provenanceUrl: z.string().url(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    tokenBalanceChanges: z
      .array(
        z
          .object({
            account: solanaAddressSchema.optional(),
            accountIndex: z.number().int().nonnegative().max(511),
            decimals: z.number().int().nonnegative().max(255),
            deltaRaw: decimalIntegerSchema,
            mint: solanaAddressSchema,
            owner: solanaAddressSchema.optional(),
            programId: solanaAddressSchema.optional(),
          })
          .strict(),
      )
      .max(1_024),
    transactionId: solanaSignatureSchema,
  })
  .strict();

export type SolanaTransactionSnapshot = z.output<typeof solanaTransactionSnapshotSchema>;
