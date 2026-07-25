import { describe, expect, it } from 'vitest';

import { getTransactionInputSchema } from './contracts.js';
import { resolvePublicTransactionReference } from './transaction-reference.js';

const EVM_HASH = `0x${'ab'.repeat(32)}`;
const SOLANA_SIGNATURE =
  '5h6xBEauJ3PK6SWCZ1q9mVqQPfV9VhJ1wN3EZ7hJQf8sJLBX5Un19XTrRruDq4WZx9ZMkF7Xr1ezKj9eVJb2xYwA';

describe('resolvePublicTransactionReference', () => {
  it('resolves Etherscan and BscScan transaction URLs', () => {
    expect(
      resolvePublicTransactionReference({
        reference: `https://etherscan.io/tx/${EVM_HASH}`,
      }),
    ).toMatchObject({
      chainId: '1',
      family: 'evm',
      network: 'eip155:1',
      transactionId: EVM_HASH,
    });
    expect(
      resolvePublicTransactionReference({
        reference: `https://bscscan.com/tx/${EVM_HASH}`,
      }),
    ).toMatchObject({
      chainId: '56',
      family: 'evm',
      network: 'eip155:56',
    });
  });

  it.each([
    ['https://basescan.org', '8453', 'eip155:8453'],
    ['https://base.blockscout.com', '8453', 'eip155:8453'],
    ['https://robinhoodchain.blockscout.com', '4663', 'eip155:4663'],
    ['https://stablescan.xyz', '988', 'eip155:988'],
  ])('resolves the built-in EVM Explorer %s', (explorer, chainId, network) => {
    expect(
      resolvePublicTransactionReference({
        reference: `${explorer}/tx/${EVM_HASH}`,
      }),
    ).toMatchObject({
      chainId,
      family: 'evm',
      network,
      transactionId: EVM_HASH,
    });
  });

  it.each([
    ['ethereum', '1'],
    ['bnb-smart-chain', '56'],
    ['base', '8453'],
    ['robinhood-chain', '4663'],
    ['stable-chain', '988'],
  ])('resolves the built-in EVM alias %s', (network, chainId) => {
    const input = getTransactionInputSchema.parse({
      network,
      reference: EVM_HASH,
    });
    expect(resolvePublicTransactionReference(input)).toMatchObject({
      chainId,
      family: 'evm',
      network: `eip155:${chainId}`,
    });
  });

  it('resolves Solscan links and canonicalizes the Explorer URL', () => {
    expect(
      resolvePublicTransactionReference({
        reference: `https://www.solscan.io/tx/${SOLANA_SIGNATURE}?utm_source=test`,
      }),
    ).toEqual({
      explorerUrl: `https://solscan.io/tx/${SOLANA_SIGNATURE}`,
      family: 'solana',
      network: 'solana:mainnet',
      transactionId: SOLANA_SIGNATURE,
    });
  });

  it('requires an explicit network for raw transaction ids', () => {
    expect(() => resolvePublicTransactionReference({ reference: EVM_HASH })).toThrow(
      'invalid or ambiguous',
    );
    expect(
      resolvePublicTransactionReference({
        network: 'bsc',
        reference: EVM_HASH,
      }),
    ).toMatchObject({
      chainId: '56',
      family: 'evm',
    });
  });

  it('rejects a network that conflicts with an Explorer URL', () => {
    expect(() =>
      resolvePublicTransactionReference({
        network: 'bsc',
        reference: `https://etherscan.io/tx/${EVM_HASH}`,
      }),
    ).toThrow('invalid or ambiguous');
  });

  it('rejects Solana Explorer links that explicitly select a non-mainnet cluster', () => {
    expect(() =>
      resolvePublicTransactionReference({
        reference: `https://explorer.solana.com/tx/${SOLANA_SIGNATURE}?cluster=devnet`,
      }),
    ).toThrow('invalid or ambiguous');
  });

  it('classifies malformed transaction ids as invalid references', () => {
    expect(() =>
      resolvePublicTransactionReference({
        reference: 'https://etherscan.io/tx/not-a-transaction',
      }),
    ).toThrow('invalid or ambiguous');
    expect(() =>
      resolvePublicTransactionReference({
        network: 'solana',
        reference: 'not-a-signature',
      }),
    ).toThrow('invalid or ambiguous');
  });
});
