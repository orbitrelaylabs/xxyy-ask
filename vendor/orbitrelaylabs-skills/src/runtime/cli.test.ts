import { describe, expect, it } from 'vitest';

import { main, runXxyyTransactionDiagnosisCli } from './cli.js';

describe('XXYY transaction diagnosis CLI', () => {
  it('fails before browser startup when reference is missing', async () => {
    await expect(runXxyyTransactionDiagnosisCli({ argv: [] })).rejects.toThrow(
      '--reference is required',
    );
  });

  it('rejects invalid checks and unknown arguments before browser startup', async () => {
    await expect(
      runXxyyTransactionDiagnosisCli({
        argv: ['--reference', '0x123', '--checks', 'sandwich,sandwich'],
      }),
    ).rejects.toThrow('--checks must contain unique sandwich and/or pool values');
    await expect(
      runXxyyTransactionDiagnosisCli({ argv: ['--reference', '0x123', '--rpc', 'hidden'] }),
    ).rejects.toThrow('Unknown argument: --rpc');
    await expect(
      runXxyyTransactionDiagnosisCli({
        argv: ['--reference', '0x123', '--screenshot', 'sometimes'],
      }),
    ).rejects.toThrow('--screenshot must be disabled or required');
  });

  it('prints usage without starting the runtime', async () => {
    const write = process.stdout.write;
    let output = '';
    process.stdout.write = ((value: string) => {
      output += value;
      return true;
    }) as typeof process.stdout.write;
    try {
      await main({ argv: ['--help'] });
    } finally {
      process.stdout.write = write;
    }
    expect(output).toContain('Usage: diagnose.mjs --reference');
  });

  it('accepts the standard package-script argument separator', async () => {
    await expect(
      runXxyyTransactionDiagnosisCli({
        argv: ['--', '--reference', '0x123', '--screenshot', 'disabled'],
        env: { PATH: '' },
      }),
    ).rejects.toThrow('Chrome or Chromium');
  });
});
