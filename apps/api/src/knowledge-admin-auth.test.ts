import { describe, expect, it } from 'vitest';

import {
  createKnowledgeAdminAuthenticator,
  createKnowledgeAdminToken,
  hashKnowledgeAdminToken,
  hasKnowledgeAdminPermission,
} from './knowledge-admin-auth.js';

describe('knowledge admin authentication', () => {
  it('fails closed when no administrators are configured', () => {
    const authenticator = createKnowledgeAdminAuthenticator(undefined);

    expect(authenticator.configured).toBe(false);
    expect(authenticator.authenticate('Bearer any-token-with-enough-characters')).toBeUndefined();
  });

  it('authenticates a high-entropy bearer token by its hash', () => {
    const token = 'admin-test-token-with-at-least-24-characters';
    const authenticator = createKnowledgeAdminAuthenticator(
      JSON.stringify([
        {
          displayName: 'Alice',
          id: 'alice',
          role: 'publisher',
          tokenHash: hashKnowledgeAdminToken(token),
        },
      ]),
    );

    expect(authenticator.authenticate(`Bearer ${token}`)).toEqual({
      displayName: 'Alice',
      id: 'alice',
      role: 'publisher',
    });
    expect(
      authenticator.authenticate('Bearer wrong-token-with-at-least-24-characters'),
    ).toBeUndefined();
    expect(authenticator.authenticate(`Basic ${token}`)).toBeUndefined();
  });

  it('enforces the reviewer, publisher, and administrator permission boundary', () => {
    const reviewer = { displayName: 'R', id: 'reviewer', role: 'reviewer' as const };
    const publisher = { displayName: 'P', id: 'publisher', role: 'publisher' as const };
    const admin = { displayName: 'A', id: 'admin', role: 'admin' as const };

    expect(hasKnowledgeAdminPermission(reviewer, 'candidate:review')).toBe(true);
    expect(hasKnowledgeAdminPermission(reviewer, 'support:manage')).toBe(true);
    expect(hasKnowledgeAdminPermission(reviewer, 'publication:request')).toBe(false);
    expect(hasKnowledgeAdminPermission({ ...reviewer, role: 'viewer' }, 'support:read')).toBe(true);
    expect(hasKnowledgeAdminPermission(publisher, 'publication:request')).toBe(true);
    expect(hasKnowledgeAdminPermission(publisher, 'trusted_author:manage')).toBe(false);
    expect(hasKnowledgeAdminPermission(admin, 'trusted_author:manage')).toBe(true);
  });

  it('generates a token only returned in plaintext once', () => {
    const generated = createKnowledgeAdminToken();

    expect(generated.token.length).toBeGreaterThanOrEqual(24);
    expect(generated.tokenHash).toBe(hashKnowledgeAdminToken(generated.token));
    expect(generated.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects malformed or duplicate administrator configuration', () => {
    expect(() => createKnowledgeAdminAuthenticator('{')).toThrow('must be valid JSON');
    expect(() =>
      createKnowledgeAdminAuthenticator(
        JSON.stringify([
          { id: 'alice', role: 'viewer', tokenHash: '0'.repeat(64) },
          { id: 'alice', role: 'viewer', tokenHash: '1'.repeat(64) },
        ]),
      ),
    ).toThrow('duplicated');
    expect(() =>
      createKnowledgeAdminAuthenticator(
        JSON.stringify([
          { id: 'alice', role: 'viewer', tokenHash: '0'.repeat(64) },
          { id: 'bob', role: 'admin', tokenHash: '0'.repeat(64) },
        ]),
      ),
    ).toThrow('reuses');
  });
});
