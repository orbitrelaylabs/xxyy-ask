import {
  createQualityTracerFromEnv,
  loadRagConfig,
  loadWorkspaceEnv,
  readKnowledgeRefreshStatus,
  resolveWorkspaceCwd,
  type RagEnv,
} from '@xxyy/rag-core';

import {
  TelegramBotConfigurationError,
  TELEGRAM_BOT_COMMANDS,
  createTelegramBot,
  loadTelegramBotConfig,
  runTelegramBot,
  type TelegramBotEnv,
} from './bot.js';
import { createTelegramChatRuntime } from './runtime.js';
import { createTelegramApiClient } from './telegram-api.js';
import { createTelegramKnowledgeAutomationRuntime } from './knowledge-automation.js';

type TelegramEnv = RagEnv &
  TelegramBotEnv &
  Partial<Record<'INIT_CWD' | 'TELEGRAM_API_BASE_URL', string>>;

const logger = {
  error(message: string, error?: unknown) {
    process.stderr.write(`${message}${error === undefined ? '' : ` ${formatError(error)}`}\n`);
  },
  info(message: string) {
    process.stdout.write(`${message}\n`);
  },
};

async function main(env: TelegramEnv = process.env): Promise<void> {
  const workspaceCwd = resolveWorkspaceCwd(process.cwd(), env);
  const workspaceEnv = loadWorkspaceEnv({ cwd: workspaceCwd, env });
  const config = loadRagConfig(workspaceEnv);
  const botConfig = loadTelegramBotConfig(workspaceEnv);
  const runtime = createTelegramChatRuntime(
    config,
    createQualityTracerFromEnv({ ...workspaceEnv }),
  );
  const knowledgeRuntime = createTelegramKnowledgeAutomationRuntime({
    botToken: botConfig.botToken,
    config,
    ...(workspaceEnv.TELEGRAM_API_BASE_URL === undefined
      ? {}
      : { telegramApiBaseUrl: workspaceEnv.TELEGRAM_API_BASE_URL }),
  });
  const api = createTelegramApiClient({
    botToken: botConfig.botToken,
    ...(workspaceEnv.TELEGRAM_API_BASE_URL === undefined
      ? {}
      : { apiBaseUrl: workspaceEnv.TELEGRAM_API_BASE_URL }),
  });
  const bot = createTelegramBot({
    api,
    chatService: runtime.service,
    config: botConfig,
    getKnowledgeRefreshStatus: () =>
      readKnowledgeRefreshStatus({ cwd: workspaceCwd, env: workspaceEnv }),
    knowledgeAutomation: knowledgeRuntime.automation,
    logger,
  });
  const abortController = new AbortController();

  const stop = (): void => {
    abortController.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    try {
      await api.setMyCommands?.({ commands: [...TELEGRAM_BOT_COMMANDS] });
      logger.info('Telegram bot commands configured.');
    } catch (error) {
      logger.error('Telegram bot command configuration failed.', error);
    }
    logger.info('Telegram bot polling started.');
    await runTelegramBot(bot, {
      abortSignal: abortController.signal,
      errorRetryMs: botConfig.pollErrorRetryMs,
      logger,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await Promise.all([runtime.close(), knowledgeRuntime.close()]);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof TelegramBotConfigurationError) {
    logger.error(error.message);
  } else {
    logger.error('Telegram bot failed.', error);
  }
  process.exitCode = 1;
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
