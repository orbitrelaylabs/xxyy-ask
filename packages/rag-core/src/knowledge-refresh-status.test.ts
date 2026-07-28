import { describe, expect, it, vi } from 'vitest';

import { readKnowledgeRefreshStatus } from './knowledge-refresh-status.js';

const SCHEDULE = {
  fullMode: 'manual',
  incrementalDailyAt: '08:00',
  timeZone: 'Asia/Shanghai',
};

describe('readKnowledgeRefreshStatus', () => {
  it('reports disabled without reading a receipt', async () => {
    const readTextFile = vi.fn<() => Promise<string>>();

    await expect(readKnowledgeRefreshStatus({ env: {}, readTextFile })).resolves.toEqual({
      enabled: false,
      schedule: SCHEDULE,
      state: 'disabled',
    });
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it('reports a recent successful refresh as healthy', async () => {
    await expect(
      readKnowledgeRefreshStatus({
        env: { KNOWLEDGE_AUTO_REFRESH_ENABLED: 'true' },
        now: () => new Date('2026-07-27T07:00:00.000Z'),
        readTextFile: () =>
          Promise.resolve(
            JSON.stringify({
              finishedAt: '2026-07-27T06:48:33.456Z',
              mode: 'incremental',
              status: 'succeeded',
            }),
          ),
      }),
    ).resolves.toEqual({
      enabled: true,
      lastRun: {
        finishedAt: '2026-07-27T06:48:33.456Z',
        mode: 'incremental',
        status: 'succeeded',
      },
      schedule: SCHEDULE,
      state: 'healthy',
    });
  });

  it('reports the configured daily incremental time and keeps full refresh manual', async () => {
    const configured = await readKnowledgeRefreshStatus({
      env: {
        KNOWLEDGE_AUTO_REFRESH_INCREMENTAL_DAILY_AT: '09:45',
        KNOWLEDGE_AUTO_REFRESH_TIME_ZONE: 'Asia/Shanghai',
      },
    });
    const invalid = await readKnowledgeRefreshStatus({
      env: {
        KNOWLEDGE_AUTO_REFRESH_INCREMENTAL_DAILY_AT: '8am',
      },
    });

    expect(configured.schedule).toEqual({
      fullMode: 'manual',
      incrementalDailyAt: '09:45',
      timeZone: 'Asia/Shanghai',
    });
    expect(invalid.schedule).toEqual(SCHEDULE);
  });

  it('reports stale and failed receipts without exposing receipt details', async () => {
    const stale = await readKnowledgeRefreshStatus({
      env: {
        KNOWLEDGE_AUTO_REFRESH_ENABLED: '1',
        KNOWLEDGE_AUTO_REFRESH_STALE_AFTER_MINUTES: '30',
      },
      now: () => new Date('2026-07-27T08:00:00.000Z'),
      readTextFile: () =>
        Promise.resolve(
          JSON.stringify({
            finishedAt: '2026-07-27T06:48:33.456Z',
            mode: 'incremental',
            runId: 'must-not-leak',
            status: 'succeeded',
            steps: [{ label: 'must-not-leak' }],
          }),
        ),
    });
    const failed = await readKnowledgeRefreshStatus({
      env: { KNOWLEDGE_AUTO_REFRESH_ENABLED: 'yes' },
      readTextFile: () =>
        Promise.resolve(
          JSON.stringify({
            failedStep: 'must-not-leak',
            finishedAt: '2026-07-27T06:48:33.456Z',
            mode: 'full',
            status: 'failed',
          }),
        ),
    });

    expect(stale).toMatchObject({ enabled: true, state: 'stale' });
    expect(JSON.stringify(stale)).not.toContain('must-not-leak');
    expect(failed).toEqual({
      enabled: true,
      lastRun: {
        finishedAt: '2026-07-27T06:48:33.456Z',
        mode: 'full',
        status: 'failed',
      },
      schedule: SCHEDULE,
      state: 'failed',
    });
  });

  it('distinguishes a missing first receipt from an unreadable receipt', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });

    await expect(
      readKnowledgeRefreshStatus({
        env: { KNOWLEDGE_AUTO_REFRESH_ENABLED: 'on' },
        readTextFile: () => Promise.reject(missing),
      }),
    ).resolves.toMatchObject({ enabled: true, state: 'pending' });
    await expect(
      readKnowledgeRefreshStatus({
        env: { KNOWLEDGE_AUTO_REFRESH_ENABLED: 'on' },
        readTextFile: () => Promise.resolve('{not-json'),
      }),
    ).resolves.toMatchObject({ enabled: true, state: 'unavailable' });
  });
});
