import { describe, expect, it } from 'vitest';

import {
  createPgTelegramGroupMessageStore,
  migrateTelegramGroupMessages,
} from './telegram-group-messages.js';
import type { PgClientLike } from './pgvector-store.js';

describe('Telegram group message inbox', () => {
  it('migrates a local inbox with an unprocessed-message index', async () => {
    const statements: string[] = [];
    await migrateTelegramGroupMessages({
      query<T>(sql: string) {
        statements.push(sql);
        return Promise.resolve({ rows: [] as T[] });
      },
    });

    expect(statements.join('\n')).toContain('create table if not exists telegram_group_messages');
    expect(statements.join('\n')).toContain('where processed_at is null');
  });

  it('upserts edited messages and clears their processed marker when content changes', async () => {
    let observedSql = '';
    let observedValues: readonly unknown[] = [];
    const client: PgClientLike = {
      query<T>(sql: string, values: readonly unknown[] = []) {
        observedSql = sql;
        observedValues = values;
        return Promise.resolve({ rows: [] as T[] });
      },
    };
    const store = createPgTelegramGroupMessageStore({ client });

    await store.capture({
      authorIsBot: false,
      authorUserId: '123',
      chatId: '-100123',
      messageId: '42',
      sentAt: '2026-07-31T01:00:00Z',
      text: '管理员更新后的回答',
    });

    expect(observedSql).toContain('on conflict (chat_id, message_id) do update');
    expect(observedSql).toContain('else null');
    expect(observedValues.slice(0, 2)).toEqual(['-100123', '42']);
    expect(observedValues).not.toContain('plaintext');
  });

  it('requeues selected processed messages without deleting their text', async () => {
    let observedSql = '';
    let observedValues: readonly unknown[] = [];
    const store = createPgTelegramGroupMessageStore({
      client: {
        query<T>(sql: string, values: readonly unknown[] = []) {
          observedSql = sql;
          observedValues = values;
          return Promise.resolve({ rows: [{ message_id: '42' }] as T[] });
        },
      },
    });

    const count = await store.markUnprocessed({ chatId: '-100123', messageIds: ['42'] });

    expect(count).toBe(1);
    expect(observedSql).toContain('set processed_at = null');
    expect(observedSql).not.toContain('delete from');
    expect(observedValues).toEqual(['-100123', ['42']]);
  });
});
