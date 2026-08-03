import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadWorkspaceEnv, resolveWorkspaceCwd } from '@xxyy/rag-core';
import { createXxyyMarketDataClient } from '@xxyy/xxyy-market-data-adapter';

import { createChromeXxyyScreenshotProvider } from './chrome-screenshot-provider.js';
import {
  createBrowserChainAnalysisClient,
  resolveBrowserChromeExecutable,
} from './browser-chain-analysis-client.js';
import { createConfiguredCanonicalPoolResolver } from './canonical-pool-config.js';
import { createXxyyOnchainSupportMcpServer } from './server.js';
import { createXxyyTransactionDiagnosisService } from './service.js';

const env = loadWorkspaceEnv({
  cwd: resolveWorkspaceCwd(process.cwd(), process.env),
  env: process.env,
});
const chromeExecutable = await resolveBrowserChromeExecutable(
  env.XXYY_SCREENSHOT_CHROME_EXECUTABLE,
);
const browserProfileDirectory = env.XXYY_BROWSER_PROFILE_DIRECTORY?.trim();
const chainAnalysis =
  chromeExecutable === undefined ||
  browserProfileDirectory === undefined ||
  browserProfileDirectory.length === 0
    ? undefined
    : createBrowserChainAnalysisClient({
        chromeExecutable,
        profileDirectory: browserProfileDirectory,
      });
if (chainAnalysis === undefined) {
  throw new TypeError(
    'XXYY diagnosis needs an installed Chrome/Chromium browser with XXYY_BROWSER_PROFILE_DIRECTORY.',
  );
}
const screenshotProvider = optionalScreenshotProvider(env);
const canonicalPoolResolver =
  env.XXYY_CANONICAL_POOL_CONFIG_JSON?.trim() === undefined ||
  env.XXYY_CANONICAL_POOL_CONFIG_JSON.trim().length === 0
    ? undefined
    : createConfiguredCanonicalPoolResolver(env.XXYY_CANONICAL_POOL_CONFIG_JSON);
const server = createXxyyOnchainSupportMcpServer({
  handler: createXxyyTransactionDiagnosisService({
    chainAnalysis,
    ...(canonicalPoolResolver === undefined ? {} : { canonicalPoolResolver }),
    marketData: createXxyyMarketDataClient(),
    poolPolicy: {
      maxSmallPoolLiquidityUsd: env.XXYY_SMALL_POOL_MAX_LIQUIDITY_USD?.trim() || '10000',
      maxSmallPoolRelativeLiquidityPpm: Number(
        env.XXYY_SMALL_POOL_MAX_RELATIVE_LIQUIDITY_PPM ?? '100000',
      ),
      version: '1.0.0',
    },
    ...(screenshotProvider === undefined ? {} : { screenshotProvider }),
  }),
});
await server.connect(new StdioServerTransport());

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await Promise.allSettled([server.close(), chainAnalysis.close()]);
};
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

function optionalScreenshotProvider(env: NodeJS.ProcessEnv) {
  const chromeExecutable = env.XXYY_SCREENSHOT_CHROME_EXECUTABLE?.trim();
  const artifactDirectory = env.XXYY_SCREENSHOT_DIRECTORY?.trim();
  const values = [chromeExecutable, artifactDirectory];
  if (values.every((value) => value === undefined || value.length === 0)) return undefined;
  if (values.some((value) => value === undefined || value.length === 0)) {
    throw new TypeError('XXYY screenshot configuration must be provided as one complete set.');
  }
  return createChromeXxyyScreenshotProvider({
    artifactDirectory: artifactDirectory!,
    chromeExecutable: chromeExecutable!,
  });
}
