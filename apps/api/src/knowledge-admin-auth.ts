import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type KnowledgeAdminRole = 'admin' | 'publisher' | 'reviewer' | 'viewer';
export type KnowledgeAdminPermission =
  | 'candidate:read'
  | 'candidate:review'
  | 'import:telegram'
  | 'publication:request'
  | 'support:manage'
  | 'support:read'
  | 'trusted_author:manage';

export interface KnowledgeAdminPrincipal {
  displayName: string;
  id: string;
  role: KnowledgeAdminRole;
}

export interface KnowledgeAdminAuthenticator {
  readonly configured: boolean;
  authenticate(authorization: string | undefined): KnowledgeAdminPrincipal | undefined;
}

interface KnowledgeAdminTokenRecord extends KnowledgeAdminPrincipal {
  tokenHash: string;
}

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
  'support:manage': ROLE_LEVEL.reviewer,
  'support:read': ROLE_LEVEL.viewer,
  'trusted_author:manage': ROLE_LEVEL.admin,
};

export function createKnowledgeAdminAuthenticator(
  rawConfiguration: string | undefined,
): KnowledgeAdminAuthenticator {
  if (rawConfiguration?.trim() === undefined || rawConfiguration.trim().length === 0) {
    return {
      configured: false,
      authenticate: () => undefined,
    };
  }

  const records = parseKnowledgeAdminTokenRecords(rawConfiguration);
  return {
    configured: true,
    authenticate(authorization) {
      const token = parseBearerToken(authorization);
      if (token === undefined) {
        return undefined;
      }
      const actualHash = Buffer.from(hashKnowledgeAdminToken(token), 'hex');
      let matched: KnowledgeAdminTokenRecord | undefined;
      for (const record of records) {
        const expectedHash = Buffer.from(record.tokenHash, 'hex');
        if (timingSafeEqual(actualHash, expectedHash)) {
          matched = record;
        }
      }
      if (matched === undefined) {
        return undefined;
      }
      return {
        displayName: matched.displayName,
        id: matched.id,
        role: matched.role,
      };
    },
  };
}

export function hasKnowledgeAdminPermission(
  principal: KnowledgeAdminPrincipal,
  permission: KnowledgeAdminPermission,
): boolean {
  return ROLE_LEVEL[principal.role] >= PERMISSION_LEVEL[permission];
}

export function createKnowledgeAdminToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashKnowledgeAdminToken(token) };
}

export function hashKnowledgeAdminToken(token: string): string {
  const normalized = token.trim();
  if (normalized.length < 24 || normalized.length > 512) {
    throw new Error('Knowledge admin tokens must contain between 24 and 512 characters.');
  }
  return createHash('sha256').update(normalized).digest('hex');
}

function parseKnowledgeAdminTokenRecords(rawConfiguration: string): KnowledgeAdminTokenRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfiguration);
  } catch (error) {
    throw new Error('KNOWLEDGE_ADMIN_TOKENS_JSON must be valid JSON.', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('KNOWLEDGE_ADMIN_TOKENS_JSON must contain at least one administrator.');
  }

  const ids = new Set<string>();
  const tokenHashes = new Set<string>();
  return parsed.map((rawRecord, index) => {
    if (!isObject(rawRecord)) {
      throw new Error(`Knowledge admin record ${index} must be an object.`);
    }
    const id = requiredIdentifier(rawRecord.id, `Knowledge admin record ${index} id`);
    if (ids.has(id)) {
      throw new Error(`Knowledge admin id ${id} is duplicated.`);
    }
    ids.add(id);
    const role = parseKnowledgeAdminRole(rawRecord.role, index);
    const tokenHash = requiredString(
      rawRecord.tokenHash,
      `Knowledge admin record ${index} tokenHash`,
    ).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(tokenHash)) {
      throw new Error(`Knowledge admin record ${index} tokenHash must be a SHA-256 hex digest.`);
    }
    if (tokenHashes.has(tokenHash)) {
      throw new Error(`Knowledge admin record ${index} reuses an administrator token hash.`);
    }
    tokenHashes.add(tokenHash);
    return {
      displayName:
        rawRecord.displayName === undefined
          ? id
          : requiredString(rawRecord.displayName, `Knowledge admin record ${index} displayName`),
      id,
      role,
      tokenHash,
    };
  });
}

function parseBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/u.exec(authorization.trim());
  if (match === null) {
    return undefined;
  }
  const token = match[1];
  return token !== undefined && token.length >= 24 && token.length <= 512 ? token : undefined;
}

function parseKnowledgeAdminRole(value: unknown, index: number): KnowledgeAdminRole {
  if (value === 'admin' || value === 'publisher' || value === 'reviewer' || value === 'viewer') {
    return value;
  }
  throw new Error(`Knowledge admin record ${index} has an invalid role.`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/u.test(identifier)) {
    throw new Error(`${field} contains unsupported characters or is too long.`);
  }
  return identifier;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
