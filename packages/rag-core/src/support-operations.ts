import { createHash, randomUUID } from 'node:crypto';

import type { ChatChannel, Intent } from '@xxyy/shared';

import type { PgClientLike } from './pgvector-store.js';
import { redactSensitiveSupportText } from './redaction.js';

export type SupportConversationStatus = 'closed' | 'escalated' | 'open' | 'resolved';
export type SupportMessageRole = 'assistant' | 'support_agent' | 'system' | 'user';
export type SupportTicketPriority = 'high' | 'low' | 'normal' | 'urgent';
export type SupportTicketStatus = 'closed' | 'in_progress' | 'open' | 'resolved' | 'waiting_user';
export type SupportEscalationReason =
  | 'account_or_private_data'
  | 'explicit_human_request'
  | 'low_evidence'
  | 'negative_feedback'
  | 'repeated_unresolved'
  | 'other';

export interface SupportConversation {
  channel: ChatChannel;
  createdAt: string;
  externalSessionId: string;
  id: string;
  lastMessageAt: string;
  status: SupportConversationStatus;
  updatedAt: string;
  summary?: string;
  userIdHash?: string;
}

export interface SupportConversationMessage {
  content: string;
  conversationId: string;
  createdAt: string;
  id: string;
  role: SupportMessageRole;
  citationCount?: number;
  intent?: Intent;
  requestId?: string;
}

export interface SupportTicket {
  conversationId: string;
  createdAt: string;
  id: string;
  priority: SupportTicketPriority;
  reason: SupportEscalationReason;
  status: SupportTicketStatus;
  subject: string;
  updatedAt: string;
  assignedTo?: string;
  resolution?: string;
  resolvedAt?: string;
}

export interface SupportOperationsMetrics {
  activeConversationCount: number;
  openTicketCount: number;
  unassignedTicketCount: number;
  waitingUserTicketCount: number;
}

export interface ListSupportTicketsOptions {
  assignee?: string;
  limit?: number;
  status?: SupportTicketStatus;
}

export interface PgSupportOperationsStore {
  appendMessage(input: {
    content: string;
    conversationId: string;
    role: SupportMessageRole;
    citationCount?: number;
    intent?: Intent;
    requestId?: string;
  }): Promise<SupportConversationMessage>;
  createTicket(input: {
    conversationId: string;
    reason: SupportEscalationReason;
    subject: string;
    priority?: SupportTicketPriority;
  }): Promise<SupportTicket>;
  ensureConversation(input: {
    channel: ChatChannel;
    externalSessionId: string;
    userId?: string;
  }): Promise<SupportConversation>;
  getConversation(id: string): Promise<SupportConversation | undefined>;
  getConversationByExternalSessionId(
    externalSessionId: string,
  ): Promise<SupportConversation | undefined>;
  getMetrics(): Promise<SupportOperationsMetrics>;
  getRecentMessages(
    conversationId: string,
    options?: { limit?: number },
  ): Promise<SupportConversationMessage[]>;
  getTicket(id: string): Promise<SupportTicket | undefined>;
  listTickets(options?: ListSupportTicketsOptions): Promise<SupportTicket[]>;
  migrate(): Promise<void>;
  updateTicket(input: {
    actor: string;
    id: string;
    assignedTo?: string | null;
    priority?: SupportTicketPriority;
    resolution?: string;
    status?: SupportTicketStatus;
  }): Promise<SupportTicket>;
}

interface SupportConversationRow {
  channel: ChatChannel;
  created_at: string;
  external_session_id: string;
  id: string;
  last_message_at: string;
  status: SupportConversationStatus;
  summary: string | null;
  updated_at: string;
  user_id_hash: string | null;
}

interface SupportMessageRow {
  citation_count: number | null;
  content: string;
  conversation_id: string;
  created_at: string;
  id: string;
  intent: Intent | null;
  request_id: string | null;
  role: SupportMessageRole;
}

interface SupportTicketRow {
  assigned_to: string | null;
  conversation_id: string;
  created_at: string;
  id: string;
  priority: SupportTicketPriority;
  reason: SupportEscalationReason;
  resolution: string | null;
  resolved_at: string | null;
  status: SupportTicketStatus;
  subject: string;
  updated_at: string;
}

interface SupportMetricsRow {
  active_conversation_count: number;
  open_ticket_count: number;
  unassigned_ticket_count: number;
  waiting_user_ticket_count: number;
}

const CONVERSATION_COLUMNS = `
  id,
  external_session_id,
  channel,
  user_id_hash,
  status,
  summary,
  last_message_at::text as last_message_at,
  created_at::text as created_at,
  updated_at::text as updated_at
`;

const MESSAGE_COLUMNS = `
  id,
  conversation_id,
  role,
  content,
  request_id,
  intent,
  citation_count,
  created_at::text as created_at
`;

const TICKET_COLUMNS = `
  id,
  conversation_id,
  status,
  priority,
  reason,
  subject,
  assigned_to,
  resolution,
  resolved_at::text as resolved_at,
  created_at::text as created_at,
  updated_at::text as updated_at
`;

const ACTIVE_TICKET_STATUSES: readonly SupportTicketStatus[] = [
  'open',
  'in_progress',
  'waiting_user',
];

export class SupportConversationNotFoundError extends Error {
  constructor(id: string) {
    super(`Support conversation ${id} was not found.`);
    this.name = 'SupportConversationNotFoundError';
  }
}

export class SupportTicketNotFoundError extends Error {
  constructor(id: string) {
    super(`Support ticket ${id} was not found.`);
    this.name = 'SupportTicketNotFoundError';
  }
}

export function createPgSupportOperationsStore(options: {
  client: PgClientLike;
}): PgSupportOperationsStore {
  return {
    async appendMessage(input): Promise<SupportConversationMessage> {
      const response = await queryDatabase<SupportMessageRow>(
        options.client,
        `
        with inserted as (
          insert into support_conversation_messages (
            id, conversation_id, role, content, request_id, intent, citation_count
          )
          values ($1, $2, $3, $4, $5, $6, $7)
          returning ${MESSAGE_COLUMNS}
        ), touched as (
          update support_conversations
          set last_message_at = now(), updated_at = now()
          where id = $2
          returning id
        )
        select ${MESSAGE_COLUMNS}
        from inserted
        `,
        [
          `support_message_${randomUUID()}`,
          normalizeIdentifier(input.conversationId, 'conversationId'),
          normalizeMessageRole(input.role),
          sanitizeStoredSupportText(input.content, 'content', 16_000),
          normalizeOptionalText(input.requestId, 'requestId', 256) ?? null,
          input.intent ?? null,
          input.citationCount === undefined
            ? null
            : normalizeNonNegativeInteger(input.citationCount, 'citationCount'),
        ],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new SupportConversationNotFoundError(input.conversationId);
      }
      return mapSupportMessage(row);
    },

    async createTicket(input): Promise<SupportTicket> {
      return withTransaction(options.client, async (client) => {
        const conversationId = normalizeIdentifier(input.conversationId, 'conversationId');
        const conversation = await queryDatabase<{ id: string }>(
          client,
          `
          select id
          from support_conversations
          where id = $1
          for update
          `,
          [conversationId],
        );
        if (conversation.rows[0] === undefined) {
          throw new SupportConversationNotFoundError(conversationId);
        }

        const existing = await queryDatabase<SupportTicketRow>(
          client,
          `
          select ${TICKET_COLUMNS}
          from support_tickets
          where conversation_id = $1 and status = any($2::text[])
          order by created_at desc, id
          limit 1
          `,
          [conversationId, ACTIVE_TICKET_STATUSES],
        );
        if (existing.rows[0] !== undefined) {
          return mapSupportTicket(existing.rows[0]);
        }

        const response = await queryDatabase<SupportTicketRow>(
          client,
          `
          with inserted as (
            insert into support_tickets (
              id, conversation_id, status, priority, reason, subject
            )
            values ($1, $2, 'open', $3, $4, $5)
            returning ${TICKET_COLUMNS}
          ), conversation_updated as (
            update support_conversations
            set status = 'escalated', updated_at = now()
            where id = $2
          ), audited as (
            insert into support_ticket_events (
              ticket_id, event_type, actor, details
            )
            select id, 'ticket_created', 'system:customer-agent',
              jsonb_build_object('reason', reason, 'priority', priority)
            from inserted
          )
          select ${TICKET_COLUMNS}
          from inserted
          `,
          [
            `support_ticket_${randomUUID()}`,
            conversationId,
            normalizeTicketPriority(input.priority ?? 'normal'),
            normalizeEscalationReason(input.reason),
            sanitizeStoredSupportText(input.subject, 'subject', 500),
          ],
        );
        return mapSupportTicket(response.rows[0]!);
      });
    },

    async ensureConversation(input): Promise<SupportConversation> {
      const externalSessionId = normalizeExternalSessionId(input.externalSessionId);
      const response = await queryDatabase<SupportConversationRow>(
        options.client,
        `
        insert into support_conversations (
          id, external_session_id, channel, user_id_hash
        )
        values ($1, $2, $3, $4)
        on conflict (external_session_id) do update
        set
          channel = excluded.channel,
          user_id_hash = coalesce(support_conversations.user_id_hash, excluded.user_id_hash),
          updated_at = now()
        returning ${CONVERSATION_COLUMNS}
        `,
        [
          `support_conversation_${randomUUID()}`,
          externalSessionId,
          input.channel,
          input.userId === undefined ? null : hashUserId(input.userId),
        ],
      );
      return mapSupportConversation(response.rows[0]!);
    },

    async getConversation(id): Promise<SupportConversation | undefined> {
      const response = await queryDatabase<SupportConversationRow>(
        options.client,
        `
        select ${CONVERSATION_COLUMNS}
        from support_conversations
        where id = $1
        `,
        [normalizeIdentifier(id, 'id')],
      );
      return response.rows[0] === undefined ? undefined : mapSupportConversation(response.rows[0]);
    },

    async getConversationByExternalSessionId(externalSessionId) {
      const response = await queryDatabase<SupportConversationRow>(
        options.client,
        `
        select ${CONVERSATION_COLUMNS}
        from support_conversations
        where external_session_id = $1
        `,
        [normalizeExternalSessionId(externalSessionId)],
      );
      return response.rows[0] === undefined ? undefined : mapSupportConversation(response.rows[0]);
    },

    async getMetrics(): Promise<SupportOperationsMetrics> {
      const response = await queryDatabase<SupportMetricsRow>(
        options.client,
        `
        select
          (
            select count(*)::integer
            from support_conversations
            where status in ('open', 'escalated')
          ) as active_conversation_count,
          (
            select count(*)::integer
            from support_tickets
            where status = any($1::text[])
          ) as open_ticket_count,
          (
            select count(*)::integer
            from support_tickets
            where status = any($1::text[]) and assigned_to is null
          ) as unassigned_ticket_count,
          (
            select count(*)::integer
            from support_tickets
            where status = 'waiting_user'
          ) as waiting_user_ticket_count
        `,
        [ACTIVE_TICKET_STATUSES],
      );
      const row = response.rows[0];
      return {
        activeConversationCount: row?.active_conversation_count ?? 0,
        openTicketCount: row?.open_ticket_count ?? 0,
        unassignedTicketCount: row?.unassigned_ticket_count ?? 0,
        waitingUserTicketCount: row?.waiting_user_ticket_count ?? 0,
      };
    },

    async getRecentMessages(conversationId, messageOptions = {}) {
      const limit = normalizeLimit(messageOptions.limit, 12, 50);
      const response = await queryDatabase<SupportMessageRow>(
        options.client,
        `
        select ${MESSAGE_COLUMNS}
        from (
          select ${MESSAGE_COLUMNS}
          from support_conversation_messages
          where conversation_id = $1
          order by created_at desc, id desc
          limit $2
        ) recent
        order by created_at, id
        `,
        [normalizeIdentifier(conversationId, 'conversationId'), limit],
      );
      return response.rows.map(mapSupportMessage);
    },

    async getTicket(id): Promise<SupportTicket | undefined> {
      const response = await queryDatabase<SupportTicketRow>(
        options.client,
        `
        select ${TICKET_COLUMNS}
        from support_tickets
        where id = $1
        `,
        [normalizeIdentifier(id, 'id')],
      );
      return response.rows[0] === undefined ? undefined : mapSupportTicket(response.rows[0]);
    },

    async listTickets(listOptions = {}): Promise<SupportTicket[]> {
      const response = await queryDatabase<SupportTicketRow>(
        options.client,
        `
        select ${TICKET_COLUMNS}
        from support_tickets
        where
          ($1::text is null or status = $1)
          and ($2::text is null or assigned_to = $2)
        order by
          case priority
            when 'urgent' then 0
            when 'high' then 1
            when 'normal' then 2
            else 3
          end,
          created_at,
          id
        limit $3
        `,
        [
          listOptions.status ?? null,
          normalizeOptionalText(listOptions.assignee, 'assignee', 200) ?? null,
          normalizeLimit(listOptions.limit, 50, 200),
        ],
      );
      return response.rows.map(mapSupportTicket);
    },

    migrate(): Promise<void> {
      return migrateSupportOperations(options.client);
    },

    async updateTicket(input): Promise<SupportTicket> {
      const id = normalizeIdentifier(input.id, 'id');
      const actor = normalizeRequiredText(input.actor, 'actor', 200);
      if (
        input.assignedTo === undefined &&
        input.priority === undefined &&
        input.resolution === undefined &&
        input.status === undefined
      ) {
        const existing = await this.getTicket(id);
        if (existing === undefined) {
          throw new SupportTicketNotFoundError(id);
        }
        return existing;
      }
      const response = await queryDatabase<SupportTicketRow>(
        options.client,
        `
        with updated as (
          update support_tickets
          set
            status = coalesce($2, status),
            priority = coalesce($3, priority),
            assigned_to = case when $4 then $5 else assigned_to end,
            resolution = coalesce($6, resolution),
            resolved_at = case
              when coalesce($2, status) in ('resolved', 'closed') then coalesce(resolved_at, now())
              else null
            end,
            updated_at = now()
          where id = $1
          returning ${TICKET_COLUMNS}
        ), conversation_updated as (
          update support_conversations conversations
          set
            status = case
              when updated.status = 'resolved' then 'resolved'
              when updated.status = 'closed' then 'closed'
              else 'escalated'
            end,
            updated_at = now()
          from updated
          where conversations.id = updated.conversation_id
        ), audited as (
          insert into support_ticket_events (ticket_id, event_type, actor, details)
          select id, 'ticket_updated', $7,
            jsonb_build_object(
              'status', status,
              'priority', priority,
              'assignedToPresent', assigned_to is not null,
              'resolutionPresent', resolution is not null
            )
          from updated
        )
        select ${TICKET_COLUMNS}
        from updated
        `,
        [
          id,
          input.status ?? null,
          input.priority ?? null,
          input.assignedTo !== undefined,
          input.assignedTo === null
            ? null
            : (normalizeOptionalText(input.assignedTo, 'assignedTo', 200) ?? null),
          input.resolution === undefined
            ? null
            : sanitizeStoredSupportText(input.resolution, 'resolution', 8_000),
          actor,
        ],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new SupportTicketNotFoundError(id);
      }
      return mapSupportTicket(row);
    },
  };
}

export async function migrateSupportOperations(client: PgClientLike): Promise<void> {
  await queryDatabase(
    client,
    `
    create table if not exists support_conversations (
      id text primary key,
      external_session_id text not null unique,
      channel text not null check (channel in ('cli', 'web', 'telegram')),
      user_id_hash text,
      status text not null default 'open'
        check (status in ('open', 'escalated', 'resolved', 'closed')),
      summary text,
      last_message_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists support_conversations_status_activity_idx
      on support_conversations (status, last_message_at desc)
    `,
  );
  await queryDatabase(
    client,
    `
    create table if not exists support_conversation_messages (
      id text primary key,
      conversation_id text not null references support_conversations(id) on delete cascade,
      role text not null check (role in ('user', 'assistant', 'support_agent', 'system')),
      content text not null,
      request_id text,
      intent text,
      citation_count integer check (citation_count is null or citation_count >= 0),
      created_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists support_conversation_messages_recent_idx
      on support_conversation_messages (conversation_id, created_at desc, id desc)
    `,
  );
  await queryDatabase(
    client,
    `
    create table if not exists support_tickets (
      id text primary key,
      conversation_id text not null references support_conversations(id),
      status text not null default 'open'
        check (status in ('open', 'in_progress', 'waiting_user', 'resolved', 'closed')),
      priority text not null default 'normal'
        check (priority in ('low', 'normal', 'high', 'urgent')),
      reason text not null
        check (
          reason in (
            'low_evidence',
            'negative_feedback',
            'explicit_human_request',
            'account_or_private_data',
            'repeated_unresolved',
            'other'
          )
        ),
      subject text not null,
      assigned_to text,
      resolution text,
      resolved_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create unique index if not exists support_tickets_one_active_per_conversation_idx
      on support_tickets (conversation_id)
      where status in ('open', 'in_progress', 'waiting_user')
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists support_tickets_queue_idx
      on support_tickets (status, priority, created_at)
    `,
  );
  await queryDatabase(
    client,
    `
    create table if not exists support_ticket_events (
      id bigserial primary key,
      ticket_id text not null references support_tickets(id) on delete cascade,
      event_type text not null,
      actor text not null,
      details jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists support_ticket_events_timeline_idx
      on support_ticket_events (ticket_id, created_at, id)
    `,
  );
}

function mapSupportConversation(row: SupportConversationRow): SupportConversation {
  return {
    channel: row.channel,
    createdAt: row.created_at,
    externalSessionId: row.external_session_id,
    id: row.id,
    lastMessageAt: row.last_message_at,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.user_id_hash === null ? {} : { userIdHash: row.user_id_hash }),
  };
}

function mapSupportMessage(row: SupportMessageRow): SupportConversationMessage {
  return {
    content: row.content,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    id: row.id,
    role: row.role,
    ...(row.citation_count === null ? {} : { citationCount: row.citation_count }),
    ...(row.intent === null ? {} : { intent: row.intent }),
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
  };
}

function mapSupportTicket(row: SupportTicketRow): SupportTicket {
  return {
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    id: row.id,
    priority: row.priority,
    reason: row.reason,
    status: row.status,
    subject: row.subject,
    updatedAt: row.updated_at,
    ...(row.assigned_to === null ? {} : { assignedTo: row.assigned_to }),
    ...(row.resolution === null ? {} : { resolution: row.resolution }),
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  };
}

function sanitizeStoredSupportText(value: string, field: string, maxLength: number): string {
  const normalized = normalizeRequiredText(value, field, maxLength);
  return redactSensitiveSupportText(normalized);
}

function hashUserId(userId: string): string {
  return createHash('sha256')
    .update(normalizeRequiredText(userId, 'userId', 512))
    .digest('hex');
}

function normalizeExternalSessionId(value: string): string {
  return normalizeRequiredText(value, 'externalSessionId', 256);
}

function normalizeIdentifier(value: string, field: string): string {
  const normalized = normalizeRequiredText(value, field, 256);
  if (!/^[A-Za-z0-9:._-]+$/u.test(normalized)) {
    throw new TypeError(`${field} contains unsupported characters.`);
  }
  return normalized;
}

function normalizeMessageRole(value: SupportMessageRole): SupportMessageRole {
  if (['assistant', 'support_agent', 'system', 'user'].includes(value)) {
    return value;
  }
  throw new TypeError('role is invalid.');
}

function normalizeTicketPriority(value: SupportTicketPriority): SupportTicketPriority {
  if (['high', 'low', 'normal', 'urgent'].includes(value)) {
    return value;
  }
  throw new TypeError('priority is invalid.');
}

function normalizeEscalationReason(value: SupportEscalationReason): SupportEscalationReason {
  if (
    [
      'account_or_private_data',
      'explicit_human_request',
      'low_evidence',
      'negative_feedback',
      'other',
      'repeated_unresolved',
    ].includes(value)
  ) {
    return value;
  }
  throw new TypeError('reason is invalid.');
}

function normalizeRequiredText(value: string, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: string | undefined,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return normalizeRequiredText(value, field, maxLength);
}

function normalizeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer.`);
  }
  return value;
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`limit must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

async function queryDatabase<T>(
  client: PgClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  return client.query<T>(sql, values);
}

async function withTransaction<T>(
  client: PgClientLike,
  operation: (transaction: PgClientLike) => Promise<T>,
): Promise<T> {
  if (client.connect === undefined) {
    await client.query('begin');
    try {
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
  const transaction = await client.connect();
  try {
    await transaction.query('begin');
    const result = await operation(transaction);
    await transaction.query('commit');
    return result;
  } catch (error) {
    await transaction.query('rollback');
    throw error;
  } finally {
    transaction.release();
  }
}
