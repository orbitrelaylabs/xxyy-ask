import type { QualityTracer } from '@xxyy/rag-core';
import {
  DIAGNOSE_XXYY_TRANSACTION_TIMEOUT_MS,
  XXYY_TRANSACTION_DIAGNOSIS_RUNTIME_VERSION,
  diagnoseXxyyTransactionInputSchema,
  diagnoseXxyyTransactionOutputSchema,
  type XxyyTransactionDiagnosisHandler,
} from '@xxyy/transaction-skill-bridge';

import { parseCapabilityManifest } from './capability-contract.js';
import { createDenyByDefaultCapabilityPolicy } from './capability-policy.js';
import { createCapabilityRegistry, type CapabilityRegistry } from './capability-registry.js';
import type { PublicChainAnalysisCaller } from './chain-analysis-capabilities.js';

export const XXYY_DIAGNOSIS_SKILL_CAPABILITY_ID = 'xxyy.skill.diagnose_transaction';
const XXYY_DIAGNOSIS_DATA_SCOPES = [
  'chain.public.transaction',
  'xxyy.public.market',
  'xxyy.public.screenshot',
] as const;
const MAX_OUTPUT_BYTES = 1_048_576;

export function createXxyyTransactionDiagnosisCapabilityRegistry(options: {
  caller: PublicChainAnalysisCaller;
  diagnosis: XxyyTransactionDiagnosisHandler;
  tracer?: QualityTracer;
}): CapabilityRegistry {
  const grants = [createGrant(XXYY_DIAGNOSIS_SKILL_CAPABILITY_ID, options.caller)];
  const registry = createCapabilityRegistry({
    maxOutputBytes: MAX_OUTPUT_BYTES,
    maxTimeoutMs: DIAGNOSE_XXYY_TRANSACTION_TIMEOUT_MS,
    policy: createDenyByDefaultCapabilityPolicy(grants),
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  registry.register({
    adapter: {
      source: 'skill',
      invoke(request) {
        return options.diagnosis.diagnoseXxyyTransaction(
          diagnoseXxyyTransactionInputSchema.parse(request.input),
          { signal: request.context.signal },
        );
      },
    },
    inputSchema: diagnoseXxyyTransactionInputSchema,
    manifest: manifest(
      XXYY_DIAGNOSIS_SKILL_CAPABILITY_ID,
      'skill',
      'Diagnose one supplied public XXYY trade for Sandwich evidence and pool selection.',
    ),
    outputSchema: diagnoseXxyyTransactionOutputSchema,
  });
  return registry;
}

function createGrant(capabilityId: string, caller: PublicChainAnalysisCaller) {
  return {
    capabilityId,
    channels: [caller.channel],
    dataScopes: [...XXYY_DIAGNOSIS_DATA_SCOPES],
    maxRisk: 'moderate' as const,
    principals: [caller.principal],
    sideEffects: ['external_read' as const],
    source: 'skill' as const,
    version: XXYY_TRANSACTION_DIAGNOSIS_RUNTIME_VERSION,
  };
}

function manifest(id: string, source: 'skill', description: string) {
  return parseCapabilityManifest({
    dataScopes: [...XXYY_DIAGNOSIS_DATA_SCOPES],
    description,
    id,
    idempotency: 'not_applicable',
    limits: {
      maxOutputBytes: MAX_OUTPUT_BYTES,
      timeoutMs: DIAGNOSE_XXYY_TRANSACTION_TIMEOUT_MS,
    },
    requiresConfirmation: false,
    risk: 'moderate',
    sideEffect: 'external_read',
    source,
    version: XXYY_TRANSACTION_DIAGNOSIS_RUNTIME_VERSION,
  });
}
