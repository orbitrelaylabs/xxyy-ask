import path from 'node:path';

export interface RagConfig {
  topK: number;
  databaseUrl: string | undefined;
  embeddingApiKey: string | undefined;
  embeddingBaseUrl: string;
  embeddingDimension: number;
  openAiApiKey: string | undefined;
  openAiBaseUrl: string;
  openAiModel: string | undefined;
  openAiEmbeddingModel: string;
  openAiMaxRetries: number;
  openAiRequestTimeoutMs: number;
  wikiBundlePath?: string;
}

export type RagEnv = Partial<
  Record<
    | 'DATABASE_URL'
    | 'EMBEDDING_API_KEY'
    | 'EMBEDDING_BASE_URL'
    | 'EMBEDDING_DIMENSION'
    | 'OPENAI_API_KEY'
    | 'OPENAI_BASE_URL'
    | 'OPENAI_EMBEDDING_MODEL'
    | 'OPENAI_MAX_RETRIES'
    | 'OPENAI_MODEL'
    | 'OPENAI_REQUEST_TIMEOUT_MS'
    | 'POSTGRES_DB'
    | 'POSTGRES_HOST'
    | 'POSTGRES_PASSWORD'
    | 'POSTGRES_PORT'
    | 'POSTGRES_USER'
    | 'RAG_TOP_K'
    | 'RAG_WIKI_PATH',
    string
  >
>;

const DEFAULT_TOP_K = 6;
const DEFAULT_EMBEDDING_DIMENSION = 1536;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_OPENAI_MAX_RETRIES = 1;
const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_POSTGRES_HOST = 'localhost';
const DEFAULT_POSTGRES_PORT = '5432';

export function loadRagConfig(env: RagEnv = process.env): RagConfig {
  const openAiApiKey = env.OPENAI_API_KEY;
  const openAiBaseUrl = env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL;
  const wikiBundlePath = normalizeOptionalText(env.RAG_WIKI_PATH);
  if (wikiBundlePath !== undefined && !path.isAbsolute(wikiBundlePath)) {
    throw new Error('RAG_WIKI_PATH must be an absolute path to a published wiki bundle.');
  }
  const config: RagConfig = {
    ...(wikiBundlePath === undefined ? {} : { wikiBundlePath }),
    topK: parseTopK(env.RAG_TOP_K),
    databaseUrl: normalizeOptionalText(env.DATABASE_URL) ?? buildPostgresUrl(env),
    embeddingApiKey: normalizeOptionalText(env.EMBEDDING_API_KEY) ?? openAiApiKey,
    embeddingBaseUrl: normalizeOptionalText(env.EMBEDDING_BASE_URL) ?? openAiBaseUrl,
    embeddingDimension: parsePositiveInteger(env.EMBEDDING_DIMENSION, DEFAULT_EMBEDDING_DIMENSION),
    openAiApiKey,
    openAiBaseUrl,
    openAiModel: env.OPENAI_MODEL,
    openAiEmbeddingModel: env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
    openAiMaxRetries: parseNonNegativeInteger(env.OPENAI_MAX_RETRIES, DEFAULT_OPENAI_MAX_RETRIES),
    openAiRequestTimeoutMs: parsePositiveInteger(
      env.OPENAI_REQUEST_TIMEOUT_MS,
      DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
    ),
  };

  return config;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function buildPostgresUrl(env: RagEnv): string | undefined {
  if (
    env.POSTGRES_DB === undefined ||
    env.POSTGRES_PASSWORD === undefined ||
    env.POSTGRES_USER === undefined
  ) {
    return undefined;
  }

  const host = env.POSTGRES_HOST ?? DEFAULT_POSTGRES_HOST;
  const port = env.POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT;
  return [
    'postgres://',
    encodeURIComponent(env.POSTGRES_USER),
    ':',
    encodeURIComponent(env.POSTGRES_PASSWORD),
    '@',
    host,
    ':',
    port,
    '/',
    encodeURIComponent(env.POSTGRES_DB),
  ].join('');
}

function parseTopK(value: string | undefined): number {
  return parsePositiveInteger(value, DEFAULT_TOP_K);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}
