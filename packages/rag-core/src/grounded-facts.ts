import type { KnowledgeStatus, SourceType } from '@xxyy/shared';

import {
  hasUsableKnowledgeText,
  sanitizeRetrievedKnowledgeChunk,
} from './knowledge-content-safety.js';
import { createRetrieveQueryTokens, type RetrievedChunk } from './retrieve.js';

export interface GroundedFact {
  claim: string;
  evidenceIds: string[];
  scope: string;
  sourceType: SourceType;
  status: 'current' | 'historical' | 'uncertain';
  subject: string;
  effectiveAt?: string;
  unit?: string;
  value?: string;
}

export interface GroundedFactConflict {
  evidenceIds: string[];
  subject: string;
  values: string[];
}

export interface GroundedFactReport {
  conflicts: GroundedFactConflict[];
  facts: GroundedFact[];
  version: '1';
}

export interface GroundedFactScopeValidation {
  acceptedFacts: GroundedFact[];
  rejectedEvidenceIds: string[];
  requiresNumericValue: boolean;
  valid: boolean;
  version: '1';
}

export function shouldBlockOnGroundedFactConflicts(
  question: string,
  validation: GroundedFactScopeValidation,
): boolean {
  return (
    validation.requiresNumericValue ||
    /冲突|矛盾|哪个(?:说法)?(?:对|准确)|到底(?:是|有|能|可|支持|多少)/u.test(question)
  );
}

const NUMBER_WITH_UNIT_PATTERN =
  /(\d{1,9}(?:,\d{3})*(?:\.\d+)?)\s*(个|条|次|种|项|笔|秒|分钟|小时|天|周|月|年|%|％|倍|bps|qps|rps|美元|美金|点|积分|钱包|地址|代币|链)/giu;
const EVIDENCE_SENTENCE_SEPARATOR = /(?<=[。！？!?；;])\s*|\n+/u;
const FACT_STOP_TOKENS = new Set([
  'xxyy',
  '当前',
  '现在',
  '目前',
  '支持',
  '哪些',
  '什么',
  '如何',
  '怎么',
  '是否',
  '可以',
]);

export function extractGroundedFacts(
  question: string,
  retrievedChunks: readonly RetrievedChunk[],
): GroundedFactReport {
  const questionTokens = new Set(createRetrieveQueryTokens(question));
  const facts = retrievedChunks.flatMap((rawChunk) => {
    const chunk = sanitizeRetrievedKnowledgeChunk(rawChunk);
    if (!hasUsableKnowledgeText(chunk.text) || chunk.metadata.status === 'deprecated') {
      return [];
    }
    const includeStructuredContinuation = chunkHeadingMatchesQuestion(question, chunk);
    return splitEvidenceParagraphs(chunk.text)
      .flatMap((sentences) => {
        const safeSentences = sentences.filter((sentence) => !isMarketingFactSentence(sentence));
        const paragraphRelevant =
          includeStructuredContinuation ||
          safeSentences.some((sentence) => isFactSentenceRelevant(sentence, questionTokens));
        return paragraphRelevant
          ? safeSentences
          : safeSentences.filter((sentence) => isFactSentenceRelevant(sentence, questionTokens));
      })
      .flatMap((sentence) =>
        factsFromSentence(
          sentence,
          chunk,
          /区域|部分|模块/u.test(question) && includeStructuredContinuation,
        ),
      );
  });

  return {
    conflicts: detectGroundedFactConflicts(facts, retrievedChunks),
    facts: deduplicateFacts(facts).slice(0, 80),
    version: '1',
  };
}

export function formatGroundedFactsForPrompt(
  facts: readonly GroundedFact[],
  maxLength = 12_000,
): string {
  const lines: string[] = [];
  let length = 0;
  for (const [index, fact] of facts.entries()) {
    const line = [
      `[F${index + 1}]`,
      `status=${fact.status}`,
      `scope=${fact.scope}`,
      `evidence=${fact.evidenceIds.join(',')}`,
      fact.claim,
    ].join(' | ');
    if (length + line.length + 1 > maxLength) {
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

export function createGroundedFactChunks(
  facts: readonly GroundedFact[],
  retrievedChunks: readonly RetrievedChunk[],
): RetrievedChunk[] {
  const claimsByEvidence = new Map<string, string[]>();
  for (const fact of facts) {
    for (const evidenceId of fact.evidenceIds) {
      const claims = claimsByEvidence.get(evidenceId) ?? [];
      claims.push(fact.claim);
      claimsByEvidence.set(evidenceId, claims);
    }
  }

  return retrievedChunks.flatMap((chunk) => {
    const claims = [...new Set(claimsByEvidence.get(chunk.id) ?? [])];
    if (claims.length === 0) {
      return [];
    }
    return [
      {
        ...chunk,
        text: claims.reduce(
          (text, claim) =>
            text.length === 0
              ? claim
              : `${text}${/[。！？!?；;]$/u.test(text) ? '' : '\n'}${claim}`,
          '',
        ),
      },
    ];
  });
}

export function validateGroundedFactScope(
  question: string,
  facts: readonly GroundedFact[],
): GroundedFactScopeValidation {
  const requestedPlan = requestedPlanScope(question);
  const historicalQuestion = /历史|以前|过去|当时|曾经|(?:19|20)\d{2}/u.test(question);
  const acceptedFacts = facts.filter((fact) => {
    if (!historicalQuestion && fact.status === 'historical') {
      return false;
    }
    if (requestedPlan === undefined) {
      return true;
    }
    const factPlan = requestedPlanScope(fact.scope);
    return factPlan === undefined || factPlan === requestedPlan;
  });
  const rejectedEvidenceIds = [
    ...new Set(
      facts.filter((fact) => !acceptedFacts.includes(fact)).flatMap((fact) => fact.evidenceIds),
    ),
  ];
  const requiresNumericValue = /多少|几(?:个|条|次|种|项|笔)|上限|下限|额度|限制|频率|间隔/u.test(
    question,
  );
  const valid =
    acceptedFacts.length > 0 &&
    (!requiresNumericValue ||
      acceptedFacts.some((fact) => fact.value !== undefined && fact.unit !== undefined));
  return {
    acceptedFacts,
    rejectedEvidenceIds,
    requiresNumericValue,
    valid,
    version: '1',
  };
}

export function detectGroundedFactConflicts(
  facts: readonly GroundedFact[],
  chunks: readonly RetrievedChunk[] = [],
): GroundedFactConflict[] {
  const supersededIds = new Set(
    chunks
      .filter((chunk) => chunk.metadata.status === 'current')
      .flatMap((chunk) => chunk.metadata.supersedes ?? []),
  );
  const currentNumericFacts = facts.filter(
    (fact) =>
      fact.status === 'current' &&
      fact.value !== undefined &&
      fact.unit !== undefined &&
      !fact.evidenceIds.some((id) => supersededIds.has(id)),
  );
  const groups = new Map<string, GroundedFact[]>();
  for (const fact of currentNumericFacts) {
    const key = `${normalizeScope(fact.scope)}|${normalizeUnit(fact.unit ?? '')}`;
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  const conflicts: GroundedFactConflict[] = [];
  for (const group of groups.values()) {
    const valuesByEvidence = new Map<string, Set<string>>();
    for (const fact of group) {
      for (const evidenceId of fact.evidenceIds) {
        const values = valuesByEvidence.get(evidenceId) ?? new Set<string>();
        values.add(fact.value as string);
        valuesByEvidence.set(evidenceId, values);
      }
    }
    // A single source may legitimately enumerate several supported values. Only compare
    // independent sources that each assert one value for the same scoped limit.
    const singleValueAssertions = [...valuesByEvidence.entries()].filter(
      ([, values]) => values.size === 1,
    );
    const distinctValues = [...new Set(singleValueAssertions.flatMap(([, values]) => [...values]))];
    if (singleValueAssertions.length < 2 || distinctValues.length < 2) {
      continue;
    }
    const representative = group[0];
    if (representative === undefined) {
      continue;
    }
    conflicts.push({
      evidenceIds: singleValueAssertions.map(([evidenceId]) => evidenceId),
      subject: representative.scope,
      values: distinctValues.sort(compareNumericStrings),
    });
  }

  return conflicts.slice(0, 20);
}

function factsFromSentence(
  sentence: string,
  chunk: RetrievedChunk,
  prefixLeafHeading = false,
): GroundedFact[] {
  const normalizedSentence = sentence
    .replace(/^\*{1,2}|\*{1,2}$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 600);
  const leafHeading = chunk.metadata.headingPath
    .at(-1)
    ?.replace(/^[^\p{L}\p{N}]+/gu, '')
    .trim();
  const cleanSentence =
    prefixLeafHeading &&
    leafHeading !== undefined &&
    leafHeading.length >= 2 &&
    !/overview|概览/iu.test(leafHeading) &&
    leafHeading !== chunk.metadata.title &&
    !normalizedSentence.includes(leafHeading)
      ? `${leafHeading}：${normalizedSentence}`
      : normalizedSentence;
  if (cleanSentence.length < 2) {
    return [];
  }
  const numericMatches = [...cleanSentence.matchAll(NUMBER_WITH_UNIT_PATTERN)];
  const base = {
    claim: cleanSentence,
    evidenceIds: [chunk.id],
    scope: createFactScope(cleanSentence, chunk),
    sourceType: chunk.metadata.sourceType,
    status: factStatus(chunk.metadata.status),
    subject: createFactSubject(cleanSentence, chunk),
    ...(chunk.metadata.effectiveAt === undefined
      ? {}
      : { effectiveAt: chunk.metadata.effectiveAt }),
  } satisfies Omit<GroundedFact, 'unit' | 'value'>;

  if (numericMatches.length === 0) {
    return [base];
  }
  return numericMatches.map((match) => ({
    ...base,
    unit: normalizeUnit(match[2] ?? ''),
    value: normalizeNumericValue(match[1] ?? ''),
  }));
}

function createFactScope(sentence: string, chunk: RetrievedChunk): string {
  const plan =
    factPlanLabel(sentence) ??
    factPlanLabel(
      [chunk.metadata.title, chunk.metadata.module, ...chunk.metadata.headingPath].join(' '),
    );
  const dimension =
    factDimension(sentence) ?? chunk.metadata.headingPath.at(-1) ?? chunk.metadata.title;
  return [chunk.metadata.module, plan, dimension].filter(Boolean).join(' / ').slice(0, 240);
}

function factPlanLabel(text: string): 'Basic' | 'Pro' | '永久 Pro' | undefined {
  if (/\b永久\s*pro\b|永久\s*PRO/iu.test(text)) {
    return '永久 Pro';
  }
  if (/\bbasic\b|免费版/iu.test(text)) {
    return 'Basic';
  }
  return /\bpro\b/iu.test(text) ? 'Pro' : undefined;
}

function createFactSubject(sentence: string, chunk: RetrievedChunk): string {
  return factDimension(sentence) ?? chunk.metadata.headingPath.at(-1) ?? chunk.metadata.title;
}

function factDimension(sentence: string): string | undefined {
  const dimensions: Array<[string, RegExp]> = [
    ['钱包监控上限', /钱包.{0,12}(?:监控|提醒)|(?:监控|提醒).{0,12}钱包/iu],
    ['钱包管理上限', /钱包.{0,12}(?:管理|创建|导入)|(?:管理|创建|导入).{0,12}钱包/iu],
    ['API 频率限制', /api.{0,12}(?:频率|限流|qps|rps)|(?:频率|限流).{0,12}api/iu],
    ['交易限额', /交易.{0,12}(?:上限|下限|最多|最少|限额)/u],
    ['通知频率', /通知.{0,12}(?:频率|间隔|次数)|(?:频率|间隔).{0,12}通知/u],
    ['K 线周期', /k\s*线.{0,12}(?:周期|秒|分钟|小时)/iu],
    ['套餐权益', /(?:pro|basic|套餐|会员).{0,12}(?:权益|额度|上限)/iu],
  ];
  return dimensions.find(([, pattern]) => pattern.test(sentence))?.[0];
}

function splitEvidenceSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .split(EVIDENCE_SENTENCE_SEPARATOR)
    .map((sentence) =>
      sentence
        .replace(/^#{1,6}\s*/u, '')
        .replace(/^(?:[-*+]|\d+[.)、])\s*/u, '')
        .trim(),
    )
    .filter((sentence) => sentence.length > 0);
}

function splitEvidenceParagraphs(text: string): string[][] {
  const sanitized = text.replace(/```[\s\S]*?```/gu, ' ').replace(/\s+-\s+/gu, '\n\n');
  return sanitized
    .split(/\n\s*\n+/u)
    .map(splitEvidenceSentences)
    .filter((sentences) => sentences.length > 0);
}

function isFactSentenceRelevant(sentence: string, questionTokens: Set<string>): boolean {
  if (/标准客服回答：|前置条件|注意事项|失败|步骤|\[已隔离疑似指令注入内容\]/u.test(sentence)) {
    return true;
  }
  if (questionTokens.size === 0) {
    return true;
  }
  const sentenceTokens = new Set(createRetrieveQueryTokens(sentence));
  const meaningfulQuestionTokens = [...questionTokens].filter(
    (token) => token.length > 1 && !FACT_STOP_TOKENS.has(token.toLowerCase()),
  );
  return (
    meaningfulQuestionTokens.length === 0 ||
    meaningfulQuestionTokens.some((token) => sentenceTokens.has(token))
  );
}

function isMarketingFactSentence(sentence: string): boolean {
  return /(?:欢迎.{0,24}(?:留言|评论|反馈)|祝(?:大家|所有用户).{0,16}(?:发财|愉快|快乐)|(?:点赞|转发|关注我们|KOL\s*推荐))/iu.test(
    sentence,
  );
}

function chunkHeadingMatchesQuestion(question: string, chunk: RetrievedChunk): boolean {
  const questionTokens = new Set(
    createRetrieveQueryTokens(question).filter(
      (token) => token.length > 1 && !FACT_STOP_TOKENS.has(token.toLowerCase()),
    ),
  );
  if (questionTokens.size === 0) {
    return false;
  }
  const headingTokens = createRetrieveQueryTokens(
    [chunk.metadata.title, ...chunk.metadata.headingPath].join(' '),
  ).filter((token) => token.length > 1 && !FACT_STOP_TOKENS.has(token.toLowerCase()));
  return headingTokens.some((token) => questionTokens.has(token));
}

function factStatus(status: KnowledgeStatus | undefined): GroundedFact['status'] {
  if (status === 'historical') {
    return 'historical';
  }
  return status === 'current' || status === undefined ? 'current' : 'uncertain';
}

function deduplicateFacts(facts: readonly GroundedFact[]): GroundedFact[] {
  const byKey = new Map<string, GroundedFact>();
  for (const fact of facts) {
    const key = [
      normalizeScope(fact.scope),
      fact.status,
      normalizeClaim(fact.claim),
      fact.value ?? '',
      fact.unit ?? '',
    ].join('|');
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, fact);
      continue;
    }
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...fact.evidenceIds])];
  }
  return [...byKey.values()];
}

function normalizeScope(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[：:，,。.!！?？/|_-]+/gu, '');
}

function normalizeClaim(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

function normalizeNumericValue(value: string): string {
  const numeric = Number(value.replace(/,/gu, ''));
  return Number.isFinite(numeric) ? String(numeric) : value;
}

function normalizeUnit(value: string): string {
  const normalized = value.normalize('NFKC').toLowerCase();
  return normalized === '％' ? '%' : normalized;
}

function compareNumericStrings(left: string, right: string): number {
  return Number(left) - Number(right) || left.localeCompare(right);
}

function requestedPlanScope(question: string): 'basic' | 'permanent_pro' | 'pro' | undefined {
  if (/\b永久\s*pro\b|永久\s*PRO/iu.test(question)) {
    return 'permanent_pro';
  }
  if (/\bbasic\b|免费版/iu.test(question)) {
    return 'basic';
  }
  return /\bpro\b/iu.test(question) ? 'pro' : undefined;
}
