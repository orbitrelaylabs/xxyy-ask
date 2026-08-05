export interface BuiltInEvmNetworkProfile {
  aliases: readonly string[];
  canonicalNetwork: `eip155:${string}`;
  chainId: string;
  explorerBaseUrl: string;
  explorerHosts: readonly string[];
  name: string;
}

export const BUILT_IN_EVM_NETWORKS: readonly BuiltInEvmNetworkProfile[] = [
  {
    aliases: ['eth', 'ethereum', 'eip155:1'],
    canonicalNetwork: 'eip155:1',
    chainId: '1',
    explorerBaseUrl: 'https://etherscan.io',
    explorerHosts: ['etherscan.io', 'www.etherscan.io'],
    name: 'Ethereum',
  },
  {
    aliases: ['bsc', 'bnb', 'bnbchain', 'bnb-smart-chain', 'eip155:56'],
    canonicalNetwork: 'eip155:56',
    chainId: '56',
    explorerBaseUrl: 'https://bscscan.com',
    explorerHosts: ['bscscan.com', 'www.bscscan.com'],
    name: 'BNB Smart Chain',
  },
  {
    aliases: ['base', 'base-mainnet', 'eip155:8453'],
    canonicalNetwork: 'eip155:8453',
    chainId: '8453',
    explorerBaseUrl: 'https://basescan.org',
    explorerHosts: [
      'base.blockscout.com',
      'basescan.org',
      'www.base.blockscout.com',
      'www.basescan.org',
    ],
    name: 'Base',
  },
  {
    aliases: ['robin', 'robinhood', 'robinhood-chain', 'eip155:4663'],
    canonicalNetwork: 'eip155:4663',
    chainId: '4663',
    explorerBaseUrl: 'https://robinhoodchain.blockscout.com',
    explorerHosts: ['robinhoodchain.blockscout.com', 'www.robinhoodchain.blockscout.com'],
    name: 'Robinhood Chain',
  },
  {
    aliases: ['stable', 'stablechain', 'stable-chain', 'eip155:988'],
    canonicalNetwork: 'eip155:988',
    chainId: '988',
    explorerBaseUrl: 'https://stablescan.xyz',
    explorerHosts: ['stablescan.xyz', 'www.stablescan.xyz'],
    name: 'Stable Chain',
  },
] as const;

export const SOLANA_MAINNET_NETWORK = 'solana:mainnet';

const SOLANA_MAINNET_ALIASES = new Set(['sol', 'solana', SOLANA_MAINNET_NETWORK]);

export function findBuiltInEvmNetworkByAlias(value: string): BuiltInEvmNetworkProfile | undefined {
  const normalized = value.toLowerCase();
  return BUILT_IN_EVM_NETWORKS.find((network) => network.aliases.includes(normalized));
}

export function findBuiltInEvmNetworkByChainId(
  chainId: string,
): BuiltInEvmNetworkProfile | undefined {
  return BUILT_IN_EVM_NETWORKS.find((network) => network.chainId === chainId);
}

export function findBuiltInEvmNetworkByExplorerHost(
  host: string,
): BuiltInEvmNetworkProfile | undefined {
  const normalized = host.toLowerCase();
  return BUILT_IN_EVM_NETWORKS.find((network) => network.explorerHosts.includes(normalized));
}

export function normalizePublicNetworkIdentifier(value: string): string | undefined {
  const normalized = value.toLowerCase();
  const builtIn = findBuiltInEvmNetworkByAlias(normalized);
  if (builtIn !== undefined) return builtIn.canonicalNetwork;
  if (SOLANA_MAINNET_ALIASES.has(normalized)) return SOLANA_MAINNET_NETWORK;
  return undefined;
}
