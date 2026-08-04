import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  parseCapabilityManifest,
  type CapabilityInvocationContext,
} from './capability-contract.js';
import { createDenyByDefaultCapabilityPolicy, type CapabilityGrant } from './capability-policy.js';

const publicReadManifest = parseCapabilityManifest({
  dataScopes: ['chain.public'],
  description: 'Read public chain data without taking action.',
  id: 'chain.inspect_transaction',
  idempotency: 'not_applicable',
  limits: { maxOutputBytes: 32_768, timeoutMs: 5_000 },
  requiresConfirmation: false,
  risk: 'moderate',
  sideEffect: 'external_read',
  source: 'builtin',
  version: '1.0.0',
});

const webUserContext: CapabilityInvocationContext = {
  channel: 'web',
  principal: 'user',
  requestId: 'req-policy-1',
};

const publicReadGrant: CapabilityGrant = {
  capabilityId: publicReadManifest.id,
  channels: ['web'],
  dataScopes: ['chain.public'],
  maxRisk: 'moderate',
  principals: ['user'],
  sideEffects: ['external_read'],
  source: 'builtin',
  version: '1.0.0',
};

describe('capability manifest', () => {
  it('parses and freezes a namespace-qualified, versioned manifest', () => {
    expect(publicReadManifest).toMatchObject({
      id: 'chain.inspect_transaction',
      source: 'builtin',
      version: '1.0.0',
    });
    expect(Object.isFrozen(publicReadManifest)).toBe(true);
    expect(Object.isFrozen(publicReadManifest.dataScopes)).toBe(true);
    expect(Object.isFrozen(publicReadManifest.limits)).toBe(true);
  });

  it('rejects malformed ids, duplicate data scopes, and unknown manifest fields', () => {
    const base = {
      dataScopes: ['chain.public'],
      description: 'Read chain data.',
      id: 'chain.inspect',
      idempotency: 'not_applicable',
      limits: { maxOutputBytes: 1024, timeoutMs: 1000 },
      requiresConfirmation: false,
      risk: 'low',
      sideEffect: 'external_read',
      source: 'builtin',
      version: '1.0.0',
    } as const;

    expect(() => parseCapabilityManifest({ ...base, id: 'InspectTransaction' })).toThrow(
      z.ZodError,
    );
    expect(() =>
      parseCapabilityManifest({ ...base, dataScopes: ['chain.public', 'chain.public'] }),
    ).toThrow(z.ZodError);
    expect(() => parseCapabilityManifest({ ...base, undeclared: true })).toThrow(z.ZodError);
  });

  it('requires confirmation and idempotency for every state-changing capability', () => {
    const base = {
      dataScopes: ['wallet.private'],
      description: 'Change an external wallet setting.',
      id: 'wallet.update_setting',
      limits: { maxOutputBytes: 1024, timeoutMs: 1000 },
      risk: 'high',
      sideEffect: 'external_write',
      source: 'skill',
      version: '1.0.0',
    } as const;

    expect(() =>
      parseCapabilityManifest({
        ...base,
        idempotency: 'optional',
        requiresConfirmation: false,
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      parseCapabilityManifest({
        ...base,
        idempotency: 'required',
        requiresConfirmation: false,
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      parseCapabilityManifest({
        ...base,
        idempotency: 'optional',
        requiresConfirmation: true,
      }),
    ).toThrow(z.ZodError);
  });

  it('requires high or critical risk for financial transaction capabilities', () => {
    expect(() =>
      parseCapabilityManifest({
        dataScopes: ['wallet.private'],
        description: 'Submit a transaction.',
        id: 'trade.submit_transaction',
        idempotency: 'required',
        limits: { maxOutputBytes: 1024, timeoutMs: 1000 },
        requiresConfirmation: true,
        risk: 'moderate',
        sideEffect: 'financial_transaction',
        source: 'skill',
        version: '1.0.0',
      }),
    ).toThrow(z.ZodError);
  });
});

describe('createDenyByDefaultCapabilityPolicy', () => {
  it('denies every capability when no explicit grant exists', () => {
    expect(
      createDenyByDefaultCapabilityPolicy().evaluate(publicReadManifest, webUserContext),
    ).toEqual({ allowed: false, reason: 'no_matching_grant' });
  });

  it('allows only an exact id, version, source, channel, principal, side effect, and data scope grant', () => {
    const policy = createDenyByDefaultCapabilityPolicy([publicReadGrant]);

    expect(policy.evaluate(publicReadManifest, webUserContext)).toEqual({
      allowed: true,
      reason: 'explicit_grant',
    });
    expect(policy.evaluate(publicReadManifest, { ...webUserContext, channel: 'telegram' })).toEqual(
      { allowed: false, reason: 'no_matching_grant' },
    );
    expect(
      policy.evaluate(publicReadManifest, { ...webUserContext, principal: 'anonymous' }),
    ).toEqual({ allowed: false, reason: 'no_matching_grant' });
  });

  it('rejects grants with stale versions or insufficient source, risk, effect, or data scope coverage', () => {
    const insufficientGrants: CapabilityGrant[] = [
      { ...publicReadGrant, version: '1.0.1' },
      { ...publicReadGrant, source: 'skill' },
      { ...publicReadGrant, maxRisk: 'low' },
      { ...publicReadGrant, sideEffects: ['none'] },
      { ...publicReadGrant, dataScopes: ['market.public'] },
    ];

    for (const grant of insufficientGrants) {
      expect(
        createDenyByDefaultCapabilityPolicy([grant]).evaluate(publicReadManifest, webUserContext),
      ).toEqual({ allowed: false, reason: 'no_matching_grant' });
    }
  });

  it('checks confirmation and idempotency only after a matching grant', () => {
    const writeManifest = parseCapabilityManifest({
      dataScopes: ['wallet.private'],
      description: 'Update an external wallet setting.',
      id: 'wallet.update_setting',
      idempotency: 'required',
      limits: { maxOutputBytes: 4096, timeoutMs: 2000 },
      requiresConfirmation: true,
      risk: 'high',
      sideEffect: 'external_write',
      source: 'skill',
      version: '2.1.0',
    });
    const grant: CapabilityGrant = {
      capabilityId: writeManifest.id,
      channels: ['admin'],
      dataScopes: ['wallet.private'],
      maxRisk: 'high',
      principals: ['admin'],
      sideEffects: ['external_write'],
      source: 'skill',
      version: '2.1.0',
    };
    const policy = createDenyByDefaultCapabilityPolicy([grant]);

    expect(policy.evaluate(writeManifest, webUserContext)).toEqual({
      allowed: false,
      reason: 'no_matching_grant',
    });
    expect(policy.evaluate(writeManifest, { channel: 'admin', principal: 'admin' })).toEqual({
      allowed: false,
      reason: 'confirmation_required',
    });
    expect(
      policy.evaluate(writeManifest, {
        channel: 'admin',
        principal: 'admin',
        userConfirmed: true,
      }),
    ).toEqual({ allowed: false, reason: 'idempotency_key_required' });
    expect(
      policy.evaluate(writeManifest, {
        channel: 'admin',
        idempotencyKey: 'setting-change-0001',
        principal: 'admin',
        userConfirmed: true,
      }),
    ).toEqual({ allowed: true, reason: 'explicit_grant' });
  });
});
