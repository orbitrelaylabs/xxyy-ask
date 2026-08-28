import {
  loadRagConfig,
  loadWorkspaceEnv,
  readKnowledgeRefreshStatus,
  resolveWorkspaceCwd,
  type RagEnv,
} from '@xxyy/rag-core';
import {
  createTransactionSkillDiagnosisHandler,
  createTransactionSkillPublicClient,
  resolveExplorerBrowserExecutable,
} from '@xxyy/transaction-skill-bridge';
import {
  loadAnswerQualityRolloutConfig,
  type AnswerQualityRolloutEnv,
  type AnswerQualityRolloutObservation,
} from '@xxyy/agent-core';
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
  Partial<
    Record<
      | 'INIT_CWD'
      | 'NODE_ENV'
      | 'PATH'
      | 'ANSWER_QUALITY_CLI_MODE'
      | 'ANSWER_QUALITY_CLI_OPTIMIZED_PERCENTAGE'
      | 'ANSWER_QUALITY_OBSERVABILITY_ENABLED'
      | 'ANSWER_QUALITY_TELEGRAM_MODE'
      | 'ANSWER_QUALITY_TELEGRAM_OPTIMIZED_PERCENTAGE'
      | 'ANSWER_QUALITY_WEB_MODE'
      | 'ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE'
      | 'XXYY_SMALL_POOL_MAX_LIQUIDITY_USD'
      | 'XXYY_SMALL_POOL_MAX_RELATIVE_LIQUIDITY_PPM'
      | 'XXYY_CANONICAL_POOL_CONFIG_JSON'
      | 'XXYY_SCREENSHOT_CHROME_EXECUTABLE'
      | 'XXYY_SCREENSHOT_DIRECTORY'
      | 'XXYY_BROWSER_PROFILE_DIRECTORY'
      | 'XXYY_BROWSER_EXTENSION_INSTALLATION_ID'
      | 'XXYY_BROWSER_NATIVE_MESSAGING_DIRECTORY'
      | 'TELEGRAM_API_BASE_URL'
      | 'TELEGRAM_GROUP_MESSAGE_RETENTION_DAYS'
      | 'TELEGRAM_DAILY_QUOTA_TIME_ZONE',
      string
    >
  >;

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
  await logExplorerBrowserStartup(workspaceEnv);
  const config = loadRagConfig(workspaceEnv);
  const botConfig = loadTelegramBotConfig(workspaceEnv);
  const publicTransactionClient =
    (await resolveExplorerBrowserExecutable(workspaceEnv)) === undefined
      ? undefined
      : createTransactionSkillPublicClient({ env: workspaceEnv });
  const runtime = createTelegramChatRuntime(config, undefined, {
    answerQualityRollout: loadAnswerQualityRolloutConfig(workspaceEnv as AnswerQualityRolloutEnv),
    telegramDailyQuotaTimeZone: parseTimeZone(
      workspaceEnv.TELEGRAM_DAILY_QUOTA_TIME_ZONE,
      'Asia/Shanghai',
    ),
    ...(parseBoolean(workspaceEnv.ANSWER_QUALITY_OBSERVABILITY_ENABLED, false)
      ? {
          answerQualityRolloutObserver: (observation: AnswerQualityRolloutObservation) => {
            logger.info(JSON.stringify({ event: 'answer_quality_rollout', ...observation }));
          },
        }
      : {}),
    ...(publicTransactionClient === undefined ? {} : { publicTransactionClient }),
    ...(publicTransactionClient === undefined
      ? {}
      : {
          xxyyTransactionDiagnosis: createTransactionSkillDiagnosisHandler({
            env: workspaceEnv,
            ...(workspaceEnv.XXYY_SCREENSHOT_DIRECTORY?.trim()
              ? { outputDirectory: workspaceEnv.XXYY_SCREENSHOT_DIRECTORY.trim() }
              : {}),
          }),
        }),
  });
  const knowledgeRuntime = createTelegramKnowledgeAutomationRuntime({
    botToken: botConfig.botToken,
    config,
    contextMessageLimit: botConfig.autoLearningContextMessages,
    defaultEnabled: botConfig.autoLearningDefaultEnabled,
    messageRetentionDays: parsePositiveInteger(
      workspaceEnv.TELEGRAM_GROUP_MESSAGE_RETENTION_DAYS,
      30,
    ),
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
    groupMessageArchive: knowledgeRuntime.groupMessageArchive,
    groupRegistry: knowledgeRuntime.groupRegistry,
    knowledgeAutomation: knowledgeRuntime.automation,
    logger,
    userDirectory: runtime.userDirectory,
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

async function logExplorerBrowserStartup(env: TelegramEnv): Promise<void> {
  const executable = await resolveExplorerBrowserExecutable(env);
  logger.info(
    executable === undefined
      ? 'Explorer browser: Chrome or Chromium not found; public transaction queries are disabled while product Q&A remains available.'
      : `Explorer browser: Chrome Connector executable available; extension connection is checked per query (${executable}).`,
  );
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
    ? true
    : ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
      ? false
      : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimeZone(value: string | undefined, fallback: string): string {
  const timeZone = value?.trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return fallback;
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
