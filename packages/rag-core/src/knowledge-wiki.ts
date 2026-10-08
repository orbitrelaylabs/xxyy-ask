import { createHash } from 'node:crypto';

import { createLocalHashEmbedding, tokenize } from '@xxyy/knowledge';
import { chatAttachmentSchema, type RagChunk, type RagIndex } from '@xxyy/shared';
import { z } from 'zod';

import { classifyQuestion } from './classify.js';
import { validateAnswerGrounding } from './grounding-validation.js';
import { sanitizeUntrustedKnowledgeText } from './knowledge-content-safety.js';
import { createProductRetrievalPolicy, understandProductQuestion } from './product-question.js';
import {
  createLocalRetriever,
  createMetadataReranker,
  createRerankingRetriever,
} from './retriever.js';
import type { RetrievedChunk, WikiNavigation } from './retrieve.js';

export const WIKI_COMPILER_VERSION = 'product-wiki-v1';
export const WIKI_MAX_BYTES = 8 * 1024 * 1024;
export const WIKI_MAX_SOURCE_CHUNKS = 24;

export const wikiTopics = [
  {
    id: 'pro-benefits',
    title: 'XXYY Pro 权益与限制',
    query: 'XXYY Pro 各等级会员有哪些权益和限制？',
  },
  { id: 'trading-modes', title: '交易模式比较', query: 'XXYY 不同交易模式有什么区别和使用限制？' },
  {
    id: 'wallet-monitor',
    title: '钱包监控',
    query: 'XXYY 钱包监控支持哪些功能、地址数量和通知设置？',
  },
  {
    id: 'chain-support',
    title: '公链与功能支持范围',
    query: 'XXYY 当前支持哪些公链，各项功能支持哪些链？',
  },
  { id: 'launchpads', title: '各链发射平台', query: 'XXYY 当前各条链支持哪些发射平台？' },
] as const;

const topicIdSchema = z.enum([
  'pro-benefits',
  'trading-modes',
  'wallet-monitor',
  'chain-support',
  'launchpads',
]);
const boundedText = z.string().trim().min(1).max(1000);
const sourceSchema = z
  .object({
    id: z.string().min(1).max(500),
    documentId: z.string().min(1).max(500),
    text: z.string().min(1).max(32_000),
    metadata: z
      .object({
        title: z.string().max(1000),
        module: z.string().max(1000),
        sourceType: z.enum(['official_docs', 'x_updates', 'admin_verified']),
        file: z.string().max(1000),
        headingPath: z.array(z.string().max(1000)).max(30),
        attachments: z.array(chatAttachmentSchema).max(30).optional(),
        sourceUrl: z.string().max(2000).optional(),
        order: z.number().optional(),
        effectiveAt: z.string().optional(),
        retrievedAt: z.string().optional(),
        status: z.enum(['current', 'historical', 'deprecated']).optional(),
        supersedes: z.array(z.string().max(500)).max(100).optional(),
      })
      .strict(),
  })
  .strict()
  .transform((source) => {
    // JSON artifacts cannot carry explicit undefined; normalize Zod's optional
    // fields to the repository's exact-optional RagChunk contract, including media.
    return JSON.parse(JSON.stringify(source)) as RagChunk;
  });

export const wikiSnapshotSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{32}$/u),
    chunks: z.array(sourceSchema).max(10_000),
  })
  .strict();

export const wikiProposalSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            text: boundedText,
            evidence: z
              .array(z.object({ chunkId: z.string().min(1).max(500), quote: boundedText }).strict())
              .min(1)
              .max(4),
          })
          .strict(),
      )
      .min(1)
      .max(12),
    relatedTopics: z.array(topicIdSchema).max(4),
  })
  .strict();

const wikiPageSchema = wikiProposalSchema.extend({
  id: topicIdSchema,
  title: boundedText,
  query: boundedText,
});

export const wikiBundleSchema = z
  .object({
    version: z.literal(1),
    compilerVersion: z.literal(WIKI_COMPILER_VERSION),
    model: z.string().min(1).max(200),
    builtAt: z.iso.datetime(),
    corpusRevision: z.string().regex(/^[a-f0-9]{32}$/u),
    pages: z.array(wikiPageSchema).min(1).max(wikiTopics.length),
    sources: z
      .array(sourceSchema)
      .min(1)
      .max(wikiTopics.length * WIKI_MAX_SOURCE_CHUNKS),
  })
  .strict();

export const publishedWikiSchema = z
  .object({
    version: z.literal(1),
    publishedAt: z.iso.datetime(),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/u),
    bundle: wikiBundleSchema,
    gate: z
      .object({
        version: z.literal('wiki-publication-v1'),
        goldenCaseCount: z.number().int().positive(),
        passed: z.literal(true),
      })
      .strict(),
  })
  .strict();

export type WikiTopic = (typeof wikiTopics)[number];
export type WikiSnapshot = z.infer<typeof wikiSnapshotSchema>;
export type WikiProposal = z.infer<typeof wikiProposalSchema>;
export type WikiBundle = z.infer<typeof wikiBundleSchema>;
export type PublishedWiki = z.infer<typeof publishedWikiSchema>;
export interface WikiCompilerModel {
  name: string;
  compile(topic: WikiTopic, sources: RagChunk[]): Promise<unknown>;
}

export function createWikiEvidenceIndex(chunks: readonly RagChunk[]): RagIndex {
  return {
    version: 1,
    builtAt: new Date(0).toISOString(),
    entries: chunks.map((chunk) => {
      const text = [
        chunk.metadata.title,
        chunk.metadata.module,
        ...chunk.metadata.headingPath,
        chunk.text,
      ].join('\n');
      return { ...chunk, tokens: tokenize(text), embedding: createLocalHashEmbedding(text) };
    }),
  };
}

export async function planWikiTopics(
  snapshot: WikiSnapshot,
): Promise<Array<{ topic: WikiTopic; sources: RagChunk[] }>> {
  const safeChunks = selectWikiSources(snapshot);
  const retriever = createRerankingRetriever(
    createLocalRetriever(createWikiEvidenceIndex(safeChunks)),
    createMetadataReranker(),
  );
  const result: Array<{ topic: WikiTopic; sources: RagChunk[] }> = [];
  for (const topic of wikiTopics) {
    const understanding = understandProductQuestion(topic.query, classifyQuestion(topic.query));
    const sources = await retriever.retrieve(topic.query, {
      policy: createProductRetrievalPolicy(understanding),
      topK: WIKI_MAX_SOURCE_CHUNKS,
    });
    let inputCharacters = 0;
    const boundedSources = sources
      .map(({ id, documentId, text, metadata }) => ({ id, documentId, text, metadata }))
      .filter((source) => {
        inputCharacters += JSON.stringify(source).length;
        return inputCharacters <= 48_000;
      });
    result.push({ topic, sources: boundedSources });
  }
  return result;
}

export async function compileWiki(
  snapshot: WikiSnapshot,
  model: WikiCompilerModel,
): Promise<WikiBundle> {
  const plans = await planWikiTopics(snapshot);
  const pages: WikiBundle['pages'] = [];
  const sources = new Map<string, RagChunk>();
  for (const { topic, sources: candidates } of plans) {
    if (candidates.length === 0) continue;
    const proposal = wikiProposalSchema.parse(await model.compile(topic, candidates));
    const page = { ...proposal, ...topic };
    validateWikiPage(page, new Map(candidates.map((chunk) => [chunk.id, chunk])));
    pages.push(page);
    for (const id of page.claims.flatMap((claim) => claim.evidence.map((item) => item.chunkId))) {
      const source = candidates.find((chunk) => chunk.id === id);
      if (source !== undefined) sources.set(id, source);
    }
  }
  const pageIds = new Set(pages.map((page) => page.id));
  for (const page of pages) page.relatedTopics = page.relatedTopics.filter((id) => pageIds.has(id));
  return validateWikiBundle({
    version: 1,
    compilerVersion: WIKI_COMPILER_VERSION,
    model: model.name,
    builtAt: new Date().toISOString(),
    corpusRevision: snapshot.revision,
    pages,
    sources: [...sources.values()],
  });
}

export function validateWikiBundle(value: unknown, snapshot?: WikiSnapshot): WikiBundle {
  const bundle = wikiBundleSchema.parse(value);
  if (snapshot !== undefined && snapshot.revision !== bundle.corpusRevision)
    throw new Error('wiki_source_revision_changed');
  const sources = new Map(bundle.sources.map((source) => [source.id, source]));
  const liveSources =
    snapshot === undefined
      ? undefined
      : new Map(selectWikiSources(snapshot).map((source) => [source.id, source]));
  if (sources.size !== bundle.sources.length) throw new Error('wiki_duplicate_source');
  for (const source of bundle.sources) {
    if (!isWikiSourceEligible(source)) throw new Error('wiki_ineligible_source');
    if (
      liveSources !== undefined &&
      wikiSourceHash(source) !== wikiSourceHash(liveSources.get(source.id))
    )
      throw new Error('wiki_source_changed');
  }
  const pageIds = new Set(bundle.pages.map((page) => page.id));
  if (pageIds.size !== bundle.pages.length) throw new Error('wiki_duplicate_page');
  const usedSources = new Set<string>();
  for (const page of bundle.pages) {
    validateWikiPage(page, sources);
    if (page.relatedTopics.some((id) => !pageIds.has(id) || id === page.id))
      throw new Error('wiki_invalid_link');
    page.claims.forEach((claim) => claim.evidence.forEach((item) => usedSources.add(item.chunkId)));
  }
  if (usedSources.size !== sources.size) throw new Error('wiki_unused_source');
  return bundle;
}

function validateWikiPage(page: WikiBundle['pages'][number], sources: Map<string, RagChunk>): void {
  const topic = wikiTopics.find((item) => item.id === page.id);
  if (topic === undefined || topic.title !== page.title || topic.query !== page.query)
    throw new Error('wiki_invalid_topic');
  for (const claim of page.claims) {
    if (
      sanitizeUntrustedKnowledgeText(claim.text).detected ||
      /https?:|javascript:|file:/iu.test(claim.text)
    )
      throw new Error('wiki_unsafe_claim');
    const evidence: RetrievedChunk[] = claim.evidence.map((item, index) => {
      const source = sources.get(item.chunkId);
      if (source === undefined || item.quote.length < 8 || !source.text.includes(item.quote))
        throw new Error('wiki_invalid_evidence');
      // Validate against the cited quotation, not an unrelated sentence elsewhere in the source.
      return {
        ...source,
        text: item.quote,
        tokens: [],
        embedding: [],
        rank: index + 1,
        score: 1,
        lexicalScore: 1,
        vectorScore: 0,
        sourceBoost: 0,
      };
    });
    const grounding = validateAnswerGrounding(claim.text, page.query, evidence);
    if (
      !grounding.grounded ||
      grounding.criticalClaimCount === 0 ||
      grounding.supportedChunkIds.length === 0
    )
      throw new Error('wiki_ungrounded_claim');
  }
}

export function isWikiSourceEligible(source: RagChunk): boolean {
  if (source.metadata.status !== 'current') return false;
  if (
    [
      source.text,
      source.metadata.title,
      source.metadata.module,
      ...source.metadata.headingPath,
    ].some((value) => sanitizeUntrustedKnowledgeText(value).detected)
  )
    return false;
  if (source.metadata.sourceType === 'admin_verified') return true;
  try {
    const url = new URL(source.metadata.sourceUrl ?? '');
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      ((source.metadata.sourceType === 'official_docs' && url.origin === 'https://docs.xxyy.io') ||
        (source.metadata.sourceType === 'x_updates' &&
          url.origin === 'https://x.com' &&
          /^\/useXXYYio\/status\/\d+$/u.test(url.pathname)))
    );
  } catch {
    return false;
  }
}

function selectWikiSources(snapshot: WikiSnapshot): RagChunk[] {
  const superseded = new Set(
    snapshot.chunks
      .filter((source) => source.metadata.status === 'current')
      .flatMap((source) => source.metadata.supersedes ?? []),
  );
  return snapshot.chunks.filter(
    (source) =>
      isWikiSourceEligible(source) &&
      !superseded.has(source.id) &&
      !superseded.has(source.documentId),
  );
}

export function wikiSourceHash(source: RagChunk | undefined): string {
  if (source === undefined) return '';
  const { retrievedAt: _retrievedAt, ...metadata } = source.metadata;
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: source.id,
        documentId: source.documentId,
        text: source.text,
        metadata: Object.fromEntries(
          Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }),
    )
    .digest('hex');
}

export function wikiBundleHash(bundle: WikiBundle): string {
  return createHash('sha256')
    .update(JSON.stringify(wikiBundleSchema.parse(bundle)))
    .digest('hex');
}

const MATCH_STOP_TOKENS = new Set([
  'xxyy',
  '当前',
  '现在',
  '哪些',
  '什么',
  '支持',
  '如何',
  '功能',
  '可以',
  '使用',
]);

export function findWikiNavigation(
  question: string,
  bundle: WikiBundle,
): WikiNavigation | undefined {
  const queryTokens = new Set(tokenize(question).filter((token) => !MATCH_STOP_TOKENS.has(token)));
  const pages = bundle.pages
    .map((page) => {
      const tokens = new Set(
        tokenize(
          `${page.title}\n${page.query}\n${page.claims.map((claim) => claim.text).join('\n')}`,
        ),
      );
      const score =
        [...queryTokens].filter((token) => tokens.has(token)).length /
        Math.max(1, queryTokens.size);
      return { page, score };
    })
    .filter(({ score }) => score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  const chunkIds = [
    ...new Set(
      pages.flatMap(({ page }) =>
        page.claims.flatMap((claim) => claim.evidence.map((item) => item.chunkId)),
      ),
    ),
  ].slice(0, 24);
  return chunkIds.length === 0 ? undefined : { corpusRevision: bundle.corpusRevision, chunkIds };
}

export function renderWikiPage(page: WikiBundle['pages'][number], bundle: WikiBundle): string {
  const sources = new Map(bundle.sources.map((source) => [source.id, source]));
  const lines = [
    `# ${page.title}`,
    '',
    '> LLM 整理的派生导航页。事实依据是下列原始证据；不得作为新的官方来源入库。',
    '',
    `知识版本：${bundle.corpusRevision}`,
    `编译时间：${bundle.builtAt}`,
    '',
  ];
  for (const claim of page.claims) {
    lines.push(claim.text, '');
    for (const item of claim.evidence) {
      const source = sources.get(item.chunkId)!;
      lines.push(
        `- 证据：\`${item.chunkId}\`（${source.metadata.sourceType}；${source.metadata.effectiveAt ?? '未标注生效时间'}）`,
        `  > ${item.quote.replaceAll('\n', '\n  > ')}`,
      );
      if (source.metadata.sourceUrl !== undefined)
        lines.push(`  [原始来源](<${source.metadata.sourceUrl}>)`);
    }
    lines.push('');
  }
  if (page.relatedTopics.length > 0)
    lines.push(
      '相关主题：',
      '',
      ...page.relatedTopics.map(
        (id) => `- [${wikiTopics.find((topic) => topic.id === id)!.title}](${id}.md)`,
      ),
      '',
    );
  return lines.join('\n');
}
