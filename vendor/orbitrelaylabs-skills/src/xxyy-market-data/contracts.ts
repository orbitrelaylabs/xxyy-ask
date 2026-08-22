import { z } from 'zod';

import { xxyyPairCandidateSchema } from '../xxyy-diagnosis-core/index.js';

export const XXYY_MARKET_DATA_ADAPTER_VERSION = '0.1.0' as const;
export const XXYY_MARKET_DATA_ORIGIN = 'https://www.xxyy.io' as const;

const identifierSchema = z.string().trim().min(1).max(256);
const decimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);

export const xxyyMarketTradeSchema = z
  .object({
    blockNumber: z
      .string()
      .regex(/^(?:0|[1-9]\d*)$/u)
      .optional(),
    logIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    maker: identifierSchema,
    marketCapUsd: decimalAmountSchema.optional(),
    nativeAmount: decimalAmountSchema,
    timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tokenAmount: decimalAmountSchema,
    transactionId: identifierSchema,
    type: z.enum(['buy', 'sell']),
    usdAmount: decimalAmountSchema.optional(),
  })
  .strict();

export const xxyyContextTradeSchema = xxyyMarketTradeSchema
  .extend({
    displayIndex: z.number().int().nonnegative().max(499),
    relation: z.enum(['earlier', 'same_time', 'later']),
  })
  .strict();

export const xxyyTradeLookupInputSchema = z
  .object({
    actor: identifierSchema.optional(),
    chain: z.string().trim().min(2).max(96),
    executionPools: z
      .array(
        z
          .object({
            amount0Raw: z
              .string()
              .regex(/^-?(?:0|[1-9]\d*)$/u)
              .optional(),
            amount1Raw: z
              .string()
              .regex(/^-?(?:0|[1-9]\d*)$/u)
              .optional(),
            isPrimary: z.boolean().optional(),
            poolIdentifier: identifierSchema,
          })
          .strict(),
      )
      .max(128)
      .optional(),
    targetTokenAddresses: z.array(identifierSchema).min(1).max(8),
    timestampMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    transactionAccountAddresses: z.array(identifierSchema).max(512).optional(),
    transactionId: identifierSchema,
  })
  .strict();

export const xxyyMarketDiagnosticCodes = [
  'http_error',
  'invalid_response',
  'multiple_transaction_matches',
  'request_aborted',
  'request_timeout',
  'response_too_large',
  'source_actor_conflict',
  'transport_error',
] as const;

export const xxyyMarketDiagnosticSchema = z
  .object({
    code: z.enum(xxyyMarketDiagnosticCodes),
    retryable: z.boolean(),
    stage: z.enum(['pair_search', 'trade_search', 'validate_match']),
  })
  .strict();

export const xxyyTradeLookupResultSchema = z
  .object({
    candidatePairs: z.array(xxyyPairCandidateSchema).max(64),
    contextComplete: z.boolean().optional(),
    contextTrades: z.array(xxyyContextTradeSchema).max(12).optional(),
    diagnostics: z.array(xxyyMarketDiagnosticSchema).max(100),
    matchedPair: xxyyPairCandidateSchema.optional(),
    matchedTrades: z
      .array(
        z
          .object({
            contextTrades: z.array(xxyyContextTradeSchema).max(12),
            pair: xxyyPairCandidateSchema,
            trade: xxyyMarketTradeSchema,
          })
          .strict(),
      )
      .max(128)
      .optional(),
    status: z.enum(['exact', 'multi_exact', 'conflict', 'not_found']),
    trade: xxyyMarketTradeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === 'exact' || value.status === 'multi_exact') &&
      (value.trade === undefined || value.matchedPair === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An exact XXYY trade match requires the trade and matched pair.',
        path: ['status'],
      });
    }
    if (
      value.status !== 'exact' &&
      value.status !== 'multi_exact' &&
      (value.trade !== undefined ||
        value.matchedPair !== undefined ||
        value.contextComplete !== undefined ||
        (value.contextTrades?.length ?? 0) > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only an exact XXYY trade match may expose one selected trade and pair.',
        path: ['status'],
      });
    }
    if (value.status === 'multi_exact' && (value.matchedTrades?.length ?? 0) < 2) {
      context.addIssue({
        code: 'custom',
        message: 'A multi-pool XXYY match requires at least two matched trades.',
        path: ['matchedTrades'],
      });
    }
    if (
      value.trade !== undefined &&
      value.contextTrades?.some((trade) => trade.transactionId === value.trade?.transactionId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Context trades must exclude the exact target transaction.',
        path: ['contextTrades'],
      });
    }
  });

export type XxyyMarketTrade = z.output<typeof xxyyMarketTradeSchema>;
export type XxyyContextTrade = z.output<typeof xxyyContextTradeSchema>;
export type XxyyMarketDiagnostic = z.output<typeof xxyyMarketDiagnosticSchema>;
export type XxyyTradeLookupInput = z.output<typeof xxyyTradeLookupInputSchema>;
export type XxyyTradeLookupResult = z.output<typeof xxyyTradeLookupResultSchema>;

export interface XxyyMarketDataClient {
  findTrade(
    input: XxyyTradeLookupInput,
    options?: { signal?: AbortSignal },
  ): Promise<XxyyTradeLookupResult>;
}
