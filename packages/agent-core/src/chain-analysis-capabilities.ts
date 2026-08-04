import {
  getTransactionInputSchema,
  getTransactionOutputSchema,
  type PublicTransactionClient,
} from '@xxyy/xxyy-transaction-diagnosis-runtime';
import type { QualityTracer } from '@xxyy/rag-core';

import { parseCapabilityManifest } from './capability-contract.js';
import { createDenyByDefaultCapabilityPolicy } from './capability-policy.js';
import { createCapabilityRegistry, type CapabilityRegistry } from './capability-registry.js';

export const CHAIN_GET_SKILL_CAPABILITY_ID = 'chain.skill.get_transaction';

const DATA_SCOPES = ['chain.public.evm.transaction', 'chain.public.solana.transaction'] as const;

export type PublicChainAnalysisCaller =
  | { channel: 'telegram'; principal: 'service' }
  | { channel: 'web'; principal: 'anonymous' };
export type PublicChainTransactionCaller = PublicChainAnalysisCaller;

export interface CreatePublicChainAnalysisCapabilityRegistryOptions {
  caller: PublicChainAnalysisCaller;
  client: PublicTransactionClient;
  tracer?: QualityTracer;
}

export type CreatePublicChainTransactionCapabilityRegistryOptions =
  CreatePublicChainAnalysisCapabilityRegistryOptions;

export function createPublicChainAnalysisCapabilityRegistry(
  options: CreatePublicChainAnalysisCapabilityRegistryOptions,
): CapabilityRegistry {
  assertPublicCaller(options.caller);
  const registry = createCapabilityRegistry({
    policy: createDenyByDefaultCapabilityPolicy([
      {
        capabilityId: CHAIN_GET_SKILL_CAPABILITY_ID,
        channels: [options.caller.channel],
        dataScopes: [...DATA_SCOPES],
        maxRisk: 'moderate',
        principals: [options.caller.principal],
        sideEffects: ['external_read'],
        source: 'skill',
        version: '1.0.0',
      },
    ]),
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  registry.register({
    adapter: {
      source: 'skill',
      invoke(request) {
        return options.client.getTransaction(getTransactionInputSchema.parse(request.input), {
          signal: request.context.signal,
        });
      },
    },
    inputSchema: getTransactionInputSchema,
    manifest: parseCapabilityManifest({
      dataScopes: [...DATA_SCOPES],
      description: 'Read one public transaction from a fixed Explorer in an isolated browser.',
      id: CHAIN_GET_SKILL_CAPABILITY_ID,
      idempotency: 'not_applicable',
      limits: { maxOutputBytes: 524_288, timeoutMs: 45_000 },
      requiresConfirmation: false,
      risk: 'moderate',
      sideEffect: 'external_read',
      source: 'skill',
      version: '1.0.0',
    }),
    outputSchema: getTransactionOutputSchema,
  });
  return registry;
}

export const createPublicChainTransactionCapabilityRegistry =
  createPublicChainAnalysisCapabilityRegistry;

function assertPublicCaller(caller: PublicChainAnalysisCaller): void {
  const valid =
    (caller.channel === 'web' && caller.principal === 'anonymous') ||
    (caller.channel === 'telegram' && caller.principal === 'service');
  if (!valid) throw new TypeError('Public browser transaction capability caller is not trusted.');
}
