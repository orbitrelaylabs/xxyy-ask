import { describe, expect, it } from 'vitest';

import { createPgApiObservabilityStore, renderPrometheusApiMetrics } from './api-observability.js';

class FakePgClient {
  queuedRows: unknown[][] = [];
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  query<T>(sql: string, values: readonly unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

describe('createPgApiObservabilityStore', () => {
  it('migrates the observation table and operational indexes', async () => {
    const client = new FakePgClient();
    await createPgApiObservabilityStore({ client }).migrate();
    const sql = client.queries.map((query) => query.sql).join('\n');
    expect(sql).toContain('create table if not exists api_call_observations');
    expect(sql).toContain('api_call_observations_created_at_idx');
    expect(sql).toContain('api_call_observations_api_key_idx');
  });

  it('persists only a hashed client identity with token and cost metadata', async () => {
    const client = new FakePgClient();
    await createPgApiObservabilityStore({ client, hashSalt: 'test-salt' }).record({
      apiKeyId: 'partner-a',
      channel: 'web',
      clientAddress: '203.0.113.4',
      completionTokens: 20,
      durationMs: 125,
      estimatedCostUsd: 0.0012,
      method: 'post',
      path: '/api/v1/chat',
      promptTokens: 100,
      rateLimited: false,
      requestId: 'request-1',
      statusCode: 200,
      totalTokens: 120,
    });
    const values = client.queries[0]?.values ?? [];
    expect(JSON.stringify(values)).not.toContain('203.0.113.4');
    expect(values[6]).toMatch(/^[a-f0-9]{64}$/u);
    expect(values).toContain('partner-a');
    expect(values).toContain(120);
  });

  it('aggregates totals, dimensions, and an hourly timeline', async () => {
    const client = new FakePgClient();
    client.queuedRows = [
      [
        {
          average_duration_ms: '80.5',
          completion_tokens: '40',
          estimated_cost_usd: '0.0123',
          p95_duration_ms: '140',
          prompt_tokens: '160',
          rate_limited_count: 1,
          request_count: 10,
          server_error_count: 2,
          total_tokens: '200',
        },
      ],
      [
        {
          api_key_id: null,
          channel: 'web',
          dimension: 'channel',
          estimated_cost_usd: '0.01',
          rate_limited_count: 1,
          request_count: 8,
          server_error_count: 1,
          total_tokens: '180',
        },
      ],
      [
        {
          period_start: '2026-08-04T01:00:00.000Z',
          rate_limited_count: 1,
          request_count: 10,
          server_error_count: 2,
        },
      ],
    ];
    const summary = await createPgApiObservabilityStore({ client }).getSummary({
      from: '2026-08-04T00:00:00.000Z',
      to: '2026-08-05T00:00:00.000Z',
    });
    expect(summary).toMatchObject({
      p95DurationMs: 140,
      rateLimitedCount: 1,
      requestCount: 10,
      serverErrorCount: 2,
      totalTokens: 200,
    });
    expect(summary.byChannel[0]).toMatchObject({ key: 'web', requestCount: 8 });
    expect(summary.timeline).toHaveLength(1);
  });
});

it('renders a Prometheus-compatible snapshot without sensitive labels', () => {
  const text = renderPrometheusApiMetrics({
    averageDurationMs: 10,
    byApiKey: [],
    byChannel: [],
    byModel: [],
    completionTokens: 3,
    estimatedCostUsd: 0.1,
    from: '2026-08-04T00:00:00.000Z',
    p95DurationMs: 25,
    promptTokens: 7,
    rateLimitedCount: 2,
    requestCount: 20,
    serverErrorCount: 1,
    timeline: [],
    to: '2026-08-05T00:00:00.000Z',
    totalTokens: 10,
  });
  expect(text).toContain('xxyy_api_requests_total 20');
  expect(text).toContain('xxyy_api_tokens_total{type="total"} 10');
});
