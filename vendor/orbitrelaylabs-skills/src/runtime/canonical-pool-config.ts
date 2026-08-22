import { z } from 'zod';

const identifierSchema = z.string().trim().min(1).max(256);

export const xxyyCanonicalPoolConfigSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            chain: z.string().trim().min(2).max(96),
            pairAddress: identifierSchema,
            tokenAddress: identifierSchema,
          })
          .strict(),
      )
      .max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const [index, entry] of value.entries.entries()) {
      const key = `${entry.chain.toLowerCase()}:${normalizeIdentifier(entry.chain, entry.tokenAddress)}`;
      if (keys.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'Canonical pool entries must be unique by chain and token.',
          path: ['entries', index],
        });
      }
      keys.add(key);
    }
  });

export function createConfiguredCanonicalPoolResolver(rawConfig: string | unknown) {
  const config = xxyyCanonicalPoolConfigSchema.parse(
    typeof rawConfig === 'string' ? parseJson(rawConfig) : rawConfig,
  );
  const byToken = new Map(
    config.entries.map((entry) => [
      `${entry.chain.toLowerCase()}:${normalizeIdentifier(entry.chain, entry.tokenAddress)}`,
      entry.pairAddress,
    ]),
  );
  return (input: { chain: string; targetTokenAddresses: readonly string[] }) => {
    const matches = new Set(
      input.targetTokenAddresses.flatMap((token) => {
        const pair = byToken.get(
          `${input.chain.toLowerCase()}:${normalizeIdentifier(input.chain, token)}`,
        );
        return pair === undefined ? [] : [pair];
      }),
    );
    return matches.size === 1 ? [...matches][0] : undefined;
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new TypeError('XXYY_CANONICAL_POOL_CONFIG_JSON must be valid JSON.', { cause });
  }
}

function normalizeIdentifier(chain: string, value: string): string {
  return chain.toLowerCase().startsWith('eip155:') ? value.toLowerCase() : value;
}
