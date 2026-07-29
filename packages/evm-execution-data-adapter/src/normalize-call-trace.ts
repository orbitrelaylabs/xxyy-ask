import { createHash } from 'node:crypto';

import { rpcHexQuantitySchema, rpcQuantityToDecimal } from '@xxyy/evm-data-adapter';
import {
  MAX_TRACE_BYTES,
  MAX_TRACE_DEPTH,
  MAX_TRACE_NODES,
  evmCallTraceSchema,
  type EvmCallTrace,
  type EvmTraceNode,
} from '@xxyy/evm-execution-enrichment-core';
import { evmAddressSchema, evmBytesSchema } from '@xxyy/transaction-analysis-core';

import { EvmTraceNormalizationError } from './errors.js';

interface NormalizeCallTracerResultOptions {
  chainId: string;
  observedAt: string;
  payloadHash: string;
  providerId: string;
  sourceKind?: 'explorer' | 'fixture' | 'indexer' | 'rpc';
  transactionHash: string;
}

interface PendingFrame {
  frame: unknown;
  traceAddress: number[];
}

const callTypeMap = new Map<string, EvmTraceNode['type']>([
  ['CALL', 'call'],
  ['CALLCODE', 'callcode'],
  ['CREATE', 'create'],
  ['CREATE2', 'create2'],
  ['DELEGATECALL', 'delegatecall'],
  ['SELFDESTRUCT', 'selfdestruct'],
  ['STATICCALL', 'staticcall'],
  ['SUICIDE', 'selfdestruct'],
]);

export function normalizeCallTracerResult(
  input: unknown,
  options: NormalizeCallTracerResultOptions,
): EvmCallTrace {
  const nodes: EvmTraceNode[] = [];
  const pending: PendingFrame[] = [{ frame: input, traceAddress: [] }];

  while (pending.length > 0) {
    if (nodes.length >= MAX_TRACE_NODES) {
      throw new EvmTraceNormalizationError('trace_node_limit_exceeded');
    }
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    if (current.traceAddress.length > MAX_TRACE_DEPTH) {
      throw new EvmTraceNormalizationError('trace_depth_limit_exceeded');
    }

    const record = requireRecord(current.frame);
    const children = readChildren(record.calls);
    if (nodes.length + pending.length + children.length + 1 > MAX_TRACE_NODES) {
      throw new EvmTraceNormalizationError('trace_node_limit_exceeded');
    }

    nodes.push(normalizeFrame(record, current.traceAddress, options.providerId));

    for (let index = children.length - 1; index >= 0; index -= 1) {
      if (index > 999) {
        throw new EvmTraceNormalizationError('trace_node_limit_exceeded');
      }
      const childTraceAddress = [...current.traceAddress, index];
      if (childTraceAddress.length > MAX_TRACE_DEPTH) {
        throw new EvmTraceNormalizationError('trace_depth_limit_exceeded');
      }
      pending.push({ frame: children[index], traceAddress: childTraceAddress });
    }
  }

  try {
    return evmCallTraceSchema.parse({
      chainId: options.chainId,
      nodes,
      source: {
        id: options.providerId,
        kind: options.sourceKind ?? 'rpc',
        observedAt: options.observedAt,
        payloadHash: options.payloadHash,
      },
      transactionHash: options.transactionHash,
    });
  } catch {
    throw new EvmTraceNormalizationError('trace_invalid');
  }
}

export function fingerprintCallTrace(trace: EvmCallTrace): string {
  return sha256Json({
    chainId: trace.chainId,
    nodes: trace.nodes.map((node) => ({
      errorCode: node.errorCode ?? null,
      from: node.from,
      gasUsed: node.gasUsed ?? null,
      input: node.input,
      output: node.output ?? null,
      status: node.status,
      to: node.to,
      traceAddress: node.traceAddress,
      type: node.type,
      value: node.value,
    })),
    transactionHash: trace.transactionHash,
  });
}

function normalizeFrame(
  record: Record<string, unknown>,
  traceAddress: number[],
  sourceId: string,
): EvmTraceNode {
  const type = normalizeCallType(record.type);
  const error = normalizeError(record.error);
  const status = error === undefined ? 'success' : 'reverted';
  const from = parseAddress(record.from);
  const to = record.to === null || record.to === undefined ? null : parseAddress(record.to);
  const input = parseBoundedBytes(record.input ?? '0x');
  const output =
    record.output === undefined || record.output === null
      ? undefined
      : parseBoundedBytes(record.output);
  const value = parseQuantity(record.value ?? '0x0');
  const gasUsed =
    record.gasUsed === undefined || record.gasUsed === null
      ? undefined
      : parseQuantity(record.gasUsed);

  return {
    ...(error === undefined ? {} : { errorCode: error }),
    from,
    ...(gasUsed === undefined ? {} : { gasUsed }),
    input,
    ...(output === undefined ? {} : { output }),
    sourceId,
    status,
    to,
    traceAddress,
    type,
    value,
  };
}

function requireRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new EvmTraceNormalizationError('trace_invalid');
  }
  return input as Record<string, unknown>;
}

function readChildren(input: unknown): unknown[] {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new EvmTraceNormalizationError('trace_invalid');
  }
  if (input.length > MAX_TRACE_NODES) {
    throw new EvmTraceNormalizationError('trace_node_limit_exceeded');
  }
  return input;
}

function normalizeCallType(input: unknown): EvmTraceNode['type'] {
  if (typeof input !== 'string') {
    throw new EvmTraceNormalizationError('trace_invalid');
  }
  const type = callTypeMap.get(input.toUpperCase());
  if (type === undefined) {
    throw new EvmTraceNormalizationError('trace_invalid');
  }
  return type;
}

function normalizeError(input: unknown): string | undefined {
  if (input === undefined || input === null || input === '') {
    return undefined;
  }
  if (typeof input !== 'string') {
    throw new EvmTraceNormalizationError('trace_invalid');
  }
  const normalized = input.toLowerCase();
  if (normalized.includes('execution reverted') || normalized === 'revert') {
    return 'execution_reverted';
  }
  if (normalized.includes('out of gas')) {
    return 'out_of_gas';
  }
  if (normalized.includes('invalid opcode')) {
    return 'invalid_opcode';
  }
  if (normalized.includes('stack underflow')) {
    return 'stack_underflow';
  }
  if (normalized.includes('stack overflow')) {
    return 'stack_overflow';
  }
  if (normalized.includes('write protection')) {
    return 'write_protection';
  }
  if (normalized.includes('return data out of bounds')) {
    return 'return_data_out_of_bounds';
  }
  if (normalized.includes('contract address collision')) {
    return 'contract_address_collision';
  }
  if (normalized.includes('max code size exceeded')) {
    return 'max_code_size_exceeded';
  }
  if (normalized.includes('insufficient balance')) {
    return 'insufficient_balance';
  }
  if (normalized.includes('depth')) {
    return 'call_depth_exceeded';
  }
  return 'unknown_execution_error';
}

function parseAddress(input: unknown): string {
  try {
    return evmAddressSchema.parse(input);
  } catch {
    throw new EvmTraceNormalizationError('trace_invalid');
  }
}

function parseQuantity(input: unknown): string {
  try {
    return rpcQuantityToDecimal(rpcHexQuantitySchema.parse(input));
  } catch {
    throw new EvmTraceNormalizationError('trace_invalid');
  }
}

function parseBoundedBytes(input: unknown): string {
  if (typeof input === 'string' && input.length > MAX_TRACE_BYTES * 2 + 2) {
    throw new EvmTraceNormalizationError('trace_bytes_limit_exceeded');
  }
  try {
    const parsed = evmBytesSchema.parse(input);
    if ((parsed.length - 2) / 2 > MAX_TRACE_BYTES) {
      throw new EvmTraceNormalizationError('trace_bytes_limit_exceeded');
    }
    return parsed;
  } catch (error) {
    if (error instanceof EvmTraceNormalizationError) {
      throw error;
    }
    throw new EvmTraceNormalizationError('trace_invalid');
  }
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
