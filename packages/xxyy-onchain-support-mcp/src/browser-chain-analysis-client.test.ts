import { describe, expect, it } from 'vitest';

import { resolveSolanaBrowserTransactionId } from './browser-chain-analysis-client.js';

const signature =
  'mC3JipVwKobtkB1evDCxb9jDWqic9aVaRj81r6ffNweQ3gfmA9vPJCmftTuUCECb35TbvovRznezsuL7TCq6BVb';

describe('browser chain analysis client', () => {
  it('accepts a Solana signature or fixed Solscan transaction URL', () => {
    expect(resolveSolanaBrowserTransactionId(signature, 'solana:mainnet')).toBe(signature);
    expect(resolveSolanaBrowserTransactionId(`https://solscan.io/tx/${signature}`)).toBe(signature);
  });

  it('rejects non-allowlisted explorer URLs and non-Solana networks', () => {
    expect(() =>
      resolveSolanaBrowserTransactionId(`https://example.com/tx/${signature}`),
    ).toThrow();
    expect(() => resolveSolanaBrowserTransactionId(signature, 'eip155:1')).toThrow();
  });
});
