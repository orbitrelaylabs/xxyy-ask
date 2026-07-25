import { describe, expect, it } from 'vitest';

import {
  loadChainDataPlaneRuntimeConfig,
  loadChainOperationsRuntimeConfig,
  type ChainOperationsEnv,
} from './runtime-config.js';

const hash = `sha256:${'ab'.repeat(32)}`;

describe('chain operations runtime configuration', () => {
  it('requires an isolated control database and explicit worker identities', () => {
    const config = loadChainOperationsRuntimeConfig(baseEnv());
    expect(config.controlDatabaseUrl).toContain('/chain_control');
    expect(config.instanceIdHash).toBe(hash);
    expect(config.reconciliationWorkerIdHash).toBe(hash);

    expect(() =>
      loadChainOperationsRuntimeConfig({
        ...baseEnv(),
        CHAIN_CONTROL_DATABASE_URL: 'postgres://localhost/product',
        DATABASE_URL: 'postgres://localhost/product',
      }),
    ).toThrow(/must not use the Product RAG database/u);
  });

  it('requires verified TLS remotely and forbids insecure providers in production', () => {
    expect(() =>
      loadChainOperationsRuntimeConfig({
        ...baseEnv(),
        CHAIN_CONTROL_DATABASE_URL: 'postgres://db.example/chain_control',
      }),
    ).toThrow(/verified TLS/u);
    expect(() =>
      loadChainOperationsRuntimeConfig({
        ...baseEnv(),
        CHAIN_DATA_PLANE_ALLOW_INSECURE_LOCALHOST: 'true',
        NODE_ENV: 'production',
      }),
    ).toThrow(/cannot be enabled in production/u);
  });

  it('loads the MCP data-plane boundary without unrelated worker identities', () => {
    expect(
      loadChainDataPlaneRuntimeConfig({
        CHAIN_CONTROL_DATABASE_URL: 'postgres://localhost/chain_control',
        CHAIN_DATA_PLANE_INSTANCE_ID_HASH: hash,
        CHAIN_DATA_PLANE_MANIFEST_FILE: '/controlled/manifest.json',
        CHAIN_DATA_PLANE_SECRET_DIR: '/run/secrets/chain',
        DATABASE_URL: 'postgres://localhost/product',
      }),
    ).toMatchObject({
      controlDatabaseUrl: 'postgres://localhost/chain_control',
      instanceIdHash: hash,
    });
  });
});

function baseEnv(): ChainOperationsEnv {
  return {
    CHAIN_CONTROL_DATABASE_URL: 'postgres://localhost/chain_control',
    CHAIN_DATA_PLANE_INSTANCE_ID_HASH: hash,
    CHAIN_DATA_PLANE_MANIFEST_FILE: '/controlled/manifest.json',
    CHAIN_DATA_PLANE_SECRET_DIR: '/run/secrets/chain',
    CHAIN_RETENTION_WORKER_ID_HASH: `sha256:${'cd'.repeat(32)}`,
    DATABASE_URL: 'postgres://localhost/product',
  };
}
