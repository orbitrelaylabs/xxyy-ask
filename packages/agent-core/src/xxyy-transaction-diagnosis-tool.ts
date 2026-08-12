import { chatResponseSchema, type ChatResponse } from '@xxyy/shared';
import {
  diagnoseXxyyTransactionInputSchema,
  diagnoseXxyyTransactionOutputSchema,
  findBuiltInEvmNetworkByChainId,
  type DiagnoseXxyyTransactionOutput,
} from '@xxyy/transaction-skill-bridge';

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
  const headline = diagnosisHeadline(output);
  const lines = [
    `**${headline.icon} ${headline.text}**`,
    '',
    '**📌 交易概览**',
    `交易：\`${output.transaction.transactionId}\``,
    `链：${transactionNetworkLabel(output.transaction)}`,
    ...transactionFactLines(output.transaction),
  ];
  if (transactionWasNotFound(output.transaction)) {
    lines.push(
      '⚠️ Explorer 查无这笔交易。Solana 签名区分大小写，请从钱包重新复制完整签名后再查。',
      '在交易被公开 Explorer 精确解析前，无法安全确认目标合约、本笔成交池或该合约的池子清单。',
    );
  }
  if (output.market?.status === 'exact') {
    const trade = output.market.trade!;
    const pair = output.market.matchedPair!;
    lines.push(
      '',
      '**🧾 XXYY 成交**',
      `买卖方向：${trade.type === 'buy' ? '买入' : '卖出'}`,
      `交易者：\`${trade.maker}\``,
      `XXYY 成交时间：${new Date(trade.timestamp).toISOString()}`,
      `交易币：\`${pair.baseToken}\``,
      `报价币：\`${pair.quoteToken}\``,
      `成交数量：代币 ${formatDecimal(trade.tokenAmount, 6)}；原生币 ${formatDecimal(trade.nativeAmount, 8)}${trade.usdAmount === undefined ? '' : `；约 $${formatDecimal(trade.usdAmount, 2)}`}`,
      ...(trade.marketCapUsd === undefined
        ? []
        : [`成交时市值：约 $${formatDecimal(trade.marketCapUsd, 2)}`]),
    );
  } else {
    lines.push(
      '',
      '**🧾 XXYY 成交**',
      output.market?.status === 'conflict'
        ? output.executionPools?.length
          ? '发现多个成交候选；已改用 Explorer Event Logs 定位本笔实际执行池。'
          : '发现多个相互冲突的成交候选，无法安全选定目标记录。'
        : '未能按完整交易哈希匹配到目标成交，因此无法确认本笔成交池，也暂时无法判断是否被夹。',
    );
  }
  const candidatePools = sortedCandidatePools(output.market?.candidatePairs ?? []);
  const executionPools = output.executionPools ?? [];
  const executionPoolIds = new Set(
    executionPools.map((executionPool) => executionPool.poolIdentifier.toLowerCase()),
  );
  if (
    output.poolAssessment !== undefined ||
    candidatePools.length > 0 ||
    executionPools.length > 0
  ) {
    const pool = output.poolAssessment;
    lines.push(
      '',
      '**🏊 合约与池子**',
      ...(candidatePools[0] === undefined ? [] : [`目标合约：\`${candidatePools[0].baseToken}\``]),
      ...(output.market?.matchedPair === undefined
        ? executionPools.length === 0
          ? ['本笔成交池：未能按完整交易哈希确认。']
          : executionPools.length === 1
            ? [
                `本笔执行池（Explorer Event Logs）：\`${executionPools[0]!.poolIdentifier}\`（日志 #${executionPools[0]!.logIndex}）`,
              ]
            : [
                `本笔由路由拆分到 ${executionPools.length} 个执行池（Explorer Event Logs）：`,
                ...executionPools.map(
                  (executionPool, index) =>
                    `${index + 1}. \`${executionPool.poolIdentifier}\`（日志 #${executionPool.logIndex}）`,
                ),
              ]
        : [
            `本笔成交池：\`${output.market.matchedPair.pairAddress}\`（${dexLabel(output.market.matchedPair.dexId)}）`,
          ]),
      ...(pool === undefined
        ? []
        : [
            `池子结论：${canonicalMatchLabel(pool.canonicalMatch)}；${liquidityClassLabel(pool.liquidityClass)}。`,
          ]),
      ...(pool?.actualLiquidityUsd === undefined
        ? []
        : [`本笔池流动性：约 $${formatDecimal(pool.actualLiquidityUsd, 2)}`]),
      ...(pool?.dominantPoolAddress === undefined
        ? []
        : [
            `当前主导池：\`${pool.dominantPoolAddress}\`${pool.dominantLiquidityUsd === undefined ? '' : `，约 $${formatDecimal(pool.dominantLiquidityUsd, 2)}`}`,
          ]),
      ...(pool?.relativeLiquidityPpm === undefined
        ? []
        : [`实际池约为主导池流动性的 ${ppmPercent(pool.relativeLiquidityPpm)}。`]),
    );
    if (candidatePools.length > 0) {
      lines.push(`XXYY 当前发现 ${candidatePools.length} 个池子：`);
      candidatePools.forEach((candidate, index) => {
        const isMatchedTrade = candidate.pairAddress === output.market?.matchedPair?.pairAddress;
        const isObservedExecution = executionPoolIds.has(candidate.pairAddress.toLowerCase());
        lines.push(
          `${index + 1}. ${isMatchedTrade ? '✅ 本笔成交 · ' : isObservedExecution ? '✅ 本笔执行 · ' : ''}${dexLabel(candidate.dexId)} · ${candidate.liquidityUsd === undefined ? '流动性未知' : `约 $${formatDecimal(candidate.liquidityUsd, 2)}`}`,
          `   池：\`${candidate.pairAddress}\`｜报价：\`${candidate.quoteToken}\``,
        );
      });
    }
  }
  if (output.sandwichAssessment !== undefined) {
    const sandwich = output.sandwichAssessment;
    lines.push(
      '',
      '**🥪 Sandwich 检查**',
      `Sandwich 结论：${sandwichVerdictLabel(sandwich.verdict)}。`,
      `判定条件：${sandwichCriteriaLine(sandwich.criteria)}。`,
    );
    if (
      sandwich.candidateActor !== undefined &&
      (sandwich.verdict === 'confirmed' || sandwich.verdict === 'likely')
    ) {
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
    lines.push('', '**↔️ 目标交易前后成交**');
    for (const trade of nearestSurroundingTrades(output.surroundingTrades!)) {
      lines.push(formatSurroundingTrade(trade));
    }
  }
  if (output.warnings.length > 0) {
    const limits = [...new Set(output.warnings.map(evidenceLimitLabel))];
    lines.push('', '**ℹ️ 证据范围**', ...limits.map((warning) => `• ${warning}`));
  }
  lines.push(
    output.screenshotEvidence.status === 'ready'
      ? '已附上与完整交易哈希、交易者和池子交叉校验的 XXYY 原生页面截图。'
      : screenshotUnavailableLabel(output.screenshotEvidence.reason),
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
              excerpt: `XXYY 已按完整交易哈希、交易者 ${artifact.maker} 和池子 ${artifact.pairAddress} 交叉验证目标成交。`,
              file: 'xxyy-market-evidence',
              sourceUrl: artifact.sourceUrl,
              title: 'XXYY 最新成交查证',
            },
          ],
    confidence: output.status === 'success' ? 0.9 : output.status === 'partial' ? 0.65 : 0.35,
    intent: 'onchain_transaction',
  }) as ChatResponse;
}

function diagnosisHeadline(output: DiagnoseXxyyTransactionOutput): {
  icon: string;
  text: string;
} {
  const verdict = output.sandwichAssessment?.verdict;
  if (verdict === 'confirmed') return { icon: '🚨', text: '确认存在 Sandwich 证据' };
  if (verdict === 'likely') return { icon: '⚠️', text: '疑似被夹，仍需补充证据' };
  if (verdict === 'unlikely') return { icon: '✅', text: '当前证据不支持被夹' };
  return { icon: '🔎', text: '被夹检查：证据不足' };
}

function transactionWasNotFound(
  transaction: DiagnoseXxyyTransactionOutput['transaction'],
): boolean {
  return transaction.diagnostics.some(
    (diagnostic) =>
      typeof diagnostic === 'object' &&
      diagnostic !== null &&
      'code' in diagnostic &&
      diagnostic.code === 'transaction_not_found',
  );
}

function sortedCandidatePools(
  pools: readonly NonNullable<DiagnoseXxyyTransactionOutput['market']>['candidatePairs'][number][],
) {
  return [...pools].sort((left, right) => {
    const liquidityDifference =
      numericLiquidity(right.liquidityUsd) - numericLiquidity(left.liquidityUsd);
    return liquidityDifference === 0
      ? left.pairAddress.localeCompare(right.pairAddress)
      : liquidityDifference;
  });
}

function numericLiquidity(value: string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function dexLabel(dexId: string | undefined): string {
  if (dexId === undefined) return 'DEX 未标注';
  const labels: Record<string, string> = {
    dammv2: 'Meteora DYN2',
    dlmm: 'Meteora DLMM',
    orca: 'Orca',
    pfamm: 'Pump AMM',
  };
  return labels[dexId.toLowerCase()] ?? dexId;
}

function transactionNetworkLabel(
  transaction: DiagnoseXxyyTransactionOutput['transaction'],
): string {
  if (transaction.family === 'solana') return 'Solana';
  return findBuiltInEvmNetworkByChainId(transaction.chainId)?.name ?? transaction.network;
}

function evidenceLimitLabel(warning: string): string {
  if (warning.startsWith('Transaction facts came from')) {
    return '链上事实来自固定公开 Explorer 页面，属于单一来源的部分证据。';
  }
  if (warning.startsWith('XXYY did not return')) {
    return 'XXYY 未返回唯一的完整交易哈希匹配。';
  }
  if (warning.startsWith('Sandwich analysis requires')) {
    return '只有精确匹配目标成交后才能分析前后夹子结构。';
  }
  if (warning.startsWith('Browser and XXYY rows can support')) {
    return '结论基于 Explorer 与 XXYY 前后成交结构，不包含池状态、攻击者收益或反事实损失证明。';
  }
  if (warning.startsWith('Some surrounding XXYY trades')) {
    return '部分周边成交未能解析到区块或 Slot。';
  }
  if (warning.startsWith('Explorer event logs show')) {
    return 'Explorer Event Logs 显示该交易由路由拆分到多个 Swap 池。';
  }
  return '部分证据暂不可用，结论按现有可核验数据给出。';
}

function screenshotUnavailableLabel(
  reason: 'capture_failed' | 'not_configured' | 'trade_not_exactly_matched' | undefined,
): string {
  if (reason === 'capture_failed') {
    return '截图：已匹配目标成交，但 XXYY 原生页面截图生成失败。';
  }
  if (reason === 'not_configured') return '截图：当前环境未启用截图能力。';
  return '截图：未精确匹配目标成交，因此未生成。';
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
  if (value === 'unlikely') return '当前完整相邻成交证据不支持 Sandwich 结构';
  return '证据不足，无法可靠判断';
}

function sandwichCriteriaLine(
  criteria: NonNullable<DiagnoseXxyyTransactionOutput['sandwichAssessment']>['criteria'],
): string {
  return [
    `同区块/Slot=${criteriaValueLabel(criteria.sameBlockOrSlot)}`,
    `同池=${criteriaValueLabel(criteria.samePool)}`,
    `前后顺序=${criteriaValueLabel(criteria.transactionOrder)}`,
    `双向买卖=${criteriaValueLabel(criteria.twoSidedDirection)}`,
    `地址资产闭环=${criteriaValueLabel(criteria.actorLoop)}`,
    `目标受到不利影响=${criteriaValueLabel(criteria.adverseVictimImpact)}`,
    `候选地址获利=${criteriaValueLabel(criteria.profitableActor)}`,
  ].join('，');
}

function criteriaValueLabel(value: 'no' | 'unknown' | 'yes'): string {
  return value === 'yes' ? '是' : value === 'no' ? '否' : '未知';
}

function nearestSurroundingTrades(
  trades: readonly NonNullable<DiagnoseXxyyTransactionOutput['surroundingTrades']>[number][],
) {
  const earlier = trades
    .filter((trade) => trade.relation === 'earlier')
    .sort((left, right) => right.timestamp - left.timestamp)[0];
  const later = trades
    .filter((trade) => trade.relation === 'later')
    .sort((left, right) => left.timestamp - right.timestamp)[0];
  return [earlier, later].filter(
    (trade): trade is NonNullable<typeof trade> => trade !== undefined,
  );
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
  return `- ${relation}：${trade.type === 'buy' ? '买入' : '卖出'}，时间 ${new Date(trade.timestamp).toISOString()}，地址 \`${trade.maker}\`，交易 \`${trade.transactionId}\`，代币 ${formatDecimal(trade.tokenAmount, 6)}，原生币 ${formatDecimal(trade.nativeAmount, 8)}${trade.usdAmount === undefined ? '' : `，约 $${formatDecimal(trade.usdAmount, 2)}`}，${chainPosition}`;
}

function formatDecimal(value: string, maximumFractionDigits: number): string {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString('en-US', { maximumFractionDigits, useGrouping: true })
    : value;
}

function ppmPercent(value: number | string): string {
  const ppm = BigInt(value);
  const whole = ppm / 10_000n;
  const fraction = (ppm % 10_000n).toString().padStart(4, '0').replace(/0+$/u, '');
  return `${whole}${fraction.length === 0 ? '' : `.${fraction}`}%`;
}

function transactionFactLines(transaction: DiagnoseXxyyTransactionOutput['transaction']): string[] {
  if (transaction.family === 'evm') {
    const fact = transaction.analysis.transaction;
    const tokenAddresses = extractEvmTokenAddresses(transaction);
    return [
      `执行状态：${fact.executionStatus === 'success' ? '✅ 成功' : fact.executionStatus === 'reverted' ? '❌ 失败' : '⚠️ 未知'}`,
      ...(fact.failureReason === undefined ? [] : [`失败原因：\`${fact.failureReason}\``]),
      ...(fact.blockNumber === undefined ? [] : [`区块：\`${fact.blockNumber}\``]),
      ...(fact.blockTimestamp === undefined
        ? []
        : [`区块时间：${new Date(Number(fact.blockTimestamp) * 1_000).toISOString()}`]),
      ...(fact.feeWei === undefined
        ? []
        : [`Gas 费用：${formatEvmWei(fact.feeWei, fact.chainId)}`]),
      ...(fact.from === undefined ? [] : [`交易发起地址：\`${fact.from}\``]),
      `目标 Token：${tokenAddresses.map((address) => `\`${address}\``).join('、') || '未解析'}`,
    ];
  }
  const fact = transaction.analysis;
  if (fact === undefined) return ['Solana 交易详情：当前 Provider 未返回可验证快照。'];
  return [
    ...(fact.sources.some((source: { kind: string }) => source.kind === 'explorer_browser')
      ? ['交易证据源：固定 Explorer 浏览器页面（部分证据）']
      : []),
    `执行状态：${fact.executionStatus}`,
    `Slot：${fact.slot}`,
    ...(fact.blockTime === undefined ? [] : [`区块时间：${fact.blockTime}`]),
    ...(fact.feeLamports === undefined ? [] : [`手续费：${fact.feeLamports} lamports`]),
    `涉及 Token mint：${
      [...new Set(fact.tokenBalanceChanges.map((item: { mint: string }) => item.mint))].join(
        '、',
      ) || '未解析'
    }`,
  ];
}

function formatEvmWei(value: string, chainId: string): string {
  const wei = BigInt(value);
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = (wei % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, '0')
    .replace(/0+$/u, '');
  const amount = `${whole}${fraction.length === 0 ? '' : `.${fraction}`}`;
  const symbol = chainId === '56' ? ' BNB' : chainId === '1' || chainId === '8453' ? ' ETH' : '';
  return `${amount}${symbol}（\`${value}\` wei）`;
}

export function extractEvmTokenAddresses(
  transaction: Extract<DiagnoseXxyyTransactionOutput['transaction'], { family: 'evm' }>,
): string[] {
  const addresses = new Set<string>(
    transaction.analysis.tokenTransfers.map((item: { tokenAddress: string }) =>
      item.tokenAddress.toLowerCase(),
    ),
  );
  for (const evidence of transaction.analysis.evidence) {
    const structuredData = evidence.structuredData;
    if (
      structuredData === null ||
      typeof structuredData !== 'object' ||
      Array.isArray(structuredData)
    ) {
      continue;
    }
    const candidates = structuredData.tokenAddresses;
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && /^0x[0-9a-f]{40}$/iu.test(candidate)) {
        addresses.add(candidate.toLowerCase());
      }
    }
  }
  return [...addresses];
}
