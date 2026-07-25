import { createHash } from 'node:crypto';

import {
  loadSolanaTransactionInputSchema,
  solanaDataAdapterConfigSchema,
  solanaDataAdapterResultSchema,
  solanaTransactionSnapshotSchema,
  type LoadSolanaTransactionInput,
  type SolanaDataAdapterConfig,
  type SolanaDataAdapterDiagnostic,
  type SolanaDataAdapterResult,
  type SolanaRpcProviderConfig,
  type SolanaTransactionSnapshot,
} from './contracts.js';
import { SolanaDataAdapterError } from './errors.js';

const DEFAULT_MAX_RESPONSE_BYTES = 5_242_880;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const ABSOLUTE_MAX_RESPONSE_BYTES = 16_777_216;
const ABSOLUTE_MAX_RETRIES = 3;
const ABSOLUTE_MAX_REQUEST_TIMEOUT_MS = 120_000;

interface ProviderObservation {
  diagnostic?: SolanaDataAdapterDiagnostic;
  fingerprint?: string;
  notFound: boolean;
  snapshot?: Omit<SolanaTransactionSnapshot, 'sources'>;
  source?: SolanaTransactionSnapshot['sources'][number];
}

export interface SolanaDataAdapter {
  listConfiguredNetworks(): Array<{ network: 'solana:mainnet'; providerIds: string[] }>;
  loadTransaction(
    input: LoadSolanaTransactionInput,
    options?: { signal?: AbortSignal },
  ): Promise<SolanaDataAdapterResult>;
}

export interface CreateSolanaDataAdapterOptions {
  allowInsecureLocalhost?: boolean;
  config: SolanaDataAdapterConfig;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  maxRetries?: number;
  now?: () => Date;
  requestTimeoutMs?: number;
}

export function createSolanaDataAdapter(
  options: CreateSolanaDataAdapterOptions,
): SolanaDataAdapter {
  let config: SolanaDataAdapterConfig;
  try {
    config = solanaDataAdapterConfigSchema.parse(options.config);
  } catch (cause) {
    throw new SolanaDataAdapterError(
      'invalid_configuration',
      'Solana data adapter configuration is invalid.',
      { cause },
    );
  }
  const providers = config.providers.map((provider) => ({
    config: provider,
    endpoint: parseAllowedEndpoint(provider, options.allowInsecureLocalhost ?? false),
  }));
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    1,
    ABSOLUTE_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const maxRetries = boundedInteger(
    options.maxRetries,
    DEFAULT_MAX_RETRIES,
    0,
    ABSOLUTE_MAX_RETRIES,
    'maxRetries',
  );
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    ABSOLUTE_MAX_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  );
  const now = options.now ?? (() => new Date());

  return {
    listConfiguredNetworks() {
      return [
        {
          network: config.network,
          providerIds: providers.map((provider) => provider.config.id),
        },
      ];
    },

    async loadTransaction(rawInput, requestOptions = {}) {
      let input: LoadSolanaTransactionInput;
      try {
        input = loadSolanaTransactionInputSchema.parse(rawInput);
      } catch (cause) {
        throw new SolanaDataAdapterError(
          'invalid_configuration',
          'Solana transaction request is invalid.',
          { cause },
        );
      }
      const selected = selectProviders(providers, input.providerIds);
      const observedAt = now().toISOString();
      const observations = await Promise.all(
        selected.map((provider) =>
          loadProviderObservation({
            fetchImpl,
            maxResponseBytes,
            maxRetries,
            observedAt,
            provider: provider.config,
            endpoint: provider.endpoint,
            requestTimeoutMs,
            ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
            transactionId: input.transactionId,
          }),
        ),
      );
      return reconcileObservations(observations);
    },
  };
}

function selectProviders<T extends { config: SolanaRpcProviderConfig }>(
  providers: readonly T[],
  providerIds: readonly string[] | undefined,
): T[] {
  if (providerIds === undefined) {
    return [...providers];
  }
  const ids = new Set(providerIds);
  for (const id of ids) {
    if (!providers.some((provider) => provider.config.id === id)) {
      throw new SolanaDataAdapterError(
        'invalid_configuration',
        `Solana RPC provider ${id} is not configured.`,
      );
    }
  }
  return providers.filter((provider) => ids.has(provider.config.id));
}

async function loadProviderObservation(input: {
  endpoint: URL;
  fetchImpl: typeof fetch;
  maxResponseBytes: number;
  maxRetries: number;
  observedAt: string;
  provider: SolanaRpcProviderConfig;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  transactionId: string;
}): Promise<ProviderObservation> {
  for (let attempt = 1; attempt <= input.maxRetries + 1; attempt += 1) {
    try {
      const text = await requestTransaction(input);
      const payloadHash = fingerprint(text);
      const result = parseRpcResponse(text, input.provider.id);
      if (result === null) {
        return {
          diagnostic: {
            code: 'transaction_not_found',
            providerId: input.provider.id,
            retryable: false,
          },
          notFound: true,
        };
      }
      const normalized = normalizeTransaction(result, input.transactionId);
      const normalizedFingerprint = fingerprint(JSON.stringify(normalized));
      return {
        fingerprint: normalizedFingerprint,
        notFound: false,
        snapshot: normalized,
        source: {
          id: input.provider.id,
          kind: 'rpc',
          observedAt: input.observedAt,
          payloadHash,
          provenanceUrl: input.endpoint.origin,
        },
      };
    } catch (error) {
      const normalized = normalizeProviderError(error, input.provider.id);
      if (normalized.retryable && attempt <= input.maxRetries) {
        continue;
      }
      return {
        diagnostic: {
          code: diagnosticCode(normalized),
          ...(normalized.httpStatus === undefined ? {} : { httpStatus: normalized.httpStatus }),
          providerId: input.provider.id,
          retryable: normalized.retryable,
        },
        notFound: false,
      };
    }
  }
  return {
    diagnostic: {
      code: 'transport_error',
      providerId: input.provider.id,
      retryable: true,
    },
    notFound: false,
  };
}

async function requestTransaction(input: {
  endpoint: URL;
  fetchImpl: typeof fetch;
  maxResponseBytes: number;
  observedAt: string;
  provider: SolanaRpcProviderConfig;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  transactionId: string;
}): Promise<string> {
  if (input.signal?.aborted === true) {
    throw new SolanaDataAdapterError('request_aborted', 'Solana RPC request was aborted.', {
      providerId: input.provider.id,
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.requestTimeoutMs);
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await input.fetchImpl(input.endpoint, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'getTransaction',
        params: [
          input.transactionId,
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
      headers: {
        accept: 'application/json',
        ...(input.provider.headers ?? {}),
        'content-type': 'application/json',
      },
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SolanaDataAdapterError('http_error', 'Solana RPC returned an HTTP error.', {
        httpStatus: response.status,
        providerId: input.provider.id,
        retryable: isRetryableStatus(response.status),
      });
    }
    return await readBoundedResponse(response, input.maxResponseBytes, input.provider.id);
  } catch (error) {
    if (error instanceof SolanaDataAdapterError) {
      throw error;
    }
    if (isAborted(input.signal)) {
      throw new SolanaDataAdapterError('request_aborted', 'Solana RPC request was aborted.', {
        providerId: input.provider.id,
      });
    }
    if (controller.signal.aborted) {
      throw new SolanaDataAdapterError('request_timeout', 'Solana RPC request timed out.', {
        providerId: input.provider.id,
        retryable: true,
      });
    }
    throw new SolanaDataAdapterError('transport_error', 'Solana RPC transport failed.', {
      providerId: input.provider.id,
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  providerId: string,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      throw new SolanaDataAdapterError(
        'response_too_large',
        'Solana RPC response exceeds the configured limit.',
        { providerId },
      );
    }
  }
  if (response.body === null) {
    return '';
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SolanaDataAdapterError(
        'response_too_large',
        'Solana RPC response exceeds the configured limit.',
        { providerId },
      );
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function parseRpcResponse(text: string, providerId: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new SolanaDataAdapterError('invalid_json', 'Solana RPC returned invalid JSON.', {
      cause,
      providerId,
    });
  }
  if (!isRecord(payload) || payload.jsonrpc !== '2.0' || payload.id !== 1) {
    throw new SolanaDataAdapterError(
      'invalid_jsonrpc',
      'Solana RPC returned an invalid JSON-RPC envelope.',
      { providerId },
    );
  }
  if (Object.hasOwn(payload, 'error')) {
    throw new SolanaDataAdapterError('rpc_error', 'Solana RPC returned an RPC error.', {
      providerId,
    });
  }
  if (!Object.hasOwn(payload, 'result')) {
    throw new SolanaDataAdapterError(
      'invalid_jsonrpc',
      'Solana RPC response is missing a result.',
      { providerId },
    );
  }
  return payload.result ?? null;
}

function normalizeTransaction(
  input: unknown,
  requestedTransactionId: string,
): Omit<SolanaTransactionSnapshot, 'sources'> {
  if (!isRecord(input)) {
    throw new SolanaDataAdapterError('invalid_jsonrpc', 'Solana transaction payload is invalid.');
  }
  const slot = safeUnsignedInteger(input.slot, 'slot');
  const transaction = requiredRecord(input.transaction, 'transaction');
  const signatures = requiredArray(transaction.signatures, 'signatures');
  if (signatures[0] !== requestedTransactionId) {
    throw new SolanaDataAdapterError(
      'invalid_jsonrpc',
      'Solana transaction signature does not match the request.',
    );
  }
  const message = requiredRecord(transaction.message, 'message');
  const accountKeys = requiredArray(message.accountKeys, 'accountKeys').map(normalizeAccountKey);
  const meta = input.meta === null ? undefined : requiredRecord(input.meta, 'meta');
  const preBalances =
    meta === undefined ? [] : requiredArray(meta.preBalances, 'preBalances').map(safeBalance);
  const postBalances =
    meta === undefined ? [] : requiredArray(meta.postBalances, 'postBalances').map(safeBalance);
  if (preBalances.length !== postBalances.length || preBalances.length !== accountKeys.length) {
    throw new SolanaDataAdapterError(
      'invalid_jsonrpc',
      'Solana transaction balance arrays do not match account keys.',
    );
  }
  const nativeBalanceChanges = accountKeys.flatMap((account, accountIndex) => {
    const before = preBalances[accountIndex];
    const after = postBalances[accountIndex];
    if (before === undefined || after === undefined || before === after) {
      return [];
    }
    return [
      {
        account,
        accountIndex,
        deltaLamports: (after - before).toString(),
      },
    ];
  });
  const tokenBalanceChanges =
    meta === undefined
      ? []
      : normalizeTokenBalanceChanges(meta.preTokenBalances, meta.postTokenBalances, accountKeys);
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  const programIds = [
    ...new Set(
      instructions.flatMap((instruction) =>
        isRecord(instruction) && typeof instruction.programId === 'string'
          ? [instruction.programId]
          : [],
      ),
    ),
  ];
  const blockTime =
    input.blockTime === null || input.blockTime === undefined
      ? undefined
      : new Date(safeUnsignedInteger(input.blockTime, 'blockTime') * 1_000).toISOString();
  const logMessages = meta !== undefined && Array.isArray(meta.logMessages) ? meta.logMessages : [];
  const output = {
    accountKeys,
    ...(blockTime === undefined ? {} : { blockTime }),
    ...(meta === undefined || meta.computeUnitsConsumed === undefined
      ? {}
      : {
          computeUnitsConsumed: safeUnsignedInteger(
            meta.computeUnitsConsumed,
            'computeUnitsConsumed',
          ).toString(),
        }),
    executionStatus:
      meta === undefined
        ? ('unknown' as const)
        : meta.err === null
          ? ('success' as const)
          : ('reverted' as const),
    ...(meta === undefined ? {} : { feeLamports: safeUnsignedInteger(meta.fee, 'fee').toString() }),
    logCount: logMessages.length,
    nativeBalanceChanges,
    network: 'solana:mainnet' as const,
    programIds,
    slot: slot.toString(),
    tokenBalanceChanges,
    transactionId: requestedTransactionId,
  };
  return solanaTransactionSnapshotSchema.omit({ sources: true }).parse(output);
}

function normalizeTokenBalanceChanges(
  rawPre: unknown,
  rawPost: unknown,
  accountKeys: readonly string[],
): SolanaTransactionSnapshot['tokenBalanceChanges'] {
  const pre = tokenBalanceMap(rawPre);
  const post = tokenBalanceMap(rawPost);
  const keys = new Set([...pre.keys(), ...post.keys()]);
  const changes: SolanaTransactionSnapshot['tokenBalanceChanges'] = [];
  for (const key of [...keys].sort()) {
    const before = pre.get(key);
    const after = post.get(key);
    const reference = after ?? before;
    if (reference === undefined) {
      continue;
    }
    const delta = (after?.amount ?? 0n) - (before?.amount ?? 0n);
    if (delta === 0n) {
      continue;
    }
    const account = accountKeys[reference.accountIndex];
    changes.push({
      ...(account === undefined ? {} : { account }),
      accountIndex: reference.accountIndex,
      decimals: reference.decimals,
      deltaRaw: delta.toString(),
      mint: reference.mint,
      ...(reference.owner === undefined ? {} : { owner: reference.owner }),
      ...(reference.programId === undefined ? {} : { programId: reference.programId }),
    });
  }
  return changes;
}

function tokenBalanceMap(input: unknown): Map<
  string,
  {
    accountIndex: number;
    amount: bigint;
    decimals: number;
    mint: string;
    owner?: string;
    programId?: string;
  }
> {
  if (input === undefined || input === null) {
    return new Map();
  }
  const items = requiredArray(input, 'tokenBalances');
  const result = new Map<string, ReturnType<typeof normalizeTokenBalance>>();
  for (const item of items) {
    const balance = normalizeTokenBalance(item);
    result.set(`${balance.accountIndex}:${balance.mint}`, balance);
  }
  return result;
}

function normalizeTokenBalance(input: unknown) {
  const record = requiredRecord(input, 'tokenBalance');
  const amount = requiredRecord(record.uiTokenAmount, 'uiTokenAmount');
  const accountIndex = safeUnsignedInteger(record.accountIndex, 'accountIndex');
  const decimals = safeUnsignedInteger(amount.decimals, 'decimals');
  if (accountIndex > 511 || decimals > 255 || typeof amount.amount !== 'string') {
    throw new SolanaDataAdapterError('invalid_jsonrpc', 'Solana token balance payload is invalid.');
  }
  return {
    accountIndex,
    amount: BigInt(amount.amount),
    decimals,
    mint: requiredString(record.mint, 'mint'),
    ...(typeof record.owner === 'string' ? { owner: record.owner } : {}),
    ...(typeof record.programId === 'string' ? { programId: record.programId } : {}),
  };
}

function normalizeAccountKey(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  const record = requiredRecord(input, 'accountKey');
  return requiredString(record.pubkey, 'pubkey');
}

function reconcileObservations(
  observations: readonly ProviderObservation[],
): SolanaDataAdapterResult {
  const diagnostics = observations.flatMap((observation) =>
    observation.diagnostic === undefined ? [] : [observation.diagnostic],
  );
  const withSnapshot = observations.filter(
    (
      observation,
    ): observation is ProviderObservation &
      Required<Pick<ProviderObservation, 'fingerprint' | 'snapshot' | 'source'>> =>
      observation.snapshot !== undefined &&
      observation.source !== undefined &&
      observation.fingerprint !== undefined,
  );
  if (withSnapshot.length === 0) {
    return solanaDataAdapterResultSchema.parse({
      diagnostics,
      status: 'insufficient_data',
    });
  }
  const fingerprints = new Set(withSnapshot.map((observation) => observation.fingerprint));
  if (fingerprints.size > 1) {
    diagnostics.push(
      ...withSnapshot.map((observation) => ({
        code: 'provider_conflict' as const,
        providerId: observation.source.id,
        retryable: false,
      })),
    );
  }
  const selected = withSnapshot[0];
  if (selected === undefined) {
    throw new SolanaDataAdapterError('invalid_jsonrpc', 'Solana reconciliation failed.');
  }
  const agreeingSources = withSnapshot
    .filter((observation) => observation.fingerprint === selected.fingerprint)
    .map((observation) => observation.source);
  return solanaDataAdapterResultSchema.parse({
    diagnostics,
    snapshot: {
      ...selected.snapshot,
      sources: agreeingSources,
    },
    status:
      diagnostics.length > 0 ||
      fingerprints.size > 1 ||
      agreeingSources.length !== observations.length
        ? 'partial'
        : 'success',
  });
}

function normalizeProviderError(error: unknown, providerId: string): SolanaDataAdapterError {
  if (error instanceof SolanaDataAdapterError) {
    return error;
  }
  return new SolanaDataAdapterError('transport_error', 'Solana RPC transport failed.', {
    providerId,
    retryable: true,
  });
}

function diagnosticCode(error: SolanaDataAdapterError): SolanaDataAdapterDiagnostic['code'] {
  switch (error.code) {
    case 'http_error':
      return 'http_error';
    case 'request_aborted':
      return 'request_aborted';
    case 'request_timeout':
      return 'request_timeout';
    case 'response_too_large':
      return 'response_too_large';
    case 'rpc_error':
      return 'rpc_error';
    default:
      return 'transport_error';
  }
}

function parseAllowedEndpoint(provider: SolanaRpcProviderConfig, allowLocalhost: boolean): URL {
  const url = new URL(provider.endpoint);
  const local =
    url.protocol === 'http:' &&
    allowLocalhost &&
    ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname.toLowerCase());
  if (
    (url.protocol !== 'https:' && !local) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new SolanaDataAdapterError(
      'endpoint_not_allowed',
      `Solana RPC endpoint is not allowed for provider ${provider.id}.`,
      { providerId: provider.id },
    );
  }
  return url;
}

function requiredRecord(input: unknown, label: string): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new SolanaDataAdapterError('invalid_jsonrpc', `Solana ${label} must be an object.`);
  }
  return input;
}

function requiredArray(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) {
    throw new SolanaDataAdapterError('invalid_jsonrpc', `Solana ${label} must be an array.`);
  }
  return input;
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== 'string') {
    throw new SolanaDataAdapterError('invalid_jsonrpc', `Solana ${label} must be a string.`);
  }
  return input;
}

function safeBalance(input: unknown): bigint {
  return BigInt(safeUnsignedInteger(input, 'balance'));
}

function safeUnsignedInteger(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new SolanaDataAdapterError(
      'invalid_jsonrpc',
      `Solana ${label} must be a non-negative safe integer.`,
    );
  }
  return input;
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new SolanaDataAdapterError(
      'invalid_configuration',
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return normalized;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
