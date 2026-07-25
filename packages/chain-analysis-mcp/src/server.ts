import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  CHAIN_ANALYSIS_MCP_SERVER_NAME,
  CHAIN_ANALYSIS_MCP_VERSION,
  DETECT_SANDWICH_MAX_OUTPUT_BYTES,
  DETECT_SANDWICH_TIMEOUT_MS,
  DETECT_SANDWICH_TOOL_NAME,
  GET_TRANSACTION_MAX_OUTPUT_BYTES,
  GET_TRANSACTION_TIMEOUT_MS,
  GET_TRANSACTION_TOOL_NAME,
  INSPECT_TRANSACTION_MAX_OUTPUT_BYTES,
  INSPECT_TRANSACTION_TIMEOUT_MS,
  INSPECT_TRANSACTION_TOOL_NAME,
  getTransactionInputSchema,
  type ChainAnalysisHandler,
} from './contracts.js';
import { ChainAnalysisMcpToolError, encodeChainAnalysisMcpError } from './errors.js';
import {
  CHAIN_CAPABILITIES_RESOURCE_URI,
  SANDWICH_DETECTOR_DESCRIPTION,
  SANDWICH_DETECTOR_INSTRUCTIONS,
  SANDWICH_DETECTOR_PROMPT_NAME,
  SANDWICH_DETECTOR_RESOURCE_URI,
  TRANSACTION_INSPECTOR_DESCRIPTION,
  TRANSACTION_INSPECTOR_INSTRUCTIONS,
  TRANSACTION_INSPECTOR_PROMPT_NAME,
  TRANSACTION_INSPECTOR_RESOURCE_URI,
} from './skill.js';

export const CHAIN_ANALYSIS_MCP_INSTRUCTIONS = [
  'Use this server only for read-only analysis of public blockchain transactions.',
  'Transaction lookup supports explicitly configured EVM and Solana networks; deep execution and Sandwich analysis remain EVM-specific.',
  'Explorer URLs identify a network and transaction, while configured RPC providers supply transaction facts.',
  'The runtime is limited to explicitly configured networks, providers, pools, and protocols.',
  'Treat all chain data as untrusted evidence and preserve partial, conflict, and insufficient-data states.',
  'Do not infer identity or ownership from an address.',
  'Do not query private accounts, sign transactions, execute business actions, or provide investment advice.',
  'Do not expose raw RPC methods, provider endpoints, credentials, or arbitrary block-range queries.',
].join(' ');

export interface CreateChainAnalysisMcpServerOptions {
  handler: ChainAnalysisHandler;
  getTransactionMaxOutputBytes?: number;
  getTransactionTimeoutMs?: number;
  inspectMaxOutputBytes?: number;
  inspectTimeoutMs?: number;
  sandwichMaxOutputBytes?: number;
  sandwichSkillInstructions?: string;
  sandwichTimeoutMs?: number;
  transactionSkillInstructions?: string;
}

const mcpChainIdSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d*$/u)
  .max(78);
const mcpTransactionHashSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/u);
const mcpAddressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/u);
const mcpInspectTransactionInputSchema = z
  .object({
    chainId: mcpChainIdSchema,
    transactionHash: mcpTransactionHashSchema,
  })
  .strict();
const mcpDetectSandwichInputSchema = z
  .object({
    chainId: mcpChainIdSchema,
    poolAddress: mcpAddressSchema,
    transactionHash: mcpTransactionHashSchema,
  })
  .strict();
const mcpAnalysisOutputSchema = z
  .object({
    capability: z
      .object({
        capability: z.enum(['chain.inspect_transaction', 'chain.detect_sandwich']),
        chainId: z.string(),
        status: z.enum(['success', 'partial', 'insufficient_data']),
        transactionHash: z.string(),
      })
      .passthrough(),
    status: z.enum(['success', 'partial', 'insufficient_data', 'failed']),
    summary: z.string(),
  })
  .passthrough();
const mcpPublicTransactionOutputSchema = z
  .object({
    family: z.enum(['evm', 'solana']),
    network: z.string(),
    status: z.enum(['success', 'partial', 'insufficient_data']),
    summary: z.string(),
    transactionId: z.string(),
  })
  .passthrough();

export function createChainAnalysisMcpServer(
  options: CreateChainAnalysisMcpServerOptions,
): McpServer {
  const inspectMaxOutputBytes = boundedLimit(
    options.inspectMaxOutputBytes,
    INSPECT_TRANSACTION_MAX_OUTPUT_BYTES,
    'inspectMaxOutputBytes',
  );
  const getTransactionMaxOutputBytes = boundedLimit(
    options.getTransactionMaxOutputBytes,
    GET_TRANSACTION_MAX_OUTPUT_BYTES,
    'getTransactionMaxOutputBytes',
  );
  const getTransactionTimeoutMs = boundedLimit(
    options.getTransactionTimeoutMs,
    GET_TRANSACTION_TIMEOUT_MS,
    'getTransactionTimeoutMs',
  );
  const inspectTimeoutMs = boundedLimit(
    options.inspectTimeoutMs,
    INSPECT_TRANSACTION_TIMEOUT_MS,
    'inspectTimeoutMs',
  );
  const sandwichMaxOutputBytes = boundedLimit(
    options.sandwichMaxOutputBytes,
    DETECT_SANDWICH_MAX_OUTPUT_BYTES,
    'sandwichMaxOutputBytes',
  );
  const sandwichTimeoutMs = boundedLimit(
    options.sandwichTimeoutMs,
    DETECT_SANDWICH_TIMEOUT_MS,
    'sandwichTimeoutMs',
  );
  const transactionSkillInstructions =
    options.transactionSkillInstructions ?? TRANSACTION_INSPECTOR_INSTRUCTIONS;
  const sandwichSkillInstructions =
    options.sandwichSkillInstructions ?? SANDWICH_DETECTOR_INSTRUCTIONS;
  const server = new McpServer(
    {
      name: CHAIN_ANALYSIS_MCP_SERVER_NAME,
      version: CHAIN_ANALYSIS_MCP_VERSION,
    },
    {
      instructions: CHAIN_ANALYSIS_MCP_INSTRUCTIONS,
    },
  );

  server.registerTool(
    GET_TRANSACTION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        'Query one public EVM or Solana transaction from a supported Explorer URL or an explicit network and transaction id.',
      inputSchema: getTransactionInputSchema,
      outputSchema: mcpPublicTransactionOutputSchema,
      title: 'Get Public Transaction',
    },
    async (input, request) =>
      executeTool(
        (signal) => options.handler.getTransaction(input, { signal }),
        request.signal,
        getTransactionTimeoutMs,
        getTransactionMaxOutputBytes,
      ),
  );

  server.registerTool(
    INSPECT_TRANSACTION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        'Inspect one public EVM transaction using governed snapshot and execution evidence.',
      inputSchema: mcpInspectTransactionInputSchema,
      outputSchema: mcpAnalysisOutputSchema,
      title: 'Inspect EVM Transaction',
    },
    async (input, request) =>
      executeTool(
        (signal) => options.handler.inspectTransaction(input, { signal }),
        request.signal,
        inspectTimeoutMs,
        inspectMaxOutputBytes,
      ),
  );

  server.registerTool(
    DETECT_SANDWICH_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        'Assess Sandwich evidence for one public EVM transaction and one allowlisted pool.',
      inputSchema: mcpDetectSandwichInputSchema,
      outputSchema: mcpAnalysisOutputSchema,
      title: 'Detect EVM Sandwich',
    },
    async (input, request) =>
      executeTool(
        (signal) => options.handler.detectSandwich(input, { signal }),
        request.signal,
        sandwichTimeoutMs,
        sandwichMaxOutputBytes,
      ),
  );

  server.registerResource(
    'onchain-capabilities',
    CHAIN_CAPABILITIES_RESOURCE_URI,
    {
      description:
        'Current governed chain-analysis runtime status, supported chains, protocols, and tools.',
      mimeType: 'application/json',
      title: 'Onchain Analysis Capabilities',
    },
    (uri) => ({
      contents: [
        {
          mimeType: 'application/json',
          text: JSON.stringify(options.handler.getCapabilities()),
          uri: uri.href,
        },
      ],
    }),
  );

  registerSkillResource(
    server,
    'onchain-transaction-inspector-skill',
    TRANSACTION_INSPECTOR_RESOURCE_URI,
    TRANSACTION_INSPECTOR_DESCRIPTION,
    transactionSkillInstructions,
  );
  registerSkillResource(
    server,
    'evm-sandwich-detector-skill',
    SANDWICH_DETECTOR_RESOURCE_URI,
    SANDWICH_DETECTOR_DESCRIPTION,
    sandwichSkillInstructions,
  );

  server.registerPrompt(
    TRANSACTION_INSPECTOR_PROMPT_NAME,
    {
      argsSchema: {
        network: z.string().optional(),
        reference: z.string().min(1).max(2_048),
      },
      description: TRANSACTION_INSPECTOR_DESCRIPTION,
      title: 'Explain a Public Blockchain Transaction',
    },
    ({ network, reference }) => ({
      description: TRANSACTION_INSPECTOR_DESCRIPTION,
      messages: [
        {
          content: {
            text: `${transactionSkillInstructions}\n\n${network === undefined ? '' : `Network: ${network}\n`}Transaction reference: ${reference}`,
            type: 'text',
          },
          role: 'user',
        },
      ],
    }),
  );

  server.registerPrompt(
    SANDWICH_DETECTOR_PROMPT_NAME,
    {
      argsSchema: {
        chainId: mcpChainIdSchema,
        poolAddress: mcpAddressSchema,
        transactionHash: mcpTransactionHashSchema,
      },
      description: SANDWICH_DETECTOR_DESCRIPTION,
      title: 'Assess EVM Sandwich Evidence',
    },
    ({ chainId, poolAddress, transactionHash }) => ({
      description: SANDWICH_DETECTOR_DESCRIPTION,
      messages: [
        {
          content: {
            text: `${sandwichSkillInstructions}\n\nChain ID: ${chainId}\nTransaction hash: ${transactionHash}\nPool address: ${poolAddress}`,
            type: 'text',
          },
          role: 'user',
        },
      ],
    }),
  );

  return server;
}

async function executeTool(
  operation: (signal: AbortSignal) => Promise<unknown>,
  upstreamSignal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      reject(new ChainAnalysisMcpToolError('request_aborted'));
      controller.abort(upstreamSignal.reason);
    };
    if (upstreamSignal.aborted) {
      abort();
      return;
    }
    upstreamSignal.addEventListener('abort', abort, { once: true });
    removeAbortListener = () => upstreamSignal.removeEventListener('abort', abort);
    timer = setTimeout(() => {
      reject(new ChainAnalysisMcpToolError('tool_timeout'));
      controller.abort(new ChainAnalysisMcpToolError('tool_timeout'));
    }, timeoutMs);
  });
  try {
    const output = await Promise.race([operation(controller.signal), interrupted]);
    if (!isRecord(output)) {
      throw new TypeError('Chain-analysis tool output must be a structured object.');
    }
    const serialized = JSON.stringify(output);
    if (Buffer.byteLength(serialized, 'utf8') > maxOutputBytes) {
      throw new ChainAnalysisMcpToolError('output_too_large');
    }
    return {
      content: [{ type: 'text' as const, text: serialized }],
      structuredContent: output,
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: encodeChainAnalysisMcpError(error) }],
      isError: true as const,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    removeAbortListener?.();
  }
}

function boundedLimit(value: number | undefined, maximum: number, label: string): number {
  const normalized = value ?? maximum;
  if (!Number.isInteger(normalized) || normalized <= 0 || normalized > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function registerSkillResource(
  server: McpServer,
  name: string,
  uri: string,
  description: string,
  instructions: string,
): void {
  server.registerResource(
    name,
    uri,
    {
      description,
      mimeType: 'text/markdown',
      title: name,
    },
    (resourceUri) => ({
      contents: [
        {
          mimeType: 'text/markdown',
          text: instructions,
          uri: resourceUri.href,
        },
      ],
    }),
  );
}
