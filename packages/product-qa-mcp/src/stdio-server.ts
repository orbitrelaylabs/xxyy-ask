import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createOpenAiEmbeddingProvider } from '@xxyy/knowledge';
import {
  createLazyRetriever,
  createPgPool,
  createPgVectorStore,
  loadRagConfig,
  loadWorkspaceEnv,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';

import { createProductSearchHandler } from './search-handler.js';
import { createProductQaMcpServer } from './server.js';

const env = loadWorkspaceEnv({
  cwd: resolveWorkspaceCwd(process.cwd(), process.env),
  env: process.env,
});
const config = loadRagConfig(env);
let vectorPool: ReturnType<typeof createPgPool> | undefined;
let closing = false;

const retriever = createLazyRetriever(async () => {
  const nextPool = createPgPool(config.databaseUrl);
  try {
    const embeddingProvider = createOpenAiEmbeddingProvider({
      apiKey: config.embeddingApiKey,
      baseUrl: config.embeddingBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiEmbeddingModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    vectorPool = nextPool;
    return createPgVectorStore({
      client: nextPool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider,
    });
  } catch (error) {
    await nextPool.end();
    throw error;
  }
});

const server = createProductQaMcpServer({
  handler: createProductSearchHandler({ config, retriever }),
});
await server.connect(new StdioServerTransport());

const shutdown = async (): Promise<void> => {
  if (closing) {
    return;
  }
  closing = true;
  await server.close().catch(() => undefined);
  const pool = vectorPool;
  vectorPool = undefined;
  await pool?.end();
};

process.once('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
