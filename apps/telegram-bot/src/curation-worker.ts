import { hostname } from 'node:os';

import { loadRagConfig, loadWorkspaceEnv, resolveWorkspaceCwd, type RagEnv } from '@xxyy/rag-core';

import { loadTelegramBotConfig, type TelegramBotEnv } from './bot.js';
import { createTelegramKnowledgeAutomationRuntime } from './knowledge-automation.js';

type WorkerEnv = RagEnv &
  TelegramBotEnv &
  Partial<
    Record<
      | 'INIT_CWD'
      | 'TELEGRAM_API_BASE_URL'
      | 'TELEGRAM_CURATION_DEBOUNCE_SECONDS'
      | 'TELEGRAM_CURATION_WORKER_POLL_MS'
      | 'TELEGRAM_GROUP_MESSAGE_RETENTION_DAYS',
      string
    >
  >;

async function main(env: WorkerEnv = process.env): Promise<void> {
  const workspaceCwd = resolveWorkspaceCwd(process.cwd(), env);
  const workspaceEnv = loadWorkspaceEnv({ cwd: workspaceCwd, env });
  const config = loadRagConfig(workspaceEnv);
  const botConfig = loadTelegramBotConfig(workspaceEnv);
  const runtime = createTelegramKnowledgeAutomationRuntime({
    botToken: botConfig.botToken,
    config,
    contextMessageLimit: botConfig.autoLearningContextMessages,
    curationDebounceSeconds: parseNonNegativeInteger(
      workspaceEnv.TELEGRAM_CURATION_DEBOUNCE_SECONDS,
      30,
    ),
    defaultEnabled: botConfig.autoLearningDefaultEnabled,
    messageRetentionDays: parsePositiveInteger(
      workspaceEnv.TELEGRAM_GROUP_MESSAGE_RETENTION_DAYS,
      30,
    ),
    ...(workspaceEnv.TELEGRAM_API_BASE_URL === undefined
      ? {}
      : { telegramApiBaseUrl: workspaceEnv.TELEGRAM_API_BASE_URL }),
  });
  const abortController = new AbortController();
  const stop = (): void => abortController.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const workerId = `telegram-curation:${hostname()}:${process.pid}`;
  const pollMs = parsePositiveInteger(workspaceEnv.TELEGRAM_CURATION_WORKER_POLL_MS, 1_000);
  process.stdout.write(
    `${JSON.stringify({ event: 'telegram_curation_worker_started', workerId })}\n`,
  );

  try {
    while (!abortController.signal.aborted) {
      const job = await runtime.curationJobs.claimNext({ workerId });
      if (job === undefined) {
        await delay(pollMs, abortController.signal);
        continue;
      }
      try {
        const result = await runtime.processInbox(job.chatId);
        const completed = await runtime.curationJobs.complete({
          attemptCount: job.attemptCount,
          chatId: job.chatId,
          result: { ...result },
          workerId,
        });
        process.stdout.write(
          `${JSON.stringify({ event: 'telegram_curation_completed', chatId: job.chatId, completed, result })}\n`,
        );
      } catch (error) {
        const errorCode = classifyError(error);
        const failed = await runtime.curationJobs.fail({
          attemptCount: job.attemptCount,
          chatId: job.chatId,
          errorCode,
          workerId,
        });
        process.stderr.write(
          `${JSON.stringify({ event: 'telegram_curation_failed', chatId: job.chatId, errorCode, failed })}\n`,
        );
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await runtime.close();
  }
}

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  return error.name
    .replace(/Error$/u, '')
    .replace(/([a-z])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .slice(0, 120);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Telegram curation worker failed. ${message}\n`);
  process.exitCode = 1;
});
