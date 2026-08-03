import { z } from 'zod';

import { getTransactionOutputSchema } from '@xxyy/chain-analysis-mcp';
import { xxyyTradeLookupResultSchema } from '@xxyy/xxyy-market-data-adapter';
import { xxyyContextTradeSchema } from '@xxyy/xxyy-market-data-adapter';
import {
  xxyyPoolAssessmentSchema,
  xxyyPoolPolicySchema,
  xxyySandwichAssessmentSchema,
} from '@xxyy/xxyy-transaction-diagnosis-core';

export const XXYY_ONCHAIN_SUPPORT_MCP_SERVER_NAME = 'xxyy-onchain-support';
export const XXYY_ONCHAIN_SUPPORT_MCP_VERSION = '0.1.0';
export const DIAGNOSE_XXYY_TRANSACTION_TOOL_NAME = 'diagnose_xxyy_transaction';
export const DIAGNOSE_XXYY_TRANSACTION_TIMEOUT_MS = 120_000;

export const xxyyDiagnosisCheckSchema = z.enum(['pool', 'sandwich']);

export const diagnoseXxyyTransactionInputSchema = z
  .object({
    checks: z
      .array(xxyyDiagnosisCheckSchema)
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

export const xxyyScreenshotArtifactSchema = z
  .object({
    capturedAt: z.string().datetime({ offset: true }),
    maker: z.string().trim().min(1).max(256),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    pairAddress: z.string().trim().min(1).max(256),
    sourceUrl: z.string().url(),
    title: z.string().trim().min(1).max(256),
    transactionId: z.string().trim().min(1).max(256),
    url: z.string().url(),
  })
  .strict();

export const xxyyScreenshotEvidenceSchema = z
  .object({
    artifact: xxyyScreenshotArtifactSchema.optional(),
    reason: z.enum(['capture_failed', 'not_configured', 'trade_not_exactly_matched']).optional(),
    status: z.enum(['ready', 'unavailable']),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'ready' && value.artifact === undefined) {
      context.addIssue({ code: 'custom', message: 'Ready screenshot evidence needs an artifact.' });
    }
    if (value.status === 'unavailable' && value.reason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Unavailable screenshot evidence needs a reason.',
      });
    }
  });

export const xxyySurroundingTradeSchema = xxyyContextTradeSchema
  .extend({
    blockNumber: z
      .string()
      .regex(/^(?:0|[1-9]\d*)$/u)
      .optional(),
    chainStatus: z.enum(['resolved', 'unavailable']),
    slot: z
      .string()
      .regex(/^(?:0|[1-9]\d*)$/u)
      .optional(),
  })
  .strict();

export const diagnoseXxyyTransactionOutputSchema = z
  .object({
    checks: z.array(xxyyDiagnosisCheckSchema).min(1).max(2),
    market: xxyyTradeLookupResultSchema.optional(),
    poolAssessment: xxyyPoolAssessmentSchema.optional(),
    sandwichAssessment: xxyySandwichAssessmentSchema.optional(),
    screenshotEvidence: xxyyScreenshotEvidenceSchema,
    status: z.enum(['insufficient_data', 'partial', 'success']),
    summary: z.string().trim().min(1).max(4_096),
    surroundingTrades: z.array(xxyySurroundingTradeSchema).max(12).optional(),
    transaction: getTransactionOutputSchema,
    warnings: z.array(z.string().trim().min(1).max(512)).max(32),
  })
  .strict();

export type DiagnoseXxyyTransactionInput = z.output<typeof diagnoseXxyyTransactionInputSchema>;
export type DiagnoseXxyyTransactionOutput = z.output<typeof diagnoseXxyyTransactionOutputSchema>;
export type XxyyScreenshotArtifact = z.output<typeof xxyyScreenshotArtifactSchema>;
export type XxyyScreenshotEvidence = z.output<typeof xxyyScreenshotEvidenceSchema>;
export type XxyySurroundingTrade = z.output<typeof xxyySurroundingTradeSchema>;

export interface XxyyTransactionDiagnosisHandler {
  diagnoseXxyyTransaction(
    input: DiagnoseXxyyTransactionInput,
    options?: { signal?: AbortSignal },
  ): Promise<DiagnoseXxyyTransactionOutput>;
}

export interface XxyyOnchainSupportMcpClient extends XxyyTransactionDiagnosisHandler {
  close(): Promise<void>;
}

export interface XxyyScreenshotEvidenceProvider {
  capture(
    input: {
      chain: string;
      maker: string;
      nativeAmount?: string;
      pairAddress: string;
      timestamp?: number;
      tokenAmount?: string;
      transactionId: string;
      type?: 'buy' | 'sell';
      usdAmount?: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<XxyyScreenshotArtifact>;
}

export type XxyyDiagnosisPoolPolicy = z.output<typeof xxyyPoolPolicySchema>;
