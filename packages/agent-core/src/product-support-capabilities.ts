import {
  PRODUCT_SUPPORT_SKILL_DESCRIPTION,
  PRODUCT_SUPPORT_SKILL_VERSION,
  productSearchInputSchema,
  productSearchOutputSchema,
  type ProductSearchHandler,
} from '@xxyy/product-support-runtime';
import type { QualityTracer } from '@xxyy/rag-core';

import {
  parseCapabilityManifest,
  type CapabilityChannel,
  type CapabilityPrincipal,
} from './capability-contract.js';
import { createDenyByDefaultCapabilityPolicy } from './capability-policy.js';
import { createCapabilityRegistry, type CapabilityRegistry } from './capability-registry.js';
import type { ToolDefinition } from './tool-registry.js';

export const PRODUCT_SEARCH_SKILL_CAPABILITY_ID = 'product.skill.search_docs';

const PRODUCT_PUBLIC_DATA_SCOPE = 'product.public';
const PRODUCT_CAPABILITY_MAX_OUTPUT_BYTES = 262_144;
const PRODUCT_CAPABILITY_TIMEOUT_MS = 30_000;

export interface TrustedProductCapabilityCaller {
  channel: CapabilityChannel;
  principal: CapabilityPrincipal;
}

export interface CreateProductSupportCapabilityRegistryOptions {
  caller: TrustedProductCapabilityCaller;
  productSearch: ProductSearchHandler;
  tracer?: QualityTracer;
}

export function createProductSupportCapabilityRegistry(
  options: CreateProductSupportCapabilityRegistryOptions,
): CapabilityRegistry {
  const registry = createCapabilityRegistry({
    policy: createDenyByDefaultCapabilityPolicy([
      {
        capabilityId: PRODUCT_SEARCH_SKILL_CAPABILITY_ID,
        channels: [options.caller.channel],
        dataScopes: [PRODUCT_PUBLIC_DATA_SCOPE],
        maxRisk: 'low',
        principals: [options.caller.principal],
        sideEffects: ['external_read'],
        source: 'skill',
        version: PRODUCT_SUPPORT_SKILL_VERSION,
      },
    ]),
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });

  registry.register({
    adapter: {
      source: 'skill',
      invoke(request) {
        return options.productSearch.searchProductDocs(
          productSearchInputSchema.parse(request.input),
          { signal: request.context.signal },
        );
      },
    },
    inputSchema: productSearchInputSchema,
    manifest: parseCapabilityManifest({
      dataScopes: [PRODUCT_PUBLIC_DATA_SCOPE],
      description: PRODUCT_SUPPORT_SKILL_DESCRIPTION,
      id: PRODUCT_SEARCH_SKILL_CAPABILITY_ID,
      idempotency: 'not_applicable',
      limits: {
        maxOutputBytes: PRODUCT_CAPABILITY_MAX_OUTPUT_BYTES,
        timeoutMs: PRODUCT_CAPABILITY_TIMEOUT_MS,
      },
      requiresConfirmation: false,
      risk: 'low',
      sideEffect: 'external_read',
      source: 'skill',
      version: PRODUCT_SUPPORT_SKILL_VERSION,
    }),
    outputSchema: productSearchOutputSchema,
  });

  return registry;
}

export function createProductSupportSkillTool(options: {
  caller: TrustedProductCapabilityCaller;
  registry: CapabilityRegistry;
}): ToolDefinition<
  'search_product_docs',
  typeof productSearchInputSchema,
  typeof productSearchOutputSchema
> {
  return {
    name: 'search_product_docs',
    description: PRODUCT_SUPPORT_SKILL_DESCRIPTION,
    inputSchema: productSearchInputSchema,
    outputSchema: productSearchOutputSchema,
    async execute(input, context) {
      const output = await options.registry.invoke(PRODUCT_SEARCH_SKILL_CAPABILITY_ID, input, {
        channel: options.caller.channel,
        principal: options.caller.principal,
        ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      });
      return productSearchOutputSchema.parse(output);
    },
  };
}
