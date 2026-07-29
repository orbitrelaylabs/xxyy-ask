import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  createChainAnalysisMcpClient,
  type ChainAnalysisMcpClient,
} from '@xxyy/chain-analysis-mcp';

import { runInternalOnchainQuery, type InternalOnchainQueryIo } from './internal-query.js';
import { loadChainAnalysisMcpRuntimeConfig } from './mcp-runtime-config.js';
import { loadChainDataPlaneRuntimeConfig, type ChainOperationsEnv } from './runtime-config.js';

const PRODUCTION_MCP_ENV_NAMES = [
  'CHAIN_CONTROL_DATABASE_URL',
  'CHAIN_ANALYSIS_DATA_PLANE_MANIFEST_FINGERPRINT',
  'CHAIN_ANALYSIS_READINESS_FINGERPRINT',
  'CHAIN_DATA_PLANE_ALLOW_INSECURE_LOCALHOST',
  'CHAIN_DATA_PLANE_INSTANCE_ID_HASH',
  'CHAIN_DATA_PLANE_MANIFEST_FILE',
  'CHAIN_DATA_PLANE_SECRET_DIR',
  'DATABASE_URL',
  'NODE_ENV',
  'POSTGRES_DB',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
] as const satisfies readonly (keyof ChainOperationsEnv)[];
const MCP_STDIO_ENTRY = fileURLToPath(new URL('./mcp-stdio.ts', import.meta.url));
const TSX_IMPORT = import.meta.resolve('tsx');

export interface ProductionOnchainQueryDependencies {
  createMcpClient?(io: InternalOnchainQueryIo): ChainAnalysisMcpClient;
}

export async function runProductionOnchainQuery(
  args: readonly string[],
  io: InternalOnchainQueryIo = defaultIo(),
  dependencies: ProductionOnchainQueryDependencies = {},
): Promise<number> {
  return runInternalOnchainQuery(args, io, {
    createMcpClient: dependencies.createMcpClient ?? createReadinessGatedMcpClient,
    profile: 'production',
  });
}

function createReadinessGatedMcpClient(io: InternalOnchainQueryIo): ChainAnalysisMcpClient {
  loadChainDataPlaneRuntimeConfig(io.env);
  loadChainAnalysisMcpRuntimeConfig(io.env);

  return createChainAnalysisMcpClient({
    transport: new StdioClientTransport(createProductionMcpStdioParameters(io)),
  });
}

export function createProductionMcpStdioParameters(
  io: InternalOnchainQueryIo,
): StdioServerParameters {
  return {
    args: ['--import', TSX_IMPORT, MCP_STDIO_ENTRY],
    command: process.execPath,
    cwd: io.cwd,
    env: selectProductionMcpEnvironment(io.env),
    stderr: 'inherit',
  };
}

function selectProductionMcpEnvironment(
  env: InternalOnchainQueryIo['env'],
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of PRODUCTION_MCP_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) {
      selected[name] = value;
    }
  }
  return selected;
}

function defaultIo(): InternalOnchainQueryIo {
  return {
    createRequestId: randomUUID,
    cwd: process.cwd(),
    env: process.env,
    stderr: process.stderr,
    stdout: process.stdout,
  };
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  process.exitCode = await runProductionOnchainQuery(process.argv.slice(2));
}
