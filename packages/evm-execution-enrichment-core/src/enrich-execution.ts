import type {
  EvidenceItem,
  JsonValue,
  SkillDiagnostic,
  SkillFinding,
  SkillResultStatus,
} from '@xxyy/shared';
import type {
  EvmTransaction,
  EvmTransactionLog,
  EvmTransactionReceipt,
  EvmTransactionSnapshot,
} from '@xxyy/transaction-analysis-core';

import {
  BAGS_BONDING_CURVE_TOKENS_BOUGHT_TOPIC,
  BAGS_BONDING_CURVE_TOKENS_SOLD_TOPIC,
  EVM_EXECUTION_ENRICHMENT_SKILL,
  EVM_EXECUTION_ENRICHMENT_VERSION,
  MAX_SWAP_EVENTS,
  MAX_TRACE_BYTES,
  SOLIDITY_ERROR_STRING_SELECTOR,
  SOLIDITY_PANIC_SELECTOR,
  UNISWAP_V2_SWAP_TOPIC,
  UNISWAP_V3_SWAP_TOPIC,
  UNISWAP_V4_SWAP_TOPIC,
  evmCallTraceSchema,
  evmExecutionEnrichmentInputSchema,
  evmExecutionEnrichmentResultSchema,
  evmPoolMetadataSchema,
  traceAddressKey,
  type EvmCallTrace,
  type EvmDecodedSwap,
  type EvmExecutionEnrichmentResult,
  type EvmInternalTransfer,
  type EvmNativeAssetChange,
  type EvmPoolMetadataEntry,
  type EvmRevertArtifact,
  type EvmTraceNode,
} from './contracts.js';

interface EnrichmentState {
  coverage: EvmExecutionEnrichmentResult['coverage'];
  diagnostics: SkillDiagnostic[];
  diagnosticIndex: Map<string, number>;
  evidence: Map<string, EvidenceItem>;
  findings: SkillFinding[];
  internalTransfers: EvmInternalTransfer[];
  materialIssue: boolean;
  nativeAssetChanges: Map<string, MutableNativeAssetChange>;
  reverts: EvmRevertArtifact[];
  swaps: EvmDecodedSwap[];
  unresolvedSwapEvidenceIds: Set<string>;
  warnings: string[];
}

interface MutableNativeAssetChange {
  address: string;
  chainId: string;
  delta: bigint;
  evidenceIds: Set<string>;
}

interface ReconciledReceipt {
  receipt?: EvmTransactionReceipt | undefined;
  status: EvmExecutionEnrichmentResult['coverage']['receiptLogs'];
}

export interface DecodedSolidityRevertData {
  dataLengthBytes: number;
  kind: EvmRevertArtifact['kind'];
  panicCode?: string | undefined;
  panicDescription?: string | undefined;
  reason?: string | undefined;
  selector?: string | undefined;
}

interface SwapDirection {
  amountInRaw?: string | undefined;
  amountOutRaw?: string | undefined;
  direction: EvmDecodedSwap['direction'];
  tokenIn?: string | undefined;
  tokenOut?: string | undefined;
}

type DecodedSwapWithoutEvidence =
  | Omit<Extract<EvmDecodedSwap, { protocol: 'uniswap_v2' }>, 'evidenceIds'>
  | Omit<Extract<EvmDecodedSwap, { protocol: 'uniswap_v3' }>, 'evidenceIds'>;

const findingIds = {
  dexSwaps: 'dex_swaps',
  internalTransfers: 'internal_native_transfers',
  revertSemantics: 'revert_semantics',
  traceCoverage: 'trace_coverage',
  unresolvedSwapEvents: 'unresolved_swap_events',
} as const;

const PANIC_DESCRIPTIONS = new Map<bigint, string>([
  [0x00n, 'generic compiler-inserted panic'],
  [0x01n, 'assertion failed'],
  [0x11n, 'arithmetic underflow or overflow'],
  [0x12n, 'division or modulo by zero'],
  [0x21n, 'invalid enum conversion'],
  [0x22n, 'invalid storage byte array encoding'],
  [0x31n, 'pop on an empty array'],
  [0x32n, 'array or bytes index out of bounds'],
  [0x41n, 'memory allocation overflow'],
  [0x51n, 'call to an uninitialized internal function'],
]);

const UINT160_MAX = (1n << 160n) - 1n;
const UINT128_MAX = (1n << 128n) - 1n;
const INT24_MIN = -(1n << 23n);
const INT24_MAX = (1n << 23n) - 1n;
const UINT256_MODULUS = 1n << 256n;
const INT256_SIGN_BIT = 1n << 255n;

export function enrichEvmExecution(input: unknown): EvmExecutionEnrichmentResult {
  const envelope = evmExecutionEnrichmentInputSchema.parse(input);
  const snapshot = envelope.snapshot;
  const state = createState();
  const transaction = snapshot.transaction;

  if (transaction === undefined) {
    addIssue(state, 'load', 'transaction_missing', true);
    return finalizeResult(snapshot, state, {
      executionStatus: 'unknown',
      status: 'insufficient_data',
      summary: 'Execution enrichment cannot run because the requested transaction is missing.',
    });
  }
  if (transaction.hash !== snapshot.requestedTransactionHash) {
    addIssue(state, 'validate', 'transaction_hash_mismatch', false);
    return finalizeResult(snapshot, state, {
      executionStatus: 'unknown',
      status: 'insufficient_data',
      summary:
        'Execution enrichment rejected a transaction that does not match the requested hash.',
    });
  }

  validateSnapshotIntegrity(snapshot, state);
  const reconciledReceipt = reconcileReceipt(snapshot, transaction, state);
  state.coverage.receiptLogs = reconciledReceipt.status;
  const trace = reconcileTrace(envelope.trace, snapshot, transaction, state);
  if (trace !== undefined) {
    analyzeTrace(snapshot, reconciledReceipt.receipt, trace, state);
  }

  const pools = parsePoolMetadata(envelope.poolMetadata, state);
  decodeSwapLogs(snapshot, reconciledReceipt.receipt, pools, state);
  addSwapFindings(state);

  const executionStatus =
    reconciledReceipt.receipt?.status ??
    (reconciledReceipt.status === 'mismatched' ? 'unknown' : 'pending');
  const status: SkillResultStatus = state.materialIssue ? 'partial' : 'success';
  return finalizeResult(snapshot, state, {
    executionStatus,
    status,
    summary: createSummary(state, executionStatus, status),
  });
}

function createState(): EnrichmentState {
  return {
    coverage: {
      decodedSwapLogs: 0,
      receiptLogs: 'missing',
      recognizedSwapLogs: 0,
      trace: 'missing',
      traceNodeCount: 0,
      unresolvedSwapLogs: 0,
    },
    diagnostics: [],
    diagnosticIndex: new Map(),
    evidence: new Map(),
    findings: [],
    internalTransfers: [],
    materialIssue: false,
    nativeAssetChanges: new Map(),
    reverts: [],
    swaps: [],
    unresolvedSwapEvidenceIds: new Set(),
    warnings: [],
  };
}

function reconcileReceipt(
  snapshot: EvmTransactionSnapshot,
  transaction: EvmTransaction,
  state: EnrichmentState,
): ReconciledReceipt {
  const receipt = snapshot.receipt;
  if (receipt === undefined) {
    addIssue(state, 'load_receipt', 'receipt_missing', true);
    return { status: 'missing' };
  }
  if (
    receipt.transactionHash !== transaction.hash ||
    (transaction.blockNumber !== undefined && receipt.blockNumber !== transaction.blockNumber)
  ) {
    addIssue(state, 'reconcile_receipt', 'receipt_transaction_mismatch', false);
    return { status: 'mismatched' };
  }
  if (
    transaction.transactionIndex !== undefined &&
    receipt.transactionIndex !== undefined &&
    transaction.transactionIndex !== receipt.transactionIndex
  ) {
    addIssue(state, 'reconcile_receipt', 'receipt_transaction_index_mismatch', false);
  }
  if (receipt.status === 'reverted') {
    if (receipt.logs.length > 0) {
      addIssue(state, 'decode_logs', 'reverted_receipt_contains_logs', false);
    }
    return { receipt, status: 'reverted' };
  }
  return { receipt, status: 'available' };
}

function validateSnapshotIntegrity(snapshot: EvmTransactionSnapshot, state: EnrichmentState): void {
  const sourceIds = new Set(snapshot.sources.map((source) => source.id));
  if (snapshot.transaction !== undefined && !sourceIds.has(snapshot.transaction.sourceId)) {
    addIssue(state, 'validate_snapshot', 'unknown_transaction_source', false);
  }
  if (snapshot.receipt !== undefined) {
    if (!sourceIds.has(snapshot.receipt.sourceId)) {
      addIssue(state, 'validate_snapshot', 'unknown_receipt_source', false);
    }
    if (snapshot.receipt.logs.some((log) => !sourceIds.has(log.sourceId))) {
      addIssue(state, 'validate_snapshot', 'unknown_log_source', false);
    }
  }
  if (snapshot.block !== undefined && !sourceIds.has(snapshot.block.sourceId)) {
    addIssue(state, 'validate_snapshot', 'unknown_block_source', false);
  }
  if (
    (snapshot.conflicts ?? []).some((conflict) =>
      conflict.observations.some((observation) => !sourceIds.has(observation.sourceId)),
    )
  ) {
    addIssue(state, 'validate_snapshot', 'unknown_conflict_source', false);
  }
  if ((snapshot.conflicts?.length ?? 0) > 0) {
    addIssue(state, 'reconcile_snapshot', 'snapshot_source_conflicts', false);
  }
}

function reconcileTrace(
  rawTrace: unknown,
  snapshot: EvmTransactionSnapshot,
  transaction: EvmTransaction,
  state: EnrichmentState,
): EvmCallTrace | undefined {
  if (rawTrace === undefined) {
    state.coverage.trace = 'missing';
    addIssue(state, 'load_trace', 'trace_missing', true);
    return undefined;
  }

  const parsed = evmCallTraceSchema.safeParse(rawTrace);
  if (!parsed.success) {
    state.coverage.trace = 'invalid';
    addIssue(state, 'validate_trace', 'trace_invalid', false);
    return undefined;
  }
  if (
    parsed.data.chainId !== snapshot.chainId ||
    parsed.data.transactionHash !== snapshot.requestedTransactionHash
  ) {
    state.coverage.trace = 'mismatched';
    addIssue(state, 'reconcile_trace', 'trace_transaction_mismatch', false);
    return undefined;
  }

  const root = parsed.data.nodes.find((node) => node.traceAddress.length === 0);
  const destinationMatches =
    root !== undefined &&
    (transaction.to === null
      ? (root.type === 'create' || root.type === 'create2') &&
        (snapshot.receipt?.contractAddress == null || root.to === snapshot.receipt.contractAddress)
      : root.type === 'call' && root.to === transaction.to);
  if (
    root === undefined ||
    root.from !== transaction.from ||
    root.value !== transaction.value ||
    root.input !== transaction.input ||
    !destinationMatches
  ) {
    state.coverage.trace = 'mismatched';
    addIssue(state, 'reconcile_trace', 'trace_envelope_mismatch', false);
    return undefined;
  }

  state.coverage.trace = 'available';
  state.coverage.traceNodeCount = parsed.data.nodes.length;
  if (parsed.data.source.kind === 'explorer' || parsed.data.source.kind === 'indexer') {
    addIssue(state, 'validate_trace', 'trace_source_partial', false);
  }
  return parsed.data;
}

function parsePoolMetadata(
  rawMetadata: unknown,
  state: EnrichmentState,
): ReadonlyMap<string, EvmPoolMetadataEntry> {
  if (rawMetadata === undefined) {
    return new Map();
  }
  const parsed = evmPoolMetadataSchema.safeParse(rawMetadata);
  if (!parsed.success) {
    addIssue(state, 'validate_pool_metadata', 'pool_metadata_invalid', false);
    return new Map();
  }
  return new Map(parsed.data.map((pool) => [poolIdentity(pool.chainId, pool.poolAddress), pool]));
}

function analyzeTrace(
  snapshot: EvmTransactionSnapshot,
  receipt: EvmTransactionReceipt | undefined,
  trace: EvmCallTrace,
  state: EnrichmentState,
): void {
  const nodes = [...trace.nodes].sort((left, right) =>
    compareTraceAddresses(left.traceAddress, right.traceAddress),
  );
  const nodeByPath = new Map(nodes.map((node) => [traceAddressKey(node.traceAddress), node]));
  const root = nodeByPath.get('root');
  if (root === undefined) {
    addIssue(state, 'validate_trace', 'trace_root_missing', false);
    return;
  }

  const rootEvidenceId = ensureTraceEvidence(
    snapshot,
    trace,
    root,
    [findingIds.traceCoverage],
    state,
  );
  state.findings.push({
    confidence: 1,
    evidenceIds: [rootEvidenceId],
    id: findingIds.traceCoverage,
    inference: false,
    statement: `Validated a bounded call trace containing ${nodes.length} node(s).`,
  });

  if (receipt !== undefined && root.status !== receipt.status) {
    addIssue(state, 'reconcile_trace', 'trace_receipt_status_mismatch', false, [rootEvidenceId]);
  }

  const internalEvidenceIds: string[] = [];
  const revertEvidenceIds: string[] = [];
  for (const node of nodes) {
    if (node.status === 'reverted') {
      const decoded = decodeSolidityRevertData(node.output ?? '0x');
      const evidenceId = ensureTraceEvidence(
        snapshot,
        trace,
        node,
        [findingIds.revertSemantics],
        state,
        {
          dataLengthBytes: decoded.dataLengthBytes,
          kind: decoded.kind,
          ...(decoded.panicCode === undefined ? {} : { panicCode: decoded.panicCode }),
          ...(decoded.panicDescription === undefined
            ? {}
            : { panicDescription: decoded.panicDescription }),
          ...(decoded.reason === undefined ? {} : { reason: decoded.reason }),
          ...(decoded.selector === undefined ? {} : { selector: decoded.selector }),
        },
      );
      state.reverts.push({
        callType: node.type,
        dataLengthBytes: decoded.dataLengthBytes,
        evidenceId,
        from: node.from,
        kind: decoded.kind,
        ...(decoded.panicCode === undefined ? {} : { panicCode: decoded.panicCode }),
        ...(decoded.panicDescription === undefined
          ? {}
          : { panicDescription: decoded.panicDescription }),
        ...(decoded.reason === undefined ? {} : { reason: decoded.reason }),
        ...(decoded.selector === undefined ? {} : { selector: decoded.selector }),
        to: node.to,
        traceAddress: node.traceAddress,
      });
      revertEvidenceIds.push(evidenceId);
      if (decoded.kind === 'malformed') {
        addIssue(state, 'decode_revert', 'malformed_revert_data', false, [evidenceId]);
      }
    }

    if (node.traceAddress.length === 0 || BigInt(node.value) === 0n) {
      continue;
    }
    if (!isValueTransferCallType(node.type)) {
      addIssue(state, 'analyze_trace', 'non_value_call_reports_value', false);
      continue;
    }
    if (!isCommittedTraceNode(node, nodeByPath, receipt)) {
      continue;
    }
    if (node.to === null) {
      addIssue(state, 'analyze_trace', 'internal_transfer_recipient_missing', false);
      continue;
    }

    const evidenceId = ensureTraceEvidence(
      snapshot,
      trace,
      node,
      [findingIds.internalTransfers],
      state,
    );
    const transfer: EvmInternalTransfer = {
      amountWei: node.value,
      evidenceId,
      from: node.from,
      to: node.to,
      traceAddress: node.traceAddress,
      transferType: node.type,
    };
    state.internalTransfers.push(transfer);
    internalEvidenceIds.push(evidenceId);
    addNativeDelta(state, snapshot.chainId, node.from, -BigInt(node.value), evidenceId);
    addNativeDelta(state, snapshot.chainId, node.to, BigInt(node.value), evidenceId);
  }

  if (internalEvidenceIds.length > 0) {
    state.findings.push({
      confidence: 1,
      evidenceIds: uniqueSorted(internalEvidenceIds),
      id: findingIds.internalTransfers,
      inference: false,
      statement: `The committed trace contains ${state.internalTransfers.length} internal native transfer(s).`,
    });
  }
  if (revertEvidenceIds.length > 0) {
    state.findings.push({
      confidence: 1,
      evidenceIds: uniqueSorted(revertEvidenceIds),
      id: findingIds.revertSemantics,
      inference: false,
      statement: `Decoded revert semantics for ${state.reverts.length} reverted trace node(s).`,
    });
  }
}

function decodeSwapLogs(
  snapshot: EvmTransactionSnapshot,
  receipt: EvmTransactionReceipt | undefined,
  pools: ReadonlyMap<string, EvmPoolMetadataEntry>,
  state: EnrichmentState,
): void {
  if (receipt === undefined || receipt.status !== 'success') {
    return;
  }

  const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
  const seenLogIndexes = new Set<number>();
  let processedSwapEvents = 0;
  let overflowEvidenceRecorded = false;

  for (const log of [...receipt.logs].sort((left, right) => left.logIndex - right.logIndex)) {
    const topic = log.topics[0];
    const protocol = protocolFromTopic(topic);
    const unresolvedFormatCode =
      topic === UNISWAP_V4_SWAP_TOPIC
        ? 'uniswap_v4_pool_key_not_configured'
        : topic === BAGS_BONDING_CURVE_TOKENS_BOUGHT_TOPIC ||
            topic === BAGS_BONDING_CURVE_TOKENS_SOLD_TOPIC
          ? 'bags_bonding_curve_metadata_not_configured'
          : undefined;
    if (protocol === undefined && unresolvedFormatCode === undefined) {
      continue;
    }
    state.coverage.recognizedSwapLogs += 1;

    if (processedSwapEvents >= MAX_SWAP_EVENTS) {
      state.coverage.unresolvedSwapLogs += 1;
      if (!overflowEvidenceRecorded) {
        const evidenceId = ensureLogEvidence(
          snapshot,
          sources,
          log,
          [findingIds.unresolvedSwapEvents],
          state,
          { reason: 'swap_event_limit_exceeded' },
        );
        state.unresolvedSwapEvidenceIds.add(evidenceId);
        addIssue(state, 'decode_swaps', 'swap_event_limit_exceeded', false, [evidenceId]);
        overflowEvidenceRecorded = true;
      }
      continue;
    }
    processedSwapEvents += 1;

    if (seenLogIndexes.has(log.logIndex)) {
      markUnresolvedSwap(snapshot, sources, log, state, 'duplicate_swap_log_index');
      continue;
    }
    seenLogIndexes.add(log.logIndex);
    if (log.removed === true) {
      markUnresolvedSwap(snapshot, sources, log, state, 'removed_swap_log');
      continue;
    }
    if (unresolvedFormatCode !== undefined) {
      markUnresolvedSwap(snapshot, sources, log, state, unresolvedFormatCode);
      continue;
    }

    const pool = pools.get(poolIdentity(snapshot.chainId, log.address));
    if (pool === undefined) {
      markUnresolvedSwap(snapshot, sources, log, state, 'pool_metadata_missing');
      continue;
    }
    if (pool.protocol !== protocol) {
      const poolEvidenceId = ensurePoolEvidence(
        snapshot,
        pool,
        [findingIds.unresolvedSwapEvents],
        state,
      );
      markUnresolvedSwap(snapshot, sources, log, state, 'swap_protocol_mismatch', [poolEvidenceId]);
      continue;
    }

    const decoded = decodeSwap(log, pool);
    if (decoded === undefined) {
      const poolEvidenceId = ensurePoolEvidence(
        snapshot,
        pool,
        [findingIds.unresolvedSwapEvents],
        state,
      );
      markUnresolvedSwap(snapshot, sources, log, state, 'malformed_swap_log', [poolEvidenceId]);
      continue;
    }

    const logEvidenceId = ensureLogEvidence(
      snapshot,
      sources,
      log,
      [findingIds.dexSwaps],
      state,
      swapEvidenceData(decoded),
    );
    const poolEvidenceId = ensurePoolEvidence(snapshot, pool, [findingIds.dexSwaps], state);
    const evidenceIds = [logEvidenceId, poolEvidenceId];
    const swap: EvmDecodedSwap =
      decoded.protocol === 'uniswap_v2' ? { ...decoded, evidenceIds } : { ...decoded, evidenceIds };
    state.swaps.push(swap);
    state.coverage.decodedSwapLogs += 1;
    if (swap.direction === 'ambiguous') {
      addIssue(state, 'decode_swaps', 'ambiguous_swap_direction', false, [logEvidenceId]);
    }
  }
}

function decodeSwap(
  log: EvmTransactionLog,
  pool: EvmPoolMetadataEntry,
): DecodedSwapWithoutEvidence | undefined {
  if (log.topics.length !== 3) {
    return undefined;
  }
  const senderTopic = log.topics[1];
  const recipientTopic = log.topics[2];
  if (
    senderTopic === undefined ||
    recipientTopic === undefined ||
    !isAddressTopic(senderTopic) ||
    !isAddressTopic(recipientTopic)
  ) {
    return undefined;
  }
  const sender = topicToAddress(senderTopic);
  const recipient = topicToAddress(recipientTopic);

  if (pool.protocol === 'uniswap_v2') {
    const words = abiWords(log.data, 4);
    if (words === undefined) {
      return undefined;
    }
    const amount0In = unsignedWord(words[0]);
    const amount1In = unsignedWord(words[1]);
    const amount0Out = unsignedWord(words[2]);
    const amount1Out = unsignedWord(words[3]);
    if (
      amount0In === undefined ||
      amount1In === undefined ||
      amount0Out === undefined ||
      amount1Out === undefined
    ) {
      return undefined;
    }
    const delta0 = amount0In - amount0Out;
    const delta1 = amount1In - amount1Out;
    const direction = deriveSwapDirection(delta0, delta1, pool);
    return {
      amount0InRaw: amount0In.toString(),
      amount0OutRaw: amount0Out.toString(),
      amount0PoolDeltaRaw: delta0.toString(),
      amount1InRaw: amount1In.toString(),
      amount1OutRaw: amount1Out.toString(),
      amount1PoolDeltaRaw: delta1.toString(),
      ...optionalDirectionFields(direction),
      direction: direction.direction,
      logIndex: log.logIndex,
      poolAddress: pool.poolAddress,
      protocol: 'uniswap_v2',
      recipient,
      sender,
      token0: pool.token0,
      token1: pool.token1,
    };
  }

  const words = abiWords(log.data, 5);
  if (words === undefined) {
    return undefined;
  }
  const amount0 = signedWord(words[0]);
  const amount1 = signedWord(words[1]);
  const sqrtPriceX96 = unsignedWord(words[2]);
  const liquidity = unsignedWord(words[3]);
  const tick = signedWord(words[4]);
  if (
    amount0 === undefined ||
    amount1 === undefined ||
    sqrtPriceX96 === undefined ||
    liquidity === undefined ||
    tick === undefined ||
    sqrtPriceX96 > UINT160_MAX ||
    liquidity > UINT128_MAX ||
    tick < INT24_MIN ||
    tick > INT24_MAX
  ) {
    return undefined;
  }
  const direction = deriveSwapDirection(amount0, amount1, pool);
  return {
    amount0PoolDeltaRaw: amount0.toString(),
    amount1PoolDeltaRaw: amount1.toString(),
    ...optionalDirectionFields(direction),
    direction: direction.direction,
    liquidity: liquidity.toString(),
    logIndex: log.logIndex,
    poolAddress: pool.poolAddress,
    protocol: 'uniswap_v3',
    recipient,
    sender,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: tick.toString(),
    token0: pool.token0,
    token1: pool.token1,
  };
}

function deriveSwapDirection(
  amount0PoolDelta: bigint,
  amount1PoolDelta: bigint,
  pool: EvmPoolMetadataEntry,
): SwapDirection {
  if (amount0PoolDelta > 0n && amount1PoolDelta < 0n) {
    return {
      amountInRaw: amount0PoolDelta.toString(),
      amountOutRaw: (-amount1PoolDelta).toString(),
      direction: 'token0_to_token1',
      tokenIn: pool.token0,
      tokenOut: pool.token1,
    };
  }
  if (amount1PoolDelta > 0n && amount0PoolDelta < 0n) {
    return {
      amountInRaw: amount1PoolDelta.toString(),
      amountOutRaw: (-amount0PoolDelta).toString(),
      direction: 'token1_to_token0',
      tokenIn: pool.token1,
      tokenOut: pool.token0,
    };
  }
  return { direction: 'ambiguous' };
}

function optionalDirectionFields(direction: SwapDirection): {
  amountInRaw?: string | undefined;
  amountOutRaw?: string | undefined;
  tokenIn?: string | undefined;
  tokenOut?: string | undefined;
} {
  return {
    ...(direction.amountInRaw === undefined ? {} : { amountInRaw: direction.amountInRaw }),
    ...(direction.amountOutRaw === undefined ? {} : { amountOutRaw: direction.amountOutRaw }),
    ...(direction.tokenIn === undefined ? {} : { tokenIn: direction.tokenIn }),
    ...(direction.tokenOut === undefined ? {} : { tokenOut: direction.tokenOut }),
  };
}

function markUnresolvedSwap(
  snapshot: EvmTransactionSnapshot,
  sources: ReadonlyMap<string, EvmTransactionSnapshot['sources'][number]>,
  log: EvmTransactionLog,
  state: EnrichmentState,
  code: string,
  additionalEvidenceIds: readonly string[] = [],
): void {
  const evidenceId = ensureLogEvidence(
    snapshot,
    sources,
    log,
    [findingIds.unresolvedSwapEvents],
    state,
    { reason: code },
  );
  state.coverage.unresolvedSwapLogs += 1;
  state.unresolvedSwapEvidenceIds.add(evidenceId);
  for (const id of additionalEvidenceIds) {
    state.unresolvedSwapEvidenceIds.add(id);
  }
  addIssue(state, 'decode_swaps', code, code === 'pool_metadata_missing', [
    evidenceId,
    ...additionalEvidenceIds,
  ]);
}

function addSwapFindings(state: EnrichmentState): void {
  if (state.swaps.length > 0) {
    state.findings.push({
      confidence: 1,
      evidenceIds: uniqueSorted(state.swaps.flatMap((swap) => swap.evidenceIds)),
      id: findingIds.dexSwaps,
      inference: false,
      statement: `Decoded ${state.swaps.length} allowlisted Uniswap V2/V3 swap event(s) with explicit pool metadata.`,
    });
  }
  if (state.coverage.unresolvedSwapLogs > 0) {
    state.findings.push({
      confidence: 1,
      evidenceIds: uniqueSorted(state.unresolvedSwapEvidenceIds),
      id: findingIds.unresolvedSwapEvents,
      inference: false,
      statement: `${state.coverage.unresolvedSwapLogs} recognized swap event(s) could not be safely resolved.`,
    });
  }
}

export function decodeSolidityRevertData(output: string): DecodedSolidityRevertData {
  if (output.length > MAX_TRACE_BYTES * 2 + 2 || !/^0x(?:[0-9a-f]{2})*$/u.test(output)) {
    return { dataLengthBytes: 0, kind: 'malformed' };
  }
  const hex = output.slice(2);
  const dataLengthBytes = hex.length / 2;
  if (hex.length === 0) {
    return { dataLengthBytes, kind: 'empty' };
  }
  if (hex.length < 8) {
    return { dataLengthBytes, kind: 'malformed' };
  }

  const selector = `0x${hex.slice(0, 8)}`;
  if (selector === SOLIDITY_ERROR_STRING_SELECTOR) {
    const reason = decodeErrorString(hex.slice(8));
    if (reason === undefined) {
      return { dataLengthBytes, kind: 'malformed', selector };
    }
    return { dataLengthBytes, kind: 'error_string', reason, selector };
  }
  if (selector === SOLIDITY_PANIC_SELECTOR) {
    const body = hex.slice(8);
    if (body.length !== 64) {
      return { dataLengthBytes, kind: 'malformed', selector };
    }
    const panic = BigInt(`0x${body}`);
    const description = PANIC_DESCRIPTIONS.get(panic);
    return {
      dataLengthBytes,
      kind: 'panic',
      panicCode: panic.toString(),
      ...(description === undefined ? {} : { panicDescription: description }),
      selector,
    };
  }
  return { dataLengthBytes, kind: 'custom_error', selector };
}

function decodeErrorString(body: string): string | undefined {
  if (body.length < 128 || body.length % 64 !== 0) {
    return undefined;
  }
  const offset = BigInt(`0x${body.slice(0, 64)}`);
  if (offset !== 32n) {
    return undefined;
  }
  const byteLength = BigInt(`0x${body.slice(64, 128)}`);
  if (byteLength > 1_024n) {
    return undefined;
  }
  const paddedBytes = ((byteLength + 31n) / 32n) * 32n;
  const expectedHexLength = 128n + paddedBytes * 2n;
  if (BigInt(body.length) !== expectedHexLength) {
    return undefined;
  }
  const dataEnd = 128 + Number(byteLength) * 2;
  const dataHex = body.slice(128, dataEnd);
  const padding = body.slice(dataEnd);
  if (!/^0*$/u.test(padding)) {
    return undefined;
  }
  const bytes = Uint8Array.from(dataHex.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
  try {
    const reason = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (reason.length > 1_000 || /\p{Cc}/u.test(reason)) {
      return undefined;
    }
    return reason;
  } catch {
    return undefined;
  }
}

function isCommittedTraceNode(
  node: EvmTraceNode,
  nodes: ReadonlyMap<string, EvmTraceNode>,
  receipt: EvmTransactionReceipt | undefined,
): boolean {
  if (receipt?.status !== 'success' || node.status !== 'success') {
    return false;
  }
  for (let depth = 0; depth < node.traceAddress.length; depth += 1) {
    const ancestor = nodes.get(traceAddressKey(node.traceAddress.slice(0, depth)));
    if (ancestor?.status !== 'success') {
      return false;
    }
  }
  return true;
}

function isValueTransferCallType(
  callType: EvmTraceNode['type'],
): callType is EvmInternalTransfer['transferType'] {
  return (
    callType === 'call' ||
    callType === 'create' ||
    callType === 'create2' ||
    callType === 'selfdestruct'
  );
}

function ensureTraceEvidence(
  snapshot: EvmTransactionSnapshot,
  trace: EvmCallTrace,
  node: EvmTraceNode,
  supports: readonly string[],
  state: EnrichmentState,
  revertData?: JsonValue,
): string {
  const path = traceAddressKey(node.traceAddress);
  const id = `trace:${trace.transactionHash}:${path}`;
  addEvidence(state, {
    chainId: snapshot.chainId,
    confidence: 1,
    id,
    kind: 'trace',
    observedAt: trace.source.observedAt,
    ...(trace.source.payloadHash === undefined ? {} : { payloadHash: trace.source.payloadHash }),
    source: trace.source.id,
    structuredData: {
      callType: node.type,
      ...(node.errorCode === undefined ? {} : { errorCode: node.errorCode }),
      from: node.from,
      inputLengthBytes: (node.input.length - 2) / 2,
      outputLengthBytes: node.output === undefined ? 0 : (node.output.length - 2) / 2,
      ...(revertData === undefined ? {} : { revert: revertData }),
      status: node.status,
      to: node.to,
      traceAddress: node.traceAddress,
      valueWei: node.value,
    },
    supports: [...supports],
    transactionHash: trace.transactionHash,
  });
  return id;
}

function ensureLogEvidence(
  snapshot: EvmTransactionSnapshot,
  sources: ReadonlyMap<string, EvmTransactionSnapshot['sources'][number]>,
  log: EvmTransactionLog,
  supports: readonly string[],
  state: EnrichmentState,
  details: JsonValue,
): string {
  const id = `log:${snapshot.requestedTransactionHash}:${log.logIndex}`;
  const source = sources.get(log.sourceId);
  addEvidence(state, {
    ...(snapshot.receipt?.blockNumber === undefined
      ? {}
      : { blockNumber: snapshot.receipt.blockNumber }),
    chainId: snapshot.chainId,
    confidence: 1,
    id,
    kind: 'log',
    observedAt: source?.observedAt ?? snapshot.observedAt,
    ...(source?.payloadHash === undefined ? {} : { payloadHash: source.payloadHash }),
    source: log.sourceId,
    structuredData: {
      address: log.address,
      details,
      logIndex: log.logIndex,
      topic0: log.topics[0] ?? null,
    },
    supports: [...supports],
    transactionHash: snapshot.requestedTransactionHash,
  });
  return id;
}

function ensurePoolEvidence(
  snapshot: EvmTransactionSnapshot,
  pool: EvmPoolMetadataEntry,
  supports: readonly string[],
  state: EnrichmentState,
): string {
  const id = `pool:${pool.chainId}:${pool.poolAddress}`;
  addEvidence(state, {
    chainId: snapshot.chainId,
    confidence: 1,
    id,
    kind: 'metadata',
    observedAt: pool.source.observedAt,
    ...(pool.source.payloadHash === undefined ? {} : { payloadHash: pool.source.payloadHash }),
    source: pool.source.id,
    structuredData: {
      poolAddress: pool.poolAddress,
      protocol: pool.protocol,
      token0: pool.token0,
      token1: pool.token1,
    },
    supports: [...supports],
    transactionHash: snapshot.requestedTransactionHash,
  });
  return id;
}

function addEvidence(state: EnrichmentState, evidence: EvidenceItem): void {
  const existing = state.evidence.get(evidence.id);
  if (existing === undefined) {
    state.evidence.set(evidence.id, evidence);
    return;
  }
  state.evidence.set(evidence.id, {
    ...existing,
    supports: uniqueSorted([...existing.supports, ...evidence.supports]),
  });
}

function addNativeDelta(
  state: EnrichmentState,
  chainId: string,
  address: string,
  delta: bigint,
  evidenceId: string,
): void {
  if (delta === 0n) {
    return;
  }
  const key = `${chainId}:${address}`;
  const existing = state.nativeAssetChanges.get(key);
  if (existing === undefined) {
    state.nativeAssetChanges.set(key, {
      address,
      chainId,
      delta,
      evidenceIds: new Set([evidenceId]),
    });
    return;
  }
  existing.delta += delta;
  existing.evidenceIds.add(evidenceId);
}

function addIssue(
  state: EnrichmentState,
  stage: string,
  code: string,
  retryable: boolean,
  evidenceIds: readonly string[] = [],
): void {
  state.materialIssue = true;
  if (!state.warnings.includes(code)) {
    state.warnings.push(code);
  }
  const key = `${stage}:${code}`;
  const existingIndex = state.diagnosticIndex.get(key);
  if (existingIndex === undefined) {
    state.diagnosticIndex.set(key, state.diagnostics.length);
    state.diagnostics.push({
      code,
      ...(evidenceIds.length === 0 ? {} : { evidenceIds: uniqueSorted(evidenceIds) }),
      retryable,
      stage,
    });
    return;
  }
  const existing = state.diagnostics[existingIndex];
  if (existing === undefined || evidenceIds.length === 0) {
    return;
  }
  state.diagnostics[existingIndex] = {
    ...existing,
    evidenceIds: uniqueSorted([...(existing.evidenceIds ?? []), ...evidenceIds]),
  };
}

function finalizeResult(
  snapshot: EvmTransactionSnapshot,
  state: EnrichmentState,
  input: {
    executionStatus: EvmExecutionEnrichmentResult['transaction']['executionStatus'];
    status: SkillResultStatus;
    summary: string;
  },
): EvmExecutionEnrichmentResult {
  const nativeAssetChanges = Array.from(state.nativeAssetChanges.values())
    .filter((change) => change.delta !== 0n)
    .sort((left, right) => left.address.localeCompare(right.address))
    .map(
      (change): EvmNativeAssetChange => ({
        address: change.address,
        chainId: change.chainId,
        evidenceIds: uniqueSorted(change.evidenceIds),
        rawDelta: change.delta.toString(),
      }),
    );

  return evmExecutionEnrichmentResultSchema.parse({
    coverage: state.coverage,
    diagnostics: state.diagnostics,
    evidence: Array.from(state.evidence.values()).sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    findings: state.findings,
    internalTransfers: state.internalTransfers,
    nativeAssetChanges,
    reverts: state.reverts,
    skill: EVM_EXECUTION_ENRICHMENT_SKILL,
    status: input.status,
    summary: input.summary,
    swaps: state.swaps,
    transaction: {
      chainId: snapshot.chainId,
      executionStatus: input.executionStatus,
      hash: snapshot.requestedTransactionHash,
    },
    version: EVM_EXECUTION_ENRICHMENT_VERSION,
    warnings: state.warnings,
  });
}

function createSummary(
  state: EnrichmentState,
  executionStatus: EvmExecutionEnrichmentResult['transaction']['executionStatus'],
  status: SkillResultStatus,
): string {
  const suffix = status === 'partial' ? ' Coverage is partial.' : '';
  return `Execution ${executionStatus}; found ${state.internalTransfers.length} internal native transfer(s), ${state.reverts.length} reverted trace node(s), and ${state.swaps.length} decoded swap(s).${suffix}`;
}

function protocolFromTopic(
  topic: string | undefined,
): EvmPoolMetadataEntry['protocol'] | undefined {
  if (topic === UNISWAP_V2_SWAP_TOPIC) {
    return 'uniswap_v2';
  }
  if (topic === UNISWAP_V3_SWAP_TOPIC) {
    return 'uniswap_v3';
  }
  return undefined;
}

function abiWords(data: string, expectedWords: number): string[] | undefined {
  const hex = data.slice(2);
  if (hex.length !== expectedWords * 64) {
    return undefined;
  }
  return Array.from({ length: expectedWords }, (_, index) =>
    hex.slice(index * 64, (index + 1) * 64),
  );
}

function unsignedWord(word: string | undefined): bigint | undefined {
  if (word === undefined || !/^[0-9a-f]{64}$/u.test(word)) {
    return undefined;
  }
  return BigInt(`0x${word}`);
}

function signedWord(word: string | undefined): bigint | undefined {
  const unsigned = unsignedWord(word);
  if (unsigned === undefined) {
    return undefined;
  }
  return unsigned >= INT256_SIGN_BIT ? unsigned - UINT256_MODULUS : unsigned;
}

function isAddressTopic(topic: string): boolean {
  return /^0x0{24}[0-9a-f]{40}$/u.test(topic);
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

function poolIdentity(chainId: string, poolAddress: string): string {
  return `${chainId}:${poolAddress}`;
}

function compareTraceAddresses(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function swapEvidenceData(swap: DecodedSwapWithoutEvidence): JsonValue {
  return { ...swap } as JsonValue;
}
