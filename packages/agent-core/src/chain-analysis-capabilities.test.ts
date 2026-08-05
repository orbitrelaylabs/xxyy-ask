import { describe, expect, it, vi } from 'vitest';

import {
  createPublicTransactionClientStub,
  type GetTransactionOutput,
} from '@xxyy/transaction-skill-bridge';
import { createInMemoryQualityTracer } from '@xxyy/rag-core';

import { CapabilityPolicyDeniedError } from './capability-registry.js';
import {
  CHAIN_GET_SKILL_CAPABILITY_ID,
  createPublicChainAnalysisCapabilityRegistry,
} from './chain-analysis-capabilities.js';

describe('public browser transaction Skill capability', () => {
  it('registers and executes only the direct Skill capability', async () => {
    const getTransaction = vi.fn(async () => transactionOutput());
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createPublicChainAnalysisCapabilityRegistry({
      caller: { channel: 'web', principal: 'anonymous' },
      client: createPublicTransactionClientStub(getTransaction),
      tracer,
    });

    await expect(
      registry.invoke(
        CHAIN_GET_SKILL_CAPABILITY_ID,
        { reference: `https://bscscan.com/tx/0x${'1'.repeat(64)}` },
        { channel: 'web', principal: 'anonymous' },
      ),
    ).resolves.toMatchObject({ family: 'solana', transactionId: '4'.repeat(88) });
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: CHAIN_GET_SKILL_CAPABILITY_ID, source: 'skill' }),
    ]);
    expect(records.filter((record) => record.name === 'agent.capability')).toHaveLength(1);
  });

  it('denies the Skill under a different caller identity', async () => {
    const registry = createPublicChainAnalysisCapabilityRegistry({
      caller: { channel: 'web', principal: 'anonymous' },
      client: createPublicTransactionClientStub(async () => transactionOutput()),
    });
    await expect(
      registry.invoke(
        CHAIN_GET_SKILL_CAPABILITY_ID,
        { reference: 'x' },
        { channel: 'telegram', principal: 'service' },
      ),
    ).rejects.toBeInstanceOf(CapabilityPolicyDeniedError);
  });
});

function transactionOutput(): GetTransactionOutput {
  const signature = '4'.repeat(88);
  return {
    analysis: {
      accountKeys: [],
      executionStatus: 'success',
      logCount: 0,
      nativeBalanceChanges: [],
      network: 'solana:mainnet',
      programIds: [],
      slot: '1',
      sources: [
        {
          id: 'solscan_browser',
          kind: 'explorer_browser',
          observedAt: '2026-08-04T00:00:00.000Z',
          payloadHash: `sha256:${'a'.repeat(64)}`,
          provenanceUrl: `https://solscan.io/tx/${signature}`,
        },
      ],
      tokenBalanceChanges: [],
      transactionId: signature,
    },
    diagnostics: [],
    explorerUrl: `https://solscan.io/tx/${signature}`,
    family: 'solana',
    network: 'solana:mainnet',
    status: 'partial',
    summary: 'Browser evidence.',
    transactionId: signature,
  };
}
