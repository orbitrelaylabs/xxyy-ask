import type { PgClientLike } from './pgvector-store.js';
import { quotaDateInTimeZone } from './daily-chat-quota.js';

export type TelegramBotUserStatus = 'active' | 'disabled';

export interface TelegramBotUser {
  createdAt: string;
  dailyLimit: number | null;
  displayName?: string;
  status: TelegramBotUserStatus;
  telegramUserId: string;
  todayUsed: number;
  updatedAt: string;
  username?: string;
}

export interface TelegramUserIdentity {
  displayName?: string;
  telegramUserId: string;
  username?: string;
}

export interface TelegramBotAccessResult {
  allowed: boolean;
  dailyLimit: number | null;
  quotaDate: string;
  reason: 'allowed' | 'not_allowed' | 'quota_exhausted';
  remaining: number | null;
  used: number;
}

export interface PgTelegramBotAccessStore {
  authorizeAndConsume(input: {
    now?: Date;
    telegramUserId: string;
    timeZone: string;
  }): Promise<TelegramBotAccessResult>;
  createUser(input: {
    actor: string;
    dailyLimit: number | null;
    displayName?: string;
    telegramUserId: string;
  }): Promise<TelegramBotUser>;
  listUsers(input: { now?: Date; timeZone: string }): Promise<TelegramBotUser[]>;
  migrate(): Promise<void>;
  observeUser(input: TelegramUserIdentity): Promise<void>;
  resolveUserReference(reference: string): Promise<TelegramUserIdentity | undefined>;
  updateUser(input: {
    actor: string;
    dailyLimit?: number | null;
    displayName?: string | null;
    status?: TelegramBotUserStatus;
    telegramUserId: string;
  }): Promise<TelegramBotUser>;
}

interface TelegramBotUserRow {
  created_at: string;
  daily_limit: number | null;
  display_name: string | null;
  status: TelegramBotUserStatus;
  telegram_user_id: string;
  today_used: number;
  updated_at: string;
  username: string | null;
}

interface TelegramBotAccessRow {
  daily_limit: number | null;
  reason: TelegramBotAccessResult['reason'];
  usage_count: number;
}

const USER_COLUMNS = `
  telegram_user_id,
  display_name,
  daily_limit,
  status,
  0::integer as today_used,
  created_at::text as created_at,
  updated_at::text as updated_at,
  null::text as username
`;

export function createPgTelegramBotAccessStore(options: {
  client: PgClientLike;
}): PgTelegramBotAccessStore {
  return {
    async authorizeAndConsume(input) {
      const telegramUserId = normalizeTelegramBotUserId(input.telegramUserId);
      const quotaDate = quotaDateInTimeZone(input.now ?? new Date(), input.timeZone);
      const response = await options.client.query<TelegramBotAccessRow>(
        `
        with configured as (
          select telegram_user_id, daily_limit, status
          from telegram_bot_users
          where telegram_user_id = $1
        ), consumed as (
          insert into telegram_bot_daily_usage (telegram_user_id, quota_date, usage_count)
          select telegram_user_id, $2::date, 1
          from configured
          where status = 'active'
          on conflict (telegram_user_id, quota_date) do update
          set usage_count = telegram_bot_daily_usage.usage_count + 1,
              updated_at = now()
          where
            (select daily_limit from configured) is null
            or telegram_bot_daily_usage.usage_count < (select daily_limit from configured)
          returning usage_count
        ), current_usage as (
          select usage_count
          from telegram_bot_daily_usage
          where telegram_user_id = $1 and quota_date = $2::date
        )
        select
          configured.daily_limit,
          case
            when configured.telegram_user_id is null or configured.status <> 'active'
              then 'not_allowed'
            when exists (select 1 from consumed)
              then 'allowed'
            else 'quota_exhausted'
          end as reason,
          coalesce(
            (select usage_count from consumed),
            (select usage_count from current_usage),
            0
          )::integer as usage_count
        from (select 1) seed
        left join configured on true
        `,
        [telegramUserId, quotaDate],
      );
      const row = response.rows[0];
      const reason = row?.reason ?? 'not_allowed';
      const dailyLimit = row?.daily_limit ?? null;
      const used = row?.usage_count ?? 0;
      return {
        allowed: reason === 'allowed',
        dailyLimit,
        quotaDate,
        reason,
        remaining: dailyLimit === null ? null : Math.max(0, dailyLimit - used),
        used,
      };
    },

    async createUser(input) {
      const telegramUserId = normalizeTelegramBotUserId(input.telegramUserId);
      const displayName = normalizeDisplayName(input.displayName);
      const dailyLimit = normalizeDailyLimit(input.dailyLimit);
      const actor = normalizeActor(input.actor);
      const response = await options.client.query<TelegramBotUserRow>(
        `
        insert into telegram_bot_users (
          telegram_user_id, display_name, daily_limit, status, created_by, updated_by
        )
        values ($1, $2, $3, 'active', $4, $4)
        returning ${USER_COLUMNS}
        `,
        [telegramUserId, displayName, dailyLimit, actor],
      );
      return requireUser(response.rows[0], telegramUserId);
    },

    async listUsers(input) {
      const quotaDate = quotaDateInTimeZone(input.now ?? new Date(), input.timeZone);
      const response = await options.client.query<TelegramBotUserRow>(
        `
        select
          users.telegram_user_id,
          identities.username,
          users.display_name,
          users.daily_limit,
          users.status,
          coalesce(usage.usage_count, 0)::integer as today_used,
          users.created_at::text as created_at,
          users.updated_at::text as updated_at
        from telegram_bot_users users
        left join telegram_user_identities identities
          on identities.telegram_user_id = users.telegram_user_id
        left join telegram_bot_daily_usage usage
          on usage.telegram_user_id = users.telegram_user_id
          and usage.quota_date = $1::date
        order by users.created_at desc, users.telegram_user_id
        `,
        [quotaDate],
      );
      return response.rows.map(mapUser);
    },

    migrate: () => migrateTelegramBotAccess(options.client),

    async observeUser(input) {
      const telegramUserId = normalizeTelegramBotUserId(input.telegramUserId);
      const username = normalizeTelegramUsername(input.username);
      const displayName = normalizeDisplayName(input.displayName);
      if (username !== null) {
        await options.client.query(
          `
          update telegram_user_identities
          set username = null, updated_at = now()
          where lower(username) = lower($1) and telegram_user_id <> $2
          `,
          [username, telegramUserId],
        );
      }
      await options.client.query(
        `
        insert into telegram_user_identities (
          telegram_user_id, username, display_name, last_seen_at, updated_at
        )
        values ($1, $2, $3, now(), now())
        on conflict (telegram_user_id) do update
        set username = excluded.username,
            display_name = excluded.display_name,
            last_seen_at = now(),
            updated_at = now()
        `,
        [telegramUserId, username, displayName],
      );
    },

    async resolveUserReference(reference) {
      const normalized = reference.trim();
      if (/^(?:telegram:)?[1-9]\d{0,19}$/u.test(normalized)) {
        return { telegramUserId: normalizeTelegramBotUserId(normalized) };
      }
      const username = normalizeTelegramUsername(normalized);
      if (username === null) return undefined;
      const response = await options.client.query<{
        display_name: string | null;
        telegram_user_id: string;
        username: string | null;
      }>(
        `
        select telegram_user_id, username, display_name
        from telegram_user_identities
        where lower(username) = lower($1)
        `,
        [username],
      );
      const row = response.rows[0];
      if (row === undefined) return undefined;
      return {
        ...(row.display_name === null ? {} : { displayName: row.display_name }),
        telegramUserId: row.telegram_user_id,
        ...(row.username === null ? {} : { username: row.username }),
      };
    },

    async updateUser(input) {
      const telegramUserId = normalizeTelegramBotUserId(input.telegramUserId);
      const actor = normalizeActor(input.actor);
      const hasDisplayName = input.displayName !== undefined;
      const displayName =
        input.displayName === null ? null : normalizeDisplayName(input.displayName);
      const hasDailyLimit = input.dailyLimit !== undefined;
      const dailyLimit =
        input.dailyLimit === undefined ? null : normalizeDailyLimit(input.dailyLimit);
      const hasStatus = input.status !== undefined;
      const status = input.status === undefined ? null : normalizeStatus(input.status);
      if (!hasDisplayName && !hasDailyLimit && !hasStatus) {
        throw new TypeError('At least one Telegram Bot user field is required.');
      }
      const response = await options.client.query<TelegramBotUserRow>(
        `
        update telegram_bot_users
        set
          display_name = case when $2 then $3 else display_name end,
          daily_limit = case when $4 then $5 else daily_limit end,
          status = case when $6 then $7 else status end,
          updated_by = $8,
          updated_at = now()
        where telegram_user_id = $1
        returning ${USER_COLUMNS}
        `,
        [
          telegramUserId,
          hasDisplayName,
          displayName,
          hasDailyLimit,
          dailyLimit,
          hasStatus,
          status,
          actor,
        ],
      );
      return requireUser(response.rows[0], telegramUserId);
    },
  };
}

export async function migrateTelegramBotAccess(client: PgClientLike): Promise<void> {
  await client.query(`
    create table if not exists telegram_user_identities (
      telegram_user_id text primary key check (telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
      username text,
      display_name text,
      last_seen_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await client.query(`
    create unique index if not exists telegram_user_identities_username_idx
    on telegram_user_identities (lower(username))
    where username is not null
  `);
  await client.query(`
    create table if not exists telegram_bot_users (
      telegram_user_id text primary key check (telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
      display_name text,
      daily_limit integer check (daily_limit between 1 and 1000000),
      status text not null default 'active' check (status in ('active', 'disabled')),
      created_by text not null,
      updated_by text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await client.query(`
    create table if not exists telegram_bot_daily_usage (
      telegram_user_id text not null references telegram_bot_users (telegram_user_id),
      quota_date date not null,
      usage_count integer not null check (usage_count >= 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (telegram_user_id, quota_date)
    )
  `);
  await client.query(
    `create index if not exists telegram_bot_daily_usage_date_idx on telegram_bot_daily_usage (quota_date desc)`,
  );
}

export function normalizeTelegramBotUserId(value: string): string {
  const normalized = value.trim().replace(/^telegram:/u, '');
  if (!/^[1-9]\d{0,19}$/u.test(normalized)) {
    throw new TypeError('Telegram user id must be a positive numeric identifier.');
  }
  return normalized;
}

function normalizeDailyLimit(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new TypeError('Telegram daily limit must be null or an integer from 1 to 1000000.');
  }
  return value;
}

function normalizeDisplayName(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) return null;
  if (normalized.length > 160) {
    throw new TypeError('Telegram user display name must contain at most 160 characters.');
  }
  return normalized;
}

function normalizeTelegramUsername(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^@/u, '');
  if (normalized === undefined || normalized.length === 0) return null;
  if (!/^[A-Za-z0-9_]{5,32}$/u.test(normalized)) {
    throw new TypeError('Telegram username must contain 5 to 32 letters, digits, or underscores.');
  }
  return normalized;
}

function normalizeActor(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new TypeError('Telegram Bot access actor must contain 1 to 200 characters.');
  }
  return normalized;
}

function normalizeStatus(value: TelegramBotUserStatus): TelegramBotUserStatus {
  if (value !== 'active' && value !== 'disabled') {
    throw new TypeError('Telegram Bot user status is invalid.');
  }
  return value;
}

function requireUser(row: TelegramBotUserRow | undefined, telegramUserId: string): TelegramBotUser {
  if (row === undefined) {
    throw new Error(`Telegram Bot user ${telegramUserId} was not found.`);
  }
  return mapUser(row);
}

function mapUser(row: TelegramBotUserRow): TelegramBotUser {
  return {
    createdAt: row.created_at,
    dailyLimit: row.daily_limit,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    status: row.status,
    telegramUserId: row.telegram_user_id,
    todayUsed: row.today_used,
    updatedAt: row.updated_at,
    ...(row.username == null ? {} : { username: row.username }),
  };
}
