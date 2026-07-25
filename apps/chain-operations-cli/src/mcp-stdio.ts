import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Pool } from 'pg';
import { z } from 'zod';

import {
  createChainAnalysisHandler,
  createChainAnalysisMcpServer,
  createReadinessGuardedChainAnalysisHandler,
} from '@xxyy/chain-analysis-mcp';
import {
  ChainAnalysisControlStoreError,
  createPgEvmChainAnalysisProviderControlStore,
  createPgEvmChainAnalysisReadinessEvidenceStore,
} from '@xxyy/evm-chain-analysis-control-store';
import {
  ProductionDataPlaneError,
  createMemoryProviderResponseCache,
  createProductionChainDataPlane,
  productionDataPlaneManifestSchema,
  resolveProductionProviders,
  type ProductionDataPlaneAlert,
  type ProductionDataPlaneMetric,
} from '@xxyy/evm-chain-analysis-data-plane';

import { assertChainAnalysisMcpReadiness } from './mcp-readiness-gate.js';
import { loadChainAnalysisMcpRuntimeConfig } from './mcp-runtime-config.js';
import { createPgControlClient } from './pg-control-client.js';
import { ChainOperationsCliError, loadChainDataPlaneRuntimeConfig } from './runtime-config.js';
import { createMountedSecretResolver, readControlledManifest } from './secure-files.js';

const CACHE_MAX_ENTRIES = 512;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

async function startChainAnalysisMcp(): Promise<void> {
  const now = (): Date => new Date();
  const operationsConfig = loadChainDataPlaneRuntimeConfig(process.env);
  const mcpConfig = loadChainAnalysisMcpRuntimeConfig(process.env);
  const manifest = productionDataPlaneManifestSchema.parse(
    await readControlledManifest(operationsConfig.manifestFile),
  );
  const pool = new Pool({
    connectionString: operationsConfig.controlDatabaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 4,
  });
  let server: ReturnType<typeof createChainAnalysisMcpServer> | undefined;
  let closing = false;
  let poolClosing = false;

  const closePool = async (): Promise<void> => {
    if (poolClosing) {
      return;
    }
    poolClosing = true;
    await pool.end();
  };

  try {
    const controlClient = createPgControlClient(pool);
    const readiness = await assertChainAnalysisMcpReadiness({
      expectedManifestFingerprint: mcpConfig.manifestFingerprint,
      manifest,
      now: now(),
      readinessFingerprint: mcpConfig.readinessFingerprint,
      store: createPgEvmChainAnalysisReadinessEvidenceStore({
        client: controlClient,
      }),
    });
    const runtime = await resolveProductionProviders(
      manifest,
      createMountedSecretResolver(operationsConfig.secretDirectory),
      {
        allowInsecureLocalhost: operationsConfig.allowInsecureLocalhost,
      },
    );
    const providerStore = createPgEvmChainAnalysisProviderControlStore({
      client: controlClient,
      coordinatorInstanceIdHash: operationsConfig.instanceIdHash,
      now: () => now().toISOString(),
    });
    const dataPlane = createProductionChainDataPlane({
      alertSink: (alert) => writeOperational('alert', alert),
      allowInsecureLocalhost: operationsConfig.allowInsecureLocalhost,
      cache: createMemoryProviderResponseCache({
        maxEntries: CACHE_MAX_ENTRIES,
        maxTotalBytes: CACHE_MAX_BYTES,
      }),
      controls: providerStore,
      instanceIdHash: operationsConfig.instanceIdHash,
      manifest,
      metricSink: (metric) => writeOperational('metric', metric),
      now: () => now().toISOString(),
      nowMs: () => now().getTime(),
      providers: runtime.providers,
    });
    const handler = createReadinessGuardedChainAnalysisHandler({
      handler: createChainAnalysisHandler({
        dataPlane,
        runtimeStatus: 'ready',
      }),
      now,
      readyFrom: readiness.evaluatedAt,
      readyUntil: readiness.nextEvaluationAt,
    });
    server = createChainAnalysisMcpServer({ handler });
    const transport = new StdioServerTransport();

    async function shutdown(closeServer: boolean): Promise<void> {
      if (closing) {
        return;
      }
      closing = true;
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      process.stdin.off('end', handleStdinEnd);
      if (closeServer) {
        await server?.close().catch(() => undefined);
      }
      await closePool();
    }
    function handleSignal(): void {
      process.exitCode = 0;
      void shutdown(true).catch(() => {
        process.exitCode = 1;
      });
    }
    function handleStdinEnd(): void {
      void shutdown(true).catch(() => {
        process.exitCode = 1;
      });
    }

    transport.onclose = () => {
      void shutdown(false).catch(() => {
        process.exitCode = 1;
      });
    };
    await server.connect(transport);
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
    process.stdin.once('end', handleStdinEnd);
  } catch (error) {
    await server?.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    throw error;
  }
}

function writeOperational(
  kind: 'alert' | 'metric',
  value: ProductionDataPlaneAlert | ProductionDataPlaneMetric,
): void {
  process.stderr.write(`${JSON.stringify({ kind, ...value })}\n`);
}

function formatStartupError(error: unknown): { code: string; message: string } {
  if (error instanceof ChainOperationsCliError) {
    return { code: error.code, message: error.message };
  }
  if (
    error instanceof ChainAnalysisControlStoreError ||
    error instanceof ProductionDataPlaneError
  ) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_input',
      message: 'Chain-analysis MCP startup input failed validation.',
    };
  }
  return {
    code: 'startup_failed',
    message: 'Chain-analysis MCP startup failed without exposing provider or database details.',
  };
}

try {
  await startChainAnalysisMcp();
} catch (error) {
  process.stderr.write(`${JSON.stringify(formatStartupError(error))}\n`);
  process.exitCode = 1;
}
