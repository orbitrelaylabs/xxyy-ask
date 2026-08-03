import { z } from 'zod';

export const SOLANA_DATA_ADAPTER_VERSION = '0.1.0' as const;
export const SOLANA_MAINNET_NETWORK = 'solana:mainnet' as const;

export const solanaNetworkSchema = z.literal(SOLANA_MAINNET_NETWORK);
export const solanaProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/u, 'Expected a stable lower-case provider id.');
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

const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const headerValueSchema = z
  .string()
  .max(8_192)
  .refine((value) => !/[\r\n]/u.test(value), 'Header values cannot contain line breaks.');
const forbiddenHeaders = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'proxy-authorization',
  'transfer-encoding',
]);
const providerHeadersSchema = z
  .record(headerNameSchema, headerValueSchema)
  .superRefine((headers, context) => {
    if (Object.keys(headers).length > 32) {
      context.addIssue({
        code: 'custom',
        message: 'A provider can define at most 32 headers.',
        path: [],
      });
    }
    const normalized = new Set<string>();
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (normalized.has(lower) || forbiddenHeaders.has(lower)) {
        context.addIssue({
          code: 'custom',
          message: `Header is duplicated or controlled by the adapter: ${name}`,
          path: [name],
        });
      }
      normalized.add(lower);
    }
  })
  .transform((headers) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
  );

export const solanaRpcProviderConfigSchema = z
  .object({
    endpoint: z.string().trim().max(2_048).url(),
    headers: providerHeadersSchema.optional(),
    id: solanaProviderIdSchema,
  })
  .strict();

export const solanaDataAdapterConfigSchema = z
  .object({
    network: solanaNetworkSchema,
    providers: z
      .array(solanaRpcProviderConfigSchema)
      .min(1)
      .max(8)
      .refine(
        (providers) => new Set(providers.map((provider) => provider.id)).size === providers.length,
        { message: 'Provider ids must be unique.' },
      ),
  })
  .strict();

export const loadSolanaTransactionInputSchema = z
  .object({
    network: solanaNetworkSchema,
    providerIds: z
      .array(solanaProviderIdSchema)
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'Provider ids must be unique.',
      })
      .optional(),
    transactionId: solanaSignatureSchema,
  })
  .strict();

const decimalIntegerSchema = z.string().regex(/^-?(?:0|[1-9]\d*)$/u);
const unsignedDecimalSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const solanaNativeBalanceChangeSchema = z
  .object({
    account: solanaAddressSchema,
    accountIndex: z.number().int().nonnegative().max(511),
    deltaLamports: decimalIntegerSchema,
  })
  .strict();

export const solanaTokenBalanceChangeSchema = z
  .object({
    account: solanaAddressSchema.optional(),
    accountIndex: z.number().int().nonnegative().max(511),
    decimals: z.number().int().nonnegative().max(255),
    deltaRaw: decimalIntegerSchema,
    mint: solanaAddressSchema,
    owner: solanaAddressSchema.optional(),
    programId: solanaAddressSchema.optional(),
  })
  .strict();

export const solanaTransactionSourceSchema = z
  .object({
    id: solanaProviderIdSchema,
    kind: z.enum(['rpc', 'explorer_browser']),
    observedAt: z.string().datetime({ offset: true }),
    payloadHash: fingerprintSchema,
    provenanceUrl: z.string().url(),
  })
  .strict();

export const solanaTransactionSnapshotSchema = z
  .object({
    accountKeys: z.array(solanaAddressSchema).max(512),
    blockTime: z.string().datetime({ offset: true }).optional(),
    computeUnitsConsumed: unsignedDecimalSchema.optional(),
    executionStatus: z.enum(['reverted', 'success', 'unknown']),
    feeLamports: unsignedDecimalSchema.optional(),
    logCount: z.number().int().nonnegative().max(2_048),
    nativeBalanceChanges: z.array(solanaNativeBalanceChangeSchema).max(512),
    network: solanaNetworkSchema,
    programIds: z.array(solanaAddressSchema).max(512),
    slot: unsignedDecimalSchema,
    sources: z.array(solanaTransactionSourceSchema).min(1).max(8),
    tokenBalanceChanges: z.array(solanaTokenBalanceChangeSchema).max(1_024),
    transactionId: solanaSignatureSchema,
  })
  .strict();

export const solanaDataAdapterDiagnosticCodes = [
  'balance_length_mismatch',
  'http_error',
  'invalid_transaction_payload',
  'provider_conflict',
  'request_aborted',
  'request_timeout',
  'response_too_large',
  'rpc_error',
  'transaction_not_found',
  'transport_error',
] as const;

export const solanaDataAdapterDiagnosticSchema = z
  .object({
    code: z.enum(solanaDataAdapterDiagnosticCodes),
    httpStatus: z.number().int().min(100).max(599).optional(),
    providerId: solanaProviderIdSchema,
    retryable: z.boolean(),
  })
  .strict();

export const solanaDataAdapterResultSchema = z
  .object({
    diagnostics: z.array(solanaDataAdapterDiagnosticSchema).max(100),
    snapshot: solanaTransactionSnapshotSchema.optional(),
    status: z.enum(['insufficient_data', 'partial', 'success']),
  })
  .strict();

export type SolanaRpcProviderConfig = z.output<typeof solanaRpcProviderConfigSchema>;
export type SolanaDataAdapterConfig = z.output<typeof solanaDataAdapterConfigSchema>;
export type LoadSolanaTransactionInput = z.output<typeof loadSolanaTransactionInputSchema>;
export type SolanaTransactionSnapshot = z.output<typeof solanaTransactionSnapshotSchema>;
export type SolanaDataAdapterDiagnostic = z.output<typeof solanaDataAdapterDiagnosticSchema>;
export type SolanaDataAdapterResult = z.output<typeof solanaDataAdapterResultSchema>;
