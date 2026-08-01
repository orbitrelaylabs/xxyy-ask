import { describe, expect, it } from 'vitest';

import {
  hasKnowledgeAdminPermission,
  readKnowledgeAdminBearerToken,
} from './knowledge-admin-auth.js';

describe('knowledge admin authorization', () => {
  it('enforces reviewer, publisher, administrator, and viewer permissions', () => {
    const reviewer = { displayName: 'R', id: 'reviewer', role: 'reviewer' as const };
    const publisher = { displayName: 'P', id: 'publisher', role: 'publisher' as const };
    const admin = { displayName: 'A', id: 'admin', role: 'admin' as const };

    expect(hasKnowledgeAdminPermission(reviewer, 'candidate:review')).toBe(true);
    expect(hasKnowledgeAdminPermission(reviewer, 'support:manage')).toBe(true);
    expect(hasKnowledgeAdminPermission(reviewer, 'publication:request')).toBe(false);
    expect(hasKnowledgeAdminPermission({ ...reviewer, role: 'viewer' }, 'support:read')).toBe(true);
    expect(
      hasKnowledgeAdminPermission({ ...reviewer, role: 'viewer' }, 'telegram_group:read'),
    ).toBe(true);
    expect(hasKnowledgeAdminPermission(publisher, 'publication:request')).toBe(true);
    expect(hasKnowledgeAdminPermission(publisher, 'quality:run')).toBe(true);
    expect(hasKnowledgeAdminPermission(reviewer, 'quality:run')).toBe(false);
    expect(hasKnowledgeAdminPermission({ ...reviewer, role: 'viewer' }, 'quality:read')).toBe(true);
    expect(hasKnowledgeAdminPermission(publisher, 'quality:baseline')).toBe(false);
    expect(hasKnowledgeAdminPermission(admin, 'quality:baseline')).toBe(true);
    expect(hasKnowledgeAdminPermission(publisher, 'user:manage')).toBe(false);
    expect(hasKnowledgeAdminPermission(admin, 'user:manage')).toBe(true);
  });

  it('accepts only bounded database session bearer tokens', () => {
    const token = 'a'.repeat(43);

    expect(readKnowledgeAdminBearerToken(`Bearer ${token}`)).toBe(token);
    expect(readKnowledgeAdminBearerToken(`Basic ${token}`)).toBeUndefined();
    expect(readKnowledgeAdminBearerToken('Bearer short')).toBeUndefined();
  });
});
