import type {
  EvidenceItem,
  JsonValue,
  SkillDiagnostic,
  SkillFinding,
  SkillResultStatus,
} from '../shared/domain-contract.js';

import {
  ERC20_TRANSFER_TOPIC,
  EVM_ZERO_ADDRESS,
  TRANSACTION_ANALYSIS_SKILL,
  TRANSACTION_ANALYSIS_VERSION,
  evmTransactionSnapshotSchema,
  transactionAnalysisResultSchema,
  type EvmTransactionSnapshot,
  type EvmTransaction,
  type EvmTransactionLog,
  type EvmTransactionReceipt,
  type TransactionAnalysisResult,
  type TransactionAssetChange,
  type TransactionTimelineItem,
  type TransactionTokenTransfer,
} from './contracts.js';

interface AnalysisState {
  assetChanges: Map<string, MutableAssetChange>;
  conflicts: TransactionAnalysisResult['conflicts'];
  diagnostics: SkillDiagnostic[];
  evidence: EvidenceItem[];
  findings: SkillFinding[];
  materialIssue: boolean;
  timeline: TransactionTimelineItem[];
  tokenTransfers: TransactionTokenTransfer[];
  warnings: string[];
}

interface MutableAssetChange {
  address: string;
  asset: TransactionAssetChange['asset'];
  delta: bigint;
  evidenceIds: Set<string>;
}

interface DecodedTransfer {
  amountRaw: string;
  evidenceId: string;
  from: string;
  log: EvmTransactionLog;
  to: string;
  tokenAddress: string;
  transferType: TransactionTokenTransfer['transferType'];
}

const findingIds = {
  blockContext: 'block_context',
  executionStatus: 'execution_status',
  gasFee: 'gas_fee',
  nativeTransfer: 'native_transfer',
  sourceConflicts: 'source_conflicts',
  tokenTransfers: 'erc20_transfers',
  transactionEnvelope: 'transaction_envelope',
} as const;

export function analyzeEvmTransactionSnapshot(input: unknown): TransactionAnalysisResult {
  const snapshot = evmTransactionSnapshotSchema.parse(input);
  const sources = new Map(snapshot.sources.map((source) => [source.id, source]));
  const state = createAnalysisState();

  addConflictArtifacts(snapshot, state);
  validateSourceReferences(snapshot, sources, state);

  const transaction = snapshot.transaction;
  if (transaction === undefined) {
    addWarning(state, 'transaction_missing');
    addDiagnostic(state, 'load', 'transaction_missing', true);
    return finalizeResult(snapshot, state, {
      executionStatus: 'unknown',
      inputKind: 'unknown',
      status: 'insufficient_data',
      summary: 'The normalized snapshot does not contain the requested transaction.',
    });
  }

  if (transaction.hash !== snapshot.requestedTransactionHash) {
    addWarning(state, 'transaction_hash_mismatch');
    addDiagnostic(state, 'validate', 'transaction_hash_mismatch', false);
    return finalizeResult(snapshot, state, {
      executionStatus: 'unknown',
      inputKind: 'unknown',
      status: 'insufficient_data',
      summary: 'The returned transaction hash does not match the requested transaction.',
    });
  }

  let receipt = snapshot.receipt;
  if (receipt !== undefined && receipt.transactionHash !== transaction.hash) {
    addWarning(state, 'receipt_transaction_hash_mismatch');
    addDiagnostic(state, 'validate', 'receipt_transaction_hash_mismatch', false);
    state.materialIssue = true;
    receipt = undefined;
  }
  if (
    receipt !== undefined &&
    transaction.blockNumber !== undefined &&
    receipt.blockNumber !== transaction.blockNumber
  ) {
    addWarning(state, 'transaction_receipt_block_mismatch');
    addDiagnostic(state, 'reconcile', 'transaction_receipt_block_mismatch', false);
    state.materialIssue = true;
    receipt = undefined;
  }
  if (
    receipt !== undefined &&
    transaction.transactionIndex !== undefined &&
    receipt.transactionIndex !== undefined &&
    transaction.transactionIndex !== receipt.transactionIndex
  ) {
    addWarning(state, 'transaction_receipt_index_mismatch');
    addDiagnostic(state, 'reconcile', 'transaction_receipt_index_mismatch', false);
    state.materialIssue = true;
  }

  const expectedBlockNumber = receipt?.blockNumber ?? transaction.blockNumber;
  let block = snapshot.block;
  if (
    block !== undefined &&
    (expectedBlockNumber === undefined || block.number !== expectedBlockNumber)
  ) {
    addWarning(state, 'block_context_mismatch');
    addDiagnostic(state, 'reconcile', 'block_context_mismatch', false);
    state.materialIssue = true;
    block = undefined;
  }

  const executionStatus = receipt?.status ?? 'pending';
  if (receipt === undefined) {
    addWarning(state, 'receipt_missing_execution_unconfirmed');
    addDiagnostic(state, 'load', 'receipt_missing', true);
    state.materialIssue = true;
  }

  const decodedTransfers = decodeErc20Transfers(receipt, transaction.hash, state);
  const valueWei = BigInt(transaction.value);
  const feeWei =
    receipt === undefined ? undefined : BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const nativeRecipient = transaction.to ?? receipt?.contractAddress ?? undefined;
  const hasConfirmedNativeTransfer =
    executionStatus === 'success' && valueWei > 0n && nativeRecipient !== undefined;
  if (
    executionStatus === 'success' &&
    valueWei > 0n &&
    transaction.to === null &&
    nativeRecipient === undefined
  ) {
    addWarning(state, 'contract_creation_address_missing');
    addDiagnostic(state, 'normalize', 'contract_creation_address_missing', true);
    state.materialIssue = true;
  }

  const transactionEvidenceId = `tx:${snapshot.chainId}:${transaction.hash}`;
  const receiptEvidenceId = receipt === undefined ? undefined : `receipt:${transaction.hash}`;
  const blockEvidenceId =
    block === undefined ? undefined : `block:${snapshot.chainId}:${block.number}`;
  const feeEvidenceId = feeWei === undefined ? undefined : `calculation:fee:${transaction.hash}`;

  const transactionSupports: string[] = [
    findingIds.transactionEnvelope,
    findingIds.executionStatus,
  ];
  if (hasConfirmedNativeTransfer) {
    transactionSupports.push(findingIds.nativeTransfer);
  }
  state.evidence.push(
    createEvidence(snapshot, sources, {
      blockNumber: transaction.blockNumber,
      id: transactionEvidenceId,
      kind: 'transaction',
      sourceId: transaction.sourceId,
      structuredData: {
        from: transaction.from,
        inputKind: classifyInput(transaction.input, transaction.to),
        nonce: transaction.nonce,
        to: transaction.to,
        valueWei: transaction.value,
      },
      supports: transactionSupports,
      transactionHash: transaction.hash,
    }),
  );

  const executionEvidenceIds = [transactionEvidenceId];
  if (receipt !== undefined && receiptEvidenceId !== undefined) {
    const receiptSupports: string[] = [findingIds.executionStatus, findingIds.gasFee];
    if (decodedTransfers.length > 0) {
      receiptSupports.push(findingIds.tokenTransfers);
    }
    if (hasConfirmedNativeTransfer) {
      receiptSupports.push(findingIds.nativeTransfer);
    }
    state.evidence.push(
      createEvidence(snapshot, sources, {
        blockNumber: receipt.blockNumber,
        id: receiptEvidenceId,
        kind: 'transaction',
        sourceId: receipt.sourceId,
        structuredData: {
          effectiveGasPriceWei: receipt.effectiveGasPrice,
          gasUsed: receipt.gasUsed,
          logCount: receipt.logs.length,
          status: receipt.status,
        },
        supports: receiptSupports,
        transactionHash: transaction.hash,
      }),
    );
    executionEvidenceIds.push(receiptEvidenceId);
  }

  state.findings.push({
    confidence: 1,
    evidenceIds: [transactionEvidenceId],
    id: findingIds.transactionEnvelope,
    inference: false,
    statement: `Transaction envelope records ${transaction.value} wei from ${transaction.from}.`,
  });
  state.findings.push({
    confidence: receipt === undefined ? 0.5 : 1,
    evidenceIds: executionEvidenceIds,
    id: findingIds.executionStatus,
    inference: receipt === undefined,
    statement: executionStatement(executionStatus),
  });
  addTimeline(state, {
    evidenceIds: executionEvidenceIds,
    kind: 'execution',
    statement: executionStatement(executionStatus),
  });

  if (
    hasConfirmedNativeTransfer &&
    nativeRecipient !== undefined &&
    receiptEvidenceId !== undefined
  ) {
    const evidenceIds = [transactionEvidenceId, receiptEvidenceId];
    state.findings.push({
      confidence: 1,
      evidenceIds,
      id: findingIds.nativeTransfer,
      inference: false,
      statement: `The successful transaction transferred ${transaction.value} wei to ${nativeRecipient}.`,
    });
    addTimeline(state, {
      amountRaw: transaction.value,
      evidenceIds,
      from: transaction.from,
      kind: 'native_transfer',
      statement: `Transferred ${transaction.value} wei of the native asset.`,
      to: nativeRecipient,
    });
    addAssetDelta(
      state,
      transaction.from,
      { chainId: snapshot.chainId, kind: 'native' },
      -valueWei,
      evidenceIds,
    );
    addAssetDelta(
      state,
      nativeRecipient,
      { chainId: snapshot.chainId, kind: 'native' },
      valueWei,
      evidenceIds,
    );
  }

  if (
    receipt !== undefined &&
    receiptEvidenceId !== undefined &&
    feeWei !== undefined &&
    feeEvidenceId !== undefined
  ) {
    const evidenceIds = [receiptEvidenceId, feeEvidenceId];
    state.evidence.push(
      createEvidence(snapshot, sources, {
        blockNumber: receipt.blockNumber,
        id: feeEvidenceId,
        kind: 'calculation',
        sourceId: 'transaction_analysis_core',
        structuredData: {
          effectiveGasPriceWei: receipt.effectiveGasPrice,
          feeWei: feeWei.toString(),
          formula: 'gasUsed * effectiveGasPrice',
          gasUsed: receipt.gasUsed,
          precision: 'exact_integer',
        },
        supports: [findingIds.gasFee],
        transactionHash: transaction.hash,
      }),
    );
    state.findings.push({
      confidence: 1,
      evidenceIds,
      id: findingIds.gasFee,
      inference: false,
      statement: `The exact execution fee was ${feeWei.toString()} wei.`,
    });
    addTimeline(state, {
      amountRaw: feeWei.toString(),
      evidenceIds,
      from: transaction.from,
      kind: 'fee',
      statement: `Charged ${feeWei.toString()} wei in execution fees.`,
    });
    addAssetDelta(
      state,
      transaction.from,
      { chainId: snapshot.chainId, kind: 'native' },
      -feeWei,
      evidenceIds,
    );
  }

  if (decodedTransfers.length > 0 && receipt !== undefined && receiptEvidenceId !== undefined) {
    const transferEvidenceIds = decodedTransfers.map((transfer) => transfer.evidenceId);
    state.findings.push({
      confidence: 1,
      evidenceIds: [receiptEvidenceId, ...transferEvidenceIds],
      id: findingIds.tokenTransfers,
      inference: false,
      statement: `Decoded ${decodedTransfers.length} ERC-20 Transfer event(s) from the successful receipt.`,
    });

    for (const transfer of decodedTransfers) {
      state.evidence.push(
        createEvidence(snapshot, sources, {
          blockNumber: receipt.blockNumber,
          id: transfer.evidenceId,
          kind: 'log',
          sourceId: transfer.log.sourceId,
          structuredData: {
            amountRaw: transfer.amountRaw,
            from: transfer.from,
            logIndex: transfer.log.logIndex,
            to: transfer.to,
            tokenAddress: transfer.tokenAddress,
            transferType: transfer.transferType,
          },
          supports: [findingIds.tokenTransfers],
          transactionHash: transaction.hash,
        }),
      );
      const normalizedTransfer: TransactionTokenTransfer = {
        amountRaw: transfer.amountRaw,
        evidenceId: transfer.evidenceId,
        from: transfer.from,
        logIndex: transfer.log.logIndex,
        to: transfer.to,
        tokenAddress: transfer.tokenAddress,
        transferType: transfer.transferType,
      };
      state.tokenTransfers.push(normalizedTransfer);
      addTimeline(state, {
        amountRaw: transfer.amountRaw,
        assetAddress: transfer.tokenAddress,
        evidenceIds: [transfer.evidenceId],
        from: transfer.from,
        kind: 'token_transfer',
        logIndex: transfer.log.logIndex,
        statement: `ERC-20 ${transfer.transferType} moved ${transfer.amountRaw} raw units.`,
        to: transfer.to,
      });
      const amount = BigInt(transfer.amountRaw);
      if (transfer.from !== EVM_ZERO_ADDRESS) {
        addAssetDelta(
          state,
          transfer.from,
          { contractAddress: transfer.tokenAddress, kind: 'erc20' },
          -amount,
          [transfer.evidenceId],
        );
      }
      if (transfer.to !== EVM_ZERO_ADDRESS) {
        addAssetDelta(
          state,
          transfer.to,
          { contractAddress: transfer.tokenAddress, kind: 'erc20' },
          amount,
          [transfer.evidenceId],
        );
      }
    }
  }

  if (block !== undefined && blockEvidenceId !== undefined) {
    state.evidence.push(
      createEvidence(snapshot, sources, {
        blockNumber: block.number,
        id: blockEvidenceId,
        kind: 'block',
        sourceId: block.sourceId,
        structuredData: { blockHash: block.hash, timestamp: block.timestamp },
        supports: [findingIds.blockContext],
        transactionHash: transaction.hash,
      }),
    );
    state.findings.push({
      confidence: 1,
      evidenceIds: [blockEvidenceId],
      id: findingIds.blockContext,
      inference: false,
      statement: `The transaction is anchored to block ${block.number} at timestamp ${block.timestamp}.`,
    });
    addTimeline(state, {
      evidenceIds: [blockEvidenceId],
      kind: 'block_context',
      statement: `Block ${block.number} timestamp is ${block.timestamp}.`,
    });
  }

  const status: SkillResultStatus = state.materialIssue ? 'partial' : 'success';
  return finalizeResult(snapshot, state, {
    blockNumber: expectedBlockNumber,
    blockTimestamp: block?.timestamp,
    executionStatus,
    feeWei: feeWei?.toString(),
    from: transaction.from,
    inputKind: classifyInput(transaction.input, transaction.to),
    status,
    summary: createSummary(executionStatus, decodedTransfers.length, status),
    to: transaction.to,
    valueWei: transaction.value,
  });
}

function createAnalysisState(): AnalysisState {
  return {
    assetChanges: new Map(),
    conflicts: [],
    diagnostics: [],
    evidence: [],
    findings: [],
    materialIssue: false,
    timeline: [],
    tokenTransfers: [],
    warnings: [],
  };
}

function addConflictArtifacts(snapshot: EvmTransactionSnapshot, state: AnalysisState): void {
  const conflicts = snapshot.conflicts ?? [];
  if (conflicts.length === 0) {
    return;
  }

  const evidenceIds: string[] = [];
  for (const [index, conflict] of conflicts.entries()) {
    const evidenceId = `conflict:${index + 1}`;
    const sourceIds = Array.from(
      new Set(conflict.observations.map((observation) => observation.sourceId)),
    ).sort();
    evidenceIds.push(evidenceId);
    state.conflicts.push({ evidenceId, field: conflict.field, sourceIds });
    state.evidence.push({
      chainId: snapshot.chainId,
      confidence: 1,
      id: evidenceId,
      kind: 'calculation',
      observedAt: snapshot.observedAt,
      source: 'source_reconciliation',
      structuredData: { field: conflict.field, sourceIds },
      supports: [findingIds.sourceConflicts],
      transactionHash: snapshot.requestedTransactionHash,
    });
    addDiagnostic(state, 'reconcile', 'source_conflict', false, [evidenceId]);
  }
  state.findings.push({
    confidence: 1,
    evidenceIds,
    id: findingIds.sourceConflicts,
    inference: false,
    statement: `${conflicts.length} source conflict(s) remain unresolved.`,
  });
  addWarning(state, `unresolved_source_conflicts:${conflicts.length}`);
  state.materialIssue = true;
}

function validateSourceReferences(
  snapshot: EvmTransactionSnapshot,
  sources: ReadonlyMap<string, EvmTransactionSnapshot['sources'][number]>,
  state: AnalysisState,
): void {
  const referencedSourceIds = new Set<string>();
  if (snapshot.transaction !== undefined) {
    referencedSourceIds.add(snapshot.transaction.sourceId);
  }
  if (snapshot.receipt !== undefined) {
    referencedSourceIds.add(snapshot.receipt.sourceId);
    for (const log of snapshot.receipt.logs) {
      referencedSourceIds.add(log.sourceId);
    }
  }
  if (snapshot.block !== undefined) {
    referencedSourceIds.add(snapshot.block.sourceId);
  }
  for (const conflict of snapshot.conflicts ?? []) {
    for (const observation of conflict.observations) {
      referencedSourceIds.add(observation.sourceId);
    }
  }

  for (const sourceId of referencedSourceIds) {
    if (!sources.has(sourceId)) {
      addWarning(state, `unknown_source_reference:${sourceId}`);
      addDiagnostic(state, 'validate', 'unknown_source_reference', false);
      state.materialIssue = true;
    }
  }
}

function decodeErc20Transfers(
  receipt: EvmTransactionReceipt | undefined,
  transactionHash: string,
  state: AnalysisState,
): DecodedTransfer[] {
  if (receipt === undefined) {
    return [];
  }
  if (receipt.status === 'reverted') {
    if (receipt.logs.length > 0) {
      addWarning(state, 'reverted_receipt_contains_logs');
      addDiagnostic(state, 'decode_logs', 'reverted_receipt_contains_logs', false);
      state.materialIssue = true;
    }
    return [];
  }

  const transfers: DecodedTransfer[] = [];
  const seenLogIndexes = new Set<number>();
  for (const log of [...receipt.logs].sort((left, right) => left.logIndex - right.logIndex)) {
    if (seenLogIndexes.has(log.logIndex)) {
      addWarning(state, `duplicate_log_index:${log.logIndex}`);
      addDiagnostic(state, 'decode_logs', 'duplicate_log_index', false);
      state.materialIssue = true;
      continue;
    }
    seenLogIndexes.add(log.logIndex);
    if (log.removed === true) {
      addWarning(state, `removed_log_ignored:${log.logIndex}`);
      addDiagnostic(state, 'decode_logs', 'removed_log_ignored', true);
      state.materialIssue = true;
      continue;
    }
    if (log.topics[0] !== ERC20_TRANSFER_TOPIC) {
      continue;
    }
    if (log.topics.length !== 3 || log.data.length !== 66) {
      addWarning(state, `malformed_erc20_transfer_log:${log.logIndex}`);
      addDiagnostic(state, 'decode_logs', 'malformed_erc20_transfer_log', false);
      state.materialIssue = true;
      continue;
    }

    const fromTopic = log.topics[1];
    const toTopic = log.topics[2];
    if (fromTopic === undefined || toTopic === undefined) {
      continue;
    }
    if (!isAddressTopic(fromTopic) || !isAddressTopic(toTopic)) {
      addWarning(state, `malformed_erc20_transfer_log:${log.logIndex}`);
      addDiagnostic(state, 'decode_logs', 'malformed_erc20_transfer_log', false);
      state.materialIssue = true;
      continue;
    }
    const from = topicToAddress(fromTopic);
    const to = topicToAddress(toTopic);
    transfers.push({
      amountRaw: BigInt(log.data).toString(),
      evidenceId: `log:${transactionHash}:${log.logIndex}`,
      from,
      log,
      to,
      tokenAddress: log.address,
      transferType:
        from === EVM_ZERO_ADDRESS ? 'mint' : to === EVM_ZERO_ADDRESS ? 'burn' : 'transfer',
    });
  }
  return transfers;
}

function isAddressTopic(topic: string): boolean {
  return /^0x0{24}[0-9a-f]{40}$/u.test(topic);
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

function classifyInput(
  input: string,
  to: EvmTransaction['to'],
): TransactionAnalysisResult['transaction']['inputKind'] {
  if (to === null) {
    return 'contract_creation';
  }
  return input === '0x' ? 'native_transfer' : 'contract_call';
}

function executionStatement(
  status: TransactionAnalysisResult['transaction']['executionStatus'],
): string {
  if (status === 'success') {
    return 'The transaction receipt reports successful execution.';
  }
  if (status === 'reverted') {
    return 'The transaction receipt reports reverted execution.';
  }
  return 'No matching receipt is available, so execution remains unconfirmed.';
}

function createSummary(
  executionStatus: TransactionAnalysisResult['transaction']['executionStatus'],
  transferCount: number,
  status: SkillResultStatus,
): string {
  const execution =
    executionStatus === 'success'
      ? 'executed successfully'
      : executionStatus === 'reverted'
        ? 'reverted'
        : 'has no confirmed receipt';
  const suffix = status === 'partial' ? ' The analysis is partial.' : '';
  return `The transaction ${execution}; decoded ${transferCount} ERC-20 Transfer event(s).${suffix}`;
}

function createEvidence(
  snapshot: EvmTransactionSnapshot,
  sources: ReadonlyMap<string, EvmTransactionSnapshot['sources'][number]>,
  input: {
    blockNumber?: string | undefined;
    id: string;
    kind: EvidenceItem['kind'];
    sourceId: string;
    structuredData: JsonValue;
    supports: string[];
    transactionHash: string;
  },
): EvidenceItem {
  const source = sources.get(input.sourceId);
  return {
    ...(input.blockNumber === undefined ? {} : { blockNumber: input.blockNumber }),
    chainId: snapshot.chainId,
    confidence: 1,
    id: input.id,
    kind: input.kind,
    observedAt: source?.observedAt ?? snapshot.observedAt,
    ...(source?.payloadHash === undefined ? {} : { payloadHash: source.payloadHash }),
    source: input.sourceId,
    ...(source?.url === undefined ? {} : { sourceUrl: source.url }),
    structuredData: input.structuredData,
    supports: input.supports,
    transactionHash: input.transactionHash,
  };
}

function addTimeline(state: AnalysisState, item: Omit<TransactionTimelineItem, 'sequence'>): void {
  state.timeline.push({ ...item, sequence: state.timeline.length + 1 });
}

function addAssetDelta(
  state: AnalysisState,
  address: string,
  asset: TransactionAssetChange['asset'],
  delta: bigint,
  evidenceIds: readonly string[],
): void {
  if (delta === 0n) {
    return;
  }
  const assetId =
    asset.kind === 'native' ? `native:${asset.chainId}` : `erc20:${asset.contractAddress}`;
  const key = `${assetId}:${address}`;
  const existing = state.assetChanges.get(key);
  if (existing === undefined) {
    state.assetChanges.set(key, {
      address,
      asset,
      delta,
      evidenceIds: new Set(evidenceIds),
    });
    return;
  }
  existing.delta += delta;
  for (const evidenceId of evidenceIds) {
    existing.evidenceIds.add(evidenceId);
  }
}

function finalizeResult(
  snapshot: EvmTransactionSnapshot,
  state: AnalysisState,
  input: {
    blockNumber?: string | undefined;
    blockTimestamp?: string | undefined;
    executionStatus: TransactionAnalysisResult['transaction']['executionStatus'];
    feeWei?: string | undefined;
    from?: string | undefined;
    inputKind: TransactionAnalysisResult['transaction']['inputKind'];
    status: SkillResultStatus;
    summary: string;
    to?: string | null | undefined;
    valueWei?: string | undefined;
  },
): TransactionAnalysisResult {
  const assetChanges = Array.from(state.assetChanges.entries())
    .filter(([, change]) => change.delta !== 0n)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([, change]): TransactionAssetChange => ({
        address: change.address,
        asset: change.asset,
        evidenceIds: Array.from(change.evidenceIds).sort(),
        rawDelta: change.delta.toString(),
      }),
    );

  return transactionAnalysisResultSchema.parse({
    assetChanges,
    conflicts: state.conflicts,
    diagnostics: state.diagnostics,
    evidence: state.evidence,
    findings: state.findings,
    skill: TRANSACTION_ANALYSIS_SKILL,
    status: input.status,
    summary: input.summary,
    timeline: normalizeTimeline(state.timeline),
    tokenTransfers: state.tokenTransfers,
    transaction: {
      ...(input.blockNumber === undefined ? {} : { blockNumber: input.blockNumber }),
      ...(input.blockTimestamp === undefined ? {} : { blockTimestamp: input.blockTimestamp }),
      chainId: snapshot.chainId,
      executionStatus: input.executionStatus,
      ...(input.feeWei === undefined ? {} : { feeWei: input.feeWei }),
      ...(input.from === undefined ? {} : { from: input.from }),
      hash: snapshot.requestedTransactionHash,
      inputKind: input.inputKind,
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.valueWei === undefined ? {} : { valueWei: input.valueWei }),
    },
    version: TRANSACTION_ANALYSIS_VERSION,
    warnings: state.warnings,
  });
}

function normalizeTimeline(
  timeline: readonly TransactionTimelineItem[],
): TransactionTimelineItem[] {
  const kindOrder: Record<TransactionTimelineItem['kind'], number> = {
    execution: 0,
    native_transfer: 1,
    token_transfer: 2,
    fee: 3,
    block_context: 4,
  };
  return [...timeline]
    .sort(
      (left, right) =>
        kindOrder[left.kind] - kindOrder[right.kind] ||
        (left.logIndex ?? Number.MAX_SAFE_INTEGER) - (right.logIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.sequence - right.sequence,
    )
    .map((item, index) => ({ ...item, sequence: index + 1 }));
}

function addWarning(state: AnalysisState, warning: string): void {
  if (!state.warnings.includes(warning)) {
    state.warnings.push(warning);
  }
}

function addDiagnostic(
  state: AnalysisState,
  stage: string,
  code: string,
  retryable: boolean,
  evidenceIds?: string[],
): void {
  state.diagnostics.push({
    code,
    ...(evidenceIds === undefined ? {} : { evidenceIds }),
    retryable,
    stage,
  });
}
