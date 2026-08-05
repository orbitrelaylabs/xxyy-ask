import type { GetTransactionInput } from './contracts.js';

export interface BuiltInEvmNetworkProfile {
  aliases: readonly string[];
  canonicalNetwork: `eip155:${string}`;
  chainId: string;
  explorerBaseUrl: string;
  explorerHosts: readonly string[];
  name: string;
}

export const BUILT_IN_EVM_NETWORKS: readonly BuiltInEvmNetworkProfile[] = [
  profile(
    '1',
    'Ethereum',
    'https://etherscan.io',
    ['etherscan.io', 'www.etherscan.io'],
    ['eth', 'ethereum', 'eip155:1'],
  ),
  profile(
    '56',
    'BNB Smart Chain',
    'https://bscscan.com',
    ['bscscan.com', 'www.bscscan.com'],
    ['bsc', 'bnb', 'bnbchain', 'bnb-smart-chain', 'eip155:56'],
  ),
  profile(
    '8453',
    'Base',
    'https://basescan.org',
    ['base.blockscout.com', 'basescan.org', 'www.base.blockscout.com', 'www.basescan.org'],
    ['base', 'base-mainnet', 'eip155:8453'],
  ),
  profile(
    '4663',
    'Robinhood Chain',
    'https://robinhoodchain.blockscout.com',
    ['robinhoodchain.blockscout.com', 'www.robinhoodchain.blockscout.com'],
    ['robin', 'robinhood', 'robinhood-chain', 'eip155:4663'],
  ),
  profile(
    '988',
    'Stable Chain',
    'https://stablescan.xyz',
    ['stablescan.xyz', 'www.stablescan.xyz'],
    ['stable', 'stablechain', 'stable-chain', 'eip155:988'],
  ),
];

export const SOLANA_MAINNET_NETWORK = 'solana:mainnet';

export function findBuiltInEvmNetworkByChainId(
  chainId: string,
): BuiltInEvmNetworkProfile | undefined {
  return BUILT_IN_EVM_NETWORKS.find((network) => network.chainId === chainId);
}

export function normalizePublicNetworkIdentifier(value: string): string | undefined {
  const normalized = value.toLowerCase();
  const evm = BUILT_IN_EVM_NETWORKS.find((network) => network.aliases.includes(normalized));
  if (evm !== undefined) return evm.canonicalNetwork;
  return ['sol', 'solana', SOLANA_MAINNET_NETWORK].includes(normalized)
    ? SOLANA_MAINNET_NETWORK
    : undefined;
}

export class PublicTransactionReferenceError extends Error {
  readonly code = 'invalid_reference';

  constructor() {
    super('The transaction reference or network is invalid or ambiguous.');
    this.name = 'PublicTransactionReferenceError';
  }
}

export function resolvePublicTransactionReference(input: GetTransactionInput): {
  chainId?: string;
  explorerUrl?: string;
  family: 'evm' | 'solana';
  network: string;
  transactionId: string;
} {
  const explicit =
    input.network === undefined ? undefined : normalizePublicNetworkIdentifier(input.network);
  if (input.network !== undefined && explicit === undefined) throw invalidReference();
  if (!/^https?:\/\//iu.test(input.reference)) return resolveRaw(input.reference, explicit);
  let url: URL;
  try {
    url = new URL(input.reference);
  } catch {
    throw invalidReference();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw invalidReference();
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'tx' || parts[1] === undefined)
    throw invalidReference();
  const evm = BUILT_IN_EVM_NETWORKS.find((item) =>
    item.explorerHosts.includes(url.hostname.toLowerCase()),
  );
  if (evm !== undefined) {
    assertMatch(explicit, evm.canonicalNetwork);
    const transactionId = parseEvmHash(parts[1]);
    return {
      chainId: evm.chainId,
      explorerUrl: `${evm.explorerBaseUrl}/tx/${transactionId}`,
      family: 'evm',
      network: evm.canonicalNetwork,
      transactionId,
    };
  }
  if (
    ['explorer.solana.com', 'solscan.io', 'www.solscan.io'].includes(url.hostname.toLowerCase())
  ) {
    const cluster = url.searchParams.get('cluster')?.toLowerCase();
    if (cluster !== undefined && !['mainnet', 'mainnet-beta'].includes(cluster))
      throw invalidReference();
    assertMatch(explicit, SOLANA_MAINNET_NETWORK);
    const transactionId = parseSolanaSignature(parts[1]);
    return {
      explorerUrl: `https://solscan.io/tx/${transactionId}`,
      family: 'solana',
      network: SOLANA_MAINNET_NETWORK,
      transactionId,
    };
  }
  throw invalidReference();
}

function resolveRaw(reference: string, network: string | undefined) {
  if (network?.startsWith('eip155:')) {
    const transactionId = parseEvmHash(reference);
    const chainId = network.slice('eip155:'.length);
    const known = findBuiltInEvmNetworkByChainId(chainId);
    return {
      chainId,
      ...(known === undefined
        ? {}
        : { explorerUrl: `${known.explorerBaseUrl}/tx/${transactionId}` }),
      family: 'evm' as const,
      network,
      transactionId,
    };
  }
  if (network === SOLANA_MAINNET_NETWORK) {
    const transactionId = parseSolanaSignature(reference);
    return {
      explorerUrl: `https://solscan.io/tx/${transactionId}`,
      family: 'solana' as const,
      network,
      transactionId,
    };
  }
  throw invalidReference();
}

function profile(
  chainId: string,
  name: string,
  explorerBaseUrl: string,
  explorerHosts: readonly string[],
  aliases: readonly string[],
): BuiltInEvmNetworkProfile {
  return {
    aliases,
    canonicalNetwork: `eip155:${chainId}`,
    chainId,
    explorerBaseUrl,
    explorerHosts,
    name,
  };
}

function parseEvmHash(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) throw invalidReference();
  return value;
}

function parseSolanaSignature(value: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,128}$/u.test(value)) throw invalidReference();
  return value;
}

function assertMatch(explicit: string | undefined, resolved: string): void {
  if (explicit !== undefined && explicit !== resolved) throw invalidReference();
}

function invalidReference(): PublicTransactionReferenceError {
  return new PublicTransactionReferenceError();
}
