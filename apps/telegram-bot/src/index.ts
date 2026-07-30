import {
  loadRagConfig,
  loadWorkspaceEnv,
  readKnowledgeRefreshStatus,
  resolveWorkspaceCwd,
  type RagEnv,
} from '@xxyy/rag-core';
import { createPublicOnchainMcpClient } from '@xxyy/chain-analysis-mcp';
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
      | 'ANSWER_QUALITY_CLI_MODE'
      | 'ANSWER_QUALITY_CLI_OPTIMIZED_PERCENTAGE'
      | 'ANSWER_QUALITY_OBSERVABILITY_ENABLED'
      | 'ANSWER_QUALITY_TELEGRAM_MODE'
      | 'ANSWER_QUALITY_TELEGRAM_OPTIMIZED_PERCENTAGE'
      | 'ANSWER_QUALITY_WEB_MODE'
      | 'ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE'
      | 'ONCHAIN_ALLOW_INSECURE_LOCALHOST'
      | 'ONCHAIN_RPC_CONFIG_JSON'
      | 'TELEGRAM_API_BASE_URL',
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
  const config = loadRagConfig(workspaceEnv);
  const botConfig = loadTelegramBotConfig(workspaceEnv);
  const publicChainMcpClient =
    workspaceEnv.ONCHAIN_RPC_CONFIG_JSON?.trim().length === 0 ||
    workspaceEnv.ONCHAIN_RPC_CONFIG_JSON === undefined
      ? undefined
      : createPublicOnchainMcpClient({
          env: {
            ...(workspaceEnv.NODE_ENV === undefined ? {} : { NODE_ENV: workspaceEnv.NODE_ENV }),
            ...(workspaceEnv.ONCHAIN_ALLOW_INSECURE_LOCALHOST === undefined
              ? {}
              : {
                  ONCHAIN_ALLOW_INSECURE_LOCALHOST: workspaceEnv.ONCHAIN_ALLOW_INSECURE_LOCALHOST,
                }),
            ONCHAIN_RPC_CONFIG_JSON: workspaceEnv.ONCHAIN_RPC_CONFIG_JSON,
          },
        });
  const runtime = createTelegramChatRuntime(config, undefined, {
    answerQualityRollout: loadAnswerQualityRolloutConfig(workspaceEnv as AnswerQualityRolloutEnv),
    ...(parseBoolean(workspaceEnv.ANSWER_QUALITY_OBSERVABILITY_ENABLED, false)
      ? {
          answerQualityRolloutObserver: (observation: AnswerQualityRolloutObservation) => {
            logger.info(JSON.stringify({ event: 'answer_quality_rollout', ...observation }));
          },
        }
      : {}),
    ...(publicChainMcpClient === undefined ? {} : { publicChainMcpClient }),
  });
  const knowledgeRuntime = createTelegramKnowledgeAutomationRuntime({
    botToken: botConfig.botToken,
    config,
    contextMessageLimit: botConfig.autoLearningContextMessages,
    defaultEnabled: botConfig.autoLearningDefaultEnabled,
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
