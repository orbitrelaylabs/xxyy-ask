import {
  CHAIN_ANALYSIS_SKILL_VERSION,
  DETECT_SANDWICH_MAX_OUTPUT_BYTES,
  DETECT_SANDWICH_TIMEOUT_MS,
  INSPECT_TRANSACTION_MAX_OUTPUT_BYTES,
  INSPECT_TRANSACTION_TIMEOUT_MS,
  SANDWICH_DETECTOR_DESCRIPTION,
  TRANSACTION_INSPECTOR_DESCRIPTION,
  detectSandwichInputSchema,
  detectSandwichOutputSchema,
  inspectTransactionInputSchema,
  inspectTransactionOutputSchema,
  type ChainAnalysisMcpClient,
} from '@xxyy/chain-analysis-mcp';
import type { QualityTracer } from '@xxyy/rag-core';

import {
  parseCapabilityManifest,
  type CapabilityExecutionContext,
  type CapabilityInvocationContext,
} from './capability-contract.js';
import { createDenyByDefaultCapabilityPolicy } from './capability-policy.js';
import { createCapabilityRegistry, type CapabilityRegistry } from './capability-registry.js';
import type { ToolDefinition } from './tool-registry.js';

export const CHAIN_INSPECT_MCP_CAPABILITY_ID = 'chain.mcp.inspect_transaction';
export const CHAIN_INSPECT_SKILL_CAPABILITY_ID = 'chain.skill.inspect_transaction';
export const CHAIN_SANDWICH_MCP_CAPABILITY_ID = 'chain.mcp.detect_sandwich';
export const CHAIN_SANDWICH_SKILL_CAPABILITY_ID = 'chain.skill.detect_sandwich';

const TRANSACTION_DATA_SCOPES = [
  'chain.public.ethereum.transaction',
  'chain.public.ethereum.execution',
] as const;
const SANDWICH_DATA_SCOPES = [...TRANSACTION_DATA_SCOPES, 'chain.public.ethereum.mev'] as const;
export type InternalChainAnalysisCaller =
  | { channel: 'cli'; principal: 'admin' }
  | { channel: 'internal'; principal: 'admin' | 'service' };

export interface CreateInternalChainAnalysisCapabilityRegistryOptions {
  caller: InternalChainAnalysisCaller;
  mcpClient: ChainAnalysisMcpClient;
  tracer?: QualityTracer;
}

export function createInternalChainAnalysisCapabilityRegistry(
  options: CreateInternalChainAnalysisCapabilityRegistryOptions,
): CapabilityRegistry {
  assertInternalCaller(options.caller);
  const grants = [
    createGrant(CHAIN_INSPECT_MCP_CAPABILITY_ID, 'mcp', TRANSACTION_DATA_SCOPES, options.caller),
    createGrant(
      CHAIN_INSPECT_SKILL_CAPABILITY_ID,
      'skill',
      TRANSACTION_DATA_SCOPES,
      options.caller,
    ),
    createGrant(CHAIN_SANDWICH_MCP_CAPABILITY_ID, 'mcp', SANDWICH_DATA_SCOPES, options.caller),
    createGrant(CHAIN_SANDWICH_SKILL_CAPABILITY_ID, 'skill', SANDWICH_DATA_SCOPES, options.caller),
  ];
  const registry = createCapabilityRegistry({
    maxOutputBytes: DETECT_SANDWICH_MAX_OUTPUT_BYTES,
    maxTimeoutMs: DETECT_SANDWICH_TIMEOUT_MS,
    policy: createDenyByDefaultCapabilityPolicy(grants),
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });

  registry.register({
    adapter: {
      source: 'mcp',
      invoke(request) {
        return options.mcpClient.inspectTransaction(
          inspectTransactionInputSchema.parse(request.input),
          { signal: request.context.signal },
        );
      },
    },
    inputSchema: inspectTransactionInputSchema,
    manifest: parseCapabilityManifest({
      dataScopes: [...TRANSACTION_DATA_SCOPES],
      description: 'Inspect one public Ethereum transaction through governed MCP data access.',
      id: CHAIN_INSPECT_MCP_CAPABILITY_ID,
      idempotency: 'not_applicable',
      limits: {
        maxOutputBytes: INSPECT_TRANSACTION_MAX_OUTPUT_BYTES,
        timeoutMs: INSPECT_TRANSACTION_TIMEOUT_MS,
      },
      requiresConfirmation: false,
      risk: 'moderate',
      sideEffect: 'external_read',
      source: 'mcp',
      version: CHAIN_ANALYSIS_SKILL_VERSION,
    }),
    outputSchema: inspectTransactionOutputSchema,
  });

  registry.register({
    adapter: {
      source: 'skill',
      invoke(request) {
        return registry.invoke(
          CHAIN_INSPECT_MCP_CAPABILITY_ID,
          request.input,
          toNestedInvocationContext(request.context),
        );
      },
    },
    inputSchema: inspectTransactionInputSchema,
    manifest: parseCapabilityManifest({
      dataScopes: [...TRANSACTION_DATA_SCOPES],
      description: TRANSACTION_INSPECTOR_DESCRIPTION,
      id: CHAIN_INSPECT_SKILL_CAPABILITY_ID,
      idempotency: 'not_applicable',
      limits: {
        maxOutputBytes: INSPECT_TRANSACTION_MAX_OUTPUT_BYTES,
        timeoutMs: INSPECT_TRANSACTION_TIMEOUT_MS,
      },
      requiresConfirmation: false,
      risk: 'moderate',
      sideEffect: 'external_read',
      source: 'skill',
      version: CHAIN_ANALYSIS_SKILL_VERSION,
    }),
    outputSchema: inspectTransactionOutputSchema,
  });

  registry.register({
    adapter: {
      source: 'mcp',
      invoke(request) {
        return options.mcpClient.detectSandwich(detectSandwichInputSchema.parse(request.input), {
          signal: request.context.signal,
        });
      },
    },
    inputSchema: detectSandwichInputSchema,
    manifest: parseCapabilityManifest({
      dataScopes: [...SANDWICH_DATA_SCOPES],
      description: 'Assess Sandwich evidence through governed MCP data access.',
      id: CHAIN_SANDWICH_MCP_CAPABILITY_ID,
      idempotency: 'not_applicable',
      limits: {
        maxOutputBytes: DETECT_SANDWICH_MAX_OUTPUT_BYTES,
        timeoutMs: DETECT_SANDWICH_TIMEOUT_MS,
      },
      requiresConfirmation: false,
      risk: 'moderate',
      sideEffect: 'external_read',
      source: 'mcp',
      version: CHAIN_ANALYSIS_SKILL_VERSION,
    }),
    outputSchema: detectSandwichOutputSchema,
  });

  registry.register({
    adapter: {
      source: 'skill',
      invoke(request) {
        return registry.invoke(
          CHAIN_SANDWICH_MCP_CAPABILITY_ID,
          request.input,
          toNestedInvocationContext(request.context),
        );
      },
    },
    inputSchema: detectSandwichInputSchema,
    manifest: parseCapabilityManifest({
      dataScopes: [...SANDWICH_DATA_SCOPES],
      description: SANDWICH_DETECTOR_DESCRIPTION,
      id: CHAIN_SANDWICH_SKILL_CAPABILITY_ID,
      idempotency: 'not_applicable',
      limits: {
        maxOutputBytes: DETECT_SANDWICH_MAX_OUTPUT_BYTES,
        timeoutMs: DETECT_SANDWICH_TIMEOUT_MS,
      },
      requiresConfirmation: false,
      risk: 'moderate',
      sideEffect: 'external_read',
      source: 'skill',
      version: CHAIN_ANALYSIS_SKILL_VERSION,
    }),
    outputSchema: detectSandwichOutputSchema,
  });

  return registry;
}

export function createInternalChainAnalysisTools(options: {
  caller: InternalChainAnalysisCaller;
  registry: CapabilityRegistry;
}): ToolDefinition[] {
  assertInternalCaller(options.caller);
  return [createInspectTransactionTool(options), createDetectSandwichTool(options)];
}

function createInspectTransactionTool(options: {
  caller: InternalChainAnalysisCaller;
  registry: CapabilityRegistry;
}): ToolDefinition<
  'inspect_transaction',
  typeof inspectTransactionInputSchema,
  typeof inspectTransactionOutputSchema
> {
  return {
    name: 'inspect_transaction',
    description: `${TRANSACTION_INSPECTOR_DESCRIPTION} Internal-only until chain readiness is ready.`,
    inputSchema: inspectTransactionInputSchema,
    outputSchema: inspectTransactionOutputSchema,
    async execute(input, context) {
      return inspectTransactionOutputSchema.parse(
        await options.registry.invoke(
          CHAIN_INSPECT_SKILL_CAPABILITY_ID,
          input,
          invocationContext(options.caller, context.requestId),
        ),
      );
    },
  };
}

function createDetectSandwichTool(options: {
  caller: InternalChainAnalysisCaller;
  registry: CapabilityRegistry;
}): ToolDefinition<
  'detect_sandwich',
  typeof detectSandwichInputSchema,
  typeof detectSandwichOutputSchema
> {
  return {
    name: 'detect_sandwich',
    description: `${SANDWICH_DETECTOR_DESCRIPTION} Internal-only until chain readiness is ready.`,
    inputSchema: detectSandwichInputSchema,
    outputSchema: detectSandwichOutputSchema,
    async execute(input, context) {
      return detectSandwichOutputSchema.parse(
        await options.registry.invoke(
          CHAIN_SANDWICH_SKILL_CAPABILITY_ID,
          input,
          invocationContext(options.caller, context.requestId),
        ),
      );
    },
  };
}

function createGrant(
  capabilityId: string,
  source: 'mcp' | 'skill',
  dataScopes: readonly string[],
  caller: InternalChainAnalysisCaller,
) {
  return {
    capabilityId,
    channels: [caller.channel],
    dataScopes: [...dataScopes],
    maxRisk: 'moderate' as const,
    principals: [caller.principal],
    sideEffects: ['external_read' as const],
    source,
    version: CHAIN_ANALYSIS_SKILL_VERSION,
  };
}

function assertInternalCaller(caller: InternalChainAnalysisCaller): void {
  if (
    (caller.channel === 'cli' && caller.principal === 'admin') ||
    (caller.channel === 'internal' &&
      (caller.principal === 'admin' || caller.principal === 'service'))
  ) {
    return;
  }
  throw new TypeError('Chain-analysis capabilities require an internal-only trusted caller.');
}

function invocationContext(
  caller: InternalChainAnalysisCaller,
  requestId: string | undefined,
): CapabilityInvocationContext {
  return {
    channel: caller.channel,
    principal: caller.principal,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function toNestedInvocationContext(
  context: CapabilityExecutionContext,
): CapabilityInvocationContext {
  return {
    channel: context.channel,
    principal: context.principal,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    signal: context.signal,
  };
}
