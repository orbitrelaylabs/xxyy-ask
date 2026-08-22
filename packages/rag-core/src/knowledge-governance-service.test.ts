import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeCandidate, PgKnowledgeCandidateStore } from './knowledge-candidates.js';
import {
  createKnowledgeGovernanceService,
  UnverifiedTelegramKnowledgeAuthorError,
} from './knowledge-governance-service.js';
import type { KnowledgeCuratorModel } from './knowledge-curator.js';
import type { PgTrustedAuthorStore, TrustedAuthor } from './trusted-authors.js';

describe('createKnowledgeGovernanceService', () => {
  it('fails when agent curation is requested without a configured model', async () => {
    const service = createKnowledgeGovernanceService({
      candidateStore: candidateStore(),
      trustedAuthorStore: trustedAuthorStore([trustedAuthor()]),
    });

    await expect(
      service.importTelegram({ rawExport: telegramExport(), useAgent: true }),
    ).rejects.toThrow('no curator model is configured');
  });

  it('automatically uses the time-bounded roster and persists pending-only inputs', async () => {
    const createMany = vi.fn<PgKnowledgeCandidateStore['createMany']>().mockResolvedValue({
      created: [],
      duplicateCount: 0,
    });
    const service = createKnowledgeGovernanceService({
      candidateStore: candidateStore({ createMany }),
      trustedAuthorStore: trustedAuthorStore([trustedAuthor()]),
    });

    const result = await service.importTelegram({
      manualReviewRequired: true,
      rawExport: telegramExport(),
      runId: 'curator_run_1',
    });

    expect(result).toMatchObject({
      agentRunStats: {
        attemptedThreadCount: 0,
        modelAvailable: false,
      },
      candidateCount: 1,
      curationMode: 'auto',
      deterministicCandidateCount: 1,
      runId: 'curator_run_1',
      verifiedAuthorMessageCount: 1,
    });
    const inputs = createMany.mock.calls[0]?.[0] ?? [];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).not.toHaveProperty('status');
    expect(inputs[0]).toMatchObject({
      authorVerification: { status: 'trusted_author' },
      curatorRunId: 'curator_run_1',
    });
  });

  it('automatically invokes a configured curator model for every eligible author thread', async () => {
    const curateThread = vi.fn<KnowledgeCuratorModel['curateThread']>().mockResolvedValue([]);
    const service = createKnowledgeGovernanceService({
      candidateStore: candidateStore(),
      curatorModel: { curateThread, model: 'curator-model', promptVersion: 'curator-v1' },
      trustedAuthorStore: trustedAuthorStore([trustedAuthor()]),
    });

    const result = await service.importTelegram({
      rawExport: telegramExport(),
      runId: 'curator_run_auto',
    });

    expect(curateThread).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      agentRunStats: {
        attemptedThreadCount: 1,
        eligibleThreadCount: 1,
        succeededThreadCount: 1,
      },
      candidateCount: 1,
      curationMode: 'auto',
      deterministicCandidateCount: 1,
    });
  });

  it('runs strict automation immediately after candidate persistence', async () => {
    const pending = candidateRow('pending');
    const approved = candidateRow('approved');
    const process = vi.fn(() =>
      Promise.resolve({
        approvedCount: 1,
        decisions: [
          {
            candidate: approved,
            decision: {
              decision: 'approve' as const,
              policyVersion: 'knowledge-automation-v1' as const,
              reasonCodes: ['approved_strict_policy' as const],
            },
          },
        ],
        policyVersion: 'knowledge-automation-v1' as const,
        publicationQueuedCount: 1,
        rejectedCount: 0,
      }),
    );
    const service = createKnowledgeGovernanceService({
      automation: {
        process,
        reconcile: () => Promise.reject(new Error('not used')),
      },
      candidateStore: candidateStore({
        createMany: () => Promise.resolve({ created: [pending], duplicateCount: 0 }),
      }),
      trustedAuthorStore: trustedAuthorStore([trustedAuthor()]),
    });

    const result = await service.importTelegram({ rawExport: telegramExport() });

    expect(process).toHaveBeenCalledWith([pending]);
    expect(result.automation).toMatchObject({
      approvedCount: 1,
      publicationQueuedCount: 1,
    });
    expect(result.created).toEqual([approved]);
  });

  it('keeps inbox candidates pending when automation is explicitly disabled', async () => {
    const pending = candidateRow('pending');
    const process = vi.fn();
    const service = createKnowledgeGovernanceService({
      automation: {
        process,
        reconcile: () => Promise.reject(new Error('not used')),
      },
      candidateStore: candidateStore({
        createMany: () => Promise.resolve({ created: [pending], duplicateCount: 0 }),
      }),
      trustedAuthorStore: trustedAuthorStore([trustedAuthor()]),
    });

    const result = await service.importTelegram({
      rawExport: telegramExport(),
      runAutomation: false,
      sourceChannel: 'telegram',
    });

    expect(process).not.toHaveBeenCalled();
    expect(result.automation).toBeUndefined();
    expect(result.created).toEqual([pending]);
  });

  it('keeps legacy useAgent semantics and rejects ambiguous mode inputs', async () => {
    const service = createKnowledgeGovernanceService({
      candidateStore: candidateStore(),
      trustedAuthorStore: trustedAuthorStore([trustedAuthor()]),
    });

    await expect(
      service.importTelegram({
        curationMode: 'auto',
        rawExport: telegramExport(),
        useAgent: false,
      }),
    ).rejects.toThrow('Specify curationMode or deprecated useAgent');
    await expect(
      service.importTelegram({ rawExport: telegramExport(), useAgent: false }),
    ).resolves.toMatchObject({ curationMode: 'deterministic' });
  });

  it('fails closed when no author can be verified', async () => {
    const createMany = vi.fn<PgKnowledgeCandidateStore['createMany']>();
    const service = createKnowledgeGovernanceService({
      candidateStore: candidateStore({ createMany }),
      trustedAuthorStore: trustedAuthorStore([]),
    });

    await expect(service.importTelegram({ rawExport: telegramExport() })).rejects.toBeInstanceOf(
      UnverifiedTelegramKnowledgeAuthorError,
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it('does not expose publication and delegates approval to the existing review gate', async () => {
    const review = vi
      .fn<PgKnowledgeCandidateStore['review']>()
      .mockResolvedValue(candidateRow('approved'));
    const service = createKnowledgeGovernanceService({
      candidateStore: candidateStore({ review }),
      trustedAuthorStore: trustedAuthorStore([]),
    });

    const approved = await service.approve({
      effectiveAt: '2026-07-15',
      id: 'knowledge_candidate_1',
      reviewedBy: 'operator:alice',
    });

    expect(approved.status).toBe('approved');
    expect(review).toHaveBeenCalledWith({
      decision: 'approve',
      effectiveAt: '2026-07-15',
      id: 'knowledge_candidate_1',
      reviewedBy: 'operator:alice',
    });
    expect(service).not.toHaveProperty('publish');
  });

  it('loads candidate context, duplicate candidates, conflict chunks, and immutable history', async () => {
    const primary = {
      ...candidateRow('pending'),
      conflictChunkIds: ['official_docs:feature:chunk:1'],
      duplicateCandidateIds: ['knowledge_candidate_2'],
    };
    const duplicate = { ...candidateRow('pending'), id: 'knowledge_candidate_2' };
    const get = vi.fn<PgKnowledgeCandidateStore['get']>((id) =>
      Promise.resolve(id === primary.id ? primary : id === duplicate.id ? duplicate : undefined),
    );
    const service = createKnowledgeGovernanceService({
      candidateStore: candidateStore({ get }),
      referenceStore: {
        getByIds: () =>
          Promise.resolve([
            {
              content: '旧规则内容',
              documentId: 'official_docs:feature',
              headingPath: ['功能'],
              id: 'official_docs:feature:chunk:1',
              module: '功能',
              sourceType: 'official_docs',
              status: 'current',
              title: '功能规则',
            },
          ]),
      },
      trustedAuthorStore: trustedAuthorStore([]),
    });

    const detail = await service.getCandidateDetail(primary.id);

    expect(detail?.candidate.id).toBe(primary.id);
    expect(detail?.duplicates).toEqual([duplicate]);
    expect(detail?.conflicts[0]).toMatchObject({ content: '旧规则内容' });
    expect(get).toHaveBeenCalledWith('knowledge_candidate_2');
  });
});

function candidateStore(
  overrides: Partial<PgKnowledgeCandidateStore> = {},
): PgKnowledgeCandidateStore {
  return {
    createMany: () => Promise.resolve({ created: [], duplicateCount: 0 }),
    get: () => Promise.resolve(undefined),
    getHistory: () => Promise.resolve({ auditEvents: [], reviews: [], revisions: [] }),
    list: () => Promise.resolve([]),
    markPublished: () => Promise.reject(new Error('not used')),
    migrate: () => Promise.resolve(),
    revise: () => Promise.reject(new Error('not used')),
    review: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function trustedAuthorStore(authors: TrustedAuthor[]): PgTrustedAuthorStore {
  return {
    list: () => Promise.resolve(authors),
    migrate: () => Promise.resolve(),
    resolve: () => Promise.resolve(undefined),
    trust: () => Promise.reject(new Error('not used')),
  };
}

function trustedAuthor(): TrustedAuthor {
  return {
    chatId: '-100123',
    createdAt: '2026-07-01T00:00:00.000Z',
    id: 'trusted_author_123',
    role: 'administrator',
    updatedAt: '2026-07-01T00:00:00.000Z',
    userId: '123',
    validFrom: '2026-07-01T00:00:00.000Z',
    verificationSource: 'manual',
    verifiedAt: '2026-07-01T00:00:00.000Z',
    verifiedBy: 'operator:alice',
  };
}

function telegramExport() {
  return {
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
  };
}

function candidateRow(status: 'approved' | 'pending'): KnowledgeCandidate {
  return {
    canonicalAnswer: '答案',
    contentHash: 'hash',
    createdAt: '2026-07-15T00:00:00.000Z',
    currentRevision: 1,
    id: 'knowledge_candidate_1',
    question: '问题',
    sourceChannel: 'telegram_export' as const,
    status,
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
}
