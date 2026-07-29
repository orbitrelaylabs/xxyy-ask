import type { RagIndex } from '@xxyy/shared';
import type { ChainAnalysisMcpClient } from '@xxyy/chain-analysis-mcp';
import {
  createInMemoryProductQaMcpClient,
  createProductSearchHandler,
  type ProductQaMcpClient,
} from '@xxyy/product-qa-mcp';
import {
  LlmConfigurationError,
  loadRagConfig,
  type AnswerProvider,
  type RagConfig,
  type QualityTracer,
  type Retriever,
} from '@xxyy/rag-core';

import {
  createLangGraphCustomerRuntime,
  type CustomerAgentRuntime,
} from './langgraph-customer-runtime.js';
import { createOpenAiCompatiblePlannerModel, type PlannerModel } from './planner-model.js';
import {
  createPublicChainAnalysisCapabilityRegistry,
  type PublicChainAnalysisCaller,
} from './chain-analysis-capabilities.js';
import {
  createProductSupportCapabilityRegistry,
  createProductSupportSkillTool,
  type TrustedProductCapabilityCaller,
} from './product-support-capabilities.js';
import { createPublicChainTransactionTool } from './public-transaction-tool.js';
import { createAgentTools } from './tools/agent-tools.js';
import { createToolRegistry } from './tool-registry.js';

export interface CreateCustomerAgentChatServiceOptions {
  answerProvider: AnswerProvider;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  planner?: PlannerModel;
  productCapabilityCaller?: TrustedProductCapabilityCaller;
  productMcpClient?: ProductQaMcpClient;
  publicChainCapabilityCaller?: PublicChainAnalysisCaller;
  publicChainMcpClient?: ChainAnalysisMcpClient;
  retriever?: Retriever;
  tracer?: QualityTracer;
}

export function createCustomerAgentChatService(
  options: CreateCustomerAgentChatServiceOptions,
): CustomerAgentRuntime {
  const registry = createToolRegistry(
    options.tracer === undefined ? {} : { tracer: options.tracer },
  );

  for (const tool of createAgentTools()) {
    registry.register(tool);
  }

  const productMcpClient =
    options.productMcpClient ??
    createInMemoryProductQaMcpClient({
      handler: createProductSearchHandler({
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(options.index === undefined ? {} : { index: options.index }),
        ...(options.retriever === undefined ? {} : { retriever: options.retriever }),
        ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
      }),
    });
  const productCapabilityCaller = options.productCapabilityCaller ?? {
    channel: 'agent',
    principal: 'service',
  };
  const capabilityRegistry = createProductSupportCapabilityRegistry({
    caller: productCapabilityCaller,
    mcpClient: productMcpClient,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  registry.register(
    createProductSupportSkillTool({
      caller: productCapabilityCaller,
      registry: capabilityRegistry,
    }),
  );

  const hasPublicChainCaller = options.publicChainCapabilityCaller !== undefined;
  const hasPublicChainClient = options.publicChainMcpClient !== undefined;
  if (hasPublicChainCaller !== hasPublicChainClient) {
    throw new TypeError(
      'Public chain transaction capability requires both a fixed caller and an MCP client.',
    );
  }
  if (
    options.publicChainCapabilityCaller !== undefined &&
    options.publicChainMcpClient !== undefined
  ) {
    const publicChainRegistry = createPublicChainAnalysisCapabilityRegistry({
      caller: options.publicChainCapabilityCaller,
      mcpClient: options.publicChainMcpClient,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    registry.register(
      createPublicChainTransactionTool({
        caller: options.publicChainCapabilityCaller,
        registry: publicChainRegistry,
      }),
    );
  }

  return createLangGraphCustomerRuntime({
    answerProvider: options.answerProvider,
    planner: options.planner ?? createDefaultPlannerModel(options.config, options.tracer),
    registry,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
}

function createDefaultPlannerModel(
  configOverrides: Partial<RagConfig> | undefined,
  tracer: QualityTracer | undefined,
): PlannerModel {
  const config = {
    ...loadRagConfig(),
    ...(configOverrides ?? {}),
  };

  if (config.openAiApiKey === undefined || config.openAiApiKey.trim().length === 0) {
    return createPlannerConfigurationErrorModel(
      new LlmConfigurationError('OPENAI_API_KEY is required for agent planning.'),
    );
  }
  if (config.openAiModel === undefined || config.openAiModel.trim().length === 0) {
    return createPlannerConfigurationErrorModel(
      new LlmConfigurationError('OPENAI_MODEL is required for agent planning.'),
    );
  }

  return createOpenAiCompatiblePlannerModel({
    apiKey: config.openAiApiKey,
    baseUrl: config.openAiBaseUrl,
    model: config.openAiModel,
    requestTimeoutMs: config.openAiRequestTimeoutMs,
    ...(tracer === undefined ? {} : { tracer }),
  });
}

function createPlannerConfigurationErrorModel(error: LlmConfigurationError): PlannerModel {
  return {
    plan() {
      return Promise.reject(error);
    },
  };
}
