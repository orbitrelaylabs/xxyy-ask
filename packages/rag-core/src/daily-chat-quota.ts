import { createHash } from 'node:crypto';

import type { PgClientLike } from './pgvector-store.js';

export interface DailyChatQuotaResult {
  allowed: boolean;
  limit: number;
  quotaDate: string;
  remaining: number;
  used: number;
}

export interface PgDailyChatQuotaStore {
  consume(input: {
    identity: string;
    limit: number;
    now?: Date;
    timeZone: string;
  }): Promise<DailyChatQuotaResult>;
  migrate(): Promise<void>;
}

interface DailyChatQuotaRow {
  allowed: boolean;
  usage_count: number;
}

export function createPgDailyChatQuotaStore(options: {
  client: PgClientLike;
  hashSalt?: string;
}): PgDailyChatQuotaStore {
  const hashSalt = options.hashSalt ?? 'xxyy-daily-chat-quota';
  return {
    migrate: () => migrateDailyChatQuota(options.client),
    async consume(input) {
      const limit = normalizeLimit(input.limit);
      const quotaDate = quotaDateInTimeZone(input.now ?? new Date(), input.timeZone);
      const response = await options.client.query<DailyChatQuotaRow>(
        `
        with consumed as (
          insert into daily_chat_quotas (identity_hash, quota_date, usage_count)
          values ($1, $2::date, 1)
          on conflict (identity_hash, quota_date) do update
          set usage_count = daily_chat_quotas.usage_count + 1,
              updated_at = now()
          where daily_chat_quotas.usage_count < $3
          returning usage_count
        ), current_usage as (
          select usage_count
          from daily_chat_quotas
          where identity_hash = $1 and quota_date = $2::date
        )
        select usage_count, true as allowed from consumed
        union all
        select usage_count, false as allowed from current_usage
        where not exists (select 1 from consumed)
        limit 1
        `,
        [hashIdentity(input.identity, hashSalt), quotaDate, limit],
      );
      const row = response.rows[0];
      const used = row?.usage_count ?? limit;
      return {
        allowed: row?.allowed ?? false,
        limit,
        quotaDate,
        remaining: Math.max(0, limit - used),
        used,
      };
    },
  };
}

export async function migrateDailyChatQuota(client: PgClientLike): Promise<void> {
  await client.query(`
    create table if not exists daily_chat_quotas (
      identity_hash text not null,
      quota_date date not null,
      usage_count integer not null check (usage_count >= 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (identity_hash, quota_date)
    )
  `);
  await client.query(
    `create index if not exists daily_chat_quotas_date_idx on daily_chat_quotas (quota_date desc)`,
  );
}

export function quotaDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const year = read('year');
  const month = read('month');
  const day = read('day');
  if (!/^\d{4}$/u.test(year) || !/^\d{2}$/u.test(month) || !/^\d{2}$/u.test(day)) {
    throw new TypeError(`Unable to calculate quota date for time zone ${timeZone}.`);
  }
  return `${year}-${month}-${day}`;
}

function hashIdentity(identity: string, salt: string): string {
  const normalized = identity.trim();
  if (normalized.length === 0 || normalized.length > 1_000) {
    throw new TypeError('Daily chat quota identity must contain 1 to 1000 characters.');
  }
  return createHash('sha256').update(`${salt}:${normalized}`).digest('hex');
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new TypeError('Daily chat limit must be an integer from 1 to 1000000.');
  }
  return limit;
}
