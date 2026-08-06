import type { KnowledgeAdminPrincipal, KnowledgeAdminRole } from '@xxyy/rag-core';

export type { KnowledgeAdminPrincipal, KnowledgeAdminRole };

export type KnowledgeAdminPermission =
  | 'candidate:read'
  | 'candidate:review'
  | 'import:telegram'
  | 'publication:request'
  | 'quality:baseline'
  | 'quality:read'
  | 'quality:run'
  | 'observability:read'
  | 'support:manage'
  | 'support:read'
  | 'telegram_group:read'
  | 'telegram_user:manage'
  | 'trusted_author:manage'
  | 'user:manage';

const ROLE_LEVEL: Record<KnowledgeAdminRole, number> = {
  viewer: 0,
  reviewer: 1,
  publisher: 2,
  admin: 3,
};

const PERMISSION_LEVEL: Record<KnowledgeAdminPermission, number> = {
  'candidate:read': ROLE_LEVEL.viewer,
  'candidate:review': ROLE_LEVEL.reviewer,
  'import:telegram': ROLE_LEVEL.reviewer,
  'publication:request': ROLE_LEVEL.publisher,
  'quality:baseline': ROLE_LEVEL.admin,
  'quality:read': ROLE_LEVEL.viewer,
  'quality:run': ROLE_LEVEL.publisher,
  'observability:read': ROLE_LEVEL.viewer,
  'support:manage': ROLE_LEVEL.reviewer,
  'support:read': ROLE_LEVEL.viewer,
  'telegram_group:read': ROLE_LEVEL.viewer,
  'telegram_user:manage': ROLE_LEVEL.admin,
  'trusted_author:manage': ROLE_LEVEL.admin,
  'user:manage': ROLE_LEVEL.admin,
};

export function hasKnowledgeAdminPermission(
  principal: KnowledgeAdminPrincipal,
  permission: KnowledgeAdminPermission,
): boolean {
  return ROLE_LEVEL[principal.role] >= PERMISSION_LEVEL[permission];
}

export function readKnowledgeAdminBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (authorization === undefined) {
    return undefined;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/u.exec(authorization.trim());
  return match?.[1];
}
