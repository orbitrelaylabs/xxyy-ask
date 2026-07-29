import { describe, expect, it } from 'vitest';

import { createInMemoryChainAnalysisMcpClient } from '@xxyy/chain-analysis-mcp';
import { createChainAnalysisFixtureRuntime } from '@xxyy/chain-analysis-mcp/test-fixtures';

import {
  parseInternalOnchainQueryArgs,
  runInternalOnchainQuery,
  type InternalOnchainQueryIo,
} from './internal-query.js';

const TRANSACTION_HASH = `0x${'12'.repeat(32)}`;
const POOL_ADDRESS = `0x${'34'.repeat(20)}`;

describe('internal onchain query CLI', () => {
  it('parses transaction, inspection, and Sandwich commands', () => {
    expect(
      parseInternalOnchainQueryArgs([
        '--',
        'transaction',
        '--reference',
        TRANSACTION_HASH,
        '--network',
        'eip155:1',
      ]),
    ).toEqual({
      command: 'transaction',
      input: {
        network: 'eip155:1',
        reference: TRANSACTION_HASH,
      },
    });
    expect(
      parseInternalOnchainQueryArgs([
        'inspect',
        '--chain-id',
        '1',
        '--transaction-hash',
        TRANSACTION_HASH,
      ]),
    ).toEqual({
      command: 'inspect',
      input: {
        chainId: '1',
        transactionHash: TRANSACTION_HASH,
      },
    });
    expect(
      parseInternalOnchainQueryArgs([
        'sandwich',
        '--chain-id',
        '1',
        '--transaction-hash',
        TRANSACTION_HASH,
        '--pool-address',
        POOL_ADDRESS,
      ]),
    ).toEqual({
      command: 'sandwich',
      input: {
        chainId: '1',
        poolAddress: POOL_ADDRESS,
        transactionHash: TRANSACTION_HASH,
      },
    });
  });

  it('executes the cli/admin Tool through Skill and MCP capabilities', async () => {
    const fixture = await createChainAnalysisFixtureRuntime('synthetic.inspect-execution');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runInternalOnchainQuery(
      [
        'transaction',
        '--reference',
        fixture.transactionHash,
        '--network',
        `eip155:${fixture.chainId}`,
      ],
      createIo(stdout, stderr),
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

  it('fails closed in production before creating an MCP client', async () => {
    let clients = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runInternalOnchainQuery(
      ['transaction', '--reference', TRANSACTION_HASH, '--network', 'eip155:1'],
      {
        ...createIo(stdout, stderr),
        env: { NODE_ENV: 'production' },
      },
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
      message:
        'Internal onchain query uses the development MCP profile and is disabled in production.',
    });
  });

  it('rejects malformed and duplicate flags', () => {
    expect(() =>
      parseInternalOnchainQueryArgs([
        'transaction',
        '--reference',
        TRANSACTION_HASH,
        '--reference',
        TRANSACTION_HASH,
      ]),
    ).toThrow('unknown or duplicate flag');
    expect(() => parseInternalOnchainQueryArgs(['inspect', '--chain-id'])).toThrow(
      'explicit values',
    );
    expect(() => parseInternalOnchainQueryArgs(['inspect', '--chain-id', '1'])).toThrow(
      'requires --transaction-hash',
    );
  });
});

function createIo(stdout: string[], stderr: string[]): InternalOnchainQueryIo {
  return {
    createRequestId: () => 'request-1',
    cwd: process.cwd(),
    env: {},
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
