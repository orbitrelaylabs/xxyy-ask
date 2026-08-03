import type { PgClientLike } from './pgvector-store.js';

export type TelegramCurationJobStatus = 'failed' | 'queued' | 'running' | 'succeeded';

export interface TelegramCurationJob {
  attemptCount: number;
  availableAt: string;
  chatId: string;
  status: TelegramCurationJobStatus;
  triggerMessageId: string;
  updatedAt: string;
  completedAt?: string;
  errorCode?: string;
  leaseExpiresAt?: string;
  result?: Record<string, unknown>;
  workerId?: string;
}

export interface PgTelegramCurationJobStore {
  claimNext(input: {
    workerId: string;
    leaseSeconds?: number;
  }): Promise<TelegramCurationJob | undefined>;
  complete(input: {
    attemptCount: number;
    chatId: string;
    result: Record<string, unknown>;
    workerId: string;
  }): Promise<boolean>;
  fail(input: {
    attemptCount: number;
    chatId: string;
    errorCode: string;
    workerId: string;
  }): Promise<boolean>;
  get(chatId: string): Promise<TelegramCurationJob | undefined>;
  migrate(): Promise<void>;
  request(input: {
    chatId: string;
    triggerMessageId: string;
    debounceSeconds?: number;
  }): Promise<void>;
}

interface JobRow {
  attempt_count: number;
  available_at: string;
  chat_id: string;
  completed_at: string | null;
  error_code: string | null;
  lease_expires_at: string | null;
  result: Record<string, unknown> | null;
  status: TelegramCurationJobStatus;
  trigger_message_id: string;
  updated_at: string;
  worker_id: string | null;
}

const JOB_COLUMNS = `
  chat_id, trigger_message_id, status, attempt_count,
  available_at::text as available_at,
  lease_expires_at::text as lease_expires_at,
  worker_id, error_code, result,
  completed_at::text as completed_at,
  updated_at::text as updated_at
`;

export function createPgTelegramCurationJobStore(options: {
  client: PgClientLike;
}): PgTelegramCurationJobStore {
  return {
    async request(input): Promise<void> {
      await options.client.query(
        `insert into telegram_knowledge_curation_jobs (
           chat_id, trigger_message_id, status, attempt_count, available_at
         ) values ($1,$2,'queued',0,now()+make_interval(secs => $3))
         on conflict (chat_id) do update set
           trigger_message_id=excluded.trigger_message_id,
           status='queued', attempt_count=0,
           available_at=excluded.available_at,
           lease_expires_at=null, worker_id=null, error_code=null,
           result=null, completed_at=null, updated_at=now()`,
        [
          normalizeId(input.chatId, 'chat id'),
          normalizeId(input.triggerMessageId, 'trigger message id'),
          normalizeDebounce(input.debounceSeconds),
        ],
      );
    },

    async claimNext(input): Promise<TelegramCurationJob | undefined> {
      const response = await options.client.query<JobRow>(
        `with next_job as (
           select chat_id from telegram_knowledge_curation_jobs
           where (status='queued' and available_at <= now())
              or (status='running' and lease_expires_at < now())
           order by available_at, updated_at, chat_id
           for update skip locked limit 1
         )
         update telegram_knowledge_curation_jobs jobs set
           status='running', attempt_count=attempt_count+1,
           worker_id=$1, lease_expires_at=now()+make_interval(secs => $2),
           error_code=null, result=null, completed_at=null, updated_at=now()
         from next_job where jobs.chat_id=next_job.chat_id
         returning ${prefixColumns(JOB_COLUMNS, 'jobs')}`,
        [normalizeText(input.workerId, 'worker id'), normalizeLease(input.leaseSeconds)],
      );
      return response.rows[0] === undefined ? undefined : mapJob(response.rows[0]);
    },

    async complete(input): Promise<boolean> {
      const response = await options.client.query<{ chat_id: string }>(
        `update telegram_knowledge_curation_jobs set
           status='succeeded', lease_expires_at=null, worker_id=null,
           error_code=null, result=$4::jsonb, completed_at=now(), updated_at=now()
         where chat_id=$1 and status='running' and worker_id=$2 and attempt_count=$3
         returning chat_id`,
        [
          normalizeId(input.chatId, 'chat id'),
          normalizeText(input.workerId, 'worker id'),
          normalizeCount(input.attemptCount),
          input.result,
        ],
      );
      return response.rows.length > 0;
    },

    async fail(input): Promise<boolean> {
      const retry = input.attemptCount < 3;
      const response = await options.client.query<{ chat_id: string }>(
        `update telegram_knowledge_curation_jobs set
           status=$4, lease_expires_at=null, worker_id=null,
           error_code=$5, result=null,
           available_at=case when $4='queued' then now()+make_interval(secs => 30) else available_at end,
           completed_at=case when $4='failed' then now() else null end,
           updated_at=now()
         where chat_id=$1 and status='running' and worker_id=$2 and attempt_count=$3
         returning chat_id`,
        [
          normalizeId(input.chatId, 'chat id'),
          normalizeText(input.workerId, 'worker id'),
          normalizeCount(input.attemptCount),
          retry ? 'queued' : 'failed',
          normalizeErrorCode(input.errorCode),
        ],
      );
      return response.rows.length > 0;
    },

    async get(rawChatId): Promise<TelegramCurationJob | undefined> {
      const response = await options.client.query<JobRow>(
        `select ${JOB_COLUMNS} from telegram_knowledge_curation_jobs where chat_id=$1`,
        [normalizeId(rawChatId, 'chat id')],
      );
      return response.rows[0] === undefined ? undefined : mapJob(response.rows[0]);
    },

    migrate() {
      return migrateTelegramCurationJobs(options.client);
    },
  };
}

export async function migrateTelegramCurationJobs(client: PgClientLike): Promise<void> {
  await client.query(`create table if not exists telegram_knowledge_curation_jobs (
    chat_id text primary key,
    trigger_message_id text not null,
    status text not null check (status in ('queued','running','succeeded','failed')),
    attempt_count integer not null default 0 check (attempt_count >= 0),
    available_at timestamptz not null default now(),
    lease_expires_at timestamptz,
    worker_id text,
    error_code text,
    result jsonb,
    completed_at timestamptz,
    updated_at timestamptz not null default now()
  )`);
  await client.query(`create index if not exists telegram_knowledge_curation_jobs_claim_idx
    on telegram_knowledge_curation_jobs (available_at, updated_at)
    where status in ('queued','running')`);
}

function mapJob(row: JobRow): TelegramCurationJob {
  return {
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    chatId: row.chat_id,
    status: row.status,
    triggerMessageId: row.trigger_message_id,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.worker_id === null ? {} : { workerId: row.worker_id }),
  };
}

function normalizeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^-?[A-Za-z0-9_:.@-]{1,200}$/u.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function normalizeText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) throw new Error(`${label} is invalid.`);
  return normalized;
}

function normalizeDebounce(value: number | undefined): number {
  return value === undefined ? 30 : Math.max(0, Math.min(300, Math.floor(value)));
}

function normalizeLease(value: number | undefined): number {
  return value === undefined ? 120 : Math.max(30, Math.min(900, Math.floor(value)));
}

function normalizeCount(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error('attempt count is invalid.');
  return value;
}

function normalizeErrorCode(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9_:-]/giu, '_')
      .slice(0, 120) || 'unknown'
  );
}

function prefixColumns(columns: string, alias: string): string {
  return columns
    .split(',')
    .map((column) => {
      const trimmed = column.trim();
      const expression = trimmed.split(/\s+as\s+/iu)[0] ?? trimmed;
      const output = trimmed.match(/\s+as\s+([a-z_]+)$/iu)?.[1];
      return `${alias}.${expression}${output === undefined ? '' : ` as ${output}`}`;
    })
    .join(', ');
}
