import { z } from 'zod';

import {
  evmChainIdSchema,
  transactionAnalysisResultSchema,
} from '../transaction-analysis/index.js';

import { normalizePublicNetworkIdentifier } from './network-profiles.js';
import { solanaTransactionSnapshotSchema } from './solana-browser-contracts.js';

export const publicChainNetworkSchema = z
  .string()
  .trim()
  .min(2)
  .max(96)
  .refine(
    (value) => normalizePublicNetworkIdentifier(value) !== undefined,
    'Expected a supported network alias or canonical network id.',
  );

export const getTransactionInputSchema = z
  .object({
    network: publicChainNetworkSchema.optional(),
    reference: z.string().trim().min(1).max(2_048),
  })
  .strict();

const commonShape = {
  diagnostics: z.array(z.unknown()).max(100),
  explorerUrl: z.string().url().optional(),
  network: z.string().min(2).max(96),
  status: z.enum(['insufficient_data', 'partial', 'success']),
  summary: z.string().min(1).max(4_096),
  transactionId: z.string().min(1).max(128),
} as const;

export const getTransactionOutputSchema = z.discriminatedUnion('family', [
  z
    .object({
      ...commonShape,
      analysis: transactionAnalysisResultSchema,
      chainId: evmChainIdSchema,
      family: z.literal('evm'),
    })
    .strict(),
  z
    .object({
      ...commonShape,
      analysis: solanaTransactionSnapshotSchema.optional(),
      family: z.literal('solana'),
    })
    .strict(),
]);

export type GetTransactionInput = z.output<typeof getTransactionInputSchema>;
export type GetTransactionOutput = z.output<typeof getTransactionOutputSchema>;

export interface PublicTransactionClient {
  close(): Promise<void>;
  getTransaction(
    input: GetTransactionInput,
    options?: { signal?: AbortSignal },
  ): Promise<GetTransactionOutput>;
}

export function createPublicTransactionClientStub(
  getTransaction: PublicTransactionClient['getTransaction'],
): PublicTransactionClient {
  return {
    close: () => Promise.resolve(),
    getTransaction,
  };
}
