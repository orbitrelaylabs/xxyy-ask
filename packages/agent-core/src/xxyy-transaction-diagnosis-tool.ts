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
      return formatXxyyTransactionDiagnosis(output);
    },
  };
}

export function formatXxyyTransactionDiagnosis(
  output: DiagnoseXxyyTransactionOutput,
): ChatResponse {
  const lines = [
    `交易：${output.transaction.transactionId}`,
    `链：${output.transaction.network}`,
    `链上结果：${output.transaction.summary}`,
    ...transactionFactLines(output.transaction),
  ];
  if (output.market?.status === 'exact') {
    const trade = output.market.trade!;
    const pair = output.market.matchedPair!;
    lines.push(
      `买卖方向：${trade.type === 'buy' ? '买入' : '卖出'}`,
      `XXYY 交易者：${trade.maker}`,
      `XXYY 成交时间：${new Date(trade.timestamp).toISOString()}`,
      `实际成交池：${pair.pairAddress}${pair.dexId === undefined ? '' : `（DEX: ${pair.dexId}）`}`,
      `交易币：${pair.baseToken}；报价币：${pair.quoteToken}`,
      `成交数量：代币 ${trade.tokenAmount}；原生币 ${trade.nativeAmount}${trade.usdAmount === undefined ? '' : `；约 $${trade.usdAmount}`}`,
      ...(trade.marketCapUsd === undefined ? [] : [`成交时市值：约 $${trade.marketCapUsd}`]),
    );
  } else {
    lines.push(`XXYY 成交匹配：${output.market?.status ?? '未执行'}。`);
  }
  if (output.poolAssessment !== undefined) {
    const pool = output.poolAssessment;
    lines.push(
      `池子结论：${canonicalMatchLabel(pool.canonicalMatch)}；${liquidityClassLabel(pool.liquidityClass)}。`,
      ...(pool.actualLiquidityUsd === undefined
        ? []
        : [`实际池流动性：$${pool.actualLiquidityUsd}`]),
      ...(pool.dominantPoolAddress === undefined
        ? []
        : [
            `主导池：${pool.dominantPoolAddress}${pool.dominantLiquidityUsd === undefined ? '' : `，流动性 $${pool.dominantLiquidityUsd}`}`,
          ]),
      ...(pool.relativeLiquidityPpm === undefined
        ? []
        : [`实际池约为主导池流动性的 ${ppmPercent(pool.relativeLiquidityPpm)}。`]),
      `池子判定依据：${pool.reasonCodes.join(', ')}；策略版本 ${pool.policyVersion}。`,
    );
    const candidates = output.market?.candidatePairs ?? [];
    if (candidates.length > 0) {
      lines.push(
        `候选池（${candidates.length} 个，最多展示 5 个）：${candidates
          .slice(0, 5)
          .map(
            (candidate) =>
              `${candidate.pairAddress}${candidate.liquidityUsd === undefined ? '' : ` / $${candidate.liquidityUsd}`}`,
          )
          .join('；')}`,
      );
    }
  }
  if (output.sandwichAssessment !== undefined) {
    const sandwich = output.sandwichAssessment;
    lines.push(
      `Sandwich 结论：${sandwichVerdictLabel(sandwich.verdict)}。`,
      `判定条件：${sandwichCriteriaLine(sandwich.criteria)}。`,
      `判定依据：${sandwich.reasonCodes.join(', ')}。`,
    );
    if (sandwich.candidateActor !== undefined) {
      lines.push(`前后交易候选地址：${sandwich.candidateActor}`);
    }
    if (sandwich.frontTransactionId !== undefined) {
      lines.push(`前置交易：${sandwich.frontTransactionId}`);
    }
    if (sandwich.backTransactionId !== undefined) {
      lines.push(`后置交易：${sandwich.backTransactionId}`);
    }
    if (sandwich.victimLossRaw !== undefined) {
      lines.push(
        `目标交易反事实损失：${sandwich.victimLossRaw} 原始单位${sandwich.victimLossPpm === undefined ? '' : `（${ppmPercent(sandwich.victimLossPpm)}）`}`,
      );
    }
    if (sandwich.attackerProfitRaw !== undefined) {
      lines.push(
        `候选地址收益：${sandwich.attackerProfitRaw} 原始单位${sandwich.profitToken === undefined ? '' : `，资产 ${sandwich.profitToken}`}`,
      );
    }
  }
  if ((output.surroundingTrades?.length ?? 0) > 0) {
    lines.push('XXYY 目标交易周边成交（按 XXYY 时间与列表位置，仅作交叉查证）：');
    for (const trade of output.surroundingTrades!) {
      lines.push(formatSurroundingTrade(trade));
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
              delivery: 'required' as const,
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

function canonicalMatchLabel(value: 'matches' | 'does_not_match' | 'unknown'): string {
  if (value === 'matches') return '实际池与已配置的正确池一致';
  if (value === 'does_not_match') return '实际池与已配置的正确池不一致';
  return '未配置可验证的正确池，无法判断是否买错池';
}

function liquidityClassLabel(value: 'normal' | 'small' | 'unknown'): string {
  if (value === 'small') return '按当前策略属于小流动性池';
  if (value === 'normal') return '按当前策略不属于小流动性池';
  return '缺少流动性数据，无法判断是否为小池';
}

function sandwichVerdictLabel(
  value: 'confirmed' | 'likely' | 'unlikely' | 'insufficient_data',
): string {
  if (value === 'confirmed') return '已确认存在 Sandwich 证据';
  if (value === 'likely') return '疑似 Sandwich，但证据覆盖不完整';
  if (value === 'unlikely') return '当前完整证据不支持 Sandwich';
  return '证据不足，无法可靠判断';
}

function sandwichCriteriaLine(
  criteria: NonNullable<DiagnoseXxyyTransactionOutput['sandwichAssessment']>['criteria'],
): string {
  return [
    `同区块/Slot=${criteria.sameBlockOrSlot}`,
    `同池=${criteria.samePool}`,
    `前后顺序=${criteria.transactionOrder}`,
    `双向买卖=${criteria.twoSidedDirection}`,
    `地址资产闭环=${criteria.actorLoop}`,
    `目标受到不利影响=${criteria.adverseVictimImpact}`,
    `候选地址获利=${criteria.profitableActor}`,
  ].join('，');
}

function formatSurroundingTrade(
  trade: NonNullable<DiagnoseXxyyTransactionOutput['surroundingTrades']>[number],
): string {
  const relation =
    trade.relation === 'earlier'
      ? '目标前候选'
      : trade.relation === 'later'
        ? '目标后候选'
        : '与目标同时间候选';
  const chainPosition =
    trade.blockNumber === undefined
      ? trade.slot === undefined
        ? '区块/Slot 未解析'
        : `Slot ${trade.slot}`
      : `区块 ${trade.blockNumber}`;
  return `- ${relation}：${trade.type === 'buy' ? '买入' : '卖出'}，时间 ${new Date(trade.timestamp).toISOString()}，地址 ${trade.maker}，交易 ${trade.transactionId}，代币 ${trade.tokenAmount}，原生币 ${trade.nativeAmount}${trade.usdAmount === undefined ? '' : `，约 $${trade.usdAmount}`}，${chainPosition}`;
}

function ppmPercent(value: number | string): string {
  const ppm = BigInt(value);
  const whole = ppm / 10_000n;
  const fraction = (ppm % 10_000n).toString().padStart(4, '0').replace(/0+$/u, '');
  return `${whole}${fraction.length === 0 ? '' : `.${fraction}`}%`;
}

function formatUnixSeconds(value: string): string {
  const milliseconds = Number(BigInt(value) * 1_000n);
  return Number.isSafeInteger(milliseconds)
    ? `${new Date(milliseconds).toISOString()}（Unix ${value}）`
    : `Unix ${value}`;
}

function transactionFactLines(transaction: DiagnoseXxyyTransactionOutput['transaction']): string[] {
  if (transaction.family === 'evm') {
    const fact = transaction.analysis.transaction;
    return [
      `执行状态：${fact.executionStatus}`,
      ...(fact.blockNumber === undefined ? [] : [`区块：${fact.blockNumber}`]),
      ...(fact.blockTimestamp === undefined
        ? []
        : [`区块时间：${formatUnixSeconds(fact.blockTimestamp)}`]),
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
    ...(fact.sources.some((source) => source.kind === 'explorer_browser')
      ? ['交易证据源：固定 Explorer 浏览器页面（部分证据）']
      : []),
    `执行状态：${fact.executionStatus}`,
    `Slot：${fact.slot}`,
    ...(fact.blockTime === undefined ? [] : [`区块时间：${fact.blockTime}`]),
    ...(fact.feeLamports === undefined ? [] : [`手续费：${fact.feeLamports} lamports`]),
    `涉及 Token mint：${[...new Set(fact.tokenBalanceChanges.map((item) => item.mint))].join('、') || '未解析'}`,
  ];
}
