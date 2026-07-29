import { z } from 'zod';

import { chatResponseSchema, type ChatResponse } from '@xxyy/shared';
import {
  BUILT_IN_EVM_NETWORKS,
  ChainAnalysisMcpToolError,
  SOLANA_MAINNET_NETWORK,
  detectSandwichOutputSchema,
  findBuiltInEvmNetworkByChainId,
  getTransactionOutputSchema,
  inspectTransactionOutputSchema,
  normalizePublicNetworkIdentifier,
  resolvePublicTransactionReference,
  type DetectSandwichOutput,
  type GetTransactionInput,
  type GetTransactionOutput,
  type InspectTransactionOutput,
  type PublicTransactionReference,
} from '@xxyy/chain-analysis-mcp';

import {
  CHAIN_GET_SKILL_CAPABILITY_ID,
  CHAIN_INSPECT_SKILL_CAPABILITY_ID,
  CHAIN_SANDWICH_SKILL_CAPABILITY_ID,
  type PublicChainAnalysisCaller,
} from './chain-analysis-capabilities.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { CapabilityInvocationContext } from './capability-contract.js';
import type { ToolDefinition } from './tool-registry.js';

export const PUBLIC_TRANSACTION_TOOL_NAME = 'get_public_transaction';

const MAX_PUBLIC_TRANSACTIONS_PER_QUESTION = 3;
const MAX_RENDERED_TOKEN_TRANSFERS = 3;
const MAX_RENDERED_INTERNAL_TRANSFERS = 3;
const MAX_RENDERED_REVERTS = 3;
const MAX_RENDERED_SWAPS = 3;
const transactionQueryInputSchema = z
  .object({
    query: z.string().trim().min(1).max(8_192),
  })
  .strict();

type QueryResolution =
  | { inputs: GetTransactionInput[]; status: 'ready' }
  | { status: 'invalid_reference' | 'missing_network' | 'too_many' };

type PublicChainOperation = 'detect_sandwich' | 'get_transaction' | 'inspect_transaction';

type DeepQueryResolution =
  | {
      explorerUrl?: string;
      input: {
        chainId: string;
        transactionHash: string;
      };
      network: string;
      status: 'ready';
    }
  | {
      status:
        | 'invalid_reference'
        | 'missing_network'
        | 'single_transaction_required'
        | 'unsupported_network';
    };

export function createPublicChainTransactionTool(options: {
  caller: PublicChainAnalysisCaller;
  registry: CapabilityRegistry;
}): ToolDefinition<
  typeof PUBLIC_TRANSACTION_TOOL_NAME,
  typeof transactionQueryInputSchema,
  typeof chatResponseSchema
> {
  assertPublicCaller(options.caller);
  return {
    name: PUBLIC_TRANSACTION_TOOL_NAME,
    description:
      'Query up to three basic public EVM or Solana transactions, inspect one EVM transaction including governed call-trace evidence, or assess one allowlisted EVM pool for Sandwich/MEV evidence. Inputs must contain a supported Explorer URL or explicit network plus transaction id; Sandwich requests may also require a labeled pool address. Never use for wallet/account history, arbitrary address history, signing, simulation, or transaction execution.',
    inputSchema: transactionQueryInputSchema,
    outputSchema: chatResponseSchema,
    async execute(input, context) {
      const operation = classifyPublicChainOperation(input.query);
      if (operation !== 'get_transaction') {
        const resolution = resolveDeepEvmQuery(input.query);
        if (resolution.status !== 'ready') {
          return deepQueryClarification(resolution.status);
        }
        try {
          if (operation === 'inspect_transaction') {
            const inspection = inspectTransactionOutputSchema.parse(
              await options.registry.invoke(
                CHAIN_INSPECT_SKILL_CAPABILITY_ID,
                resolution.input,
                invocationContext(options.caller, context.requestId),
              ),
            );
            return formatInspectionResult(inspection, resolution);
          }

          return await executeSandwichQuery({
            caller: options.caller,
            query: input.query,
            registry: options.registry,
            ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
            resolution,
          });
        } catch (error) {
          return transactionQueryErrorResponse(error, operation);
        }
      }

      const resolution = resolveTransactionQueries(input.query);
      if (resolution.status !== 'ready') {
        return transactionQueryClarification(resolution.status);
      }

      try {
        const results = await Promise.all(
          resolution.inputs.map(async (transactionInput) =>
            getTransactionOutputSchema.parse(
              await options.registry.invoke(
                CHAIN_GET_SKILL_CAPABILITY_ID,
                transactionInput,
                invocationContext(options.caller, context.requestId),
              ),
            ),
          ),
        );
        return formatPublicTransactionResults(results);
      } catch (error) {
        return transactionQueryErrorResponse(error, operation);
      }
    },
  };
}

export function hasPublicTransactionReference(query: string): boolean {
  return resolveTransactionQueries(query).status !== 'invalid_reference';
}

function resolveTransactionQueries(query: string): QueryResolution {
  const explorerInputs = resolveExplorerInputs(query);
  if (explorerInputs.length > MAX_PUBLIC_TRANSACTIONS_PER_QUESTION) {
    return { status: 'too_many' };
  }
  if (explorerInputs.length > 0) {
    return { inputs: explorerInputs, status: 'ready' };
  }

  const network = detectExplicitNetwork(query);
  const evmHashes = uniqueMatches(query, /\b0x[a-fA-F0-9]{64}\b/gu);
  if (evmHashes.length > 0) {
    if (network === undefined) {
      return { status: 'missing_network' };
    }
    const canonicalNetwork = normalizePublicNetworkIdentifier(network);
    if (canonicalNetwork === undefined || !canonicalNetwork.startsWith('eip155:')) {
      return { status: 'invalid_reference' };
    }
    if (evmHashes.length > MAX_PUBLIC_TRANSACTIONS_PER_QUESTION) {
      return { status: 'too_many' };
    }
    return {
      inputs: evmHashes.map((reference) => ({ network: canonicalNetwork, reference })),
      status: 'ready',
    };
  }

  if (normalizePublicNetworkIdentifier(network ?? '') === SOLANA_MAINNET_NETWORK) {
    const signatures = uniqueMatches(query, /\b[1-9A-HJ-NP-Za-km-z]{64,128}\b/gu).filter(
      (candidate) => {
        try {
          resolvePublicTransactionReference({
            network: SOLANA_MAINNET_NETWORK,
            reference: candidate,
          });
          return true;
        } catch {
          return false;
        }
      },
    );
    if (signatures.length > MAX_PUBLIC_TRANSACTIONS_PER_QUESTION) {
      return { status: 'too_many' };
    }
    if (signatures.length > 0) {
      return {
        inputs: signatures.map((reference) => ({
          network: SOLANA_MAINNET_NETWORK,
          reference,
        })),
        status: 'ready',
      };
    }
  }

  return { status: 'invalid_reference' };
}

function classifyPublicChainOperation(query: string): PublicChainOperation {
  if (
    /detect[_\s-]?sandwich|被夹|夹子|三明治(?:攻击)?|sandwich|\bmev\b|front[- ]?run|back[- ]?run/iu.test(
      query,
    )
  ) {
    return 'detect_sandwich';
  }
  if (
    /inspect[_\s-]?transaction|调用追踪|调用树|内部调用|内部转账|链上取证|深度分析|trace|revert|(?:分析|解析).*(?:\/tx\/|\b0x[a-f0-9]{64}\b)/iu.test(
      query,
    )
  ) {
    return 'inspect_transaction';
  }
  return 'get_transaction';
}

function resolveDeepEvmQuery(query: string): DeepQueryResolution {
  const resolution = resolveTransactionQueries(query);
  if (resolution.status !== 'ready') {
    return {
      status: resolution.status === 'too_many' ? 'single_transaction_required' : resolution.status,
    };
  }
  if (resolution.inputs.length !== 1) {
    return { status: 'single_transaction_required' };
  }

  let reference: PublicTransactionReference;
  try {
    reference = resolvePublicTransactionReference(resolution.inputs[0]!);
  } catch {
    return { status: 'invalid_reference' };
  }
  if (reference.family !== 'evm') {
    return { status: 'unsupported_network' };
  }
  return {
    ...(reference.explorerUrl === undefined ? {} : { explorerUrl: reference.explorerUrl }),
    input: {
      chainId: reference.chainId,
      transactionHash: reference.transactionId,
    },
    network: reference.network,
    status: 'ready',
  };
}

async function executeSandwichQuery(options: {
  caller: PublicChainAnalysisCaller;
  query: string;
  registry: CapabilityRegistry;
  requestId?: string;
  resolution: Extract<DeepQueryResolution, { status: 'ready' }>;
}): Promise<ChatResponse> {
  const inspection = inspectTransactionOutputSchema.parse(
    await options.registry.invoke(
      CHAIN_INSPECT_SKILL_CAPABILITY_ID,
      options.resolution.input,
      invocationContext(options.caller, options.requestId),
    ),
  );
  const candidates = [
    ...new Set(inspection.execution?.swaps.map((swap) => swap.poolAddress) ?? []),
  ];
  let poolAddress = extractLabeledPoolAddress(options.query);
  if (poolAddress === undefined) {
    if (candidates.length !== 1) {
      const unsupportedSemantics = unsupportedSandwichSemanticsClarification(inspection);
      if (unsupportedSemantics !== undefined) {
        return unsupportedSemantics;
      }
      return sandwichPoolClarification(candidates.length);
    }
    poolAddress = candidates[0]!;
  } else if (candidates.length > 0 && !candidates.includes(poolAddress)) {
    return sandwichPoolMismatchClarification(poolAddress, candidates);
  }

  const output = detectSandwichOutputSchema.parse(
    await options.registry.invoke(
      CHAIN_SANDWICH_SKILL_CAPABILITY_ID,
      {
        ...options.resolution.input,
        poolAddress,
      },
      invocationContext(options.caller, options.requestId),
    ),
  );
  return formatSandwichResult(output, options.resolution);
}

function unsupportedSandwichSemanticsClarification(
  inspection: InspectTransactionOutput,
): ChatResponse | undefined {
  const warnings = inspection.execution?.warnings ?? [];
  if (warnings.includes('bags_bonding_curve_metadata_not_configured')) {
    return validatedChatResponse({
      agentRoute: 'clarify',
      answer:
        '这笔交易包含 Bags 发射台内盘事件。当前可以查询交易事实和调用追踪，但尚未接入 Bags bonding curve 的版本化池状态与同区块观察，因此不能可靠判断 Sandwich/MEV；无需继续补普通 DEX 池子地址。',
      citations: [],
      confidence: 0.4,
      intent: 'onchain_transaction',
    });
  }
  if (warnings.includes('uniswap_v4_pool_key_not_configured')) {
    return validatedChatResponse({
      agentRoute: 'clarify',
      answer:
        '这笔交易包含 Uniswap V4 Swap，但当前缺少已验证 PoolKey、Hook 与同区块池状态，因此不能可靠判断 Sandwich/MEV；仅补 PoolManager 地址不足以完成分析。',
      citations: [],
      confidence: 0.4,
      intent: 'onchain_transaction',
    });
  }
  return undefined;
}

function extractLabeledPoolAddress(query: string): string | undefined {
  const normalized = query.normalize('NFKC');
  const labelFirst =
    normalized.match(
      /(?:池子(?:地址)?|pool(?:\s+address)?)\s*(?:是|为|:|：|=)?\s*(0x[a-fA-F0-9]{40})\b/iu,
    )?.[1] ?? normalized.match(/\b(0x[a-fA-F0-9]{40})\b\s*(?:这个|该)?\s*(?:池子|pool)/iu)?.[1];
  return labelFirst?.toLowerCase();
}

function resolveExplorerInputs(query: string): GetTransactionInput[] {
  const resolved = new Map<string, GetTransactionInput>();
  for (const candidate of extractHttpsUrls(query)) {
    try {
      const reference = resolvePublicTransactionReference({ reference: candidate });
      const key = `${reference.network}:${reference.transactionId}`;
      resolved.set(key, {
        reference: reference.explorerUrl ?? reference.transactionId,
        ...(reference.explorerUrl === undefined ? { network: reference.network } : {}),
      });
    } catch {
      // Other links in a support question are not chain capability inputs.
    }
  }
  return [...resolved.values()];
}

function extractHttpsUrls(query: string): string[] {
  return (query.match(/https:\/\/[^\s<>"',，。、；]+/giu) ?? []).map((value) =>
    value.replace(/[),.;:!?，。；：！？）】》]+$/gu, ''),
  );
}

function detectExplicitNetwork(query: string): string | undefined {
  const normalized = query.normalize('NFKC').toLowerCase();
  const matches = new Set<string>();
  const canonical = normalized.match(/\b(?:eip155:[1-9]\d*|solana:mainnet)\b/gu) ?? [];
  for (const value of canonical) {
    const network = normalizePublicNetworkIdentifier(value);
    if (network !== undefined) {
      matches.add(network);
    }
  }

  for (const profile of BUILT_IN_EVM_NETWORKS) {
    const names = [profile.name.toLowerCase(), ...profile.aliases];
    if (names.some((name) => containsNetworkName(normalized, name))) {
      matches.add(profile.canonicalNetwork);
    }
  }
  if (containsNetworkName(normalized, 'solana') || containsNetworkName(normalized, 'sol')) {
    matches.add(SOLANA_MAINNET_NETWORK);
  }

  return matches.size === 1 ? [...matches][0] : undefined;
}

function containsNetworkName(query: string, networkName: string): boolean {
  const escaped = networkName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(query);
}

function uniqueMatches(query: string, pattern: RegExp): string[] {
  return [...new Set(query.match(pattern) ?? [])];
}

function formatPublicTransactionResults(results: GetTransactionOutput[]): ChatResponse {
  const sections = results.map(formatPublicTransactionSection);
  const multiple = sections.length > 1;
  return validatedChatResponse({
    agentRoute: 'chain_answer',
    answer: [
      ...(multiple ? [`共查询 ${sections.length} 笔公开链上交易。`, ''] : []),
      ...sections.flatMap((section, index) => [
        ...(multiple ? [`**${index + 1}. ${section.title}**`] : [`**${section.title}**`]),
        ...section.lines,
        ...(index === sections.length - 1 ? [] : ['']),
      ]),
      '',
      '说明：交易事实来自启动时配置的只读 RPC；不会据此推断地址归属、交易意图或投资结论。',
    ].join('\n'),
    citations: sections.flatMap((section) => section.citations),
    confidence: Math.min(...sections.map((section) => section.confidence)),
    intent: 'onchain_transaction',
  });
}

function formatPublicTransactionSection(result: GetTransactionOutput): {
  citations: ChatResponse['citations'];
  confidence: number;
  lines: string[];
  title: string;
} {
  const networkName = networkDisplayName(result);
  const title = `${networkName} 交易 ${shortTransactionId(result.transactionId)}`;
  const citations =
    result.status === 'insufficient_data' || result.explorerUrl === undefined
      ? []
      : [
          {
            excerpt: `${networkName} 公开交易，查询状态：${queryStatusLabel(result.status)}。`,
            file: `onchain/${result.network}/${result.transactionId}`,
            sourceUrl: result.explorerUrl,
            title,
          },
        ];

  if (result.family === 'solana') {
    const snapshot = result.analysis;
    const lines =
      snapshot === undefined
        ? [
            `查询状态：${queryStatusLabel(result.status)}`,
            `交易签名：\`${result.transactionId}\``,
            '当前配置的 RPC 未返回可验证的交易详情。',
          ]
        : [
            `查询状态：${queryStatusLabel(result.status)}`,
            `执行结果：${executionStatusLabel(snapshot.executionStatus)}`,
            `交易签名：\`${snapshot.transactionId}\``,
            `Slot：${snapshot.slot}`,
            ...(snapshot.blockTime === undefined ? [] : [`区块时间：${snapshot.blockTime}`]),
            ...(snapshot.feeLamports === undefined
              ? []
              : [`手续费：${snapshot.feeLamports} lamports`]),
            `原生余额变化：${snapshot.nativeBalanceChanges.length} 条`,
            `SPL Token 余额变化：${snapshot.tokenBalanceChanges.length} 条`,
            ...(result.diagnostics.length === 0
              ? []
              : [`数据诊断：${result.diagnostics.length} 条，结论可能不完整。`]),
          ];
    return {
      citations,
      confidence: confidenceForStatus(result.status),
      lines,
      title,
    };
  }

  const transaction = result.analysis.transaction;
  const transferLines = result.analysis.tokenTransfers
    .slice(0, MAX_RENDERED_TOKEN_TRANSFERS)
    .map(
      (transfer, index) =>
        `Token 转账 ${index + 1}：\`${transfer.from}\` → \`${transfer.to}\`，数量 ${transfer.amountRaw}（原始单位），合约 \`${transfer.tokenAddress}\``,
    );
  const lines = [
    `查询状态：${queryStatusLabel(result.status)}`,
    `执行结果：${executionStatusLabel(transaction.executionStatus)}`,
    `交易哈希：\`${transaction.hash}\``,
    ...(transaction.blockNumber === undefined ? [] : [`区块：${transaction.blockNumber}`]),
    ...(transaction.blockTimestamp === undefined
      ? []
      : [`区块时间：${formatUnixTimestamp(transaction.blockTimestamp)}`]),
    ...(transaction.from === undefined ? [] : [`发送方：\`${transaction.from}\``]),
    ...(transaction.to === undefined
      ? []
      : [`接收方：${transaction.to === null ? '合约创建' : `\`${transaction.to}\``}`]),
    ...(transaction.valueWei === undefined
      ? []
      : [`原生币金额：${transaction.valueWei}（最小单位）`]),
    ...(transaction.feeWei === undefined ? [] : [`手续费：${transaction.feeWei}（最小单位）`]),
    `调用类型：${inputKindLabel(transaction.inputKind)}`,
    `ERC-20 Transfer：${result.analysis.tokenTransfers.length} 条`,
    ...transferLines,
    ...(result.analysis.tokenTransfers.length > MAX_RENDERED_TOKEN_TRANSFERS
      ? [`其余 ${result.analysis.tokenTransfers.length - MAX_RENDERED_TOKEN_TRANSFERS} 条未展开。`]
      : []),
    ...(result.diagnostics.length === 0 && result.analysis.diagnostics.length === 0
      ? []
      : [
          `数据诊断：${result.diagnostics.length + result.analysis.diagnostics.length} 条，结论可能不完整。`,
        ]),
  ];
  return {
    citations,
    confidence: confidenceForStatus(result.status),
    lines,
    title,
  };
}

function formatInspectionResult(
  result: InspectTransactionOutput,
  resolution: Extract<DeepQueryResolution, { status: 'ready' }>,
): ChatResponse {
  const transaction = result.transaction.transaction;
  const execution = result.execution;
  const warnings = [...new Set([...(execution?.warnings ?? []), ...result.warnings])];
  const publicStatus = publicInspectionStatus(result);
  const title = `${networkDisplayNameFromNetwork(resolution.network)} 深度交易分析 ${shortTransactionId(
    resolution.input.transactionHash,
  )}`;
  const internalTransfers =
    execution?.internalTransfers
      .slice(0, MAX_RENDERED_INTERNAL_TRANSFERS)
      .map(
        (transfer, index) =>
          `内部转账 ${index + 1}：\`${transfer.from}\` → ${
            transfer.to === null ? '合约创建' : `\`${transfer.to}\``
          }，${transfer.amountWei} wei（${transfer.transferType}）`,
      ) ?? [];
  const reverts =
    execution?.reverts
      .slice(0, MAX_RENDERED_REVERTS)
      .map(
        (revert, index) =>
          `回滚调用 ${index + 1}：\`${revert.from}\` → ${
            revert.to === null ? '合约创建' : `\`${revert.to}\``
          }，${revert.reason ?? revert.panicDescription ?? revert.kind}`,
      ) ?? [];
  const swaps =
    execution?.swaps
      .slice(0, MAX_RENDERED_SWAPS)
      .map(
        (swap, index) =>
          `Swap ${index + 1}：${dexProtocolLabel(swap.protocol)} 池 \`${swap.poolAddress}\`，方向 ${swap.direction}${
            swap.amountInRaw === undefined
              ? ''
              : `，输入 ${swap.amountInRaw}、输出 ${swap.amountOutRaw}（原始单位）`
          }`,
      ) ?? [];

  return validatedChatResponse({
    agentRoute: 'chain_answer',
    answer: [
      `**${title}**`,
      `分析状态：${analysisStatusLabel(publicStatus)}`,
      `执行结果：${executionStatusLabel(result.capability.executionStatus)}`,
      `交易哈希：\`${resolution.input.transactionHash}\``,
      ...(transaction.blockNumber === undefined ? [] : [`区块：${transaction.blockNumber}`]),
      ...(transaction.blockTimestamp === undefined
        ? []
        : [`区块时间：${formatUnixTimestamp(transaction.blockTimestamp)}`]),
      `调用追踪：${traceCoverageLabel(
        result.capability.traceCoverage,
        execution?.coverage.traceNodeCount,
      )}`,
      `内部原生币转账：${result.capability.internalTransferCount} 条`,
      `已解码 Swap：${result.capability.swapCount} 条`,
      ...(execution === undefined || execution.coverage.unresolvedSwapLogs === 0
        ? []
        : [`识别但未安全解码的 Swap：${execution.coverage.unresolvedSwapLogs} 条`]),
      `ERC-20 Transfer：${result.capability.tokenTransferCount} 条`,
      ...internalTransfers,
      ...reverts,
      ...swaps,
      ...(result.capability.refusalCodes.length === 0
        ? []
        : [`降级原因：${result.capability.refusalCodes.map(refusalCodeLabel).join('；')}`]),
      ...(warnings.length === 0 ? [] : [`警告：${warnings.map(analysisWarningLabel).join('；')}`]),
      ...(result.capability.traceCoverage === 'available'
        ? []
        : ['证据说明：已取得交易基础事实，但未取得可用调用追踪，不能据此分析内部调用路径。']),
      '',
      '说明：调用追踪和 Swap 语义只在 Provider 与 allowlist 证据完整时展示；缺失部分会明确标为未提供或数据不足。',
    ].join('\n'),
    citations: createDeepAnalysisCitations({
      ...(resolution.explorerUrl === undefined ? {} : { explorerUrl: resolution.explorerUrl }),
      network: resolution.network,
      status: publicStatus,
      title,
      transactionHash: resolution.input.transactionHash,
    }),
    confidence: confidenceForAnalysisStatus(publicStatus),
    intent: 'onchain_transaction',
  });
}

function publicInspectionStatus(
  result: InspectTransactionOutput,
): 'insufficient_data' | 'partial' | 'success' {
  if (result.capability.status === 'insufficient_data') {
    return 'insufficient_data';
  }
  return result.capability.traceCoverage === 'available' ? result.capability.status : 'partial';
}

function formatSandwichResult(
  result: DetectSandwichOutput,
  resolution: Extract<DeepQueryResolution, { status: 'ready' }>,
): ChatResponse {
  const capability = result.capability;
  const sandwich = result.mev?.sandwich;
  const warnings = [
    ...new Set([
      ...(result.execution?.warnings ?? []),
      ...(result.mev?.warnings ?? []),
      ...result.warnings,
    ]),
  ];
  const title = `${networkDisplayNameFromNetwork(
    resolution.network,
  )} Sandwich/MEV 分析 ${shortTransactionId(resolution.input.transactionHash)}`;
  return validatedChatResponse({
    agentRoute: 'chain_answer',
    answer: [
      `**${title}**`,
      `分析状态：${analysisStatusLabel(capability.status)}`,
      `Sandwich 结论：${sandwichVerdictLabel(capability.verdict)}`,
      `交易哈希：\`${capability.transactionHash}\``,
      `池子：\`${capability.poolAddress}\``,
      ...(capability.priceImpactPpm === undefined
        ? []
        : [`目标交易价格影响：${formatPpmAsPercent(capability.priceImpactPpm)}`]),
      ...(sandwich?.victimLossRaw === undefined
        ? []
        : [`反事实受影响数量：${sandwich.victimLossRaw}（原始单位）`]),
      ...(sandwich?.attackerProfitRaw === undefined
        ? []
        : [`观察到的攻击者收益：${sandwich.attackerProfitRaw}（原始单位）`]),
      ...(sandwich?.frontTransactionHash === undefined
        ? []
        : [`前置交易：\`${sandwich.frontTransactionHash}\``]),
      ...(sandwich?.backTransactionHash === undefined
        ? []
        : [`后置交易：\`${sandwich.backTransactionHash}\``]),
      ...(capability.observationCoverage === undefined
        ? []
        : [
            `证据覆盖：区块交易 ${capability.observationCoverage.blockTransactions}、池状态 ${capability.observationCoverage.poolStates}、地址资产变化 ${capability.observationCoverage.actorAssetDeltas}`,
          ]),
      ...(capability.refusalCodes.length === 0
        ? []
        : [`降级原因：${capability.refusalCodes.map(refusalCodeLabel).join('；')}`]),
      ...(warnings.length === 0 ? [] : [`警告：${warnings.map(analysisWarningLabel).join('；')}`]),
      '',
      '说明：这是限定在已配置池子和可验证同区块证据内的确定性分析，不代表对所有 MEV 类型的完整判断，也不是投资建议。',
    ].join('\n'),
    citations: createDeepAnalysisCitations({
      ...(resolution.explorerUrl === undefined ? {} : { explorerUrl: resolution.explorerUrl }),
      network: resolution.network,
      status: capability.status,
      title,
      transactionHash: resolution.input.transactionHash,
    }),
    confidence: confidenceForSandwichResult(result),
    intent: 'onchain_transaction',
  });
}

function createDeepAnalysisCitations(input: {
  explorerUrl?: string;
  network: string;
  status: 'insufficient_data' | 'partial' | 'success';
  title: string;
  transactionHash: string;
}): ChatResponse['citations'] {
  if (input.status === 'insufficient_data' || input.explorerUrl === undefined) {
    return [];
  }
  return [
    {
      excerpt: `${networkDisplayNameFromNetwork(input.network)} 公开交易的只读链上分析。`,
      file: `onchain/${input.network}/${input.transactionHash}`,
      sourceUrl: input.explorerUrl,
      title: input.title,
    },
  ];
}

function transactionQueryClarification(
  status: Exclude<QueryResolution['status'], 'ready'>,
): ChatResponse {
  const answer =
    status === 'missing_network'
      ? '识别到了交易哈希，但无法确定网络。请同时注明 Ethereum、BSC、Base、Robinhood Chain、Stable Chain 或 Solana，最好直接发送对应 Explorer 交易链接。'
      : status === 'too_many'
        ? `一次最多查询 ${MAX_PUBLIC_TRANSACTIONS_PER_QUESTION} 笔公开交易，请减少交易链接或哈希后重试。`
        : '请提供受支持的公开 Explorer 交易链接，或同时提供网络名称和交易哈希/签名。';
  return validatedChatResponse({
    agentRoute: 'clarify',
    answer,
    citations: [],
    confidence: 0.4,
    intent: 'onchain_transaction',
  });
}

function deepQueryClarification(
  status: Exclude<DeepQueryResolution['status'], 'ready'>,
): ChatResponse {
  const answer =
    status === 'missing_network'
      ? '识别到了交易哈希，但无法确定 EVM 网络。请注明 Ethereum、BSC、Base、Robinhood Chain 或 Stable Chain，最好直接发送对应 Explorer 交易链接。'
      : status === 'single_transaction_required'
        ? '调用追踪和 MEV/Sandwich 分析一次只处理一笔 EVM 交易，请只保留一个交易链接或哈希。'
        : status === 'unsupported_network'
          ? '调用追踪和 MEV/Sandwich 分析目前只支持已配置的 EVM 网络，不适用于 Solana。'
          : '请提供受支持的 EVM Explorer 交易链接，或同时提供网络名称和交易哈希。';
  return validatedChatResponse({
    agentRoute: 'clarify',
    answer,
    citations: [],
    confidence: 0.4,
    intent: 'onchain_transaction',
  });
}

function sandwichPoolClarification(candidateCount: number): ChatResponse {
  return validatedChatResponse({
    agentRoute: 'clarify',
    answer:
      candidateCount === 0
        ? '未能从已验证的交易执行证据中唯一确定池子。请补充“池子地址 0x…”；该地址还必须在服务端启动 allowlist 中。'
        : `交易执行证据中识别到 ${candidateCount} 个池子，无法自动选择。请补充“池子地址 0x…”后重试。`,
    citations: [],
    confidence: 0.4,
    intent: 'onchain_transaction',
  });
}

function sandwichPoolMismatchClarification(
  requestedPool: string,
  verifiedPools: readonly string[],
): ChatResponse {
  return validatedChatResponse({
    agentRoute: 'clarify',
    answer: `提供的池子 \`${requestedPool}\` 与该交易已验证的 Swap 池不一致。请从以下池子中选择一个后重试：${verifiedPools
      .map((pool) => `\`${pool}\``)
      .join('、')}。`,
    citations: [],
    confidence: 0.4,
    intent: 'onchain_transaction',
  });
}

function transactionQueryErrorResponse(
  error: unknown,
  operation: PublicChainOperation,
): ChatResponse {
  let answer = '链上数据服务暂时不可用，请稍后重试。';
  if (error instanceof ChainAnalysisMcpToolError) {
    if (error.code === 'chain_not_configured') {
      answer =
        operation === 'get_transaction'
          ? '当前没有为该网络配置只读 RPC，请改用已支持的网络或联系管理员补充配置。'
          : '该网络尚未配置对应的深度链上数据面。调用追踪需要 trace Provider；MEV/Sandwich 还需要 archive Provider 和池子 allowlist。';
    } else if (error.code === 'pool_not_configured') {
      answer = '该池子未进入服务端 Sandwich 分析 allowlist，当前不能对它给出 MEV 结论。';
    } else if (error.code === 'invalid_reference') {
      answer = '交易链接、交易哈希或网络不匹配，请检查后重试。';
    } else if (error.code === 'runtime_not_ready') {
      answer = '深度链上分析运行时当前未通过 readiness 门禁，请稍后重试。';
    } else if (error.code === 'provider_unavailable') {
      answer = '链上 Provider 当前不可用或不支持所需的 trace/archive 方法，请稍后重试。';
    } else if (error.code === 'tool_timeout') {
      answer = '链上查询超时，请稍后重试。';
    }
  }
  return validatedChatResponse({
    agentRoute: 'clarify',
    answer,
    citations: [],
    confidence: 0.2,
    intent: 'onchain_transaction',
  });
}

function networkDisplayName(result: GetTransactionOutput): string {
  if (result.family === 'solana') {
    return 'Solana';
  }
  return findBuiltInEvmNetworkByChainId(result.chainId)?.name ?? result.network;
}

function networkDisplayNameFromNetwork(network: string): string {
  const chainId = network.startsWith('eip155:') ? network.slice('eip155:'.length) : undefined;
  return chainId === undefined
    ? network
    : (findBuiltInEvmNetworkByChainId(chainId)?.name ?? network);
}

function validatedChatResponse(response: ChatResponse): ChatResponse {
  chatResponseSchema.parse(response);
  return response;
}

function shortTransactionId(transactionId: string): string {
  return transactionId.length <= 18
    ? transactionId
    : `${transactionId.slice(0, 10)}…${transactionId.slice(-6)}`;
}

function queryStatusLabel(status: GetTransactionOutput['status']): string {
  switch (status) {
    case 'success':
      return '成功';
    case 'partial':
      return '部分数据';
    case 'insufficient_data':
      return '数据不足/未查到';
  }
}

function executionStatusLabel(status: 'reverted' | 'success' | 'unknown' | 'pending'): string {
  switch (status) {
    case 'success':
      return '成功';
    case 'reverted':
      return '失败（reverted）';
    case 'pending':
      return '待确认';
    case 'unknown':
      return '未知';
  }
}

function inputKindLabel(
  kind: 'contract_call' | 'contract_creation' | 'native_transfer' | 'unknown',
): string {
  switch (kind) {
    case 'contract_call':
      return '合约调用';
    case 'contract_creation':
      return '合约创建';
    case 'native_transfer':
      return '原生币转账';
    case 'unknown':
      return '未知';
  }
}

function formatUnixTimestamp(value: string): string {
  try {
    const milliseconds = BigInt(value) * 1000n;
    if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
      return `${value}（Unix 秒）`;
    }
    return new Date(Number(milliseconds)).toISOString();
  } catch {
    return `${value}（Unix 秒）`;
  }
}

function confidenceForStatus(status: GetTransactionOutput['status']): number {
  switch (status) {
    case 'success':
      return 0.95;
    case 'partial':
      return 0.65;
    case 'insufficient_data':
      return 0.35;
  }
}

function analysisStatusLabel(status: 'insufficient_data' | 'partial' | 'success'): string {
  switch (status) {
    case 'success':
      return '成功';
    case 'partial':
      return '部分数据';
    case 'insufficient_data':
      return '证据不足';
  }
}

function traceCoverageLabel(
  coverage: InspectTransactionOutput['capability']['traceCoverage'],
  nodeCount: number | undefined,
): string {
  switch (coverage) {
    case 'available':
      return `可用${nodeCount === undefined ? '' : `（${nodeCount} 个调用节点）`}`;
    case 'invalid':
      return 'Provider 返回的 trace 无效';
    case 'mismatched':
      return 'trace 与交易证据不匹配';
    case 'missing':
      return 'Provider 未返回 trace';
    case 'not_provided':
      return '未配置 trace Provider';
  }
}

function sandwichVerdictLabel(verdict: DetectSandwichOutput['capability']['verdict']): string {
  switch (verdict) {
    case 'confirmed':
      return '已确认';
    case 'likely':
      return '可能存在';
    case 'unlikely':
      return '当前证据未发现';
    case 'insufficient_data':
    case undefined:
      return '证据不足';
  }
}

function refusalCodeLabel(code: string): string {
  switch (code) {
    case 'composition_conflict':
      return '不同分析阶段的证据无法一致对齐';
    case 'execution_data_partial':
      return '调用追踪或 Swap 执行证据不完整';
    case 'observation_insufficient':
      return '同区块 MEV 观察证据不足';
    case 'observation_missing':
      return '未配置同区块 MEV 观察数据源';
    case 'pool_not_observed':
      return '目标池未出现在可验证观察中';
    case 'provider_conflict':
      return '多个数据源结果存在冲突';
    case 'transaction_data_insufficient':
      return '交易基础数据不足';
    case 'unsupported_semantics':
      return '该池或代币语义暂不支持确定性判断';
    default:
      return code;
  }
}

function dexProtocolLabel(protocol: 'uniswap_v2' | 'uniswap_v3'): string {
  return protocol === 'uniswap_v2' ? 'Uniswap V2' : 'Uniswap V3';
}

function analysisWarningLabel(code: string): string {
  switch (code) {
    case 'trace_source_partial':
      return '调用追踪来自公开 Explorer 单一数据源，仅作为部分证据';
    case 'uniswap_v4_pool_key_not_configured':
      return '检测到 Uniswap V4 格式 Swap，但缺少已验证 PoolKey/Hook 元数据，未推断方向或 MEV';
    case 'bags_bonding_curve_metadata_not_configured':
      return '检测到 Bags 发射台内盘交易格式，但缺少版本化合约与代币元数据，未把它误报为普通 DEX Swap';
    case 'pool_metadata_missing':
      return '部分 Swap 池元数据无法在交易区块验证，因此未展开';
    case 'non_value_call_reports_value':
      return '追踪源存在非标准 value 记录，相关原生币变化已保守降级';
    case 'trace_missing':
      return '调用追踪不可用';
    case 'snapshot_source_conflicts':
      return '交易基础数据源存在冲突';
    case 'chain.inspect_transaction:partial':
      return '本次深度交易分析仅取得部分证据';
    case 'chain.inspect_transaction:insufficient_data':
      return '本次深度交易分析证据不足';
    case 'chain.detect_sandwich:partial':
      return '本次 Sandwich/MEV 分析仅取得部分证据';
    case 'chain.detect_sandwich:insufficient_data':
      return '本次 Sandwich/MEV 分析证据不足';
    default:
      return '部分执行证据无法安全验证，相关结论已省略';
  }
}

function formatPpmAsPercent(value: string): string {
  try {
    const ppm = BigInt(value);
    const negative = ppm < 0n;
    const absolute = negative ? -ppm : ppm;
    const integer = absolute / 10_000n;
    const fraction = (absolute % 10_000n).toString().padStart(4, '0').replace(/0+$/u, '');
    return `${negative ? '-' : ''}${integer.toString()}${fraction.length === 0 ? '' : `.${fraction}`}%`;
  } catch {
    return `${value} ppm`;
  }
}

function confidenceForAnalysisStatus(status: 'insufficient_data' | 'partial' | 'success'): number {
  switch (status) {
    case 'success':
      return 0.92;
    case 'partial':
      return 0.65;
    case 'insufficient_data':
      return 0.35;
  }
}

function confidenceForSandwichResult(result: DetectSandwichOutput): number {
  if (result.capability.status === 'insufficient_data') {
    return 0.35;
  }
  if (result.capability.status === 'partial' || result.capability.verdict === 'likely') {
    return 0.65;
  }
  return 0.92;
}

function assertPublicCaller(caller: PublicChainAnalysisCaller): void {
  if (
    (caller.channel === 'web' && caller.principal === 'anonymous') ||
    (caller.channel === 'telegram' && caller.principal === 'service')
  ) {
    return;
  }
  throw new TypeError('Public transaction Tool requires web/anonymous or telegram/service caller.');
}

function invocationContext(
  caller: PublicChainAnalysisCaller,
  requestId: string | undefined,
): CapabilityInvocationContext {
  return {
    channel: caller.channel,
    principal: caller.principal,
    ...(requestId === undefined ? {} : { requestId }),
  };
}
