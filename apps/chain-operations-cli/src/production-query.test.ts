import { describe, expect, it } from 'vitest';

import { createInMemoryChainAnalysisMcpClient } from '@xxyy/chain-analysis-mcp';
import { createChainAnalysisFixtureRuntime } from '@xxyy/chain-analysis-mcp/test-fixtures';

import { type InternalOnchainQueryIo } from './internal-query.js';
import {
  createProductionMcpStdioParameters,
  runProductionOnchainQuery,
} from './production-query.js';

const TRANSACTION_HASH = `0x${'12'.repeat(32)}`;

describe('production onchain query CLI', () => {
  it('requires an explicit production environment before creating an MCP client', async () => {
    let clients = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runProductionOnchainQuery(
      ['transaction', '--reference', TRANSACTION_HASH, '--network', 'eip155:1'],
      createIo(stdout, stderr, {}),
      {
        createMcpClient: () => {
          clients += 1;
          throw new Error('should not create client');
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(clients).toBe(0);
    expect(JSON.parse(stderr.join(''))).toEqual({
      code: 'configuration_error',
      message: 'Production onchain query requires NODE_ENV=production.',
    });
  });

  it('preflights production data-plane configuration before spawning stdio MCP', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runProductionOnchainQuery(
      ['transaction', '--reference', TRANSACTION_HASH, '--network', 'eip155:1'],
      createIo(stdout, stderr, { NODE_ENV: 'production' }),
    );

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(''))).toEqual({
      code: 'configuration_error',
      message: 'CHAIN_DATA_PLANE_INSTANCE_ID_HASH must be a SHA-256 fingerprint.',
    });
  });

  it('executes the cli/admin capability chain with a production-profile MCP client', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runProductionOnchainQuery(
      [
        'transaction',
        '--reference',
        fixture.transactionHash,
        '--network',
        `eip155:${fixture.chainId}`,
      ],
      createIo(stdout, stderr, { NODE_ENV: 'production' }),
      {
        createMcpClient: () =>
          createInMemoryChainAnalysisMcpClient({
            handler: fixture.handler,
          }),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      command: 'transaction',
      result: {
        chainId: fixture.chainId,
        family: 'evm',
        status: 'success',
        transactionId: fixture.transactionHash,
      },
    });
  });

  it('shows the production command and gate in help output', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(runProductionOnchainQuery(['help'], createIo(stdout, stderr, {}))).resolves.toBe(
      0,
    );
    expect(stderr).toEqual([]);
    expect(stdout.join('')).toContain('pnpm onchain:query:production');
    expect(stdout.join('')).toContain('readiness-gated production MCP');
  });

  it('starts the MCP entry directly and only forwards allowlisted environment values', () => {
    const parameters = createProductionMcpStdioParameters(
      createIo([], [], {
        CHAIN_CONTROL_DATABASE_URL: 'postgres://localhost/chain_control',
        NODE_ENV: 'production',
        PROVIDER_SECRET_VALUE: 'must-not-be-forwarded',
      }),
    );

    expect(parameters.command).toBe(process.execPath);
    expect(parameters.args?.slice(0, 2)).toEqual(['--import', expect.stringContaining('tsx')]);
    expect(parameters.args?.at(-1)).toMatch(/mcp-stdio\.ts$/u);
    expect(parameters.args).not.toContain('pnpm');
    expect(parameters.env).toEqual({
      CHAIN_CONTROL_DATABASE_URL: 'postgres://localhost/chain_control',
      NODE_ENV: 'production',
    });
  });
});

function createIo(
  stdout: string[],
  stderr: string[],
  env: InternalOnchainQueryIo['env'],
): InternalOnchainQueryIo {
  return {
    createRequestId: () => 'request-1',
    cwd: process.cwd(),
    env,
    stderr: {
      write(message: string) {
        stderr.push(message);
        return true;
      },
    },
    stdout: {
      write(message: string) {
        stdout.push(message);
        return true;
      },
    },
  };
}
