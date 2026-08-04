import { createHash, randomUUID } from 'node:crypto';

import type { ChatChannel } from '@xxyy/shared';

import type { PgClientLike } from './pgvector-store.js';

export interface ApiCallObservation {
  apiKeyId?: string;
  channel?: ChatChannel;
  clientAddress?: string;
  completionTokens?: number;
  durationMs: number;
  errorCode?: string;
  estimatedCostUsd?: number;
  method: string;
  model?: string;
  modelCallCount?: number;
  path: string;
  promptTokens?: number;
  rateLimited: boolean;
  requestId?: string;
  statusCode: number;
  totalTokens?: number;
}

export interface StoredApiCallObservation extends Omit<ApiCallObservation, 'clientAddress'> {
  clientHash: string;
  createdAt: string;
  id: string;
}

export interface ApiObservabilityFilters {
  apiKeyId?: string;
  channel?: ChatChannel;
  from?: string;
  limit?: number;
  path?: string;
  statusCode?: number;
  to?: string;
}

export interface ApiObservabilityDimension {
  key: string;
  requestCount: number;
  rateLimitedCount: number;
  serverErrorCount: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface ApiObservabilityBucket {
  periodStart: string;
  requestCount: number;
  rateLimitedCount: number;
  serverErrorCount: number;
}

export interface ApiObservabilitySummary {
  averageDurationMs: number;
  byApiKey: ApiObservabilityDimension[];
  byChannel: ApiObservabilityDimension[];
  byModel: ApiObservabilityDimension[];
  completionTokens: number;
  estimatedCostUsd: number;
  from: string;
  p95DurationMs: number;
  promptTokens: number;
  rateLimitedCount: number;
  requestCount: number;
  serverErrorCount: number;
  timeline: ApiObservabilityBucket[];
  to: string;
  totalTokens: number;
}

export interface PgApiObservabilityStore {
  getSummary(
    filters?: Pick<ApiObservabilityFilters, 'from' | 'to'>,
  ): Promise<ApiObservabilitySummary>;
  list(filters?: ApiObservabilityFilters): Promise<StoredApiCallObservation[]>;
  migrate(): Promise<void>;
  record(input: ApiCallObservation): Promise<void>;
}

interface ObservationRow {
  api_key_id: string | null;
  channel: ChatChannel | null;
  client_hash: string;
  completion_tokens: number | null;
  created_at: string;
  duration_ms: number;
  error_code: string | null;
  estimated_cost_usd: string;
  id: string;
  method: string;
  model_call_count: number | null;
  model: string | null;
  path: string;
  prompt_tokens: number | null;
  rate_limited: boolean;
  request_id: string | null;
  status_code: number;
  total_tokens: number | null;
}

const OBSERVATION_COLUMNS = `
  id, request_id, method, path, channel, api_key_id, client_hash,
  status_code, duration_ms, rate_limited, error_code, model, model_call_count,
  prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, created_at
`;

export function createPgApiObservabilityStore(options: {
  client: PgClientLike;
  hashSalt?: string;
}): PgApiObservabilityStore {
  const hashSalt = options.hashSalt ?? 'xxyy-api-observability';
  return {
    migrate: () => migrateApiObservability(options.client),
    async record(input) {
      await options.client.query(
        `
        insert into api_call_observations (
          id, request_id, method, path, channel, api_key_id, client_hash,
          status_code, duration_ms, rate_limited, error_code, model, model_call_count,
          prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
        )
        `,
        [
          `api_call_${randomUUID()}`,
          normalizeOptional(input.requestId, 256),
          input.method.slice(0, 16).toUpperCase(),
          input.path.slice(0, 512),
          input.channel ?? null,
          normalizeOptional(input.apiKeyId, 160),
          hashClient(input.clientAddress, hashSalt),
          normalizeInteger(input.statusCode, 100, 599),
          normalizeInteger(input.durationMs, 0, Number.MAX_SAFE_INTEGER),
          input.rateLimited,
          normalizeOptional(input.errorCode, 160),
          normalizeOptional(input.model, 256),
          normalizeOptionalInteger(input.modelCallCount),
          normalizeOptionalInteger(input.promptTokens),
          normalizeOptionalInteger(input.completionTokens),
          normalizeOptionalInteger(input.totalTokens),
          normalizeCost(input.estimatedCostUsd),
        ],
      );
    },
    async list(filters = {}) {
      const { clause, values } = observationFilterClause(filters);
      const limit = normalizeInteger(filters.limit ?? 100, 1, 500);
      const response = await options.client.query<ObservationRow>(
        `select ${OBSERVATION_COLUMNS} from api_call_observations ${clause}
         order by created_at desc, id desc limit $${values.length + 1}`,
        [...values, limit],
      );
      return response.rows.map(mapObservation);
    },
    async getSummary(filters = {}) {
      const now = new Date();
      const from = validDate(filters.from) ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const to = validDate(filters.to) ?? now;
      const rangeValues = [from.toISOString(), to.toISOString()];
      const totals = await options.client.query<{
        average_duration_ms: string;
        completion_tokens: string;
        estimated_cost_usd: string;
        p95_duration_ms: string;
        prompt_tokens: string;
        rate_limited_count: number;
        request_count: number;
        server_error_count: number;
        total_tokens: string;
      }>(summaryTotalsSql(), rangeValues);
      const dimensions = await options.client.query<{
        api_key_id: string | null;
        channel: string | null;
        dimension: 'api_key' | 'channel' | 'model';
        estimated_cost_usd: string;
        rate_limited_count: number;
        request_count: number;
        server_error_count: number;
        total_tokens: string;
        model: string | null;
      }>(summaryDimensionsSql(), rangeValues);
      const timeline = await options.client.query<{
        period_start: string;
        rate_limited_count: number;
        request_count: number;
        server_error_count: number;
      }>(summaryTimelineSql(), rangeValues);
      const row = totals.rows[0];
      const mapDimension = (
        dimension: 'api_key' | 'channel' | 'model',
      ): ApiObservabilityDimension[] =>
        dimensions.rows
          .filter((item) => item.dimension === dimension)
          .map((item) => ({
            estimatedCostUsd: Number(item.estimated_cost_usd),
            key:
              (dimension === 'api_key'
                ? item.api_key_id
                : dimension === 'model'
                  ? item.model
                  : item.channel) ?? 'anonymous',
            rateLimitedCount: item.rate_limited_count,
            requestCount: item.request_count,
            serverErrorCount: item.server_error_count,
            totalTokens: Number(item.total_tokens),
          }));
      return {
        averageDurationMs: Number(row?.average_duration_ms ?? 0),
        byApiKey: mapDimension('api_key'),
        byChannel: mapDimension('channel'),
        byModel: mapDimension('model'),
        completionTokens: Number(row?.completion_tokens ?? 0),
        estimatedCostUsd: Number(row?.estimated_cost_usd ?? 0),
        from: from.toISOString(),
        p95DurationMs: Number(row?.p95_duration_ms ?? 0),
        promptTokens: Number(row?.prompt_tokens ?? 0),
        rateLimitedCount: row?.rate_limited_count ?? 0,
        requestCount: row?.request_count ?? 0,
        serverErrorCount: row?.server_error_count ?? 0,
        timeline: timeline.rows.map((item) => ({
          periodStart: item.period_start,
          rateLimitedCount: item.rate_limited_count,
          requestCount: item.request_count,
          serverErrorCount: item.server_error_count,
        })),
        to: to.toISOString(),
        totalTokens: Number(row?.total_tokens ?? 0),
      };
    },
  };
}

export async function migrateApiObservability(client: PgClientLike): Promise<void> {
  await client.query(`
    create table if not exists api_call_observations (
      id text primary key,
      request_id text,
      method text not null,
      path text not null,
      channel text check (channel is null or channel in ('cli', 'web', 'telegram')),
      api_key_id text,
      client_hash text not null,
      status_code integer not null check (status_code between 100 and 599),
      duration_ms integer not null check (duration_ms >= 0),
      rate_limited boolean not null default false,
      error_code text,
      model text,
      model_call_count integer check (model_call_count is null or model_call_count >= 0),
      prompt_tokens integer check (prompt_tokens is null or prompt_tokens >= 0),
      completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
      total_tokens integer check (total_tokens is null or total_tokens >= 0),
      estimated_cost_usd numeric(18, 8) not null default 0,
      created_at timestamptz not null default now()
    )
  `);
  await client.query(
    `create index if not exists api_call_observations_created_at_idx on api_call_observations (created_at desc)`,
  );
  await client.query(
    `create index if not exists api_call_observations_api_key_idx on api_call_observations (api_key_id, created_at desc) where api_key_id is not null`,
  );
  await client.query(
    `create index if not exists api_call_observations_status_idx on api_call_observations (status_code, created_at desc)`,
  );
  await client.query(`alter table api_call_observations add column if not exists model text`);
}

export function renderPrometheusApiMetrics(summary: ApiObservabilitySummary): string {
  const lines = [
    '# HELP xxyy_api_requests_total API requests in the selected observation window.',
    '# TYPE xxyy_api_requests_total gauge',
    `xxyy_api_requests_total ${summary.requestCount}`,
    '# TYPE xxyy_api_rate_limited_total gauge',
    `xxyy_api_rate_limited_total ${summary.rateLimitedCount}`,
    '# TYPE xxyy_api_server_errors_total gauge',
    `xxyy_api_server_errors_total ${summary.serverErrorCount}`,
    '# TYPE xxyy_api_duration_milliseconds gauge',
    `xxyy_api_duration_milliseconds{quantile="0.95"} ${summary.p95DurationMs}`,
    '# TYPE xxyy_api_tokens_total gauge',
    `xxyy_api_tokens_total{type="prompt"} ${summary.promptTokens}`,
    `xxyy_api_tokens_total{type="completion"} ${summary.completionTokens}`,
    `xxyy_api_tokens_total{type="total"} ${summary.totalTokens}`,
    '# TYPE xxyy_api_estimated_cost_usd gauge',
    `xxyy_api_estimated_cost_usd ${summary.estimatedCostUsd}`,
  ];
  return `${lines.join('\n')}\n`;
}

function observationFilterClause(filters: ApiObservabilityFilters): {
  clause: string;
  values: unknown[];
} {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    conditions.push(sql.replace('?', `$${values.length}`));
  };
  if (filters.from !== undefined) add('created_at >= ?', filters.from);
  if (filters.to !== undefined) add('created_at <= ?', filters.to);
  if (filters.channel !== undefined) add('channel = ?', filters.channel);
  if (filters.apiKeyId !== undefined) add('api_key_id = ?', filters.apiKeyId);
  if (filters.path !== undefined) add('path = ?', filters.path);
  if (filters.statusCode !== undefined) add('status_code = ?', filters.statusCode);
  return { clause: conditions.length === 0 ? '' : `where ${conditions.join(' and ')}`, values };
}

function summaryTotalsSql(): string {
  return `select count(*)::integer request_count,
    count(*) filter (where rate_limited)::integer rate_limited_count,
    count(*) filter (where status_code >= 500 or (status_code < 400 and error_code is not null))::integer server_error_count,
    coalesce(avg(duration_ms), 0)::text average_duration_ms,
    coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::text p95_duration_ms,
    coalesce(sum(prompt_tokens), 0)::text prompt_tokens,
    coalesce(sum(completion_tokens), 0)::text completion_tokens,
    coalesce(sum(total_tokens), 0)::text total_tokens,
    coalesce(sum(estimated_cost_usd), 0)::text estimated_cost_usd
    from api_call_observations where created_at >= $1 and created_at <= $2`;
}

function summaryDimensionsSql(): string {
  return `select 'channel'::text dimension, channel, null::text api_key_id, null::text model,
    count(*)::integer request_count, count(*) filter (where rate_limited)::integer rate_limited_count,
    count(*) filter (where status_code >= 500 or (status_code < 400 and error_code is not null))::integer server_error_count,
    coalesce(sum(total_tokens), 0)::text total_tokens, coalesce(sum(estimated_cost_usd), 0)::text estimated_cost_usd
    from api_call_observations where created_at >= $1 and created_at <= $2 group by channel
    union all
    select 'api_key'::text dimension, null::text channel, api_key_id,
    null::text model,
    count(*)::integer, count(*) filter (where rate_limited)::integer,
    count(*) filter (where status_code >= 500 or (status_code < 400 and error_code is not null))::integer,
    coalesce(sum(total_tokens), 0)::text, coalesce(sum(estimated_cost_usd), 0)::text
    from api_call_observations where created_at >= $1 and created_at <= $2 group by api_key_id
    union all
    select 'model'::text dimension, null::text channel, null::text api_key_id, model,
    count(*)::integer, count(*) filter (where rate_limited)::integer,
    count(*) filter (where status_code >= 500 or (status_code < 400 and error_code is not null))::integer,
    coalesce(sum(total_tokens), 0)::text, coalesce(sum(estimated_cost_usd), 0)::text
    from api_call_observations where created_at >= $1 and created_at <= $2 group by model
    order by request_count desc`;
}

function summaryTimelineSql(): string {
  return `select date_trunc('hour', created_at)::text period_start,
    count(*)::integer request_count, count(*) filter (where rate_limited)::integer rate_limited_count,
    count(*) filter (where status_code >= 500 or (status_code < 400 and error_code is not null))::integer server_error_count
    from api_call_observations where created_at >= $1 and created_at <= $2
    group by date_trunc('hour', created_at) order by date_trunc('hour', created_at)`;
}

function mapObservation(row: ObservationRow): StoredApiCallObservation {
  return {
    ...(row.api_key_id === null ? {} : { apiKeyId: row.api_key_id }),
    ...(row.channel === null ? {} : { channel: row.channel }),
    clientHash: row.client_hash,
    ...(row.completion_tokens === null ? {} : { completionTokens: row.completion_tokens }),
    createdAt: row.created_at,
    durationMs: row.duration_ms,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    estimatedCostUsd: Number(row.estimated_cost_usd),
    id: row.id,
    method: row.method,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.model_call_count === null ? {} : { modelCallCount: row.model_call_count }),
    path: row.path,
    ...(row.prompt_tokens === null ? {} : { promptTokens: row.prompt_tokens }),
    rateLimited: row.rate_limited,
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
    statusCode: row.status_code,
    ...(row.total_tokens === null ? {} : { totalTokens: row.total_tokens }),
  };
}

function hashClient(value: string | undefined, salt: string): string {
  return createHash('sha256')
    .update(`${salt}:${value?.trim() || 'unknown'}`)
    .digest('hex');
}

function normalizeOptional(value: string | undefined, max: number): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized.slice(0, max);
}

function normalizeInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)));
}

function normalizeOptionalInteger(value: number | undefined): number | null {
  return value === undefined ? null : normalizeInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function normalizeCost(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? 0 : value;
}

function validDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
