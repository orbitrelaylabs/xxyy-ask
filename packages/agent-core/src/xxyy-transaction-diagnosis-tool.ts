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
import {
  estimateTransactionExecutionLoss,
  type TransactionLossEstimate,
} from './transaction-loss-estimate.js';
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
  if (output.market?.status === 'exact' || output.market?.status === 'multi_exact') {
    const trade = output.market.trade!;
    const pair = output.market.matchedPair!;
    lines.push(
      '',
      output.market.status === 'multi_exact' ? '**🧾 XXYY 选定分析成交腿**' : '**🧾 XXYY 成交**',
      ...(output.market.status === 'multi_exact'
        ? [
            `XXYY 共匹配 ${output.market.matchedTrades?.length ?? 0} 个执行池成交腿；选择其中成交规模最大的可覆盖池继续分析。`,
            `选定分析池：\`${pair.pairAddress}\`（${dexLabel(pair.dexId)}）`,
          ]
        : []),
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
      output.market?.status === 'conflict' && output.executionPools?.length
        ? '**🧾 XXYY 多池成交**'
        : '**🧾 XXYY 成交**',
      output.market?.status === 'conflict'
        ? output.executionPools?.length
          ? '同一交易哈希对应多个成交腿；已按 Explorer Event Logs 分别定位本笔实际执行池。'
          : '发现多个相互冲突的成交候选，无法安全选定目标记录。'
        : '未能按完整交易哈希匹配到目标成交，因此无法确认本笔成交池，也暂时无法判断是否被夹。',
    );
  }
  const candidatePools = sortedCandidatePools(output.market?.candidatePairs ?? []);
  const executionPools = output.executionPools ?? [];
  const executionPoolIds = new Set(
    executionPools.map((executionPool) => executionPool.poolIdentifier.toLowerCase()),
  );
  const executionCandidates = candidatePools.filter((candidate) =>
    executionPoolIds.has(candidate.pairAddress.toLowerCase()),
  );
  const nativeExecutionSymbol = inferNativeExecutionSymbol(output, executionCandidates);
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
            ? [formatExecutionPool(executionPools[0]!, candidatePools, nativeExecutionSymbol)]
            : [
                `本笔由路由拆分到 ${executionPools.length} 个执行池（Explorer Event Logs）：`,
                ...executionPools.map(
                  (executionPool, index) =>
                    `${index + 1}. ${formatExecutionPool(executionPool, candidatePools, nativeExecutionSymbol)}`,
                ),
                `XXYY 池列表已对应 ${executionCandidates.length}/${executionPools.length} 个本笔执行池。`,
              ]
        : [
            `${output.market.status === 'multi_exact' ? 'XXYY 选定分析池' : '本笔成交池'}：\`${output.market.matchedPair.pairAddress}\`（${dexLabel(output.market.matchedPair.dexId)}）`,
            ...(executionPools.length > 1
              ? [
                  `链上共执行 ${executionPools.length} 个池：`,
                  ...executionPools.map(
                    (executionPool, index) =>
                      `${index + 1}. ${formatExecutionPool(executionPool, candidatePools, nativeExecutionSymbol)}`,
                  ),
                  `XXYY 池列表已对应 ${executionCandidates.length}/${executionPools.length} 个本笔执行池。`,
                ]
              : []),
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
    if (candidatePools.length > 0 && executionPools.length === 0) {
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
  const lossEstimate = estimateTransactionExecutionLoss(output);
  if (lossEstimate !== undefined) {
    lines.push('', '**💸 用户损失估算**', ...formatLossEstimate(lossEstimate, output));
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

function formatLossEstimate(
  estimate: TransactionLossEstimate,
  output: DiagnoseXxyyTransactionOutput,
): string[] {
  const scope =
    estimate.scope === 'selected_trade_leg'
      ? '仅覆盖 XXYY 选定的分析成交腿，不代表整笔多池路由的总损失'
      : '覆盖当前精确匹配的 XXYY 成交';
  const findingLabel = estimate.relatedFindings
    .map((finding) => (finding === 'small_pool' ? '小流动性池' : '疑似 Sandwich'))
    .join('、');
  if (estimate.status === 'insufficient_data') {
    return [
      `关联发现：${findingLabel}。`,
      `估算范围：${scope}。`,
      estimate.reason === 'missing_prior_same_side_trade'
        ? '金额：数据不足；缺少目标成交前最近一笔同池、同方向 XXYY 成交，无法建立价格基准。'
        : '金额：数据不足；目标成交金额字段缺失或无效。',
      '说明：不会用池流动性大小直接猜测损失金额。',
    ];
  }

  const symbol = transactionNativeSymbol(output);
  const sideFormula =
    estimate.side === 'buy'
      ? '买入多付 = 实际支付原生币 − 实际获得代币 × 基准单价'
      : '卖出少收 = 实际卖出代币 × 基准单价 − 实际收到原生币';
  const common = [
    `关联发现：${findingLabel}${estimate.relatedFindings.length > 1 ? '；影响无法拆分，金额不能重复相加' : ''}。`,
    `估算范围：${scope}。`,
    `价格基准：目标成交前最近一笔同池、同方向 XXYY 成交 ${estimate.benchmarkTransactionId}。`,
    `实际均价：${formatEstimatedAmount(estimate.actualUnitPriceNative, 12)} ${symbol}/Token；基准均价：${formatEstimatedAmount(estimate.benchmarkUnitPriceNative, 12)} ${symbol}/Token。`,
    `计算：${sideFormula}。`,
  ];
  if (estimate.status === 'no_adverse_deviation') {
    return [
      ...common,
      '估算结果：按该相邻成交基准未观察到正向不利偏差（记为 0）；这不等同于证明用户没有损失。',
      '说明：该估算不是无攻击/主导池状态下的反事实损失证明，不含 Gas、Token 税、其他路由腿或价格继续波动。',
    ];
  }
  return [
    ...common,
    `估算不利偏差：约 ${formatEstimatedAmount(estimate.lossNativeAmount, 8)} ${symbol}${estimate.lossUsdAmount === undefined ? '' : `（约 $${formatEstimatedAmount(estimate.lossUsdAmount, 2)}）`}，约为基准应成交金额的 ${ppmPercent(estimate.lossPpm)}。`,
    '说明：这是相邻同池成交基准下的可观测价格偏差估算，不是无攻击/主导池状态下的反事实损失证明；不含 Gas、Token 税、其他路由腿或价格继续波动。',
  ];
}

function transactionNativeSymbol(output: DiagnoseXxyyTransactionOutput): string {
  if (output.transaction.family === 'solana') return 'SOL';
  if (output.transaction.chainId === '56') return 'BNB';
  if (output.transaction.chainId === '1' || output.transaction.chainId === '8453') return 'ETH';
  return '原生币';
}

function formatEstimatedAmount(value: number, maximumFractionDigits: number): string {
  if (value > 0 && value < 10 ** -maximumFractionDigits) {
    return value.toExponential(Math.min(maximumFractionDigits, 6));
  }
  return value.toLocaleString('en-US', { maximumFractionDigits, useGrouping: true });
}

function diagnosisHeadline(output: DiagnoseXxyyTransactionOutput): {
  icon: string;
  text: string;
} {
  const verdict = output.sandwichAssessment?.verdict;
  if (verdict === 'confirmed') return { icon: '🚨', text: '确认存在 Sandwich 证据' };
  if (verdict === 'likely') return { icon: '⚠️', text: '疑似被夹，仍需补充证据' };
  if (verdict === 'unlikely') return { icon: '✅', text: '当前证据不支持被夹' };
  if ((output.executionPools?.length ?? 0) > 0) {
    return { icon: '🔎', text: '已定位交易执行池；被夹证据不足' };
  }
  return { icon: '🔎', text: '被夹检查：证据不足' };
}

function formatExecutionPool(
  executionPool: NonNullable<DiagnoseXxyyTransactionOutput['executionPools']>[number],
  candidatePools: ReturnType<typeof sortedCandidatePools>,
  nativeSymbol?: string,
): string {
  const candidate = candidatePools.find(
    (item) => item.pairAddress.toLowerCase() === executionPool.poolIdentifier.toLowerCase(),
  );
  const marketDetails =
    candidate === undefined
      ? 'XXYY 当前池列表未返回'
      : `${dexLabel(candidate.dexId)}${candidate.liquidityUsd === undefined ? '，流动性未知' : `，约 $${formatDecimal(candidate.liquidityUsd, 2)}`}`;
  const amountDetails =
    nativeSymbol === undefined || executionPool.amount0Raw === undefined
      ? ''
      : `；本腿约 ${formatRaw18(executionPool.amount0Raw)} ${nativeSymbol}`;
  const primaryLabel = executionPool.isPrimary === true ? '⭐ 主执行池 · ' : '';
  return `${primaryLabel}\`${executionPool.poolIdentifier}\`（日志 #${executionPool.logIndex}；${marketDetails}${amountDetails}）`;
}

function inferNativeExecutionSymbol(
  output: DiagnoseXxyyTransactionOutput,
  executionCandidates: ReturnType<typeof sortedCandidatePools>,
): string | undefined {
  if (output.transaction.family !== 'evm' || output.transaction.chainId !== '56') return undefined;
  const wrappedBnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  return executionCandidates.some((candidate) => candidate.quoteToken.toLowerCase() === wrappedBnb)
    ? 'BNB'
    : undefined;
}

function formatRaw18(value: string): string {
  const absolute = value.startsWith('-') ? value.slice(1) : value;
  const padded = absolute.padStart(19, '0');
  const whole = padded.slice(0, -18).replace(/^0+(?=\d)/u, '');
  const fraction = padded.slice(-18).replace(/0+$/u, '');
  return `${whole}${fraction.length === 0 ? '' : `.${fraction}`}`;
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
    return '该交易包含多个成交腿，XXYY 未返回可安全合并为一条记录的结果。';
  }
  if (warning.startsWith('XXYY matched multiple execution legs')) {
    return 'XXYY 已匹配多条成交腿，并选择可覆盖成交规模最大的执行池继续分析。';
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
