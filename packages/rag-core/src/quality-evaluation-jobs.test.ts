import { describe, expect, it, vi } from 'vitest';

import {
  createPgQualityEvaluationJobStore,
  migrateQualityEvaluationJobs,
} from './quality-evaluation-jobs.js';
import type { PgClientLike } from './pgvector-store.js';

describe('quality evaluation jobs', () => {
  it('migrates the bounded job and report schema', async () => {
    const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
      () => Promise.resolve({ rows: [] }),
    );

    await migrateQualityEvaluationJobs({ query: query as PgClientLike['query'] });

    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('quality_evaluation_jobs');
    expect(sql).toContain('quality_evaluation_reports');
    expect(sql).toContain("mode in ('deterministic','provider_retrieval','provider')");
    expect(sql).toContain('quality_evaluation_reports_baseline_mode_idx');
  });

  it('deduplicates active requests by fixed mode and maps the returned job', async () => {
    const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
      () => Promise.resolve({ rows: [jobRow()] }),
    );
    const store = createPgQualityEvaluationJobStore({
      client: { query: query as PgClientLike['query'] },
    });

    const job = await store.request({
      mode: 'deterministic',
      requestedBy: 'admin:alice',
    });

    expect(job).toMatchObject({
      id: 'quality-eval:1',
      mode: 'deterministic',
      requestedBy: 'admin:alice',
      status: 'queued',
    });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "on conflict (mode, with_judge) where status in ('queued','running')",
    );
  });

  it('atomically stores a bounded report and completes the active lease', async () => {
    const responses: Array<{ rows: unknown[] }> = [
      { rows: [] },
      { rows: [jobRow({ status: 'running', worker_id: 'worker:1', attempt_count: 1 })] },
      { rows: [reportRow()] },
      {
        rows: [
          jobRow({
            status: 'succeeded',
            worker_id: 'worker:1',
            attempt_count: 1,
            report_id: 'quality-report:1',
          }),
        ],
      },
      { rows: [] },
    ];
    const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
      () => Promise.resolve(responses.shift() ?? { rows: [] }),
    );
    const transaction = { query, release: vi.fn() };
    const store = createPgQualityEvaluationJobStore({
      client: {
        connect: () =>
          Promise.resolve({
            query: query as PgClientLike['query'],
            release: transaction.release,
          }),
        query: query as PgClientLike['query'],
      },
    });

    const result = await store.complete({
      attemptCount: 1,
      failures: [],
      gateReasons: [],
      gatesPassed: true,
      generatedAt: '2026-08-01T08:00:00.000Z',
      id: 'quality-eval:1',
      metrics: { casePassRate: 1, recallAtK: 1 },
      passedCases: 60,
      totalCases: 60,
      workerId: 'worker:1',
    });

    expect(result.job.status).toBe('succeeded');
    expect(result.report.metrics.recallAtK).toBe(1);
    expect(query.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining(['begin', 'commit']),
    );
    expect(transaction.release).toHaveBeenCalled();
  });
});

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    attempt_count: 0,
    completed_at: null,
    created_at: '2026-08-01T08:00:00.000Z',
    error_code: null,
    id: 'quality-eval:1',
    lease_expires_at: null,
    mode: 'deterministic',
    report_id: null,
    requested_by: 'admin:alice',
    started_at: null,
    status: 'queued',
    updated_at: '2026-08-01T08:00:00.000Z',
    with_judge: false,
    worker_id: null,
    ...overrides,
  };
}

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    approved_as_baseline_at: null,
    approved_as_baseline_by: null,
    created_at: '2026-08-01T08:00:00.000Z',
    failures: [],
    gate_reasons: [],
    gates_passed: true,
    generated_at: '2026-08-01T08:00:00.000Z',
    id: 'quality-report:1',
    is_baseline: false,
    job_id: 'quality-eval:1',
    metrics: { casePassRate: 1, recallAtK: 1 },
    mode: 'deterministic',
    passed_cases: 60,
    total_cases: 60,
    with_judge: false,
    ...overrides,
  };
}
