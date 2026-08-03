import { describe, expect, it, vi } from 'vitest';

import {
  createPgTelegramCurationJobStore,
  migrateTelegramCurationJobs,
} from './telegram-curation-jobs.js';

describe('Telegram curation jobs', () => {
  it('creates a durable per-chat queue and claim index', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await migrateTelegramCurationJobs({ query });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('telegram_knowledge_curation_jobs');
    expect(query.mock.calls[1]?.[0]).toContain('telegram_knowledge_curation_jobs_claim_idx');
  });

  it('debounces repeated chat activity through an upsert', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = createPgTelegramCurationJobStore({ client: { query } });

    await store.request({ chatId: '-100123', debounceSeconds: 45, triggerMessageId: '88' });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('on conflict (chat_id)'), [
      '-100123',
      '88',
      45,
    ]);
  });

  it('claims an available job with a bounded lease', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          attempt_count: 1,
          available_at: '2026-08-03T01:00:00.000Z',
          chat_id: '-100123',
          completed_at: null,
          error_code: null,
          lease_expires_at: '2026-08-03T01:02:00.000Z',
          result: null,
          status: 'running',
          trigger_message_id: '88',
          updated_at: '2026-08-03T01:00:00.000Z',
          worker_id: 'worker-1',
        },
      ],
    });
    const store = createPgTelegramCurationJobStore({ client: { query } });

    const job = await store.claimNext({ leaseSeconds: 120, workerId: 'worker-1' });

    expect(job).toMatchObject({ attemptCount: 1, chatId: '-100123', status: 'running' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('for update skip locked'), [
      'worker-1',
      120,
    ]);
  });
});
