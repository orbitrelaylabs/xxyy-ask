import type { RagIndex } from '@xxyy/shared';
import { tokenize } from '@xxyy/knowledge';

import { reciprocalRankFusionScore } from './hybrid-rank.js';
import {
  createRetrieveQueryTokens,
  isHistoricalOrTweetQuestion,
  retrieve,
  type RetrieveOptions,
  type RetrievedChunk,
} from './retrieve.js';
import type { ProductRetrievalPolicy } from './product-question.js';
import { isSupportQuestionText } from './support-entity.js';
import {
  noopQualityTracer,
  summarizeRetrievedChunks,
  type QualityTracer,
} from './quality-trace.js';

export interface Retriever {
  retrieve(
    question: string,
    options: RetrieveOptions,
  ): Promise<RetrievedChunk[]> | RetrievedChunk[];
}

export interface Reranker {
  rerank(input: {
    question: string;
    chunks: RetrievedChunk[];
    topK: number;
  }): Promise<RetrievedChunk[]> | RetrievedChunk[];
}

export interface RerankingRetrieverOptions {
  candidateMultiplier?: number;
  tracer?: QualityTracer;
}

const BASE_RANK_WEIGHT = 2;
const BASE_SCORE_WEIGHT = 5;
const METADATA_RERANK_WEIGHT = 3;
const TITLE_CONTAINMENT_WEIGHT = 2;
const CONTENT_COVERAGE_WEIGHT = 6;
const HOW_TO_DIRECT_EVIDENCE_BONUS = 3;
const STRUCTURED_ANSWER_WEIGHT = 3;
const DIRECT_SUPPORT_EVIDENCE_WEIGHT = 2;
const DIRECT_SOURCE_WEIGHT = 1;
const TEMPORAL_STATUS_WEIGHT = 1.5;
const QUERY_STOP_TOKENS = new Set([
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
  '版都',
  '都有',
  '有啥',
]);

export function createLazyRetriever(
  createRetriever: () => Promise<Retriever> | Retriever,
): Retriever {
  let cachedRetriever: Retriever | undefined;
  let pendingRetriever: Promise<Retriever> | undefined;

  async function loadRetriever(): Promise<Retriever> {
    if (cachedRetriever !== undefined) {
      return cachedRetriever;
    }

    pendingRetriever ??= Promise.resolve()
      .then(createRetriever)
      .then(
        (retriever) => {
          cachedRetriever = retriever;
          return retriever;
        },
        (error: unknown) => {
          pendingRetriever = undefined;
          throw error;
        },
      );

    return pendingRetriever;
  }

  return {
    async retrieve(question: string, options: RetrieveOptions): Promise<RetrievedChunk[]> {
      const retriever = await loadRetriever();
      return retriever.retrieve(question, options);
    },
  };
}

export function createRerankingRetriever(
  retriever: Retriever,
  reranker?: Reranker,
  options: RerankingRetrieverOptions = {},
): Retriever {
  if (reranker === undefined) {
    return retriever;
  }

  return {
    async retrieve(question: string, retrieveOptions: RetrieveOptions): Promise<RetrievedChunk[]> {
      const topK = normalizeTopK(retrieveOptions.topK);
      const candidateTopK = topK * normalizeCandidateMultiplier(options.candidateMultiplier);
      const candidates = await retriever.retrieve(question, {
        ...retrieveOptions,
        topK: candidateTopK,
      });
      const tracer = options.tracer ?? noopQualityTracer;
      return tracer.run(
        {
          inputs: {
            candidates: summarizeRetrievedChunks(candidates),
            ...(retrieveOptions.policy === undefined
              ? {}
              : {
                  retrievalPolicy: {
                    anchorDocumentCount: retrieveOptions.policy.anchorDocumentIds.length,
                    diversity: retrieveOptions.policy.diversity,
                    preferredSourceTypes: retrieveOptions.policy.preferredSourceTypes,
                    temporalScope: retrieveOptions.policy.temporalScope,
                    version: retrieveOptions.policy.version,
                  },
                }),
            topK,
          },
          name: 'rag.metadata_rerank',
          output: (chunks) => ({ chunks: summarizeRetrievedChunks(chunks) }),
          runType: 'retriever',
        },
        async () => {
          const reranked = await reranker.rerank({ chunks: candidates, question, topK });
          return applyProductRetrievalPolicy(reranked, retrieveOptions.policy, topK).map(
            (chunk, index) => ({ ...chunk, rank: index + 1 }),
          );
        },
      );
    },
  };
}

export function applyProductRetrievalPolicy(
  chunks: readonly RetrievedChunk[],
  policy: ProductRetrievalPolicy | undefined,
  topK: number,
): RetrievedChunk[] {
  if (policy === undefined) {
    return chunks.slice(0, topK);
  }

  const remaining = chunks.map((chunk, index) => ({ chunk, relevanceRank: index }));
  const selected: RetrievedChunk[] = [];
  while (selected.length < topK && remaining.length > 0) {
    remaining.sort((left, right) => {
      const scoreDelta =
        productPolicyScore(right.chunk, right.relevanceRank, selected, policy) -
        productPolicyScore(left.chunk, left.relevanceRank, selected, policy);
      return scoreDelta === 0 ? left.chunk.id.localeCompare(right.chunk.id) : scoreDelta;
    });
    const next = remaining.shift();
    if (next !== undefined) {
      selected.push(next.chunk);
    }
  }
  return selected;
}

function productPolicyScore(
  chunk: RetrievedChunk,
  relevanceRank: number,
  selected: readonly RetrievedChunk[],
  policy: ProductRetrievalPolicy,
): number {
  const isAnchor = policy.anchorDocumentIds.includes(chunk.documentId);
  const anchorBoost = isAnchor ? 100 : 0;
  const anchorOverviewBoost = isAnchor && /:chunk:0001$/u.test(chunk.id) ? 10 : 0;
  const sourceIndex = policy.preferredSourceTypes.indexOf(chunk.metadata.sourceType);
  const sourceBoost =
    sourceIndex < 0 ? 0 : (policy.preferredSourceTypes.length - sourceIndex) * 0.35;
  const temporalBoost = temporalPolicyBoost(chunk, policy.temporalScope);
  if (policy.diversity === 'none') {
    return -relevanceRank * 0.5 + anchorBoost + anchorOverviewBoost + sourceBoost + temporalBoost;
  }

  const repeatedDocumentCount = selected.filter(
    (selectedChunk) => selectedChunk.documentId === chunk.documentId,
  ).length;
  const repeatedModuleCount = selected.filter(
    (selectedChunk) => selectedChunk.metadata.module === chunk.metadata.module,
  ).length;
  const repeatedSourceCount = selected.filter(
    (selectedChunk) => selectedChunk.metadata.sourceType === chunk.metadata.sourceType,
  ).length;
  return (
    -relevanceRank * 0.5 +
    anchorBoost +
    anchorOverviewBoost +
    sourceBoost +
    temporalBoost -
    repeatedDocumentCount * 1.25 -
    repeatedModuleCount * 0.4 -
    repeatedSourceCount * 0.15
  );
}

function temporalPolicyBoost(
  chunk: RetrievedChunk,
  temporalScope: ProductRetrievalPolicy['temporalScope'],
): number {
  const status =
    chunk.metadata.status ?? (chunk.metadata.sourceType === 'x_updates' ? 'historical' : 'current');
  if (status === 'deprecated') {
    return -20;
  }
  if (temporalScope === 'historical') {
    return status === 'historical' ? 1.5 : 0;
  }
  if (temporalScope === 'current') {
    return status === 'current' ? 1.5 : -4;
  }
  return 0;
}

export function createMetadataReranker(): Reranker {
  return {
    rerank({ chunks, question }) {
      const queryTokens = new Set(createRetrieveQueryTokens(question));
      const maximumScore = maximumRetrievedScore(chunks);
      const ranked = [...chunks].sort((left, right) => {
        const rightScore = rerankScore(right, queryTokens, question, maximumScore);
        const leftScore = rerankScore(left, queryTokens, question, maximumScore);

        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }

        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.id.localeCompare(right.id);
      });
      return demoteStaleNumericClaims(
        demotePromotionalBenefitChunks(ranked, question),
        question,
        queryTokens,
      );
    },
  };
}

export function createLocalRetriever(index: RagIndex): Retriever {
  return {
    retrieve(question: string, options: RetrieveOptions): RetrievedChunk[] {
      return retrieve(question, index, options);
    },
  };
}

function metadataMatchScore(chunk: RetrievedChunk, queryTokens: Set<string>): number {
  const metadataText = [
    chunk.metadata.title,
    chunk.metadata.module,
    ...chunk.metadata.headingPath,
  ].join(' ');
  const informativeQueryTokens = Array.from(queryTokens).filter(isInformativeQueryToken);
  if (informativeQueryTokens.length === 0) {
    return 0;
  }

  const metadataTokens = new Set(tokenize(metadataText));
  const matchedTokenCount = informativeQueryTokens.filter((token) =>
    metadataTokens.has(token),
  ).length;
  return matchedTokenCount / informativeQueryTokens.length;
}

function rerankScore(
  chunk: RetrievedChunk,
  queryTokens: Set<string>,
  question: string,
  maximumScore: number,
): number {
  const contentCoverage = contentCoverageScore(chunk, queryTokens);
  return (
    reciprocalRankFusionScore([chunk.rank]) * BASE_RANK_WEIGHT +
    normalizedRetrievedScore(chunk.score, maximumScore) * BASE_SCORE_WEIGHT +
    metadataMatchScore(chunk, queryTokens) * METADATA_RERANK_WEIGHT +
    titleContainmentScore(chunk, question) * TITLE_CONTAINMENT_WEIGHT +
    contentCoverage * CONTENT_COVERAGE_WEIGHT +
    directSourceScore(chunk) * DIRECT_SOURCE_WEIGHT +
    temporalStatusScore(chunk, question) * TEMPORAL_STATUS_WEIGHT +
    structuredAnswerScore(chunk, question) * contentCoverage * STRUCTURED_ANSWER_WEIGHT +
    directSupportEvidenceScore(chunk, question) * DIRECT_SUPPORT_EVIDENCE_WEIGHT +
    howToEvidenceScore(chunk, question) * (0.5 + contentCoverage * 0.5)
  );
}

function maximumRetrievedScore(chunks: RetrievedChunk[]): number {
  const scores = chunks.map((chunk) => chunk.score).filter(Number.isFinite);
  return scores.length === 0 ? 0 : Math.max(...scores);
}

function normalizedRetrievedScore(score: number, maximumScore: number): number {
  if (!Number.isFinite(score) || maximumScore <= 0) {
    return 0;
  }

  return Math.max(0, score) / maximumScore;
}

function titleContainmentScore(chunk: RetrievedChunk, question: string): number {
  const normalizedQuestion = normalizeCompactText(question);
  const normalizedTitle = normalizeCompactText(chunk.metadata.title).replace(/^xxyy/u, '');
  if (normalizedTitle.length < 2) {
    return 0;
  }

  return normalizedQuestion.includes(normalizedTitle) ? 1 : 0;
}

function normalizeCompactText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function contentCoverageScore(chunk: RetrievedChunk, queryTokens: Set<string>): number {
  const informativeQueryTokens = Array.from(queryTokens).filter(isInformativeQueryToken);
  if (informativeQueryTokens.length === 0) {
    return 0;
  }

  const evidenceTokens = new Set(
    tokenize(
      [chunk.metadata.title, chunk.metadata.module, ...chunk.metadata.headingPath, chunk.text].join(
        ' ',
      ),
    ),
  );
  const matchedTokenCount = informativeQueryTokens.filter((token) =>
    evidenceTokens.has(token),
  ).length;
  return matchedTokenCount / informativeQueryTokens.length;
}

function isInformativeQueryToken(token: string): boolean {
  if (QUERY_STOP_TOKENS.has(token)) {
    return false;
  }

  return /^[a-z0-9][a-z0-9_-]*$/u.test(token) || token.length === 2;
}

function structuredAnswerScore(chunk: RetrievedChunk, question: string): number {
  if (!/哪些|哪几|有啥|啥|区别|对比|多少|字段|参数|选项|包括|列表/u.test(question)) {
    return 0;
  }

  const separators = chunk.text.match(/[、，,；;]|(?:^|\n)\s*(?:[-*]|\d+[.)、])/gu)?.length ?? 0;
  const explicitCount = /\d+\s*(?:个|条|种|项|大)/u.test(chunk.text) ? 1 : 0;
  return Math.min(1, separators / 6 + explicitCount * 0.25);
}

function directSupportEvidenceScore(chunk: RetrievedChunk, question: string): number {
  if (!isSupportQuestionText(question)) {
    return 0;
  }

  const evidence = normalizeCompactText(chunk.text);
  const markers = /已支持|支持|上线|开放|适配|可用/u;
  const supportSubject = directSupportSubject(question);
  if (supportSubject === undefined) {
    return 0;
  }

  let index = evidence.indexOf(supportSubject);
  while (index >= 0) {
    const localContext = evidence.slice(
      Math.max(0, index - 10),
      index + supportSubject.length + 10,
    );
    if (markers.test(localContext)) {
      return 1;
    }
    index = evidence.indexOf(supportSubject, index + supportSubject.length);
  }

  return 0;
}

function directSupportSubject(question: string): string | undefined {
  const normalized = question.normalize('NFKC').toLowerCase();
  const subject =
    /支持\s*(?!哪些|什么|哪几)(?<subject>[^吗么嘛呢?？]{2,24})(?:吗|么|嘛|呢|\?|？|$)/u.exec(
      normalized,
    )?.groups?.subject ??
    /\bsupport(?:s|ed)?\s+(?<subject>[a-z0-9._-]{2,32})/u.exec(normalized)?.groups?.subject;
  if (subject === undefined) {
    return undefined;
  }

  const compact = normalizeCompactText(subject).replace(/^xxyy/u, '');
  if (compact.length < 2) {
    return undefined;
  }
  if (/^[a-z0-9._-]+$/u.test(compact)) {
    return compact;
  }
  return compact.length <= 6 ? compact : undefined;
}

function directSourceScore(chunk: RetrievedChunk): number {
  return chunk.metadata.sourceUrl === undefined ? 0 : 1;
}

function temporalStatusScore(chunk: RetrievedChunk, question: string): number {
  if (isHistoricalOrTweetQuestion(question)) {
    return 0;
  }

  switch (chunk.metadata.status) {
    case 'current':
      return 0.5;
    case 'historical':
      return -1;
    case 'deprecated':
      return -4;
    case undefined:
      return 0;
  }
  return 0;
}

function demotePromotionalBenefitChunks(
  chunks: RetrievedChunk[],
  question: string,
): RetrievedChunk[] {
  if (
    isHistoricalOrTweetQuestion(question) ||
    !/\bpro\b|会员|权益|额外|区别|比.{0,8}多/iu.test(question)
  ) {
    return chunks;
  }

  return stableDemote(chunks, (chunk) =>
    /限时|一折|折扣|促销|春节|周年|抽奖|返佣|返现|福利|欢迎.{0,8}(?:体验|参加|来玩)/u.test(
      chunk.text,
    ),
  );
}

function demoteStaleNumericClaims(
  chunks: RetrievedChunk[],
  question: string,
  queryTokens: Set<string>,
): RetrievedChunk[] {
  if (
    isHistoricalOrTweetQuestion(question) ||
    /各自|分别|比较|对比|区别|和几|以及几|及几/u.test(question) ||
    !/多少|最多|最少|上限|下限|限制|当前|现在|目前|最新/u.test(question)
  ) {
    return chunks;
  }

  const datedClaims = chunks
    .map((chunk) => ({
      chunk,
      coverage: contentCoverageScore(chunk, queryTokens),
      timestamp: Date.parse(chunk.metadata.effectiveAt ?? ''),
      values: numericFactValues(chunk.text),
    }))
    .filter(
      (candidate) =>
        candidate.coverage >= 0.2 &&
        Number.isFinite(candidate.timestamp) &&
        candidate.values.size > 0,
    );
  const maximumCoverage = Math.max(0, ...datedClaims.map((candidate) => candidate.coverage));
  const referenceCoverage = Math.max(0.2, maximumCoverage * 0.75);
  const latestClaim = datedClaims
    .filter((candidate) => candidate.coverage >= referenceCoverage)
    .sort((left, right) => right.timestamp - left.timestamp)[0];
  if (latestClaim === undefined) {
    return chunks;
  }

  const staleIds = new Set(
    datedClaims
      .filter(
        (candidate) =>
          latestClaim.timestamp - candidate.timestamp > 30 * 24 * 60 * 60 * 1000 &&
          !setsIntersect(candidate.values, latestClaim.values),
      )
      .map((candidate) => candidate.chunk.id),
  );
  return stableDemote(chunks, (chunk) => staleIds.has(chunk.id));
}

function numericFactValues(text: string): Set<string> {
  return new Set(
    Array.from(
      text.matchAll(/(?<value>\d[\d,. ]*)\s*(?:秒|分钟|小时|天|个|条|种|项|钱包|地址|链)/gu),
      (match) => match.groups?.value?.replace(/[,. ]/gu, ''),
    ).filter((value): value is string => value !== undefined && value.length > 0),
  );
}

function setsIntersect(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return Array.from(left).some((value) => right.has(value));
}

function stableDemote(
  chunks: RetrievedChunk[],
  shouldDemote: (chunk: RetrievedChunk) => boolean,
): RetrievedChunk[] {
  return [
    ...chunks.filter((chunk) => !shouldDemote(chunk)),
    ...chunks.filter((chunk) => shouldDemote(chunk)),
  ];
}

function howToEvidenceScore(chunk: RetrievedChunk, question: string): number {
  const normalizedQuestion = question.normalize('NFKC').toLowerCase();
  if (!/如何|怎么|怎样|从哪里|在哪(?:里)?|入口|how\s+to|where/u.test(normalizedQuestion)) {
    return 0;
  }

  const normalizedEvidence = chunk.text.normalize('NFKC').toLowerCase();
  return /点击|选择|输入|填写|下载|上传|勾选|入口|直达|链接|菜单|网站|提前设置|设置.{0,8}(?:条件|金额|比例|模式|买入|卖出)/u.test(
    normalizedEvidence,
  )
    ? HOW_TO_DIRECT_EVIDENCE_BONUS
    : 0;
}

function normalizeTopK(topK: number | undefined): number {
  if (topK === undefined || !Number.isInteger(topK) || topK <= 0) {
    return 6;
  }

  return topK;
}

function normalizeCandidateMultiplier(candidateMultiplier: number | undefined): number {
  if (
    candidateMultiplier === undefined ||
    !Number.isInteger(candidateMultiplier) ||
    candidateMultiplier <= 1
  ) {
    return 3;
  }

  return Math.min(candidateMultiplier, 10);
}
