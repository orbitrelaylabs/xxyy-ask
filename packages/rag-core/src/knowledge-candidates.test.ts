import { describe, expect, it } from 'vitest';

import {
  createPgKnowledgeCandidateStore,
  InvalidKnowledgeCandidateStateError,
} from './knowledge-candidates.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

class FakeTransactionClient extends FakePgClient {
  released = false;

  override query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
      this.queries.push({ sql, values });
      return Promise.resolve({ rows: [] });
    }
    return super.query<T>(sql, values);
  }

  release(): void {
    this.released = true;
  }
}

describe('createPgKnowledgeCandidateStore', () => {
  it('retracts unpublished candidates when a Telegram source message is edited', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        { id: 'candidate_pending', previous_status: 'pending' },
        { id: 'candidate_published', previous_status: 'published' },
      ],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    await expect(
      store.retractTelegramSource?.({
        actor: 'system:telegram-edit',
        messageId: '22',
        sourceChatId: '-100123',
      }),
    ).resolves.toEqual({
      publishedCandidateIds: ['candidate_published'],
      retractedCandidateIds: ['candidate_pending', 'candidate_published'],
    });
    expect(client.queries[0]?.sql).toContain("'telegram_source_retracted'");
    expect(client.queries[0]?.sql).toContain(
      "matched.status in ('pending', 'approved', 'published')",
    );
    expect(client.queries[0]?.sql).toContain('insert into knowledge_source_tombstones');
    expect(client.queries[0]?.values).toEqual([
      '-100123',
      '22',
      'system:telegram-edit',
      'source_edited',
    ]);
  });

  it('creates an import batch atomically when given a pool', async () => {
    const transaction = new FakeTransactionClient();
    transaction.queuedRows = [[candidateRow()]];
    const store = createPgKnowledgeCandidateStore({
      client: {
        connect: () => Promise.resolve(transaction),
        query: () => Promise.reject(new Error('pool query must not be used for the batch')),
      },
    });

    const result = await store.createMany([
      {
        canonicalAnswer: '是的，XXYY 已支持该功能。',
        question: 'XXYY 支持该功能吗？',
        sourceChannel: 'telegram_export',
      },
    ]);

    expect(result.created).toHaveLength(1);
    expect(transaction.queries[0]?.sql).toBe('begin');
    expect(transaction.queries.at(-1)?.sql).toBe('commit');
    expect(transaction.released).toBe(true);
  });

  it('migrates the candidate review schema', async () => {
    const client = new FakePgClient();
    const store = createPgKnowledgeCandidateStore({ client });

    await store.migrate();

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('alter table knowledge_candidates rename to knowledge_candidates_legacy');
    expect(sql).toContain(
      'rename constraint knowledge_candidates_pkey to knowledge_candidates_legacy_pkey',
    );
    expect(sql).toContain('create table if not exists knowledge_candidates');
    expect(sql).toContain("status in ('pending', 'approved', 'rejected', 'published')");
    expect(sql).toContain('create table if not exists knowledge_candidate_revisions');
    expect(sql).toContain('create table if not exists knowledge_candidate_reviews');
    expect(sql).toContain('create table if not exists knowledge_trusted_authors');
    expect(sql).toContain('add column if not exists source_question_text text');
    expect(sql).toContain('add column if not exists source_answer_text text');
    expect(sql).toContain('knowledge_candidates_review_status_created_at_idx');
  });

  it('creates redacted candidates idempotently', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        candidateRow({
          canonical_answer: '请联系 [telegram_user]，支持地址 [evm_address]。',
          question: '手机号 [phone] 的用户怎么配置？',
        }),
      ],
      [],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    const result = await store.createMany([
      {
        authorVerification: {
          role: 'administrator',
          source: 'manual',
          status: 'trusted_author',
          userId: '123',
          validFrom: '2026-07-01',
          verifiedAt: '2026-07-15',
        },
        canonicalAnswer:
          '请联系 @support_admin，支持地址 0x1234567890123456789012345678901234567890。',
        contextMessageIds: ['1', '2'],
        extractionMethod: 'agent_assisted',
        question: '手机号 +86 138 0013 8000 的用户怎么配置？',
        qualityScore: 0.81234,
        riskFlags: ['contains_account_like_text'],
        sourceAnswerMessageId: '2',
        sourceChannel: 'telegram_export',
        sourceChatId: '-100123',
        sourceQuestionMessageId: '1',
        submittedBy: 'user-admin-1',
      },
      {
        canonicalAnswer: '重复答案',
        question: '重复问题',
        sourceChannel: 'telegram_export',
      },
    ]);

    expect(result.created).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
    expect(client.queries[0]?.values[2]).toBe('手机号 [phone] 的用户怎么配置？');
    expect(client.queries[0]?.values[3]).toBe('请联系 [telegram_user]，支持地址 [evm_address]。');
    expect(JSON.stringify(client.queries[0]?.values)).not.toContain('138 0013 8000');
    expect(JSON.stringify(client.queries[0]?.values)).not.toContain('@support_admin');
    expect(client.queries[0]?.values[5]).toBe('["1","2"]');
    expect(client.queries[0]?.values[7]).toBe('agent_assisted');
    expect(client.queries[0]?.values[11]).toBe(0.8123);
  });

  it('lists candidates by review status', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[candidateRow({ status: 'approved' })]];
    const store = createPgKnowledgeCandidateStore({ client });

    const candidates = await store.list({ limit: 5, status: 'approved' });

    expect(candidates[0]).toMatchObject({
      id: 'knowledge_candidate_1234567890abcdef',
      status: 'approved',
    });
    expect(client.queries[0]?.sql).toContain('where status = $1');
    expect(client.queries[0]?.values).toEqual(['approved', 5]);
  });

  it('reviews only pending candidates', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        candidateRow({
          effective_at: '2026-07-15T00:00:00.000Z',
          reviewed_at: '2026-07-15T01:00:00.000Z',
          reviewed_by: 'telegram:123',
          source_url: 'https://docs.example.com/feature',
          status: 'approved',
          supersedes: ['official_docs:old-feature'],
        }),
      ],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    const reviewed = await store.review({
      decision: 'approve',
      effectiveAt: '2026-07-15',
      id: 'knowledge_candidate_1234567890abcdef',
      reviewedBy: 'telegram:123',
      sourceUrl: 'https://docs.example.com/feature',
      supersedes: ['official_docs:old-feature'],
    });

    expect(reviewed).toMatchObject({
      reviewedBy: 'telegram:123',
      sourceUrl: 'https://docs.example.com/feature',
      status: 'approved',
      supersedes: ['official_docs:old-feature'],
    });
    expect(client.queries[0]?.sql).toContain("where id = $1 and status = 'pending'");
  });

  it('rejects invalid review transitions', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[]];
    const store = createPgKnowledgeCandidateStore({ client });

    await expect(
      store.review({
        decision: 'reject',
        id: 'knowledge_candidate_1234567890abcdef',
        reviewedBy: 'telegram:123',
      }),
    ).rejects.toBeInstanceOf(InvalidKnowledgeCandidateStateError);
  });

  it('marks approved candidates as published with a document id', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        candidateRow({
          published_at: '2026-07-15T02:00:00.000Z',
          published_document_id:
            'admin_verified:admin-verified/knowledge_candidate_1234567890abcdef',
          status: 'published',
        }),
      ],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    const published = await store.markPublished({
      id: 'knowledge_candidate_1234567890abcdef',
      publishedDocumentId: 'admin_verified:admin-verified/knowledge_candidate_1234567890abcdef',
    });

    expect(published.status).toBe('published');
    expect(published.publishedDocumentId).toContain('admin_verified:');
    expect(client.queries[0]?.sql).toContain("'candidate_published'");
  });

  it('revises only pending candidates and appends revision and audit records', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [candidateRow()],
      [candidateRow({ canonical_answer: '更新后的标准答案。', current_revision: 2 })],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    const revised = await store.revise({
      canonicalAnswer: '更新后的标准答案。',
      editedBy: 'operator:alice',
      id: 'knowledge_candidate_1234567890abcdef',
      reason: '补充产品限制',
    });

    expect(revised).toMatchObject({
      canonicalAnswer: '更新后的标准答案。',
      currentRevision: 2,
      status: 'pending',
    });
    expect(client.queries[1]?.sql).toContain('current_revision = current_revision + 1');
    expect(client.queries[1]?.sql).toContain("'candidate_revised'");
    expect(client.queries[1]?.values[7]).toBe('operator:alice');
  });

  it('returns immutable revision and review history', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          candidate_id: 'knowledge_candidate_1234567890abcdef',
          canonical_answer: '第一版答案',
          created_at: '2026-07-15T00:00:00.000Z',
          edited_by: 'system:curator',
          evidence: '群聊消息',
          id: 1,
          proposed_module: '产品功能',
          proposed_title: '功能支持',
          question: '是否支持？',
          reason: 'initial candidate',
          revision: 1,
        },
      ],
      [
        {
          candidate_id: 'knowledge_candidate_1234567890abcdef',
          created_at: '2026-07-15T01:00:00.000Z',
          decision: 'approve',
          id: 1,
          note: '证据充分',
          reviewed_by: 'operator:alice',
          revision: 1,
        },
      ],
      [
        {
          actor: 'system:curator',
          created_at: '2026-07-15T00:00:00.000Z',
          details: { extractionMethod: 'deterministic_direct_reply' },
          entity_id: 'knowledge_candidate_1234567890abcdef',
          entity_type: 'candidate',
          event_type: 'candidate_created',
          id: '1',
        },
      ],
    ];
    const store = createPgKnowledgeCandidateStore({ client });

    const history = await store.getHistory('knowledge_candidate_1234567890abcdef');

    expect(history.revisions[0]).toMatchObject({ revision: 1, editedBy: 'system:curator' });
    expect(history.reviews[0]).toMatchObject({ decision: 'approve', revision: 1 });
    expect(history.auditEvents[0]).toMatchObject({
      actor: 'system:curator',
      eventType: 'candidate_created',
    });
  });

  it('does not publish pending or rejected candidates', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[]];
    const store = createPgKnowledgeCandidateStore({ client });

    await expect(
      store.markPublished({
        id: 'knowledge_candidate_1234567890abcdef',
        publishedDocumentId: 'admin_verified:test',
      }),
    ).rejects.toBeInstanceOf(InvalidKnowledgeCandidateStateError);
  });
});

function candidateRow(overrides: Record<string, unknown> = {}) {
  return { ...baseCandidateRow(), ...overrides };
}

function baseCandidateRow() {
  return {
    author_verification: null,
    canonical_answer: '是的，XXYY 已支持该功能。',
    conflict_chunk_ids: [],
    content_hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    context_message_ids: [],
    created_at: '2026-07-15T00:00:00.000Z',
    curator_model: null,
    curator_prompt_version: null,
    curator_run_id: null,
    current_revision: 1,
    duplicate_candidate_ids: [],
    effective_at: null,
    evidence: null,
    extraction_method: 'deterministic_direct_reply' as const,
    id: 'knowledge_candidate_1234567890abcdef',
    published_at: null,
    published_document_id: null,
    proposed_module: null,
    proposed_title: null,
    quality_score: null,
    question: 'XXYY 支持该功能吗？',
    risk_flags: [],
    review_note: null,
    reviewed_at: null,
    reviewed_by: null,
    source_answer_message_id: '2',
    source_answer_text: null,
    source_channel: 'telegram_export' as const,
    source_chat_id: '-100123',
    source_question_message_id: '1',
    source_question_text: null,
    source_url: null,
    status: 'pending',
    submitted_by: 'user-admin-1',
    supersedes: [],
    updated_at: '2026-07-15T00:00:00.000Z',
  };
}
