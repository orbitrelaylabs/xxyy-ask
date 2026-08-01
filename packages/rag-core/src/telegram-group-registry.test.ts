import { describe, expect, it } from 'vitest';

import {
  createPgTelegramGroupRegistryStore,
  migrateTelegramGroupRegistry,
} from './telegram-group-registry.js';
import type { PgClientLike } from './pgvector-store.js';

describe('Telegram group registry', () => {
  it('creates a metadata-only registry with status and activity indexes', async () => {
    const { calls, client } = recordingClient([]);

    await migrateTelegramGroupRegistry(client);

    const sql = calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('create table if not exists telegram_group_registry');
    expect(sql).toContain('membership_status');
    expect(sql).toContain('last_message_at');
    expect(sql).not.toContain('message_text');
    expect(sql).not.toContain('message_content');
  });

  it('records a group message as active without accepting message content', async () => {
    const { calls, client } = recordingClient([
      {
        chat_id: '-100123',
        chat_type: 'supergroup' as const,
        first_seen_at: '2026-07-31T01:00:00.000Z',
        joined_at: '2026-07-31T01:00:00.000Z',
        last_message_at: '2026-07-31T01:00:00.000Z',
        last_seen_at: '2026-07-31T01:00:00.000Z',
        left_at: null,
        membership_status: 'active' as const,
        observation_source: 'message' as const,
        title: 'XXYY Support',
        updated_at: '2026-07-31T01:00:00.000Z',
      },
    ]);
    const store = createPgTelegramGroupRegistryStore({ client });

    const result = await store.observeMessage({
      chatId: '-100123',
      chatType: 'supergroup',
      observedAt: '2026-07-31T01:00:00Z',
      title: '  XXYY   Support ',
    });

    expect(result).toMatchObject({
      chatId: '-100123',
      membershipStatus: 'active',
      title: 'XXYY Support',
    });
    expect(calls[0]?.[1]).toEqual([
      '-100123',
      'XXYY Support',
      'supergroup',
      '2026-07-31T01:00:00.000Z',
    ]);
  });

  it('records leave events and lists groups by status', async () => {
    const row = {
      chat_id: '-100456',
      chat_type: 'group' as const,
      first_seen_at: '2026-07-31T01:00:00.000Z',
      joined_at: '2026-07-31T01:00:00.000Z',
      last_message_at: null,
      last_seen_at: '2026-07-31T02:00:00.000Z',
      left_at: '2026-07-31T02:00:00.000Z',
      membership_status: 'left' as const,
      observation_source: 'my_chat_member' as const,
      title: 'Former group',
      updated_at: '2026-07-31T02:00:00.000Z',
    };
    const { calls, client } = recordingClient([row]);
    const store = createPgTelegramGroupRegistryStore({ client });

    const observed = await store.observeMembership({
      chatId: '-100456',
      chatType: 'group',
      membershipStatus: 'left',
      observedAt: '2026-07-31T02:00:00Z',
      title: 'Former group',
    });
    const listed = await store.list({ limit: 20, membershipStatus: 'left' });

    expect(observed.leftAt).toBe('2026-07-31T02:00:00.000Z');
    expect(listed).toHaveLength(1);
    expect(calls[1]?.[1]).toEqual(['left', 20]);
  });

  it('rejects private chat identifiers', async () => {
    const store = createPgTelegramGroupRegistryStore({
      client: recordingClient([]).client,
    });

    await expect(
      store.observeMessage({
        chatId: '123',
        chatType: 'group',
        observedAt: '2026-07-31T01:00:00Z',
      }),
    ).rejects.toThrow('negative numeric identifier');
  });
});

function recordingClient(rows: unknown[]): {
  calls: Array<[string, readonly unknown[] | undefined]>;
  client: PgClientLike;
} {
  const calls: Array<[string, readonly unknown[] | undefined]> = [];
  return {
    calls,
    client: {
      query<T>(sql: string, values?: readonly unknown[]) {
        calls.push([sql, values]);
        return Promise.resolve({ rows: rows as T[] });
      },
    },
  };
}
