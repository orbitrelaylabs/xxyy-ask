import { tokenize } from '@xxyy/knowledge';

import type { RetrievedChunk } from './retrieve.js';

const SUPPORT_QUESTION_PATTERN =
  /是否支持|当前支持|现在支持|支持(?:哪些|什么|哪几)\s*(?:发射(?:台|平台)|(?:公)?链|chains?)|支持.*(?:吗|么|不)|(?:does|do|can|is|are).*\bsupport\b|\bsupport(?:s|ed)?\b/u;

const SUPPORT_ENTITY_STOP_TOKENS = new Set([
  'are',
  'can',
  'chain',
  'chains',
  'copy',
  'current',
  'currently',
  'do',
  'does',
  'i',
  'is',
  'launchpad',
  'launchpads',
  'me',
  'my',
  'now',
  'please',
  'pro',
  'support',
  'supported',
  'supports',
  'trade',
  'trading',
  'the',
  'this',
  'xxyy',
  'you',
]);

/** Boost applied when a chunk matches a rare support-entity token. */
export const SUPPORT_ENTITY_EVIDENCE_BOOST = 3;

/** Minimum latin entity length eligible for edit-distance matching. */
const FUZZY_ENTITY_MIN_LENGTH = 6;

/** Max Levenshtein distance allowed for long latin entity tokens. */
const FUZZY_ENTITY_MAX_DISTANCE = 1;

export function isSupportQuestionText(question: string): boolean {
  return SUPPORT_QUESTION_PATTERN.test(normalizeText(question));
}

export function extractSupportEntityTokens(question: string): string[] {
  const normalizedQuestion = normalizeText(question);
  if (!isSupportQuestionText(normalizedQuestion)) {
    return [];
  }

  return Array.from(new Set(tokenize(normalizedQuestion))).filter(isSupportEntityToken);
}

export function isSupportEntityToken(token: string): boolean {
  return (
    /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(token) &&
    token.length > 1 &&
    !SUPPORT_ENTITY_STOP_TOKENS.has(token)
  );
}

export function textMatchesSupportEntity(text: string, entity: string): boolean {
  const evidenceTokens = tokenize(normalizeText(text));
  return evidenceTokens.some((token) => latinTokensMatch(token, entity));
}

export function textMatchesAllSupportEntities(text: string, entities: string[]): boolean {
  if (entities.length === 0) {
    return true;
  }

  const evidenceTokens = tokenize(normalizeText(text));
  return entities.every((entity) =>
    evidenceTokens.some((token) => latinTokensMatch(token, entity)),
  );
}

export function supportEntityEvidenceBoost(text: string, entities: string[]): number {
  if (entities.length === 0) {
    return 0;
  }

  if (!textMatchesAllSupportEntities(text, entities)) {
    return 0;
  }

  return SUPPORT_ENTITY_EVIDENCE_BOOST * entities.length;
}

function chunkMatchesSupportEntities(chunk: RetrievedChunk, entities: string[]): boolean {
  if (entities.length === 0) {
    return false;
  }

  return textMatchesAllSupportEntities(toChunkEvidenceText(chunk), entities);
}

export function formatRetrievedChunksDebug(
  chunks: readonly RetrievedChunk[],
  options: { question?: string; limit?: number } = {},
): string {
  const limit = options.limit ?? chunks.length;
  const entities =
    options.question === undefined ? [] : extractSupportEntityTokens(options.question);
  const lines = [
    `Retrieve debug: ${chunks.length} chunk(s)${
      options.question === undefined ? '' : ` for «${options.question}»`
    }`,
  ];

  if (entities.length > 0) {
    lines.push(`Support entities: ${entities.join(', ')}`);
  }

  if (chunks.length === 0) {
    lines.push('(none)');
    return lines.join('\n');
  }

  chunks.slice(0, limit).forEach((chunk, index) => {
    const entityHit = entities.length > 0 && chunkMatchesSupportEntities(chunk, entities);
    lines.push(
      [
        `${index + 1}. ${chunk.id}`,
        `rank=${chunk.rank}`,
        `score=${formatScore(chunk.score)}`,
        `vector=${formatScore(chunk.vectorScore)}`,
        `lexical=${formatScore(chunk.lexicalScore)}`,
        entityHit ? 'entity=yes' : entities.length > 0 ? 'entity=no' : undefined,
        `title=${chunk.metadata.title}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' | '),
    );
    lines.push(`   ${compactPreview(chunk.text)}`);
  });

  return lines.join('\n');
}

export function latinTokenEditDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (left.length === 0) {
    return right.length;
  }

  if (right.length === 0) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? Number.POSITIVE_INFINITY) + 1,
        (current[j - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[j - 1] ?? Number.POSITIVE_INFINITY) + substitutionCost,
      );
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j] ?? Number.POSITIVE_INFINITY;
    }
  }

  return previous[right.length] ?? Number.POSITIVE_INFINITY;
}

function latinTokensMatch(evidenceToken: string, entity: string): boolean {
  const left = evidenceToken.toLowerCase();
  const right = entity.toLowerCase();
  if (left === right) {
    return true;
  }

  if (
    left.length < FUZZY_ENTITY_MIN_LENGTH ||
    right.length < FUZZY_ENTITY_MIN_LENGTH ||
    !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(left) ||
    !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(right)
  ) {
    return false;
  }

  if (Math.abs(left.length - right.length) > FUZZY_ENTITY_MAX_DISTANCE) {
    return false;
  }

  return latinTokenEditDistance(left, right) <= FUZZY_ENTITY_MAX_DISTANCE;
}

function toChunkEvidenceText(chunk: RetrievedChunk): string {
  return [chunk.metadata.title, chunk.metadata.module, ...chunk.metadata.headingPath, chunk.text]
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(3) : String(score);
}

function compactPreview(text: string, maxLength = 120): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 1)}…`;
}
