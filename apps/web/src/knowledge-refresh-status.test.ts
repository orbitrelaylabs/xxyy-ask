import { describe, expect, it, vi } from 'vitest';

import { checkKnowledgeRefreshStatus } from './knowledge-refresh-status.js';

const healthyPayload = {
  enabled: true,
  lastRun: {
    finishedAt: '2026-07-27T06:48:33.456Z',
    mode: 'incremental',
    status: 'succeeded',
  },
  schedule: {
    fullMode: 'manual',
    incrementalDailyAt: '08:00',
    timeZone: 'Asia/Shanghai',
  },
  state: 'healthy',
};

describe('checkKnowledgeRefreshStatus', () => {
  it('loads the public refresh status', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(healthyPayload)),
    ) as unknown as typeof fetch;

    await expect(checkKnowledgeRefreshStatus(fetchImpl)).resolves.toEqual({
      kind: 'loaded',
      status: healthyPayload,
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/knowledge-refresh-status', {
      headers: { Accept: 'application/json' },
      method: 'GET',
    });
  });

  it('fails closed for malformed or unavailable responses', async () => {
    const malformedFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ enabled: true })),
    ) as unknown as typeof fetch;
    const unavailableFetch = vi.fn(() =>
      Promise.reject(new Error('offline')),
    ) as unknown as typeof fetch;

    await expect(checkKnowledgeRefreshStatus(malformedFetch)).resolves.toEqual({ kind: 'error' });
    await expect(checkKnowledgeRefreshStatus(unavailableFetch)).resolves.toEqual({ kind: 'error' });
  });
});

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
    ...init,
  });
}
