import { describe, expect, it } from 'vitest';

import {
  createPgTelegramBotAccessStore,
  normalizeTelegramBotUserId,
} from './telegram-bot-access.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

describe('Telegram Bot access store', () => {
  it('normalizes the Telegram request identity prefix', () => {
    expect(normalizeTelegramBotUserId('telegram:123456')).toBe('123456');
    expect(() => normalizeTelegramBotUserId('user-name')).toThrow('positive numeric');
  });

  it('atomically authorizes and consumes a configured daily allowance', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ daily_limit: 10, reason: 'allowed', usage_count: 4 }]];

    const result = await createPgTelegramBotAccessStore({ client }).authorizeAndConsume({
      now: new Date('2026-08-06T01:00:00.000Z'),
      telegramUserId: 'telegram:123456',
      timeZone: 'Asia/Shanghai',
    });

    expect(result).toEqual({
      allowed: true,
      dailyLimit: 10,
      quotaDate: '2026-08-06',
      reason: 'allowed',
      remaining: 6,
      used: 4,
    });
    expect(client.queries[0]?.sql).toContain(
      'on conflict (telegram_user_id, quota_date) do update',
    );
    expect(client.queries[0]?.values).toEqual(['123456', '2026-08-06']);
  });

  it('treats a null daily limit as unlimited', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ daily_limit: null, reason: 'allowed', usage_count: 2048 }]];

    await expect(
      createPgTelegramBotAccessStore({ client }).authorizeAndConsume({
        telegramUserId: '123456',
        timeZone: 'UTC',
      }),
    ).resolves.toMatchObject({
      allowed: true,
      dailyLimit: null,
      reason: 'allowed',
      remaining: null,
      used: 2048,
    });
  });

  it('denies users outside the allowlist without granting a quota', async () => {
    const client = new FakePgClient();
    client.queuedRows = [[{ daily_limit: null, reason: 'not_allowed', usage_count: 0 }]];

    await expect(
      createPgTelegramBotAccessStore({ client }).authorizeAndConsume({
        telegramUserId: '789',
        timeZone: 'UTC',
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'not_allowed', used: 0 });
  });

  it('creates the allowlist and daily usage tables', async () => {
    const client = new FakePgClient();
    await createPgTelegramBotAccessStore({ client }).migrate();
    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists telegram_bot_users');
    expect(sql).toContain('create table if not exists telegram_bot_daily_usage');
    expect(sql).toContain('telegram_bot_daily_usage_date_idx');
  });
});
