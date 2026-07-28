import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { KnowledgeRefreshStatus } from '@xxyy/shared';

const DEFAULT_INCREMENTAL_DAILY_AT = '08:00';
const DEFAULT_STALE_AFTER_MINUTES = 26 * 60;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const DEFAULT_RECEIPT_PATH = '.rag/knowledge-refresh/latest.json';

export type KnowledgeRefreshStatusEnv = Partial<Record<string, string | undefined>>;

export interface ReadKnowledgeRefreshStatusOptions {
  cwd?: string;
  env?: KnowledgeRefreshStatusEnv;
  now?: () => Date;
  readTextFile?: (filePath: string) => Promise<string>;
}

interface KnowledgeRefreshReceipt {
  finishedAt: string;
  mode: 'full' | 'incremental';
  status: 'failed' | 'planned' | 'succeeded';
}

export async function readKnowledgeRefreshStatus(
  options: ReadKnowledgeRefreshStatusOptions = {},
): Promise<KnowledgeRefreshStatus> {
  const env = options.env ?? process.env;
  const enabled = parseEnabled(env.KNOWLEDGE_AUTO_REFRESH_ENABLED);
  const schedule = {
    fullMode: 'manual' as const,
    incrementalDailyAt: parseDailyTime(
      env.KNOWLEDGE_AUTO_REFRESH_INCREMENTAL_DAILY_AT,
      DEFAULT_INCREMENTAL_DAILY_AT,
    ),
    timeZone: normalizeOptionalText(env.KNOWLEDGE_AUTO_REFRESH_TIME_ZONE) ?? DEFAULT_TIME_ZONE,
  };

  if (!enabled) {
    return { enabled: false, schedule, state: 'disabled' };
  }

  const receiptFile = resolveReceiptFile(
    options.cwd ?? process.cwd(),
    env.KNOWLEDGE_AUTO_REFRESH_RECEIPT_FILE,
  );
  let rawReceipt: string;
  try {
    rawReceipt = await (options.readTextFile ?? readUtf8File)(receiptFile);
  } catch (error) {
    return {
      enabled: true,
      schedule,
      state: hasErrorCode(error, 'ENOENT') ? 'pending' : 'unavailable',
    };
  }

  const receipt = parseReceipt(rawReceipt);
  if (receipt === undefined) {
    return { enabled: true, schedule, state: 'unavailable' };
  }
  if (receipt.status === 'planned') {
    return { enabled: true, schedule, state: 'pending' };
  }

  const lastRun = {
    finishedAt: receipt.finishedAt,
    mode: receipt.mode,
    status: receipt.status,
  } as const;
  if (receipt.status === 'failed') {
    return { enabled: true, lastRun, schedule, state: 'failed' };
  }

  const finishedAtMs = Date.parse(receipt.finishedAt);
  if (!Number.isFinite(finishedAtMs)) {
    return { enabled: true, schedule, state: 'unavailable' };
  }
  const now = options.now?.() ?? new Date();
  const staleAfterMinutes = parsePositiveInteger(
    env.KNOWLEDGE_AUTO_REFRESH_STALE_AFTER_MINUTES,
    DEFAULT_STALE_AFTER_MINUTES,
  );
  const ageMs = now.getTime() - finishedAtMs;
  const state = ageMs > staleAfterMinutes * 60_000 ? 'stale' : 'healthy';

  return { enabled: true, lastRun, schedule, state };
}

function parseReceipt(rawReceipt: string): KnowledgeRefreshReceipt | undefined {
  let value: unknown;
  try {
    value = JSON.parse(rawReceipt);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.mode !== 'full' && record.mode !== 'incremental') ||
    (record.status !== 'failed' && record.status !== 'planned' && record.status !== 'succeeded') ||
    typeof record.finishedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    finishedAt: record.finishedAt,
    mode: record.mode,
    status: record.status,
  };
}

function parseEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDailyTime(value: string | undefined, fallback: string): string {
  const normalized = normalizeOptionalText(value);
  return normalized !== undefined && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(normalized)
    ? normalized
    : fallback;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function resolveReceiptFile(cwd: string, configuredPath: string | undefined): string {
  const normalizedPath = normalizeOptionalText(configuredPath) ?? DEFAULT_RECEIPT_PATH;
  return path.resolve(cwd, normalizedPath);
}

function readUtf8File(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
