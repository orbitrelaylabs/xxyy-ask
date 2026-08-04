import { z } from 'zod';

export const capabilitySources = ['builtin', 'skill'] as const;
export const capabilityRiskLevels = ['low', 'moderate', 'high', 'critical'] as const;
export const capabilitySideEffects = [
  'none',
  'external_read',
  'external_write',
  'financial_transaction',
] as const;
export const capabilityIdempotencyModes = ['not_applicable', 'optional', 'required'] as const;
export const capabilityChannels = [
  'admin',
  'agent',
  'cli',
  'internal',
  'telegram',
  'web',
  'worker',
] as const;
export const capabilityPrincipals = ['anonymous', 'user', 'admin', 'service'] as const;

export type CapabilitySource = (typeof capabilitySources)[number];
export type CapabilityRiskLevel = (typeof capabilityRiskLevels)[number];
export type CapabilitySideEffect = (typeof capabilitySideEffects)[number];
export type CapabilityIdempotencyMode = (typeof capabilityIdempotencyModes)[number];
export type CapabilityChannel = (typeof capabilityChannels)[number];
export type CapabilityPrincipal = (typeof capabilityPrincipals)[number];

export const capabilityIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u,
    'Capability ids must be lowercase and namespace-qualified.',
  );

export const capabilityVersionSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u,
    'Capability versions must use semantic version syntax.',
  );

export const capabilityDataScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.:-]*$/u, 'Capability data scopes must be lowercase identifiers.');

const capabilityLimitsSchema = z
  .object({
    maxOutputBytes: z.number().int().min(1).max(1_048_576),
    timeoutMs: z.number().int().min(1).max(120_000),
  })
  .strict();

export const capabilityManifestSchema = z
  .object({
    dataScopes: z
      .array(capabilityDataScopeSchema)
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Capability data scopes must be unique.',
      }),
    description: z.string().trim().min(1).max(500),
    id: capabilityIdSchema,
    idempotency: z.enum(capabilityIdempotencyModes),
    limits: capabilityLimitsSchema,
    requiresConfirmation: z.boolean(),
    risk: z.enum(capabilityRiskLevels),
    sideEffect: z.enum(capabilitySideEffects),
    source: z.enum(capabilitySources),
    version: capabilityVersionSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const mutatesExternalState =
      manifest.sideEffect === 'external_write' || manifest.sideEffect === 'financial_transaction';
    if (mutatesExternalState && manifest.requiresConfirmation !== true) {
      context.addIssue({
        code: 'custom',
        message: 'State-changing capabilities must require explicit confirmation.',
        path: ['requiresConfirmation'],
      });
    }
    if (mutatesExternalState && manifest.idempotency !== 'required') {
      context.addIssue({
        code: 'custom',
        message: 'State-changing capabilities must require an idempotency key.',
        path: ['idempotency'],
      });
    }
    if (
      manifest.sideEffect === 'financial_transaction' &&
      manifest.risk !== 'high' &&
      manifest.risk !== 'critical'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Financial transaction capabilities must be high or critical risk.',
        path: ['risk'],
      });
    }
  });

type ParsedCapabilityManifest = z.output<typeof capabilityManifestSchema>;

export type CapabilityManifest = Readonly<
  Omit<ParsedCapabilityManifest, 'dataScopes' | 'limits'> & {
    dataScopes: readonly string[];
    limits: Readonly<ParsedCapabilityManifest['limits']>;
  }
>;

export function parseCapabilityManifest(input: unknown): CapabilityManifest {
  const parsed = capabilityManifestSchema.parse(input);
  return Object.freeze({
    ...parsed,
    dataScopes: Object.freeze([...parsed.dataScopes]),
    limits: Object.freeze({ ...parsed.limits }),
  });
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'removeEventListener' in value &&
    typeof value.removeEventListener === 'function'
  );
}

export const capabilityInvocationContextSchema = z
  .object({
    channel: z.enum(capabilityChannels),
    idempotencyKey: z.string().trim().min(8).max(256).optional(),
    principal: z.enum(capabilityPrincipals),
    requestId: z.string().trim().min(1).max(256).optional(),
    signal: z.custom<AbortSignal>(isAbortSignal).optional(),
    userConfirmed: z.boolean().optional(),
  })
  .strict();

export type CapabilityInvocationContext = z.output<typeof capabilityInvocationContextSchema>;

export interface CapabilityExecutionContext {
  channel: CapabilityChannel;
  idempotencyKey?: string | undefined;
  principal: CapabilityPrincipal;
  requestId?: string | undefined;
  signal: AbortSignal;
  userConfirmed?: boolean | undefined;
}

export interface CapabilityAdapterRequest {
  capabilityId: string;
  context: CapabilityExecutionContext;
  input: unknown;
  version: string;
}

export interface CapabilityAdapter {
  readonly source: CapabilitySource;
  invoke(request: CapabilityAdapterRequest): unknown;
}

export interface CapabilityDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  adapter: CapabilityAdapter;
  inputSchema: InputSchema;
  manifest: CapabilityManifest;
  outputSchema: OutputSchema;
}
