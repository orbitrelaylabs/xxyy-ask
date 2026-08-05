import { describe, expect, it, vi } from 'vitest';

import {
  createPublicTransactionClientStub,
  EgoBrowserUnavailableError,
  ExplorerBrowserVerificationError,
  getTransactionOutputSchema,
  type GetTransactionOutput,
} from '@orbitrelaylabs/xxyy-transaction-agent-kit/runtime';

import { createPublicChainAnalysisCapabilityRegistry } from './chain-analysis-capabilities.js';
import {
  createPublicChainTransactionTool,
  hasPublicTransactionReference,
  resolveSinglePublicTransactionInput,
} from './public-transaction-tool.js';

const hash = `0x${'1'.repeat(64)}`;

describe('public browser transaction Skill tool', () => {
  it('resolves fixed Explorer links and formats partial browser evidence', async () => {
    const getTransaction = vi.fn(async () => transactionOutput());
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const registry = createPublicChainAnalysisCapabilityRegistry({
      caller,
      client: createPublicTransactionClientStub(getTransaction),
    });
    const tool = createPublicChainTransactionTool({ caller, registry });

    const output = await tool.execute(
      { query: `查询 https://bscscan.com/tx/${hash}` },
      { channel: 'web', requestId: 'req-browser' },
    );
    expect(output).toMatchObject({
      agentRoute: 'chain_answer',
      citations: [{ sourceUrl: `https://bscscan.com/tx/${hash}` }],
      intent: 'onchain_transaction',
    });
    expect(output.answer).toContain('部分单源证据');
    expect(output.answer).toContain('不包含 RPC 共识、调用追踪或确定性 MEV 结论');
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it('requires a network for a bare EVM hash', async () => {
    const caller = { channel: 'web' as const, principal: 'anonymous' as const };
    const registry = createPublicChainAnalysisCapabilityRegistry({
      caller,
      client: createPublicTransactionClientStub(async () => transactionOutput()),
    });
    const output = await createPublicChainTransactionTool({ caller, registry }).execute(
      { query: hash },
      { channel: 'web' },
    );
    expect(output.agentRoute).toBe('clarify');
    expect(output.answer).toContain('无法确定网络');
  });

  it('makes a reverted transaction reason and readable native amounts prominent', async () => {
    const caller = { channel: 'telegram' as const, principal: 'service' as const };
    const registry = createPublicChainAnalysisCapabilityRegistry({
      caller,
      client: createPublicTransactionClientStub(async () =>
        transactionOutput({
          failureReason: "Fail with Custom Error 'SafeTransferFailed ()'",
          status: 'reverted',
        }),
      ),
    });

    const output = await createPublicChainTransactionTool({ caller, registry }).execute(
      { query: `https://bscscan.com/tx/${hash}` },
      { channel: 'telegram' },
    );

    expect(output.answer).toContain('🚨 BNB Smart Chain 交易执行失败');
    expect(output.answer).toContain('**❌ 失败原因**');
    expect(output.answer).toContain('SafeTransferFailed ()');
    expect(output.answer).toContain('0.5 BNB');
  });

  it('exposes deterministic reference helpers for routing', () => {
    expect(hasPublicTransactionReference(`https://bscscan.com/tx/${hash}`)).toBe(true);
    expect(resolveSinglePublicTransactionInput(`BSC ${hash}`)).toEqual({
      network: 'eip155:56',
      reference: hash,
    });
  });

  it('returns an actionable response when Explorer requires interactive verification', async () => {
    const caller = { channel: 'telegram' as const, principal: 'service' as const };
    const registry = createPublicChainAnalysisCapabilityRegistry({
      caller,
      client: createPublicTransactionClientStub(async () => {
        throw new ExplorerBrowserVerificationError('bscscan.com');
      }),
    });

    const output = await createPublicChainTransactionTool({ caller, registry }).execute(
      { query: `https://bscscan.com/tx/${hash}` },
      { channel: 'telegram' },
    );

    expect(output.agentRoute).toBe('clarify');
    expect(output.answer).toContain('人机验证');
    expect(output.answer).toContain('不会自动绕过验证');
  });

  it('returns an installation hint when ego-browser is unavailable', async () => {
    const caller = { channel: 'telegram' as const, principal: 'service' as const };
    const registry = createPublicChainAnalysisCapabilityRegistry({
      caller,
      client: createPublicTransactionClientStub(async () => {
        throw new EgoBrowserUnavailableError();
      }),
    });

    const output = await createPublicChainTransactionTool({ caller, registry }).execute(
      { query: `https://bscscan.com/tx/${hash}` },
      { channel: 'telegram' },
    );

    expect(output.answer).toContain('https://lite.ego.app/');
    expect(output.answer).toContain('产品知识问答不受影响');
  });
});

function transactionOutput(
  options: {
    failureReason?: string;
    status?: 'reverted' | 'success';
  } = {},
): GetTransactionOutput {
  return getTransactionOutputSchema.parse({
    analysis: {
      assetChanges: [],
      conflicts: [],
      diagnostics: [],
      evidence: [],
      findings: [],
      skill: 'transaction_analysis',
      status: 'partial',
      summary: 'Browser evidence.',
      timeline: [],
      tokenTransfers: [],
      transaction: {
        blockNumber: '1',
        blockTimestamp: '1',
        chainId: '56',
        executionStatus: options.status ?? 'success',
        ...(options.failureReason === undefined ? {} : { failureReason: options.failureReason }),
        feeWei: '20810282400000000',
        from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        hash,
        inputKind: 'contract_call',
        to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        valueWei: '500000000000000000',
      },
      version: '1.0.0',
      warnings: [],
    },
    chainId: '56',
    diagnostics: [],
    explorerUrl: `https://bscscan.com/tx/${hash}`,
    family: 'evm',
    network: 'eip155:56',
    status: 'partial',
    summary: 'Browser evidence.',
    transactionId: hash,
  });
}
