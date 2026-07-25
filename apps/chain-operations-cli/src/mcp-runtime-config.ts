import { z } from 'zod';

import { ChainOperationsCliError, type ChainOperationsEnv } from './runtime-config.js';

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export interface ChainAnalysisMcpRuntimeConfig {
  manifestFingerprint: string;
  readinessFingerprint: string;
}

export function loadChainAnalysisMcpRuntimeConfig(
  env: ChainOperationsEnv,
): ChainAnalysisMcpRuntimeConfig {
  return {
    manifestFingerprint: parseFingerprint(
      env.CHAIN_ANALYSIS_DATA_PLANE_MANIFEST_FINGERPRINT,
      'CHAIN_ANALYSIS_DATA_PLANE_MANIFEST_FINGERPRINT',
    ),
    readinessFingerprint: parseFingerprint(
      env.CHAIN_ANALYSIS_READINESS_FINGERPRINT,
      'CHAIN_ANALYSIS_READINESS_FINGERPRINT',
    ),
  };
}

function parseFingerprint(value: string | undefined, name: string): string {
  const parsed = fingerprintSchema.safeParse(value?.trim());
  if (!parsed.success) {
    throw new ChainOperationsCliError(
      'configuration_error',
      `${name} must be a SHA-256 fingerprint.`,
    );
  }
  return parsed.data;
}
