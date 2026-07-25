import path from 'node:path';

import { z } from 'zod';

const fingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export type ChainOperationsEnv = Partial<
  Record<
    | 'CHAIN_CONTROL_DATABASE_URL'
    | 'CHAIN_ANALYSIS_DATA_PLANE_MANIFEST_FINGERPRINT'
    | 'CHAIN_ANALYSIS_READINESS_FINGERPRINT'
    | 'CHAIN_DATA_PLANE_ALLOW_INSECURE_LOCALHOST'
    | 'CHAIN_DATA_PLANE_INSTANCE_ID_HASH'
    | 'CHAIN_DATA_PLANE_MANIFEST_FILE'
    | 'CHAIN_DATA_PLANE_SECRET_DIR'
    | 'CHAIN_RECONCILIATION_WORKER_ID_HASH'
    | 'CHAIN_RETENTION_WORKER_ID_HASH'
    | 'DATABASE_URL'
    | 'NODE_ENV'
    | 'POSTGRES_DB'
    | 'POSTGRES_HOST'
    | 'POSTGRES_PORT',
    string
  >
>;

export class ChainOperationsCliError extends Error {
  constructor(
    readonly code: 'configuration_error' | 'invalid_command' | 'invalid_input' | 'io_error',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChainOperationsCliError';
  }
}

export interface ChainDataPlaneRuntimeConfig {
  allowInsecureLocalhost: boolean;
  controlDatabaseUrl: string;
  instanceIdHash: string;
  manifestFile: string;
  secretDirectory: string;
}

export interface ChainOperationsRuntimeConfig extends ChainDataPlaneRuntimeConfig {
  reconciliationWorkerIdHash: string;
  retentionWorkerIdHash: string;
}

export function loadChainDataPlaneRuntimeConfig(
  env: ChainOperationsEnv,
): ChainDataPlaneRuntimeConfig {
  const instanceIdHash = parseHash(
    env.CHAIN_DATA_PLANE_INSTANCE_ID_HASH,
    'CHAIN_DATA_PLANE_INSTANCE_ID_HASH',
  );
  const allowInsecureLocalhost = parseBoolean(env.CHAIN_DATA_PLANE_ALLOW_INSECURE_LOCALHOST, false);
  if (allowInsecureLocalhost && env.NODE_ENV === 'production') {
    throw new ChainOperationsCliError(
      'configuration_error',
      'Insecure localhost providers cannot be enabled in production.',
    );
  }
  return {
    allowInsecureLocalhost,
    controlDatabaseUrl: loadControlDatabaseUrl(env),
    instanceIdHash,
    manifestFile: path.resolve(
      requiredText(env.CHAIN_DATA_PLANE_MANIFEST_FILE, 'Manifest file is required.'),
    ),
    secretDirectory: path.resolve(
      requiredText(env.CHAIN_DATA_PLANE_SECRET_DIR, 'Secret directory is required.'),
    ),
  };
}

export function loadChainOperationsRuntimeConfig(
  env: ChainOperationsEnv,
): ChainOperationsRuntimeConfig {
  const dataPlane = loadChainDataPlaneRuntimeConfig(env);
  return {
    ...dataPlane,
    reconciliationWorkerIdHash: parseHash(
      env.CHAIN_RECONCILIATION_WORKER_ID_HASH ?? dataPlane.instanceIdHash,
      'CHAIN_RECONCILIATION_WORKER_ID_HASH',
    ),
    retentionWorkerIdHash: parseHash(
      env.CHAIN_RETENTION_WORKER_ID_HASH,
      'CHAIN_RETENTION_WORKER_ID_HASH',
    ),
  };
}

function loadControlDatabaseUrl(env: ChainOperationsEnv): string {
  const value = requiredText(
    env.CHAIN_CONTROL_DATABASE_URL,
    'CHAIN_CONTROL_DATABASE_URL is required.',
  );
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new ChainOperationsCliError(
      'configuration_error',
      'CHAIN_CONTROL_DATABASE_URL must be a valid PostgreSQL URL.',
      { cause },
    );
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname.length === 0 ||
    parsed.pathname.length <= 1
  ) {
    throw new ChainOperationsCliError(
      'configuration_error',
      'CHAIN_CONTROL_DATABASE_URL must name an explicit PostgreSQL host and database.',
    );
  }
  if (!isLocalHost(parsed.hostname)) {
    const sslMode = parsed.searchParams.get('sslmode');
    if (sslMode !== 'verify-ca' && sslMode !== 'verify-full') {
      throw new ChainOperationsCliError(
        'configuration_error',
        'Remote chain-control PostgreSQL requires verified TLS.',
      );
    }
  }
  const product = productDatabaseIdentity(env);
  if (product !== undefined && product === databaseIdentity(parsed)) {
    throw new ChainOperationsCliError(
      'configuration_error',
      'Chain operations must not use the Product RAG database.',
    );
  }
  return value;
}

function productDatabaseIdentity(env: ChainOperationsEnv): string | undefined {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    try {
      return databaseIdentity(new URL(databaseUrl));
    } catch {
      return undefined;
    }
  }
  const database = env.POSTGRES_DB?.trim();
  if (database === undefined || database.length === 0) {
    return undefined;
  }
  return `${canonicalHost(env.POSTGRES_HOST?.trim() || 'localhost')}:${env.POSTGRES_PORT?.trim() || '5432'}/${database}`;
}

function databaseIdentity(url: URL): string {
  return `${canonicalHost(url.hostname)}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
}

function canonicalHost(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return isLocalHost(normalized) ? 'local' : normalized;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === 'localhost' ||
    hostname === '[::1]'
  );
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new ChainOperationsCliError(
    'configuration_error',
    'Boolean configuration must be true or false.',
  );
}

function parseHash(value: string | undefined, name: string): string {
  try {
    return fingerprintSchema.parse(value?.trim());
  } catch (cause) {
    throw new ChainOperationsCliError(
      'configuration_error',
      `${name} must be a SHA-256 fingerprint.`,
      { cause },
    );
  }
}

function requiredText(value: string | undefined, message: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new ChainOperationsCliError('configuration_error', message);
  }
  return normalized;
}
