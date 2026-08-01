import { createLocalHashEmbedding, tokenize } from '@xxyy/knowledge';
import type { IndexEntry, RagIndex, SourceType } from '@xxyy/shared';

import { extractSupportEntityTokens, supportEntityEvidenceBoost } from './support-entity.js';
import type { ProductRetrievalPolicy } from './product-question.js';
import { createKnowledgeAliasQueryTokens, expandKnowledgeAliasText } from './knowledge-aliases.js';

export interface RetrieveOptions {
  policy?: ProductRetrievalPolicy;
  topK?: number;
}

export interface RetrievedChunk extends IndexEntry {
  rank: number;
  score: number;
  lexicalScore: number;
  sourceBoost: number;
  vectorScore: number;
  freshnessBoost?: number;
  fusionScore?: number;
  entityRank?: number;
  lexicalRank?: number;
  vectorRank?: number;
}

const DEFAULT_TOP_K = 6;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const VECTOR_WEIGHT = 0.35;
const LEXICAL_WEIGHT = 1;
const VECTOR_ONLY_MATCH_THRESHOLD = 0.9;
const TIE_EPSILON = 1e-12;
const CURRENT_STATUS_BOOST = 0.2;
const CURRENT_X_UPDATE_BOOST = 0.25;
const HISTORICAL_STATUS_PENALTY = -0.45;
const DEPRECATED_STATUS_PENALTY = -8;
const EFFECTIVE_AT_EPOCH = Date.UTC(2024, 0, 1);
const FRESHNESS_BOOST_PER_YEAR = 0.08;
const MAX_FRESHNESS_BOOST = 0.4;
const API_REFERENCE_CONTEXT_BOOST = 40;
const EXTERNAL_DEVELOPER_CONTEXT_BOOST = 36;

export function retrieve(
  question: string,
  index: RagIndex,
  options: RetrieveOptions = {},
): RetrievedChunk[] {
  const queryTokens = Array.from(
    new Set([...createRetrieveQueryTokens(question), ...createKnowledgeAliasQueryTokens(question)]),
  );
  const supportEntities = extractSupportEntityTokens(question);
  const topK = normalizeTopK(options.topK);

  if (queryTokens.length === 0 || index.entries.length === 0 || topK <= 0) {
    return [];
  }

  const eligibleEntries = selectEligibleEntries(question, index.entries);
  if (eligibleEntries.length === 0) {
    return [];
  }

  const documentFrequency = createDocumentFrequency(eligibleEntries);
  const averageDocumentLength = averageTokenLength(eligibleEntries);
  const queryEmbedding = createLocalHashEmbedding(createSemanticRetrieveQuery(question));

  const anchorDocumentIds = options.policy?.anchorDocumentIds ?? [];
  const scored = eligibleEntries
    .map((entry) => {
      const lexicalScore = calculateBm25(
        queryTokens,
        entry,
        documentFrequency,
        eligibleEntries.length,
        averageDocumentLength,
      );
      const vectorScore = Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding));
      const contextScore = calculateContextScore(question, entry);
      const sourceBoost = calculateSourceBoost(entry.metadata.sourceType);
      const freshnessBoost = calculateFreshnessBoost(question, entry);
      const entityBoost = supportEntityEvidenceBoost(
        [
          entry.metadata.title,
          entry.metadata.module,
          ...entry.metadata.headingPath,
          entry.text,
        ].join(' '),
        supportEntities,
      );
      const score = roundScore(
        LEXICAL_WEIGHT * lexicalScore +
          VECTOR_WEIGHT * vectorScore +
          contextScore +
          sourceBoost +
          freshnessBoost +
          entityBoost,
      );

      return {
        ...entry,
        freshnessBoost: roundScore(freshnessBoost),
        lexicalScore: roundScore(lexicalScore),
        vectorScore: roundScore(vectorScore),
        sourceBoost: roundScore(sourceBoost),
        score,
      };
    })
    .filter(
      (entry) =>
        anchorDocumentIds.includes(entry.documentId) ||
        entry.lexicalScore > 0 ||
        (entry.lexicalScore === 0 && entry.vectorScore >= VECTOR_ONLY_MATCH_THRESHOLD),
    )
    .sort(compareScoredEntries);

  return pinRetrievalPolicyAnchors(scored, anchorDocumentIds, topK).map((entry, indexOfEntry) => ({
    ...entry,
    rank: indexOfEntry + 1,
  }));
}

export function pinRetrievalPolicyAnchors<T extends { documentId: string; id?: string }>(
  chunks: readonly T[],
  anchorDocumentIds: readonly string[],
  topK: number,
): T[] {
  if (anchorDocumentIds.length === 0) {
    return chunks.slice(0, topK);
  }
  const selected: T[] = [];
  const selectedChunks = new Set<T>();
  for (const documentId of anchorDocumentIds) {
    const anchor = chunks
      .filter((chunk) => chunk.documentId === documentId && !selectedChunks.has(chunk))
      .sort((left, right) => (left.id ?? '').localeCompare(right.id ?? ''))[0];
    if (anchor !== undefined && selected.length < topK) {
      selected.push(anchor);
      selectedChunks.add(anchor);
    }
  }
  for (const chunk of chunks) {
    if (selected.length >= topK) {
      break;
    }
    if (!selectedChunks.has(chunk)) {
      selected.push(chunk);
      selectedChunks.add(chunk);
    }
  }
  return selected;
}

function selectEligibleEntries(question: string, entries: IndexEntry[]): IndexEntry[] {
  const audienceEligibleEntries = entries.filter((entry) =>
    isDocumentationScopeEligible(question, entry.metadata),
  );

  if (isHistoricalOrTweetQuestion(question)) {
    return audienceEligibleEntries;
  }

  const supersededIds = new Set(
    audienceEligibleEntries
      .filter((entry) => entry.metadata.status === 'current')
      .flatMap((entry) => entry.metadata.supersedes ?? []),
  );

  if (supersededIds.size === 0) {
    return audienceEligibleEntries;
  }

  return audienceEligibleEntries.filter(
    (entry) => !supersededIds.has(entry.id) && !supersededIds.has(entry.documentId),
  );
}

export function isApiDocumentationQuestion(question: string): boolean {
  return /\bapi\b|\bapi[ _-]?key\b|\brest(?:ful)?\b|\bsdk\b|\bendpoint\b|\bauthorization\b|\bbearer\b|接口|开发者文档|请求头|错误码|频率限制|\bqps\b/iu.test(
    question.normalize('NFKC').toLowerCase(),
  );
}

export function isApiReferenceDocument(metadata: {
  module: string;
  title: string;
  sourceUrl?: string;
}): boolean {
  return (
    /(?:^|\s)api(?:\s|$)|api 参考/iu.test(`${metadata.title} ${metadata.module}`) ||
    metadata.sourceUrl?.includes('/xxyy-api-can-kao-wen-dang') === true
  );
}

export function shouldIncludeApiReferenceDocumentation(question: string): boolean {
  return isApiDocumentationQuestion(question) && !isHistoricalOrTweetQuestion(question);
}

export function isExternalDeveloperDocumentationQuestion(question: string): boolean {
  const normalized = question.normalize('NFKC').toLowerCase();
  return (
    isApiDocumentationQuestion(normalized) ||
    /agent\s*skill|api\s*skill|\bskill\b|\bmcp\b|clawhub|openclaw|github|智能体技能|代理技能|技能仓库|代码仓库/iu.test(
      normalized,
    )
  );
}

export function isExternalDeveloperDocument(metadata: {
  module: string;
  title: string;
  sourceUrl?: string;
}): boolean {
  return (
    metadata.sourceUrl?.includes('github.com/Jimmy-Holiday/xxyy-trade-skill/') === true ||
    /Developer\s*\/\s*Agent Skill/iu.test(metadata.module)
  );
}

export function shouldIncludeExternalDeveloperDocumentation(question: string): boolean {
  return (
    isExternalDeveloperDocumentationQuestion(question) && !isHistoricalOrTweetQuestion(question)
  );
}

export function isChangelogDocumentationQuestion(question: string): boolean {
  const normalized = question.normalize('NFKC').toLowerCase();
  return (
    /更新|升级|新增|上线|版本|changelog|release\s*notes|what'?s\s*new|\bv?\d+\.\d+/iu.test(
      normalized,
    ) || isProductTimelineQuestion(normalized)
  );
}

export function isLegalDocumentationQuestion(question: string): boolean {
  return /用户条款|服务条款|使用条款|隐私|协议|个人信息|个人资料|cookie|gdpr|仲裁|terms|privacy|legal/iu.test(
    question.normalize('NFKC').toLowerCase(),
  );
}

export function shouldIncludeEnglishDocumentation(question: string): boolean {
  const normalized = question.normalize('NFKC').toLowerCase();
  return /英文|英语|english/u.test(normalized) || !/\p{Script=Han}/u.test(normalized);
}

export function isDocumentationScopeEligible(
  question: string,
  metadata: {
    module: string;
    title: string;
    sourceUrl?: string;
  },
): boolean {
  if (
    isExternalDeveloperDocument(metadata) &&
    !shouldIncludeExternalDeveloperDocumentation(question)
  ) {
    return false;
  }
  if (isApiReferenceDocument(metadata) && !shouldIncludeApiReferenceDocumentation(question)) {
    return false;
  }
  if (isChangelogDocument(metadata) && !isChangelogDocumentationQuestion(question)) {
    return false;
  }
  if (isLegalDocument(metadata) && !isLegalDocumentationQuestion(question)) {
    return false;
  }
  if (isEnglishDocument(metadata) && !shouldIncludeEnglishDocumentation(question)) {
    return false;
  }
  return true;
}

function isChangelogDocument(metadata: { sourceUrl?: string }): boolean {
  return (
    metadata.sourceUrl?.endsWith('/changelog') === true ||
    metadata.sourceUrl?.endsWith('/en/feature-updates') === true
  );
}

function isLegalDocument(metadata: { sourceUrl?: string }): boolean {
  return (
    metadata.sourceUrl?.includes('/wang-zhan-xie-yi/') === true ||
    metadata.sourceUrl?.includes('/en/xxyy-terms/') === true
  );
}

function isEnglishDocument(metadata: { sourceUrl?: string }): boolean {
  if (metadata.sourceUrl === undefined) {
    return false;
  }
  try {
    const pathname = new URL(metadata.sourceUrl, 'https://docs.xxyy.io').pathname;
    return pathname === '/en' || pathname.startsWith('/en/');
  } catch {
    return false;
  }
}

export function createRetrieveQueryTokens(question: string): string[] {
  return uniqueTokens(tokenize(createSemanticRetrieveQuery(question)));
}

const LEXICAL_QUERY_STOP_TOKENS = new Set([
  'xxyy',
  '什么',
  '哪些',
  '可以',
  '如何',
  '怎么',
  '是否',
  '支持',
  '当前',
  '现在',
]);

export function createLexicalRetrieveQueryTokens(question: string): string[] {
  return createRetrieveQueryTokens(question).filter(
    (token) => token.length > 1 && !LEXICAL_QUERY_STOP_TOKENS.has(token),
  );
}

export function createSemanticRetrieveQuery(question: string): string {
  const aliasExpandedQuestion = expandKnowledgeAliasText(question);
  const expansions = createQueryExpansionPhrases(aliasExpandedQuestion);
  return expansions.length === 0
    ? aliasExpandedQuestion
    : [aliasExpandedQuestion, ...expansions].join('\n');
}

function createQueryExpansionPhrases(question: string): string[] {
  const expansions: string[] = [];
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  const isProUpgradeQuestion = /升级.*\bpro\b|\bpro\b.*升级/u.test(normalizedQuestion);
  const isPermanentProQuestion = /永久\s*pro|\bpro\b.{0,12}永久/u.test(normalizedQuestion);

  if (
    /付费套餐|付费会员|高级会员|会员套餐|会员权益|会员版|会员有(?:什么|啥)|高级版|专业版|\bpro\b/u.test(
      normalizedQuestion,
    ) &&
    !isProUpgradeQuestion &&
    !isPermanentProQuestion
  ) {
    expansions.push('XXYY Pro 权益 会员权益');
  }

  if (isProUpgradeQuestion) {
    expansions.push('如何升级为 Pro 会员积分 交易积分');
  }

  if (isPermanentProQuestion) {
    expansions.push('永久PRO 额外权益 定制化功能开发 长期有效 专属客服');
  }

  if (/基础套餐|基础版|免费版|\bbasic\b/u.test(normalizedQuestion)) {
    expansions.push('XXYY Basic 基础权益');
  }

  if (/地址|追踪|跟踪/u.test(normalizedQuestion)) {
    expansions.push('钱包监控');
  }

  if (/扫链.{0,16}(?:过滤|筛选|条件)|(?:过滤|筛选).{0,16}扫链/u.test(normalizedQuestion)) {
    expansions.push('扫链筛选 筛选条件');
  }

  if (/发射台|发射平台|launch\s*(?:pad|platform)/u.test(normalizedQuestion)) {
    expansions.push('XXYY 扫链 发射平台 发射台 launchpad 按链筛选');
  }

  const asksSupportedChains =
    /支持(?:哪些|什么|哪几)(?:条)?(?:公)?链|(?:哪些|什么|哪几)(?:条)?(?:公)?链支持/u.test(
      normalizedQuestion,
    ) ||
    /(?:支持|support(?:s|ed)?).{0,12}(?:which|what|哪些|什么)?\s*(?:blockchains?|chains?)|(?:which|what)\s*(?:blockchains?|chains?).{0,12}(?:支持|support(?:s|ed)?)/u.test(
      normalizedQuestion,
    );

  if (asksSupportedChains) {
    expansions.push('XXYY 当前产品支持的区块链 公链 多链交易');
    if (/跟单|copy\s*trad(?:e|ing)/u.test(normalizedQuestion)) {
      expansions.push('XXYY 跟单支持链 跟单交易支持公链');
    }
  }

  if (/手机|手机版|手机上|主屏幕|手机桌面/u.test(normalizedQuestion)) {
    expansions.push('XXYY 移动端桌面入口 手机浏览器 添加到主屏幕 添加到桌面');
  }

  if (
    /小币种|小币|小额(?:代币|资产)|隐藏.{0,8}(?:代币|资产)|(?:代币|资产).{0,8}不显示/u.test(
      normalizedQuestion,
    )
  ) {
    expansions.push('持仓管理 隐藏小额代币 展示所有代币');
  }

  if (
    /盯.{0,12}(?:地址|钱包)|(?:地址|钱包).{0,12}(?:提醒|推送|通知)|提醒.{0,12}(?:地址|钱包)/u.test(
      normalizedQuestion,
    )
  ) {
    expansions.push('关注钱包设置 推送规则 最小买入金额 最小卖出金额');
  }

  if (
    /赚.{0,8}(?:多少|几).{0,4}倍|亏.{0,8}(?:多少|几)|收益倍数|盈利倍数|盈亏倍率|回本/u.test(
      normalizedQuestion,
    )
  ) {
    expansions.push('持仓盈亏 盈亏倍率 收益统计');
  }

  return [...new Set(expansions)];
}

function calculateBm25(
  queryTokens: string[],
  entry: IndexEntry,
  documentFrequency: Map<string, number>,
  documentCount: number,
  averageDocumentLength: number,
): number {
  const termFrequency = createTermFrequency(entry.tokens);
  let score = 0;

  for (const token of queryTokens) {
    const frequency = termFrequency.get(token) ?? 0;
    if (frequency === 0) {
      continue;
    }

    const documentsWithToken = documentFrequency.get(token) ?? 0;
    const idf = Math.log(
      1 + (documentCount - documentsWithToken + 0.5) / (documentsWithToken + 0.5),
    );
    const lengthNorm =
      BM25_K1 * (1 - BM25_B + BM25_B * (entry.tokens.length / averageDocumentLength));
    score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + lengthNorm));
  }

  return score;
}

function calculateSourceBoost(sourceType: SourceType): number {
  return sourceType === 'x_updates' ? 0 : 0.05;
}

function calculateFreshnessBoost(question: string, entry: IndexEntry): number {
  const status = entry.metadata.status;
  const isHistoryQuestion = isHistoricalOrTweetQuestion(question);
  let boost = 0;

  if (status === 'deprecated') {
    boost += DEPRECATED_STATUS_PENALTY;
  } else if (status === 'historical') {
    boost += isHistoryQuestion ? 0 : HISTORICAL_STATUS_PENALTY;
  } else if (status === 'current') {
    boost += isHistoryQuestion ? 0 : CURRENT_STATUS_BOOST;
    if (!isHistoryQuestion && entry.metadata.sourceType === 'x_updates') {
      boost += CURRENT_X_UPDATE_BOOST;
    }
  }

  if (!isHistoryQuestion && status === 'current') {
    boost += effectiveAtFreshnessBoost(entry.metadata.effectiveAt);
  }

  return boost;
}

function effectiveAtFreshnessBoost(effectiveAt: string | undefined): number {
  if (effectiveAt === undefined) {
    return 0;
  }

  const timestamp = Date.parse(effectiveAt);
  if (!Number.isFinite(timestamp) || timestamp <= EFFECTIVE_AT_EPOCH) {
    return 0;
  }

  const yearsSinceEpoch = (timestamp - EFFECTIVE_AT_EPOCH) / (365 * 24 * 60 * 60 * 1000);
  return Math.min(MAX_FRESHNESS_BOOST, yearsSinceEpoch * FRESHNESS_BOOST_PER_YEAR);
}

export function isHistoricalOrTweetQuestion(question: string): boolean {
  const normalized = question.normalize('NFKC').toLowerCase();
  return (
    /历史|以前|之前|过去|曾经|当时|截至(?:当时|那时|\d)|(?:19|20)\d{2}(?:\s*年|[-/]\d{1,2})|更新日志|变更|changelog|哪条推文|哪条推特|推文|推特|tweet|x\s*post/iu.test(
      normalized,
    ) || isProductTimelineQuestion(normalized)
  );
}

function isProductTimelineQuestion(normalizedQuestion: string): boolean {
  return /什么时候|何时|哪年|哪月|哪天|开放时间|发布时间|发布日期|推出时间|上线时间|开始开放|最初开放|首次开放|when\s+(?:was|did)|timeline/iu.test(
    normalizedQuestion,
  );
}

function calculateContextScore(question: string, entry: IndexEntry): number {
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  const apiScore =
    shouldIncludeApiReferenceDocumentation(normalizedQuestion) &&
    isApiReferenceDocument(entry.metadata)
      ? API_REFERENCE_CONTEXT_BOOST
      : 0;
  const externalDeveloperScore =
    shouldIncludeExternalDeveloperDocumentation(normalizedQuestion) &&
    isExternalDeveloperDocument(entry.metadata)
      ? EXTERNAL_DEVELOPER_CONTEXT_BOOST
      : 0;
  if (!isTradingOperationQuestion(normalizedQuestion)) {
    return apiScore + externalDeveloperScore;
  }

  const title = entry.metadata.title.toLowerCase();
  const module = entry.metadata.module.toLowerCase();
  const headingText = entry.metadata.headingPath.join(' ').toLowerCase();
  const combinedMetadata = `${title} ${module} ${headingText}`;
  let score = 0;

  if (module.includes('交易代币')) {
    score += 6;
  }

  if (/\bswap\b|swap 交易|快捷交易/u.test(combinedMetadata)) {
    score += normalizedQuestion.includes('挂单') ? 6 : 16;
  }

  if (/挂单/u.test(combinedMetadata)) {
    score += normalizedQuestion.includes('挂单') ? 16 : 6;
  }

  if (/交易金额|一键买卖|买入.*sol|卖出代币/u.test(entry.text)) {
    score += 4;
  }

  return score + apiScore + externalDeveloperScore;
}

function isTradingOperationQuestion(normalizedQuestion: string): boolean {
  return /买入|卖出|买卖|交易代币|\bswap\b|挂单/u.test(normalizedQuestion);
}

function createDocumentFrequency(entries: IndexEntry[]): Map<string, number> {
  const frequencies = new Map<string, number>();

  for (const entry of entries) {
    for (const token of uniqueTokens(entry.tokens)) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }

  return frequencies;
}

function createTermFrequency(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();

  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }

  return frequencies;
}

function averageTokenLength(entries: IndexEntry[]): number {
  const totalLength = entries.reduce((total, entry) => total + entry.tokens.length, 0);
  return totalLength / entries.length || 1;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const dimensions = Math.min(left.length, right.length);
  if (dimensions === 0) {
    return 0;
  }

  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < dimensions; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dotProduct += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function compareScoredEntries(
  left: Omit<RetrievedChunk, 'rank'>,
  right: Omit<RetrievedChunk, 'rank'>,
): number {
  if (Math.abs(right.score - left.score) > TIE_EPSILON) {
    return right.score - left.score;
  }

  const statusPreference = statusRank(left.metadata.status) - statusRank(right.metadata.status);
  if (statusPreference !== 0) {
    return statusPreference;
  }

  const effectiveAtPreference =
    effectiveAtRank(right.metadata.effectiveAt) - effectiveAtRank(left.metadata.effectiveAt);
  if (effectiveAtPreference !== 0) {
    return effectiveAtPreference;
  }

  const sourcePreference =
    sourceRank(left.metadata.sourceType) - sourceRank(right.metadata.sourceType);
  if (sourcePreference !== 0) {
    return sourcePreference;
  }

  return left.id.localeCompare(right.id);
}

function sourceRank(sourceType: SourceType): number {
  return sourceType === 'x_updates' ? 1 : 0;
}

function statusRank(status: IndexEntry['metadata']['status']): number {
  switch (status) {
    case 'current':
      return 0;
    case 'historical':
      return 1;
    case 'deprecated':
      return 2;
    case undefined:
      return 1;
  }
}

function effectiveAtRank(effectiveAt: string | undefined): number {
  if (effectiveAt === undefined) {
    return 0;
  }

  const timestamp = Date.parse(effectiveAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens));
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined) {
    return DEFAULT_TOP_K;
  }

  if (!Number.isInteger(topK) || topK <= 0) {
    return DEFAULT_TOP_K;
  }

  return topK;
}

function roundScore(score: number): number {
  return Number(score.toFixed(8));
}
