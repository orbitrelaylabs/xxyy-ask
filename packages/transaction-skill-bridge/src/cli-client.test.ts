import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ExplorerBrowserUnavailableError,
  createTransactionSkillDiagnosisHandler,
  createTransactionSkillPublicClient,
  resolveTransactionSkillScriptPaths,
} from './index.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-skill.mjs', import.meta.url));
const scriptPaths = { diagnose: fixture, inspect: fixture };
const hash = `0x${'a'.repeat(64)}`;

describe('transaction Skill CLI bridge', () => {
  it('resolves only the two pinned dependency bundles', () => {
    expect(resolveTransactionSkillScriptPaths()).toMatchObject({
      diagnose: expect.stringContaining('xxyy-transaction-diagnosis/scripts/diagnose.mjs'),
      inspect: expect.stringContaining('onchain-transaction-inspector/scripts/inspect.mjs'),
    });
  });

  it('parses one transaction JSON response', async () => {
    const client = createTransactionSkillPublicClient({ scriptPaths });
    await expect(client.getTransaction({ network: 'bsc', reference: hash })).resolves.toMatchObject(
      {
        family: 'evm',
        transactionId: hash,
      },
    );
  });

  it('disables screenshots when the host has no deliverable directory', async () => {
    const diagnosis = createTransactionSkillDiagnosisHandler({
      env: { OPENAI_API_KEY: 'must-not-reach-skill' },
      scriptPaths,
    });
    const output = await diagnosis.diagnoseXxyyTransaction({
      checks: ['sandwich', 'pool'],
      reference: hash,
    });
    expect(output.summary).toContain('--screenshot disabled');
    expect(output.warnings).toEqual([]);
  });

  it('maps CLI browser failures to the stable host error', async () => {
    const client = createTransactionSkillPublicClient({ scriptPaths });
    await expect(client.getTransaction({ reference: 'fail' })).rejects.toBeInstanceOf(
      ExplorerBrowserUnavailableError,
    );
  });
});
