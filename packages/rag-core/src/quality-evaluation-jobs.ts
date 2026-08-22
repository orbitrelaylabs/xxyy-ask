import { randomUUID } from 'node:crypto';

import type { PgClientLike } from './pgvector-store.js';

export type QualityEvaluationMode = 'deterministic' | 'provider' | 'provider_retrieval';
export type QualityEvaluationJobStatus = 'failed' | 'queued' | 'running' | 'succeeded';

export interface QualityEvaluationMetrics {
  averageCompleteness?: number;
  averageCorrectness?: number;
  averageGroundedness?: number;
  averageRelevance?: number;
  averageSafeRefusal?: number;
  casePassRate: number;
  forbiddenHitCount?: number;
  meanReciprocalRank?: number;
  ndcgAtK?: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  precisionAtK?: number;
  recallAtK?: number;
  totalTokens?: number;
}

export interface QualityEvaluationFailure {
  actualIntent?: string;
  citationCount?: number;
  expectedIntent?: string;
  failures: string[];
  name: string;
  retrieval?: {
    forbiddenHitCount?: number;
    ndcgAtK?: number;
    precisionAtK?: number;
    recallAtK?: number;
    reciprocalRank?: number;
  };
}

export interface QualityEvaluationJob {
  attemptCount: number;
  createdAt: string;
  id: string;
  mode: QualityEvaluationMode;
  requestedBy: string;
  status: QualityEvaluationJobStatus;
  updatedAt: string;
  withJudge: boolean;
  completedAt?: string;
  errorCode?: string;
  leaseExpiresAt?: string;
  reportId?: string;
  startedAt?: string;
  workerId?: string;
}

export interface QualityEvaluationReport {
  createdAt: string;
  failures: QualityEvaluationFailure[];
  generatedAt: string;
  gatesPassed: boolean;
  gateReasons: string[];
  id: string;
  isBaseline: boolean;
  jobId: string;
  metrics: QualityEvaluationMetrics;
  mode: QualityEvaluationMode;
  passedCases: number;
  totalCases: number;
  withJudge: boolean;
  approvedAsBaselineAt?: string;
  approvedAsBaselineBy?: string;
}

export interface PgQualityEvaluationJobStore {
  approveBaseline(input: { actor: string; reportId: string }): Promise<QualityEvaluationReport>;
  claimNext(input: {
    leaseSeconds?: number;
    workerId: string;
  }): Promise<QualityEvaluationJob | undefined>;
  complete(input: {
    attemptCount: number;
    failures: QualityEvaluationFailure[];
    gateReasons: string[];
    gatesPassed: boolean;
    generatedAt: string;
    id: string;
    metrics: QualityEvaluationMetrics;
    passedCases: number;
    totalCases: number;
    workerId: string;
  }): Promise<{ job: QualityEvaluationJob; report: QualityEvaluationReport }>;
  fail(input: {
    attemptCount: number;
    errorCode: string;
    id: string;
    workerId: string;
  }): Promise<QualityEvaluationJob>;
  getReport(id: string): Promise<QualityEvaluationReport | undefined>;
  listJobs(input?: {
    limit?: number;
    status?: QualityEvaluationJobStatus;
  }): Promise<QualityEvaluationJob[]>;
  listReports(input?: {
    limit?: number;
    mode?: QualityEvaluationMode;
  }): Promise<QualityEvaluationReport[]>;
  migrate(): Promise<void>;
  request(input: {
    mode: QualityEvaluationMode;
    requestedBy: string;
    withJudge?: boolean;
  }): Promise<QualityEvaluationJob>;
}

interface QualityEvaluationJobRow {
  attempt_count: number;
  completed_at: string | null;
  created_at: string;
  error_code: string | null;
  id: string;
  lease_expires_at: string | null;
  mode: QualityEvaluationMode;
  report_id: string | null;
  requested_by: string;
  started_at: string | null;
  status: QualityEvaluationJobStatus;
  updated_at: string;
  with_judge: boolean;
  worker_id: string | null;
}

interface QualityEvaluationReportRow {
  approved_as_baseline_at: string | null;
  approved_as_baseline_by: string | null;
  created_at: string;
  failures: QualityEvaluationFailure[];
  gate_reasons: string[];
  gates_passed: boolean;
  generated_at: string;
  id: string;
  is_baseline: boolean;
  job_id: string;
  metrics: QualityEvaluationMetrics;
  mode: QualityEvaluationMode;
  passed_cases: number;
  total_cases: number;
  with_judge: boolean;
}

const JOB_COLUMNS = `
  id, mode, with_judge, status, requested_by, worker_id, attempt_count,
  lease_expires_at::text as lease_expires_at, error_code, report_id,
  started_at::text as started_at, completed_at::text as completed_at,
  created_at::text as created_at, updated_at::text as updated_at
`;

const REPORT_COLUMNS = `
  id, job_id, mode, with_judge, generated_at::text as generated_at,
  total_cases, passed_cases, metrics, gates_passed, gate_reasons, failures,
  is_baseline, approved_as_baseline_by,
  approved_as_baseline_at::text as approved_as_baseline_at,
  created_at::text as created_at
`;

export function createPgQualityEvaluationJobStore(options: {
  client: PgClientLike;
}): PgQualityEvaluationJobStore {
  return {
    async approveBaseline(input) {
      return withTransaction(options.client, async (client) => {
        const selected = await query<QualityEvaluationReportRow>(
          client,
          `select ${REPORT_COLUMNS} from quality_evaluation_reports where id=$1 for update`,
          [requiredText(input.reportId, 'reportId')],
        );
        const report = selected.rows[0];
        if (report === undefined) throw new Error('Quality evaluation report was not found.');
        if (!report.gates_passed || report.passed_cases !== report.total_cases) {
          throw new Error('Only a fully passing quality report can become a baseline.');
        }
        await query(
          client,
          `update quality_evaluation_reports set is_baseline=false,
             approved_as_baseline_by=null, approved_as_baseline_at=null
           where mode=$1 and is_baseline=true`,
          [report.mode],
        );
        const updated = await query<QualityEvaluationReportRow>(
          client,
          `update quality_evaluation_reports set is_baseline=true,
             approved_as_baseline_by=$2, approved_as_baseline_at=now()
           where id=$1 returning ${REPORT_COLUMNS}`,
          [report.id, requiredText(input.actor, 'actor')],
        );
        return mapReport(requiredRow(updated.rows[0]));
      });
    },

    async claimNext(input) {
      return withTransaction(options.client, async (client) => {
        const response = await query<QualityEvaluationJobRow>(
          client,
          `with next_job as (
             select id from quality_evaluation_jobs
             where status='queued' or (status='running' and lease_expires_at < now())
             order by created_at, id for update skip locked limit 1
           )
           update quality_evaluation_jobs jobs set
             status='running', worker_id=$1, attempt_count=attempt_count+1,
             lease_expires_at=now()+make_interval(secs => $2), error_code=null,
             report_id=null, started_at=now(), completed_at=null, updated_at=now()
           from next_job where jobs.id=next_job.id
           returning ${prefixColumns(JOB_COLUMNS, 'jobs')}`,
          [requiredText(input.workerId, 'workerId'), normalizeLease(input.leaseSeconds)],
        );
        const row = response.rows[0];
        return row === undefined ? undefined : mapJob(row);
      });
    },

    async complete(input) {
      return withTransaction(options.client, async (client) => {
        const selected = await query<QualityEvaluationJobRow>(
          client,
          `select ${JOB_COLUMNS} from quality_evaluation_jobs
           where id=$1 and status='running' and worker_id=$2 and attempt_count=$3 for update`,
          [input.id, input.workerId, input.attemptCount],
        );
        const job = selected.rows[0];
        if (job === undefined) throw new Error('Quality evaluation job lease is no longer active.');
        const reportId = `quality-report:${randomUUID()}`;
        const inserted = await query<QualityEvaluationReportRow>(
          client,
          `insert into quality_evaluation_reports (
             id, job_id, mode, with_judge, generated_at, total_cases, passed_cases,
             metrics, gates_passed, gate_reasons, failures
           ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb)
           returning ${REPORT_COLUMNS}`,
          [
            reportId,
            job.id,
            job.mode,
            job.with_judge,
            input.generatedAt,
            normalizeCount(input.totalCases),
            normalizeCount(input.passedCases),
            JSON.stringify(input.metrics),
            input.gatesPassed,
            JSON.stringify(input.gateReasons.slice(0, 50)),
            JSON.stringify(input.failures.slice(0, 200)),
          ],
        );
        const updated = await query<QualityEvaluationJobRow>(
          client,
          `update quality_evaluation_jobs set status='succeeded', report_id=$4,
             lease_expires_at=null, error_code=null, completed_at=now(), updated_at=now()
           where id=$1 and worker_id=$2 and attempt_count=$3
           returning ${JOB_COLUMNS}`,
          [job.id, input.workerId, input.attemptCount, reportId],
        );
        return {
          job: mapJob(requiredRow(updated.rows[0])),
          report: mapReport(requiredRow(inserted.rows[0])),
        };
      });
    },

    async fail(input) {
      const response = await query<QualityEvaluationJobRow>(
        options.client,
        `update quality_evaluation_jobs set status='failed', lease_expires_at=null,
           error_code=$4, completed_at=now(), updated_at=now()
         where id=$1 and status='running' and worker_id=$2 and attempt_count=$3
         returning ${JOB_COLUMNS}`,
        [
          requiredText(input.id, 'id'),
          requiredText(input.workerId, 'workerId'),
          normalizeCount(input.attemptCount),
          safeErrorCode(input.errorCode),
        ],
      );
      return mapJob(requiredRow(response.rows[0]));
    },

    async getReport(id) {
      const response = await query<QualityEvaluationReportRow>(
        options.client,
        `select ${REPORT_COLUMNS} from quality_evaluation_reports where id=$1`,
        [requiredText(id, 'id')],
      );
      return response.rows[0] === undefined ? undefined : mapReport(response.rows[0]);
    },

    async listJobs(input = {}) {
      const values: unknown[] = [];
      const filters: string[] = [];
      if (input.status !== undefined) {
        values.push(input.status);
        filters.push(`status=$${values.length}`);
      }
      values.push(normalizeLimit(input.limit));
      const response = await query<QualityEvaluationJobRow>(
        options.client,
        `select ${JOB_COLUMNS} from quality_evaluation_jobs
         ${filters.length === 0 ? '' : `where ${filters.join(' and ')}`}
         order by created_at desc, id limit $${values.length}`,
        values,
      );
      return response.rows.map(mapJob);
    },

    async listReports(input = {}) {
      const values: unknown[] = [];
      const filters: string[] = [];
      if (input.mode !== undefined) {
        values.push(input.mode);
        filters.push(`mode=$${values.length}`);
      }
      values.push(normalizeLimit(input.limit));
      const response = await query<QualityEvaluationReportRow>(
        options.client,
        `select ${REPORT_COLUMNS} from quality_evaluation_reports
         ${filters.length === 0 ? '' : `where ${filters.join(' and ')}`}
         order by generated_at desc, id limit $${values.length}`,
        values,
      );
      return response.rows.map(mapReport);
    },

    migrate() {
      return migrateQualityEvaluationJobs(options.client);
    },

    async request(input) {
      const response = await query<QualityEvaluationJobRow>(
        options.client,
        `insert into quality_evaluation_jobs (id, mode, with_judge, requested_by)
         values ($1,$2,$3,$4)
         on conflict (mode, with_judge) where status in ('queued','running')
         do update set updated_at=quality_evaluation_jobs.updated_at
         returning ${JOB_COLUMNS}`,
        [
          `quality-eval:${randomUUID()}`,
          input.mode,
          input.withJudge === true,
          requiredText(input.requestedBy, 'requestedBy'),
        ],
      );
      return mapJob(requiredRow(response.rows[0]));
    },
  };
}

export async function migrateQualityEvaluationJobs(client: PgClientLike): Promise<void> {
  await query(
    client,
    `create table if not exists quality_evaluation_jobs (
       id text primary key,
       mode text not null check (mode in ('deterministic','provider_retrieval','provider')),
       with_judge boolean not null default false,
       status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
       requested_by text not null,
       worker_id text,
       attempt_count integer not null default 0,
       lease_expires_at timestamptz,
       error_code text,
       report_id text,
       started_at timestamptz,
       completed_at timestamptz,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
  );
  await query(
    client,
    `create unique index if not exists quality_evaluation_jobs_active_mode_idx
     on quality_evaluation_jobs (mode, with_judge) where status in ('queued','running')`,
  );
  await query(
    client,
    `create table if not exists quality_evaluation_reports (
       id text primary key,
       job_id text not null unique references quality_evaluation_jobs(id) on delete restrict,
       mode text not null check (mode in ('deterministic','provider_retrieval','provider')),
       with_judge boolean not null default false,
       generated_at timestamptz not null,
       total_cases integer not null,
       passed_cases integer not null,
       metrics jsonb not null,
       gates_passed boolean not null,
       gate_reasons jsonb not null default '[]'::jsonb,
       failures jsonb not null default '[]'::jsonb,
       is_baseline boolean not null default false,
       approved_as_baseline_by text,
       approved_as_baseline_at timestamptz,
       created_at timestamptz not null default now()
     )`,
  );
  await query(
    client,
    `create unique index if not exists quality_evaluation_reports_baseline_mode_idx
     on quality_evaluation_reports (mode) where is_baseline=true`,
  );
  await query(
    client,
    `update quality_evaluation_reports set
       gate_reasons=case when gate_reasons='{}'::jsonb then '[]'::jsonb else gate_reasons end,
       failures=case when failures='{}'::jsonb then '[]'::jsonb else failures end
     where gate_reasons='{}'::jsonb or failures='{}'::jsonb`,
  );
  await query(
    client,
    `create index if not exists quality_evaluation_reports_generated_idx
     on quality_evaluation_reports (generated_at desc)`,
  );
}

function mapJob(row: QualityEvaluationJobRow): QualityEvaluationJob {
  return {
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    id: row.id,
    mode: row.mode,
    requestedBy: row.requested_by,
    status: row.status,
    updatedAt: row.updated_at,
    withJudge: row.with_judge,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.report_id === null ? {} : { reportId: row.report_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.worker_id === null ? {} : { workerId: row.worker_id }),
  };
}

function mapReport(row: QualityEvaluationReportRow): QualityEvaluationReport {
  return {
    createdAt: row.created_at,
    failures: row.failures,
    generatedAt: row.generated_at,
    gatesPassed: row.gates_passed,
    gateReasons: row.gate_reasons,
    id: row.id,
    isBaseline: row.is_baseline,
    jobId: row.job_id,
    metrics: row.metrics,
    mode: row.mode,
    passedCases: row.passed_cases,
    totalCases: row.total_cases,
    withJudge: row.with_judge,
    ...(row.approved_as_baseline_at === null
      ? {}
      : { approvedAsBaselineAt: row.approved_as_baseline_at }),
    ...(row.approved_as_baseline_by === null
      ? {}
      : { approvedAsBaselineBy: row.approved_as_baseline_by }),
  };
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) throw new Error(`${field} is invalid.`);
  return normalized;
}

function safeErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gu, '_')
    .slice(0, 80);
  return normalized.length === 0 ? 'unknown' : normalized;
}

function normalizeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('count is invalid.');
  return value;
}

function normalizeLease(value: number | undefined): number {
  return value === undefined ? 7_200 : Math.min(21_600, Math.max(60, Math.floor(value)));
}

function normalizeLimit(value: number | undefined): number {
  return value === undefined ? 50 : Math.min(200, Math.max(1, Math.floor(value)));
}

function requiredRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('Quality evaluation record was not found or changed.');
  return row;
}

function prefixColumns(columns: string, prefix: string): string {
  return columns
    .split(',')
    .map((column) => {
      const trimmed = column.trim();
      const [expression, alias] = trimmed.split(/\s+as\s+/iu);
      return `${prefix}.${expression}${alias === undefined ? '' : ` as ${alias}`}`;
    })
    .join(', ');
}

async function query<T = never>(
  client: PgClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  return client.query<T>(sql, values);
}

async function withTransaction<T>(
  client: PgClientLike,
  work: (client: PgClientLike) => Promise<T>,
) {
  if (client.connect === undefined) {
    await client.query('begin');
    try {
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
  const transaction = await client.connect();
  try {
    await transaction.query('begin');
    const result = await work(transaction);
    await transaction.query('commit');
    return result;
  } catch (error) {
    await transaction.query('rollback');
    throw error;
  } finally {
    transaction.release();
  }
}
