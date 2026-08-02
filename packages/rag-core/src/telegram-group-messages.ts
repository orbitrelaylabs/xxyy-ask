import type { PgClientLike } from './pgvector-store.js';

export interface TelegramGroupMessageRecord {
  authorIsBot: boolean;
  capturedAt: string;
  chatId: string;
  messageId: string;
  sentAt: string;
  text: string;
  authorUserId?: string;
  processedAt?: string;
  replyToMessageId?: string;
  senderChatId?: string;
}

export interface CaptureTelegramGroupMessageInput {
  authorIsBot: boolean;
  chatId: string;
  messageId: string;
  sentAt: string;
  text: string;
  authorUserId?: string;
  replyToMessageId?: string;
  senderChatId?: string;
}

export interface PgTelegramGroupMessageStore {
  capture(input: CaptureTelegramGroupMessageInput): Promise<void>;
  countUnprocessed(chatId: string): Promise<number>;
  list(input: {
    chatId: string;
    limit?: number;
    processingStatus?: 'all' | 'processed' | 'unprocessed';
  }): Promise<TelegramGroupMessageRecord[]>;
  listByIds(input: {
    chatId: string;
    messageIds: readonly string[];
  }): Promise<TelegramGroupMessageRecord[]>;
  markProcessed(input: {
    chatId: string;
    messageIds: readonly string[];
    processedAt: string;
  }): Promise<number>;
  markUnprocessed(input: { chatId: string; messageIds: readonly string[] }): Promise<number>;
  migrate(): Promise<void>;
  purgeOlderThan(cutoff: string): Promise<number>;
}

interface TelegramGroupMessageRow {
  author_is_bot: boolean;
  author_user_id: string | null;
  captured_at: string;
  chat_id: string;
  message_id: string;
  processed_at: string | null;
  reply_to_message_id: string | null;
  sender_chat_id: string | null;
  sent_at: string;
  text: string;
}

const MESSAGE_COLUMNS = `
  chat_id,
  message_id,
  author_user_id,
  author_is_bot,
  sender_chat_id,
  reply_to_message_id,
  text,
  sent_at::text as sent_at,
  captured_at::text as captured_at,
  processed_at::text as processed_at
`;

export function createPgTelegramGroupMessageStore(options: {
  client: PgClientLike;
}): PgTelegramGroupMessageStore {
  return {
    async capture(input): Promise<void> {
      const chatId = normalizeId(input.chatId, 'chat id');
      const messageId = normalizeId(input.messageId, 'message id');
      const text = normalizeText(input.text);
      await options.client.query(
        `
        insert into telegram_group_messages (
          chat_id, message_id, author_user_id, author_is_bot, sender_chat_id,
          reply_to_message_id, text, sent_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
        on conflict (chat_id, message_id) do update
        set
          author_user_id = excluded.author_user_id,
          author_is_bot = excluded.author_is_bot,
          sender_chat_id = excluded.sender_chat_id,
          reply_to_message_id = excluded.reply_to_message_id,
          text = excluded.text,
          sent_at = excluded.sent_at,
          processed_at = case
            when
              telegram_group_messages.author_user_id is not distinct from excluded.author_user_id
              and telegram_group_messages.author_is_bot = excluded.author_is_bot
              and telegram_group_messages.sender_chat_id is not distinct from excluded.sender_chat_id
              and telegram_group_messages.reply_to_message_id is not distinct from excluded.reply_to_message_id
              and telegram_group_messages.text = excluded.text
              and telegram_group_messages.sent_at = excluded.sent_at
              then telegram_group_messages.processed_at
            else null
          end,
          captured_at = now()
        `,
        [
          chatId,
          messageId,
          normalizeOptionalId(input.authorUserId, 'author user id') ?? null,
          input.authorIsBot,
          normalizeOptionalId(input.senderChatId, 'sender chat id') ?? null,
          normalizeOptionalId(input.replyToMessageId, 'reply message id') ?? null,
          text,
          normalizeTimestamp(input.sentAt),
        ],
      );
    },

    async countUnprocessed(rawChatId): Promise<number> {
      const response = await options.client.query<{ count: string }>(
        `
        select count(*)::text as count
        from telegram_group_messages
        where chat_id = $1 and processed_at is null
        `,
        [normalizeId(rawChatId, 'chat id')],
      );
      return Number(response.rows[0]?.count ?? '0');
    },

    async list(input): Promise<TelegramGroupMessageRecord[]> {
      const status = input.processingStatus ?? 'unprocessed';
      const predicate =
        status === 'processed'
          ? 'and processed_at is not null'
          : status === 'unprocessed'
            ? 'and processed_at is null'
            : '';
      const response = await options.client.query<TelegramGroupMessageRow>(
        `
        select ${MESSAGE_COLUMNS}
        from telegram_group_messages
        where chat_id = $1 ${predicate}
        order by sent_at desc, message_id desc
        limit $2
        `,
        [normalizeId(input.chatId, 'chat id'), normalizeLimit(input.limit)],
      );
      return response.rows.reverse().map(mapRow);
    },

    async listByIds(input): Promise<TelegramGroupMessageRecord[]> {
      const ids = [...new Set(input.messageIds.map((id) => normalizeId(id, 'message id')))];
      if (ids.length === 0) return [];
      const response = await options.client.query<TelegramGroupMessageRow>(
        `
        select ${MESSAGE_COLUMNS}
        from telegram_group_messages
        where chat_id = $1 and message_id = any($2::text[])
        order by sent_at, message_id
        `,
        [normalizeId(input.chatId, 'chat id'), ids],
      );
      return response.rows.map(mapRow);
    },

    async markProcessed(input): Promise<number> {
      const ids = [...new Set(input.messageIds.map((id) => normalizeId(id, 'message id')))];
      if (ids.length === 0) return 0;
      const response = await options.client.query<{ message_id: string }>(
        `
        update telegram_group_messages
        set processed_at = $3::timestamptz
        where chat_id = $1 and message_id = any($2::text[]) and processed_at is null
        returning message_id
        `,
        [normalizeId(input.chatId, 'chat id'), ids, normalizeTimestamp(input.processedAt)],
      );
      return response.rows.length;
    },

    async markUnprocessed(input): Promise<number> {
      const ids = [...new Set(input.messageIds.map((id) => normalizeId(id, 'message id')))];
      if (ids.length === 0) return 0;
      const response = await options.client.query<{ message_id: string }>(
        `
        update telegram_group_messages
        set processed_at = null
        where chat_id = $1 and message_id = any($2::text[]) and processed_at is not null
        returning message_id
        `,
        [normalizeId(input.chatId, 'chat id'), ids],
      );
      return response.rows.length;
    },

    migrate() {
      return migrateTelegramGroupMessages(options.client);
    },

    async purgeOlderThan(rawCutoff): Promise<number> {
      const response = await options.client.query<{ message_id: string }>(
        `
        delete from telegram_group_messages
        where sent_at < $1::timestamptz
        returning message_id
        `,
        [normalizeTimestamp(rawCutoff)],
      );
      return response.rows.length;
    },
  };
}

export async function migrateTelegramGroupMessages(client: PgClientLike): Promise<void> {
  await client.query(
    `
    create table if not exists telegram_group_messages (
      chat_id text not null,
      message_id text not null,
      author_user_id text,
      author_is_bot boolean not null default false,
      sender_chat_id text,
      reply_to_message_id text,
      text text not null,
      sent_at timestamptz not null,
      captured_at timestamptz not null default now(),
      processed_at timestamptz,
      primary key (chat_id, message_id)
    )
    `,
  );
  await client.query(
    `
    create index if not exists telegram_group_messages_processing_idx
      on telegram_group_messages (chat_id, sent_at, message_id)
      where processed_at is null
    `,
  );
}

function mapRow(row: TelegramGroupMessageRow): TelegramGroupMessageRecord {
  return {
    authorIsBot: row.author_is_bot,
    capturedAt: row.captured_at,
    chatId: row.chat_id,
    messageId: row.message_id,
    sentAt: row.sent_at,
    text: row.text,
    ...(row.author_user_id === null ? {} : { authorUserId: row.author_user_id }),
    ...(row.processed_at === null ? {} : { processedAt: row.processed_at }),
    ...(row.reply_to_message_id === null ? {} : { replyToMessageId: row.reply_to_message_id }),
    ...(row.sender_chat_id === null ? {} : { senderChatId: row.sender_chat_id }),
  };
}

function normalizeId(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^-?[A-Za-z0-9_:.@-]{1,200}$/u.test(normalized)) {
    throw new Error(`Telegram group message ${field} is invalid.`);
  }
  return normalized;
}

function normalizeOptionalId(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : normalizeId(value, field);
}

function normalizeText(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 16_384) {
    throw new Error('Telegram group message text must contain between 1 and 16384 characters.');
  }
  return normalized;
}

function normalizeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error('Telegram group message timestamp is invalid.');
  }
  return new Date(timestamp).toISOString();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 500;
  if (!Number.isInteger(value) || value < 1 || value > 2_000) {
    throw new Error('Telegram group message limit must be between 1 and 2000.');
  }
  return value;
}
