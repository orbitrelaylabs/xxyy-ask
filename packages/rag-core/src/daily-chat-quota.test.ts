import { describe, expect, it } from 'vitest';

import { createPgDailyChatQuotaStore, quotaDateInTimeZone } from './daily-chat-quota.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

describe('daily chat quota', () => {
  it('uses the configured time zone for natural-day boundaries', () => {
    const instant = new Date('2026-08-04T16:30:00.000Z');
    expect(quotaDateInTimeZone(instant, 'Asia/Shanghai')).toBe('2026-08-05');
    expect(quotaDateInTimeZone(instant, 'UTC')).toBe('2026-08-04');
  });

  it('atomically consumes quota without storing the raw identity', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ allowed: true, usage_count: 7 }]];
    const result = await createPgDailyChatQuotaStore({ client, hashSalt: 'test-salt' }).consume({
      identity: 'telegram:user:12345',
      limit: 10,
      now: new Date('2026-08-04T01:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });
    expect(result).toEqual({
      allowed: true,
      limit: 10,
      quotaDate: '2026-08-04',
      remaining: 3,
      used: 7,
    });
    expect(client.queries[0]?.sql).toContain('on conflict (identity_hash, quota_date) do update');
    expect(client.queries[0]?.values[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(client.queries[0]?.values)).not.toContain('telegram:user:12345');
  });

  it('returns a denied result after the atomic limit is reached', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ allowed: false, usage_count: 10 }]];
    const result = await createPgDailyChatQuotaStore({ client }).consume({
      identity: 'web:session:one',
      limit: 10,
      timeZone: 'UTC',
    });
    expect(result).toMatchObject({ allowed: false, remaining: 0, used: 10 });
  });

  it('migrates the quota table and date index', async () => {
    const client = new FakePgClient();
    await createPgDailyChatQuotaStore({ client }).migrate();
    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists daily_chat_quotas');
    expect(sql).toContain('daily_chat_quotas_date_idx');
  });
});
