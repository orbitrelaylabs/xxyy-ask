import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

import type { PublicOnchainMcpEnv } from './public-mcp-config.js';

type EnvRecord = Partial<Record<string, string | undefined>>;

export interface LoadPublicOnchainMcpEnvOptions {
  cwd?: string;
  env?: EnvRecord;
}

export function loadPublicOnchainMcpEnv(
  options: LoadPublicOnchainMcpEnvOptions = {},
): PublicOnchainMcpEnv {
  const cwd = options.cwd ?? process.cwd();
  const shellEnv = options.env ?? process.env;
  const workspaceRoot = resolveWorkspaceRoot(cwd, shellEnv);
  const fileEnv = loadDotEnv(path.join(workspaceRoot, '.env'));
  const merged = mergeEnv(fileEnv, shellEnv);

  return {
    ...(merged.NODE_ENV === undefined ? {} : { NODE_ENV: merged.NODE_ENV }),
    ...(merged.ONCHAIN_ALLOW_INSECURE_LOCALHOST === undefined
      ? {}
      : { ONCHAIN_ALLOW_INSECURE_LOCALHOST: merged.ONCHAIN_ALLOW_INSECURE_LOCALHOST }),
    ...(merged.ONCHAIN_RPC_CONFIG_JSON === undefined
      ? {}
      : { ONCHAIN_RPC_CONFIG_JSON: merged.ONCHAIN_RPC_CONFIG_JSON }),
  };
}

function resolveWorkspaceRoot(cwd: string, env: EnvRecord): string {
  const initCwd = env.INIT_CWD;
  if (initCwd !== undefined && isWorkspaceRoot(initCwd)) {
    return path.resolve(initCwd);
  }
  return findWorkspaceRoot(cwd) ?? path.resolve(cwd);
}

function findWorkspaceRoot(startPath: string): string | undefined {
  let currentPath = path.resolve(startPath);
  while (true) {
    if (isWorkspaceRoot(currentPath)) {
      return currentPath;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }
    currentPath = parentPath;
  }
}

function isWorkspaceRoot(candidatePath: string): boolean {
  return existsSync(path.join(candidatePath, 'pnpm-workspace.yaml'));
}

function loadDotEnv(filePath: string): EnvRecord {
  if (!existsSync(filePath)) {
    return {};
  }
  return parseEnv(readFileSync(filePath, 'utf8'));
}

function mergeEnv(fileEnv: EnvRecord, shellEnv: EnvRecord): EnvRecord {
  const merged: EnvRecord = { ...fileEnv };
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
