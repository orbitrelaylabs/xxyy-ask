import { describe, expect, it } from 'vitest';

import { xxyyPairUrl } from './chrome-screenshot-provider.js';

describe('xxyyPairUrl', () => {
  it('maps only fixed XXYY chain routes', () => {
    expect(xxyyPairUrl('solana:mainnet', '4EBLSHwS9fCmvEva1ZXFoczrkNUtcXiz3RQtCizPP1mP')).toBe(
      'https://www.xxyy.io/sol/4EBLSHwS9fCmvEva1ZXFoczrkNUtcXiz3RQtCizPP1mP',
    );
    expect(() => xxyyPairUrl('unknown', 'abc')).toThrow(TypeError);
    expect(() => xxyyPairUrl('solana:mainnet', '../admin')).toThrow(TypeError);
  });
});
