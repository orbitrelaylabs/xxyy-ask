import { createHash, timingSafeEqual } from 'node:crypto';

export interface AgentApiPrincipal {
  id: string;
}

export interface AgentApiAuthenticator {
  readonly configured: boolean;
  authenticate(authorization: string | undefined): AgentApiPrincipal | undefined;
}

interface AgentApiKeyRecord {
  id: string;
  tokenHash: string;
}

export function createAgentApiAuthenticator(
  rawConfiguration: string | undefined,
): AgentApiAuthenticator {
  if (rawConfiguration === undefined || rawConfiguration.trim().length === 0) {
    return { configured: false, authenticate: () => undefined };
  }
  const records = parseRecords(rawConfiguration);
  return {
    configured: true,
    authenticate(authorization) {
      const token = parseBearerToken(authorization);
      if (token === undefined) return undefined;
      const actual = Buffer.from(createHash('sha256').update(token).digest('hex'), 'hex');
      let matched: AgentApiKeyRecord | undefined;
      for (const record of records) {
        const expected = Buffer.from(record.tokenHash, 'hex');
        if (timingSafeEqual(actual, expected)) matched = record;
      }
      return matched === undefined ? undefined : { id: matched.id };
    },
  };
}

function parseRecords(rawConfiguration: string): AgentApiKeyRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfiguration);
  } catch (error) {
    throw new Error('XXYY_AGENT_API_KEYS_JSON must be valid JSON.', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('XXYY_AGENT_API_KEYS_JSON must contain at least one API key.');
  }
  const ids = new Set<string>();
  const hashes = new Set<string>();
  return parsed.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Agent API key record ${index} must be an object.`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !/^[A-Za-z0-9_.:@-]{1,160}$/u.test(record.id)) {
      throw new Error(`Agent API key record ${index} has an invalid id.`);
    }
    if (typeof record.tokenHash !== 'string' || !/^[a-f0-9]{64}$/iu.test(record.tokenHash)) {
      throw new Error(`Agent API key record ${index} tokenHash must be a SHA-256 hex digest.`);
    }
    const tokenHash = record.tokenHash.toLowerCase();
    if (ids.has(record.id) || hashes.has(tokenHash)) {
      throw new Error(`Agent API key record ${index} is duplicated.`);
    }
    ids.add(record.id);
    hashes.add(tokenHash);
    return { id: record.id, tokenHash };
  });
}

function parseBearerToken(authorization: string | undefined): string | undefined {
  const match =
    authorization === undefined ? null : /^Bearer ([^\s]+)$/u.exec(authorization.trim());
  const token = match?.[1];
  return token !== undefined && token.length >= 24 && token.length <= 512 ? token : undefined;
}
