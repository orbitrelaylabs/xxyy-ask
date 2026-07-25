import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPublicOnchainMcpEnv } from './public-mcp-env.js';

describe('loadPublicOnchainMcpEnv', () => {
  it('loads the workspace .env and gives the process environment precedence', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-onchain-env-'));
    const packageCwd = path.join(workspaceRoot, 'apps', 'chain-operations-cli');
    await mkdir(packageCwd, { recursive: true });
    await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeFile(
      path.join(workspaceRoot, '.env'),
      [
        'ONCHAIN_ALLOW_INSECURE_LOCALHOST=false',
        `ONCHAIN_RPC_CONFIG_JSON='{"evm":[{"chainId":"1","providers":[{"id":"file","endpoint":"https://file.example"}]}]}'`,
      ].join('\n'),
    );

    const env = loadPublicOnchainMcpEnv({
      cwd: packageCwd,
      env: {
        ONCHAIN_ALLOW_INSECURE_LOCALHOST: 'true',
      },
    });

    expect(env.ONCHAIN_ALLOW_INSECURE_LOCALHOST).toBe('true');
    expect(env.ONCHAIN_RPC_CONFIG_JSON).toContain('"id":"file"');
  });
});
