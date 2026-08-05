import { z } from 'zod';

export const XXYY_TRANSACTION_DIAGNOSIS_RUNTIME_VERSION = '0.1.0';
export const DIAGNOSE_XXYY_TRANSACTION_TIMEOUT_MS = 120_000;

export const getTransactionInputSchema = z
  .object({
    network: z.string().trim().min(2).max(96).optional(),
    reference: z.string().trim().min(1).max(2_048),
  })
  .strict();

const commonTransactionOutput = {
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
      ...commonTransactionOutput,
      analysis: z.any(),
      chainId: z.string().regex(/^(?:0|[1-9]\d*)$/u),
      family: z.literal('evm'),
    })
    .passthrough(),
  z
    .object({
      ...commonTransactionOutput,
      analysis: z.any().optional(),
      family: z.literal('solana'),
    })
    .passthrough(),
]);

export const diagnoseXxyyTransactionInputSchema = z
  .object({
    checks: z
      .array(z.enum(['pool', 'sandwich']))
      .min(1)
      .max(2)
      .refine((checks) => new Set(checks).size === checks.length, {
        message: 'Diagnosis checks must be unique.',
      }),
    network: z.string().trim().min(2).max(96).optional(),
    reference: z.string().trim().min(1).max(2_048),
    swapIndex: z.number().int().nonnegative().max(1_000).optional(),
  })
  .strict();

const screenshotArtifactSchema = z
  .object({
    capturedAt: z.string().datetime({ offset: true }),
    filePath: z.string().optional(),
    maker: z.string().trim().min(1).max(256),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    pairAddress: z.string().trim().min(1).max(256),
    sourceUrl: z.string().url(),
    title: z.string().trim().min(1).max(256),
    transactionId: z.string().trim().min(1).max(256),
    url: z.string().regex(/^\/xxyy-evidence\/[0-9a-f]{64}\.png$/u),
  })
  .passthrough();

const screenshotEvidenceSchema = z
  .object({
    artifact: screenshotArtifactSchema.optional(),
    reason: z.enum(['capture_failed', 'not_configured', 'trade_not_exactly_matched']).optional(),
    status: z.enum(['ready', 'unavailable']),
  })
  .strict();

export const diagnoseXxyyTransactionOutputSchema = z
  .object({
    checks: z
      .array(z.enum(['pool', 'sandwich']))
      .min(1)
      .max(2),
    market: z.any().optional(),
    poolAssessment: z.any().optional(),
    sandwichAssessment: z.any().optional(),
    screenshotEvidence: screenshotEvidenceSchema,
    status: z.enum(['insufficient_data', 'partial', 'success']),
    summary: z.string().trim().min(1).max(4_096),
    surroundingTrades: z.array(z.any()).max(12).optional(),
    transaction: getTransactionOutputSchema,
    warnings: z.array(z.string().trim().min(1).max(512)).max(32),
  })
  .passthrough();

export type GetTransactionInput = z.output<typeof getTransactionInputSchema>;
export type GetTransactionOutput = z.output<typeof getTransactionOutputSchema>;
export type DiagnoseXxyyTransactionInput = z.output<typeof diagnoseXxyyTransactionInputSchema>;
export type DiagnoseXxyyTransactionOutput = z.output<typeof diagnoseXxyyTransactionOutputSchema>;

export interface PublicTransactionClient {
  close(): Promise<void>;
  getTransaction(
    input: GetTransactionInput,
    options?: { signal?: AbortSignal },
  ): Promise<GetTransactionOutput>;
}

export interface XxyyTransactionDiagnosisHandler {
  diagnoseXxyyTransaction(
    input: DiagnoseXxyyTransactionInput,
    options?: { signal?: AbortSignal },
  ): Promise<DiagnoseXxyyTransactionOutput>;
}

export function createPublicTransactionClientStub(
  getTransaction: PublicTransactionClient['getTransaction'],
): PublicTransactionClient {
  return { close: () => Promise.resolve(), getTransaction };
}
