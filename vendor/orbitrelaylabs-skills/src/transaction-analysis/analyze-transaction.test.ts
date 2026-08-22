import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { analyzeEvmTransactionSnapshot } from './analyze-transaction.js';
import {
  ERC20_TRANSFER_TOPIC,
  EVM_UINT256_MAX,
  EVM_ZERO_ADDRESS,
  evmTransactionSnapshotSchema,
  transactionAnalysisResultSchema,
} from './contracts.js';

const sender = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';
const tokenRecipient = '0x4444444444444444444444444444444444444444';

async function loadFixture(name: string): Promise<unknown> {
  const content = await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(content) as unknown;
}

describe('analyzeEvmTransactionSnapshot fixtures', () => {
  it('replays the same normalized snapshot to byte-identical JSON-safe output', async () => {
    const snapshot = await loadFixture('success-native-erc20');
    const first = analyzeEvmTransactionSnapshot(snapshot);
    const second = analyzeEvmTransactionSnapshot(snapshot);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('analyzes successful native value, ERC-20 Transfer logs, fee, timeline, and evidence', async () => {
    const result = analyzeEvmTransactionSnapshot(await loadFixture('success-native-erc20'));

    expect(transactionAnalysisResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      diagnostics: [],
      status: 'success',
      transaction: {
        blockNumber: '19000000',
        blockTimestamp: '1700000000',
        executionStatus: 'success',
        feeWei: '42000000000000',
        inputKind: 'contract_call',
        valueWei: '1000000000000000000',
      },
      warnings: [],
    });
    expect(result.tokenTransfers).toEqual([
      {
        amountRaw: '1000',
        evidenceId: 'log:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:7',
        from: sender,
        logIndex: 7,
        to: tokenRecipient,
        tokenAddress: token,
        transferType: 'transfer',
      },
    ]);
    expect(
      result.assetChanges.map((change) => ({
        address: change.address,
        asset: change.asset,
        rawDelta: change.rawDelta,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          address: sender,
          asset: { chainId: '1', kind: 'native' },
          rawDelta: '-1000042000000000000',
        },
        {
          address: recipient,
          asset: { chainId: '1', kind: 'native' },
          rawDelta: '1000000000000000000',
        },
        {
          address: sender,
          asset: { contractAddress: token, kind: 'erc20' },
          rawDelta: '-1000',
        },
        {
          address: tokenRecipient,
          asset: { contractAddress: token, kind: 'erc20' },
          rawDelta: '1000',
        },
      ]),
    );
    expect(result.assetChanges.every((change) => change.evidenceIds.length > 0)).toBe(true);
    expect(result.timeline.map((item) => item.kind)).toEqual([
      'execution',
      'native_transfer',
      'token_transfer',
      'fee',
      'block_context',
    ]);
    expect(result.timeline.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(result.findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        'transaction_envelope',
        'execution_status',
        'native_transfer',
        'gas_fee',
        'erc20_transfers',
        'block_context',
      ]),
    );
  });

  it('treats a reverted transaction as a completed analysis without applying value transfers', async () => {
    const result = analyzeEvmTransactionSnapshot(await loadFixture('reverted'));

    expect(result.status).toBe('success');
    expect(result.transaction).toMatchObject({
      executionStatus: 'reverted',
      feeWei: '150000000000000',
      inputKind: 'native_transfer',
      valueWei: '500000000000000000',
    });
    expect(result.tokenTransfers).toEqual([]);
    expect(
      result.assetChanges.map((change) => ({
        address: change.address,
        asset: change.asset,
        rawDelta: change.rawDelta,
      })),
    ).toEqual([
      {
        address: sender,
        asset: { chainId: '1', kind: 'native' },
        rawDelta: '-150000000000000',
      },
    ]);
    expect(result.assetChanges[0]?.evidenceIds.length).toBeGreaterThan(0);
    expect(result.timeline.map((item) => item.kind)).toEqual(['execution', 'fee', 'block_context']);
  });

  it('returns partial when a transaction receipt is unavailable and does not invent asset changes', async () => {
    const result = analyzeEvmTransactionSnapshot(await loadFixture('partial-missing-receipt'));

    expect(result).toMatchObject({
      assetChanges: [],
      status: 'partial',
      tokenTransfers: [],
      transaction: {
        executionStatus: 'pending',
        inputKind: 'native_transfer',
      },
      warnings: ['receipt_missing_execution_unconfirmed'],
    });
    expect(result.transaction).not.toHaveProperty('feeWei');
    expect(result.diagnostics).toContainEqual({
      code: 'receipt_missing',
      retryable: true,
      stage: 'load',
    });
    expect(result.findings.find((finding) => finding.id === 'execution_status')).toMatchObject({
      confidence: 0.5,
      inference: true,
    });
  });

  it('preserves source conflicts and malformed Transfer diagnostics without decoding the bad log', async () => {
    const result = analyzeEvmTransactionSnapshot(await loadFixture('conflict-malformed-log'));

    expect(result.status).toBe('partial');
    expect(result.conflicts).toEqual([
      {
        evidenceId: 'conflict:1',
        field: 'receipt.status',
        sourceIds: ['indexer-secondary', 'rpc-primary'],
      },
    ]);
    expect(result.tokenTransfers).toEqual([]);
    expect(result.warnings).toEqual([
      'unresolved_source_conflicts:1',
      'malformed_erc20_transfer_log:8',
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'source_conflict',
      'malformed_erc20_transfer_log',
    ]);
    expect(result.transaction.feeWei).toBe('140000000000000');
    expect(
      result.evidence.find((evidence) => evidence.id === 'conflict:1')?.structuredData,
    ).toEqual({
      field: 'receipt.status',
      sourceIds: ['indexer-secondary', 'rpc-primary'],
    });
  });

  it('returns insufficient_data when the requested transaction is missing', async () => {
    const result = analyzeEvmTransactionSnapshot(
      await loadFixture('insufficient-missing-transaction'),
    );

    expect(result).toMatchObject({
      assetChanges: [],
      evidence: [],
      findings: [],
      status: 'insufficient_data',
      timeline: [],
      tokenTransfers: [],
      transaction: { executionStatus: 'unknown', inputKind: 'unknown' },
      warnings: ['transaction_missing'],
    });
    expect(result.diagnostics).toEqual([
      { code: 'transaction_missing', retryable: true, stage: 'load' },
    ]);
  });
});

describe('analyzeEvmTransactionSnapshot edge cases', () => {
  it('refuses to analyze a returned transaction with a different hash', async () => {
    const fixture = evmTransactionSnapshotSchema.parse(await loadFixture('success-native-erc20'));
    const result = analyzeEvmTransactionSnapshot({
      ...fixture,
      requestedTransactionHash:
        '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    });

    expect(result.status).toBe('insufficient_data');
    expect(result.transaction.hash).toBe(
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    );
    expect(result.warnings).toContain('transaction_hash_mismatch');
    expect(result.assetChanges).toEqual([]);
  });

  it('aggregates mint and burn events without assigning balances to the zero address', async () => {
    const fixture = evmTransactionSnapshotSchema.parse(await loadFixture('success-native-erc20'));
    const receipt = fixture.receipt;
    if (receipt === undefined) {
      throw new Error('Expected receipt fixture.');
    }
    const mintLog = {
      ...receipt.logs[0],
      data: uint256Topic(10n),
      logIndex: 1,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(EVM_ZERO_ADDRESS), addressTopic(tokenRecipient)],
    };
    const burnLog = {
      ...receipt.logs[0],
      data: uint256Topic(3n),
      logIndex: 2,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(tokenRecipient), addressTopic(EVM_ZERO_ADDRESS)],
    };
    const result = analyzeEvmTransactionSnapshot({
      ...fixture,
      receipt: { ...receipt, logs: [mintLog, burnLog] },
      transaction: { ...fixture.transaction, value: '0' },
    });

    expect(result.tokenTransfers.map((transfer) => transfer.transferType)).toEqual([
      'mint',
      'burn',
    ]);
    const recipientChange = result.assetChanges.find(
      (change) => change.address === tokenRecipient && change.asset.kind === 'erc20',
    );
    expect(recipientChange).toMatchObject({
      address: tokenRecipient,
      asset: { contractAddress: token, kind: 'erc20' },
      rawDelta: '7',
    });
    expect(recipientChange?.evidenceIds.length).toBe(2);
    expect(result.assetChanges.some((change) => change.address === EVM_ZERO_ADDRESS)).toBe(false);
  });

  it('marks unknown sources, removed logs, duplicate log indexes, and block mismatch as partial', async () => {
    const fixture = evmTransactionSnapshotSchema.parse(await loadFixture('success-native-erc20'));
    const receipt = fixture.receipt;
    if (receipt === undefined) {
      throw new Error('Expected receipt fixture.');
    }
    const firstLog = receipt.logs[0];
    if (firstLog === undefined) {
      throw new Error('Expected log fixture.');
    }
    const result = analyzeEvmTransactionSnapshot({
      ...fixture,
      block: { ...fixture.block, number: '19000009' },
      receipt: {
        ...receipt,
        logs: [
          { ...firstLog, removed: true, sourceId: 'missing-source' },
          { ...firstLog, sourceId: 'missing-source' },
        ],
      },
    });

    expect(result.status).toBe('partial');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'unknown_source_reference:missing-source',
        'block_context_mismatch',
        'removed_log_ignored:7',
        'duplicate_log_index:7',
      ]),
    );
    expect(result.tokenTransfers).toEqual([]);
    expect(result.findings.some((finding) => finding.id === 'block_context')).toBe(false);
  });

  it('normalizes mixed-case addresses and rejects malformed or unbounded snapshots', async () => {
    const fixture = evmTransactionSnapshotSchema.parse(
      await loadFixture('partial-missing-receipt'),
    );
    const normalized = evmTransactionSnapshotSchema.parse({
      ...fixture,
      transaction: {
        ...fixture.transaction,
        from: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    expect(normalized.transaction?.from).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    expect(() => evmTransactionSnapshotSchema.parse({ ...fixture, chainId: '01' })).toThrow(
      z.ZodError,
    );
    expect(() =>
      evmTransactionSnapshotSchema.parse({
        ...fixture,
        transaction: { ...fixture.transaction, value: '01' },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      evmTransactionSnapshotSchema.parse({
        ...fixture,
        transaction: {
          ...fixture.transaction,
          value: (EVM_UINT256_MAX + 1n).toString(),
        },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      evmTransactionSnapshotSchema.parse({
        ...fixture,
        requestedTransactionHash: '0x1234',
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      evmTransactionSnapshotSchema.parse({
        ...fixture,
        receipt: {
          blockNumber: '1',
          effectiveGasPrice: '1',
          gasUsed: '1',
          logs: Array.from({ length: 501 }, () => ({
            address: token,
            data: '0x',
            logIndex: 0,
            sourceId: 'fixture-primary',
            topics: [],
          })),
          sourceId: 'fixture-primary',
          status: 'success',
          transactionHash: fixture.requestedTransactionHash,
        },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      evmTransactionSnapshotSchema.parse({
        ...fixture,
        receipt: {
          blockNumber: '1',
          effectiveGasPrice: '2',
          gasUsed: EVM_UINT256_MAX.toString(),
          logs: [],
          sourceId: 'fixture-primary',
          status: 'success',
          transactionHash: fixture.requestedTransactionHash,
        },
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      evmTransactionSnapshotSchema.parse({
        ...fixture,
        conflicts: [
          {
            field: 'receipt.status',
            observations: [
              { sourceId: 'fixture-primary', value: 'success' },
              { sourceId: 'fixture-primary', value: 'reverted' },
            ],
          },
        ],
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects dangling domain evidence references and non-contiguous timelines', async () => {
    const result = analyzeEvmTransactionSnapshot(await loadFixture('success-native-erc20'));
    const firstAssetChange = result.assetChanges[0];
    const firstTimelineItem = result.timeline[0];
    const firstTokenTransfer = result.tokenTransfers[0];
    if (
      firstAssetChange === undefined ||
      firstTimelineItem === undefined ||
      firstTokenTransfer === undefined
    ) {
      throw new Error('Expected analyzed asset changes, timeline items, and token transfers.');
    }

    expect(() =>
      transactionAnalysisResultSchema.parse({
        ...result,
        assetChanges: [
          { ...firstAssetChange, evidenceIds: ['missing:evidence'] },
          ...result.assetChanges.slice(1),
        ],
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      transactionAnalysisResultSchema.parse({
        ...result,
        timeline: [{ ...firstTimelineItem, sequence: 2 }, ...result.timeline.slice(1)],
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      transactionAnalysisResultSchema.parse({
        ...result,
        tokenTransfers: [{ ...firstTokenTransfer, evidenceId: 'missing:evidence' }],
      }),
    ).toThrow(z.ZodError);
  });

  it('aggregates more than 100 Transfer evidence items without exceeding output bounds', async () => {
    const fixture = evmTransactionSnapshotSchema.parse(await loadFixture('success-native-erc20'));
    const receipt = fixture.receipt;
    const baseLog = receipt?.logs[0];
    if (receipt === undefined || baseLog === undefined) {
      throw new Error('Expected receipt and log fixture.');
    }
    const logs = Array.from({ length: 101 }, (_, logIndex) => ({
      ...baseLog,
      data: uint256Topic(1n),
      logIndex,
    }));

    const result = analyzeEvmTransactionSnapshot({
      ...fixture,
      receipt: { ...receipt, logs },
      transaction: { ...fixture.transaction, value: '0' },
    });

    expect(result.status).toBe('success');
    expect(result.tokenTransfers).toHaveLength(101);
    const senderTokenChange = result.assetChanges.find(
      (change) => change.address === sender && change.asset.kind === 'erc20',
    );
    expect(senderTokenChange?.rawDelta).toBe('-101');
    expect(senderTokenChange?.evidenceIds).toHaveLength(101);
  });

  it('rejects non-canonical indexed address padding as a malformed Transfer log', async () => {
    const fixture = evmTransactionSnapshotSchema.parse(await loadFixture('success-native-erc20'));
    const receipt = fixture.receipt;
    const baseLog = receipt?.logs[0];
    if (receipt === undefined || baseLog === undefined) {
      throw new Error('Expected receipt and log fixture.');
    }
    const malformedFrom = `0x${'f'.repeat(24)}${sender.slice(2)}`;

    const result = analyzeEvmTransactionSnapshot({
      ...fixture,
      receipt: {
        ...receipt,
        logs: [
          {
            ...baseLog,
            topics: [ERC20_TRANSFER_TOPIC, malformedFrom, addressTopic(tokenRecipient)],
          },
        ],
      },
      transaction: { ...fixture.transaction, value: '0' },
    });

    expect(result.status).toBe('partial');
    expect(result.tokenTransfers).toEqual([]);
    expect(result.warnings).toContain('malformed_erc20_transfer_log:7');
  });
});

function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function uint256Topic(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}
