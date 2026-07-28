import type { ChatAttachment, ChatResponse, Citation, Classification, Intent } from '@xxyy/shared';
import { tokenize } from '@xxyy/knowledge';

import {
  createRetrieveQueryTokens,
  createSemanticRetrieveQuery,
  isHistoricalOrTweetQuestion,
  type RetrievedChunk,
} from './retrieve.js';
import {
  hasUsableKnowledgeText,
  sanitizeRetrievedKnowledgeChunk,
} from './knowledge-content-safety.js';
import {
  extractSupportEntityTokens,
  isSupportEntityToken,
  isSupportQuestionText,
  textMatchesAllSupportEntities,
  textMatchesSupportEntity,
} from './support-entity.js';

const GROUNDED_INTENTS = new Set<Intent>(['product_qa', 'how_to']);
const MAX_CITATIONS = 3;
const MAX_ATTACHMENTS = 4;
const MAX_STRUCTURED_GROUNDING_CHUNKS = 4;
const MAX_EXCERPT_LENGTH = 220;
const MAX_ANSWER_EVIDENCE_LENGTH = 260;
const MAX_FALLBACK_ANSWER_LENGTH = 380;
const MAX_FALLBACK_EVIDENCE_CHUNKS = 4;
const ANSWER_STOP_TOKENS = new Set([
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
const VIDEO_LINK_PATTERN = /\[([^\]]+)\]\((\/assets\/[^)\s]+\.mp4)\)/giu;
const IMAGE_LINK_PATTERN =
  /!\[([^\]]*)\]\((\/assets\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|svg|gif|avif))(?:\s+["'][^"']*["'])?\)/giu;
const HTML_IMAGE_PATTERN = /<img\b[^>]*>/giu;
const YOUTUBE_URL_PATTERN =
  /https:\/\/(?:www\.youtube\.com\/watch\?[^\s<>)]+|youtu\.be\/[A-Za-z0-9_-]+)/giu;
const FUTURE_SUPPORT_PATTERN =
  /计划|即将|预计|未来|下季度|稍后|soon|coming|roadmap|will\s+support|plans?\s+to\s+support/iu;

export function createGroundedAnswer(
  question: string,
  classification: Classification,
  retrievedChunks: RetrievedChunk[],
): ChatResponse {
  if (!GROUNDED_INTENTS.has(classification.intent)) {
    return createBoundaryAnswer(classification);
  }

  if (retrievedChunks.length === 0) {
    return {
      answer: `暂未找到与「${question}」直接相关的资料。请补充具体功能名或模块。`,
      intent: classification.intent,
      citations: [],
      confidence: 0.25,
    };
  }

  const groundingChunks = selectGroundingChunks(question, retrievedChunks);
  if (groundingChunks.length === 0) {
    return createInsufficientKnowledgeAnswer(question, classification.intent);
  }

  const fallbackEvidenceChunks = selectFallbackEvidenceChunks(question, groundingChunks);
  const perChunkEvidenceLength = Math.min(
    MAX_ANSWER_EVIDENCE_LENGTH,
    Math.floor(MAX_FALLBACK_ANSWER_LENGTH / Math.max(1, fallbackEvidenceChunks.length)),
  );
  const answerEvidence = fallbackEvidenceChunks
    .map((chunk) =>
      formatFallbackEvidence(
        question,
        withFallbackEvidenceDate(
          question,
          chunk,
          cleanEvidenceSentence(
            createRelevantExcerpt(question, chunk.text, perChunkEvidenceLength),
          ),
        ),
      ),
    )
    .filter((evidence) => evidence.length > 0);
  const standardSupportAnswer = isSupportQuestionText(question)
    ? groundingChunks
        .map((chunk) => extractStandardCustomerAnswer(chunk.text))
        .find(
          (answer) =>
            answer !== undefined && evidenceMatchesAllRequiredSupportEntities(question, answer),
        )
    : undefined;
  const supportConclusion =
    standardSupportAnswer ?? createSupportConclusion(question, groundingChunks);
  const answerChunks = supportConclusion === undefined ? fallbackEvidenceChunks : groundingChunks;
  const citations = createCitationsForQuestion(question, answerChunks);
  const evidenceAnswer = truncateAnswerText(
    answerEvidence.join(isStructuredAnswerQuestion(question) ? '\n' : ' '),
    MAX_FALLBACK_ANSWER_LENGTH,
  );
  const answerPrefix =
    classification.intent === 'how_to'
      ? `操作要点：${evidenceAnswer.includes('\n') ? '\n' : ''}`
      : '';
  const structuredSubjectPrefix =
    isStructuredAnswerQuestion(question) &&
    fallbackEvidenceChunks.length > 1 &&
    fallbackEvidenceChunks.every(
      (chunk) => chunk.metadata.title === fallbackEvidenceChunks[0]?.metadata.title,
    )
      ? `${fallbackEvidenceChunks[0]?.metadata.title}：\n`
      : '';

  return withOptionalAttachments(
    {
      answer:
        supportConclusion ??
        `${answerPrefix}${structuredSubjectPrefix}${evidenceAnswer.length > 0 ? evidenceAnswer : insufficientKnowledgeText(question)}`,
      intent: classification.intent,
      citations,
      confidence: calculateGroundedConfidence(
        classification.confidence,
        answerChunks[0]?.score ?? 0,
      ),
    },
    createAttachmentsFromChunks(answerChunks),
  );
}

export function selectGroundingChunks(
  question: string,
  retrievedChunks: RetrievedChunk[],
): RetrievedChunk[] {
  const safeRetrievedChunks = retrievedChunks
    .map(sanitizeRetrievedKnowledgeChunk)
    .filter((chunk) => hasUsableKnowledgeText(chunk.text));
  const deduplicatedChunks = filterStandardAnswerGroundingChunks(
    question,
    filterTemporalGroundingChunks(question, deduplicateGroundingChunks(safeRetrievedChunks)),
  );
  const highRankedChunks = deduplicatedChunks.slice(0, MAX_CITATIONS);

  if (isDirectSourceQuestion(question)) {
    const directXPostChunk = selectBestDirectXPostChunk(
      question,
      highRankedChunks.filter(isDirectXPostChunk),
    );
    if (directXPostChunk !== undefined) {
      return [directXPostChunk];
    }
  }

  const supportEntityTokens = extractSupportEntityTokens(question);
  if (supportEntityTokens.length > 0) {
    // Scan the full retrieved candidate list so rare entities are not lost to
    // generic "支持" hits that crowd the top citation window. A current
    // evidence chunk may use context from another chunk of the exact same
    // source, but unrelated sources cannot jointly satisfy a multi-entity
    // support question.
    const evidenceByScope = createSupportEvidenceByScope(deduplicatedChunks);
    const candidates = deduplicatedChunks
      .map((chunk) => ({
        chunk,
        entityMatches: supportEntityTokens.filter((entity) =>
          textMatchesSupportEntity(toEvidenceText(chunk), entity),
        ).length,
        hasCurrentEvidence: splitEvidenceSentences(chunk.text).some(isCurrentSupportSentence),
        scopeMatchesAllEntities: textMatchesAllSupportEntities(
          evidenceByScope.get(supportEvidenceScopeKey(chunk)) ?? toEvidenceText(chunk),
          supportEntityTokens,
        ),
      }))
      .filter((candidate) => candidate.entityMatches > 0 && candidate.scopeMatchesAllEntities)
      .filter((candidate) => candidate.hasCurrentEvidence)
      .sort(
        (left, right) =>
          Number(right.hasCurrentEvidence) - Number(left.hasCurrentEvidence) ||
          right.entityMatches - left.entityMatches ||
          left.chunk.rank - right.chunk.rank,
      )
      .map((candidate) => candidate.chunk);
    return candidates.slice(0, MAX_CITATIONS);
  }

  if (isSupportQuestionText(question)) {
    const supportKeywords = supportEvidenceKeywords(question);
    const candidates = deduplicatedChunks
      .map((chunk) => ({
        chunk,
        coverage: supportKeywords.filter((keyword) =>
          containsAllEvidenceTokens(normalizeForEvidenceMatch(chunk.text), [keyword]),
        ).length,
        hasCurrentEvidence: splitEvidenceSentences(chunk.text).some(isCurrentSupportSentence),
      }))
      .filter((candidate) => candidate.coverage > 0 && candidate.hasCurrentEvidence)
      .sort((left, right) => right.coverage - left.coverage || left.chunk.rank - right.chunk.rank)
      .map((candidate) => candidate.chunk);
    if (candidates.length > 0) {
      return candidates.slice(0, MAX_CITATIONS);
    }
  }

  const standardAnswerChunk = highRankedChunks.find(
    (chunk) => /标准客服回答：/u.test(chunk.text) && standardAnswerMatchesQuestion(chunk, question),
  );
  if (
    standardAnswerChunk !== undefined &&
    !requiresMultipleGroundingSources(question) &&
    !requiresDetailedOperationalEvidence(question)
  ) {
    return [standardAnswerChunk];
  }

  if (isStructuredAnswerQuestion(question)) {
    return selectStructuredGroundingChunks(question, deduplicatedChunks);
  }

  return highRankedChunks;
}

function filterStandardAnswerGroundingChunks(
  question: string,
  chunks: RetrievedChunk[],
): RetrievedChunk[] {
  const relevantChunks = chunks.filter(
    (chunk) =>
      !/标准客服回答：/u.test(chunk.text) || standardAnswerMatchesQuestion(chunk, question),
  );
  return relevantChunks.length === 0 ? chunks : relevantChunks;
}

function standardAnswerMatchesQuestion(chunk: RetrievedChunk, question: string): boolean {
  if (titleMatchesQuestion(chunk.metadata.title, question)) {
    return true;
  }

  const queryTokens = meaningfulAnswerTokens(question);
  if (queryTokens.length === 0) {
    return false;
  }
  const titleTokens = meaningfulAnswerTokens(chunk.metadata.title);
  const matchedTitleTokens = titleTokens.filter((token) => queryTokens.includes(token));
  if (
    titleTokens.length > 0 &&
    matchedTitleTokens.length / titleTokens.length >= 0.5 &&
    /权益|有什么|哪些|多少|上限|限制|包括|包含|区别|比较/u.test(question)
  ) {
    return true;
  }
  const evidenceTokens = new Set(tokenize(toEvidenceText(chunk)));
  const matchedTokenCount = queryTokens.filter((token) => evidenceTokens.has(token)).length;
  return matchedTokenCount / queryTokens.length >= 0.75;
}

function filterTemporalGroundingChunks(
  question: string,
  chunks: RetrievedChunk[],
): RetrievedChunk[] {
  const historicalRange = extractHistoricalReferenceRange(question);
  if (historicalRange !== undefined) {
    const datedChunks = chunks.flatMap((chunk) => {
      const timestamp = Date.parse(chunk.metadata.effectiveAt ?? '');
      return Number.isFinite(timestamp) ? [{ chunk, timestamp }] : [];
    });
    const withinRange = datedChunks
      .filter(
        ({ timestamp }) =>
          timestamp >= historicalRange.startTimestamp && timestamp <= historicalRange.endTimestamp,
      )
      .map(({ chunk }) => chunk);
    if (withinRange.length > 0) {
      return withinRange;
    }

    const latestBeforeRange = datedChunks
      .filter(({ timestamp }) => timestamp <= historicalRange.endTimestamp)
      .sort((left, right) => right.timestamp - left.timestamp || left.chunk.rank - right.chunk.rank)
      .map(({ chunk }) => chunk);
    if (latestBeforeRange.length > 0) {
      return latestBeforeRange;
    }

    return datedChunks.length === 0 ? chunks : [];
  }

  if (!isCurrentStateQuestion(question)) {
    return chunks;
  }

  const currentChunks = chunks.filter(
    (chunk) =>
      chunk.metadata.status !== 'historical' &&
      chunk.metadata.status !== 'deprecated' &&
      !describesHistoricalProgression(chunk.text),
  );
  return currentChunks.length === 0 ? chunks : currentChunks;
}

function extractHistoricalReferenceRange(
  question: string,
): { endTimestamp: number; startTimestamp: number } | undefined {
  const normalized = question.normalize('NFKC');
  const dayMatch =
    /(?<year>(?:19|20)\d{2})\s*年\s*(?<month>\d{1,2})\s*月\s*(?<day>\d{1,2})\s*日?/u.exec(
      normalized,
    ) ?? /(?<year>(?:19|20)\d{2})[-/](?<month>\d{1,2})[-/](?<day>\d{1,2})/u.exec(normalized);
  const year = Number(dayMatch?.groups?.year);
  const month = Number(dayMatch?.groups?.month);
  const day = Number(dayMatch?.groups?.day);
  if (isValidDateParts(year, month, day)) {
    return {
      endTimestamp: Date.UTC(year, month - 1, day + 1) - 1,
      startTimestamp: Date.UTC(year, month - 1, day),
    };
  }

  const monthMatch = /(?<year>(?:19|20)\d{2})\s*年\s*(?<month>\d{1,2})\s*月/u.exec(normalized);
  const monthYear = Number(monthMatch?.groups?.year);
  const monthNumber = Number(monthMatch?.groups?.month);
  if (
    Number.isInteger(monthYear) &&
    Number.isInteger(monthNumber) &&
    monthNumber >= 1 &&
    monthNumber <= 12
  ) {
    return {
      endTimestamp: Date.UTC(monthYear, monthNumber, 1) - 1,
      startTimestamp: Date.UTC(monthYear, monthNumber - 1, 1),
    };
  }

  return undefined;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isCurrentStateQuestion(question: string): boolean {
  if (isHistoricalOrTweetQuestion(question)) {
    return false;
  }
  return /当前|现在|目前|最新|最多|上限|现阶段|today|current(?:ly)?|latest|now/iu.test(
    question.normalize('NFKC'),
  );
}

function describesHistoricalProgression(text: string): boolean {
  const normalized = text.normalize('NFKC');
  return /早期|曾经|此前|历史(?:版本|配额|上限)|逐步(?:提高|提升|增加)|从.{0,40}(?:提高|提升|增加|扩展)到.{0,40}(?:再到|目前|现在|当前)/u.test(
    normalized,
  );
}

function deduplicateGroundingChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  const deduplicated: RetrievedChunk[] = [];
  for (const chunk of chunks) {
    const key = isDirectXPostChunk(chunk)
      ? `direct-x:${chunk.id}`
      : `${chunk.metadata.sourceType}:${chunk.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const duplicateIndex = deduplicated.findIndex((candidate) =>
      groundingTextsSubstantiallyOverlap(candidate.text, chunk.text),
    );
    if (duplicateIndex < 0) {
      deduplicated.push(chunk);
      continue;
    }

    const existing = deduplicated[duplicateIndex];
    if (
      existing !== undefined &&
      groundingSourceSpecificity(chunk) > groundingSourceSpecificity(existing)
    ) {
      deduplicated[duplicateIndex] = chunk;
    }
  }
  return deduplicated;
}

function groundingTextsSubstantiallyOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeForEvidenceMatch(left).replace(/\s+/gu, '');
  const normalizedRight = normalizeForEvidenceMatch(right).replace(/\s+/gu, '');
  if (Math.min(normalizedLeft.length, normalizedRight.length) < 40) {
    return false;
  }
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function groundingSourceSpecificity(chunk: RetrievedChunk): number {
  return chunk.metadata.sourceUrl === undefined ? 0 : 1;
}

export function createInsufficientKnowledgeAnswer(question: string, intent: Intent): ChatResponse {
  return {
    answer: insufficientKnowledgeText(question),
    citations: [],
    confidence: 0.25,
    intent,
  };
}

export function shouldUseDeterministicSupportAnswer(question: string): boolean {
  return isSupportQuestionText(question);
}

function withOptionalAttachments(
  response: ChatResponse,
  attachments: ChatAttachment[],
): ChatResponse {
  if (attachments.length === 0) {
    return response;
  }

  return {
    ...response,
    attachments,
  };
}

export function createAttachmentsFromChunks(retrievedChunks: RetrievedChunk[]): ChatAttachment[] {
  const byUrl = new Map<string, ChatAttachment>();

  for (const chunk of retrievedChunks) {
    for (const attachment of [
      ...(chunk.metadata.attachments ?? []),
      ...extractInlineMediaAttachments(chunk.text, chunk.metadata.title),
    ]) {
      if (!byUrl.has(attachment.url)) {
        byUrl.set(attachment.url, attachment);
      }
      if (byUrl.size >= MAX_ATTACHMENTS) {
        return Array.from(byUrl.values());
      }
    }
  }

  return Array.from(byUrl.values());
}

function extractInlineMediaAttachments(text: string, fallbackTitle: string): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];

  for (const match of text.matchAll(VIDEO_LINK_PATTERN)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (title === undefined || title.length === 0 || url === undefined || url.length === 0) {
      continue;
    }
    attachments.push({
      kind: 'video',
      mediaType: 'video/mp4',
      title,
      url,
    });
  }

  for (const match of text.matchAll(IMAGE_LINK_PATTERN)) {
    const url = match[2]?.trim();
    const mediaType = url === undefined ? undefined : imageMediaTypeFromUrl(url);
    if (url === undefined || mediaType === undefined) continue;
    attachments.push({
      kind: 'image',
      mediaType,
      title: match[1]?.trim() || fallbackTitle,
      url,
    });
  }

  for (const match of text.matchAll(HTML_IMAGE_PATTERN)) {
    const tag = match[0];
    const url = htmlAttribute(tag, 'src');
    const mediaType = url === undefined ? undefined : imageMediaTypeFromUrl(url);
    if (url === undefined || mediaType === undefined || !url.startsWith('/assets/')) continue;
    attachments.push({
      kind: 'image',
      mediaType,
      title: htmlAttribute(tag, 'alt')?.trim() || fallbackTitle,
      url,
    });
  }

  for (const match of text.matchAll(YOUTUBE_URL_PATTERN)) {
    const url = normalizeYouTubeUrl(match[0]);
    if (url === undefined) continue;
    attachments.push({
      kind: 'video',
      mediaType: 'text/html',
      title: fallbackTitle,
      url,
    });
  }

  return attachments;
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(?<value>.*?)\\1`, 'iu').exec(tag);
  return match?.groups?.value;
}

function imageMediaTypeFromUrl(
  url: string,
): Extract<ChatAttachment, { kind: 'image' }>['mediaType'] | undefined {
  const extension = /\.([A-Za-z0-9]+)(?:[?#]|$)/u.exec(url)?.[1]?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'svg') return 'image/svg+xml';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'avif') return 'image/avif';
  return undefined;
}

function normalizeYouTubeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname === 'www.youtube.com' && url.pathname === '/watch') {
      const videoId = url.searchParams.get('v');
      return videoId === null || !/^[A-Za-z0-9_-]+$/u.test(videoId)
        ? undefined
        : `https://www.youtube.com/watch?v=${videoId}`;
    }
    if (url.hostname === 'youtu.be') {
      const videoId = url.pathname.slice(1);
      return /^[A-Za-z0-9_-]+$/u.test(videoId) ? `https://youtu.be/${videoId}` : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isDirectSourceQuestion(question: string): boolean {
  return /哪条推文|哪条推特|哪篇推文|哪篇推特|具体推文|具体推特|tweet|x\s*post/iu.test(
    question.normalize('NFKC'),
  );
}

function requiresMultipleGroundingSources(question: string): boolean {
  return (
    /比较|对比|区别|分别|同时|以及|与|\bcompare\b|\bversus\b|\bvs\b/iu.test(question) ||
    /(?:权益|功能|设置|上限|限制|管理).*和.*(?:权益|功能|设置|上限|限制|管理)/u.test(question)
  );
}

function isDirectXPostChunk(chunk: RetrievedChunk): boolean {
  return (
    chunk.metadata.sourceType === 'x_updates' &&
    /^X Post \d+/u.test(chunk.metadata.title) &&
    /^https:\/\/x\.com\//u.test(chunk.metadata.sourceUrl ?? '')
  );
}

function selectBestDirectXPostChunk(
  question: string,
  chunks: RetrievedChunk[],
): RetrievedChunk | undefined {
  let bestChunk: RetrievedChunk | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  const queryTokens = meaningfulSourceQuestionTokens(question);

  for (const chunk of chunks) {
    const evidence = toEvidenceText(chunk);
    let score = 0;
    for (const token of queryTokens) {
      if (evidence.includes(token)) {
        score += token.length > 2 ? token.length : 1;
      }
    }

    if (score > bestScore) {
      bestChunk = chunk;
      bestScore = score;
    }
  }

  return bestChunk;
}

function meaningfulSourceQuestionTokens(question: string): string[] {
  const stopTokens = new Set([
    'tweet',
    'post',
    'x',
    '哪条',
    '哪篇',
    '具体',
    '推文',
    '推特',
    '来源',
  ]);
  return tokenize(question).filter((token) => token.length > 1 && !stopTokens.has(token));
}

function containsAllEvidenceTokens(text: string, tokens: string[]): boolean {
  return textMatchesAllSupportEntities(text, tokens);
}

function createSupportConclusion(
  question: string,
  groundingChunks: RetrievedChunk[],
): string | undefined {
  return createSupportConclusionFromEvidence(
    question,
    groundingChunks.map((chunk) => chunk.text),
  );
}

export function createSupportConclusionFromEvidence(
  question: string,
  evidenceTexts: string[],
): string | undefined {
  const normalizedQuestion = normalizeForEvidenceMatch(question);
  if (!isSupportQuestionText(normalizedQuestion)) {
    return undefined;
  }
  if (
    !evidenceMatchesAllRequiredSupportEntities(
      question,
      evidenceTexts.map(normalizeForEvidenceMatch).join(' '),
    )
  ) {
    return undefined;
  }

  const sentence = selectSupportEvidenceSentence(question, evidenceTexts);
  if (sentence === undefined) {
    return undefined;
  }

  if (isNegativeSupportSentence(sentence) || /^(?:支持|已支持|全面支持)/u.test(sentence)) {
    return ensureSentenceEnding(sentence);
  }

  return `支持。${ensureSentenceEnding(sentence)}`;
}

function selectSupportEvidenceSentence(
  question: string,
  evidenceTexts: string[],
): string | undefined {
  const keywords = supportEvidenceKeywords(question);
  if (keywords.length === 0) {
    return undefined;
  }

  const candidate = evidenceTexts
    .map((text, index) => {
      const sentences = splitEvidenceSentences(text);
      const hasCurrentSupport = sentences.some((sentence) =>
        isCurrentSupportSentence(normalizeForEvidenceMatch(sentence)),
      );
      const normalizedText = normalizeForEvidenceMatch(sentences.join(' '));
      const coverage = keywords.filter((keyword) =>
        containsAllEvidenceTokens(normalizedText, [keyword]),
      ).length;
      return { coverage, hasCurrentSupport, index, sentences };
    })
    .filter((item) => item.hasCurrentSupport && item.coverage > 0)
    .sort((left, right) => right.coverage - left.coverage || left.index - right.index)[0];
  if (candidate === undefined) {
    return undefined;
  }

  const selected: string[] = [];
  const covered = new Set<string>();
  const rankedSentences = candidate.sentences
    .map((sentence, index) => {
      const normalizedSentence = normalizeForEvidenceMatch(sentence);
      const matchedKeywords = keywords.filter((keyword) =>
        containsAllEvidenceTokens(normalizedSentence, [keyword]),
      );
      return {
        index,
        isCurrentSupport: isCurrentSupportSentence(normalizedSentence),
        matchedKeywords,
        sentence,
      };
    })
    .filter((item) => item.matchedKeywords.length > 0)
    .sort(
      (left, right) =>
        Number(right.isCurrentSupport) - Number(left.isCurrentSupport) ||
        right.matchedKeywords.length - left.matchedKeywords.length ||
        left.index - right.index,
    );

  for (const item of rankedSentences) {
    const addsCoverage = item.matchedKeywords.some((keyword) => !covered.has(keyword));
    if (!addsCoverage && selected.length > 0) {
      continue;
    }
    selected.push(cleanEvidenceSentence(item.sentence));
    item.matchedKeywords.forEach((keyword) => covered.add(keyword));
    if (covered.size === candidate.coverage) {
      break;
    }
  }

  return selected
    .sort((left, right) => candidate.sentences.indexOf(left) - candidate.sentences.indexOf(right))
    .join(' ');
}

function supportEvidenceKeywords(question: string): string[] {
  const subjectTokens = extractSupportSubjectTokens(question);
  if (subjectTokens.length > 0) {
    return subjectTokens;
  }

  return Array.from(new Set(extractSupportEntityTokens(question)));
}

function extractSupportSubjectTokens(question: string): string[] {
  const normalized = question.normalize('NFKC').toLowerCase();
  const beforeSupport = /(?:^|\s)(?<subject>[\p{Letter}\p{Number}#._/-]{2,24})\s*支持/iu.exec(
    normalized.replace(/\bxxyy\b/gu, ' '),
  )?.groups?.subject;
  const afterSupport =
    /支持\s*(?!哪些|什么|哪几)(?<subject>[\p{Letter}\p{Number}#._ /-]{2,24}?)(?:吗|么|嘛|呢|\?|？|$)/iu.exec(
      normalized,
    )?.groups?.subject;
  for (const subject of [beforeSupport, afterSupport]) {
    if (subject === undefined) {
      continue;
    }
    const tokens = Array.from(
      new Set(
        tokenize(subject).filter(
          (token) =>
            !ANSWER_STOP_TOKENS.has(token) &&
            (/^[a-z0-9][a-z0-9._/-]*$/u.test(token) || token.length === 2),
        ),
      ),
    );
    if (tokens.length > 0) {
      return tokens;
    }
  }

  return [];
}

function isCurrentSupportSentence(sentence: string): boolean {
  return (
    !FUTURE_SUPPORT_PATTERN.test(sentence) &&
    !/[吗么嘛呢][？?]?$|[？?]$/u.test(sentence) &&
    /支持|上线|可用|暂时没有|不支持|未支持|尚未支持|\bsupport(?:s|ed)?\b|\bavailable\b|\blaunched\b/iu.test(
      sentence,
    )
  );
}

function splitEvidenceSentences(text: string): string[] {
  return text
    .replace(/\s+-\s+/gu, '\n')
    .split(/(?<=[。！？!?])\s+|\n+/u)
    .map(cleanEvidenceSentence)
    .filter((sentence) => sentence.length > 0);
}

function cleanEvidenceSentence(sentence: string): string {
  return sentence
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, '$1')
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/^[\s\-*•|]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isNegativeSupportSentence(sentence: string): boolean {
  return /暂时没有|不支持|未支持|尚未支持|没有明确/u.test(sentence);
}

function ensureSentenceEnding(sentence: string): string {
  return /[。！？!?]$/u.test(sentence) ? sentence : `${sentence}。`;
}

function toEvidenceText(chunk: RetrievedChunk): string {
  return normalizeForEvidenceMatch(
    [chunk.metadata.title, chunk.metadata.module, ...chunk.metadata.headingPath, chunk.text].join(
      ' ',
    ),
  );
}

function createSupportEvidenceByScope(chunks: RetrievedChunk[]): Map<string, string> {
  const evidencePartsByScope = new Map<string, string[]>();
  for (const chunk of chunks) {
    const scope = supportEvidenceScopeKey(chunk);
    const parts = evidencePartsByScope.get(scope) ?? [];
    parts.push(toEvidenceText(chunk));
    evidencePartsByScope.set(scope, parts);
  }

  return new Map(
    Array.from(evidencePartsByScope, ([scope, evidenceParts]) => [scope, evidenceParts.join(' ')]),
  );
}

function supportEvidenceScopeKey(chunk: RetrievedChunk): string {
  const sourceUrl = chunk.metadata.sourceUrl?.trim();
  if (sourceUrl !== undefined && sourceUrl.length > 0) {
    return `source:${sourceUrl}`;
  }

  return `document:${chunk.documentId}`;
}

function evidenceMatchesAllRequiredSupportEntities(question: string, evidence: string): boolean {
  const requiredEntities = extractSupportEntityTokens(question);
  return (
    requiredEntities.length === 0 ||
    textMatchesAllSupportEntities(normalizeForEvidenceMatch(evidence), requiredEntities)
  );
}

function normalizeForEvidenceMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export function createBoundaryAnswer(classification: Classification): ChatResponse {
  return {
    answer:
      classification.reason === 'business action execution request'
        ? businessActionBoundaryText()
        : classification.reason === 'private credential or seed phrase disclosure'
          ? privateCredentialBoundaryText()
          : classification.reason === 'unsupported transaction or mev analysis request'
            ? unsupportedTransactionAnalysisBoundaryText()
            : classification.reason === 'unsafe or unsupported operation request'
              ? unsafeOperationBoundaryText()
              : boundaryText(classification.intent),
    intent: classification.intent,
    citations: [],
    confidence: Math.min(classification.confidence, 0.7),
  };
}

function boundaryText(intent: Intent): string {
  switch (intent) {
    case 'realtime_account_query':
      return '我不能直接查询你的钱包余额、订单、账户或交易记录，也不会编造实时数据。请在已授权的 XXYY 产品界面查看；如果你想了解产品里如何找到这些入口，可以继续问我操作步骤。';
    case 'investment_advice':
      return '我不能提供买卖建议、喊单或收益承诺。可以帮你理解 XXYY 产品功能、风险提示或如何使用产品信息，但最终投资判断需要你自行评估风险。';
    case 'agent_capabilities':
    case 'unknown':
      return '我还不确定你想咨询的具体问题。你可以补充是想了解 XXYY 产品功能、设置步骤，还是账户/交易相关入口。';
    case 'product_qa':
    case 'how_to':
      return '暂时没有找到可引用的知识库内容。';
  }
}

function businessActionBoundaryText(): string {
  return '我不能代你开通、取消、修改、退款、赔偿或执行账户内操作，也不会在客服对话里完成这类处理。可以继续问我开通或升级的操作步骤、权益说明、配置路径，我会基于 XXYY 知识库回答。';
}

function privateCredentialBoundaryText(): string {
  return '不要在客服对话里发送私钥、助记词、密码、API key 或任何敏感凭据。为了你的资产和账户安全，我不会处理这类内容；如果你想了解 XXYY 相关安全设置入口，可以改问产品操作步骤。';
}

function unsafeOperationBoundaryText(): string {
  return '我不能帮助攻击、盗号、钓鱼、破解或利用系统漏洞。可以继续咨询 XXYY 产品功能、配置步骤、权益说明或官方更新相关问题。';
}

function unsupportedTransactionAnalysisBoundaryText(): string {
  return '当前不分析交易哈希、explorer 链接、池子、链上取证或 MEV/夹子问题，也不会编造实时链上结论。可以继续咨询 XXYY 产品功能、配置步骤、权益说明或官方更新。';
}

export function createCitationsFromChunks(retrievedChunks: RetrievedChunk[]): Citation[] {
  return retrievedChunks
    .map(sanitizeRetrievedKnowledgeChunk)
    .filter((chunk) => hasUsableKnowledgeText(chunk.text))
    .slice(0, MAX_STRUCTURED_GROUNDING_CHUNKS)
    .map(createCitation);
}

export function createCitationsForAnswer(
  question: string,
  answer: string,
  retrievedChunks: RetrievedChunk[],
): Citation[] {
  const relevanceQuery = `${question}\n${answer}`;
  return retrievedChunks
    .map(sanitizeRetrievedKnowledgeChunk)
    .filter((chunk) => hasUsableKnowledgeText(chunk.text))
    .slice(0, MAX_STRUCTURED_GROUNDING_CHUNKS)
    .map((chunk) => ({
      ...createCitation(chunk),
      excerpt: withCitationPublicationDate(
        chunk,
        createRelevantExcerpt(relevanceQuery, chunk.text),
      ),
    }));
}

function createCitationsForQuestion(
  question: string,
  retrievedChunks: RetrievedChunk[],
): Citation[] {
  return retrievedChunks.slice(0, MAX_STRUCTURED_GROUNDING_CHUNKS).map((chunk) => ({
    ...createCitation(chunk),
    excerpt: withCitationPublicationDate(chunk, createRelevantExcerpt(question, chunk.text)),
  }));
}

function createCitation(chunk: RetrievedChunk): Citation {
  const citation: Citation = {
    title: chunk.metadata.title,
    file: normalizeCitationFile(chunk.metadata.file),
    excerpt: withCitationPublicationDate(chunk, createExcerpt(chunk.text)),
    sourceType: chunk.metadata.sourceType,
  };

  if (chunk.metadata.sourceUrl !== undefined) {
    return {
      ...citation,
      sourceUrl: chunk.metadata.sourceUrl,
    };
  }

  return citation;
}

function withCitationPublicationDate(chunk: RetrievedChunk, excerpt: string): string {
  const publicationDate = chunk.metadata.effectiveAt?.slice(0, 10);
  if (publicationDate === undefined || excerpt.includes(publicationDate)) {
    return excerpt;
  }
  return truncateExcerpt(`发布日期：${publicationDate}。 ${excerpt}`, MAX_EXCERPT_LENGTH);
}

function normalizeCitationFile(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  const docsIndex = normalized.indexOf('/docs/');
  if (docsIndex >= 0) {
    return normalized.slice(docsIndex + 1);
  }

  return normalized.replace(/^\/+/u, '');
}

function createExcerpt(text: string): string {
  const compact = (extractStandardCustomerAnswer(text) ?? text).replace(/\s+/gu, ' ').trim();
  if (compact.length <= MAX_EXCERPT_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

function selectFallbackEvidenceChunks(
  question: string,
  chunks: RetrievedChunk[],
): RetrievedChunk[] {
  const firstChunk = chunks[0];
  if (firstChunk === undefined) {
    return [];
  }
  const authoredAlternative =
    firstChunk.metadata.sourceUrl === undefined || isAuthoredOfficialKnowledgeChunk(firstChunk)
      ? undefined
      : chunks.find(
          (chunk) =>
            chunk.metadata.sourceUrl === firstChunk.metadata.sourceUrl &&
            isAuthoredOfficialKnowledgeChunk(chunk),
        );
  const anchor = authoredAlternative ?? firstChunk;
  const ordered = [anchor, ...chunks.filter((chunk) => chunk.id !== anchor.id)];

  if (
    isDirectSourceQuestion(question) ||
    (extractStandardCustomerAnswer(anchor.text) !== undefined &&
      standardAnswerMatchesQuestion(anchor, question) &&
      !requiresMultipleGroundingSources(question))
  ) {
    return [anchor];
  }

  if (isStructuredAnswerQuestion(question) && !requiresMultipleGroundingSources(question)) {
    const sameDocumentChunks = ordered.filter((chunk) => chunk.documentId === anchor.documentId);
    if (
      sameDocumentChunks.length > 1 &&
      (!isAuthoredOfficialKnowledgeChunk(anchor) ||
        /各自|分别|每个|作用|做什么|干什么|区域|部分|模块/u.test(question))
    ) {
      return sameDocumentChunks.slice(0, MAX_FALLBACK_EVIDENCE_CHUNKS);
    }
    if (isAuthoredOfficialKnowledgeChunk(anchor)) {
      return [anchor];
    }
    return ordered.slice(0, 2);
  }

  if (requiresMultipleGroundingSources(question)) {
    const selected: RetrievedChunk[] = [];
    const seenScopes = new Set<string>();
    for (const chunk of ordered) {
      const scope = fallbackEvidenceScopeKey(chunk);
      if (seenScopes.has(scope)) {
        continue;
      }
      seenScopes.add(scope);
      selected.push(chunk);
      if (selected.length >= MAX_FALLBACK_EVIDENCE_CHUNKS) {
        break;
      }
    }
    return selected;
  }

  const sameDocumentChunks = ordered.filter((chunk) => chunk.documentId === anchor.documentId);
  return sameDocumentChunks.slice(0, MAX_FALLBACK_EVIDENCE_CHUNKS);
}

function isAuthoredOfficialKnowledgeChunk(chunk: RetrievedChunk): boolean {
  return (
    chunk.metadata.sourceType === 'official_docs' &&
    !chunk.metadata.file.replaceAll('\\', '/').includes('/enriched/')
  );
}

function fallbackEvidenceScopeKey(chunk: RetrievedChunk): string {
  return chunk.metadata.sourceUrl ?? chunk.documentId;
}

function withFallbackEvidenceDate(
  question: string,
  chunk: RetrievedChunk,
  evidence: string,
): string {
  const publicationDate = chunk.metadata.effectiveAt?.slice(0, 10);
  if (
    publicationDate === undefined ||
    evidence.includes(publicationDate) ||
    (!isHistoricalOrTweetQuestion(question) &&
      !/什么时候|何时|哪年|哪月|哪天|开放时间|发布时间|发布日期/u.test(question))
  ) {
    return evidence;
  }
  return `${publicationDate}：${evidence}`;
}

function createRelevantExcerpt(
  question: string,
  text: string,
  maximumLength = MAX_EXCERPT_LENGTH,
): string {
  const standardAnswer = extractStandardCustomerAnswer(text);
  if (standardAnswer !== undefined) {
    return truncateExcerpt(standardAnswer, maximumLength);
  }

  const segments = text
    .split(/\n+|(?<=[。！？!?；;])\s*/u)
    .map((segment) => segment.replace(/\s+/gu, ' ').trim())
    .filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return truncateExcerpt(text, maximumLength);
  }

  const queryTokens = meaningfulAnswerTokens(question);
  const ranked = segments
    .map((segment, index) => ({
      index,
      score: evidenceSegmentScore(segment, queryTokens, question),
      segment,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = ranked[0];
  if (best === undefined) {
    return truncateExcerpt(text, maximumLength);
  }

  const selectedIndexes = [best.index];
  let selectedLength = best.segment.length;
  const neighborIndexes = [
    ...segments.map((_, index) => best.index + index + 1),
    ...segments.map((_, index) => best.index - index - 1),
  ];
  for (const index of neighborIndexes) {
    const segment = segments[index];
    if (segment === undefined || selectedIndexes.includes(index)) {
      continue;
    }
    if (selectedLength + 1 + segment.length > maximumLength) {
      continue;
    }
    selectedIndexes.push(index);
    selectedLength += 1 + segment.length;
    if (selectedLength >= maximumLength * 0.8) {
      break;
    }
  }

  const excerpt = selectedIndexes
    .sort((left, right) => left - right)
    .map((index) => segments[index])
    .filter((segment): segment is string => segment !== undefined)
    .join(' ');
  return truncateExcerpt(excerpt, maximumLength);
}

function truncateExcerpt(text: string, maximumLength: number): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (compact.length <= maximumLength) {
    return compact;
  }

  return `${compact.slice(0, maximumLength - 1)}…`;
}

function truncateAnswerText(text: string, maximumLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maximumLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maximumLength - 1).trimEnd()}…`;
}

function formatFallbackEvidence(question: string, text: string): string {
  if (!isStructuredAnswerQuestion(question)) {
    return text.replace(/\s+\*\s+/gu, '；');
  }

  const fieldLabel =
    '(?:社交媒体|创建时间(?:（分钟）)?|市值|Dev Buy金额|Dev Sell金额|Holder人数|钱包交易类型|最小买入金额|最小卖出金额|是否开启推送|仅推送Pump交易|买入价值(?:（Invested）)?|卖出价值(?:（Sold）)?|剩余价值(?:（Remaining）)?|盈亏倍率(?:（Change in P\\\\&L）)?)';
  const withBreaks = text
    .replace(/\s+\*\s+/gu, '\n')
    .replace(new RegExp(`\\s+(?=${fieldLabel}[：:])`, 'gu'), '\n');
  const lines = withBreaks
    .split(/\n+/u)
    .map((line) => line.replace(/^[-*•]\s*/u, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return text.replace(/\s+\*\s+/gu, '；');
  }

  if (
    lines.length > 1 &&
    /事半功倍|快人一步|神器|赚钱|胜率|福利|立即体验|欢迎/u.test(lines[0] ?? '')
  ) {
    lines.shift();
  }

  return lines.map((line) => `- ${line}`).join('\n');
}

function meaningfulAnswerTokens(question: string): string[] {
  return Array.from(
    new Set(
      createRetrieveQueryTokens(question).filter(
        (token) =>
          !ANSWER_STOP_TOKENS.has(token) &&
          (/^[a-z0-9][a-z0-9_-]*$/u.test(token) || token.length === 2),
      ),
    ),
  );
}

function evidenceSegmentScore(segment: string, queryTokens: string[], question: string): number {
  const evidenceTokens = new Set(tokenize(segment));
  const tokenMatches = queryTokens.filter((token) => evidenceTokens.has(token)).length;
  const structuredEvidence = isStructuredAnswerQuestion(question)
    ? Math.min(2, (segment.match(/[、，,；;：:]|(?:^|\s)\d+[.)、]/gu)?.length ?? 0) / 3) +
      (/是指|包括|包含|分为/u.test(segment)
        ? 1
        : /支持.{0,12}(?:筛选|设置|查看)/u.test(segment)
          ? 1
          : 0)
    : 0;
  const commandEvidence =
    isInstallationOrSetupQuestion(question) &&
    /(?:^|\s)(?:\/plugin\b|git\s+clone\b|(?:npm|pnpm|yarn)\s+(?:add|install)\b|clawhub\s+install\b)/iu.test(
      segment,
    )
      ? 3
      : 0;
  return tokenMatches + structuredEvidence + commandEvidence;
}

function isStructuredAnswerQuestion(question: string): boolean {
  return /什么(?!时候)|哪些|哪几|有什么|有啥|啥|多少|字段|参数|选项|包括|列表|区域|类型|条件/u.test(
    question,
  );
}

function requiresDetailedOperationalEvidence(question: string): boolean {
  return /具体步骤|第[一二三四五六七八九十\d]+步|iphone|safari|分享按钮|二维码|验证码|add\s+to\s+home\s+screen|添加到主屏幕/iu.test(
    question,
  );
}

function shouldPreferAuthoredTitleAnchor(question: string): boolean {
  return /哪些|哪几|有什么|有啥|啥|字段|参数|选项|包括|列表|区域|类型|条件/u.test(question);
}

function isInstallationOrSetupQuestion(question: string): boolean {
  return /安装|配置|设置|部署|接入|install|setup|set\s+up|configure|configuration|deploy/iu.test(
    question,
  );
}

function selectStructuredGroundingChunks(
  question: string,
  chunks: RetrievedChunk[],
): RetrievedChunk[] {
  const firstChunk = chunks[0];
  if (firstChunk === undefined) {
    return [];
  }
  const queryTokens = meaningfulAnswerTokens(question);
  const preferredAuthoredAnchor = shouldPreferAuthoredTitleAnchor(question)
    ? chunks.find(
        (chunk) =>
          isAuthoredOfficialKnowledgeChunk(chunk) &&
          titleMatchesQuestion(chunk.metadata.title, question),
      )
    : undefined;
  const anchorChunk =
    preferredAuthoredAnchor ??
    chunks
      .map((chunk) => ({
        chunk,
        score:
          groundingEvidenceStrength(chunk, question, queryTokens, undefined) +
          reciprocalGroundingRank(chunk.rank) * 2,
      }))
      .sort((left, right) => right.score - left.score || left.chunk.rank - right.chunk.rank)[0]
      ?.chunk ??
    firstChunk;
  const anchorDocumentId =
    chunks.filter((chunk) => chunk.documentId === anchorChunk.documentId).length > 1
      ? anchorChunk.documentId
      : undefined;
  const scored = chunks
    .filter((chunk) => chunk.id !== anchorChunk.id)
    .map((chunk) => ({
      chunk,
      score: groundingEvidenceStrength(chunk, question, queryTokens, anchorDocumentId),
    }))
    .filter((candidate) => candidate.score > 0);
  const sameDocumentCandidates =
    anchorDocumentId === undefined
      ? []
      : scored.filter((candidate) => candidate.chunk.documentId === anchorDocumentId);
  if (sameDocumentCandidates.length > 0 && !requiresMultipleGroundingSources(question)) {
    const orderedSameDocumentChunks = sameDocumentCandidates
      .sort((left, right) => right.score - left.score || left.chunk.rank - right.chunk.rank)
      .map((candidate) => candidate.chunk);
    return (
      /功能目录页|具体说明见/u.test(anchorChunk.text)
        ? orderedSameDocumentChunks
        : [anchorChunk, ...orderedSameDocumentChunks]
    ).slice(0, MAX_STRUCTURED_GROUNDING_CHUNKS);
  }
  const remaining = scored
    .sort((left, right) => {
      const rightScore = right.score + reciprocalGroundingRank(right.chunk.rank);
      const leftScore = left.score + reciprocalGroundingRank(left.chunk.rank);
      return rightScore - leftScore || left.chunk.rank - right.chunk.rank;
    })
    .map((candidate) => candidate.chunk)
    .slice(0, MAX_STRUCTURED_GROUNDING_CHUNKS - 1);
  return [anchorChunk, ...remaining];
}

function groundingEvidenceStrength(
  chunk: RetrievedChunk,
  question: string,
  queryTokens: string[],
  anchorDocumentId: string | undefined,
): number {
  const titleMatch = titleMatchesQuestion(chunk.metadata.title, question) ? 2 : 0;
  const evidenceTokens = new Set(tokenize(chunk.text));
  const contentMatches = queryTokens.filter((token) => evidenceTokens.has(token)).length;
  const isRequestedSiblingSection =
    anchorDocumentId !== undefined &&
    chunk.documentId === anchorDocumentId &&
    /区域|部分|模块|各自|分别/u.test(question);
  if (titleMatch === 0 && contentMatches === 0 && !isRequestedSiblingSection) {
    return 0;
  }

  const definitionBonus =
    /什么|区域|类型|分类|含义/u.test(question) && /是指|分为/u.test(chunk.text) ? 4 : 0;
  const quantityAnswerBonus =
    /多少|最多|上限|几条|几个|秒级/u.test(question) &&
    /\d[\d,. ]*\s*(?:秒|个|条|种|项|钱包|地址|链)/u.test(chunk.text)
      ? 6
      : 0;
  const timelineAnswerBonus =
    /什么时候|何时|哪年|哪月|哪天|开放时间|发布时间|发布日期/u.test(question) &&
    /(?:19|20)\d{2}(?:\s*年|[-/]\d{1,2})?/u.test(chunk.text)
      ? 5
      : 0;
  const listAnswerBonus =
    /哪些|哪几|有啥|啥|字段|参数|选项|列表|区域|类型|条件/u.test(question) &&
    (chunk.text.match(/[、，,；;：:]|(?:^|\s)[-*]|\d+[.)、]/gu)?.length ?? 0) >= 2
      ? 3
      : 0;
  const documentCoherenceBonus =
    anchorDocumentId !== undefined && chunk.documentId === anchorDocumentId ? 4 : 0;
  return (
    titleMatch +
    contentMatches +
    evidenceSegmentScore(chunk.text, queryTokens, question) +
    definitionBonus +
    quantityAnswerBonus +
    timelineAnswerBonus +
    listAnswerBonus +
    documentCoherenceBonus
  );
}

function titleMatchesQuestion(title: string, question: string): boolean {
  const normalizedQuestion = normalizeForEvidenceMatch(
    createSemanticRetrieveQuery(question),
  ).replace(/\s+/gu, '');
  const normalizedTitle = normalizeForEvidenceMatch(title).replace(/\s+/gu, '');
  return normalizedTitle.length >= 2 && normalizedQuestion.includes(normalizedTitle);
}

function reciprocalGroundingRank(rank: number): number {
  return Number.isInteger(rank) && rank > 0 ? 1 / rank : 0;
}

function extractStandardCustomerAnswer(text: string): string | undefined {
  const match = /标准客服回答：(?<answer>.*?)(?:用户问|演示视频：|\n{2,}|$)/su.exec(text);
  const answer = match?.groups?.answer?.trim();
  return answer === undefined || answer.length === 0 ? undefined : answer;
}

function insufficientKnowledgeText(question: string): string {
  const supportEntity = supportEntityDisplayName(question);
  if (supportEntity !== undefined) {
    return `当前知识库没有明确说明 XXYY 支持 ${supportEntity}，不能确认已支持。`;
  }

  return `当前知识库没有找到与「${question}」直接相关的资料，不能确认。`;
}

function supportEntityDisplayName(question: string): string | undefined {
  const supportEntities = extractSupportEntityTokens(question);
  if (supportEntities.length > 1) {
    return `${supportEntities.join(' 与 ')} 的组合`;
  }

  const normalizedQuestion = question.normalize('NFKC');
  const supportMatch =
    /(?:是否支持|当前支持|现在支持|支持)\s*(?<entity>[#$]?[a-z0-9][a-z0-9._-]*)/iu.exec(
      normalizedQuestion,
    ) ?? /\bsupport(?:s|ed)?\s+(?<entity>[#$]?[a-z0-9][a-z0-9._-]*)/iu.exec(normalizedQuestion);
  const entity = supportMatch?.groups?.entity?.trim();
  if (entity !== undefined && entity.length > 0 && isSupportEntityToken(entity.toLowerCase())) {
    return entity;
  }

  return extractSupportEntityTokens(question)[0];
}

function calculateGroundedConfidence(classificationConfidence: number, topScore: number): number {
  const scoreConfidence = Math.min(0.25, topScore / 10);
  return Number(
    Math.min(0.95, Math.max(0.55, classificationConfidence * 0.75 + scoreConfidence)).toFixed(2),
  );
}
