import { z } from 'zod';

import { xxyyPairCandidateSchema, type XxyyPairCandidate } from '../xxyy-diagnosis-core/index.js';

import {
  XXYY_MARKET_DATA_ORIGIN,
  xxyyMarketTradeSchema,
  xxyyTradeLookupInputSchema,
  xxyyTradeLookupResultSchema,
  type XxyyMarketDataClient,
  type XxyyMarketDiagnostic,
  type XxyyContextTrade,
  type XxyyMarketTrade,
  type XxyyTradeLookupResult,
} from './contracts.js';
import { XxyyMarketDataError } from './errors.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const TRADE_WINDOW_MS = 120_000;
const TRADE_SEARCH_WINDOWS_MS = [2_000, 15_000, TRADE_WINDOW_MS] as const;
const MAX_PAIR_CANDIDATES = 64;
const TRADE_SEARCH_PAGE_SIZE = 50;

const pairApiSchema = z
  .object({
    pairInfo: z
      .object({
        address: z.string(),
        baseToken: z.string(),
        chain: z.string(),
        dexId: z.string().nullable().optional(),
        liquidityUSD: z.string().nullable().optional(),
        quoteToken: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const pairSearchResponseSchema = z
  .object({
    code: z.literal(0),
    data: z
      .object({
        results: z.array(pairApiSchema).max(256),
      })
      .passthrough(),
  })
  .passthrough();

const tradeApiSchema = z
  .object({
    blockNumber: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/u)]).optional(),
    logIndex: z.number().int().nonnegative().optional(),
    maker: z.string(),
    marketCapUSD: z.string().optional(),
    nativeAmount: z.string(),
    timestamp: z.number(),
    tokenAmount: z.string(),
    txHash: z.string(),
    type: z.enum(['buy', 'sell']),
    usdAmount: z.string().optional(),
  })
  .passthrough();

const tradeSearchResponseSchema = z
  .object({
    code: z.literal(0),
    data: z.array(tradeApiSchema).max(500),
  })
  .passthrough();

export interface CreateXxyyMarketDataClientOptions {
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
}

export function createXxyyMarketDataClient(
  options: CreateXxyyMarketDataClientOptions = {},
): XxyyMarketDataClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  );
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );

  return {
    async findTrade(rawInput, requestOptions = {}) {
      const input = xxyyTradeLookupInputSchema.parse(rawInput);
      const diagnostics: XxyyMarketDiagnostic[] = [];
      const candidatePairs = await loadCandidatePairs({
        diagnostics,
        fetchImpl,
        input,
        maxResponseBytes,
        requestTimeoutMs,
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      const tradeSearch = await loadMatchingTrades({
        candidatePairs: candidatePairsForTradeSearch(input, candidatePairs),
        diagnostics,
        fetchImpl,
        input,
        maxResponseBytes,
        requestTimeoutMs,
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      const matches = disambiguateMatchesByTransactionAccounts(input, tradeSearch.matches);
      if (matches.length > 1) {
        const selected = selectExecutionPoolMatch(input, matches);
        if (selected === undefined) {
          diagnostics.push({
            code: 'multiple_transaction_matches',
            retryable: false,
            stage: 'validate_match',
          });
          return xxyyTradeLookupResultSchema.parse({
            candidatePairs,
            diagnostics,
            status: 'conflict',
          });
        }
        if (
          input.actor !== undefined &&
          matches.some((match) => !identifierEquals(input.chain, input.actor!, match.trade.maker))
        ) {
          diagnostics.push({
            code: 'source_actor_conflict',
            retryable: false,
            stage: 'validate_match',
          });
          return xxyyTradeLookupResultSchema.parse({
            candidatePairs,
            diagnostics,
            status: 'conflict',
          });
        }
        return xxyyTradeLookupResultSchema.parse({
          candidatePairs,
          contextComplete:
            (tradeSearch.tradesByPair.get(selected.pair.pairAddress)?.length ?? 0) <
            TRADE_SEARCH_PAGE_SIZE,
          contextTrades: contextTradesForMatch(
            selected.trade,
            tradeSearch.tradesByPair.get(selected.pair.pairAddress) ?? [],
          ),
          diagnostics,
          matchedPair: selected.pair,
          matchedTrades: matches.map((match) => ({
            contextTrades: contextTradesForMatch(
              match.trade,
              tradeSearch.tradesByPair.get(match.pair.pairAddress) ?? [],
            ),
            pair: match.pair,
            trade: match.trade,
          })),
          status: 'multi_exact',
          trade: selected.trade,
        });
      }
      if (matches.length === 0) {
        return xxyyTradeLookupResultSchema.parse({
          candidatePairs,
          diagnostics,
          status: 'not_found',
        });
      }
      const match = matches[0]!;
      if (
        input.actor !== undefined &&
        !identifierEquals(input.chain, input.actor, match.trade.maker)
      ) {
        diagnostics.push({
          code: 'source_actor_conflict',
          retryable: false,
          stage: 'validate_match',
        });
        return xxyyTradeLookupResultSchema.parse({
          candidatePairs,
          diagnostics,
          status: 'conflict',
        });
      }
      return xxyyTradeLookupResultSchema.parse({
        candidatePairs,
        contextComplete:
          (tradeSearch.tradesByPair.get(match.pair.pairAddress)?.length ?? 0) <
          TRADE_SEARCH_PAGE_SIZE,
        contextTrades: contextTradesForMatch(
          match.trade,
          tradeSearch.tradesByPair.get(match.pair.pairAddress) ?? [],
        ),
        diagnostics,
        matchedPair: match.pair,
        status: 'exact',
        trade: match.trade,
      });
    },
  };
}

function selectExecutionPoolMatch(
  input: z.output<typeof xxyyTradeLookupInputSchema>,
  matches: Array<{ pair: XxyyPairCandidate; trade: XxyyMarketTrade }>,
) {
  if (input.executionPools === undefined) return undefined;
  const executionPools = new Map(
    input.executionPools.map((pool) => [
      normalizeIdentifier(input.chain, pool.poolIdentifier),
      pool,
    ]),
  );
  const observedMatches = matches.flatMap((match) => {
    const pool = executionPools.get(normalizeIdentifier(input.chain, match.pair.pairAddress));
    return pool === undefined ? [] : [{ match, pool }];
  });
  const primaryMatches = observedMatches.filter(({ pool }) => pool.isPrimary === true);
  if (primaryMatches.length === 1) return primaryMatches[0]!.match;
  const ranked = observedMatches.flatMap(({ match, pool }) =>
    pool.amount0Raw === undefined ? [] : [{ amount: absoluteBigInt(pool.amount0Raw), match }],
  );
  if (ranked.length !== observedMatches.length || ranked.length === 0) return undefined;
  const largest = ranked.reduce(
    (current, candidate) => (candidate.amount > current.amount ? candidate : current),
    ranked[0]!,
  );
  return ranked.filter((candidate) => candidate.amount === largest.amount).length === 1
    ? largest.match
    : undefined;
}

function absoluteBigInt(value: string): bigint {
  const parsed = BigInt(value);
  return parsed < 0n ? -parsed : parsed;
}

async function loadCandidatePairs(input: {
  diagnostics: XxyyMarketDiagnostic[];
  fetchImpl: typeof fetch;
  input: z.output<typeof xxyyTradeLookupInputSchema>;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<XxyyPairCandidate[]> {
  const pairs = new Map<string, XxyyPairCandidate>();
  for (const tokenAddress of input.input.targetTokenAddresses) {
    if (pairs.size >= MAX_PAIR_CANDIDATES) break;
    try {
      const response = pairSearchResponseSchema.parse(
        await requestJson({
          fetchImpl: input.fetchImpl,
          headers: xxyyHeaders(input.input.chain),
          maxResponseBytes: input.maxResponseBytes,
          requestTimeoutMs: input.requestTimeoutMs,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          url: new URL(
            `/api/data/search/v3?q=${encodeURIComponent(tokenAddress)}`,
            XXYY_MARKET_DATA_ORIGIN,
          ),
        }),
      );
      for (const item of response.data.results) {
        const pair = item.pairInfo;
        if (normalizeChain(pair.chain) !== normalizeChain(input.input.chain)) {
          continue;
        }
        const parsed = xxyyPairCandidateSchema.safeParse({
          baseToken: pair.baseToken,
          chain: normalizeChain(pair.chain),
          ...(pair.dexId === null || pair.dexId === undefined ? {} : { dexId: pair.dexId }),
          ...(pair.liquidityUSD === null || pair.liquidityUSD === undefined
            ? {}
            : { liquidityUsd: pair.liquidityUSD }),
          pairAddress: pair.address,
          quoteToken: pair.quoteToken,
        });
        if (parsed.success) {
          pairs.set(parsed.data.pairAddress, parsed.data);
        }
        if (pairs.size >= MAX_PAIR_CANDIDATES) {
          break;
        }
      }
      if (pairs.size > 0) break;
    } catch (error) {
      input.diagnostics.push(diagnosticFor(error, 'pair_search'));
    }
  }
  return [...pairs.values()].sort((left, right) =>
    left.pairAddress.localeCompare(right.pairAddress),
  );
}

async function loadMatchingTrades(input: {
  candidatePairs: readonly XxyyPairCandidate[];
  diagnostics: XxyyMarketDiagnostic[];
  fetchImpl: typeof fetch;
  input: z.output<typeof xxyyTradeLookupInputSchema>;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  matches: Array<{ pair: XxyyPairCandidate; trade: XxyyMarketTrade }>;
  tradesByPair: Map<string, XxyyMarketTrade[]>;
}> {
  const matches: Array<{ pair: XxyyPairCandidate; trade: XxyyMarketTrade }> = [];
  const tradesByPair = new Map<string, XxyyMarketTrade[]>();
  for (const pair of input.candidatePairs) {
    try {
      const timestamp = input.input.timestampMs;
      const windows = timestamp === undefined ? [undefined] : TRADE_SEARCH_WINDOWS_MS;
      let pairTrades: XxyyMarketTrade[] = [];
      for (const windowMs of windows) {
        const response = tradeSearchResponseSchema.parse(
          await requestJson({
            body: tradeSearchBody(pair.pairAddress, timestamp, windowMs),
            fetchImpl: input.fetchImpl,
            headers: xxyyHeaders(input.input.chain),
            maxResponseBytes: input.maxResponseBytes,
            method: 'POST',
            requestTimeoutMs: input.requestTimeoutMs,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            url: new URL('/api/data/trades/search', XXYY_MARKET_DATA_ORIGIN),
          }),
        );
        const responseTrades = response.data.map(parseMarketTrade);
        if (
          responseTrades.some((trade) =>
            identifierEquals(input.input.chain, trade.transactionId, input.input.transactionId),
          ) &&
          responseTrades.length >= pairTrades.length
        ) {
          pairTrades = responseTrades;
        }
      }
      tradesByPair.set(pair.pairAddress, pairTrades);
      for (const trade of pairTrades) {
        if (!identifierEquals(input.input.chain, trade.transactionId, input.input.transactionId)) {
          continue;
        }
        matches.push({
          pair,
          trade,
        });
      }
    } catch (error) {
      input.diagnostics.push(diagnosticFor(error, 'trade_search'));
    }
  }
  return { matches, tradesByPair };
}

function parseMarketTrade(rawTrade: z.output<typeof tradeApiSchema>): XxyyMarketTrade {
  return xxyyMarketTradeSchema.parse({
    ...(rawTrade.blockNumber === undefined ? {} : { blockNumber: String(rawTrade.blockNumber) }),
    ...(rawTrade.logIndex === undefined ? {} : { logIndex: rawTrade.logIndex }),
    maker: rawTrade.maker,
    ...(rawTrade.marketCapUSD === undefined ? {} : { marketCapUsd: rawTrade.marketCapUSD }),
    nativeAmount: rawTrade.nativeAmount,
    timestamp: rawTrade.timestamp,
    tokenAmount: rawTrade.tokenAmount,
    transactionId: rawTrade.txHash,
    type: rawTrade.type,
    ...(rawTrade.usdAmount === undefined ? {} : { usdAmount: rawTrade.usdAmount }),
  });
}

function contextTradesForMatch(
  target: XxyyMarketTrade,
  pairTrades: readonly XxyyMarketTrade[],
): XxyyContextTrade[] {
  return pairTrades
    .map((trade, displayIndex) => ({ displayIndex, trade }))
    .filter(({ trade }) => trade.transactionId !== target.transactionId)
    .map(({ displayIndex, trade }) => ({
      ...trade,
      displayIndex,
      relation: tradeRelation(target, trade),
    }))
    .sort((left, right) => {
      const distance = tradeDistance(target, left) - tradeDistance(target, right);
      return distance === 0 ? left.displayIndex - right.displayIndex : distance;
    })
    .slice(0, 6)
    .sort((left, right) => left.displayIndex - right.displayIndex);
}

function tradeDistance(target: XxyyMarketTrade, candidate: XxyyMarketTrade): number {
  if (target.blockNumber !== undefined && candidate.blockNumber !== undefined) {
    const difference = BigInt(candidate.blockNumber) - BigInt(target.blockNumber);
    const absolute = difference < 0n ? -difference : difference;
    const blockDistance = Number(
      absolute > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : absolute,
    );
    const logDistance = Math.abs((candidate.logIndex ?? 0) - (target.logIndex ?? 0));
    return blockDistance * 1_000_000 + Math.min(logDistance, 999_999);
  }
  return Math.abs(candidate.timestamp - target.timestamp);
}

function tradeRelation(
  target: XxyyMarketTrade,
  candidate: XxyyMarketTrade,
): XxyyContextTrade['relation'] {
  if (target.blockNumber !== undefined && candidate.blockNumber !== undefined) {
    const targetBlock = BigInt(target.blockNumber);
    const candidateBlock = BigInt(candidate.blockNumber);
    if (candidateBlock < targetBlock) return 'earlier';
    if (candidateBlock > targetBlock) return 'later';
    if (target.logIndex !== undefined && candidate.logIndex !== undefined) {
      if (candidate.logIndex < target.logIndex) return 'earlier';
      if (candidate.logIndex > target.logIndex) return 'later';
    }
  }
  return candidate.timestamp < target.timestamp
    ? 'earlier'
    : candidate.timestamp > target.timestamp
      ? 'later'
      : 'same_time';
}

function disambiguateMatchesByTransactionAccounts(
  input: z.output<typeof xxyyTradeLookupInputSchema>,
  matches: Array<{ pair: XxyyPairCandidate; trade: XxyyMarketTrade }>,
): Array<{ pair: XxyyPairCandidate; trade: XxyyMarketTrade }> {
  if (matches.length <= 1 || input.transactionAccountAddresses === undefined) return matches;
  const observed = new Set(
    input.transactionAccountAddresses.map((address) => normalizeIdentifier(input.chain, address)),
  );
  const onchainMatches = matches.filter((match) =>
    observed.has(normalizeIdentifier(input.chain, match.pair.pairAddress)),
  );
  return onchainMatches.length === 1 ? onchainMatches : matches;
}

function candidatePairsForTradeSearch(
  input: z.output<typeof xxyyTradeLookupInputSchema>,
  candidatePairs: readonly XxyyPairCandidate[],
): readonly XxyyPairCandidate[] {
  if (input.transactionAccountAddresses === undefined) return candidatePairs;
  const observed = new Set(
    input.transactionAccountAddresses.map((address) => normalizeIdentifier(input.chain, address)),
  );
  const observedPairs = candidatePairs.filter((pair) =>
    observed.has(normalizeIdentifier(input.chain, pair.pairAddress)),
  );
  return observedPairs.length === 0 ? candidatePairs : observedPairs;
}

async function requestJson(input: {
  body?: Record<string, unknown>;
  fetchImpl: typeof fetch;
  headers?: Record<string, string>;
  maxResponseBytes: number;
  method?: 'GET' | 'POST';
  requestTimeoutMs: number;
  signal?: AbortSignal;
  url: URL;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.requestTimeoutMs);
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await input.fetchImpl(input.url, {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers: {
        accept: 'application/json',
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...input.headers,
      },
      method: input.method ?? 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new XxyyMarketDataError('http_error', response.status >= 500);
    }
    const text = await readBoundedResponse(response, input.maxResponseBytes);
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new XxyyMarketDataError('invalid_response', false, { cause });
    }
  } catch (error) {
    if (error instanceof XxyyMarketDataError) {
      throw error;
    }
    if (input.signal?.aborted === true) {
      throw new XxyyMarketDataError('request_aborted');
    }
    if (controller.signal.aborted) {
      throw new XxyyMarketDataError('request_timeout', true);
    }
    throw new XxyyMarketDataError('transport_error', true, { cause: error });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}

function tradeSearchBody(
  pairAddress: string,
  timestamp: number | undefined,
  windowMs: number | undefined,
): Record<string, unknown> {
  return {
    makerAddress: '',
    nativeAmountEnd: '',
    nativeAmountStart: '',
    pageSize: TRADE_SEARCH_PAGE_SIZE,
    pairAddress,
    reverse: 0,
    timeEnd: timestamp === undefined || windowMs === undefined ? '' : timestamp + windowMs,
    timeStart:
      timestamp === undefined || windowMs === undefined ? '' : Math.max(0, timestamp - windowMs),
    tokenAmountEnd: '',
    tokenAmountStart: '',
    type: 'all',
    usdAmountEnd: '',
    usdAmountStart: '',
  };
}

function xxyyHeaders(chain: string): Record<string, string> {
  const route: Record<string, string> = {
    'eip155:1': 'eth',
    'eip155:56': 'bsc',
    'eip155:8453': 'base',
    'eip155:4663': 'robin',
    'eip155:988': 'stable',
    'solana:mainnet': 'sol',
  };
  const xxyyChain = route[normalizeChain(chain)];
  if (xxyyChain === undefined) {
    throw new XxyyMarketDataError('invalid_response', false);
  }
  return {
    'x-chain': xxyyChain,
    'x-language': 'zh',
    'x-version': '1',
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new XxyyMarketDataError('response_too_large');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new XxyyMarketDataError('response_too_large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function diagnosticFor(error: unknown, stage: XxyyMarketDiagnostic['stage']): XxyyMarketDiagnostic {
  if (error instanceof XxyyMarketDataError) {
    return { code: error.code, retryable: error.retryable, stage };
  }
  return { code: 'invalid_response', retryable: false, stage };
}

function normalizeChain(chain: string): string {
  const normalized = chain.trim().toLowerCase();
  const aliases: Record<string, string> = {
    base: 'eip155:8453',
    bnb: 'eip155:56',
    bsc: 'eip155:56',
    eth: 'eip155:1',
    ethereum: 'eip155:1',
    rhc: 'eip155:4663',
    robinhood: 'eip155:4663',
    sol: 'solana:mainnet',
    stable: 'eip155:988',
  };
  return aliases[normalized] ?? normalized;
}

function identifierEquals(chain: string, left: string, right: string): boolean {
  return normalizeIdentifier(chain, left) === normalizeIdentifier(chain, right);
}

function normalizeIdentifier(chain: string, value: string): string {
  return normalizeChain(chain).startsWith('eip155:') ? value.toLowerCase() : value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function createXxyyMarketDataClientStub(
  findTrade: XxyyMarketDataClient['findTrade'],
): XxyyMarketDataClient {
  return { findTrade };
}

export function emptyXxyyTradeLookupResult(): XxyyTradeLookupResult {
  return xxyyTradeLookupResultSchema.parse({
    candidatePairs: [],
    diagnostics: [],
    status: 'not_found',
  });
}
