import { readFile } from 'node:fs/promises';

import type {
  TelegramApi,
  TelegramBotIdentity,
  TelegramSendChatActionInput,
  TelegramGetUpdatesInput,
  TelegramSendMessageInput,
  TelegramSendMessageDraftInput,
  TelegramSendPhotoInput,
  TelegramSetMyCommandsInput,
  TelegramSendVideoInput,
  TelegramUpdate,
} from './bot.js';

export interface CreateTelegramApiClientOptions {
  apiBaseUrl?: string;
  botToken: string;
  fetch?: TelegramFetch;
}

type TelegramFetch = (
  input: string,
  init: {
    body: FormData | string;
    headers?: Record<string, string>;
    method: 'POST';
  },
) => Promise<{
  json(): Promise<unknown>;
}>;

export class TelegramApiError extends Error {
  description?: string;
  method: string;

  constructor(method: string, description: string) {
    super(`Telegram Bot API ${method} failed: ${description}`);
    this.name = 'TelegramApiError';
    this.description = description;
    this.method = method;
  }
}

interface TelegramApiResponse {
  description?: string;
  ok: boolean;
  result?: unknown;
}

export function createTelegramApiClient(options: CreateTelegramApiClientOptions): TelegramApi {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const fetchImpl = options.fetch ?? fetch;

  return {
    getMe() {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'getMe', {}).then(
        readTelegramBotIdentity,
      );
    },

    getUpdates(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'getUpdates', {
        allowed_updates: ['message', 'edited_message', 'my_chat_member'],
        limit: input.limit,
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        timeout: input.timeout,
      }).then((result) => (Array.isArray(result) ? (result as TelegramUpdate[]) : []));
    },

    sendChatAction(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendChatAction', {
        action: input.action,
        chat_id: input.chatId,
      }).then(() => undefined);
    },

    sendMessage(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendMessage', {
        chat_id: input.chatId,
        link_preview_options: { is_disabled: true },
        ...(input.parseMode === undefined ? {} : { parse_mode: input.parseMode }),
        ...(input.replyToMessageId === undefined
          ? {}
          : { reply_parameters: { message_id: input.replyToMessageId } }),
        text: input.text,
      }).then(() => undefined);
    },

    sendMessageDraft(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendMessageDraft', {
        chat_id: input.chatId,
        draft_id: input.draftId,
        text: input.text,
      }).then(() => undefined);
    },

    sendPhoto(input) {
      if (typeof input.photo !== 'string') {
        return callTelegramPhotoUpload(fetchImpl, apiBaseUrl, options.botToken, input).then(
          () => undefined,
        );
      }
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendPhoto', {
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        chat_id: input.chatId,
        photo: input.photo,
        ...(input.replyToMessageId === undefined
          ? {}
          : { reply_parameters: { message_id: input.replyToMessageId } }),
      }).then(() => undefined);
    },

    sendVideo(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'sendVideo', {
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        chat_id: input.chatId,
        video: input.video,
        ...(input.replyToMessageId === undefined
          ? {}
          : { reply_parameters: { message_id: input.replyToMessageId } }),
      }).then(() => undefined);
    },

    setMyCommands(input) {
      return callTelegramMethod(fetchImpl, apiBaseUrl, options.botToken, 'setMyCommands', {
        commands: input.commands,
      }).then(() => undefined);
    },
  } satisfies TelegramApi;
}

async function callTelegramPhotoUpload(
  fetchImpl: TelegramFetch,
  apiBaseUrl: string,
  botToken: string,
  input: TelegramSendPhotoInput,
): Promise<unknown> {
  if (typeof input.photo === 'string') {
    throw new TypeError('Telegram photo upload requires a local file descriptor.');
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(input.photo.filePath);
  } catch {
    throw new TelegramApiError('sendPhoto', 'Local screenshot file could not be read.');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 10_000_000) {
    throw new TelegramApiError('sendPhoto', 'Local screenshot file size is invalid.');
  }
  const form = new FormData();
  form.set('chat_id', String(input.chatId));
  if (input.caption !== undefined) form.set('caption', input.caption);
  if (input.replyToMessageId !== undefined) {
    form.set('reply_parameters', JSON.stringify({ message_id: input.replyToMessageId }));
  }
  form.set(
    'photo',
    new Blob([new Uint8Array(bytes)], { type: input.photo.mediaType }),
    input.photo.filename,
  );
  return await callTelegramMultipartMethod(fetchImpl, apiBaseUrl, botToken, 'sendPhoto', form);
}

async function callTelegramMultipartMethod(
  fetchImpl: TelegramFetch,
  apiBaseUrl: string,
  botToken: string,
  method: 'sendPhoto',
  body: FormData,
): Promise<unknown> {
  let response: Awaited<ReturnType<TelegramFetch>>;
  try {
    response = await fetchImpl(`${apiBaseUrl}/bot${botToken}/${method}`, {
      body,
      method: 'POST',
    });
  } catch {
    throw new TelegramApiError(method, 'Transport request failed.');
  }
  return await readTelegramMethodResponse(method, response);
}

async function callTelegramMethod(
  fetchImpl: TelegramFetch,
  apiBaseUrl: string,
  botToken: string,
  method:
    | 'getMe'
    | 'getUpdates'
    | 'sendChatAction'
    | 'sendMessage'
    | 'sendMessageDraft'
    | 'sendPhoto'
    | 'sendVideo'
    | 'setMyCommands',
  payload:
    | Record<string, unknown>
    | Record<keyof TelegramSendChatActionInput, unknown>
    | Record<keyof TelegramGetUpdatesInput, unknown>
    | Record<keyof TelegramSendMessageInput, unknown>
    | Record<keyof TelegramSendMessageDraftInput, unknown>
    | Record<keyof TelegramSendPhotoInput, unknown>
    | Record<keyof TelegramSendVideoInput, unknown>
    | Record<keyof TelegramSetMyCommandsInput, unknown>,
): Promise<unknown> {
  let response: Awaited<ReturnType<TelegramFetch>>;
  try {
    response = await fetchImpl(`${apiBaseUrl}/bot${botToken}/${method}`, {
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
  } catch {
    throw new TelegramApiError(method, 'Transport request failed.');
  }
  return await readTelegramMethodResponse(method, response);
}

async function readTelegramMethodResponse(
  method: TelegramApiError['method'],
  response: Awaited<ReturnType<TelegramFetch>>,
): Promise<unknown> {
  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    throw new TelegramApiError(method, 'Invalid JSON response.');
  }
  const body = readTelegramApiResponse(rawBody);
  if (!body.ok) {
    throw new TelegramApiError(method, body.description ?? 'Unknown Telegram API error.');
  }
  return body.result;
}

function readTelegramBotIdentity(value: unknown): TelegramBotIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TelegramApiError('getMe', 'Invalid bot identity.');
  }
  const record = value as Record<string, unknown>;
  const id = record.id;
  const username = typeof record.username === 'string' ? record.username.trim() : '';
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    record.is_bot !== true ||
    username.length === 0
  ) {
    throw new TelegramApiError('getMe', 'Invalid bot identity.');
  }
  return { id, username };
}

function normalizeApiBaseUrl(value: string | undefined): string {
  const normalized = value?.trim();
  return (
    normalized === undefined || normalized.length === 0 ? 'https://api.telegram.org' : normalized
  ).replace(/\/+$/u, '');
}

function readTelegramApiResponse(value: unknown): TelegramApiResponse {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, description: 'Invalid Telegram API response.' };
  }
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ok: record.ok === true,
    result: record.result,
  };
}
