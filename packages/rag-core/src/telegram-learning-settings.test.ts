import { describe, expect, it, vi } from 'vitest';

import type { PgClientLike } from './pgvector-store.js';
import {
  createPgTelegramKnowledgeLearningSettingsStore,
  migrateTelegramKnowledgeLearningSettings,
} from './telegram-learning-settings.js';

describe('Telegram knowledge learning settings', () => {
  it('creates persistent settings, audit events, and the chat index', async () => {
    const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
      () => Promise.resolve({ rows: [] }),
    );

    await migrateTelegramKnowledgeLearningSettings({
      query: query as PgClientLike['query'],
    });

    const sql = query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('create table if not exists telegram_knowledge_learning_settings');
    expect(sql).toContain('create table if not exists telegram_knowledge_learning_setting_events');
    expect(sql).toContain('telegram_knowledge_learning_events_chat_idx');
  });

  it('reads and updates a chat override with an audit event', async () => {
    const query = vi
      .fn<(sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValueOnce({
        rows: [
          {
            chat_id: '-100123',
            enabled: true,
            updated_at: '2026-07-27 09:00:00+00',
            updated_by: 'telegram:456',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            chat_id: '-100123',
            enabled: false,
            updated_at: '2026-07-27 09:05:00+00',
            updated_by: 'telegram:456',
          },
        ],
      });
    const store = createPgTelegramKnowledgeLearningSettingsStore({
      client: { query: query as PgClientLike['query'] },
    });

    await expect(store.get('-100123')).resolves.toEqual({
      chatId: '-100123',
      enabled: true,
      updatedAt: '2026-07-27 09:00:00+00',
      updatedBy: 'telegram:456',
    });
    await expect(
      store.set({ chatId: '-100123', enabled: false, updatedBy: 'telegram:456' }),
    ).resolves.toEqual({
      chatId: '-100123',
      enabled: false,
      updatedAt: '2026-07-27 09:05:00+00',
      updatedBy: 'telegram:456',
    });

    expect(query.mock.calls[1]?.[0]).toContain(
      'insert into telegram_knowledge_learning_setting_events',
    );
    expect(query.mock.calls[1]?.[1]).toEqual(['-100123', false, 'telegram:456']);
  });

  it('summarizes candidate progression without exposing conversation content', async () => {
    const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
      () =>
        Promise.resolve({
          rows: [
            {
              approved_count: 1,
              candidate_count: 5,
              last_analyzed_at: '2026-07-27 09:10:00+00',
              pending_count: 0,
              published_count: 2,
              rejected_count: 2,
            },
          ],
        }),
    );
    const store = createPgTelegramKnowledgeLearningSettingsStore({
      client: { query: query as PgClientLike['query'] },
    });

    await expect(store.getProgress('-100123')).resolves.toEqual({
      approvedCount: 1,
      candidateCount: 5,
      lastAnalyzedAt: '2026-07-27 09:10:00+00',
      pendingCount: 0,
      publishedCount: 2,
      rejectedCount: 2,
    });
    expect(query.mock.calls[0]?.[0]).toContain("source_channel = 'telegram'");
    expect(query.mock.calls[0]?.[0]).not.toContain('source_question_text');
    expect(query.mock.calls[0]?.[0]).not.toContain('source_answer_text');
  });

  it('rejects non-numeric chat identifiers and unsafe actors', async () => {
    const store = createPgTelegramKnowledgeLearningSettingsStore({
      client: {
        query: vi.fn(() => Promise.resolve({ rows: [] })) as PgClientLike['query'],
      },
    });

    await expect(store.get('all-chats')).rejects.toThrow('numeric chat identifier');
    await expect(
      store.set({ chatId: '-100123', enabled: true, updatedBy: 'admin with spaces' }),
    ).rejects.toThrow('unsupported characters');
  });
});
