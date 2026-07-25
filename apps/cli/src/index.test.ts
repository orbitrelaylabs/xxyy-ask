import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { CreateCustomerAgentChatServiceOptions } from '@xxyy/agent-core';
import type { PreparedKnowledgeChunk } from '@xxyy/knowledge';
import type { EmbeddedKnowledgeChunk, KnowledgeCandidate, KnowledgeStats } from '@xxyy/rag-core';
import { createInMemoryQualityTracer } from '@xxyy/rag-core';
import type { SourceDocument } from '@xxyy/shared';

import {
  createDefaultCliIo,
  collectEvaluationTraceObservation,
  formatChatResponse,
  formatAdminVerifiedKnowledgeDocument,
  formatEvaluationReport,
  formatFeedbackEvalBacklog,
  formatIngestSummary,
  formatKnowledgeCandidateList,
  formatKnowledgePublicationSummary,
  formatKnowledgeStats,
  formatMigrationSummary,
  formatProviderRetrievalReport,
  formatSyncXUpdatesSummary,
  formatTelegramKnowledgeImportSummary,
  parseCliArgs,
  resolveWorkspaceCwd,
  runCli,
} from './index.js';

describe('parseCliArgs', () => {
  it('parses ask questions with or without a separator', () => {
    expect(parseCliArgs(['ask', '--', 'XXYY Pro 有哪些权益？'])).toEqual({
      command: 'ask',
      debugRetrieve: false,
      question: 'XXYY Pro 有哪些权益？',
    });
    expect(parseCliArgs(['ask', 'XXYY Pro', '有哪些权益？'])).toEqual({
      command: 'ask',
      debugRetrieve: false,
      question: 'XXYY Pro 有哪些权益？',
    });
    expect(parseCliArgs(['ask', '--', '--debug-retrieve', '当前支持robinhood么'])).toEqual({
      command: 'ask',
      debugRetrieve: true,
      question: '当前支持robinhood么',
    });
  });

  it('parses retained commands that do not require extra arguments', () => {
    expect(parseCliArgs(['ingest'])).toEqual({
      command: 'ingest',
      rebuildEmbeddingSchema: false,
    });
    expect(parseCliArgs(['ingest', '--', '--rebuild-embedding-schema'])).toEqual({
      command: 'ingest',
      rebuildEmbeddingSchema: true,
    });
    expect(parseCliArgs(['migrate'])).toEqual({ command: 'migrate' });
    expect(parseCliArgs(['stats'])).toEqual({ command: 'stats' });
    expect(parseCliArgs(['sync:x'])).toEqual({ command: 'sync:x' });
    expect(parseCliArgs(['feedback:backlog'])).toEqual({ command: 'feedback:backlog' });
    expect(parseCliArgs(['evaluate'])).toEqual({
      command: 'evaluate',
      judge: false,
      providerBacked: false,
      retrievalOnly: false,
    });
    expect(parseCliArgs(['evaluate', '--provider'])).toEqual({
      command: 'evaluate',
      judge: false,
      providerBacked: true,
      retrievalOnly: false,
    });
    expect(
      parseCliArgs(['evaluate', '--provider', '--judge', '--failures-out', '.rag/failures.jsonl']),
    ).toEqual({
      command: 'evaluate',
      failuresOut: '.rag/failures.jsonl',
      judge: true,
      providerBacked: true,
      retrievalOnly: false,
    });
    expect(parseCliArgs(['evaluate', '--provider', '--retrieval-only'])).toEqual({
      command: 'evaluate',
      judge: false,
      providerBacked: true,
      retrievalOnly: true,
    });
  });

  it('parses controlled knowledge evolution commands', () => {
    expect(
      parseCliArgs([
        'knowledge:import:telegram',
        '--',
        'group.json',
        '--agent',
        '--admin-id',
        '123',
        '--admin-id',
        '456',
      ]),
    ).toEqual({
      adminUserIds: ['123', '456'],
      command: 'knowledge:import:telegram',
      curationMode: 'required',
      file: 'group.json',
    });
    expect(parseCliArgs(['knowledge:import:telegram', 'group.json'])).toEqual({
      adminUserIds: [],
      command: 'knowledge:import:telegram',
      curationMode: 'auto',
      file: 'group.json',
    });
    expect(
      parseCliArgs(['knowledge:import:telegram', 'group.json', '--curation-mode', 'deterministic']),
    ).toEqual({
      adminUserIds: [],
      command: 'knowledge:import:telegram',
      curationMode: 'deterministic',
      file: 'group.json',
    });
    expect(parseCliArgs(['knowledge:list', '--status', 'pending', '--limit', '10'])).toEqual({
      command: 'knowledge:list',
      limit: 10,
      status: 'pending',
    });
    expect(
      parseCliArgs([
        'knowledge:approve',
        'knowledge_candidate_1',
        '--reviewer',
        'telegram:123',
        '--effective-at',
        '2026-07-15',
        '--source-url',
        'https://docs.example.com/feature',
        '--supersedes',
        'official_docs:old,official_docs:older',
      ]),
    ).toEqual({
      command: 'knowledge:approve',
      effectiveAt: '2026-07-15',
      id: 'knowledge_candidate_1',
      reviewedBy: 'telegram:123',
      sourceUrl: 'https://docs.example.com/feature',
      supersedes: ['official_docs:old', 'official_docs:older'],
    });
    expect(
      parseCliArgs([
        'knowledge:reject',
        'knowledge_candidate_1',
        '--reviewer',
        'telegram:123',
        '--note',
        '证据不足',
      ]),
    ).toEqual({
      command: 'knowledge:reject',
      id: 'knowledge_candidate_1',
      note: '证据不足',
      reviewedBy: 'telegram:123',
    });
    expect(parseCliArgs(['knowledge:publish', 'knowledge_candidate_1'])).toEqual({
      command: 'knowledge:publish',
      id: 'knowledge_candidate_1',
    });
    expect(
      parseCliArgs([
        'knowledge:automation:work',
        '--',
        '--limit',
        '5',
        '--worker-id',
        'worker:one',
      ]),
    ).toEqual({
      command: 'knowledge:automation:work',
      limit: 5,
      workerId: 'worker:one',
    });
    expect(parseCliArgs(['knowledge:publication:work'])).toEqual({
      command: 'knowledge:publication:work',
    });
    expect(parseCliArgs(['knowledge:publication:work', '--', '--worker-id', 'worker:one'])).toEqual(
      {
        command: 'knowledge:publication:work',
        workerId: 'worker:one',
      },
    );
    expect(
      parseCliArgs([
        'knowledge:author:trust',
        '--chat-id',
        '-100123',
        '--user-id',
        '123',
        '--role',
        'knowledge_editor',
        '--valid-from',
        '2026-07-01',
        '--valid-to',
        '2026-08-01',
        '--reviewer',
        'operator:alice',
      ]),
    ).toEqual({
      chatId: '-100123',
      command: 'knowledge:author:trust',
      role: 'knowledge_editor',
      userId: '123',
      validFrom: '2026-07-01',
      validTo: '2026-08-01',
      verificationSource: 'manual',
      verifiedBy: 'operator:alice',
    });
    expect(
      parseCliArgs(['knowledge:author:list', '--chat-id', '-100123', '--active-at', '2026-07-15']),
    ).toEqual({
      activeAt: '2026-07-15',
      chatId: '-100123',
      command: 'knowledge:author:list',
      limit: 100,
    });
    expect(parseCliArgs(['knowledge:history', 'knowledge_candidate_1'])).toEqual({
      command: 'knowledge:history',
      id: 'knowledge_candidate_1',
    });
    expect(
      parseCliArgs([
        'knowledge:revise',
        'knowledge_candidate_1',
        '--editor',
        'operator:alice',
        '--answer',
        '修订后的答案',
        '--reason',
        '补充限制',
      ]),
    ).toEqual({
      canonicalAnswer: '修订后的答案',
      command: 'knowledge:revise',
      editedBy: 'operator:alice',
      id: 'knowledge_candidate_1',
      reason: '补充限制',
    });
  });

  it('allows automatic Telegram roles but still requires explicit reviewer identity', () => {
    expect(parseCliArgs(['knowledge:import:telegram', 'group.json'])).toEqual({
      adminUserIds: [],
      command: 'knowledge:import:telegram',
      curationMode: 'auto',
      file: 'group.json',
    });
    expect(parseCliArgs(['knowledge:approve', 'knowledge_candidate_1'])).toMatchObject({
      command: 'help',
      error: '--reviewer is required.',
    });
  });

  it('rejects unsafe or inconsistent evaluation options', () => {
    expect(parseCliArgs(['evaluate', '--judge'])).toMatchObject({
      command: 'help',
      error: '--judge requires --provider.',
    });
    expect(parseCliArgs(['evaluate', '--retrieval-only'])).toMatchObject({
      command: 'help',
      error: '--retrieval-only requires --provider.',
    });
    expect(parseCliArgs(['evaluate', '--provider', '--retrieval-only', '--judge'])).toMatchObject({
      command: 'help',
      error: '--judge cannot be used with --retrieval-only.',
    });
    expect(parseCliArgs(['evaluate', '--failures-out'])).toMatchObject({
      command: 'help',
      error: 'Missing path for --failures-out.',
    });
    expect(parseCliArgs(['evaluate', '--failures-out', '../failures.jsonl'])).toMatchObject({
      command: 'help',
      error: '--failures-out must be a file under .rag/.',
    });
    expect(parseCliArgs(['evaluate', '--unknown'])).toMatchObject({
      command: 'help',
      error: 'Unknown rag:evaluate option: --unknown',
    });
  });

  it('rejects unknown commands', () => {
    expect(parseCliArgs(['unknown'])).toEqual({
      command: 'help',
      error: 'Unknown command: unknown',
    });
  });
});

function xChunk(overrides: Partial<PreparedKnowledgeChunk> = {}): PreparedKnowledgeChunk {
  return {
    contentHash: 'hash-1',
    documentId: 'x-doc',
    id: 'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
    metadata: {
      file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
      headingPath: ['X Post 1', 'Text'],
      module: 'X Updates',
      sourceType: 'x_updates',
      title: 'X Post 1',
    },
    searchableText: 'X Post 1\nXXYY update',
    text: 'XXYY update',
    tokens: ['xxyy', 'update'],
    ...overrides,
  };
}

describe('resolveWorkspaceCwd', () => {
  it('prefers pnpm INIT_CWD when filtered scripts run inside an app package', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-cli-root-'));
    const appCwd = path.join(workspaceRoot, 'apps', 'cli');
    await mkdir(path.join(workspaceRoot, 'docs', 'product-features'), { recursive: true });
    await mkdir(appCwd, { recursive: true });

    expect(resolveWorkspaceCwd(appCwd, { INIT_CWD: workspaceRoot })).toBe(workspaceRoot);
  });
});

describe('createDefaultCliIo', () => {
  it('loads workspace .env values without overriding shell env', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-cli-env-'));
    await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    await writeFile(
      path.join(workspaceRoot, '.env'),
      [
        'POSTGRES_DB=xxyy_ask',
        'POSTGRES_HOST=localhost',
        'POSTGRES_PORT=5432',
        'POSTGRES_USER=xxyy',
        'POSTGRES_PASSWORD=from_file',
        'OPENAI_MODEL=openrouter/free',
      ].join('\n'),
    );

    const io = createDefaultCliIo({
      cwd: workspaceRoot,
      env: {
        POSTGRES_PASSWORD: 'from_shell',
      },
      stderr: { write: () => true },
      stdout: { write: () => true },
    });

    expect(io.env.POSTGRES_DB).toBe('xxyy_ask');
    expect(io.env.POSTGRES_PASSWORD).toBe('from_shell');
    expect(io.env.OPENAI_MODEL).toBe('openrouter/free');
  });
});

describe('CLI output formatting', () => {
  it('formats candidate import, review lists, and publication summaries', () => {
    const candidate = createKnowledgeCandidate();

    expect(
      formatTelegramKnowledgeImportSummary({
        agentCandidateCount: 1,
        agentRunStats: {
          attemptedThreadCount: 2,
          eligibleThreadCount: 3,
          failedThreadCount: 1,
          failureCounts: {
            invalid_output: 1,
            provider_error: 0,
            timeout: 0,
            unknown: 0,
          },
          modelAvailable: true,
          skippedBudgetThreadCount: 1,
          skippedByModeThreadCount: 0,
          skippedUnavailableThreadCount: 0,
          succeededThreadCount: 1,
        },
        adminReplyCount: 4,
        automation: {
          approvedCount: 1,
          decisions: [],
          policyVersion: 'knowledge-automation-v1',
          publicationQueuedCount: 1,
          rejectedCount: 0,
        },
        candidateCount: 2,
        createdCount: 1,
        curationMode: 'auto',
        deterministicCandidateCount: 1,
        duplicateCount: 1,
        messageCount: 12,
        rejectedAgentProposalCount: 0,
        runId: 'curator_run_1',
        skippedBoundaryCount: 1,
        skippedMissingReplyCount: 1,
        threadCount: 5,
        unverifiedAuthorMessageCount: 8,
        verifiedAuthorMessageCount: 4,
      }),
    ).toContain('Automation knowledge-automation-v1: 1 approved, 0 rejected');
    expect(formatKnowledgeCandidateList([candidate])).toContain(candidate.id);
    expect(
      formatKnowledgePublicationSummary({
        alreadyPublished: false,
        candidateId: candidate.id,
        documentId: `admin_verified:admin-verified/${candidate.id}`,
        file: `/tmp/${candidate.id}.md`,
        jobId: 'knowledge_publication_1',
        runId: 'ingest_run_1',
      }),
    ).toContain('Ingestion run: ingest_run_1');

    const document = formatAdminVerifiedKnowledgeDocument(candidate);
    expect(document).toContain('section: "XXYY 客服群审核知识"');
    expect(document).toContain('title: "XXYY 支持 Robinhood 吗？"');
    expect(document).toContain('effective_at: "2026-07-15T00:00:00.000Z"');
    expect(document).toContain('source_url: "https://docs.example.com/robinhood"');
    expect(document).toContain('supersedes: ["official_docs:old-robinhood"]');
    expect(document).toContain('## 标准答案\n\n是的，XXYY 已支持 Robinhood。');
  });

  it('collects ordered tool and retrieval observations from one request trace tree', async () => {
    const { records, tracer } = createInMemoryQualityTracer();
    await tracer.run(
      {
        metadata: { requestId: 'eval:case-1' },
        name: 'chat.request',
        runType: 'chain',
      },
      () =>
        tracer.run(
          {
            metadata: { toolName: 'search_product_docs' },
            name: 'agent.tool',
            runType: 'tool',
          },
          () =>
            tracer.run(
              {
                name: 'rag.metadata_rerank',
                output: () => ({ chunks: [{ id: 'chunk-current' }] }),
                runType: 'retriever',
              },
              () => Promise.resolve([]),
            ),
        ),
    );

    expect(collectEvaluationTraceObservation(records, 'eval:case-1')).toEqual({
      retrievedChunkIds: ['chunk-current'],
      toolNames: ['search_product_docs'],
    });
    expect(collectEvaluationTraceObservation(records, 'eval:missing')).toEqual({
      retrievedChunkIds: [],
      toolNames: [],
    });
  });

  it('formats chat responses with readable citations and attachments', () => {
    expect(
      formatChatResponse({
        answer: '根据知识库，XXYY Pro 提供更多权益。',
        attachments: [
          {
            kind: 'video',
            mediaType: 'video/mp4',
            title: '添加到桌面演示',
            url: '/assets/xxyy-add-to-home.mp4',
          },
        ],
        confidence: 0.82,
        intent: 'product_qa',
        citations: [
          {
            title: 'XXYY Pro 权益',
            file: 'docs/product-features/pages/pro.md',
            sourceUrl: 'https://docs.xxyy.io/pro',
            excerpt: 'Pro 用户可以使用更多产品权益。',
          },
        ],
      }),
    ).toContain(
      [
        '根据知识库，XXYY Pro 提供更多权益。',
        '',
        'Intent: product_qa (confidence 0.82)',
        '',
        'Citations:',
        '[1] XXYY Pro 权益',
        '    docs/product-features/pages/pro.md',
        '    https://docs.xxyy.io/pro',
        '    Pro 用户可以使用更多产品权益。',
        '',
        'Attachments:',
        '[1] 添加到桌面演示',
        '    /assets/xxyy-add-to-home.mp4',
      ].join('\n'),
    );
  });

  it('formats image attachments for product knowledge responses', () => {
    expect(
      formatChatResponse({
        answer: '产品功能截图如下。',
        attachments: [
          {
            kind: 'image',
            mediaType: 'image/svg+xml',
            title: '产品功能截图',
            url: '/assets/xxyy-feature-card.svg',
          },
        ],
        citations: [],
        confidence: 0.82,
        intent: 'product_qa',
      }),
    ).toContain(
      [
        'Citations: none',
        '',
        'Attachments:',
        '[1] 产品功能截图',
        '    /assets/xxyy-feature-card.svg',
      ].join('\n'),
    );
  });

  it('formats retained command summaries', () => {
    expect(
      formatIngestSummary({
        chunkCount: 64,
        documentCount: 12,
        indexPath: 'pgvector',
        runId: 'ingest_20260606T010203Z_abcd1234',
      }),
    ).toContain('Run ID: ingest_20260606T010203Z_abcd1234');
    expect(
      formatSyncXUpdatesSummary({
        changedChunkCount: 3,
        chunkCount: 8,
        documentCount: 2,
        indexPath: 'pgvector',
        skippedChunkCount: 5,
      }),
    ).toContain('Synced 3 changed X chunks (5 skipped).');
    expect(formatMigrationSummary()).toBe('Database migrations applied.');
  });

  it('formats evaluation reports with useful failure reasons', () => {
    expect(
      formatEvaluationReport({
        passed: 1,
        total: 2,
        results: [
          {
            actualIntent: 'product_qa',
            citationCount: 1,
            expectedIntent: 'product_qa',
            failureReasons: [],
            minCitations: 1,
            name: 'pro benefits',
            passed: true,
          },
          {
            actualIntent: 'unknown',
            citationCount: 0,
            expectedIntent: 'product_qa',
            failureReasons: ['intent unknown != product_qa', 'citations 0/1'],
            minCitations: 1,
            name: 'bad answer',
            passed: false,
          },
        ],
      }),
    ).toContain(
      [
        'Evaluation: 1/2 passed',
        '[PASS] pro benefits',
        '[FAIL] bad answer',
        '  - intent unknown != product_qa',
        '  - citations 0/1',
      ].join('\n'),
    );
  });

  it('formats provider-backed evaluation reports with per-case review details', () => {
    expect(
      formatEvaluationReport(
        {
          passed: 1,
          total: 2,
          results: [
            {
              actualIntent: 'product_qa',
              citationCount: 2,
              expectedIntent: 'product_qa',
              failureReasons: [],
              minCitations: 1,
              name: 'pro benefits',
              passed: true,
            },
            {
              actualIntent: 'unknown',
              citationCount: 0,
              expectedIntent: 'product_qa',
              failureReasons: ['intent unknown != product_qa', 'citations 0/1'],
              minCitations: 1,
              name: 'bad answer',
              passed: false,
            },
          ],
        },
        { providerBacked: true },
      ),
    ).toContain(
      [
        'Evaluation (provider-backed): 1/2 passed',
        '[PASS] pro benefits (expected product_qa, actual product_qa, citations 2/1)',
        '[FAIL] bad answer (expected product_qa, actual unknown, citations 0/1)',
        '  - intent unknown != product_qa',
        '  - citations 0/1',
      ].join('\n'),
    );
  });

  it('formats feedback records as review-only eval backlog JSONL', () => {
    const output = formatFeedbackEvalBacklog([
      {
        answer: '根据知识库，XXYY Pro 提供更多权益。',
        channel: 'web',
        citationCount: 2,
        comment: '没有讲清楚监控数量上限',
        createdAt: '2026-07-05T03:04:05.000Z',
        intent: 'product_qa',
        question: 'XXYY Pro 有哪些权益？',
        rating: 'negative',
        sessionId: 'session-1',
      },
      {
        answer: '暂时没有找到可引用的知识库内容。',
        channel: 'telegram',
        citationCount: 0,
        createdAt: '2026-07-05T03:05:06.000Z',
        intent: 'product_qa',
        question: '雷达扫链从哪里进入？',
        rating: 'positive',
      },
    ]);

    const records = output.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      boundaryExpected: false,
      expectedIntent: 'product_qa',
      question: 'XXYY Pro 有哪些权益？',
    });
    expect(records[0]?.name).toMatch(/^feedback-20260705-/u);
    expect(records[0]?._review).toMatchObject({
      citationCount: 2,
      comment: '没有讲清楚监控数量上限',
      reason: 'negative_feedback',
      rating: 'negative',
      sessionId: 'session-1',
      source: 'rag_feedback',
    });
    expect(records[1]?._review).toMatchObject({
      citationCount: 0,
      reason: 'no_citation_feedback',
      rating: 'positive',
      source: 'rag_feedback',
    });
  });

  it('formats retrieval and judge summaries only when present', () => {
    const output = formatEvaluationReport({
      judgeSummary: {
        averageCompleteness: 0.8,
        averageCorrectness: 0.9,
        averageGroundedness: 1,
        averageRelevance: 0.95,
        averageSafeRefusal: 1,
        judgedCaseCount: 1,
      },
      passed: 1,
      results: [],
      retrievalSummary: {
        annotatedCaseCount: 2,
        averageNdcgAtK: 0.75,
        averagePrecisionAtK: 0.5,
        averageRecallAtK: 1,
        meanReciprocalRank: 0.75,
        totalForbiddenHits: 0,
      },
      total: 1,
    });

    expect(output).toContain(
      'Retrieval (2 annotated): Recall@K 1.000000, Precision@K 0.500000, MRR 0.750000, nDCG@K 0.750000, forbidden hits 0',
    );
    expect(output).toContain(
      'Judge (1 cases): correctness 0.900000, groundedness 1.000000, completeness 0.800000, relevance 0.950000, safe refusal 1.000000',
    );
    expect(formatEvaluationReport({ passed: 0, results: [], total: 0 })).not.toContain('Retrieval');
  });

  it('formats provider retrieval failures independently from answer generation', () => {
    const output = formatProviderRetrievalReport({
      passed: 1,
      results: [
        {
          forbiddenChunkIds: [],
          name: 'missing evidence',
          passed: false,
          question: '问题',
          relevantChunkIds: ['expected:chunk'],
          result: {
            annotated: true,
            forbiddenHitCount: 0,
            ndcgAtK: 0,
            precisionAtK: 0,
            recallAtK: 0,
            reciprocalRank: 0,
            retrievedChunkIds: ['other:chunk'],
            topK: 1,
          },
        },
      ],
      summary: {
        annotatedCaseCount: 1,
        averageNdcgAtK: 0,
        averagePrecisionAtK: 0,
        averageRecallAtK: 0,
        meanReciprocalRank: 0,
        totalForbiddenHits: 0,
      },
      total: 2,
    });

    expect(output).toContain('Retrieval evaluation (provider-backed): 1/2 cases fully recalled');
    expect(output).toContain('[FAIL] missing evidence (recall 0.000000, forbidden 0)');
    expect(output).toContain('expected: expected:chunk');
    expect(output).toContain('retrieved: other:chunk');
  });

  it('formats knowledge stats for retained stats command', () => {
    const stats: KnowledgeStats = {
      chunkCount: 64,
      documentCount: 12,
      latestChunkUpdatedAt: '2026-06-06T01:02:03.000Z',
      latestIngestionRun: {
        chunkCount: 64,
        contentHash: 'content-hash-1',
        createdAt: '2026-06-06T01:03:04.000Z',
        documentCount: 12,
        runId: 'ingest_20260606T010203Z_abcd1234',
        source: 'cli',
        sourceCounts: { official_docs: 48, x_updates: 16 },
      },
      sourceStats: [
        { chunkCount: 48, documentCount: 10, sourceType: 'official_docs' },
        { chunkCount: 16, documentCount: 2, sourceType: 'x_updates' },
      ],
      sourceUrlCount: 8,
    };

    expect(formatKnowledgeStats(stats)).toContain(
      [
        'Knowledge stats:',
        'Documents: 12',
        'Chunks: 64',
        'Source URLs: 8',
        'Latest chunk update: 2026-06-06T01:02:03.000Z',
        '',
        'Latest ingest run:',
        'Run ID: ingest_20260606T010203Z_abcd1234',
      ].join('\n'),
    );
    expect(formatKnowledgeStats(stats)).toContain(
      'XXYY 官方文档 (official_docs): 48 chunks, 10 documents',
    );
    expect(formatKnowledgeStats(stats)).toContain('Content hash: content-hash-1');
  });

  it('maps golden QA expected source URLs into evaluation cases', async () => {
    vi.resetModules();

    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'xxyy-cli-eval-'));
    await mkdir(path.join(workspaceRoot, 'docs', 'eval'), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, 'docs', 'eval', 'golden-qa.jsonl'),
      `${JSON.stringify({
        name: 'tweet-source',
        question: '钱包备注支持最多 1 万条是哪条推文？',
        expectedIntent: 'product_qa',
        expectedAgentRoute: 'product_answer',
        expectedToolNames: ['search_product_docs'],
        forbiddenChunkIds: ['chunk-old'],
        forbiddenCitationFiles: [
          'docs/product-features/pages/59-getting-started__xxyy-pro-quan-yi.md',
        ],
        forbiddenSourceUrls: ['https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi'],
        expectedSourceUrls: ['https://x.com/useXXYYio/status/2030954722350575916'],
        requireCitationSupport: true,
        referenceFacts: ['钱包备注支持最多 1 万条'],
        relevantChunkIds: ['chunk-current'],
      })}\n`,
    );
    const evaluateCases = vi.fn(() =>
      Promise.resolve({
        total: 1,
        passed: 1,
        results: [
          {
            actualIntent: 'product_qa' as const,
            citationCount: 1,
            expectedIntent: 'product_qa' as const,
            failureReasons: [],
            minCitations: 0,
            name: 'tweet-source',
            expectedAgentRoute: 'product_answer',
            expectedToolNames: ['search_product_docs'],
            forbiddenChunkIds: ['chunk-old'],
            passed: true,
          },
        ],
      }),
    );

    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        loadProductDocuments: vi.fn(() => Promise.resolve([])),
        prepareKnowledgeChunks: vi.fn(() => []),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createChatService: vi.fn(() => ({ ask: vi.fn(), stream: vi.fn() })),
        createMetadataReranker: vi.fn(() => ({ rerank: vi.fn() })),
        evaluateCases,
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(
        ['evaluate', '--failures-out', '.rag/failures.jsonl'],
        {
          cwd: workspaceRoot,
          env: {},
          stderr: { write: () => true },
          stdout: { write: () => true },
        },
      );

      expect(exitCode).toBe(0);
      expect(evaluateCases).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            name: 'tweet-source',
            forbiddenCitationFiles: [
              'docs/product-features/pages/59-getting-started__xxyy-pro-quan-yi.md',
            ],
            forbiddenSourceUrls: ['https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi'],
            requireCitationSupport: true,
            referenceFacts: ['钱包备注支持最多 1 万条'],
            relevantChunkIds: ['chunk-current'],
            requiredSourceUrls: ['https://x.com/useXXYYio/status/2030954722350575916'],
          }),
        ],
        expect.anything(),
        expect.anything(),
      );
      const evaluationCall = evaluateCases.mock.calls[0] as unknown as [
        unknown,
        unknown,
        { observe?: unknown },
      ];
      expect(typeof evaluationCall[2].observe).toBe('function');
      await expect(
        readFile(path.join(workspaceRoot, '.rag', 'failures.jsonl'), 'utf8'),
      ).resolves.toBe('');
    } finally {
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });
});

function createKnowledgeCandidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    canonicalAnswer: '是的，XXYY 已支持 Robinhood。',
    contentHash: 'content-hash',
    createdAt: '2026-07-15T00:00:00.000Z',
    effectiveAt: '2026-07-15T00:00:00.000Z',
    id: 'knowledge_candidate_1234567890abcdef',
    question: 'XXYY 支持 Robinhood 吗？',
    reviewedAt: '2026-07-15T00:01:00.000Z',
    reviewedBy: 'telegram:123',
    sourceChannel: 'telegram_export',
    sourceUrl: 'https://docs.example.com/robinhood',
    status: 'approved',
    supersedes: ['official_docs:old-robinhood'],
    updatedAt: '2026-07-15T00:01:00.000Z',
    ...overrides,
  };
}

describe('runCli', () => {
  it('prints tracing configuration errors without exposing secrets', async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(['ask', '帮我查一下钱包余额'], {
      cwd: process.cwd(),
      env: { LANGSMITH_TRACING: 'true' },
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
      stdout: { write: () => true },
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('LANGSMITH_API_KEY is required');
  });

  it('returns boundary answers without planner configuration for obvious private lookups', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['ask', '帮我查一下钱包余额'], {
      cwd: process.cwd(),
      env: {},
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
      stdout: {
        write: (message: string) => {
          stdout.push(message);
          return true;
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout.join('')).toContain('我不能直接查询你的钱包余额');
    expect(stdout.join('')).toContain('Intent: realtime_account_query');
    expect(stderr.join('')).toBe('');
  });

  it('prints planner configuration errors for ambiguous requests', async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(['ask', '你好，可以介绍一下吗？'], {
      cwd: process.cwd(),
      env: {
        DATABASE_URL: 'postgres://xxyy:password@localhost:5432/xxyy_ask',
        OPENAI_MODEL: 'test-model',
      },
      stderr: {
        write: (message: string) => {
          stderr.push(message);
          return true;
        },
      },
      stdout: { write: () => true },
    });

    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('OPENAI_API_KEY is required for agent planning');
  });

  it('creates the customer chat service without session, audit, feedback, or quality options', async () => {
    vi.resetModules();

    const stdout: string[] = [];
    const ask = vi.fn((request: unknown) => {
      expect(request).toEqual({
        channel: 'cli',
        message: 'XXYY Pro 怎么升级？',
      });
      return Promise.resolve({
        answer: 'trimmed runtime response',
        citations: [],
        confidence: 0.8,
        intent: 'how_to' as const,
      });
    });
    const createCustomerAgentChatService = vi.fn(
      (options: CreateCustomerAgentChatServiceOptions) => {
        expect(Object.keys(options).sort()).toEqual([
          'answerProvider',
          'config',
          'productCapabilityCaller',
          'retriever',
          'tracer',
        ]);
        expect(options.productCapabilityCaller).toEqual({
          channel: 'cli',
          principal: 'user',
        });
        return {
          ask,
          stream: vi.fn(),
        };
      },
    );

    vi.doMock('@xxyy/agent-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createCustomerAgentChatService,
      };
    });
    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn() })),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createLazyRetriever: vi.fn(() => ({ retrieve: vi.fn() })),
        createPgPool: vi.fn(() => ({ end: vi.fn() })),
        createPgVectorStore: vi.fn(() => ({ retrieve: vi.fn() })),
        loadRagConfig: vi.fn(() => ({
          databaseUrl: 'postgres://example.test/db',
          embeddingDimension: 1536,
          openAiApiKey: 'test-key',
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['ask', 'XXYY Pro 怎么升级？'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(createCustomerAgentChatService).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(stdout.join('')).toContain('trimmed runtime response');
    } finally {
      vi.doUnmock('@xxyy/agent-core');
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('migrates pgvector storage before replacing prepared chunks', async () => {
    vi.resetModules();

    const events: string[] = [];
    const documents = [
      {
        id: 'doc-1',
        title: 'Doc 1',
        module: 'Product',
        sourceType: 'official_docs',
        file: 'docs/doc-1.md',
        content: 'Doc content',
      },
    ] satisfies SourceDocument[];
    const chunks = [
      {
        id: 'chunk-1',
        documentId: 'doc-1',
        text: 'Doc content',
        metadata: {
          title: 'Doc 1',
          module: 'Product',
          sourceType: 'official_docs',
          file: 'docs/doc-1.md',
          headingPath: [],
        },
        searchableText: 'Doc 1 Doc content',
        tokens: ['doc', 'content'],
        contentHash: 'hash-1',
      },
    ] satisfies PreparedKnowledgeChunk[];
    const embedTexts = vi.fn(() => {
      events.push('embed');
      return Promise.resolve([[0.1, 0.2, 0.3]]);
    });
    const migrate = vi.fn(() => {
      events.push('migrate');
      return Promise.resolve();
    });
    const replaceChunks = vi.fn(() => {
      events.push('replace');
      return Promise.resolve();
    });
    const recordIngestionRun = vi.fn(() => {
      events.push('record');
      return Promise.resolve();
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });
    const createOpenAiEmbeddingProvider = vi.fn(() => ({ embedTexts }));

    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider,
        loadProductDocuments: vi.fn(() => Promise.resolve(documents)),
        prepareKnowledgeChunks: vi.fn(() => chunks),
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getStats: vi.fn(),
          migrate,
          recordIngestionRun,
          replaceChunks,
          retrieve: vi.fn(),
          upsertChunks: vi.fn(),
        })),
        loadRagConfig: vi.fn(() => ({
          databaseUrl: 'postgres://example.test/db',
          embeddingApiKey: 'embedding-key',
          embeddingBaseUrl: 'https://embedding.example/v1',
          embeddingDimension: 1536,
          openAiApiKey: 'test-key',
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiModel: 'gpt-test',
          topK: 6,
        })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['ingest'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: { write: () => true },
      });

      expect(exitCode).toBe(0);
      expect(createOpenAiEmbeddingProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'embedding-key',
          baseUrl: 'https://embedding.example/v1',
          model: 'text-embedding-3-small',
        }),
      );
      expect(events).toEqual(['migrate', 'embed', 'replace', 'pool.end']);
      expect(replaceChunks).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'chunk-1' })],
        expect.objectContaining({
          chunkCount: 1,
          documentCount: 1,
          source: 'cli',
          sourceCounts: { official_docs: 1 },
        }),
      );
      expect(recordIngestionRun).not.toHaveBeenCalled();

      events.length = 0;
      const rebuildExitCode = await runCliWithMocks(
        ['ingest', '--', '--rebuild-embedding-schema'],
        {
          cwd: process.cwd(),
          env: {},
          stderr: { write: () => true },
          stdout: { write: () => true },
        },
      );

      expect(rebuildExitCode).toBe(0);
      expect(events).toEqual(['migrate', 'embed', 'replace', 'pool.end']);
      expect(migrate).toHaveBeenLastCalledWith({ allowEmbeddingDimensionMismatch: true });
      expect(replaceChunks).toHaveBeenLastCalledWith(
        [expect.objectContaining({ id: 'chunk-1' })],
        expect.objectContaining({ source: 'cli' }),
        { rebuildEmbeddingSchema: true },
      );
    } finally {
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('syncs only changed X update chunks without replacing the full index', async () => {
    vi.resetModules();

    const events: string[] = [];
    const documents = [
      {
        id: 'official-doc',
        title: 'Official Doc',
        module: 'Product',
        sourceType: 'official_docs',
        file: 'docs/product-features/pages/pro.md',
        content: 'Official content',
      },
      {
        id: 'x-doc',
        title: 'X Post 2',
        module: 'X Updates',
        sourceType: 'x_updates',
        file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
        content: 'X update content',
      },
    ] satisfies SourceDocument[];
    const chunks = [
      xChunk({
        contentHash: 'hash-unchanged',
        id: 'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
        searchableText: 'unchanged searchable text',
      }),
      xChunk({
        contentHash: 'hash-changed',
        id: 'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
        searchableText: 'changed searchable text',
      }),
    ] satisfies PreparedKnowledgeChunk[];
    const prepareKnowledgeChunks = vi.fn((inputDocuments: SourceDocument[]) => {
      events.push(`prepare:${inputDocuments.map((document) => document.id).join(',')}`);
      return chunks;
    });
    const embedTexts = vi.fn((texts: string[]) => {
      events.push(`embed:${texts.join('|')}`);
      return Promise.resolve(texts.map(() => [0.9, 0.8, 0.7]));
    });
    const migrate = vi.fn(() => {
      events.push('migrate');
      return Promise.resolve();
    });
    const getChunkContentHashes = vi.fn(() => {
      events.push('hashes');
      return Promise.resolve(
        new Map([
          ['x_updates:sources/usexxyyio-x-posts/1:chunk:0001', 'hash-unchanged'],
          ['x_updates:sources/usexxyyio-x-posts/2:chunk:0001', 'old-hash'],
        ]),
      );
    });
    const replaceChunks = vi.fn(() => {
      events.push('replace');
      return Promise.resolve();
    });
    const upsertChunks = vi.fn((_chunks: EmbeddedKnowledgeChunk[]) => {
      events.push('upsert');
      return Promise.resolve();
    });
    const recordIngestionRun = vi.fn(() => {
      events.push('record');
      return Promise.resolve();
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });

    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts })),
        loadProductDocuments: vi.fn(() => Promise.resolve(documents)),
        prepareKnowledgeChunks,
      };
    });
    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getChunkContentHashes,
          getStats: vi.fn(),
          migrate,
          recordIngestionRun,
          replaceChunks,
          retrieve: vi.fn(),
          upsertChunks,
        })),
        loadRagConfig: vi.fn(() => ({
          databaseUrl: 'postgres://example.test/db',
          embeddingDimension: 1536,
          openAiApiKey: 'test-key',
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiModel: 'gpt-test',
          topK: 6,
        })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');
      const stdout: string[] = [];

      const exitCode = await runCliWithMocks(['sync:x'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual([
        'prepare:x-doc',
        'migrate',
        'hashes',
        'embed:changed searchable text',
        'upsert',
        'record',
        'pool.end',
      ]);
      expect(getChunkContentHashes).toHaveBeenCalledWith([
        'x_updates:sources/usexxyyio-x-posts/1:chunk:0001',
        'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
      ]);
      expect(upsertChunks).toHaveBeenCalledWith([
        expect.objectContaining({
          contentHash: 'hash-changed',
          id: 'x_updates:sources/usexxyyio-x-posts/2:chunk:0001',
        }),
      ]);
      expect(replaceChunks).not.toHaveBeenCalled();
      expect(recordIngestionRun).toHaveBeenCalledWith(
        expect.objectContaining({
          chunkCount: 1,
          documentCount: 1,
          source: 'cli:x_incremental',
          sourceCounts: { x_updates: 1 },
        }),
      );
      expect(stdout.join('')).toContain('Synced 1 changed X chunks (1 skipped).');
    } finally {
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('runs database migrations without generating embeddings', async () => {
    vi.resetModules();

    const events: string[] = [];
    const migrate = vi.fn(() => {
      events.push('rag:migrate');
      return Promise.resolve();
    });
    const end = vi.fn(() => {
      events.push('pool.end');
      return Promise.resolve();
    });

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getStats: vi.fn(),
          migrate,
          recordIngestionRun: vi.fn(),
          replaceChunks: vi.fn(),
          retrieve: vi.fn(),
          upsertChunks: vi.fn(),
        })),
        loadRagConfig: vi.fn(() => ({
          databaseUrl: 'postgres://example.test/db',
          embeddingDimension: 1536,
          openAiApiKey: undefined,
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: undefined,
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');
      const stdout: string[] = [];

      const exitCode = await runCliWithMocks(['migrate'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(events).toEqual(['rag:migrate', 'pool.end']);
      expect(stdout.join('')).toContain('Database migrations applied.');
    } finally {
      vi.doUnmock('@xxyy/rag-core');
    }
  });

  it('prints pgvector knowledge stats', async () => {
    vi.resetModules();

    const stdout: string[] = [];
    const getStats = vi.fn(
      () =>
        Promise.resolve({
          chunkCount: 64,
          documentCount: 12,
          latestChunkUpdatedAt: '2026-06-06T01:02:03.000Z',
          latestIngestionRun: {
            chunkCount: 64,
            contentHash: 'content-hash-1',
            createdAt: '2026-06-06T01:03:04.000Z',
            documentCount: 12,
            runId: 'ingest_20260606T010203Z_abcd1234',
            source: 'cli',
            sourceCounts: { official_docs: 48, x_updates: 16 },
          },
          sourceStats: [
            { chunkCount: 48, documentCount: 10, sourceType: 'official_docs' },
            { chunkCount: 16, documentCount: 2, sourceType: 'x_updates' },
          ],
          sourceUrlCount: 8,
        }) satisfies Promise<KnowledgeStats>,
    );
    const end = vi.fn(() => Promise.resolve());

    vi.doMock('@xxyy/rag-core', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createPgPool: vi.fn(() => ({ end })),
        createPgVectorStore: vi.fn(() => ({
          getStats,
          migrate: vi.fn(),
          recordIngestionRun: vi.fn(),
          replaceChunks: vi.fn(),
          retrieve: vi.fn(),
          upsertChunks: vi.fn(),
        })),
        loadRagConfig: vi.fn(() => ({
          databaseUrl: 'postgres://example.test/db',
          embeddingDimension: 1536,
          openAiApiKey: 'test-key',
          openAiBaseUrl: 'https://api.openai.test/v1',
          openAiEmbeddingModel: 'text-embedding-3-small',
          openAiMaxRetries: 1,
          openAiModel: 'gpt-test',
          openAiRequestTimeoutMs: 30000,
          topK: 6,
        })),
      };
    });
    vi.doMock('@xxyy/knowledge', async (importOriginal) => {
      const actual = await importOriginal<Record<string, unknown>>();
      return {
        ...actual,
        createOpenAiEmbeddingProvider: vi.fn(() => ({ embedTexts: vi.fn() })),
      };
    });

    try {
      const { runCli: runCliWithMocks } = await import('./index.js');

      const exitCode = await runCliWithMocks(['stats'], {
        cwd: process.cwd(),
        env: {},
        stderr: { write: () => true },
        stdout: {
          write: (message: string) => {
            stdout.push(message);
            return true;
          },
        },
      });

      expect(exitCode).toBe(0);
      expect(getStats).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(stdout.join('')).toContain('Knowledge stats:');
      expect(stdout.join('')).toContain('Run ID: ingest_20260606T010203Z_abcd1234');
    } finally {
      vi.doUnmock('@xxyy/knowledge');
      vi.doUnmock('@xxyy/rag-core');
    }
  });
});
