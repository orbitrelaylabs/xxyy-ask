import { z } from 'zod';

import {
  chainAnalysisStageSchema,
  detectSandwichCapabilityResultSchema,
  inspectTransactionCapabilityResultSchema,
} from '@xxyy/evm-chain-analysis-harness';
import { evmExecutionEnrichmentResultSchema } from '@xxyy/evm-execution-enrichment-core';
import { evmPriceImpactSandwichResultSchema } from '@xxyy/evm-price-impact-sandwich-core';
import { createSkillResultSchema } from '@xxyy/shared';
import {
  evmAddressSchema,
  evmChainIdSchema,
  evmHashSchema,
  transactionAnalysisResultSchema,
} from '@xxyy/transaction-analysis-core';

export const CHAIN_ANALYSIS_MCP_SERVER_NAME = 'xxyy-chain-analysis';
export const CHAIN_ANALYSIS_MCP_VERSION = '0.1.0';
export const INSPECT_TRANSACTION_TOOL_NAME = 'inspect_transaction';
export const DETECT_SANDWICH_TOOL_NAME = 'detect_sandwich';
export const INSPECT_TRANSACTION_TIMEOUT_MS = 60_000;
export const DETECT_SANDWICH_TIMEOUT_MS = 120_000;
export const INSPECT_TRANSACTION_MAX_OUTPUT_BYTES = 524_288;
export const DETECT_SANDWICH_MAX_OUTPUT_BYTES = 1_048_576;

export const chainAnalysisRuntimeStatuses = [
  'contract_only',
  'internal',
  'ready',
  'degraded',
] as const;

export const inspectTransactionInputSchema = z
  .object({
    chainId: evmChainIdSchema,
    transactionHash: evmHashSchema,
  })
  .strict();

export const detectSandwichInputSchema = z
  .object({
    chainId: evmChainIdSchema,
    poolAddress: evmAddressSchema,
    transactionHash: evmHashSchema,
  })
  .strict();

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const pipelineCoverageSchema = z
  .object({
    execution: z.enum(['complete', 'partial', 'not_provided']),
    mev: z.enum(['blocked', 'complete', 'not_requested', 'partial']),
    observation: z.enum(['complete', 'not_provided', 'partial']),
    providerCostUnits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    providerRequests: z.number().int().nonnegative().max(1_000_000),
    transaction: z.enum(['complete', 'missing', 'partial']),
  })
  .strict();

const commonAnalysisOutputShape = {
  coverage: pipelineCoverageSchema,
  execution: evmExecutionEnrichmentResultSchema.optional(),
  inputFingerprint: fingerprintSchema,
  replayFingerprint: fingerprintSchema,
  stages: z.array(chainAnalysisStageSchema).length(4),
  transaction: transactionAnalysisResultSchema,
} as const;

export const inspectTransactionOutputSchema = createSkillResultSchema({
  ...commonAnalysisOutputShape,
  capability: inspectTransactionCapabilityResultSchema,
});

export const detectSandwichOutputSchema = createSkillResultSchema({
  ...commonAnalysisOutputShape,
  capability: detectSandwichCapabilityResultSchema,
  mev: evmPriceImpactSandwichResultSchema.optional(),
});

const chainCapabilityDescriptorSchema = z
  .object({
    chainId: evmChainIdSchema,
    protocols: z.array(z.enum(['uniswap_v2', 'uniswap_v3'])).max(2),
    tools: z
      .array(z.enum([INSPECT_TRANSACTION_TOOL_NAME, DETECT_SANDWICH_TOOL_NAME]))
      .min(1)
      .max(2),
  })
  .strict();

export const chainAnalysisCapabilitiesSchema = z
  .object({
    chains: z.array(chainCapabilityDescriptorSchema).max(64),
    runtimeStatus: z.enum(chainAnalysisRuntimeStatuses),
    version: z.literal(CHAIN_ANALYSIS_MCP_VERSION),
  })
  .strict();

export type InspectTransactionInput = z.output<typeof inspectTransactionInputSchema>;
export type DetectSandwichInput = z.output<typeof detectSandwichInputSchema>;
export type InspectTransactionOutput = z.output<typeof inspectTransactionOutputSchema>;
export type DetectSandwichOutput = z.output<typeof detectSandwichOutputSchema>;
export type ChainAnalysisCapabilities = z.output<typeof chainAnalysisCapabilitiesSchema>;
export type ChainAnalysisRuntimeStatus = (typeof chainAnalysisRuntimeStatuses)[number];

export interface ChainAnalysisHandler {
  detectSandwich(
    input: DetectSandwichInput,
    options?: { signal?: AbortSignal },
  ): Promise<DetectSandwichOutput>;
  getCapabilities(): ChainAnalysisCapabilities;
  inspectTransaction(
    input: InspectTransactionInput,
    options?: { signal?: AbortSignal },
  ): Promise<InspectTransactionOutput>;
}

export interface ChainAnalysisMcpClient {
  close(): Promise<void>;
  detectSandwich(
    input: DetectSandwichInput,
    options?: { signal?: AbortSignal },
  ): Promise<DetectSandwichOutput>;
  inspectTransaction(
    input: InspectTransactionInput,
    options?: { signal?: AbortSignal },
  ): Promise<InspectTransactionOutput>;
}
