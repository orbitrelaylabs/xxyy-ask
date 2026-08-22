import { evmHashSchema } from '../transaction-analysis/index.js';

import type { GetTransactionInput } from './public-transaction-contracts.js';
import {
  SOLANA_MAINNET_NETWORK,
  findBuiltInEvmNetworkByChainId,
  findBuiltInEvmNetworkByExplorerHost,
  normalizePublicNetworkIdentifier,
} from './network-profiles.js';
import { solanaSignatureSchema } from './solana-browser-contracts.js';

export class PublicTransactionReferenceError extends Error {
  readonly code = 'invalid_reference';

  constructor() {
    super('The transaction reference or network is invalid or ambiguous.');
    this.name = 'PublicTransactionReferenceError';
  }
}

export interface EvmTransactionReference {
  chainId: string;
  explorerUrl?: string;
  family: 'evm';
  network: string;
  transactionId: string;
}

export interface SolanaTransactionReference {
  explorerUrl: string;
  family: 'solana';
  network: 'solana:mainnet';
  transactionId: string;
}

export type PublicTransactionReference = EvmTransactionReference | SolanaTransactionReference;

const SOLANA_EXPLORER_HOSTS = new Set(['explorer.solana.com', 'solscan.io', 'www.solscan.io']);

export function resolvePublicTransactionReference(
  input: GetTransactionInput,
): PublicTransactionReference {
  const explicitNetwork = input.network === undefined ? undefined : normalizeNetwork(input.network);
  return looksLikeUrl(input.reference)
    ? resolveExplorerUrl(input.reference, explicitNetwork)
    : resolveRawTransactionId(input.reference, explicitNetwork);
}

function resolveExplorerUrl(
  reference: string,
  explicitNetwork: string | undefined,
): PublicTransactionReference {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw invalidReference();
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw invalidReference();
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'tx' || parts[1] === undefined) {
    throw invalidReference();
  }
  const evm = findBuiltInEvmNetworkByExplorerHost(url.hostname);
  if (evm !== undefined) {
    assertNetworkMatch(explicitNetwork, evm.canonicalNetwork);
    const transactionId = parseEvmTransactionId(parts[1]);
    return {
      chainId: evm.chainId,
      explorerUrl: `${evm.explorerBaseUrl}/tx/${transactionId}`,
      family: 'evm',
      network: evm.canonicalNetwork,
      transactionId,
    };
  }
  if (SOLANA_EXPLORER_HOSTS.has(url.hostname.toLowerCase())) {
    const cluster = url.searchParams.get('cluster')?.toLowerCase();
    if (cluster !== undefined && cluster !== 'mainnet' && cluster !== 'mainnet-beta') {
      throw invalidReference();
    }
    assertNetworkMatch(explicitNetwork, SOLANA_MAINNET_NETWORK);
    const transactionId = parseSolanaTransactionId(parts[1]);
    return {
      explorerUrl: `https://solscan.io/tx/${transactionId}`,
      family: 'solana',
      network: SOLANA_MAINNET_NETWORK,
      transactionId,
    };
  }
  throw invalidReference();
}

function resolveRawTransactionId(
  reference: string,
  explicitNetwork: string | undefined,
): PublicTransactionReference {
  if (explicitNetwork?.startsWith('eip155:')) {
    const transactionId = parseEvmTransactionId(reference);
    const chainId = explicitNetwork.slice('eip155:'.length);
    const known = findBuiltInEvmNetworkByChainId(chainId);
    return {
      chainId,
      ...(known === undefined
        ? {}
        : { explorerUrl: `${known.explorerBaseUrl}/tx/${transactionId}` }),
      family: 'evm',
      network: explicitNetwork,
      transactionId,
    };
  }
  if (explicitNetwork === SOLANA_MAINNET_NETWORK) {
    const transactionId = parseSolanaTransactionId(reference);
    return {
      explorerUrl: `https://solscan.io/tx/${transactionId}`,
      family: 'solana',
      network: explicitNetwork,
      transactionId,
    };
  }
  throw invalidReference();
}

function normalizeNetwork(network: string): string {
  const normalized = normalizePublicNetworkIdentifier(network);
  if (normalized === undefined) throw invalidReference();
  return normalized;
}

function assertNetworkMatch(explicit: string | undefined, resolved: string): void {
  if (explicit !== undefined && explicit !== resolved) throw invalidReference();
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function parseEvmTransactionId(value: string): string {
  const result = evmHashSchema.safeParse(value);
  if (!result.success) throw invalidReference();
  return result.data;
}

function parseSolanaTransactionId(value: string): string {
  const result = solanaSignatureSchema.safeParse(value);
  if (!result.success) throw invalidReference();
  return result.data;
}

function invalidReference(): PublicTransactionReferenceError {
  return new PublicTransactionReferenceError();
}
