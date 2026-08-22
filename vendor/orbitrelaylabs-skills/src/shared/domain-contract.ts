import { z } from 'zod';

export const evidenceKinds = [
  'document',
  'social',
  'transaction',
  'log',
  'trace',
  'metadata',
  'block',
  'calculation',
] as const;

export const skillResultStatuses = ['success', 'partial', 'insufficient_data', 'failed'] as const;

export type EvidenceKind = (typeof evidenceKinds)[number];
export type SkillResultStatus = (typeof skillResultStatuses)[number];
export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const stableIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Expected a stable identifier.');

const uniqueStableIdsSchema = z
  .array(stableIdSchema)
  .max(1_000)
  .refine((values) => new Set(values).size === values.length, {
    message: 'Identifiers must be unique.',
  });

export const evidenceItemSchema = z
  .object({
    blockNumber: z
      .string()
      .regex(/^(?:0|[1-9]\d*)$/u)
      .optional(),
    chainId: z.string().trim().min(1).max(128).optional(),
    confidence: z.number().min(0).max(1),
    effectiveAt: z.string().datetime({ offset: true }).optional(),
    excerpt: z.string().max(2_000).optional(),
    id: stableIdSchema,
    kind: z.enum(evidenceKinds),
    observedAt: z.string().datetime({ offset: true }).optional(),
    payloadHash: z.string().trim().min(1).max(256).optional(),
    source: z.string().trim().min(1).max(256),
    sourceUrl: z.string().url().optional(),
    structuredData: jsonValueSchema.optional(),
    supports: uniqueStableIdsSchema.min(1),
    transactionHash: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const skillFindingSchema = z
  .object({
    confidence: z.number().min(0).max(1),
    evidenceIds: uniqueStableIdsSchema.min(1),
    id: stableIdSchema,
    inference: z.boolean(),
    statement: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const skillDiagnosticSchema = z
  .object({
    code: stableIdSchema,
    evidenceIds: uniqueStableIdsSchema.optional(),
    retryable: z.boolean(),
    stage: stableIdSchema,
  })
  .strict();

export const skillResultBaseShape = {
  diagnostics: z.array(skillDiagnosticSchema).max(100),
  evidence: z.array(evidenceItemSchema).max(1_000),
  findings: z.array(skillFindingSchema).max(100),
  skill: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_]*$/u),
  status: z.enum(skillResultStatuses),
  summary: z.string().trim().min(1).max(2_000),
  version: z
    .string()
    .trim()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  warnings: z.array(z.string().trim().min(1).max(500)).max(100),
} as const;

interface SkillResultReferenceShape {
  diagnostics: Array<{ evidenceIds?: string[] | undefined }>;
  evidence: Array<{ id: string; supports: string[] }>;
  findings: Array<{ evidenceIds: string[]; id: string }>;
}

interface RefinementIssueSink {
  addIssue(issue: { code: 'custom'; message: string; path: Array<number | string> }): void;
}

export function createSkillResultSchema<const Extension extends z.ZodRawShape>(
  extension: Extension,
) {
  return z
    .object({ ...skillResultBaseShape, ...extension })
    .strict()
    .superRefine((value, context) => {
      addSkillResultReferenceIssues(value as SkillResultReferenceShape, context);
    });
}

export const skillResultSchema = createSkillResultSchema({});

export type EvidenceItem = z.output<typeof evidenceItemSchema>;
export type SkillFinding = z.output<typeof skillFindingSchema>;
export type SkillDiagnostic = z.output<typeof skillDiagnosticSchema>;
export type SkillResult = z.output<typeof skillResultSchema>;

function addSkillResultReferenceIssues(
  result: SkillResultReferenceShape,
  context: RefinementIssueSink,
): void {
  const findingIds = new Set<string>();
  for (const [index, finding] of result.findings.entries()) {
    if (findingIds.has(finding.id)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate finding id: ${finding.id}`,
        path: ['findings', index, 'id'],
      });
    }
    findingIds.add(finding.id);
  }

  const evidenceIds = new Set<string>();
  for (const [index, evidence] of result.evidence.entries()) {
    if (evidenceIds.has(evidence.id)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate evidence id: ${evidence.id}`,
        path: ['evidence', index, 'id'],
      });
    }
    evidenceIds.add(evidence.id);
    for (const [supportIndex, findingId] of evidence.supports.entries()) {
      if (!findingIds.has(findingId)) {
        context.addIssue({
          code: 'custom',
          message: `Evidence references unknown finding: ${findingId}`,
          path: ['evidence', index, 'supports', supportIndex],
        });
      }
    }
  }

  for (const [index, finding] of result.findings.entries()) {
    for (const [evidenceIndex, evidenceId] of finding.evidenceIds.entries()) {
      if (!evidenceIds.has(evidenceId)) {
        context.addIssue({
          code: 'custom',
          message: `Finding references unknown evidence: ${evidenceId}`,
          path: ['findings', index, 'evidenceIds', evidenceIndex],
        });
      }
    }
  }

  for (const [index, diagnostic] of result.diagnostics.entries()) {
    for (const [evidenceIndex, evidenceId] of (diagnostic.evidenceIds ?? []).entries()) {
      if (!evidenceIds.has(evidenceId)) {
        context.addIssue({
          code: 'custom',
          message: `Diagnostic references unknown evidence: ${evidenceId}`,
          path: ['diagnostics', index, 'evidenceIds', evidenceIndex],
        });
      }
    }
  }
}
