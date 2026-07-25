import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertChainAnalysisMcpReadiness,
  type ChainAnalysisMcpManifest,
  type ChainAnalysisMcpReadinessStore,
} from './mcp-readiness-gate.js';

const MANIFEST_FINGERPRINT = fingerprint('manifest');
const READINESS_FINGERPRINT = fingerprint('readiness');
const EVIDENCE_FINGERPRINT = fingerprint('evidence');
const POLICY_FINGERPRINT = fingerprint('policy');
const ADAPTERS = ['execution', 'mev_observation', 'snapshot'] as const;

describe('chain-analysis MCP readiness gate', () => {
  it('accepts an unexpired ready attestation with exact provider lineage', async () => {
    const fixture = createFixture();

    await expect(
      assertChainAnalysisMcpReadiness({
        expectedManifestFingerprint: MANIFEST_FINGERPRINT,
        manifest: fixture.manifest,
        now: new Date('2026-07-24T12:30:00.000Z'),
        readinessFingerprint: READINESS_FINGERPRINT,
        store: fixture.store,
      }),
    ).resolves.toEqual({
      evaluatedAt: '2026-07-24T12:00:00.000Z',
      nextEvaluationAt: '2026-07-24T13:00:00.000Z',
    });
  });

  it('fails closed for expired readiness or changed provider lineage', async () => {
    const expired = createFixture();
    await expect(
      assertChainAnalysisMcpReadiness({
        expectedManifestFingerprint: MANIFEST_FINGERPRINT,
        manifest: expired.manifest,
        now: new Date('2026-07-24T13:00:00.000Z'),
        readinessFingerprint: READINESS_FINGERPRINT,
        store: expired.store,
      }),
    ).rejects.toThrow('not currently valid');

    const changed = createFixture({ changeProviderFingerprint: true });
    await expect(
      assertChainAnalysisMcpReadiness({
        expectedManifestFingerprint: MANIFEST_FINGERPRINT,
        manifest: changed.manifest,
        now: new Date('2026-07-24T12:30:00.000Z'),
        readinessFingerprint: READINESS_FINGERPRINT,
        store: changed.store,
      }),
    ).rejects.toThrow('Provider deployment evidence');
  });

  it('requires the readiness policy to cover every production adapter', async () => {
    const fixture = createFixture({ requiredAdapters: ['snapshot'] });

    await expect(
      assertChainAnalysisMcpReadiness({
        expectedManifestFingerprint: MANIFEST_FINGERPRINT,
        manifest: fixture.manifest,
        now: new Date('2026-07-24T12:30:00.000Z'),
        readinessFingerprint: READINESS_FINGERPRINT,
        store: fixture.store,
      }),
    ).rejects.toThrow('does not cover');
  });
});

function createFixture(options?: {
  changeProviderFingerprint?: boolean;
  requiredAdapters?: readonly string[];
}): {
  manifest: ChainAnalysisMcpManifest;
  store: ChainAnalysisMcpReadinessStore;
} {
  const providers = ADAPTERS.flatMap((adapter) =>
    ['primary', 'secondary'].map((suffix) => ({
      budgetPolicy: {
        adapter,
        chainId: '1',
        policyFingerprint: fingerprint(`${adapter}-${suffix}-budget`),
        providerId: `${adapter}_${suffix}`,
      },
      descriptor: {
        adapter,
        chainId: '1',
        configurationFingerprint: fingerprint(`${adapter}-${suffix}-configuration`),
        descriptorFingerprint: fingerprint(`${adapter}-${suffix}-descriptor`),
        providerId: `${adapter}_${suffix}`,
      },
    })),
  );
  const evidenceProviders = providers.map(({ descriptor }, index) => ({
    ...descriptor,
    descriptorFingerprint:
      options?.changeProviderFingerprint === true && index === 0
        ? fingerprint('changed-descriptor')
        : descriptor.descriptorFingerprint,
  }));
  return {
    manifest: {
      chainId: '1',
      manifestFingerprint: MANIFEST_FINGERPRINT,
      providers,
    },
    store: {
      getOperationsEvidence() {
        return Promise.resolve({
          evidence: {
            budgetPolicies: providers.map(({ budgetPolicy }) => budgetPolicy),
            providers: evidenceProviders,
          },
        });
      },
      getPolicy() {
        return Promise.resolve({
          minProvidersPerAdapterChain: 2,
          requiredAdapters: options?.requiredAdapters ?? ADAPTERS,
          requiredChains: ['1'],
        });
      },
      getReadinessAttestation() {
        return Promise.resolve({
          evaluatedAt: '2026-07-24T12:00:00.000Z',
          nextEvaluationAt: '2026-07-24T13:00:00.000Z',
          operations: { evidenceFingerprint: EVIDENCE_FINGERPRINT },
          policyFingerprint: POLICY_FINGERPRINT,
          status: 'ready',
        });
      },
    },
  };
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
