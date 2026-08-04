import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createInMemoryQualityTracer } from '@xxyy/rag-core';

import {
  parseCapabilityManifest,
  type CapabilityAdapter,
  type CapabilityManifest,
  type CapabilitySource,
} from './capability-contract.js';
import { createDenyByDefaultCapabilityPolicy, type CapabilityGrant } from './capability-policy.js';
import {
  CapabilityAdapterSourceMismatchError,
  CapabilityInvocationAbortedError,
  CapabilityInvocationTimeoutError,
  CapabilityOutputLimitError,
  CapabilityOutputSerializationError,
  CapabilityPolicyDeniedError,
  CapabilityRegistryDuplicateIdError,
  CapabilityRegistryNotFoundError,
  createCapabilityRegistry,
  type CapabilityRegistry,
} from './capability-registry.js';

afterEach(() => {
  vi.useRealTimers();
});

function createReadManifest(
  options: {
    id?: string;
    maxOutputBytes?: number;
    source?: CapabilitySource;
    timeoutMs?: number;
    version?: string;
  } = {},
): CapabilityManifest {
  return parseCapabilityManifest({
    dataScopes: ['product.knowledge'],
    description: 'Read public product knowledge.',
    id: options.id ?? 'knowledge.search',
    idempotency: 'not_applicable',
    limits: {
      maxOutputBytes: options.maxOutputBytes ?? 4096,
      timeoutMs: options.timeoutMs ?? 1000,
    },
    requiresConfirmation: false,
    risk: 'low',
    sideEffect: 'none',
    source: options.source ?? 'builtin',
    version: options.version ?? '1.0.0',
  });
}

function createGrant(manifest: CapabilityManifest): CapabilityGrant {
  return {
    capabilityId: manifest.id,
    channels: ['web'],
    dataScopes: ['product.knowledge'],
    maxRisk: 'low',
    principals: ['user'],
    sideEffects: ['none'],
    source: manifest.source,
    version: manifest.version,
  };
}

function createAdapter(
  source: CapabilitySource,
  invoke: CapabilityAdapter['invoke'] = () => ({ ok: true }),
): CapabilityAdapter {
  return { invoke, source };
}

function registerReadCapability(
  registry: CapabilityRegistry,
  manifest: CapabilityManifest,
  adapter: CapabilityAdapter,
  options: {
    inputSchema?: z.ZodType;
    outputSchema?: z.ZodType;
  } = {},
): void {
  registry.register({
    adapter,
    inputSchema: options.inputSchema ?? z.object({ query: z.string() }),
    manifest,
    outputSchema: options.outputSchema ?? z.object({ ok: z.boolean() }),
  });
}

describe('createCapabilityRegistry catalog', () => {
  it('lists immutable manifests in stable id order without exposing adapters', () => {
    const registry = createCapabilityRegistry();
    const chainManifest = createReadManifest({ id: 'chain.inspect' });
    const knowledgeManifest = createReadManifest({ id: 'knowledge.search' });

    registerReadCapability(registry, knowledgeManifest, createAdapter('builtin'));
    registerReadCapability(registry, chainManifest, createAdapter('builtin'));

    expect(registry.list().map((manifest) => manifest.id)).toEqual([
      'chain.inspect',
      'knowledge.search',
    ]);
    expect(registry.getManifest('knowledge.search')).toStrictEqual(knowledgeManifest);
    expect(Object.isFrozen(registry.getManifest('knowledge.search'))).toBe(true);
    expect(registry.getManifest('missing.capability')).toBeUndefined();
    expect(Object.keys(registry.getManifest('knowledge.search') ?? {})).not.toContain('adapter');
  });

  it('rejects duplicate ids and adapter sources that do not match the manifest', () => {
    const registry = createCapabilityRegistry();
    const manifest = createReadManifest();
    registerReadCapability(registry, manifest, createAdapter('builtin'));

    expect(() => registerReadCapability(registry, manifest, createAdapter('builtin'))).toThrow(
      CapabilityRegistryDuplicateIdError,
    );

    const otherRegistry = createCapabilityRegistry();
    expect(() => registerReadCapability(otherRegistry, manifest, createAdapter('skill'))).toThrow(
      CapabilityAdapterSourceMismatchError,
    );
  });

  it('rejects unsafe global execution limits', () => {
    expect(() => createCapabilityRegistry({ maxTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => createCapabilityRegistry({ maxOutputBytes: 1_048_577 })).toThrow(RangeError);
  });
});

describe('createCapabilityRegistry policy and audit boundary', () => {
  it('denies by default before input validation or adapter execution', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const invoke = vi.fn<CapabilityAdapter['invoke']>(() => ({ ok: true }));
    const registry = createCapabilityRegistry({ tracer });
    const manifest = createReadManifest();
    registerReadCapability(registry, manifest, createAdapter('builtin', invoke));

    await expect(
      registry.invoke(
        manifest.id,
        { query: 42, raw: 'private input value' },
        { channel: 'web', principal: 'user', requestId: 'req-denied' },
      ),
    ).rejects.toMatchObject({
      name: 'CapabilityPolicyDeniedError',
      reason: 'no_matching_grant',
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputs: { inputFieldCount: 2, inputType: 'object' },
      metadata: {
        capabilityId: manifest.id,
        policyDecision: 'denied',
        policyReason: 'no_matching_grant',
      },
      name: 'agent.capability',
      status: 'error',
    });
    expect(JSON.stringify(records)).not.toContain('private input value');
  });

  it('executes an explicitly granted adapter with validated data and bounded trace summaries', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const manifest = createReadManifest({ source: 'skill' });
    const policy = createDenyByDefaultCapabilityPolicy([createGrant(manifest)]);
    const invoke = vi.fn<CapabilityAdapter['invoke']>(({ context, input }) => {
      expect(context.signal).toBeInstanceOf(AbortSignal);
      return { result: `answer:${String((input as { query: string }).query)}` };
    });
    const registry = createCapabilityRegistry({ policy, tracer });
    registerReadCapability(registry, manifest, createAdapter('skill', invoke), {
      inputSchema: z.object({ query: z.string().transform((value) => value.trim()) }),
      outputSchema: z.object({ result: z.string() }),
    });

    await expect(
      registry.invoke(
        manifest.id,
        { query: '  private lookup  ' },
        { channel: 'web', principal: 'user', requestId: 'req-allowed' },
      ),
    ).resolves.toEqual({ result: 'answer:private lookup' });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      capabilityId: manifest.id,
      input: { query: 'private lookup' },
      version: '1.0.0',
    });
    expect(records[0]).toMatchObject({
      inputs: { inputFieldCount: 1, inputType: 'object' },
      metadata: {
        capabilityId: manifest.id,
        policyDecision: 'allowed',
        policyReason: 'explicit_grant',
        source: 'skill',
      },
      outputs: {
        outputFieldCount: 1,
        outputType: 'object',
      },
      status: 'success',
    });
    expect(typeof records[0]?.outputs?.outputBytes).toBe('number');
    const serializedTrace = JSON.stringify(records);
    expect(serializedTrace).not.toContain('private lookup');
    expect(serializedTrace).not.toContain('answer:private lookup');
  });

  it('requires confirmation and an idempotency key before invoking an external write', async () => {
    const manifest = parseCapabilityManifest({
      dataScopes: ['wallet.private'],
      description: 'Update an external wallet setting.',
      id: 'wallet.update_setting',
      idempotency: 'required',
      limits: { maxOutputBytes: 4096, timeoutMs: 1000 },
      requiresConfirmation: true,
      risk: 'high',
      sideEffect: 'external_write',
      source: 'skill',
      version: '1.0.0',
    });
    const grant: CapabilityGrant = {
      capabilityId: manifest.id,
      channels: ['admin'],
      dataScopes: ['wallet.private'],
      maxRisk: 'high',
      principals: ['admin'],
      sideEffects: ['external_write'],
      source: 'skill',
      version: '1.0.0',
    };
    const { records, tracer } = createInMemoryQualityTracer();
    const invoke = vi.fn<CapabilityAdapter['invoke']>(({ context }) => ({
      idempotencyObserved: context.idempotencyKey !== undefined,
      updated: true,
    }));
    const registry = createCapabilityRegistry({
      policy: createDenyByDefaultCapabilityPolicy([grant]),
      tracer,
    });
    registry.register({
      adapter: createAdapter('skill', invoke),
      inputSchema: z.object({ enabled: z.boolean() }),
      manifest,
      outputSchema: z.object({ idempotencyObserved: z.boolean(), updated: z.boolean() }),
    });

    await expect(
      registry.invoke(manifest.id, { enabled: true }, { channel: 'admin', principal: 'admin' }),
    ).rejects.toMatchObject({ reason: 'confirmation_required' });
    await expect(
      registry.invoke(
        manifest.id,
        { enabled: true },
        { channel: 'admin', principal: 'admin', userConfirmed: true },
      ),
    ).rejects.toMatchObject({ reason: 'idempotency_key_required' });
    await expect(
      registry.invoke(
        manifest.id,
        { enabled: true },
        {
          channel: 'admin',
          idempotencyKey: 'private-idempotency-key-0001',
          principal: 'admin',
          userConfirmed: true,
        },
      ),
    ).resolves.toEqual({ idempotencyObserved: true, updated: true });

    expect(invoke).toHaveBeenCalledOnce();
    expect(records).toHaveLength(3);
    expect(records[2]?.metadata).toMatchObject({
      idempotencyKeyPresent: true,
      policyDecision: 'allowed',
      userConfirmed: true,
    });
    expect(JSON.stringify(records)).not.toContain('private-idempotency-key-0001');
  });

  it('does not let a custom allow policy bypass confirmation or idempotency invariants', async () => {
    const manifest = parseCapabilityManifest({
      dataScopes: ['wallet.private'],
      description: 'Submit an externally visible transaction.',
      id: 'trade.submit_transaction',
      idempotency: 'required',
      limits: { maxOutputBytes: 4096, timeoutMs: 1000 },
      requiresConfirmation: true,
      risk: 'critical',
      sideEffect: 'financial_transaction',
      source: 'skill',
      version: '1.0.0',
    });
    const invoke = vi.fn<CapabilityAdapter['invoke']>(() => ({ submitted: true }));
    const registry = createCapabilityRegistry({
      policy: { evaluate: () => ({ allowed: true, reason: 'explicit_grant' }) },
    });
    registry.register({
      adapter: createAdapter('skill', invoke),
      inputSchema: z.object({ payload: z.string() }),
      manifest,
      outputSchema: z.object({ submitted: z.boolean() }),
    });

    await expect(
      registry.invoke(
        manifest.id,
        { payload: 'unsigned' },
        { channel: 'admin', principal: 'admin' },
      ),
    ).rejects.toMatchObject({ reason: 'confirmation_required' });
    await expect(
      registry.invoke(
        manifest.id,
        { payload: 'unsigned' },
        { channel: 'admin', principal: 'admin', userConfirmed: true },
      ),
    ).rejects.toMatchObject({ reason: 'idempotency_key_required' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('audits attempts to invoke an unregistered capability without retaining input values', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createCapabilityRegistry({ tracer });

    await expect(
      registry.invoke(
        'chain.unregistered',
        { transactionHash: 'private-transaction-hash' },
        { channel: 'web', principal: 'anonymous', requestId: 'req-missing' },
      ),
    ).rejects.toBeInstanceOf(CapabilityRegistryNotFoundError);

    expect(records[0]).toMatchObject({
      inputs: { inputFieldCount: 1, inputType: 'object' },
      metadata: {
        capabilityId: 'chain.unregistered',
        policyDecision: 'denied',
        policyReason: 'not_registered',
      },
      name: 'agent.capability',
    });
    expect(JSON.stringify(records)).not.toContain('private-transaction-hash');
  });

  it('rejects malformed capability ids before creating an audit record', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    const registry = createCapabilityRegistry({ tracer });

    await expect(
      registry.invoke(
        'PRIVATE SECRET AS CAPABILITY ID',
        { value: true },
        { channel: 'web', principal: 'anonymous' },
      ),
    ).rejects.toThrow(z.ZodError);
    expect(records).toEqual([]);
  });
});

describe('createCapabilityRegistry execution bounds', () => {
  it('enforces the smaller global timeout and aborts the adapter signal', async () => {
    vi.useFakeTimers();
    const manifest = createReadManifest({ timeoutMs: 5000 });
    const policy = createDenyByDefaultCapabilityPolicy([createGrant(manifest)]);
    let adapterSignal: AbortSignal | undefined;
    const invoke = vi.fn<CapabilityAdapter['invoke']>(({ context }) => {
      adapterSignal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(new Error('adapter observed abort')),
          { once: true },
        );
      });
    });
    const registry = createCapabilityRegistry({ maxTimeoutMs: 20, policy });
    registerReadCapability(registry, manifest, createAdapter('builtin', invoke));

    const assertion = expect(
      registry.invoke(manifest.id, { query: 'status' }, { channel: 'web', principal: 'user' }),
    ).rejects.toMatchObject({
      name: 'CapabilityInvocationTimeoutError',
      timeoutMs: 20,
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;

    expect(adapterSignal?.aborted).toBe(true);
  });

  it('stops before adapter execution when the caller signal is already aborted', async () => {
    const manifest = createReadManifest();
    const policy = createDenyByDefaultCapabilityPolicy([createGrant(manifest)]);
    const invoke = vi.fn<CapabilityAdapter['invoke']>(() => new Promise(() => undefined));
    const registry = createCapabilityRegistry({ policy });
    registerReadCapability(registry, manifest, createAdapter('builtin', invoke));
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry.invoke(
        manifest.id,
        { query: 'status' },
        { channel: 'web', principal: 'user', signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(CapabilityInvocationAbortedError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('propagates active caller cancellation through the adapter signal', async () => {
    const manifest = createReadManifest();
    const policy = createDenyByDefaultCapabilityPolicy([createGrant(manifest)]);
    let adapterSignal: AbortSignal | undefined;
    const invoke = vi.fn<CapabilityAdapter['invoke']>(({ context }) => {
      adapterSignal = context.signal;
      return new Promise(() => undefined);
    });
    const registry = createCapabilityRegistry({ policy });
    registerReadCapability(registry, manifest, createAdapter('builtin', invoke));
    const controller = new AbortController();

    const assertion = expect(
      registry.invoke(
        manifest.id,
        { query: 'status' },
        { channel: 'web', principal: 'user', signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(CapabilityInvocationAbortedError);
    controller.abort();
    await assertion;

    expect(adapterSignal?.aborted).toBe(true);
  });

  it('rejects validated output larger than the effective byte limit', async () => {
    const manifest = createReadManifest({ maxOutputBytes: 4096 });
    const policy = createDenyByDefaultCapabilityPolicy([createGrant(manifest)]);
    const registry = createCapabilityRegistry({ maxOutputBytes: 32, policy });
    registerReadCapability(
      registry,
      manifest,
      createAdapter('builtin', () => ({ result: 'x'.repeat(100) })),
      { outputSchema: z.object({ result: z.string() }) },
    );

    await expect(
      registry.invoke(manifest.id, { query: 'status' }, { channel: 'web', principal: 'user' }),
    ).rejects.toMatchObject({
      maxOutputBytes: 32,
      name: 'CapabilityOutputLimitError',
    });
  });

  it('rejects schema-invalid and non-JSON-serializable adapter outputs', async () => {
    const manifest = createReadManifest();
    const policy = createDenyByDefaultCapabilityPolicy([createGrant(manifest)]);
    const invalidRegistry = createCapabilityRegistry({ policy });
    registerReadCapability(
      invalidRegistry,
      manifest,
      createAdapter('builtin', () => ({ ok: 'yes' })),
    );

    await expect(
      invalidRegistry.invoke(
        manifest.id,
        { query: 'status' },
        { channel: 'web', principal: 'user' },
      ),
    ).rejects.toThrow(z.ZodError);

    const serializationRegistry = createCapabilityRegistry({ policy });
    registerReadCapability(
      serializationRegistry,
      manifest,
      createAdapter('builtin', () => 1n),
      { outputSchema: z.unknown() },
    );
    await expect(
      serializationRegistry.invoke(
        manifest.id,
        { query: 'status' },
        { channel: 'web', principal: 'user' },
      ),
    ).rejects.toBeInstanceOf(CapabilityOutputSerializationError);
  });

  it('exposes stable error classes for policy, timeout, and output limits', () => {
    expect(new CapabilityPolicyDeniedError('knowledge.search', 'no_matching_grant')).toBeInstanceOf(
      Error,
    );
    expect(new CapabilityInvocationTimeoutError('knowledge.search', 10)).toBeInstanceOf(Error);
    expect(new CapabilityOutputLimitError('knowledge.search', 11, 10)).toBeInstanceOf(Error);
  });
});
