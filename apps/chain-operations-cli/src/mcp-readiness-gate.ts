import { ChainOperationsCliError } from './runtime-config.js';

const REQUIRED_ADAPTERS = ['execution', 'mev_observation', 'snapshot'] as const;

interface ReadinessAttestation {
  evaluatedAt: string;
  nextEvaluationAt: string;
  operations: {
    evidenceFingerprint: string;
  };
  policyFingerprint: string;
  status: 'blocked' | 'degraded' | 'ready';
}

interface ReadinessProviderDescriptor {
  adapter: string;
  chainId: string;
  configurationFingerprint: string;
  descriptorFingerprint: string;
  providerId: string;
}

interface ReadinessBudgetPolicy {
  adapter: string;
  chainId: string;
  policyFingerprint: string;
  providerId: string;
}

interface ReadinessPolicy {
  minProvidersPerAdapterChain: number;
  requiredAdapters: readonly string[];
  requiredChains: readonly string[];
}

export interface ChainAnalysisMcpReadinessStore {
  getOperationsEvidence(evidenceFingerprint: string): Promise<
    | {
        evidence: {
          budgetPolicies: readonly ReadinessBudgetPolicy[];
          providers: readonly ReadinessProviderDescriptor[];
        };
      }
    | undefined
  >;
  getPolicy(policyFingerprint: string): Promise<ReadinessPolicy | undefined>;
  getReadinessAttestation(readinessFingerprint: string): Promise<ReadinessAttestation | undefined>;
}

export interface ChainAnalysisMcpManifest {
  chainId: string;
  manifestFingerprint: string;
  providers: readonly {
    budgetPolicy: ReadinessBudgetPolicy;
    descriptor: ReadinessProviderDescriptor;
  }[];
}

export interface AssertChainAnalysisMcpReadinessOptions {
  expectedManifestFingerprint: string;
  manifest: ChainAnalysisMcpManifest;
  now: Date;
  readinessFingerprint: string;
  store: ChainAnalysisMcpReadinessStore;
}

export async function assertChainAnalysisMcpReadiness(
  options: AssertChainAnalysisMcpReadinessOptions,
): Promise<{ evaluatedAt: string; nextEvaluationAt: string }> {
  if (options.manifest.manifestFingerprint !== options.expectedManifestFingerprint) {
    throw notReady('The configured chain data-plane manifest is not the pinned manifest.');
  }
  const attestation = await options.store.getReadinessAttestation(options.readinessFingerprint);
  if (attestation === undefined) {
    throw notReady('The pinned chain-analysis readiness attestation was not found.');
  }
  const nowMs = options.now.getTime();
  const evaluatedAtMs = Date.parse(attestation.evaluatedAt);
  const nextEvaluationAtMs = Date.parse(attestation.nextEvaluationAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(evaluatedAtMs) ||
    !Number.isFinite(nextEvaluationAtMs) ||
    attestation.status !== 'ready' ||
    evaluatedAtMs > nowMs ||
    nextEvaluationAtMs <= nowMs ||
    nextEvaluationAtMs <= evaluatedAtMs
  ) {
    throw notReady('The pinned chain-analysis readiness attestation is not currently valid.');
  }

  const [operationsEvidence, policy] = await Promise.all([
    options.store.getOperationsEvidence(attestation.operations.evidenceFingerprint),
    options.store.getPolicy(attestation.policyFingerprint),
  ]);
  if (operationsEvidence === undefined || policy === undefined) {
    throw notReady('The chain-analysis readiness lineage is incomplete.');
  }
  if (
    !policy.requiredChains.includes(options.manifest.chainId) ||
    policy.minProvidersPerAdapterChain < 2 ||
    REQUIRED_ADAPTERS.some((adapter) => !policy.requiredAdapters.includes(adapter))
  ) {
    throw notReady('The readiness policy does not cover the production chain data plane.');
  }

  assertExactFingerprintSet(
    options.manifest.providers.map(({ descriptor }) => ({
      fingerprint: descriptor.descriptorFingerprint,
      identity: providerIdentity(descriptor),
    })),
    operationsEvidence.evidence.providers.map((descriptor) => ({
      fingerprint: descriptor.descriptorFingerprint,
      identity: providerIdentity(descriptor),
    })),
    'Provider deployment evidence does not match the pinned manifest.',
  );
  assertExactFingerprintSet(
    options.manifest.providers.map(({ budgetPolicy }) => ({
      fingerprint: budgetPolicy.policyFingerprint,
      identity: providerIdentity(budgetPolicy),
    })),
    operationsEvidence.evidence.budgetPolicies.map((policyEntry) => ({
      fingerprint: policyEntry.policyFingerprint,
      identity: providerIdentity(policyEntry),
    })),
    'Provider budget evidence does not match the pinned manifest.',
  );

  return {
    evaluatedAt: attestation.evaluatedAt,
    nextEvaluationAt: attestation.nextEvaluationAt,
  };
}

function assertExactFingerprintSet(
  expectedEntries: readonly { fingerprint: string; identity: string }[],
  actualEntries: readonly { fingerprint: string; identity: string }[],
  message: string,
): void {
  const expected = new Map(expectedEntries.map((entry) => [entry.identity, entry.fingerprint]));
  const actual = new Map(actualEntries.map((entry) => [entry.identity, entry.fingerprint]));
  if (
    expected.size !== expectedEntries.length ||
    actual.size !== actualEntries.length ||
    expected.size !== actual.size ||
    Array.from(expected).some(([identity, fingerprint]) => actual.get(identity) !== fingerprint)
  ) {
    throw notReady(message);
  }
}

function providerIdentity(provider: {
  adapter: string;
  chainId: string;
  providerId: string;
}): string {
  return `${provider.chainId}:${provider.adapter}:${provider.providerId}`;
}

function notReady(message: string): ChainOperationsCliError {
  return new ChainOperationsCliError('configuration_error', message);
}
