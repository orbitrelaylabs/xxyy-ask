import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  BAGS_BONDING_CURVE_TOKENS_BOUGHT_TOPIC,
  BAGS_BONDING_CURVE_TOKENS_SOLD_TOPIC,
  MAX_SWAP_EVENTS,
  SOLIDITY_ERROR_STRING_SELECTOR,
  UNISWAP_V2_SWAP_TOPIC,
  UNISWAP_V3_SWAP_TOPIC,
  UNISWAP_V4_SWAP_TOPIC,
  decodeSolidityRevertData,
  enrichEvmExecution,
  evmExecutionEnrichmentResultSchema,
  type EvmExecutionEnrichmentResult,
} from './index.js';

const sender = '0x1111111111111111111111111111111111111111';
const router = '0x2222222222222222222222222222222222222222';
const recipient = '0x3333333333333333333333333333333333333333';
const internalRecipient = '0x4444444444444444444444444444444444444444';
const createdAddress = '0x7777777777777777777777777777777777777777';
const v2Pool = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const token0 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const token1 = '0xcccccccccccccccccccccccccccccccccccccccc';
const v3Token0 = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const v3Token1 = '0xffffffffffffffffffffffffffffffffffffffff';

async function loadFixture(name: string): Promise<Record<string, unknown>> {
  const content = await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

function uint256Word(value: bigint): string {
  const normalized = value < 0n ? (1n << 256n) + value : value;
  return normalized.toString(16).padStart(64, '0');
}

function v2Data(amount0In: bigint, amount1In: bigint, amount0Out: bigint, amount1Out: bigint) {
  return `0x${[amount0In, amount1In, amount0Out, amount1Out].map(uint256Word).join('')}`;
}

describe('EVM execution enrichment replay fixtures', () => {
  it('replays to byte-identical output and validates the complete result contract', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const first = enrichEvmExecution(fixture);
    const second = enrichEvmExecution(fixture);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(evmExecutionEnrichmentResultSchema.parse(first)).toEqual(first);
  });

  it('extracts committed internal transfers while excluding a reverted child value', async () => {
    const result = enrichEvmExecution(await loadFixture('success-internal-swaps'));

    expect(result.status).toBe('success');
    expect(result.warnings).toEqual([]);
    expect(
      result.internalTransfers.map(({ evidenceId: _evidenceId, ...transfer }) => transfer),
    ).toEqual([
      {
        amountWei: '100',
        from: router,
        to: internalRecipient,
        traceAddress: [0],
        transferType: 'call',
      },
      {
        amountWei: '250',
        from: router,
        to: createdAddress,
        traceAddress: [2],
        transferType: 'create',
      },
      {
        amountWei: '50',
        from: internalRecipient,
        to: recipient,
        traceAddress: [3],
        transferType: 'selfdestruct',
      },
    ]);
    expect(
      result.internalTransfers.every((transfer) => transfer.evidenceId.startsWith('trace:')),
    ).toBe(true);
    expect(
      result.nativeAssetChanges.map((change) => ({
        address: change.address,
        rawDelta: change.rawDelta,
      })),
    ).toEqual([
      { address: router, rawDelta: '-350' },
      { address: recipient, rawDelta: '50' },
      { address: internalRecipient, rawDelta: '50' },
      { address: createdAddress, rawDelta: '250' },
    ]);
    expect(
      result.nativeAssetChanges.reduce((sum, change) => sum + BigInt(change.rawDelta), 0n),
    ).toBe(0n);
    expect(result.reverts).toEqual([
      expect.objectContaining({
        kind: 'error_string',
        reason: 'subcall failed',
        selector: SOLIDITY_ERROR_STRING_SELECTOR,
        traceAddress: [0, 0],
      }),
    ]);
  });

  it('decodes V2 and V3 pool deltas only with explicit token metadata', async () => {
    const result = enrichEvmExecution(await loadFixture('success-internal-swaps'));

    expect(result.coverage).toMatchObject({
      decodedSwapLogs: 2,
      receiptLogs: 'available',
      recognizedSwapLogs: 2,
      trace: 'available',
      unresolvedSwapLogs: 0,
    });
    expect(result.swaps).toEqual([
      expect.objectContaining({
        amount0InRaw: '1000',
        amount0PoolDeltaRaw: '1000',
        amount1OutRaw: '900',
        amount1PoolDeltaRaw: '-900',
        amountInRaw: '1000',
        amountOutRaw: '900',
        direction: 'token0_to_token1',
        poolAddress: v2Pool,
        protocol: 'uniswap_v2',
        token0,
        token1,
        tokenIn: token0,
        tokenOut: token1,
      }),
      expect.objectContaining({
        amount0PoolDeltaRaw: '-500',
        amount1PoolDeltaRaw: '600',
        amountInRaw: '600',
        amountOutRaw: '500',
        direction: 'token1_to_token0',
        liquidity: '1000000',
        protocol: 'uniswap_v3',
        sqrtPriceX96: '79228162514264337593543950336',
        tick: '-120',
        tokenIn: v3Token1,
        tokenOut: v3Token0,
      }),
    ]);
    expect(result.swaps.every((swap) => swap.evidenceIds.length === 2)).toBe(true);
  });

  it('does not apply root or descendant value when the whole transaction reverted', async () => {
    const result = enrichEvmExecution(await loadFixture('reverted-error'));

    expect(result).toMatchObject({
      internalTransfers: [],
      nativeAssetChanges: [],
      status: 'success',
      transaction: { executionStatus: 'reverted' },
      warnings: [],
    });
    expect(result.reverts).toEqual([
      expect.objectContaining({
        kind: 'error_string',
        reason: 'execution denied',
        traceAddress: [],
      }),
    ]);
  });

  it('decodes panic, unknown custom selector, and empty revert without guessing signatures', async () => {
    const result = enrichEvmExecution(await loadFixture('nested-reverts'));

    expect(result.status).toBe('success');
    expect(result.nativeAssetChanges).toEqual([]);
    expect(result.reverts).toEqual([
      expect.objectContaining({
        kind: 'panic',
        panicCode: '17',
        panicDescription: 'arithmetic underflow or overflow',
        selector: '0x4e487b71',
      }),
      expect.objectContaining({
        kind: 'custom_error',
        selector: '0xdeadbeef',
      }),
      expect.objectContaining({ kind: 'empty', traceAddress: [2] }),
    ]);
    expect(result.reverts[1]).not.toHaveProperty('reason');
  });

  it('returns explicit partial coverage when trace and pool metadata are absent', async () => {
    const result = enrichEvmExecution(await loadFixture('partial-missing-trace-metadata'));

    expect(result).toMatchObject({
      coverage: {
        decodedSwapLogs: 0,
        recognizedSwapLogs: 1,
        trace: 'missing',
        unresolvedSwapLogs: 1,
      },
      internalTransfers: [],
      status: 'partial',
      swaps: [],
      warnings: ['trace_missing', 'pool_metadata_missing'],
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'trace_missing', retryable: true }),
        expect.objectContaining({ code: 'pool_metadata_missing', retryable: true }),
      ]),
    );
    expect(result.findings.map((finding) => finding.id)).toContain('unresolved_swap_events');
  });
});

describe('EVM execution enrichment defensive behavior', () => {
  it('degrades invalid or mismatched traces instead of analyzing them', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const invalid = enrichEvmExecution({ ...fixture, trace: { attackerControlled: true } });
    const trace = fixture.trace as Record<string, unknown>;
    const mismatched = enrichEvmExecution({ ...fixture, trace: { ...trace, chainId: '10' } });

    expect(invalid).toMatchObject({
      coverage: { trace: 'invalid', traceNodeCount: 0 },
      internalTransfers: [],
      status: 'partial',
      warnings: ['trace_invalid'],
    });
    expect(mismatched).toMatchObject({
      coverage: { trace: 'mismatched', traceNodeCount: 0 },
      internalTransfers: [],
      status: 'partial',
      warnings: ['trace_transaction_mismatch'],
    });
  });

  it('fails closed when a syntactically valid trace does not match the transaction envelope', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const trace = fixture.trace as Record<string, unknown>;
    const nodes = trace.nodes as Array<Record<string, unknown>>;
    const result = enrichEvmExecution({
      ...fixture,
      trace: {
        ...trace,
        nodes: nodes.map((node) =>
          (node.traceAddress as number[]).length === 0 ? { ...node, value: '1' } : node,
        ),
      },
    });

    expect(result).toMatchObject({
      coverage: { trace: 'mismatched', traceNodeCount: 0 },
      internalTransfers: [],
      status: 'partial',
      warnings: ['trace_envelope_mismatch'],
    });
  });

  it('surfaces trace/receipt conflicts and non-value call value without applying either', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const trace = fixture.trace as Record<string, unknown>;
    const nodes = trace.nodes as Array<Record<string, unknown>>;
    const mutatedNodes = nodes.map((node) => {
      const path = node.traceAddress as number[];
      if (path.length === 0) {
        return { ...node, status: 'reverted' };
      }
      return path.length === 1 && path[0] === 1 ? { ...node, value: '1' } : node;
    });
    const result = enrichEvmExecution({ ...fixture, trace: { ...trace, nodes: mutatedNodes } });

    expect(result.status).toBe('partial');
    expect(result.warnings).toEqual(
      expect.arrayContaining(['trace_receipt_status_mismatch', 'non_value_call_reports_value']),
    );
    expect(result.internalTransfers).toEqual([]);
  });

  it('marks malformed standard revert payloads without exposing raw output', async () => {
    const fixture = await loadFixture('nested-reverts');
    const trace = fixture.trace as Record<string, unknown>;
    const nodes = trace.nodes as Array<Record<string, unknown>>;
    const result = enrichEvmExecution({
      ...fixture,
      trace: {
        ...trace,
        nodes: nodes.map((node) =>
          (node.traceAddress as number[])[0] === 0
            ? { ...node, output: SOLIDITY_ERROR_STRING_SELECTOR }
            : node,
        ),
      },
    });

    expect(result.status).toBe('partial');
    expect(result.reverts[0]).toMatchObject({
      kind: 'malformed',
      selector: SOLIDITY_ERROR_STRING_SELECTOR,
    });
    expect(result.warnings).toContain('malformed_revert_data');
    expect(JSON.stringify(result)).not.toContain('08c379a000000000000000000');
  });

  it('rejects invalid metadata and safely leaves recognized events unresolved', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const pools = fixture.poolMetadata as Array<Record<string, unknown>>;
    const result = enrichEvmExecution({
      ...fixture,
      poolMetadata: [...pools, pools[0]],
    });

    expect(result.status).toBe('partial');
    expect(result.swaps).toEqual([]);
    expect(result.coverage).toMatchObject({
      decodedSwapLogs: 0,
      recognizedSwapLogs: 2,
      unresolvedSwapLogs: 2,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining(['pool_metadata_invalid', 'pool_metadata_missing']),
    );
  });

  it('keeps ambiguous but arithmetically valid V2 deltas and omits invented direction fields', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const logs = receipt.logs as Array<Record<string, unknown>>;
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: {
        ...snapshot,
        receipt: {
          ...receipt,
          logs: [{ ...logs[0], data: v2Data(1n, 0n, 1n, 0n) }],
        },
      },
      poolMetadata: [(fixture.poolMetadata as unknown[])[0]],
    });

    expect(result.status).toBe('partial');
    expect(result.swaps).toHaveLength(1);
    expect(result.swaps[0]).toMatchObject({
      amount0PoolDeltaRaw: '0',
      amount1PoolDeltaRaw: '0',
      direction: 'ambiguous',
    });
    expect(result.swaps[0]).not.toHaveProperty('tokenIn');
    expect(result.swaps[0]).not.toHaveProperty('amountInRaw');
    expect(result.warnings).toContain('ambiguous_swap_direction');
  });

  it('rejects V3 words that are not valid uint160, uint128, or int24 values', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const logs = receipt.logs as Array<Record<string, unknown>>;
    const v3Log = logs[1];
    if (v3Log === undefined) {
      throw new Error('Expected a V3 swap log fixture.');
    }
    const words = (v3Log.data as string).slice(2).match(/.{64}/gu);
    if (words === null || words.length !== 5) {
      throw new Error('Expected five V3 ABI words.');
    }
    words[4] = uint256Word(1n << 23n);
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: {
        ...snapshot,
        receipt: { ...receipt, logs: [{ ...v3Log, data: `0x${words.join('')}` }] },
      },
      poolMetadata: [(fixture.poolMetadata as unknown[])[1]],
    });

    expect(result.status).toBe('partial');
    expect(result.swaps).toEqual([]);
    expect(result.coverage).toMatchObject({
      decodedSwapLogs: 0,
      recognizedSwapLogs: 1,
      unresolvedSwapLogs: 1,
    });
    expect(result.warnings).toContain('malformed_swap_log');
  });

  it('ignores removed and duplicate swap logs with explicit diagnostics', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const baseLog = (receipt.logs as Array<Record<string, unknown>>)[0];
    if (baseLog === undefined) {
      throw new Error('Expected a V2 swap log fixture.');
    }
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: {
        ...snapshot,
        receipt: {
          ...receipt,
          logs: [{ ...baseLog, removed: true }, { ...baseLog }],
        },
      },
      poolMetadata: [(fixture.poolMetadata as unknown[])[0]],
    });

    expect(result.status).toBe('partial');
    expect(result.swaps).toEqual([]);
    expect(result.coverage).toMatchObject({
      decodedSwapLogs: 0,
      recognizedSwapLogs: 2,
      unresolvedSwapLogs: 2,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining(['removed_swap_log', 'duplicate_swap_log_index']),
    );
  });

  it('bounds swap decoding and reports overflow as unresolved coverage', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const baseLog = (receipt.logs as Array<Record<string, unknown>>)[0];
    if (baseLog === undefined) {
      throw new Error('Expected a swap log fixture.');
    }
    const logs = Array.from({ length: MAX_SWAP_EVENTS + 1 }, (_, logIndex) => ({
      ...baseLog,
      logIndex,
    }));
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: { ...snapshot, receipt: { ...receipt, logs } },
      poolMetadata: [(fixture.poolMetadata as unknown[])[0]],
    });

    expect(result.status).toBe('partial');
    expect(result.swaps).toHaveLength(MAX_SWAP_EVENTS);
    expect(result.coverage).toMatchObject({
      decodedSwapLogs: MAX_SWAP_EVENTS,
      recognizedSwapLogs: MAX_SWAP_EVENTS + 1,
      unresolvedSwapLogs: 1,
    });
    expect(result.warnings).toContain('swap_event_limit_exceeded');
    expect(result.evidence.length).toBeLessThan(1_000);
  });

  it('returns insufficient_data for absent or mismatched transaction envelopes', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const { transaction: _transaction, ...withoutTransaction } = snapshot;
    const missing = enrichEvmExecution({ snapshot: withoutTransaction });
    const mismatched = enrichEvmExecution({
      snapshot: {
        ...snapshot,
        requestedTransactionHash:
          '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      },
    });

    expect(missing).toMatchObject({
      status: 'insufficient_data',
      warnings: ['transaction_missing'],
    });
    expect(mismatched).toMatchObject({
      status: 'insufficient_data',
      warnings: ['transaction_hash_mismatch'],
    });
  });

  it('does not commit trace values without a matching successful receipt', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const { receipt: _receipt, ...withoutReceipt } = snapshot;
    const result = enrichEvmExecution({ ...fixture, snapshot: withoutReceipt });

    expect(result).toMatchObject({
      coverage: { receiptLogs: 'missing', trace: 'available' },
      internalTransfers: [],
      nativeAssetChanges: [],
      status: 'partial',
      transaction: { executionStatus: 'pending' },
    });
    expect(result.warnings).toContain('receipt_missing');
  });

  it('labels a mismatched receipt unknown and excludes its logs from semantic output', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: {
        ...snapshot,
        receipt: {
          ...receipt,
          transactionHash: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        },
      },
    });

    expect(result).toMatchObject({
      coverage: { receiptLogs: 'mismatched', recognizedSwapLogs: 0 },
      internalTransfers: [],
      status: 'partial',
      swaps: [],
      transaction: { executionStatus: 'unknown' },
    });
    expect(result.warnings).toContain('receipt_transaction_mismatch');
  });

  it('retains decoded log facts but marks unregistered log provenance as partial', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const logs = receipt.logs as Array<Record<string, unknown>>;
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: {
        ...snapshot,
        receipt: {
          ...receipt,
          logs: logs.map((log, index) =>
            index === 0 ? { ...log, sourceId: 'unregistered-source' } : log,
          ),
        },
      },
    });

    expect(result.status).toBe('partial');
    expect(result.swaps).toHaveLength(2);
    expect(result.warnings).toContain('unknown_log_source');
  });

  it('uses Explorer traces while preserving their partial-evidence status', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const trace = fixture.trace as Record<string, unknown>;
    const source = trace.source as Record<string, unknown>;
    const result = enrichEvmExecution({
      ...fixture,
      trace: {
        ...trace,
        source: { ...source, kind: 'explorer' },
      },
    });

    expect(result.status).toBe('partial');
    expect(result.coverage.trace).toBe('available');
    expect(result.internalTransfers.length).toBeGreaterThan(0);
    expect(result.warnings).toContain('trace_source_partial');
  });

  it('preserves snapshot conflicts and receipt index disagreement as partial provenance', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: {
        ...snapshot,
        conflicts: [
          {
            field: 'receipt.status',
            observations: [
              { sourceId: 'rpc-primary', value: 'success' },
              { sourceId: 'rpc-secondary', value: 'reverted' },
            ],
          },
        ],
        receipt: { ...receipt, transactionIndex: 8 },
        sources: [
          ...(snapshot.sources as unknown[]),
          {
            id: 'rpc-secondary',
            kind: 'fixture',
            observedAt: '2026-07-22T00:00:03.000Z',
          },
        ],
      },
    });

    expect(result.status).toBe('partial');
    expect(result.warnings).toEqual(
      expect.arrayContaining(['snapshot_source_conflicts', 'receipt_transaction_index_mismatch']),
    );
    expect(result.swaps).toHaveLength(2);
  });

  it('decodes revert selectors with strict canonical ABI and UTF-8 checks', () => {
    expect(decodeSolidityRevertData('0x')).toEqual({ dataLengthBytes: 0, kind: 'empty' });
    expect(decodeSolidityRevertData('0x12')).toEqual({
      dataLengthBytes: 1,
      kind: 'malformed',
    });
    expect(decodeSolidityRevertData('0xdeadbeef')).toEqual({
      dataLengthBytes: 4,
      kind: 'custom_error',
      selector: '0xdeadbeef',
    });
    expect(decodeSolidityRevertData(SOLIDITY_ERROR_STRING_SELECTOR)).toEqual({
      dataLengthBytes: 4,
      kind: 'malformed',
      selector: SOLIDITY_ERROR_STRING_SELECTOR,
    });
    expect(decodeSolidityRevertData('not-hex')).toEqual({
      dataLengthBytes: 0,
      kind: 'malformed',
    });
  });

  it('rejects tampered directional, conservation, and coverage fields at the result boundary', async () => {
    const result = enrichEvmExecution(await loadFixture('success-internal-swaps'));
    const firstSwap = result.swaps[0];
    const firstChange = result.nativeAssetChanges[0];
    if (firstSwap === undefined || firstChange === undefined) {
      throw new Error('Expected swap and native change output.');
    }

    expect(
      evmExecutionEnrichmentResultSchema.safeParse({
        ...result,
        swaps: [{ ...firstSwap, direction: 'token1_to_token0' }, ...result.swaps.slice(1)],
      }).success,
    ).toBe(false);
    expect(
      evmExecutionEnrichmentResultSchema.safeParse({
        ...result,
        nativeAssetChanges: [
          { ...firstChange, rawDelta: (BigInt(firstChange.rawDelta) + 1n).toString() },
          ...result.nativeAssetChanges.slice(1),
        ],
      }).success,
    ).toBe(false);
    expect(
      evmExecutionEnrichmentResultSchema.safeParse({
        ...result,
        coverage: { ...result.coverage, traceNodeCount: 0 },
      }).success,
    ).toBe(false);
  });

  it('does not confuse non-swap logs with the allowlisted V2 topic', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const logs = receipt.logs as Array<Record<string, unknown>>;
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: {
        ...snapshot,
        receipt: {
          ...receipt,
          logs: [
            {
              ...logs[0],
              topics: [`0x${'12'.repeat(32)}`, ...(logs[0]?.topics as string[]).slice(1)],
            },
          ],
        },
      },
    });

    expect(UNISWAP_V2_SWAP_TOPIC).toHaveLength(66);
    expect(UNISWAP_V3_SWAP_TOPIC).toBe(
      '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
    );
    expect(UNISWAP_V4_SWAP_TOPIC).toBe(
      '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
    );
    expect(result.coverage.recognizedSwapLogs).toBe(0);
    expect(result.swaps).toEqual([]);
  });

  it('recognizes Uniswap V4-format Swap events but refuses to infer a pool without PoolKey data', async () => {
    const fixture = await loadFixture('success-internal-swaps');
    const snapshot = fixture.snapshot as Record<string, unknown>;
    const receipt = snapshot.receipt as Record<string, unknown>;
    const logs = receipt.logs as Array<Record<string, unknown>>;
    const firstLog = logs[0]!;
    const topics = firstLog.topics as string[];
    const result = enrichEvmExecution({
      ...fixture,
      snapshot: {
        ...snapshot,
        receipt: {
          ...receipt,
          logs: [
            {
              ...firstLog,
              topics: [UNISWAP_V4_SWAP_TOPIC, ...topics.slice(1)],
            },
            ...logs.slice(1),
          ],
        },
      },
    });

    expect(result.status).toBe('partial');
    expect(result.coverage).toMatchObject({
      decodedSwapLogs: 1,
      recognizedSwapLogs: 2,
      unresolvedSwapLogs: 1,
    });
    expect(result.warnings).toContain('uniswap_v4_pool_key_not_configured');
  });

  it.each([BAGS_BONDING_CURVE_TOKENS_BOUGHT_TOPIC, BAGS_BONDING_CURVE_TOKENS_SOLD_TOPIC])(
    'recognizes Bags bonding-curve trade topic %s without treating it as an allowlisted DEX pool',
    async (topic) => {
      const fixture = await loadFixture('success-internal-swaps');
      const snapshot = fixture.snapshot as Record<string, unknown>;
      const receipt = snapshot.receipt as Record<string, unknown>;
      const logs = receipt.logs as Array<Record<string, unknown>>;
      const firstLog = logs[0]!;
      const topics = firstLog.topics as string[];
      const result = enrichEvmExecution({
        ...fixture,
        snapshot: {
          ...snapshot,
          receipt: {
            ...receipt,
            logs: [
              {
                ...firstLog,
                topics: [topic, ...topics.slice(1)],
              },
            ],
          },
        },
        poolMetadata: [],
      });

      expect(result.status).toBe('partial');
      expect(result.swaps).toEqual([]);
      expect(result.coverage).toMatchObject({
        decodedSwapLogs: 0,
        recognizedSwapLogs: 1,
        unresolvedSwapLogs: 1,
      });
      expect(result.warnings).toContain('bags_bonding_curve_metadata_not_configured');
    },
  );

  it('keeps the transaction sender as trace provenance without adding root value twice', async () => {
    const result: EvmExecutionEnrichmentResult = enrichEvmExecution(
      await loadFixture('success-internal-swaps'),
    );
    const rootEvidence = result.evidence.find((evidence) => evidence.id.endsWith(':root'));

    expect(rootEvidence?.structuredData).toMatchObject({ from: sender, valueWei: '0' });
    expect(result.internalTransfers.every((transfer) => transfer.from !== sender)).toBe(true);
  });
});
