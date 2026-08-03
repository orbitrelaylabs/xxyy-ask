import { chatResponseSchema, type ChatResponse } from '@xxyy/shared';
import {
  diagnoseXxyyTransactionInputSchema,
  diagnoseXxyyTransactionOutputSchema,
  type DiagnoseXxyyTransactionOutput,
} from '@xxyy/xxyy-onchain-support-mcp';

import type { CapabilityRegistry } from './capability-registry.js';
import type { PublicChainAnalysisCaller } from './chain-analysis-capabilities.js';
import type { ToolDefinition } from './tool-registry.js';
import { XXYY_DIAGNOSIS_SKILL_CAPABILITY_ID } from './xxyy-transaction-diagnosis-capabilities.js';

export const PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME = 'diagnose_xxyy_transaction';

export function createPublicXxyyTransactionDiagnosisTool(options: {
  caller: PublicChainAnalysisCaller;
  registry: CapabilityRegistry;
}): ToolDefinition<
  typeof PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME,
  typeof diagnoseXxyyTransactionInputSchema,
  typeof chatResponseSchema
> {
  return {
    name: PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME,
    description:
      'Diagnose exactly one user-supplied public EVM or Solana transaction for Sandwich evidence and/or wrong/small pool selection using normalized chain facts and exact XXYY market evidence. Never use for wallet history, identity, investment advice, or execution.',
    inputSchema: diagnoseXxyyTransactionInputSchema,
    outputSchema: chatResponseSchema,
    async execute(input, context) {
      const output = diagnoseXxyyTransactionOutputSchema.parse(
        await options.registry.invoke(XXYY_DIAGNOSIS_SKILL_CAPABILITY_ID, input, {
          channel: options.caller.channel,
          principal: options.caller.principal,
          ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
        }),
      );
      return formatDiagnosis(output);
    },
  };
}

function formatDiagnosis(output: DiagnoseXxyyTransactionOutput): ChatResponse {
  const lines = [
    `交易：${output.transaction.transactionId}`,
    `链：${output.transaction.network}`,
    `链上结果：${output.transaction.summary}`,
    ...transactionFactLines(output.transaction),
  ];
  if (output.market?.status === 'exact') {
    lines.push(
      `XXYY 成交：${output.market.trade!.type}，maker ${output.market.trade!.maker}，池子 ${output.market.matchedPair!.pairAddress}，代币数量 ${output.market.trade!.tokenAmount}，原生币数量 ${output.market.trade!.nativeAmount}${output.market.trade!.usdAmount === undefined ? '' : `，约 $${output.market.trade!.usdAmount}`}`,
    );
  } else {
    lines.push(`XXYY 成交匹配：${output.market?.status ?? '未执行'}。`);
  }
  if (output.poolAssessment !== undefined) {
    lines.push(
      `池子判断：canonicalMatch=${output.poolAssessment.canonicalMatch}，liquidityClass=${output.poolAssessment.liquidityClass}，策略版本=${output.poolAssessment.policyVersion}。`,
    );
  }
  if (output.sandwichAssessment !== undefined) {
    lines.push(
      `Sandwich 判断：${output.sandwichAssessment.verdict}（${output.sandwichAssessment.reasonCodes.join(', ')}）。`,
    );
    if (output.sandwichAssessment.frontTransactionId !== undefined) {
      lines.push(`前置交易：${output.sandwichAssessment.frontTransactionId}`);
    }
    if (output.sandwichAssessment.backTransactionId !== undefined) {
      lines.push(`后置交易：${output.sandwichAssessment.backTransactionId}`);
    }
  }
  if (output.warnings.length > 0) {
    lines.push(`证据限制：${output.warnings.join('；')}`);
  }
  lines.push(
    output.screenshotEvidence.status === 'ready'
      ? '已附上与完整交易哈希、maker 和池子交叉校验的 XXYY 截图。'
      : `XXYY 截图不可用：${output.screenshotEvidence.reason}。`,
  );
  const artifact = output.screenshotEvidence.artifact;
  return chatResponseSchema.parse({
    agentRoute: 'chain_answer',
    answer: lines.join('\n'),
    ...(artifact === undefined
      ? {}
      : {
          attachments: [
            {
              kind: 'image' as const,
              mediaType: artifact.mediaType,
              title: artifact.title,
              url: artifact.url,
            },
          ],
        }),
    citations:
      artifact === undefined
        ? []
        : [
            {
              excerpt: `Exact XXYY row for transaction ${artifact.transactionId}, maker ${artifact.maker}, pair ${artifact.pairAddress}.`,
              file: 'xxyy-market-evidence',
              sourceUrl: artifact.sourceUrl,
              title: 'XXYY latest trades evidence',
            },
          ],
    confidence: output.status === 'success' ? 0.9 : output.status === 'partial' ? 0.65 : 0.35,
    intent: 'onchain_transaction',
  }) as ChatResponse;
}

function transactionFactLines(transaction: DiagnoseXxyyTransactionOutput['transaction']): string[] {
  if (transaction.family === 'evm') {
    const fact = transaction.analysis.transaction;
    return [
      `执行状态：${fact.executionStatus}`,
      ...(fact.blockNumber === undefined ? [] : [`区块：${fact.blockNumber}`]),
      ...(fact.blockTimestamp === undefined ? [] : [`区块时间戳：${fact.blockTimestamp}`]),
      ...(fact.feeWei === undefined ? [] : [`Gas 费用：${fact.feeWei} wei`]),
      ...(fact.from === undefined ? [] : [`交易发起地址：${fact.from}`]),
      `涉及 Token：${
        [...new Set(transaction.analysis.tokenTransfers.map((item) => item.tokenAddress))].join(
          '、',
        ) || '未解析'
      }`,
    ];
  }
  const fact = transaction.analysis;
  if (fact === undefined) return ['Solana 交易详情：当前 Provider 未返回可验证快照。'];
  return [
    `执行状态：${fact.executionStatus}`,
    `Slot：${fact.slot}`,
    ...(fact.blockTime === undefined ? [] : [`区块时间：${fact.blockTime}`]),
    ...(fact.feeLamports === undefined ? [] : [`手续费：${fact.feeLamports} lamports`]),
    `涉及 Token mint：${[...new Set(fact.tokenBalanceChanges.map((item) => item.mint))].join('、') || '未解析'}`,
  ];
}
