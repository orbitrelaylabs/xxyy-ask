import type { SourceType } from '@xxyy/shared';
import {
  classifyQuestion,
  decomposeProductQuestion,
  understandProductQuestion,
  type ProductQuestionKind,
} from '@xxyy/rag-core';

export interface SearchEvidenceAttempt {
  chunkIds: readonly string[];
  citationKeys: readonly string[];
  citationSourceTypes?: readonly (SourceType | undefined)[];
  currentEvidenceCount?: number;
  evidenceTexts: readonly string[];
  historicalEvidenceCount?: number;
  query: string;
}

export type EvidenceObservationStopReason = 'max_steps' | 'no_new_evidence' | 'sufficient';

export interface EvidenceObservation {
  authoritativeCitationCount: number;
  authoritativeOverviewCitationCount: number;
  complexity: 'multi_part' | 'single_part';
  conflicts: Array<{
    evidenceIds: string[];
    subject: string;
    values: string[];
  }>;
  coverage: number;
  coveredFacets: string[];
  currentEvidenceCount: number;
  distinctCitationCount: number;
  distinctEvidenceCount: number;
  historicalEvidenceCount: number;
  latestNewEvidenceCount: number;
  missingFacets: string[];
  facetCoverage: Array<{
    covered: boolean;
    evidenceIds: string[];
    facet: string;
  }>;
  nextAction: 'answer' | 'clarify' | 'continue_search' | 'partial_answer';
  questionKind: ProductQuestionKind;
  requiredFacets: string[];
  shouldContinue: boolean;
  sourceTypes: SourceType[];
  stopReason?: EvidenceObservationStopReason;
  sufficient: boolean;
  suggestedQuery?: string;
  version: '1';
  xCitationCount: number;
}

export type ProductEvidenceReport = EvidenceObservation;

const MULTI_PART_SIGNAL = /比较|对比|区别|分别|同时|以及|与|\bcompare\b|\bversus\b|\bvs\.?\b/iu;
const MULTI_CATEGORY_SIGNAL =
  /(?:权益|功能|设置|上限|限制|管理|套餐|版本).+和.+(?:权益|功能|设置|上限|限制|管理|套餐|版本)/u;
const FACET_SEPARATOR = /\s*(?:以及|并且|还有|和|与|及|、|\/|\bversus\b|\bvs\.?\b)\s*/iu;
const GENERIC_FACET_TERMS = new Set([
  'compare',
  'versus',
  'vs',
  'xxyy',
  '什么',
  '区别',
  '哪些',
  '如何',
  '怎么',
  '是否',
  '比较',
  '对比',
  '分别',
  '可以',
  '同时',
  '以及',
]);

export function observeProductEvidence(
  question: string,
  attempts: readonly SearchEvidenceAttempt[],
  maxSteps: number,
): EvidenceObservation {
  const questionKind = understandProductQuestion(question, classifyQuestion(question)).kind;
  const requiredFacets = extractEvidenceFacets(question);
  const multiPart = requiresMultiPartEvidence(question);
  const capabilityOverview = isCapabilityOverview(question);
  const allEvidenceTexts = attempts.flatMap((attempt) => attempt.evidenceTexts);
  const facetCoverage = requiredFacets.map((facet) => {
    const evidenceIds = attempts.flatMap((attempt) =>
      attempt.evidenceTexts.flatMap((text, index) =>
        (capabilityOverview || facetMatchesEvidence(facet, attempt.query)) &&
        facetMatchesEvidence(facet, text)
          ? [attempt.citationKeys[index] ?? '']
          : [],
      ),
    );
    const uniqueEvidenceIds = [...new Set(evidenceIds.filter((id) => id.length > 0))];
    return {
      covered:
        uniqueEvidenceIds.length > 0 ||
        attempts.some(
          (attempt) =>
            (capabilityOverview || facetMatchesEvidence(facet, attempt.query)) &&
            attempt.evidenceTexts.some((text) => facetMatchesEvidence(facet, text)),
        ),
      evidenceIds: uniqueEvidenceIds,
      facet,
    };
  });
  const coveredFacets = facetCoverage.filter((item) => item.covered).map((item) => item.facet);
  const missingFacets = requiredFacets.filter((facet) => !coveredFacets.includes(facet));
  const citationKeys = new Set(attempts.flatMap((attempt) => attempt.citationKeys));
  const citationSources = distinctCitationSources(attempts);
  const authoritativeCitationCount = [...citationSources.values()].filter(
    (sourceType) => sourceType === 'admin_verified' || sourceType === 'official_docs',
  ).length;
  const authoritativeOverviewCitationCount = countAuthoritativeOverviewCitations(attempts);
  const xCitationCount = [...citationSources.values()].filter(
    (sourceType) => sourceType === 'x_updates',
  ).length;
  const evidenceKeys = distinctEvidenceKeys(attempts);
  const latestNewEvidenceCount = countLatestNewEvidence(attempts);
  const currentEvidenceCount = attempts.reduce(
    (sum, attempt) => sum + (attempt.currentEvidenceCount ?? 0),
    0,
  );
  const historicalEvidenceCount = attempts.reduce(
    (sum, attempt) => sum + (attempt.historicalEvidenceCount ?? 0),
    0,
  );
  const sourceTypes = [
    ...new Set(
      [...citationSources.values()].filter(
        (sourceType): sourceType is SourceType => sourceType !== undefined,
      ),
    ),
  ];
  const coverage =
    requiredFacets.length === 0
      ? citationKeys.size > 0
        ? 1
        : 0
      : coveredFacets.length / requiredFacets.length;
  const sufficient = determineSufficiency({
    actionableEvidenceCount: allEvidenceTexts.filter(hasActionableHowToEvidence).length,
    authoritativeCitationCount,
    authoritativeOverviewCitationCount,
    coveredFacetCount: coveredFacets.length,
    distinctCitationCount: citationKeys.size,
    multiPart,
    numericEvidenceCount: allEvidenceTexts.filter(hasExplicitNumericEvidence).length,
    questionKind,
    requiredFacetCount: requiredFacets.length,
  });

  let stopReason: EvidenceObservationStopReason | undefined;
  if (sufficient) {
    stopReason = 'sufficient';
  } else if (attempts.length >= Math.max(0, maxSteps)) {
    stopReason = 'max_steps';
  } else if (attempts.length >= 2 && latestNewEvidenceCount === 0) {
    stopReason = 'no_new_evidence';
  }

  const suggestedQuery =
    sufficient || stopReason !== undefined
      ? undefined
      : createSuggestedQuery(question, missingFacets[0]);
  const nextAction = sufficient
    ? 'answer'
    : stopReason === undefined
      ? 'continue_search'
      : citationKeys.size > 0
        ? 'partial_answer'
        : 'clarify';

  return {
    authoritativeCitationCount,
    authoritativeOverviewCitationCount,
    complexity: multiPart ? 'multi_part' : 'single_part',
    conflicts: [],
    coverage,
    coveredFacets,
    currentEvidenceCount,
    distinctCitationCount: citationKeys.size,
    distinctEvidenceCount: evidenceKeys.size,
    historicalEvidenceCount,
    latestNewEvidenceCount,
    missingFacets,
    facetCoverage,
    nextAction,
    questionKind,
    requiredFacets,
    shouldContinue: !sufficient && stopReason === undefined,
    sourceTypes,
    ...(stopReason === undefined ? {} : { stopReason }),
    sufficient,
    ...(suggestedQuery === undefined ? {} : { suggestedQuery }),
    version: '1',
    xCitationCount,
  };
}

export function extractEvidenceFacets(question: string): string[] {
  if (isCapabilityOverview(question)) {
    return ['交易', '钱包', '监控', '移动端'];
  }

  if (!requiresMultiPartEvidence(question)) {
    return [];
  }

  const subquestions = decomposeProductQuestion(question);
  if (subquestions.length > 1) {
    return [...new Set(subquestions.map((subquestion) => subquestion.facet))];
  }

  const normalized = question
    .normalize('NFKC')
    .replace(/^[\s，,。.!！?？]*(?:请|帮我|麻烦)?\s*(?:比较|对比|分别说明|说明一下)?\s*/u, '')
    .replace(/[？?！!。.]\s*$/u, '')
    .trim();
  const facets = normalized
    .split(FACET_SEPARATOR)
    .map(cleanFacet)
    .filter((facet) => facet.length >= 2 && facet.length <= 80);

  return [...new Set(facets)].slice(0, 4);
}

export function requiresMultiPartEvidence(question: string): boolean {
  const normalized = question.normalize('NFKC');
  return (
    decomposeProductQuestion(question).length > 1 ||
    isCapabilityOverview(question) ||
    MULTI_PART_SIGNAL.test(normalized) ||
    MULTI_CATEGORY_SIGNAL.test(normalized)
  );
}

export function queryTargetsMissingFacet(query: string, missingFacets: readonly string[]): boolean {
  if (missingFacets.length === 0) {
    return true;
  }

  return missingFacets.some((facet) => facetMatchesEvidence(facet, query));
}

export function isAllowedSearchQueryRewrite(
  originalQuestion: string,
  rewrittenQuery: string,
  missingFacets: readonly string[],
): boolean {
  const query = rewrittenQuery.trim();
  if (query.length === 0 || query.length > 240) {
    return false;
  }
  if (!queryTargetsMissingFacet(query, missingFacets)) {
    return false;
  }
  if (!queryPreservesQuestionScope(originalQuestion, query)) {
    return false;
  }

  const requiredTemporalTerms = originalQuestion.match(/当前|现在|当时|截至|(?:19|20)\d{2}/gu);
  return (
    requiredTemporalTerms === null || requiredTemporalTerms.every((term) => query.includes(term))
  );
}

function determineSufficiency(input: {
  actionableEvidenceCount: number;
  authoritativeCitationCount: number;
  authoritativeOverviewCitationCount: number;
  coveredFacetCount: number;
  distinctCitationCount: number;
  multiPart: boolean;
  numericEvidenceCount: number;
  questionKind: ProductQuestionKind;
  requiredFacetCount: number;
}): boolean {
  if (input.distinctCitationCount === 0) {
    return false;
  }

  if (input.questionKind === 'capability_overview') {
    return (
      input.requiredFacetCount > 0 &&
      input.coveredFacetCount === input.requiredFacetCount &&
      (input.authoritativeOverviewCitationCount > 0 ||
        (input.authoritativeCitationCount > 0 && input.distinctCitationCount >= 2))
    );
  }

  if (
    input.multiPart &&
    input.requiredFacetCount > 1 &&
    input.coveredFacetCount !== input.requiredFacetCount
  ) {
    return false;
  }

  if (input.questionKind === 'how_to') {
    return input.authoritativeCitationCount > 0 && input.actionableEvidenceCount > 0;
  }

  if (input.questionKind === 'limit_or_quota') {
    return input.numericEvidenceCount > 0;
  }

  if (!input.multiPart) {
    return true;
  }

  return input.distinctCitationCount >= 2;
}

function hasActionableHowToEvidence(text: string): boolean {
  return /(?:^|[。；;\n])\s*(?:\d+[.)、]|第[一二三四五六七八九十]+步)|打开|进入|点击|选择|设置|配置|输入|填写|保存|确认|开启|关闭/iu.test(
    text,
  );
}

function hasExplicitNumericEvidence(text: string): boolean {
  return /\d+(?:\.\d+)?\s*(?:个|条|次|种|项|天|小时|分钟|秒|%|倍|地址|钱包|USDT|USD)?/iu.test(text);
}

function countAuthoritativeOverviewCitations(attempts: readonly SearchEvidenceAttempt[]): number {
  const matchingKeys = new Set<string>();
  for (const attempt of attempts) {
    attempt.citationKeys.forEach((key, index) => {
      const sourceType = attempt.citationSourceTypes?.[index];
      const evidenceText = attempt.evidenceTexts[index] ?? '';
      if (
        (sourceType === 'admin_verified' || sourceType === 'official_docs') &&
        /(?:当前支持的产品功能总览|当前功能总览|产品功能目录)/u.test(evidenceText)
      ) {
        matchingKeys.add(key);
      }
    });
  }
  return matchingKeys.size;
}

function distinctCitationSources(
  attempts: readonly SearchEvidenceAttempt[],
): Map<string, SourceType | undefined> {
  const sources = new Map<string, SourceType | undefined>();
  for (const attempt of attempts) {
    attempt.citationKeys.forEach((key, index) => {
      sources.set(key, attempt.citationSourceTypes?.[index]);
    });
  }
  return sources;
}

function isCapabilityOverview(question: string): boolean {
  return (
    understandProductQuestion(question, classifyQuestion(question)).kind === 'capability_overview'
  );
}

function cleanFacet(value: string): string {
  return value
    .replace(/^(?:请|帮我|麻烦|比较|对比|分别|说明|一下)+\s*/u, '')
    .replace(/(?:分别)?(?:有什么|有何|是什么)?(?:区别|差异|不同)?(?:吗|么|呢)?\s*$/u, '')
    .replace(/^(?:XXYY\s*)?(?=XXYY)/iu, '')
    .trim();
}

function facetMatchesEvidence(facet: string, evidence: string): boolean {
  const normalizedFacet = compactText(facet);
  const normalizedEvidence = compactText(evidence);
  if (normalizedFacet.length === 0 || normalizedEvidence.length === 0) {
    return false;
  }

  const exactFacet = normalizedFacet.replace(/^xxyy/u, '');
  if (exactFacet.length >= 2 && normalizedEvidence.includes(exactFacet)) {
    return true;
  }

  const terms = meaningfulFacetTerms(facet);
  if (terms.length === 0) {
    return false;
  }
  const matched = terms.filter((term) => normalizedEvidence.includes(compactText(term))).length;
  const minimumMatches = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);
  return matched >= minimumMatches;
}

function meaningfulFacetTerms(facet: string): string[] {
  const normalized = facet.normalize('NFKC').toLowerCase();
  const latinTerms = (normalized.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/gu) ?? []).filter(
    (term) => term.length > 1 && !GENERIC_FACET_TERMS.has(term),
  );
  const hanTerms = (normalized.match(/\p{Script=Han}+/gu) ?? []).flatMap((segment) => {
    const characters = Array.from(segment);
    if (characters.length <= 2) {
      return [segment];
    }
    return characters
      .slice(0, -1)
      .map((character, index) => `${character}${characters[index + 1]}`);
  });

  return [...new Set([...latinTerms, ...hanTerms])].filter(
    (term) => term.length > 1 && !GENERIC_FACET_TERMS.has(term),
  );
}

function queryPreservesQuestionScope(question: string, query: string): boolean {
  const normalizedQuery = compactText(query);
  const questionTerms = meaningfulFacetTerms(question).filter((term) => term.length > 1);
  if (questionTerms.length === 0) {
    return normalizedQuery.includes('xxyy');
  }
  return questionTerms.some((term) => normalizedQuery.includes(compactText(term)));
}

function compactText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function distinctEvidenceKeys(attempts: readonly SearchEvidenceAttempt[]): Set<string> {
  return new Set(
    attempts.flatMap((attempt) =>
      attempt.chunkIds.length > 0
        ? attempt.chunkIds.map((id) => `chunk:${id}`)
        : attempt.citationKeys.map((key) => `citation:${key}`),
    ),
  );
}

function countLatestNewEvidence(attempts: readonly SearchEvidenceAttempt[]): number {
  const latest = attempts.at(-1);
  if (latest === undefined) {
    return 0;
  }

  const previousKeys = distinctEvidenceKeys(attempts.slice(0, -1));
  const latestKeys = distinctEvidenceKeys([latest]);
  return [...latestKeys].filter((key) => !previousKeys.has(key)).length;
}

function createSuggestedQuery(question: string, missingFacet: string | undefined): string {
  const timeScopes = [
    ...new Set(
      question.match(
        /(?:当前|现在|当时|截至[^，,。.!！?？]{0,20}|(?:19|20)\d{2}(?:\s*年|[-/]\d{1,2})?)/gu,
      ) ?? [],
    ),
  ];
  const base =
    missingFacet === undefined ? `${question} 官方文档 具体限制` : `XXYY ${missingFacet}`;
  return [base, ...timeScopes]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join(' ')
    .slice(0, 240)
    .trim();
}
