import { describe, expect, it } from 'vitest';

import { createConfiguredCanonicalPoolResolver } from './canonical-pool-config.js';

describe('createConfiguredCanonicalPoolResolver', () => {
  it('resolves only an explicitly configured chain and token', () => {
    const resolve = createConfiguredCanonicalPoolResolver({
      entries: [
        {
          chain: 'eip155:1',
          pairAddress: '0x2222222222222222222222222222222222222222',
          tokenAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      ],
    });
    expect(
      resolve({
        chain: 'eip155:1',
        targetTokenAddresses: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      }),
    ).toBe('0x2222222222222222222222222222222222222222');
    expect(
      resolve({ chain: 'eip155:56', targetTokenAddresses: ['0x' + 'a'.repeat(40)] }),
    ).toBeUndefined();
  });

  it('rejects duplicate declarations instead of picking by order', () => {
    expect(() =>
      createConfiguredCanonicalPoolResolver({
        entries: [
          { chain: 'solana:mainnet', pairAddress: 'pair-1', tokenAddress: 'token-1' },
          { chain: 'solana:mainnet', pairAddress: 'pair-2', tokenAddress: 'token-1' },
        ],
      }),
    ).toThrow();
  });
});
