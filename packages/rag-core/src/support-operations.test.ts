import { describe, expect, it } from 'vitest';

import {
  createPgSupportOperationsStore,
  SupportConversationNotFoundError,
  SupportTicketNotFoundError,
} from './support-operations.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    const transactionStatement = sql.trim().toLowerCase();
    const rows =
      transactionStatement === 'begin' ||
      transactionStatement === 'commit' ||
      transactionStatement === 'rollback'
        ? []
        : (this.queuedRows.shift() ?? []);
    return Promise.resolve({ rows: rows as T[] });
  }
}

describe('createPgSupportOperationsStore', () => {
  it('migrates conversations, messages, tickets, and ticket audit events', async () => {
    const client = new FakePgClient();
    await createPgSupportOperationsStore({ client }).migrate();

    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists support_conversations');
    expect(sql).toContain('create table if not exists support_conversation_messages');
    expect(sql).toContain('create table if not exists support_tickets');
    expect(sql).toContain('support_tickets_one_active_per_conversation_idx');
    expect(sql).toContain('create table if not exists support_ticket_events');
  });

  it('upserts an external session while hashing the user identity', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[conversationRow()]];
    const conversation = await createPgSupportOperationsStore({
      client,
    }).ensureConversation({
      channel: 'web',
      externalSessionId: 'session-1',
      userId: 'user@example.com',
    });

    expect(conversation).toMatchObject({
      externalSessionId: 'session-1',
      status: 'open',
    });
    expect(client.queries[0]?.sql).toContain('on conflict (external_session_id) do update');
    expect(client.queries[0]?.values[3]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(client.queries[0]?.values)).not.toContain('user@example.com');
  });

  it('redacts sensitive message content before persistence', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        messageRow({
          content: '密码是 [sensitive_credential]，钱包 [evm_address]',
        }),
      ],
    ];
    await createPgSupportOperationsStore({ client }).appendMessage({
      content: '密码是 hunter2，钱包 0x1234567890123456789012345678901234567890',
      conversationId: 'support_conversation_1',
      role: 'user',
    });

    expect(client.queries[0]?.values[3]).not.toContain('hunter2');
    expect(client.queries[0]?.values[3]).not.toContain(
      '0x1234567890123456789012345678901234567890',
    );
  });

  it('returns messages in chronological order using a bounded recent query', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        messageRow({ id: 'message-1', role: 'user' }),
        messageRow({ id: 'message-2', role: 'assistant' }),
      ],
    ];
    const messages = await createPgSupportOperationsStore({ client }).getRecentMessages(
      'support_conversation_1',
      { limit: 8 },
    );

    expect(messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(client.queries[0]?.sql).toContain('order by created_at desc, id desc');
    expect(client.queries[0]?.values).toEqual(['support_conversation_1', 8]);
  });

  it('creates at most one active ticket per conversation', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ id: 'support_conversation_1' }], [], [ticketRow()]];
    const ticket = await createPgSupportOperationsStore({ client }).createTicket({
      conversationId: 'support_conversation_1',
      reason: 'low_evidence',
      subject: '无法确认 Pro 权益',
    });

    expect(ticket).toMatchObject({
      reason: 'low_evidence',
      status: 'open',
    });
    expect(client.queries.some((query) => query.sql.trim() === 'begin')).toBe(true);
    expect(client.queries.some((query) => query.sql.trim() === 'commit')).toBe(true);
    expect(client.queries.map((query) => query.sql).join('\n')).toContain("'ticket_created'");
  });

  it('returns the existing active ticket idempotently', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ id: 'support_conversation_1' }], [ticketRow()]];
    const ticket = await createPgSupportOperationsStore({ client }).createTicket({
      conversationId: 'support_conversation_1',
      reason: 'negative_feedback',
      subject: '用户反馈错误',
    });

    expect(ticket.id).toBe('support_ticket_1');
    expect(client.queries.map((query) => query.sql).join('\n')).not.toContain(
      'insert into support_tickets (',
    );
  });

  it('updates ticket assignment and closes the linked conversation', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        ticketRow({
          assigned_to: 'support:alice',
          resolved_at: '2026-07-29T01:30:00.000Z',
          status: 'resolved',
        }),
      ],
    ];
    const ticket = await createPgSupportOperationsStore({ client }).updateTicket({
      actor: 'support:alice',
      assignedTo: 'support:alice',
      id: 'support_ticket_1',
      resolution: '已提供正确配置步骤。',
      status: 'resolved',
    });

    expect(ticket).toMatchObject({
      assignedTo: 'support:alice',
      status: 'resolved',
    });
    expect(client.queries[0]?.sql).toContain("'ticket_updated'");
    expect(client.queries[0]?.sql).toContain("when updated.status = 'resolved' then 'resolved'");
    expect(client.queries[0]?.values[3]).toBe(true);
  });

  it('fails closed for missing conversations and tickets', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[], []];
    const store = createPgSupportOperationsStore({ client });

    await expect(
      store.appendMessage({
        content: '问题',
        conversationId: 'support_conversation_missing',
        role: 'user',
      }),
    ).rejects.toBeInstanceOf(SupportConversationNotFoundError);
    await expect(
      store.updateTicket({
        actor: 'support:alice',
        id: 'support_ticket_missing',
        status: 'closed',
      }),
    ).rejects.toBeInstanceOf(SupportTicketNotFoundError);
  });
});

function conversationRow(overrides: Partial<ReturnType<typeof conversationRowBase>> = {}) {
  return { ...conversationRowBase(), ...overrides };
}

function conversationRowBase() {
  return {
    channel: 'web' as const,
    created_at: '2026-07-29T01:00:00.000Z',
    external_session_id: 'session-1',
    id: 'support_conversation_1',
    last_message_at: '2026-07-29T01:00:00.000Z',
    status: 'open' as const,
    summary: null,
    updated_at: '2026-07-29T01:00:00.000Z',
    user_id_hash: 'a'.repeat(64),
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    citation_count: null,
    content: 'XXYY Pro 怎么升级？',
    conversation_id: 'support_conversation_1',
    created_at: '2026-07-29T01:00:00.000Z',
    id: 'support_message_1',
    intent: null,
    request_id: null,
    role: 'user' as const,
    ...overrides,
  };
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    assigned_to: null,
    conversation_id: 'support_conversation_1',
    created_at: '2026-07-29T01:00:00.000Z',
    id: 'support_ticket_1',
    priority: 'normal' as const,
    reason: 'low_evidence' as const,
    resolution: null,
    resolved_at: null,
    status: 'open' as const,
    subject: '无法确认 Pro 权益',
    updated_at: '2026-07-29T01:00:00.000Z',
    ...overrides,
  };
}
