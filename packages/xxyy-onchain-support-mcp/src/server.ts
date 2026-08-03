import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  DIAGNOSE_XXYY_TRANSACTION_TOOL_NAME,
  XXYY_ONCHAIN_SUPPORT_MCP_SERVER_NAME,
  XXYY_ONCHAIN_SUPPORT_MCP_VERSION,
  diagnoseXxyyTransactionInputSchema,
  diagnoseXxyyTransactionOutputSchema,
  type XxyyTransactionDiagnosisHandler,
} from './contracts.js';
import {
  XXYY_TRANSACTION_DIAGNOSIS_PROMPT_NAME,
  XXYY_TRANSACTION_DIAGNOSIS_SKILL_DESCRIPTION,
  XXYY_TRANSACTION_DIAGNOSIS_SKILL_INSTRUCTIONS,
  XXYY_TRANSACTION_DIAGNOSIS_SKILL_RESOURCE_URI,
} from './skill.js';

export const XXYY_ONCHAIN_SUPPORT_MCP_INSTRUCTIONS = [
  'Use this read-only server only for one user-supplied public transaction reference.',
  'Preserve four-state Sandwich verdicts and separate canonical-pool matching from liquidity classification.',
  'Never treat screenshots, shortened addresses, timestamps, or amounts as identity proof.',
  'Do not expose arbitrary RPC or HTTP endpoints and do not provide investment advice.',
].join(' ');

export function createXxyyOnchainSupportMcpServer(options: {
  handler: XxyyTransactionDiagnosisHandler;
  skillInstructions?: string;
}): McpServer {
  const skillInstructions =
    options.skillInstructions ?? XXYY_TRANSACTION_DIAGNOSIS_SKILL_INSTRUCTIONS;
  const server = new McpServer(
    { name: XXYY_ONCHAIN_SUPPORT_MCP_SERVER_NAME, version: XXYY_ONCHAIN_SUPPORT_MCP_VERSION },
    { instructions: XXYY_ONCHAIN_SUPPORT_MCP_INSTRUCTIONS },
  );
  server.registerTool(
    DIAGNOSE_XXYY_TRANSACTION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        'Diagnose one public transaction for exact XXYY trade evidence, pool selection, and strict Sandwich evidence.',
      inputSchema: diagnoseXxyyTransactionInputSchema,
      outputSchema: diagnoseXxyyTransactionOutputSchema,
      title: 'Diagnose XXYY Transaction',
    },
    async (input, request) => {
      try {
        const output = await options.handler.diagnoseXxyyTransaction(
          input,
          request.signal === undefined ? {} : { signal: request.signal },
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'tool_failure' }) }],
          isError: true,
        };
      }
    },
  );
  server.registerResource(
    'xxyy-transaction-diagnosis-skill',
    XXYY_TRANSACTION_DIAGNOSIS_SKILL_RESOURCE_URI,
    {
      description: XXYY_TRANSACTION_DIAGNOSIS_SKILL_DESCRIPTION,
      mimeType: 'text/markdown',
      title: 'XXYY Transaction Diagnosis Skill',
    },
    (uri) => ({
      contents: [{ mimeType: 'text/markdown', text: skillInstructions, uri: uri.href }],
    }),
  );
  server.registerPrompt(
    XXYY_TRANSACTION_DIAGNOSIS_PROMPT_NAME,
    {
      argsSchema: { question: z.string().trim().min(1) },
      description: XXYY_TRANSACTION_DIAGNOSIS_SKILL_DESCRIPTION,
      title: 'Diagnose an XXYY transaction',
    },
    ({ question }) => ({
      messages: [
        {
          content: { text: `${skillInstructions}\n\nUser question: ${question}`, type: 'text' },
          role: 'user',
        },
      ],
    }),
  );
  return server;
}
