import { normalizeTelegramUserId } from './trusted-authors.js';

export interface FetchTelegramAdministratorsOptions {
  botToken: string;
  chatId: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

interface TelegramChatAdministrator {
  status?: unknown;
  user?: {
    id?: unknown;
    is_bot?: unknown;
  };
}

const DEFAULT_TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export async function fetchTelegramCurrentAdministratorIds(
  options: FetchTelegramAdministratorsOptions,
): Promise<Set<string>> {
  const botToken = requireText(options.botToken, 'botToken');
  const chatId = requireText(options.chatId, 'chatId');
  const configuredApiBaseUrl = options.apiBaseUrl?.trim();
  const apiBaseUrl = (
    configuredApiBaseUrl === undefined || configuredApiBaseUrl.length === 0
      ? DEFAULT_TELEGRAM_API_BASE_URL
      : configuredApiBaseUrl
  ).replace(/\/+$/u, '');
  const timeoutMs = normalizeTimeout(options.requestTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${apiBaseUrl}/bot${botToken}/getChatAdministrators`,
      {
        body: JSON.stringify({ chat_id: chatId }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Telegram getChatAdministrators timed out after ${timeoutMs}ms.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Telegram getChatAdministrators returned invalid JSON.');
  }
  if (!isObject(body) || body.ok !== true || !Array.isArray(body.result)) {
    const description =
      isObject(body) && typeof body.description === 'string'
        ? body.description
        : `HTTP ${response.status}`;
    throw new Error(`Telegram getChatAdministrators failed: ${description}.`);
  }

  const ids = new Set<string>();
  for (const member of body.result as TelegramChatAdministrator[]) {
    if (
      !isObject(member) ||
      (member.status !== 'administrator' && member.status !== 'creator') ||
      !isObject(member.user) ||
      member.user.is_bot === true
    ) {
      continue;
    }
    const rawId = member.user.id;
    if (typeof rawId === 'number' && Number.isSafeInteger(rawId)) {
      ids.add(normalizeTelegramUserId(String(rawId)));
    } else if (typeof rawId === 'string' && rawId.trim().length > 0) {
      ids.add(normalizeTelegramUserId(rawId));
    }
  }
  return ids;
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.min(value, 60_000);
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
