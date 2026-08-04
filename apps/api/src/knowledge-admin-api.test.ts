import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type {
  FeedbackRecord,
  KnowledgeCandidate,
  KnowledgeGovernanceService,
  KnowledgePublicationJob,
  KnowledgeAdminPrincipal,
  PgFeedbackStore,
  PgKnowledgeAdminUserStore,
  PgKnowledgeGraphStore,
  PgKnowledgePublicationJobStore,
  PgQualityEvaluationJobStore,
  PgSupportOperationsStore,
  PgApiObservabilityStore,
  PgTelegramGroupMessageStore,
  PgTelegramGroupRegistryStore,
  PgTelegramCurationJobStore,
} from '@xxyy/rag-core';

import { handleKnowledgeAdminApi, type KnowledgeAdminServices } from './knowledge-admin-api.js';
import type { ApiRequestLike, ApiResponseLike } from './index.js';

const TOKEN = 'admin-test-token-with-at-least-24-characters';

describe('handleKnowledgeAdminApi', () => {
  it('requires database administrator setup before login', async () => {
    const response = await callAdmin({
      authenticator: {},
      body: { id: 'admin', password: 'valid-password-123' },
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            adminUsers: adminUserStore({ hasUsers: () => Promise.resolve(false) }),
          }),
        ),
      method: 'POST',
      url: '/admin/api/auth/login',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json).toMatchObject({ error: 'knowledge_admin_setup_required' });
  });

  it('creates the first administrator from the one-time setup endpoint', async () => {
    const createdUser = {
      createdAt: '2026-07-31T01:00:00.000Z',
      displayName: 'Owner',
      id: 'owner',
      role: 'admin' as const,
      status: 'active' as const,
      updatedAt: '2026-07-31T01:00:00.000Z',
    };
    const createInitialAdmin = vi.fn(() => Promise.resolve(createdUser));
    const login = vi.fn(() =>
      Promise.resolve({
        expiresAt: '2026-07-31T12:00:00.000Z',
        principal: { displayName: 'Owner', id: 'owner', role: 'admin' as const },
        token: TOKEN,
      }),
    );
    const response = await callAdmin({
      authenticator: {},
      body: { displayName: 'Owner', id: 'owner', password: 'valid-password-123' },
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            adminUsers: adminUserStore({
              createInitialAdmin,
              hasUsers: () => Promise.resolve(false),
              login,
            }),
          }),
        ),
      method: 'POST',
      url: '/admin/api/auth/setup',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      principal: { id: 'owner', role: 'admin' },
      sessionToken: TOKEN,
    });
    expect(createInitialAdmin).toHaveBeenCalledWith({
      displayName: 'Owner',
      id: 'owner',
      password: 'valid-password-123',
    });
  });

  it('closes the initial setup endpoint once an administrator exists', async () => {
    const createInitialAdmin = vi.fn();
    const response = await callAdmin({
      authenticator: {},
      body: { displayName: 'Owner', id: 'owner', password: 'valid-password-123' },
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            adminUsers: adminUserStore({
              createInitialAdmin,
              hasUsers: () => Promise.resolve(true),
            }),
          }),
        ),
      method: 'POST',
      url: '/admin/api/auth/setup',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json).toMatchObject({ error: 'knowledge_admin_setup_complete' });
    expect(createInitialAdmin).not.toHaveBeenCalled();
  });

  it('rejects missing database session credentials', async () => {
    const response = await callAdmin({
      authenticator: authenticator('admin'),
      getServices: () => Promise.resolve(knowledgeAdminServices()),
      method: 'GET',
      url: '/admin/api/candidates',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['WWW-Authenticate']).toContain('Bearer');
    expect(response.headers['Cache-Control']).toBe('no-store');
  });

  it('logs in with database credentials and returns a revocable session', async () => {
    const login = vi.fn(() =>
      Promise.resolve({
        expiresAt: '2026-07-31T12:00:00.000Z',
        principal: { displayName: 'Alice', id: 'alice', role: 'admin' as const },
        token: TOKEN,
      }),
    );
    const response = await callAdmin({
      authenticator: {},
      body: { id: 'alice', password: 'valid-password-123' },
      getServices: () =>
        Promise.resolve(knowledgeAdminServices({ adminUsers: adminUserStore({ login }) })),
      method: 'POST',
      url: '/admin/api/auth/login',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      principal: { id: 'alice', role: 'admin' },
      sessionToken: TOKEN,
    });
    expect(login).toHaveBeenCalledWith({ id: 'alice', password: 'valid-password-123' });
  });

  it('lets an authenticated administrator change their own password', async () => {
    const changeOwnPassword = vi.fn(() => Promise.resolve(true));
    const response = await callAdmin({
      authenticator: authenticator('viewer'),
      body: {
        currentPassword: 'current-password-value',
        newPassword: 'different-password-value',
      },
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            adminUsers: adminUserStore({ changeOwnPassword }),
          }),
        ),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/auth/change-password',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({ changed: true });
    expect(changeOwnPassword).toHaveBeenCalledWith({
      currentPassword: 'current-password-value',
      currentSessionToken: TOKEN,
      id: 'alice',
      newPassword: 'different-password-value',
    });
  });

  it('prevents an administrator from changing their own role or status', async () => {
    const updateUser = vi.fn();
    const response = await callAdmin({
      authenticator: authenticator('admin'),
      body: { role: 'viewer' },
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            adminUsers: adminUserStore({ updateUser }),
          }),
        ),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/users/alice',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json).toMatchObject({ error: 'self_account_protection' });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('lets administrators create and list database users', async () => {
    const user = {
      createdAt: '2026-07-31T01:00:00.000Z',
      displayName: 'Reviewer',
      id: 'reviewer',
      role: 'reviewer' as const,
      status: 'active' as const,
      updatedAt: '2026-07-31T01:00:00.000Z',
    };
    const createUser = vi.fn(() => Promise.resolve(user));
    const listUsers = vi.fn(() => Promise.resolve([user]));
    const services = knowledgeAdminServices({
      adminUsers: adminUserStore({ createUser, listUsers }),
    });
    const created = await callAdmin({
      authenticator: authenticator('admin'),
      body: {
        displayName: 'Reviewer',
        id: 'reviewer',
        password: 'valid-password-123',
        role: 'reviewer',
      },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/users',
    });
    const listed = await callAdmin({
      authenticator: authenticator('admin'),
      getServices: () => Promise.resolve(services),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/users',
    });

    expect(created.statusCode).toBe(201);
    expect(listed.json).toMatchObject({ users: [{ id: 'reviewer' }] });
    expect(createUser).toHaveBeenCalledWith({
      actor: 'admin:alice',
      displayName: 'Reviewer',
      id: 'reviewer',
      password: 'valid-password-123',
      role: 'reviewer',
    });
  });

  it('allows viewers to inspect candidates but not mutate them', async () => {
    const listCandidates = vi
      .fn<KnowledgeGovernanceService['listCandidates']>()
      .mockResolvedValue([candidate()]);
    const services = knowledgeAdminServices({ governance: governance({ listCandidates }) });
    const readResponse = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () => Promise.resolve(services),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/candidates?status=pending&limit=20',
    });
    const writeResponse = await callAdmin({
      authenticator: authenticator('viewer'),
      body: { canonicalAnswer: '修改后的答案' },
      getServices: () => Promise.resolve(services),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1',
    });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json).toMatchObject({ candidates: [{ id: 'knowledge_candidate_1' }] });
    expect(listCandidates).toHaveBeenCalledWith({ limit: 20, status: 'pending' });
    expect(writeResponse.statusCode).toBe(403);
  });

  it('exposes governed knowledge graph relations and lets reviewers reject a relation', async () => {
    const relation = {
      confidence: 0.95,
      evidence: 'XXYY 支持 Solana',
      id: 'kg_relation_1',
      object: { canonicalName: 'Solana', type: 'chain' as const },
      predicate: 'supports_chain' as const,
      sourceChunkId: 'chunk-1',
      sourceDocumentId: 'document-1',
      sourceType: 'official_docs' as const,
      status: 'approved' as const,
      subject: { canonicalName: 'XXYY', type: 'product' as const },
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const listRelations = vi.fn(() => Promise.resolve([relation]));
    const setRelationStatus = vi.fn(() =>
      Promise.resolve({ ...relation, status: 'rejected' as const }),
    );
    const services = knowledgeAdminServices({
      knowledgeGraph: knowledgeGraphStore({ listRelations, setRelationStatus }),
    });
    const listed = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () => Promise.resolve(services),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/knowledge-graph/relations?status=approved&limit=20',
    });
    const rejected = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: { status: 'rejected' },
      getServices: () => Promise.resolve(services),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/knowledge-graph/relations/kg_relation_1',
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json).toMatchObject({ relations: [{ id: 'kg_relation_1' }] });
    expect(rejected.statusCode).toBe(200);
    expect(setRelationStatus).toHaveBeenCalledWith({ id: 'kg_relation_1', status: 'rejected' });
  });

  it('previews graph relations for a Telegram candidate without publishing them', async () => {
    const getCandidateDetail = vi.fn<KnowledgeGovernanceService['getCandidateDetail']>(() =>
      Promise.resolve({
        candidate: candidate({
          canonicalAnswer: 'XXYY 整体产品目前支持哪些链：Solana、BSC。',
          proposedTitle: 'XXYY 当前支持的公链',
          sourceChannel: 'telegram',
        }),
        conflicts: [],
        duplicates: [],
        history: { auditEvents: [], reviews: [], revisions: [] },
      }),
    );
    const response = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () =>
        Promise.resolve(knowledgeAdminServices({ governance: governance({ getCandidateDetail }) })),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      graphPreview: expect.arrayContaining([
        expect.objectContaining({
          object: { canonicalName: 'Solana', type: 'chain' },
          subject: { canonicalName: 'XXYY', type: 'product' },
        }),
      ]),
    });
  });

  it('lists observed Telegram groups with local inbox counts', async () => {
    const list = vi.fn(() =>
      Promise.resolve([
        {
          chatId: '-100123',
          chatType: 'supergroup' as const,
          firstSeenAt: '2026-07-31T01:00:00.000Z',
          lastMessageAt: '2026-07-31T02:00:00.000Z',
          lastSeenAt: '2026-07-31T02:00:00.000Z',
          membershipStatus: 'active' as const,
          observationSource: 'message' as const,
          title: 'XXYY Support',
          updatedAt: '2026-07-31T02:00:00.000Z',
        },
      ]),
    );
    const countUnprocessed = vi.fn(() => Promise.resolve(7));
    const response = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            telegramGroups: telegramGroupStore({ list }),
            telegramCurationJobs: telegramCurationJobStore({
              get: () =>
                Promise.resolve({
                  attemptCount: 0,
                  availableAt: '2026-07-31T02:00:30.000Z',
                  chatId: '-100123',
                  status: 'queued',
                  triggerMessageId: '10',
                  updatedAt: '2026-07-31T02:00:00.000Z',
                }),
            }),
            telegramMessages: telegramMessageStore({ countUnprocessed }),
          }),
        ),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/telegram-groups?status=active&limit=20',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      groups: [
        {
          chatId: '-100123',
          curationJob: { status: 'queued' },
          title: 'XXYY Support',
          unprocessedMessageCount: 7,
        },
      ],
    });
    expect(JSON.stringify(response.json)).not.toContain('messageText');
    expect(list).toHaveBeenCalledWith({ limit: 20, membershipStatus: 'active' });
  });

  it('lets reviewers inspect and process a Telegram group inbox', async () => {
    const list = vi.fn(() =>
      Promise.resolve([
        {
          authorIsBot: false,
          authorUserId: '456',
          capturedAt: '2026-07-31T01:00:00.000Z',
          chatId: '-100123',
          messageId: '10',
          sentAt: '2026-07-31T01:00:00.000Z',
          text: 'XXYY 如何设置提醒？',
        },
      ]),
    );
    const processTelegramInbox = vi.fn(() =>
      Promise.resolve({
        agentFailedThreadCount: 0,
        candidateCount: 1,
        createdCount: 1,
        duplicateCount: 0,
        processedMessageCount: 2,
        requeuedMessageCount: 0,
        retainedMessageCount: 0,
        skippedBoundaryCount: 0,
        skippedMissingReplyCount: 0,
        unverifiedAuthorMessageCount: 0,
      }),
    );
    const services = knowledgeAdminServices({
      processTelegramInbox,
      telegramMessages: telegramMessageStore({ list }),
    });
    const messages = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () => Promise.resolve(services),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/telegram-groups/-100123/messages?status=all&limit=200',
    });
    const processed = await callAdmin({
      authenticator: authenticator('reviewer'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/telegram-groups/-100123/process',
    });

    expect(messages.statusCode).toBe(200);
    expect(messages.json).toMatchObject({ messages: [{ messageId: '10' }] });
    expect(list).toHaveBeenCalledWith({
      chatId: '-100123',
      limit: 200,
      processingStatus: 'all',
    });
    expect(processed.statusCode).toBe(200);
    expect(processTelegramInbox).toHaveBeenCalledWith({ chatId: '-100123' });

    const reprocessed = await callAdmin({
      authenticator: authenticator('reviewer'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/telegram-groups/-100123/reprocess',
    });
    expect(reprocessed.statusCode).toBe(200);
    expect(processTelegramInbox).toHaveBeenLastCalledWith({
      chatId: '-100123',
      reprocess: true,
    });
  });

  it('lets reviewers request an AI candidate suggestion without applying it', async () => {
    const suggestCandidate = vi.fn<KnowledgeAdminServices['suggestCandidate']>().mockResolvedValue({
      canonicalAnswer: '根据管理员回复，当前需要使用 BNB。',
      missingInformation: ['需要确认 BNB 的具体用途。'],
      model: 'test-model',
      proposedModule: '交易设置',
      proposedTitle: 'BSC 交易资产',
      promptVersion: 'knowledge-candidate-improvement-v1',
      question: 'XXYY 在 BSC 场景下是否支持 USDT？',
      rationale: '规范口语表达。',
      riskFlags: ['ambiguous_scope'],
      status: 'needs_clarification',
    });
    const services = knowledgeAdminServices({ suggestCandidate });
    const reviewerResponse = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: {
        canonicalAnswer: '不行，用 BNB 的。',
        question: '关于 XXYY，BSC 的可以用 USDT 交易吗？',
      },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/candidate-1/suggestion',
    });
    const viewerResponse = await callAdmin({
      authenticator: authenticator('viewer'),
      body: {
        canonicalAnswer: '不行，用 BNB 的。',
        question: '关于 XXYY，BSC 的可以用 USDT 交易吗？',
      },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/candidate-1/suggestion',
    });

    expect(reviewerResponse.statusCode).toBe(200);
    expect(reviewerResponse.json).toMatchObject({
      suggestion: { status: 'needs_clarification' },
    });
    expect(viewerResponse.statusCode).toBe(403);
    expect(suggestCandidate).toHaveBeenCalledTimes(1);
    expect(suggestCandidate).toHaveBeenCalledWith({
      canonicalAnswer: '不行，用 BNB 的。',
      id: 'candidate-1',
      question: '关于 XXYY，BSC 的可以用 USDT 交易吗？',
    });
  });

  it('exposes the support queue to viewers and restricts ticket updates to reviewers', async () => {
    const ticket = supportTicket();
    const listTickets = vi.fn(() => Promise.resolve([ticket]));
    const updateTicket = vi.fn(() =>
      Promise.resolve({
        ...ticket,
        assignedTo: 'admin:alice',
        status: 'in_progress' as const,
      }),
    );
    const services = knowledgeAdminServices({
      supportOperations: supportOperationsStore({ listTickets, updateTicket }),
    });
    const readResponse = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () => Promise.resolve(services),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/support/tickets?status=open&limit=20',
    });
    const forbidden = await callAdmin({
      authenticator: authenticator('viewer'),
      body: { assignedTo: 'admin:alice', status: 'in_progress' },
      getServices: () => Promise.resolve(services),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/support/tickets/support_ticket_1',
    });
    const accepted = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: { assignedTo: 'admin:alice', status: 'in_progress' },
      getServices: () => Promise.resolve(services),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/support/tickets/support_ticket_1',
    });

    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json).toMatchObject({ tickets: [{ id: 'support_ticket_1' }] });
    expect(listTickets).toHaveBeenCalledWith({ limit: 20, status: 'open' });
    expect(forbidden.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(updateTicket).toHaveBeenCalledWith({
      actor: 'admin:alice',
      assignedTo: 'admin:alice',
      id: 'support_ticket_1',
      status: 'in_progress',
    });
  });

  it('exposes feedback-derived knowledge gaps without publishing them', async () => {
    const getFeedbackStats = vi.fn(() =>
      Promise.resolve({
        latest: [
          {
            answer: '当前知识库存在冲突。',
            answerStatus: 'conflict' as const,
            channel: 'telegram' as const,
            citationCount: 2,
            comment: 'automatic_evidence_conflict',
            createdAt: '2026-07-29T01:00:00.000Z',
            intent: 'product_qa' as const,
            question: '钱包监控上限是多少？',
            rating: 'negative' as const,
            sourceTypes: ['official_docs', 'x_updates'] satisfies NonNullable<
              FeedbackRecord['sourceTypes']
            >,
          },
          {
            answer: '暂时无法确认。',
            channel: 'web' as const,
            citationCount: 0,
            comment: 'automatic_low_evidence',
            createdAt: '2026-07-29T00:00:00.000Z',
            intent: 'product_qa' as const,
            question: '新功能怎么使用？',
            rating: 'negative' as const,
          },
        ],
        negativeCount: 2,
        positiveCount: 0,
        totalCount: 2,
      }),
    );
    const response = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            feedback: feedbackStore({ getFeedbackStats }),
          }),
        ),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/support/knowledge-gaps',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      gaps: [
        {
          diagnosis: {
            category: 'knowledge',
            knowledgeCandidateEligible: false,
          },
          quality: {
            evidence: {
              answerStatus: 'conflict',
              conflictCount: 1,
              observedSourceTypes: ['official_docs', 'x_updates'],
              sourceObservation: 'available',
              stopReason: 'evidence_conflict',
            },
            queryPlan: { version: '1' },
            understanding: { kind: 'limit_or_quota', version: '1' },
            version: '1',
          },
          question: '钱包监控上限是多少？',
        },
        {
          diagnosis: {
            category: 'retrieval',
            knowledgeCandidateEligible: false,
          },
          quality: {
            evidence: {
              answerStatus: 'insufficient',
              coverageState: 'none',
            },
            retrievalPolicy: {
              preferredSourceTypes: ['official_docs', 'admin_verified', 'x_updates'],
            },
            understanding: { kind: 'how_to' },
          },
          question: '新功能怎么使用？',
        },
      ],
      metrics: { negativeCount: 2, totalCount: 2 },
      trend: {
        answerStatusCounts: {
          complete: 0,
          conflict: 1,
          insufficient: 1,
          partial: 0,
        },
        categoryCounts: {
          boundary: 0,
          classification: 0,
          generation: 0,
          knowledge: 1,
          retrieval: 1,
        },
        sampleSize: 2,
        version: '1',
      },
    });
    expect(getFeedbackStats).toHaveBeenCalledWith({ limit: 100 });
  });

  it('lets reviewers tombstone a confirmed deleted Telegram source', async () => {
    const retractTelegramSource = vi.fn(() =>
      Promise.resolve({
        publishedCandidateIds: ['candidate_published'],
        retractedCandidateIds: ['candidate_published'],
      }),
    );
    const response = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: { messageId: '22', sourceChatId: '-100123' },
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            governance: governance({ retractTelegramSource }),
          }),
        ),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/support/telegram-sources/retract',
    });

    expect(response.statusCode).toBe(200);
    expect(retractTelegramSource).toHaveBeenCalledWith({
      actor: 'admin:alice',
      messageId: '22',
      reason: 'source_deleted',
      sourceChatId: '-100123',
    });
  });

  it('uses the authenticated reviewer identity instead of accepting an actor from the body', async () => {
    const revise = vi.fn<KnowledgeGovernanceService['revise']>().mockResolvedValue(candidate());
    const response = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: {
        canonicalAnswer: '修改后的答案',
        editedBy: 'forged:actor',
      },
      getServices: () =>
        Promise.resolve(knowledgeAdminServices({ governance: governance({ revise }) })),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1',
    });

    expect(response.statusCode).toBe(400);
    expect(revise).not.toHaveBeenCalled();

    const accepted = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: { canonicalAnswer: '修改后的答案', reason: '补充限制' },
      getServices: () =>
        Promise.resolve(knowledgeAdminServices({ governance: governance({ revise }) })),
      method: 'PATCH',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1',
    });
    expect(accepted.statusCode).toBe(200);
    expect(revise).toHaveBeenCalledWith({
      canonicalAnswer: '修改后的答案',
      editedBy: 'admin:alice',
      id: 'knowledge_candidate_1',
      reason: '补充限制',
    });
  });

  it('requires an explicit effective time when a reviewer approves a candidate', async () => {
    const approve = vi.fn<KnowledgeGovernanceService['approve']>().mockResolvedValue(
      candidate({
        effectiveAt: '2026-07-21T00:00:00.000Z',
        status: 'approved',
      }),
    );
    const request = vi
      .fn<PgKnowledgePublicationJobStore['request']>()
      .mockResolvedValue(publication());
    const services = knowledgeAdminServices({
      governance: governance({ approve }),
      publicationJobs: publicationStore({ request }),
    });

    const missingEffectiveTime = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: {},
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1/approve',
    });
    const accepted = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: { effectiveAt: '2026-07-21T00:00:00.000Z' },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1/approve',
    });

    expect(missingEffectiveTime.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(200);
    expect(approve).toHaveBeenCalledWith({
      effectiveAt: '2026-07-21T00:00:00.000Z',
      id: 'knowledge_candidate_1',
      reviewedBy: 'admin:alice',
    });
    expect(request).toHaveBeenCalledWith({
      candidateId: 'knowledge_candidate_1',
      requestedBy: 'admin:alice',
    });
  });

  it('separates reviewer and publisher permissions for publication requests and retries', async () => {
    const request = vi
      .fn<PgKnowledgePublicationJobStore['request']>()
      .mockResolvedValue(publication());
    const retry = vi
      .fn<PgKnowledgePublicationJobStore['retry']>()
      .mockResolvedValue(publication({ status: 'queued' }));
    const services = knowledgeAdminServices({
      publicationJobs: publicationStore({ request, retry }),
    });

    const forbidden = await callAdmin({
      authenticator: authenticator('reviewer'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1/publication',
    });
    const queued = await callAdmin({
      authenticator: authenticator('publisher'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/candidates/knowledge_candidate_1/publication',
    });
    const retried = await callAdmin({
      authenticator: authenticator('publisher'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/publications/knowledge_publication_1/retry',
    });

    expect(forbidden.statusCode).toBe(403);
    expect(queued.statusCode).toBe(202);
    expect(retried.statusCode).toBe(202);
    expect(request).toHaveBeenCalledWith({
      candidateId: 'knowledge_candidate_1',
      requestedBy: 'admin:alice',
    });
    expect(retry).toHaveBeenCalledWith({
      id: 'knowledge_publication_1',
      requestedBy: 'admin:alice',
    });
  });

  it('reserves trusted-author management for administrators and stamps the verifier', async () => {
    const trustAuthor = vi
      .fn<KnowledgeGovernanceService['trustAuthor']>()
      .mockResolvedValue(trustedAuthor());
    const services = knowledgeAdminServices({ governance: governance({ trustAuthor }) });
    const payload = {
      chatId: '-100123',
      role: 'administrator',
      userId: '456',
      validFrom: '2026-07-01T00:00:00.000Z',
    };

    const publisherResponse = await callAdmin({
      authenticator: authenticator('publisher'),
      body: payload,
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/trusted-authors',
    });
    const adminResponse = await callAdmin({
      authenticator: authenticator('admin'),
      body: payload,
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/trusted-authors',
    });
    const forgedSourceResponse = await callAdmin({
      authenticator: authenticator('admin'),
      body: { ...payload, verificationSource: 'telegram_api' },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/trusted-authors',
    });

    expect(publisherResponse.statusCode).toBe(403);
    expect(adminResponse.statusCode).toBe(201);
    expect(forgedSourceResponse.statusCode).toBe(400);
    expect(trustAuthor).toHaveBeenCalledWith({
      ...payload,
      verificationSource: 'manual',
      verifiedBy: 'admin:alice',
    });
  });

  it('limits Telegram imports and never accepts an explicit administrator override', async () => {
    const importTelegram = vi.fn<KnowledgeAdminServices['importTelegram']>().mockResolvedValue({
      adminReplyCount: 1,
      agentCandidateCount: 0,
      agentRunStats: {
        attemptedThreadCount: 0,
        eligibleThreadCount: 0,
        failedThreadCount: 0,
        failureCounts: {
          invalid_output: 0,
          provider_error: 0,
          timeout: 0,
          unknown: 0,
        },
        modelAvailable: false,
        skippedBudgetThreadCount: 0,
        skippedByModeThreadCount: 0,
        skippedUnavailableThreadCount: 0,
        succeededThreadCount: 0,
      },
      candidateCount: 1,
      created: [],
      curationMode: 'auto',
      deterministicCandidateCount: 1,
      duplicateCount: 0,
      messageCount: 2,
      rejectedAgentProposalCount: 0,
      runId: 'run-1',
      skippedBoundaryCount: 0,
      skippedMissingReplyCount: 0,
      threadCount: 1,
      unverifiedAuthorMessageCount: 0,
      verifiedAuthorMessageCount: 1,
    });
    const services = knowledgeAdminServices({ importTelegram });

    const forged = await callAdmin({
      authenticator: authenticator('admin'),
      body: { adminUserIds: ['attacker'], rawExport: {}, useAgent: false },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/imports/telegram',
    });
    const tooLarge = await callAdmin({
      authenticator: authenticator('admin'),
      body: { rawExport: { text: 'x'.repeat(200) } },
      getServices: () => Promise.resolve(services),
      maxBodyBytes: 32,
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/imports/telegram',
    });

    expect(forged.statusCode).toBe(400);
    expect(tooLarge.statusCode).toBe(413);
    expect(importTelegram).not.toHaveBeenCalled();
  });

  it('defaults Telegram imports to auto curation and maps the legacy agent flag', async () => {
    const importTelegram = vi
      .fn<KnowledgeAdminServices['importTelegram']>()
      .mockRejectedValue(new Error('stop after input capture'));
    const services = knowledgeAdminServices({ importTelegram });

    await callAdmin({
      authenticator: authenticator('admin'),
      body: { rawExport: { messages: [] } },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/imports/telegram',
    });
    await callAdmin({
      authenticator: authenticator('admin'),
      body: { rawExport: { messages: [] }, useAgent: true },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/imports/telegram',
    });

    expect(importTelegram).toHaveBeenNthCalledWith(1, {
      curationMode: 'auto',
      rawExport: { messages: [] },
    });
    expect(importTelegram).toHaveBeenNthCalledWith(2, {
      curationMode: 'required',
      rawExport: { messages: [] },
    });
  });

  it('reports knowledge database connectivity failures as unavailable', async () => {
    const listCandidates = vi
      .fn<KnowledgeGovernanceService['listCandidates']>()
      .mockRejectedValue(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }));

    const response = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () =>
        Promise.resolve(knowledgeAdminServices({ governance: governance({ listCandidates }) })),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/candidates',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json).toMatchObject({ error: 'knowledge_store_unavailable' });
  });

  it('lists quality reports and lets publishers enqueue only fixed evaluation modes', async () => {
    const job = {
      attemptCount: 0,
      createdAt: '2026-08-01T08:00:00.000Z',
      id: 'quality-eval:1',
      mode: 'provider_retrieval' as const,
      requestedBy: 'admin:alice',
      status: 'queued' as const,
      updatedAt: '2026-08-01T08:00:00.000Z',
      withJudge: false,
    };
    const request = vi.fn(() => Promise.resolve(job));
    const listJobs = vi.fn(() => Promise.resolve([job]));
    const listReports = vi.fn(() => Promise.resolve([]));
    const services = knowledgeAdminServices({
      qualityEvaluations: qualityEvaluationStore({ listJobs, listReports, request }),
    });

    const overview = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () => Promise.resolve(services),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/quality/overview',
    });
    const queued = await callAdmin({
      authenticator: authenticator('publisher'),
      body: { mode: 'provider_retrieval' },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/quality/jobs',
    });

    expect(overview.statusCode).toBe(200);
    expect(overview.json).toMatchObject({ jobs: [{ id: job.id }], reports: [] });
    expect(queued.statusCode).toBe(202);
    expect(request).toHaveBeenCalledWith({
      mode: 'provider_retrieval',
      requestedBy: 'admin:alice',
    });
  });

  it('protects paid quality runs and baseline approval with RBAC', async () => {
    const request = vi.fn();
    const approveBaseline = vi.fn(() =>
      Promise.resolve({
        createdAt: '2026-08-01T08:00:00.000Z',
        failures: [],
        generatedAt: '2026-08-01T08:00:00.000Z',
        gatesPassed: true,
        gateReasons: [],
        id: 'quality-report:1',
        isBaseline: true,
        jobId: 'quality-eval:1',
        metrics: { casePassRate: 1 },
        mode: 'deterministic' as const,
        passedCases: 60,
        totalCases: 60,
        withJudge: false,
      }),
    );
    const services = knowledgeAdminServices({
      qualityEvaluations: qualityEvaluationStore({ approveBaseline, request }),
    });
    const forbidden = await callAdmin({
      authenticator: authenticator('reviewer'),
      body: { mode: 'provider', withJudge: true },
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/quality/jobs',
    });
    const approved = await callAdmin({
      authenticator: authenticator('admin'),
      getServices: () => Promise.resolve(services),
      method: 'POST',
      token: TOKEN,
      url: '/admin/api/quality/reports/quality-report%3A1/baseline',
    });

    expect(forbidden.statusCode).toBe(403);
    expect(request).not.toHaveBeenCalled();
    expect(approved.statusCode).toBe(200);
    expect(approveBaseline).toHaveBeenCalledWith({
      actor: 'admin:alice',
      reportId: 'quality-report:1',
    });
  });

  it('returns protected production API monitoring summaries and active alerts', async () => {
    const getSummary = vi.fn(() =>
      Promise.resolve({
        averageDurationMs: 80,
        byApiKey: [],
        byChannel: [],
        byModel: [],
        completionTokens: 40,
        estimatedCostUsd: 12,
        from: '2026-08-03T00:00:00.000Z',
        p95DurationMs: 150,
        promptTokens: 160,
        rateLimitedCount: 1,
        requestCount: 10,
        serverErrorCount: 1,
        timeline: [],
        to: '2026-08-04T00:00:00.000Z',
        totalTokens: 200,
      }),
    );
    const response = await callAdmin({
      authenticator: authenticator('viewer'),
      getServices: () =>
        Promise.resolve(
          knowledgeAdminServices({
            apiObservability: apiObservabilityStore({ getSummary }),
          }),
        ),
      method: 'GET',
      token: TOKEN,
      url: '/admin/api/observability/summary?from=2026-08-03T00%3A00%3A00.000Z',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      alerts: [
        { active: true, code: 'rate_limited_ratio' },
        { active: true, code: 'server_error_ratio' },
        { active: true, code: 'estimated_cost_usd' },
      ],
      summary: { requestCount: 10, totalTokens: 200 },
    });
    expect(getSummary).toHaveBeenCalledWith({ from: '2026-08-03T00:00:00.000Z' });
  });
});

interface CapturedResponse {
  body: string;
  headers: Record<string, string>;
  json: unknown;
  statusCode: number;
}

async function callAdmin(input: {
  authenticator: TestAuthenticator;
  getServices: () => Promise<KnowledgeAdminServices>;
  method: string;
  url: string;
  body?: unknown;
  maxBodyBytes?: number;
  token?: string;
}): Promise<CapturedResponse> {
  const chunks = input.body === undefined ? [] : [Buffer.from(JSON.stringify(input.body), 'utf8')];
  const request: ApiRequestLike = {
    headers: input.token === undefined ? {} : { authorization: `Bearer ${input.token}` },
    method: input.method,
    url: input.url,
    [Symbol.asyncIterator]() {
      return Readable.from(chunks)[Symbol.asyncIterator]();
    },
  };
  const captured: CapturedResponse = { body: '', headers: {}, json: undefined, statusCode: 200 };
  const response: ApiResponseLike = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    end(body) {
      if (body !== undefined) {
        captured.body += typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
      }
    },
    setHeader(name, value) {
      captured.headers[name] = value;
    },
    write(body) {
      captured.body += body;
    },
  };
  await handleKnowledgeAdminApi({
    getServices: async () => {
      const services = await input.getServices();
      return {
        ...services,
        adminUsers: {
          ...services.adminUsers,
          authenticateSession: (token) =>
            Promise.resolve(token === TOKEN ? input.authenticator.principal : undefined),
        },
      };
    },
    maxBodyBytes: input.maxBodyBytes ?? 1024 * 1024,
    request,
    requestUrl: new URL(input.url, 'http://localhost'),
    response,
  });
  captured.json = captured.body.length === 0 ? undefined : (JSON.parse(captured.body) as unknown);
  return captured;
}

function authenticator(role: 'admin' | 'publisher' | 'reviewer' | 'viewer') {
  return { principal: { displayName: 'Alice', id: 'alice', role } };
}

interface TestAuthenticator {
  principal?: KnowledgeAdminPrincipal;
}

function governance(
  overrides: Partial<KnowledgeGovernanceService> = {},
): KnowledgeGovernanceService {
  return {
    approve: () => Promise.reject(new Error('not used')),
    getCandidate: () => Promise.resolve(undefined),
    getCandidateDetail: () => Promise.resolve(undefined),
    getCandidateHistory: () => Promise.resolve({ auditEvents: [], reviews: [], revisions: [] }),
    importTelegram: () => Promise.reject(new Error('not used')),
    listCandidates: () => Promise.resolve([]),
    listTrustedAuthors: () => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    reject: () => Promise.reject(new Error('not used')),
    retractTelegramSource: () => Promise.reject(new Error('not used')),
    revise: () => Promise.reject(new Error('not used')),
    trustAuthor: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function publicationStore(
  overrides: Partial<PgKnowledgePublicationJobStore> = {},
): PgKnowledgePublicationJobStore {
  return {
    claim: () => Promise.reject(new Error('not used')),
    claimNext: () => Promise.resolve(undefined),
    complete: () => Promise.reject(new Error('not used')),
    fail: () => Promise.reject(new Error('not used')),
    get: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    request: () => Promise.reject(new Error('not used')),
    retry: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function knowledgeAdminServices(
  overrides: Partial<KnowledgeAdminServices> = {},
): KnowledgeAdminServices {
  return {
    adminUsers: adminUserStore(),
    apiObservability: apiObservabilityStore(),
    feedback: feedbackStore(),
    governance: governance(),
    knowledgeGraph: knowledgeGraphStore(),
    importTelegram: () => Promise.reject(new Error('not used')),
    publicationJobs: publicationStore(),
    qualityEvaluations: qualityEvaluationStore(),
    processTelegramInbox: () => Promise.reject(new Error('not used')),
    supportOperations: supportOperationsStore(),
    observabilityThresholds: {
      costUsd: 10,
      rateLimitedRatio: 0.05,
      serverErrorRatio: 0.02,
    },
    suggestCandidate: () => Promise.reject(new Error('not used')),
    telegramGroups: telegramGroupStore(),
    telegramCurationJobs: telegramCurationJobStore(),
    telegramMessages: telegramMessageStore(),
    ...overrides,
  };
}

function apiObservabilityStore(
  overrides: Partial<PgApiObservabilityStore> = {},
): PgApiObservabilityStore {
  return {
    getSummary: () =>
      Promise.resolve({
        averageDurationMs: 0,
        byApiKey: [],
        byChannel: [],
        byModel: [],
        completionTokens: 0,
        estimatedCostUsd: 0,
        from: '2026-08-03T00:00:00.000Z',
        p95DurationMs: 0,
        promptTokens: 0,
        rateLimitedCount: 0,
        requestCount: 0,
        serverErrorCount: 0,
        timeline: [],
        to: '2026-08-04T00:00:00.000Z',
        totalTokens: 0,
      }),
    list: () => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    record: () => Promise.resolve(),
    ...overrides,
  };
}

function telegramCurationJobStore(
  overrides: Partial<PgTelegramCurationJobStore> = {},
): PgTelegramCurationJobStore {
  return {
    claimNext: () => Promise.resolve(undefined),
    complete: () => Promise.resolve(false),
    fail: () => Promise.resolve(false),
    get: () => Promise.resolve(undefined),
    migrate: () => Promise.resolve(),
    request: () => Promise.resolve(),
    ...overrides,
  };
}

function qualityEvaluationStore(
  overrides: Partial<PgQualityEvaluationJobStore> = {},
): PgQualityEvaluationJobStore {
  return {
    approveBaseline: () => Promise.reject(new Error('not used')),
    claimNext: () => Promise.resolve(undefined),
    complete: () => Promise.reject(new Error('not used')),
    fail: () => Promise.reject(new Error('not used')),
    getReport: () => Promise.resolve(undefined),
    listJobs: () => Promise.resolve([]),
    listReports: () => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    request: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function knowledgeGraphStore(
  overrides: Partial<PgKnowledgeGraphStore> = {},
): PgKnowledgeGraphStore {
  return {
    listConflicts: () => Promise.resolve([]),
    listEntities: () => Promise.resolve([]),
    listRelations: () => Promise.resolve([]),
    setRelationStatus: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function adminUserStore(
  overrides: Partial<PgKnowledgeAdminUserStore> = {},
): PgKnowledgeAdminUserStore {
  return {
    authenticateSession: () => Promise.resolve(undefined),
    changeOwnPassword: () => Promise.resolve(false),
    createInitialAdmin: () => Promise.reject(new Error('not used')),
    createUser: () => Promise.reject(new Error('not used')),
    hasUsers: () => Promise.resolve(true),
    listUsers: () => Promise.resolve([]),
    login: () => Promise.resolve(undefined),
    logout: () => Promise.resolve(),
    migrate: () => Promise.resolve(),
    updateUser: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function telegramGroupStore(
  overrides: Partial<PgTelegramGroupRegistryStore> = {},
): PgTelegramGroupRegistryStore {
  return {
    list: () => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    observeMembership: () => Promise.reject(new Error('not used')),
    observeMessage: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function telegramMessageStore(
  overrides: Partial<PgTelegramGroupMessageStore> = {},
): PgTelegramGroupMessageStore {
  return {
    capture: () => Promise.resolve(),
    countUnprocessed: () => Promise.resolve(0),
    list: () => Promise.resolve([]),
    listByIds: () => Promise.resolve([]),
    markProcessed: () => Promise.resolve(0),
    markUnprocessed: () => Promise.resolve(0),
    migrate: () => Promise.resolve(),
    purgeOlderThan: () => Promise.resolve(0),
    ...overrides,
  };
}

function feedbackStore(overrides: Partial<PgFeedbackStore> = {}): PgFeedbackStore {
  return {
    getFeedbackStats: () =>
      Promise.resolve({
        latest: [],
        negativeCount: 0,
        positiveCount: 0,
        totalCount: 0,
      }),
    recordFeedback: () => Promise.resolve(),
    ...overrides,
  };
}

function supportOperationsStore(
  overrides: Partial<PgSupportOperationsStore> = {},
): PgSupportOperationsStore {
  return {
    appendMessage: () => Promise.reject(new Error('not used')),
    createTicket: () => Promise.reject(new Error('not used')),
    ensureConversation: () => Promise.reject(new Error('not used')),
    getConversation: () => Promise.resolve(undefined),
    getConversationByExternalSessionId: () => Promise.resolve(undefined),
    getMetrics: () =>
      Promise.resolve({
        activeConversationCount: 0,
        openTicketCount: 0,
        unassignedTicketCount: 0,
        waitingUserTicketCount: 0,
      }),
    getRecentMessages: () => Promise.resolve([]),
    getTicket: () => Promise.resolve(undefined),
    listTickets: () => Promise.resolve([]),
    migrate: () => Promise.resolve(),
    updateTicket: () => Promise.reject(new Error('not used')),
    ...overrides,
  };
}

function candidate(overrides: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate {
  return {
    canonicalAnswer: '标准答案',
    contentHash: 'hash',
    createdAt: '2026-07-21T00:00:00.000Z',
    currentRevision: 1,
    id: 'knowledge_candidate_1',
    question: '标准问题',
    sourceChannel: 'telegram_export' as const,
    status: 'pending' as const,
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function supportTicket() {
  return {
    conversationId: 'support_conversation_1',
    createdAt: '2026-07-29T00:00:00.000Z',
    id: 'support_ticket_1',
    priority: 'normal' as const,
    reason: 'explicit_human_request' as const,
    status: 'open' as const,
    subject: '需要人工协助',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}

function publication(overrides: Partial<KnowledgePublicationJob> = {}): KnowledgePublicationJob {
  return {
    attemptCount: 0,
    candidateId: 'knowledge_candidate_1',
    createdAt: '2026-07-21T00:00:00.000Z',
    id: 'knowledge_publication_1',
    requestedBy: 'admin:alice',
    status: 'queued',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function trustedAuthor() {
  return {
    chatId: '-100123',
    createdAt: '2026-07-21T00:00:00.000Z',
    id: 'trusted_author_1',
    role: 'administrator' as const,
    updatedAt: '2026-07-21T00:00:00.000Z',
    userId: '456',
    validFrom: '2026-07-01T00:00:00.000Z',
    verificationSource: 'manual' as const,
    verifiedAt: '2026-07-21T00:00:00.000Z',
    verifiedBy: 'admin:alice',
  };
}
