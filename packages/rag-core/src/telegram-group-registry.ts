import type { PgClientLike } from './pgvector-store.js';

export type TelegramGroupChatType = 'group' | 'supergroup';
export type TelegramGroupMembershipStatus = 'active' | 'kicked' | 'left' | 'unknown';
export type TelegramGroupObservationSource = 'message' | 'my_chat_member';

export interface TelegramGroupRegistryEntry {
  chatId: string;
  chatType: TelegramGroupChatType;
  firstSeenAt: string;
  lastSeenAt: string;
  membershipStatus: TelegramGroupMembershipStatus;
  observationSource: TelegramGroupObservationSource;
  updatedAt: string;
  joinedAt?: string;
  lastMessageAt?: string;
  leftAt?: string;
  title?: string;
}

export interface ObserveTelegramGroupMessageInput {
  chatId: string;
  chatType: TelegramGroupChatType;
  observedAt: string;
  title?: string;
}

export interface ObserveTelegramGroupMembershipInput {
  chatId: string;
  chatType: TelegramGroupChatType;
  membershipStatus: TelegramGroupMembershipStatus;
  observedAt: string;
  title?: string;
}

export interface ListTelegramGroupsOptions {
  limit?: number;
  membershipStatus?: TelegramGroupMembershipStatus;
}

export interface PgTelegramGroupRegistryStore {
  list(options?: ListTelegramGroupsOptions): Promise<TelegramGroupRegistryEntry[]>;
  migrate(): Promise<void>;
  observeMembership(
    input: ObserveTelegramGroupMembershipInput,
  ): Promise<TelegramGroupRegistryEntry>;
  observeMessage(input: ObserveTelegramGroupMessageInput): Promise<TelegramGroupRegistryEntry>;
}

interface TelegramGroupRegistryRow {
  chat_id: string;
  chat_type: TelegramGroupChatType;
  first_seen_at: string;
  joined_at: string | null;
  last_message_at: string | null;
  last_seen_at: string;
  left_at: string | null;
  membership_status: TelegramGroupMembershipStatus;
  observation_source: TelegramGroupObservationSource;
  title: string | null;
  updated_at: string;
}

const TELEGRAM_GROUP_COLUMNS = `
  chat_id,
  title,
  chat_type,
  membership_status,
  observation_source,
  first_seen_at::text as first_seen_at,
  joined_at::text as joined_at,
  left_at::text as left_at,
  last_message_at::text as last_message_at,
  last_seen_at::text as last_seen_at,
  updated_at::text as updated_at
`;

export function createPgTelegramGroupRegistryStore(options: {
  client: PgClientLike;
}): PgTelegramGroupRegistryStore {
  return {
    async list(input: ListTelegramGroupsOptions = {}): Promise<TelegramGroupRegistryEntry[]> {
      const values: unknown[] = [];
      const predicates: string[] = [];
      if (input.membershipStatus !== undefined) {
        values.push(normalizeMembershipStatus(input.membershipStatus));
        predicates.push(`membership_status = $${values.length}`);
      }
      values.push(normalizeLimit(input.limit));
      const response = await options.client.query<TelegramGroupRegistryRow>(
        `
        select ${TELEGRAM_GROUP_COLUMNS}
        from telegram_group_registry
        ${predicates.length === 0 ? '' : `where ${predicates.join(' and ')}`}
        order by last_seen_at desc, chat_id
        limit $${values.length}
        `,
        values,
      );
      return response.rows.map(mapTelegramGroupRegistryRow);
    },

    migrate() {
      return migrateTelegramGroupRegistry(options.client);
    },

    async observeMembership(input): Promise<TelegramGroupRegistryEntry> {
      const chatId = normalizeChatId(input.chatId);
      const chatType = normalizeChatType(input.chatType);
      const membershipStatus = normalizeMembershipStatus(input.membershipStatus);
      const observedAt = normalizeTimestamp(input.observedAt);
      const title = normalizeTitle(input.title);
      const active = membershipStatus === 'active';
      const response = await options.client.query<TelegramGroupRegistryRow>(
        `
        insert into telegram_group_registry (
          chat_id, title, chat_type, membership_status, observation_source,
          first_seen_at, joined_at, left_at, last_seen_at, updated_at
        )
        values (
          $1, $2, $3, $4, 'my_chat_member',
          $5::timestamptz,
          case when $6::boolean then $5::timestamptz else null end,
          case when $6::boolean then null else $5::timestamptz end,
          $5::timestamptz, now()
        )
        on conflict (chat_id) do update
        set
          title = coalesce(excluded.title, telegram_group_registry.title),
          chat_type = excluded.chat_type,
          membership_status = excluded.membership_status,
          observation_source = excluded.observation_source,
          joined_at = case
            when excluded.membership_status = 'active'
              and telegram_group_registry.membership_status <> 'active'
              then excluded.last_seen_at
            when excluded.membership_status = 'active'
              then coalesce(telegram_group_registry.joined_at, excluded.last_seen_at)
            else telegram_group_registry.joined_at
          end,
          left_at = case
            when excluded.membership_status = 'active' then null
            else excluded.last_seen_at
          end,
          last_seen_at = greatest(telegram_group_registry.last_seen_at, excluded.last_seen_at),
          updated_at = now()
        returning ${TELEGRAM_GROUP_COLUMNS}
        `,
        [chatId, title ?? null, chatType, membershipStatus, observedAt, active],
      );
      return requireRegistryRow(response.rows[0]);
    },

    async observeMessage(input): Promise<TelegramGroupRegistryEntry> {
      const chatId = normalizeChatId(input.chatId);
      const chatType = normalizeChatType(input.chatType);
      const observedAt = normalizeTimestamp(input.observedAt);
      const title = normalizeTitle(input.title);
      const response = await options.client.query<TelegramGroupRegistryRow>(
        `
        insert into telegram_group_registry (
          chat_id, title, chat_type, membership_status, observation_source,
          first_seen_at, joined_at, last_message_at, last_seen_at, updated_at
        )
        values (
          $1, $2, $3, 'active', 'message',
          $4::timestamptz, $4::timestamptz, $4::timestamptz, $4::timestamptz, now()
        )
        on conflict (chat_id) do update
        set
          title = coalesce(excluded.title, telegram_group_registry.title),
          chat_type = excluded.chat_type,
          membership_status = 'active',
          observation_source = 'message',
          joined_at = case
            when telegram_group_registry.membership_status <> 'active'
              then excluded.last_seen_at
            else coalesce(telegram_group_registry.joined_at, excluded.last_seen_at)
          end,
          left_at = null,
          last_message_at = greatest(
            coalesce(telegram_group_registry.last_message_at, excluded.last_message_at),
            excluded.last_message_at
          ),
          last_seen_at = greatest(telegram_group_registry.last_seen_at, excluded.last_seen_at),
          updated_at = now()
        returning ${TELEGRAM_GROUP_COLUMNS}
        `,
        [chatId, title ?? null, chatType, observedAt],
      );
      return requireRegistryRow(response.rows[0]);
    },
  };
}

export async function migrateTelegramGroupRegistry(client: PgClientLike): Promise<void> {
  await client.query(
    `
    create table if not exists telegram_group_registry (
      chat_id text primary key,
      title text,
      chat_type text not null check (chat_type in ('group', 'supergroup')),
      membership_status text not null check (
        membership_status in ('active', 'kicked', 'left', 'unknown')
      ),
      observation_source text not null check (
        observation_source in ('message', 'my_chat_member')
      ),
      first_seen_at timestamptz not null,
      joined_at timestamptz,
      left_at timestamptz,
      last_message_at timestamptz,
      last_seen_at timestamptz not null,
      updated_at timestamptz not null default now()
    )
    `,
  );
  await client.query(
    `
    create index if not exists telegram_group_registry_status_seen_idx
      on telegram_group_registry (membership_status, last_seen_at desc)
    `,
  );
}

function requireRegistryRow(row: TelegramGroupRegistryRow | undefined): TelegramGroupRegistryEntry {
  if (row === undefined) {
    throw new Error('Telegram group registry update did not return a row.');
  }
  return mapTelegramGroupRegistryRow(row);
}

function mapTelegramGroupRegistryRow(row: TelegramGroupRegistryRow): TelegramGroupRegistryEntry {
  return {
    chatId: row.chat_id,
    chatType: row.chat_type,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    membershipStatus: row.membership_status,
    observationSource: row.observation_source,
    updatedAt: row.updated_at,
    ...(row.joined_at === null ? {} : { joinedAt: row.joined_at }),
    ...(row.last_message_at === null ? {} : { lastMessageAt: row.last_message_at }),
    ...(row.left_at === null ? {} : { leftAt: row.left_at }),
    ...(row.title === null ? {} : { title: row.title }),
  };
}

function normalizeChatId(value: string): string {
  const normalized = value.trim();
  if (!/^-\d{1,31}$/u.test(normalized)) {
    throw new Error('Telegram group chatId must be a negative numeric identifier.');
  }
  return normalized;
}

function normalizeChatType(value: TelegramGroupChatType): TelegramGroupChatType {
  if (value !== 'group' && value !== 'supergroup') {
    throw new Error('Telegram group chatType must be group or supergroup.');
  }
  return value;
}

function normalizeMembershipStatus(
  value: TelegramGroupMembershipStatus,
): TelegramGroupMembershipStatus {
  if (!['active', 'kicked', 'left', 'unknown'].includes(value)) {
    throw new Error('Unsupported Telegram group membership status.');
  }
  return value;
}

function normalizeTimestamp(value: string): string {
  const normalized = value.trim();
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error('Telegram group observedAt must be an ISO timestamp.');
  }
  return new Date(normalized).toISOString();
}

function normalizeTitle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  return normalized.slice(0, 255);
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw new Error('Telegram group list limit must be between 1 and 500.');
  }
  return value;
}
