import { z } from 'zod';

import { chatResponseSchema, type ChatResponse } from '@xxyy/shared';
import {
  BUILT_IN_EVM_NETWORKS,
  EgoBrowserUnavailableError,
  ExplorerBrowserVerificationError,
  PublicTransactionReferenceError,
  SOLANA_MAINNET_NETWORK,
  findBuiltInEvmNetworkByChainId,
  getTransactionOutputSchema,
  normalizePublicNetworkIdentifier,
  resolvePublicTransactionReference,
  type GetTransactionInput,
  type GetTransactionOutput,
} from '@orbitrelaylabs/xxyy-transaction-agent-kit/runtime';

import {
  CHAIN_GET_SKILL_CAPABILITY_ID,
  type PublicChainAnalysisCaller,
} from './chain-analysis-capabilities.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { ToolDefinition } from './tool-registry.js';

export const PUBLIC_TRANSACTION_TOOL_NAME = 'get_public_transaction';

const MAX_PUBLIC_TRANSACTIONS_PER_QUESTION = 3;
const transactionQueryInputSchema = z
  .object({ query: z.string().trim().min(1).max(8_192) })
  .strict();

type QueryResolution =
  | { inputs: GetTransactionInput[]; status: 'ready' }
  | { status: 'invalid_reference' | 'missing_network' | 'too_many' };

export function createPublicChainTransactionTool(options: {
  caller: PublicChainAnalysisCaller;
  registry: CapabilityRegistry;
}): ToolDefinition<
  typeof PUBLIC_TRANSACTION_TOOL_NAME,
  typeof transactionQueryInputSchema,
  typeof chatResponseSchema
> {
  return {
    name: PUBLIC_TRANSACTION_TOOL_NAME,
    description:
      'Read up to three basic public EVM or Solana transactions from fixed Explorer pages in an isolated browser. Never use for call traces, MEV conclusions, wallet history, signing, simulation, or execution.',
    inputSchema: transactionQueryInputSchema,
    outputSchema: chatResponseSchema,
    async execute(input, context) {
      const resolution = resolveTransactionQueries(input.query);
      if (resolution.status !== 'ready') return clarification(resolution.status);
      try {
        const results = await Promise.all(
          resolution.inputs.map(async (transactionInput) =>
            getTransactionOutputSchema.parse(
              await options.registry.invoke(CHAIN_GET_SKILL_CAPABILITY_ID, transactionInput, {
                channel: options.caller.channel,
                principal: options.caller.principal,
                ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
              }),
            ),
          ),
        );
        return formatResults(results);
      } catch (error) {
        return queryError(error);
      }
    },
  };
}

export function hasPublicTransactionReference(query: string): boolean {
  return resolveTransactionQueries(query).status !== 'invalid_reference';
}

export function resolveSinglePublicTransactionInput(
  query: string,
): GetTransactionInput | undefined {
  const resolution = resolveTransactionQueries(query);
  return resolution.status === 'ready' && resolution.inputs.length === 1
    ? resolution.inputs[0]
    : undefined;
}

function resolveTransactionQueries(query: string): QueryResolution {
  const explorerInputs = resolveExplorerInputs(query);
  if (explorerInputs.length > MAX_PUBLIC_TRANSACTIONS_PER_QUESTION) return { status: 'too_many' };
  if (explorerInputs.length > 0) return { inputs: explorerInputs, status: 'ready' };
  const network = detectExplicitNetwork(query);
  const evmHashes = uniqueMatches(query, /\b0x[a-fA-F0-9]{64}\b/gu);
  if (evmHashes.length > 0) {
    if (network === undefined) return { status: 'missing_network' };
    const canonical = normalizePublicNetworkIdentifier(network);
    if (canonical === undefined || !canonical.startsWith('eip155:'))
      return { status: 'invalid_reference' };
    if (evmHashes.length > MAX_PUBLIC_TRANSACTIONS_PER_QUESTION) return { status: 'too_many' };
    return {
      inputs: evmHashes.map((reference) => ({ network: canonical, reference })),
      status: 'ready',
    };
  }
  if (normalizePublicNetworkIdentifier(network ?? '') === SOLANA_MAINNET_NETWORK) {
    const signatures = uniqueMatches(query, /\b[1-9A-HJ-NP-Za-km-z]{64,128}\b/gu).filter(
      (reference) => {
        try {
          resolvePublicTransactionReference({ network: SOLANA_MAINNET_NETWORK, reference });
          return true;
        } catch {
          return false;
        }
      },
    );
    if (signatures.length > MAX_PUBLIC_TRANSACTIONS_PER_QUESTION) return { status: 'too_many' };
    if (signatures.length > 0) {
      return {
        inputs: signatures.map((reference) => ({ network: SOLANA_MAINNET_NETWORK, reference })),
        status: 'ready',
      };
    }
  }
  return { status: 'invalid_reference' };
}

function resolveExplorerInputs(query: string): GetTransactionInput[] {
  const resolved = new Map<string, GetTransactionInput>();
  for (const candidate of extractHttpsUrls(query)) {
    try {
      const reference = resolvePublicTransactionReference({ reference: candidate });
      resolved.set(`${reference.network}:${reference.transactionId}`, {
        reference: reference.explorerUrl ?? reference.transactionId,
        ...(reference.explorerUrl === undefined ? { network: reference.network } : {}),
      });
    } catch {
      // Ignore unrelated links.
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
  for (const value of normalized.match(/\b(?:eip155:[1-9]\d*|solana:mainnet)\b/gu) ?? []) {
    const network = normalizePublicNetworkIdentifier(value);
    if (network !== undefined) matches.add(network);
  }
  for (const profile of BUILT_IN_EVM_NETWORKS) {
    if (
      [profile.name.toLowerCase(), ...profile.aliases].some((name) =>
        containsNetworkName(normalized, name),
      )
    ) {
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

function formatResults(results: GetTransactionOutput[]): ChatResponse {
  const sections = results.map(formatSection);
  return chatResponseSchema.parse({
    agentRoute: 'chain_answer',
    answer: [
      ...(sections.length > 1 ? [`共查询 ${sections.length} 笔公开交易。`, ''] : []),
      ...sections.flatMap((section, index) => [
        section.title,
        ...section.lines,
        ...(index + 1 === sections.length ? [] : ['']),
      ]),
      '',
      '说明：以上事实来自固定公开 Explorer 的浏览器页面，属于部分单源证据；不包含 RPC 共识、调用追踪或确定性 MEV 结论。',
    ].join('\n'),
    citations: sections.flatMap((section) => section.citations),
    confidence: Math.min(...sections.map((section) => section.confidence)),
    intent: 'onchain_transaction',
  }) as ChatResponse;
}

function formatSection(result: GetTransactionOutput) {
  const name =
    result.family === 'solana'
      ? 'Solana'
      : (findBuiltInEvmNetworkByChainId(result.chainId)?.name ?? result.network);
  const citationTitle = `${name} 交易 ${shortId(result.transactionId)}`;
  const citations =
    result.explorerUrl === undefined
      ? []
      : [
          {
            excerpt: `${name} 公开 Explorer 交易页面。`,
            file: `onchain/${result.network}/${result.transactionId}`,
            sourceUrl: result.explorerUrl,
            title: citationTitle,
          },
        ];
  if (result.family === 'solana') {
    const tx = result.analysis;
    return {
      citations,
      confidence: result.status === 'partial' ? 0.65 : 0.8,
      lines:
        tx === undefined
          ? ['数据不足。']
          : [
              `执行结果：${tx.executionStatus}`,
              `交易签名：${tx.transactionId}`,
              `Slot：${tx.slot}`,
              ...(tx.blockTime === undefined ? [] : [`区块时间：${tx.blockTime}`]),
              ...(tx.feeLamports === undefined ? [] : [`手续费：${tx.feeLamports} lamports`]),
            ],
      title: `**${citationTitle}**`,
    };
  }
  const tx = result.analysis.transaction;
  const failed = tx.executionStatus === 'reverted';
  const nativeSymbol = nativeCurrencySymbol(tx.chainId);
  return {
    citations,
    confidence: result.status === 'partial' ? 0.65 : 0.8,
    lines: [
      ...(failed
        ? [
            '',
            '**❌ 失败原因**',
            tx.failureReason === undefined
              ? '`execution reverted（未解析到具体原因）`'
              : `\`${tx.failureReason}\``,
          ]
        : []),
      '',
      '**交易概览**',
      `状态：${executionStatusLabel(tx.executionStatus)}`,
      `交易哈希：\`${tx.hash}\``,
      ...(tx.blockNumber === undefined ? [] : [`区块：\`${tx.blockNumber}\``]),
      ...(tx.blockTimestamp === undefined
        ? []
        : [`区块时间：${new Date(Number(tx.blockTimestamp) * 1_000).toISOString()}`]),
      '',
      '**地址**',
      ...(tx.from === undefined ? ['发送方：未解析'] : [`发送方：\`${tx.from}\``]),
      ...(tx.to === undefined
        ? ['接收方：未解析']
        : [`接收方：${tx.to === null ? '合约创建' : `\`${tx.to}\``}`]),
      '',
      '**金额与费用**',
      ...(tx.valueWei === undefined ? [] : [`原生币金额：${formatWei(tx.valueWei, nativeSymbol)}`]),
      ...(tx.feeWei === undefined ? [] : [`手续费：${formatWei(tx.feeWei, nativeSymbol)}`]),
      `Token 转账：${result.analysis.tokenTransfers.length} 条`,
    ],
    title: failed
      ? `**🚨 ${name} 交易执行失败 ${shortId(result.transactionId)}**`
      : `**✅ ${citationTitle}**`,
  };
}

function executionStatusLabel(status: 'pending' | 'reverted' | 'success' | 'unknown'): string {
  switch (status) {
    case 'success':
      return '✅ 成功';
    case 'reverted':
      return '❌ 失败（reverted）';
    case 'pending':
      return '⏳ 待确认';
    case 'unknown':
      return '⚠️ 未知';
  }
}

function nativeCurrencySymbol(chainId: string): string | undefined {
  switch (chainId) {
    case '56':
      return 'BNB';
    case '1':
    case '8453':
      return 'ETH';
    default:
      return undefined;
  }
}

function formatWei(value: string, symbol: string | undefined): string {
  const wei = BigInt(value);
  const base = 1_000_000_000_000_000_000n;
  const whole = wei / base;
  const fraction = (wei % base).toString().padStart(18, '0').replace(/0+$/u, '');
  const amount = `${whole}${fraction.length === 0 ? '' : `.${fraction}`}`;
  return `${amount}${symbol === undefined ? '（原生币）' : ` ${symbol}`}（\`${value}\` wei）`;
}

function clarification(status: Exclude<QueryResolution['status'], 'ready'>): ChatResponse {
  const answer =
    status === 'missing_network'
      ? '识别到了交易哈希，但无法确定网络。请注明 Ethereum、BSC、Base、Robinhood Chain、Stable Chain 或 Solana，最好直接发送 Explorer 交易链接。'
      : status === 'too_many'
        ? `一次最多查询 ${MAX_PUBLIC_TRANSACTIONS_PER_QUESTION} 笔公开交易。`
        : '请提供受支持的公开 Explorer 交易链接，或同时提供网络名称和交易哈希/签名。';
  return chatResponseSchema.parse({
    agentRoute: 'clarify',
    answer,
    citations: [],
    confidence: 0.4,
    intent: 'onchain_transaction',
  }) as ChatResponse;
}

function queryError(error: unknown): ChatResponse {
  const answer =
    error instanceof PublicTransactionReferenceError
      ? '交易链接、交易哈希或网络不匹配，请检查后重试。'
      : error instanceof EgoBrowserUnavailableError
        ? '受保护的 Explorer 查询需要安装 ego-browser。请从 https://lite.ego.app/ 安装 ego lite、完成首次引导后重启服务；产品知识问答不受影响。'
        : error instanceof ExplorerBrowserVerificationError
          ? 'Explorer 需要完成人机验证。请在已配置的持久浏览器会话中完成验证后重试；系统不会自动绕过验证。'
          : 'Explorer 浏览器查询暂时不可用，请稍后重试。';
  return chatResponseSchema.parse({
    agentRoute: 'clarify',
    answer,
    citations: [],
    confidence: 0.2,
    intent: 'onchain_transaction',
  }) as ChatResponse;
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}
