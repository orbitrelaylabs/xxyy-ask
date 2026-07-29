import { readFile } from 'node:fs/promises';

import { decimalToRpcQuantity } from '@xxyy/evm-data-adapter';
import { enrichEvmExecution } from '@xxyy/evm-execution-enrichment-core';
import { describe, expect, it } from 'vitest';

import {
  POOL_FACTORY_SELECTOR,
  POOL_TOKEN0_SELECTOR,
  POOL_TOKEN1_SELECTOR,
  UNISWAP_V2_GET_PAIR_SELECTOR,
  UNISWAP_V3_FEE_SELECTOR,
  UNISWAP_V3_GET_POOL_SELECTOR,
  type EvmExecutionChainConfig,
} from './contracts.js';
import { createEvmExecutionDataAdapter } from './evm-execution-data-adapter.js';
import { EvmExecutionDataAdapterConfigurationError } from './errors.js';

const transactionHash = `0x${'a'.repeat(64)}`;
const blockNumber = '19000000';
const fixedNow = () => new Date('2026-07-22T00:00:00.000Z');

interface ReplayPool {
  code: string;
  factoryAddress: string;
  factoryCode: string;
  fee?: string;
  poolAddress: string;
  protocol: 'uniswap_v2' | 'uniswap_v3';
  token0: string;
  token1: string;
}

interface ReplayFixture {
  chainId: string;
  pools: ReplayPool[];
  trace: unknown;
}

interface WireCall {
  id: number;
  jsonrpc: string;
  method: string;
  params: unknown[];
}

interface CapturedRequest {
  calls: WireCall[];
  host: string;
}

async function loadFixture(name: string): Promise<ReplayFixture> {
  return JSON.parse(
    await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as ReplayFixture;
}

function cloneFixture(fixture: ReplayFixture): ReplayFixture {
  return JSON.parse(JSON.stringify(fixture)) as ReplayFixture;
}

function createReplayFetch(
  fixtures: ReadonlyMap<string, ReplayFixture>,
  options: {
    factoryMismatchHosts?: ReadonlySet<string>;
    traceRpcErrorHosts?: ReadonlySet<string>;
    transportFailureHosts?: ReadonlySet<string>;
  } = {},
): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (request, init) => {
    const host = new URL(fetchInputUrl(request)).host;
    const calls = parseWireCalls(init);
    requests.push({ calls, host });
    if (options.transportFailureHosts?.has(host) === true) {
      return Promise.reject(new TypeError('offline with private provider detail'));
    }
    const fixture = fixtures.get(host);
    if (fixture === undefined) {
      return Promise.reject(new Error(`Missing replay fixture for ${host}.`));
    }
    const responses = calls
      .map((call) =>
        call.method === 'debug_traceTransaction' && options.traceRpcErrorHosts?.has(host) === true
          ? {
              error: { code: -32_000, message: 'private trace provider detail' },
              id: call.id,
              jsonrpc: '2.0',
            }
          : {
              id: call.id,
              jsonrpc: '2.0',
              result: replayResult(call, fixture, options.factoryMismatchHosts?.has(host) === true),
            },
      )
      .reverse();
    return Promise.resolve(new Response(JSON.stringify(responses), { status: 200 }));
  };
  return { fetchImpl, requests };
}

function replayResult(call: WireCall, fixture: ReplayFixture, factoryMismatch: boolean): unknown {
  if (call.method === 'eth_chainId') {
    return fixture.chainId;
  }
  if (call.method === 'debug_traceTransaction') {
    return fixture.trace;
  }
  if (call.method === 'eth_getCode') {
    const address = call.params[0];
    if (typeof address !== 'string') {
      throw new Error('Expected eth_getCode address.');
    }
    const pool = fixture.pools.find((candidate) => candidate.poolAddress === address);
    if (pool !== undefined) {
      return pool.code;
    }
    const factory = fixture.pools.find((candidate) => candidate.factoryAddress === address);
    if (factory !== undefined) {
      return factory.factoryCode;
    }
    return '0x';
  }
  if (call.method !== 'eth_call') {
    throw new Error(`Unexpected replay method: ${call.method}`);
  }
  const request = call.params[0];
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new Error('Expected eth_call request.');
  }
  const data = (request as Record<string, unknown>).data;
  const to = (request as Record<string, unknown>).to;
  if (typeof data !== 'string' || typeof to !== 'string') {
    throw new Error('Expected eth_call data and target.');
  }
  const pool = fixture.pools.find((candidate) => candidate.poolAddress === to);
  if (pool !== undefined) {
    if (data === POOL_FACTORY_SELECTOR) {
      return encodeAddress(pool.factoryAddress);
    }
    if (data === POOL_TOKEN0_SELECTOR) {
      return encodeAddress(pool.token0);
    }
    if (data === POOL_TOKEN1_SELECTOR) {
      return encodeAddress(pool.token1);
    }
    if (data === UNISWAP_V3_FEE_SELECTOR && pool.fee !== undefined) {
      return encodeUint(pool.fee);
    }
    throw new Error(`Unexpected pool selector: ${data}`);
  }
  const factoryPool = fixture.pools.find((candidate) => candidate.factoryAddress === to);
  if (
    factoryPool !== undefined &&
    (data.startsWith(UNISWAP_V2_GET_PAIR_SELECTOR) || data.startsWith(UNISWAP_V3_GET_POOL_SELECTOR))
  ) {
    return encodeAddress(
      factoryMismatch ? '0xcccccccccccccccccccccccccccccccccccccccc' : factoryPool.poolAddress,
    );
  }
  throw new Error(`Unexpected factory call target: ${to}`);
}

function parseWireCalls(init: RequestInit | undefined): WireCall[] {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected a JSON-RPC request body.');
  }
  const payload = JSON.parse(init.body) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error('Expected a JSON-RPC batch.');
  }
  return payload as WireCall[];
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function encodeAddress(address: string): string {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function encodeUint(value: string): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function providers(ids: readonly string[]): EvmExecutionChainConfig['providers'] {
  return ids.map((id) => ({
    endpoint: `https://${id.replaceAll('_', '-')}.example/private?token=query-secret`,
    id,
  }));
}

function createAdapter(
  fetchImpl: typeof fetch,
  fixture: ReplayFixture,
  providerIds: readonly string[] = ['rpc_primary'],
  factoryOverrides?: EvmExecutionChainConfig['factories'],
) {
  const v2Factory = fixture.pools.find((pool) => pool.protocol === 'uniswap_v2')?.factoryAddress;
  const v3Factory = fixture.pools.find((pool) => pool.protocol === 'uniswap_v3')?.factoryAddress;
  return createEvmExecutionDataAdapter({
    chains: [
      {
        chainId: '1',
        factories: factoryOverrides ?? {
          uniswapV2: v2Factory === undefined ? [] : [v2Factory],
          uniswapV3: v3Factory === undefined ? [] : [v3Factory],
        },
        providers: providers(providerIds),
      },
    ],
    fetchImpl,
    maxRetries: 0,
    now: fixedNow,
  });
}

function requestFor(fixture: ReplayFixture, pools = fixture.pools) {
  return {
    blockNumber,
    chainId: '1',
    pools: pools.map((pool) => ({
      poolAddress: pool.poolAddress,
      protocol: pool.protocol,
    })),
    transactionHash,
  } as const;
}

describe('EVM execution data adapter replay contract', () => {
  it('loads a bounded trace and factory-verified V2/V3 metadata at the exact block', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(new Map([['rpc-primary.example', fixture]]));
    const adapter = createAdapter(replay.fetchImpl, fixture);

    expect(adapter.listConfiguredChains()).toEqual([
      {
        chainId: '1',
        protocols: ['uniswap_v2', 'uniswap_v3'],
        providerIds: ['rpc_primary'],
      },
    ]);
    expect(JSON.stringify(adapter.listConfiguredChains())).not.toContain('query-secret');

    const first = await adapter.loadExecutionData(requestFor(fixture));
    const second = await adapter.loadExecutionData(requestFor(fixture));

    expect(first).toEqual(second);
    expect(first.status).toBe('success');
    expect(first.diagnostics).toEqual([]);
    expect(first.conflicts).toEqual([]);
    expect(first.trace?.nodes).toHaveLength(5);
    expect(first.poolMetadata).toHaveLength(2);
    expect(first.verifiedPools).toEqual([
      expect.objectContaining({
        factoryAddress: fixture.pools[0]?.factoryAddress,
        poolAddress: fixture.pools[0]?.poolAddress,
        protocol: 'uniswap_v2',
        token0: fixture.pools[0]?.token0,
        token1: fixture.pools[0]?.token1,
      }),
      expect.objectContaining({
        factoryAddress: fixture.pools[1]?.factoryAddress,
        fee: '3000',
        poolAddress: fixture.pools[1]?.poolAddress,
        protocol: 'uniswap_v3',
      }),
    ]);
    expect(first.verifiedPools[0]?.poolCodeHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.verifiedPools[0]?.source.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(first)).not.toContain('private provider detail');
    expect(replay.requests).toHaveLength(12);

    const metadataRequests = replay.requests.filter((request) =>
      request.calls.some((call) => call.method === 'eth_call' || call.method === 'eth_getCode'),
    );
    expect(metadataRequests).toHaveLength(8);
    for (const request of metadataRequests) {
      for (const call of request.calls) {
        expect(call.params.at(-1)).toBe(decimalToRpcQuantity(blockNumber));
        expect(['eth_call', 'eth_getCode']).toContain(call.method);
      }
    }
    const lookupData = metadataRequests
      .flatMap((request) => request.calls)
      .filter((call) => call.method === 'eth_call')
      .map((call) => (call.params[0] as { data: string }).data ?? '')
      .filter(
        (data) =>
          data.startsWith(UNISWAP_V2_GET_PAIR_SELECTOR) ||
          data.startsWith(UNISWAP_V3_GET_POOL_SELECTOR),
      );
    expect(lookupData).toHaveLength(4);
    expect(
      lookupData.filter((data) => data.startsWith(UNISWAP_V2_GET_PAIR_SELECTOR))[0],
    ).toHaveLength(138);
    expect(
      lookupData.filter((data) => data.startsWith(UNISWAP_V3_GET_POOL_SELECTOR))[0],
    ).toHaveLength(202);
  });

  it('feeds the enrichment core without a conversion layer', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(new Map([['rpc-primary.example', fixture]]));
    const adapter = createAdapter(replay.fetchImpl, fixture);
    const data = await adapter.loadExecutionData(requestFor(fixture));
    const source = {
      id: 'rpc_primary',
      kind: 'rpc' as const,
      observedAt: '2026-07-22T00:00:00.000Z',
      payloadHash: `sha256:${'f'.repeat(64)}`,
      url: 'https://rpc-primary.example',
    };

    const enrichment = enrichEvmExecution({
      poolMetadata: data.poolMetadata,
      snapshot: {
        chainId: '1',
        observedAt: source.observedAt,
        receipt: {
          blockNumber,
          effectiveGasPrice: '1',
          gasUsed: '100000',
          logs: [],
          sourceId: source.id,
          status: 'success',
          transactionHash,
          transactionIndex: 1,
        },
        requestedTransactionHash: transactionHash,
        sources: [source],
        transaction: {
          blockNumber,
          from: '0x1111111111111111111111111111111111111111',
          hash: transactionHash,
          input: '0xabcdef',
          nonce: '1',
          sourceId: source.id,
          to: '0x2222222222222222222222222222222222222222',
          transactionIndex: 1,
          value: '0',
        },
      },
      trace: data.trace,
    });

    expect(enrichment.coverage.trace).toBe('available');
    expect(enrichment.coverage.traceNodeCount).toBe(5);
    expect(enrichment.internalTransfers.map((transfer) => transfer.amountWei)).toEqual(['2', '5']);
  });

  it('does not create conflicts for semantically equal providers', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(
      new Map([
        ['rpc-a.example', fixture],
        ['rpc-b.example', fixture],
      ]),
    );
    const adapter = createAdapter(replay.fetchImpl, fixture, ['rpc_a', 'rpc_b']);

    const result = await adapter.loadExecutionData(requestFor(fixture, [fixture.pools[0]!]));

    expect(result.status).toBe('success');
    expect(result.conflicts).toEqual([]);
    expect(result.trace?.source.id).toBe('rpc_a');
    expect(result.poolMetadata[0]?.source.id).toBe('rpc_a');
  });

  it('preserves trace and pool conflicts while selecting canonical data by config order', async () => {
    const success = await loadFixture('provider-success');
    const conflict = await loadFixture('provider-conflict');
    const replay = createReplayFetch(
      new Map([
        ['rpc-a.example', success],
        ['rpc-b.example', conflict],
      ]),
    );
    const adapter = createAdapter(replay.fetchImpl, success, ['rpc_a', 'rpc_b']);

    const result = await adapter.loadExecutionData({
      ...requestFor(success, [success.pools[1]!]),
      providerIds: ['rpc_b', 'rpc_a'],
    });

    expect(result.status).toBe('partial');
    expect(result.diagnostics).toEqual([]);
    expect(result.trace?.source.id).toBe('rpc_a');
    expect(result.poolMetadata[0]?.source.id).toBe('rpc_a');
    expect(result.conflicts.map((entry) => entry.field)).toEqual(['trace', 'pool_metadata']);
    expect(result.conflicts[0]?.observations.map((entry) => entry.providerId)).toEqual([
      'rpc_a',
      'rpc_b',
    ]);
  });

  it('fails a wrong-chain provider closed before any metadata request', async () => {
    const fixture = await loadFixture('provider-success');
    const wrongChain = cloneFixture(fixture);
    wrongChain.chainId = '0x2';
    const replay = createReplayFetch(new Map([['rpc-primary.example', wrongChain]]));
    const adapter = createAdapter(replay.fetchImpl, fixture);

    const result = await adapter.loadExecutionData(requestFor(fixture));

    expect(result.status).toBe('insufficient_data');
    expect(result.trace).toBeUndefined();
    expect(result.poolMetadata).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        attempts: 1,
        code: 'chain_id_mismatch',
        operation: 'chain_id',
        providerId: 'rpc_primary',
        retryable: false,
      },
    ]);
    expect(replay.requests).toHaveLength(1);
  });

  it('keeps a healthy provider when another provider transport fails', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(
      new Map([
        ['rpc-a.example', fixture],
        ['rpc-b.example', fixture],
      ]),
      { transportFailureHosts: new Set(['rpc-a.example']) },
    );
    const adapter = createAdapter(replay.fetchImpl, fixture, ['rpc_a', 'rpc_b']);

    const result = await adapter.loadExecutionData(requestFor(fixture, []));

    expect(result.status).toBe('partial');
    expect(result.trace?.source.id).toBe('rpc_b');
    expect(result.diagnostics).toEqual([
      {
        attempts: 1,
        code: 'transport_error',
        operation: 'chain_id',
        providerId: 'rpc_a',
        retryable: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });

  it('keeps verified pool metadata when the same provider cannot return a trace', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(new Map([['rpc-primary.example', fixture]]), {
      traceRpcErrorHosts: new Set(['rpc-primary.example']),
    });
    const adapter = createAdapter(replay.fetchImpl, fixture);

    const result = await adapter.loadExecutionData(requestFor(fixture, [fixture.pools[0]!]));

    expect(result.status).toBe('partial');
    expect(result.trace).toBeUndefined();
    expect(result.poolMetadata).toHaveLength(1);
    expect(result.diagnostics).toEqual([
      {
        attempts: 1,
        code: 'rpc_error',
        operation: 'trace',
        providerId: 'rpc_primary',
        retryable: false,
        rpcCode: -32_000,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('private trace provider detail');
  });

  it('uses a configured Blockscout trace without invoking debug RPC and marks it partial', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(new Map([['rpc-primary.example', fixture]]));
    const explorerRequests: string[] = [];
    const fetchImpl: typeof fetch = (request, init) => {
      const url = new URL(fetchInputUrl(request));
      if (url.host === 'blockscout.example') {
        explorerRequests.push(url.href);
        expect(init?.method).toBe('GET');
        return Promise.resolve(new Response(JSON.stringify(fixture.trace), { status: 200 }));
      }
      return replay.fetchImpl(request, init);
    };
    const adapter = createEvmExecutionDataAdapter({
      chains: [
        {
          chainId: '1',
          factories: { uniswapV2: [], uniswapV3: [] },
          providers: [
            {
              endpoint: 'https://rpc-primary.example/private?token=query-secret',
              id: 'rpc_primary',
              traceSource: {
                endpoint: 'https://blockscout.example',
                id: 'blockscout_public',
                kind: 'blockscout_v2',
              },
            },
          ],
        },
      ],
      fetchImpl,
      maxRetries: 0,
      now: fixedNow,
    });

    const result = await adapter.loadExecutionData(requestFor(fixture, []));

    expect(result.status).toBe('partial');
    expect(result.trace?.nodes).toHaveLength(5);
    expect(result.trace?.source).toMatchObject({
      id: 'blockscout_public',
      kind: 'explorer',
    });
    expect(result.diagnostics).toEqual([
      {
        attempts: 1,
        code: 'explorer_trace_partial_evidence',
        operation: 'trace',
        providerId: 'blockscout_public',
        retryable: false,
      },
    ]);
    expect(explorerRequests).toEqual([
      `https://blockscout.example/api/v2/transactions/${transactionHash}/raw-trace`,
    ]);
    expect(replay.requests.flatMap((request) => request.calls.map((call) => call.method))).toEqual([
      'eth_chainId',
    ]);
    expect(JSON.stringify(result)).not.toContain('query-secret');
  });

  it('rejects a pool whose self-reported factory is not allowlisted', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(new Map([['rpc-primary.example', fixture]]));
    const adapter = createAdapter(replay.fetchImpl, fixture, ['rpc_primary'], {
      uniswapV2: ['0x9999999999999999999999999999999999999999'],
      uniswapV3: [fixture.pools[1]!.factoryAddress],
    });

    const result = await adapter.loadExecutionData(requestFor(fixture, [fixture.pools[0]!]));

    expect(result.status).toBe('partial');
    expect(result.poolMetadata).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'pool_factory_not_allowed',
        operation: 'pool_factory',
        poolAddress: fixture.pools[0]?.poolAddress,
      }),
    ]);
    expect(replay.requests).toHaveLength(3);
  });

  it('rejects a spoofed pool when the allowlisted factory lookup does not map back', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(new Map([['rpc-primary.example', fixture]]), {
      factoryMismatchHosts: new Set(['rpc-primary.example']),
    });
    const adapter = createAdapter(replay.fetchImpl, fixture);

    const result = await adapter.loadExecutionData(requestFor(fixture, [fixture.pools[1]!]));

    expect(result.status).toBe('partial');
    expect(result.poolMetadata).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'factory_lookup_mismatch',
        operation: 'factory_lookup',
      }),
    ]);
    expect(replay.requests).toHaveLength(4);
  });

  it('rejects V3 fees outside the canonical factory range before factory lookup', async () => {
    const fixture = await loadFixture('provider-success');
    const invalidFee = cloneFixture(fixture);
    invalidFee.pools[1]!.fee = '1000000';
    const replay = createReplayFetch(new Map([['rpc-primary.example', invalidFee]]));
    const adapter = createAdapter(replay.fetchImpl, fixture);

    const result = await adapter.loadExecutionData(requestFor(fixture, [fixture.pools[1]!]));

    expect(result.status).toBe('partial');
    expect(result.poolMetadata).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'pool_fee_invalid', operation: 'pool_fee' }),
    ]);
    expect(replay.requests).toHaveLength(3);
  });

  it('skips metadata RPC when a requested protocol has no startup factory allowlist', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(new Map([['rpc-primary.example', fixture]]));
    const adapter = createAdapter(replay.fetchImpl, fixture, ['rpc_primary'], {
      uniswapV2: [],
      uniswapV3: [fixture.pools[1]!.factoryAddress],
    });

    const result = await adapter.loadExecutionData(requestFor(fixture, [fixture.pools[0]!]));

    expect(result.status).toBe('partial');
    expect(result.diagnostics).toEqual([
      {
        code: 'pool_protocol_not_configured',
        poolAddress: fixture.pools[0]?.poolAddress,
        retryable: false,
      },
    ]);
    expect(replay.requests).toHaveLength(2);
  });

  it('enforces the deployment pool-count limit before network access', async () => {
    const fixture = await loadFixture('provider-success');
    const replay = createReplayFetch(new Map([['rpc-primary.example', fixture]]));
    const adapter = createEvmExecutionDataAdapter({
      chains: [
        {
          chainId: '1',
          factories: { uniswapV2: [fixture.pools[0]!.factoryAddress], uniswapV3: [] },
          providers: providers(['rpc_primary']),
        },
      ],
      fetchImpl: replay.fetchImpl,
      maxPoolCandidates: 0,
      now: fixedNow,
    });

    await expect(
      adapter.loadExecutionData(requestFor(fixture, [fixture.pools[0]!])),
    ).rejects.toBeInstanceOf(EvmExecutionDataAdapterConfigurationError);
    expect(replay.requests).toEqual([]);
  });
});
