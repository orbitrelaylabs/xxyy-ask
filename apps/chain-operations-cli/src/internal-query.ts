import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import {
  createInternalChainAnalysisCapabilityRegistry,
  createInternalChainAnalysisTools,
  createToolRegistry,
} from '@xxyy/agent-core';
import {
  ChainAnalysisMcpToolError,
  detectSandwichInputSchema,
  getTransactionInputSchema,
  inspectTransactionInputSchema,
  type ChainAnalysisMcpClient,
  type DetectSandwichInput,
  type GetTransactionInput,
  type InspectTransactionInput,
} from '@xxyy/chain-analysis-mcp';

import { ChainOperationsCliError } from './runtime-config.js';

type InternalOnchainQueryCommand =
  | { command: 'help' }
  | { command: 'inspect'; input: InspectTransactionInput }
  | { command: 'sandwich'; input: DetectSandwichInput }
  | { command: 'transaction'; input: GetTransactionInput };

type InternalOnchainQueryEnv = Partial<Record<string, string | undefined>>;
export type InternalOnchainQueryProfile = 'development' | 'production';

export interface InternalOnchainQueryIo {
  createRequestId(): string;
  cwd: string;
  env: InternalOnchainQueryEnv;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
}

export interface InternalOnchainQueryDependencies {
  createMcpClient?(io: InternalOnchainQueryIo): ChainAnalysisMcpClient;
  profile?: InternalOnchainQueryProfile;
}

const CALLER = { channel: 'cli' as const, principal: 'admin' as const };

export function parseInternalOnchainQueryArgs(
  args: readonly string[],
): InternalOnchainQueryCommand {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const [rawCommand, ...rawRest] = normalizedArgs;
  const rest = rawRest[0] === '--' ? rawRest.slice(1) : rawRest;
  if (
    rawCommand === undefined ||
    rawCommand === 'help' ||
    rawCommand === '--help' ||
    rawCommand === '-h'
  ) {
    if (rest.length > 0) {
      throw invalidCommand('Help does not accept arguments.');
    }
    return { command: 'help' };
  }
  if (rawCommand === 'transaction') {
    const flags = parseValueFlags(rest, ['network', 'reference']);
    return {
      command: 'transaction',
      input: getTransactionInputSchema.parse({
        ...(flags.get('network') === undefined ? {} : { network: flags.get('network') }),
        reference: requiredFlag(flags, 'reference'),
      }),
    };
  }
  if (rawCommand === 'inspect') {
    const flags = parseValueFlags(rest, ['chain-id', 'transaction-hash']);
    return {
      command: 'inspect',
      input: inspectTransactionInputSchema.parse({
        chainId: requiredFlag(flags, 'chain-id'),
        transactionHash: requiredFlag(flags, 'transaction-hash'),
      }),
    };
  }
  if (rawCommand === 'sandwich') {
    const flags = parseValueFlags(rest, ['chain-id', 'pool-address', 'transaction-hash']);
    return {
      command: 'sandwich',
      input: detectSandwichInputSchema.parse({
        chainId: requiredFlag(flags, 'chain-id'),
        poolAddress: requiredFlag(flags, 'pool-address'),
        transactionHash: requiredFlag(flags, 'transaction-hash'),
      }),
    };
  }
  throw invalidCommand('Unknown internal onchain query command.');
}

export async function runInternalOnchainQuery(
  args: readonly string[],
  io: InternalOnchainQueryIo = defaultIo(),
  dependencies: InternalOnchainQueryDependencies = {},
): Promise<number> {
  let mcpClient: ChainAnalysisMcpClient | undefined;
  try {
    const profile = dependencies.profile ?? 'development';
    const command = parseInternalOnchainQueryArgs(args);
    if (command.command === 'help') {
      io.stdout.write(`${helpText(profile)}\n`);
      return 0;
    }
    if (profile === 'development') {
      if (io.env.NODE_ENV === 'production') {
        throw new ChainOperationsCliError(
          'configuration_error',
          'Internal onchain query uses the development MCP profile and is disabled in production.',
        );
      }
      if (dependencies.createMcpClient === undefined) {
        throw new ChainOperationsCliError(
          'configuration_error',
          'The RPC-backed development query profile was removed; inject a browser-backed MCP client or use the XXYY diagnosis MCP.',
        );
      }
      mcpClient = dependencies.createMcpClient(io);
    } else {
      if (io.env.NODE_ENV !== 'production') {
        throw new ChainOperationsCliError(
          'configuration_error',
          'Production onchain query requires NODE_ENV=production.',
        );
      }
      if (dependencies.createMcpClient === undefined) {
        throw new ChainOperationsCliError(
          'configuration_error',
          'Production onchain query requires a readiness-gated MCP client.',
        );
      }
      mcpClient = dependencies.createMcpClient(io);
    }

    const capabilities = createInternalChainAnalysisCapabilityRegistry({
      caller: CALLER,
      mcpClient,
    });
    const tools = createToolRegistry();
    for (const tool of createInternalChainAnalysisTools({
      caller: CALLER,
      registry: capabilities,
    })) {
      tools.register(tool);
    }
    const requestId = `internal-onchain:${io.createRequestId()}`;
    const result = await tools.execute(toolName(command), command.input, {
      channel: CALLER.channel,
      requestId,
    });
    io.stdout.write(`${JSON.stringify({ command: command.command, result })}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify(formatError(error))}\n`);
    return 1;
  } finally {
    await mcpClient?.close().catch(() => undefined);
  }
}

function helpText(profile: InternalOnchainQueryProfile): string {
  const command = profile === 'production' ? 'pnpm onchain:query:production' : 'pnpm onchain:query';
  const profileNotice =
    profile === 'production'
      ? 'This internal cli/admin command requires NODE_ENV=production and the readiness-gated production MCP configuration.'
      : 'This internal cli/admin command uses the development MCP profile and is disabled when NODE_ENV=production.';
  return [
    'Usage:',
    `  ${command} -- transaction --reference <explorer-url-or-transaction-id> [--network <network>]`,
    `  ${command} -- inspect --chain-id <id> --transaction-hash <0x...>`,
    `  ${command} -- sandwich --chain-id <id> --transaction-hash <0x...> --pool-address <0x...>`,
    '',
    profileNotice,
  ].join('\n');
}

function toolName(
  command: Exclude<InternalOnchainQueryCommand, { command: 'help' }>,
): 'detect_sandwich' | 'get_transaction' | 'inspect_transaction' {
  switch (command.command) {
    case 'inspect':
      return 'inspect_transaction';
    case 'sandwich':
      return 'detect_sandwich';
    case 'transaction':
      return 'get_transaction';
  }
}

function parseValueFlags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  const allowedSet = new Set(allowed);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      throw invalidCommand('Command flags require explicit values.');
    }
    const name = flag.slice(2);
    if (!allowedSet.has(name) || result.has(name)) {
      throw invalidCommand('Command contains an unknown or duplicate flag.');
    }
    result.set(name, value);
  }
  return result;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw invalidCommand(`Command requires --${name}.`);
  }
  return value;
}

function invalidCommand(message: string): ChainOperationsCliError {
  return new ChainOperationsCliError('invalid_command', message);
}

function formatError(error: unknown): { code: string; message: string } {
  if (error instanceof ChainOperationsCliError || error instanceof ChainAnalysisMcpToolError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_input',
      message: 'Internal onchain query input failed validation.',
    };
  }
  return {
    code: 'query_failed',
    message: 'Internal onchain query failed without exposing provider details.',
  };
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
  process.exitCode = await runInternalOnchainQuery(process.argv.slice(2));
}
