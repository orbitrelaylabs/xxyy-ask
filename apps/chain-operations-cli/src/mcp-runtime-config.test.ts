import { describe, expect, it } from 'vitest';

import { loadChainAnalysisMcpRuntimeConfig } from './mcp-runtime-config.js';

const HASH = `sha256:${'12'.repeat(32)}`;

describe('chain-analysis MCP runtime config', () => {
  it('requires pinned manifest and readiness fingerprints', () => {
    expect(
      loadChainAnalysisMcpRuntimeConfig({
        CHAIN_ANALYSIS_DATA_PLANE_MANIFEST_FINGERPRINT: HASH,
        CHAIN_ANALYSIS_READINESS_FINGERPRINT: HASH,
      }),
    ).toEqual({
      manifestFingerprint: HASH,
      readinessFingerprint: HASH,
    });
    expect(() => loadChainAnalysisMcpRuntimeConfig({})).toThrow(
      'CHAIN_ANALYSIS_DATA_PLANE_MANIFEST_FINGERPRINT',
    );
  });
});
