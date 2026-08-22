import { describe, expect, it } from 'vitest';

import { runPublicTransactionCli } from './transaction-cli.js';

describe('public transaction Skill CLI', () => {
  it('validates arguments before browser startup', async () => {
    await expect(runPublicTransactionCli({ argv: [] })).rejects.toThrow('--reference is required');
    await expect(
      runPublicTransactionCli({ argv: ['--reference', 'x', '--rpc', 'hidden'] }),
    ).rejects.toThrow('Unknown argument: --rpc');
  });

  it('accepts the standard package-script argument separator', async () => {
    await expect(
      runPublicTransactionCli({
        argv: ['--', '--reference', '0x123'],
        env: { PATH: '' },
      }),
    ).rejects.toThrow('Chrome or Chromium');
  });
});
