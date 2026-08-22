import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeCandidate } from './knowledge-candidates.js';
import {
  createKnowledgeMatchInspector,
  createOpenAiKnowledgeCuratorModel,
  runKnowledgeCurator,
  type KnowledgeCuratorModel,
} from './knowledge-curator.js';
import type { RetrievedChunk } from './retrieve.js';
import type { Retriever } from './retriever.js';
import { extractTelegramKnowledgeCandidates } from './telegram-knowledge.js';
import type { TrustedAuthor } from './trusted-authors.js';

describe('runKnowledgeCurator', () => {
  it('keeps the deterministic path and assigns an auditable run id', async () => {
    const extraction = directReplyExtraction();

    const result = await runKnowledgeCurator({ extraction, runId: 'curator_run_1' });

    expect(result).toMatchObject({
      agentCandidateCount: 0,
      agentRunStats: {
        attemptedThreadCount: 0,
        eligibleThreadCount: 1,
        failedThreadCount: 0,
        skippedUnavailableThreadCount: 1,
      },
      curationMode: 'auto',
      deterministicCandidateCount: 1,
      rejectedAgentProposalCount: 0,
      runId: 'curator_run_1',
    });
    expect(result.candidates[0]).toMatchObject({
      curatorRunId: 'curator_run_1',
      extractionMethod: 'deterministic_direct_reply',
    });
  });

  it('uses the model to normalize a direct administrator reply and replaces its rule candidate', async () => {
    const extraction = directReplyExtraction();
    const curateThread = vi.fn<KnowledgeCuratorModel['curateThread']>().mockResolvedValue([
      {
        canonicalAnswer: '打开提醒设置，开启价格提醒并保存即可生效。',
        confidence: 0.92,
        proposedModule: '操作指南',
        proposedTitle: '设置价格提醒',
        question: '如何在 XXYY 开启价格提醒？',
        riskFlags: [],
        sourceAnswerMessageId: '2',
        sourceQuestionMessageId: '1',
      },
    ]);

    const result = await runKnowledgeCurator({
      extraction,
      model: { curateThread, model: 'curator-model', promptVersion: 'curator-v1' },
      runId: 'curator_run_direct',
    });

    expect(curateThread).toHaveBeenCalledOnce();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      canonicalAnswer: '打开提醒设置，开启价格提醒并保存即可生效。',
      extractionMethod: 'agent_assisted',
      sourceAnswerMessageId: '2',
    });
    expect(result).toMatchObject({
      agentCandidateCount: 1,
      deterministicCandidateCount: 0,
    });
  });

  it('keeps the rule candidate when the model returns no supported proposal', async () => {
    const curateThread = vi.fn<KnowledgeCuratorModel['curateThread']>().mockResolvedValue([]);

    const result = await runKnowledgeCurator({
      extraction: directReplyExtraction(),
      model: { curateThread, model: 'curator-model', promptVersion: 'curator-v1' },
      runId: 'curator_run_direct_fallback',
    });

    expect(curateThread).toHaveBeenCalledOnce();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.extractionMethod).toBe('deterministic_direct_reply');
    expect(result).toMatchObject({
      agentCandidateCount: 0,
      deterministicCandidateCount: 1,
    });
  });

  it('does not fall back to a rule candidate when Agent curation is required', async () => {
    const curateThread = vi.fn<KnowledgeCuratorModel['curateThread']>().mockResolvedValue([]);

    const result = await runKnowledgeCurator({
      extraction: directReplyExtraction(),
      mode: 'required',
      model: { curateThread, model: 'curator-model', promptVersion: 'curator-v1' },
      runId: 'curator_run_direct_required',
    });

    expect(curateThread).toHaveBeenCalledOnce();
    expect(result.candidates).toEqual([]);
    expect(result).toMatchObject({
      agentCandidateCount: 0,
      deterministicCandidateCount: 0,
    });
  });

  it('uses the model for multi-message context and validates the cited author', async () => {
    const extraction = multiMessageExtraction();
    const curateThread = vi.fn<KnowledgeCuratorModel['curateThread']>().mockResolvedValue([
      {
        canonicalAnswer: '在提醒设置中开启价格提醒，保存后生效。',
        confidence: 0.88,
        proposedModule: '操作指南',
        proposedTitle: '设置价格提醒',
        question: 'XXYY 如何设置价格提醒？',
        riskFlags: [],
        sourceAnswerMessageId: '3',
        sourceQuestionMessageId: '1',
      },
    ]);

    const result = await runKnowledgeCurator({
      extraction,
      model: { curateThread, model: 'curator-model', promptVersion: 'curator-v1' },
      runId: 'curator_run_2',
      sourceChatId: '-100123',
    });

    expect(curateThread).toHaveBeenCalledOnce();
    expect(curateThread.mock.calls[0]?.[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorRole: 'knowledge_author', id: '3' }),
      ]),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      curatorModel: 'curator-model',
      curatorPromptVersion: 'curator-v1',
      extractionMethod: 'agent_assisted',
      sourceAnswerMessageId: '3',
      sourceQuestionMessageId: '1',
    });
    expect(result.candidates[0]?.authorVerification).toMatchObject({
      status: 'trusted_author',
    });
    expect(result.candidates[0]?.riskFlags).toContain('agent_generated');
    expect(result.agentRunStats).toMatchObject({
      attemptedThreadCount: 1,
      eligibleThreadCount: 1,
      failedThreadCount: 0,
      succeededThreadCount: 1,
    });
  });

  it('rejects a model proposal that cites a participant as the answer authority', async () => {
    const extraction = multiMessageExtraction();
    const model: KnowledgeCuratorModel = {
      model: 'curator-model',
      promptVersion: 'curator-v1',
      curateThread: () =>
        Promise.resolve([
          {
            canonicalAnswer: '这是用户自己说的答案。',
            confidence: 0.99,
            proposedModule: '产品功能',
            proposedTitle: '错误候选',
            question: 'XXYY 支持某功能吗？',
            riskFlags: [],
            sourceAnswerMessageId: '2',
          },
        ]),
    };

    const result = await runKnowledgeCurator({ extraction, model, runId: 'curator_run_3' });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedAgentProposalCount).toBe(1);
  });

  it('auto mode safely skips eligible threads when no model is configured', async () => {
    const result = await runKnowledgeCurator({
      extraction: multiMessageExtraction(),
      runId: 'curator_run_auto_without_model',
    });

    expect(result.curationMode).toBe('auto');
    expect(result.agentRunStats).toMatchObject({
      attemptedThreadCount: 0,
      eligibleThreadCount: 1,
      modelAvailable: false,
      skippedUnavailableThreadCount: 1,
    });
  });

  it('isolates model failures in auto mode but fails closed in required mode', async () => {
    const model: KnowledgeCuratorModel = {
      model: 'curator-model',
      promptVersion: 'curator-v1',
      curateThread: () => Promise.reject(new Error('Knowledge Curator model timed out after 1ms.')),
    };

    const automatic = await runKnowledgeCurator({
      extraction: mixedDirectAndMultiMessageExtraction(),
      mode: 'auto',
      model,
      runId: 'curator_run_auto_failure',
    });

    expect(automatic.candidates).toHaveLength(1);
    expect(automatic.candidates[0]?.extractionMethod).toBe('deterministic_direct_reply');
    expect(automatic.agentRunStats).toMatchObject({
      attemptedThreadCount: 2,
      failedThreadCount: 2,
      failureCounts: { timeout: 2 },
      succeededThreadCount: 0,
    });
    await expect(
      runKnowledgeCurator({
        extraction: multiMessageExtraction(),
        mode: 'required',
        model,
        runId: 'curator_run_required_failure',
      }),
    ).rejects.toThrow('timed out');
  });

  it('caps automatic model calls and rejects over-budget required imports', async () => {
    const curateThread = vi.fn<KnowledgeCuratorModel['curateThread']>().mockResolvedValue([]);
    const input = {
      extraction: twoMultiMessageThreadsExtraction(),
      maxAgentThreads: 1,
      model: { curateThread, model: 'curator-model', promptVersion: 'curator-v1' },
    };

    const automatic = await runKnowledgeCurator({
      ...input,
      mode: 'auto',
      runId: 'curator_run_auto_budget',
    });

    expect(curateThread).toHaveBeenCalledOnce();
    expect(curateThread.mock.calls[0]?.[0].rootMessageId).toBe('1');
    expect(automatic.agentRunStats).toMatchObject({
      attemptedThreadCount: 1,
      eligibleThreadCount: 2,
      skippedBudgetThreadCount: 1,
      succeededThreadCount: 1,
    });
    await expect(
      runKnowledgeCurator({
        ...input,
        mode: 'required',
        runId: 'curator_run_required_budget',
      }),
    ).rejects.toThrow('exceeding the per-import limit');
  });

  it('adds deterministic duplicate and conflict evidence before persistence', async () => {
    const existing = existingCandidate();
    const retriever: Retriever = {
      retrieve: () => [conflictingChunk()],
    };
    const inspector = createKnowledgeMatchInspector({
      candidateStore: { list: () => Promise.resolve([existing]) },
      retriever,
    });
    const candidate = directReplyExtraction().candidates[0];
    if (candidate === undefined) throw new Error('fixture candidate missing');

    const inspection = await inspector.inspect(candidate);

    expect(inspection.duplicateCandidateIds).toEqual([existing.id]);
    expect(inspection.conflictChunkIds).toEqual(['official_docs:alerts:chunk:1']);
    expect(inspection.riskFlags).toContain('possible_knowledge_conflict');
    expect(inspection.riskFlags).toContain('possible_duplicate_candidate');
  });
});

describe('createOpenAiKnowledgeCuratorModel', () => {
  it('uses structured JSON output and validates the response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidates: [
                    {
                      canonicalAnswer: '已经支持。',
                      confidence: 0.8,
                      proposedModule: '产品功能',
                      proposedTitle: '功能支持',
                      question: 'XXYY 支持该功能吗？',
                      riskFlags: [],
                      sourceAnswerMessageId: '2',
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const model = createOpenAiKnowledgeCuratorModel({
      apiKey: 'test-key',
      baseUrl: 'https://model.example/v1',
      fetchImpl,
      model: 'test-model',
    });

    const proposals = await model.curateThread({ messages: [], rootMessageId: '1' });

    expect(proposals[0]).toMatchObject({ confidence: 0.8, sourceAnswerMessageId: '2' });
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(request?.body).toContain('"response_format":{"type":"json_object"}');
    expect(request?.body).toContain('Curate direct replies as well as multi-message discussions.');
  });
});

function directReplyExtraction() {
  return extractTelegramKnowledgeCandidates(
    {
      id: -100123,
      messages: [
        {
          date: '2026-07-15T01:00:00Z',
          from_id: 'user456',
          id: 1,
          text: 'XXYY 如何设置价格提醒？',
        },
        {
          date: '2026-07-15T01:02:00Z',
          from_id: 'user123',
          id: 2,
          reply_to_message_id: 1,
          text: '在提醒设置中开启价格提醒，保存后生效。',
        },
      ],
    },
    { trustedAuthors: [trustedAuthor()] },
  );
}

function multiMessageExtraction() {
  return extractTelegramKnowledgeCandidates(
    {
      id: -100123,
      messages: [
        {
          date: '2026-07-15T01:00:00Z',
          from_id: 'user456',
          id: 1,
          text: 'XXYY 如何设置价格提醒？',
        },
        {
          date: '2026-07-15T01:01:00Z',
          from_id: 'user456',
          id: 2,
          reply_to_message_id: 1,
          text: '具体入口在哪里？',
        },
        {
          date: '2026-07-15T01:02:00Z',
          from_id: 'user123',
          id: 3,
          reply_to_message_id: 2,
          text: '在提醒设置中开启，保存后生效。',
        },
      ],
    },
    { trustedAuthors: [trustedAuthor()] },
  );
}

function twoMultiMessageThreadsExtraction() {
  return extractTelegramKnowledgeCandidates(
    {
      id: -100123,
      messages: [
        {
          date: '2026-07-15T01:00:00Z',
          from_id: 'user456',
          id: 1,
          text: 'XXYY 如何设置价格提醒？',
        },
        {
          date: '2026-07-15T01:01:00Z',
          from_id: 'user456',
          id: 2,
          reply_to_message_id: 1,
          text: '具体入口在哪里？',
        },
        {
          date: '2026-07-15T01:02:00Z',
          from_id: 'user123',
          id: 3,
          reply_to_message_id: 2,
          text: '在提醒设置中开启，保存后生效。',
        },
        {
          date: '2026-07-15T02:00:00Z',
          from_id: 'user789',
          id: 4,
          text: 'XXYY 如何开启 Telegram 通知？',
        },
        {
          date: '2026-07-15T02:01:00Z',
          from_id: 'user789',
          id: 5,
          reply_to_message_id: 4,
          text: '是在哪个页面设置？',
        },
        {
          date: '2026-07-15T02:02:00Z',
          from_id: 'user123',
          id: 6,
          reply_to_message_id: 5,
          text: '在监控设置中绑定 Telegram 后开启通知。',
        },
      ],
    },
    { trustedAuthors: [trustedAuthor()] },
  );
}

function mixedDirectAndMultiMessageExtraction() {
  return extractTelegramKnowledgeCandidates(
    {
      id: -100123,
      messages: [
        {
          date: '2026-07-15T01:00:00Z',
          from_id: 'user456',
          id: 1,
          text: 'XXYY 如何设置价格提醒？',
        },
        {
          date: '2026-07-15T01:02:00Z',
          from_id: 'user123',
          id: 2,
          reply_to_message_id: 1,
          text: '在提醒设置中开启价格提醒，保存后生效。',
        },
        {
          date: '2026-07-15T02:00:00Z',
          from_id: 'user789',
          id: 10,
          text: 'XXYY 如何开启 Telegram 通知？',
        },
        {
          date: '2026-07-15T02:01:00Z',
          from_id: 'user789',
          id: 11,
          reply_to_message_id: 10,
          text: '是在哪个页面设置？',
        },
        {
          date: '2026-07-15T02:02:00Z',
          from_id: 'user123',
          id: 12,
          reply_to_message_id: 11,
          text: '在监控设置中绑定 Telegram 后开启通知。',
        },
      ],
    },
    { trustedAuthors: [trustedAuthor()] },
  );
}

function trustedAuthor(): TrustedAuthor {
  return {
    chatId: '-100123',
    createdAt: '2026-07-01T00:00:00.000Z',
    id: 'trusted_author_123',
    role: 'knowledge_editor',
    updatedAt: '2026-07-01T00:00:00.000Z',
    userId: '123',
    validFrom: '2026-07-01T00:00:00.000Z',
    verificationSource: 'manual',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    verifiedBy: 'operator:alice',
  };
}

function existingCandidate(): KnowledgeCandidate {
  return {
    canonicalAnswer: '在提醒设置中开启价格提醒，保存后生效。',
    contentHash: 'hash',
    createdAt: '2026-07-01T00:00:00.000Z',
    currentRevision: 1,
    id: 'knowledge_candidate_existing',
    question: 'XXYY 如何设置价格提醒？',
    sourceChannel: 'telegram_export',
    status: 'pending',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function conflictingChunk(): RetrievedChunk {
  return {
    documentId: 'official_docs:alerts',
    embedding: [],
    id: 'official_docs:alerts:chunk:1',
    lexicalScore: 1,
    metadata: {
      file: 'docs/alerts.md',
      headingPath: ['价格提醒'],
      module: '操作指南',
      sourceType: 'official_docs',
      title: 'XXYY 价格提醒',
    },
    rank: 1,
    score: 1,
    sourceBoost: 1,
    text: 'XXYY 暂未支持价格提醒，不能在设置中开启。',
    tokens: ['xxyy', '价格', '提醒'],
    vectorScore: 0.8,
  };
}
