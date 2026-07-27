import type { PgClientLike } from './pgvector-store.js';

export interface TelegramKnowledgeLearningSetting {
  chatId: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface TelegramKnowledgeLearningProgress {
  approvedCount: number;
  candidateCount: number;
  pendingCount: number;
  publishedCount: number;
  rejectedCount: number;
  lastAnalyzedAt?: string;
}

export interface PgTelegramKnowledgeLearningSettingsStore {
  get(chatId: string): Promise<TelegramKnowledgeLearningSetting | undefined>;
  getProgress(chatId: string): Promise<TelegramKnowledgeLearningProgress>;
  migrate(): Promise<void>;
  set(input: {
    chatId: string;
    enabled: boolean;
    updatedBy: string;
  }): Promise<TelegramKnowledgeLearningSetting>;
}

interface TelegramKnowledgeLearningSettingRow {
  chat_id: string;
  enabled: boolean;
  updated_at: string;
  updated_by: string;
}

interface TelegramKnowledgeLearningProgressRow {
  approved_count: number;
  candidate_count: number;
  last_analyzed_at: string | null;
  pending_count: number;
  published_count: number;
  rejected_count: number;
}

const SETTING_COLUMNS = `
  chat_id,
  enabled,
  updated_by,
  updated_at::text as updated_at
`;

export function createPgTelegramKnowledgeLearningSettingsStore(options: {
  client: PgClientLike;
}): PgTelegramKnowledgeLearningSettingsStore {
  return {
    async get(rawChatId): Promise<TelegramKnowledgeLearningSetting | undefined> {
      const response = await options.client.query<TelegramKnowledgeLearningSettingRow>(
        `
        select ${SETTING_COLUMNS}
        from telegram_knowledge_learning_settings
        where chat_id = $1
        `,
        [normalizeTelegramChatId(rawChatId)],
      );
      const row = response.rows[0];
      return row === undefined ? undefined : mapSetting(row);
    },

    async getProgress(rawChatId): Promise<TelegramKnowledgeLearningProgress> {
      const response = await options.client.query<TelegramKnowledgeLearningProgressRow>(
        `
        select
          count(*)::integer as candidate_count,
          count(*) filter (where status = 'pending')::integer as pending_count,
          count(*) filter (where status = 'approved')::integer as approved_count,
          count(*) filter (where status = 'rejected')::integer as rejected_count,
          count(*) filter (where status = 'published')::integer as published_count,
          max(created_at)::text as last_analyzed_at
        from knowledge_candidates
        where source_channel = 'telegram' and source_chat_id = $1
        `,
        [normalizeTelegramChatId(rawChatId)],
      );
      const row = response.rows[0];
      if (row === undefined) {
        return {
          approvedCount: 0,
          candidateCount: 0,
          pendingCount: 0,
          publishedCount: 0,
          rejectedCount: 0,
        };
      }
      return {
        approvedCount: Number(row.approved_count),
        candidateCount: Number(row.candidate_count),
        pendingCount: Number(row.pending_count),
        publishedCount: Number(row.published_count),
        rejectedCount: Number(row.rejected_count),
        ...(row.last_analyzed_at === null ? {} : { lastAnalyzedAt: row.last_analyzed_at }),
      };
    },

    migrate() {
      return migrateTelegramKnowledgeLearningSettings(options.client);
    },

    async set(input): Promise<TelegramKnowledgeLearningSetting> {
      const chatId = normalizeTelegramChatId(input.chatId);
      const updatedBy = normalizeActor(input.updatedBy);
      const response = await options.client.query<TelegramKnowledgeLearningSettingRow>(
        `
        with changed as (
          insert into telegram_knowledge_learning_settings (
            chat_id, enabled, updated_by, updated_at
          )
          values ($1, $2, $3, now())
          on conflict (chat_id) do update
          set
            enabled = excluded.enabled,
            updated_by = excluded.updated_by,
            updated_at = now()
          returning ${SETTING_COLUMNS}
        ), audited as (
          insert into telegram_knowledge_learning_setting_events (
            chat_id, enabled, changed_by
          )
          select chat_id, enabled, updated_by
          from changed
        )
        select ${SETTING_COLUMNS}
        from changed
        `,
        [chatId, input.enabled, updatedBy],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new Error('Telegram knowledge learning setting update did not return a row.');
      }
      return mapSetting(row);
    },
  };
}

export async function migrateTelegramKnowledgeLearningSettings(
  client: PgClientLike,
): Promise<void> {
  await client.query(
    `
    create table if not exists telegram_knowledge_learning_settings (
      chat_id text primary key,
      enabled boolean not null,
      updated_by text not null,
      updated_at timestamptz not null default now()
    )
    `,
  );
  await client.query(
    `
    create table if not exists telegram_knowledge_learning_setting_events (
      id bigserial primary key,
      chat_id text not null,
      enabled boolean not null,
      changed_by text not null,
      created_at timestamptz not null default now()
    )
    `,
  );
  await client.query(
    `
    create index if not exists telegram_knowledge_learning_events_chat_idx
      on telegram_knowledge_learning_setting_events (chat_id, created_at desc)
    `,
  );
}

function mapSetting(row: TelegramKnowledgeLearningSettingRow): TelegramKnowledgeLearningSetting {
  return {
    chatId: row.chat_id,
    enabled: row.enabled,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function normalizeTelegramChatId(value: string): string {
  const normalized = value.trim();
  if (!/^-?\d{1,32}$/u.test(normalized)) {
    throw new Error('chatId must be a Telegram numeric chat identifier.');
  }
  return normalized;
}

function normalizeActor(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9_.:@/-]+$/u.test(normalized)
  ) {
    throw new Error('updatedBy contains unsupported characters.');
  }
  return normalized;
}
