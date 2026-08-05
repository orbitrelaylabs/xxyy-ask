import type { RagIndex } from '@xxyy/shared';
import type {
  PublicTransactionClient,
  XxyyTransactionDiagnosisHandler,
} from '@orbitrelaylabs/xxyy-transaction-agent-kit/runtime';
import {
  createProductSearchHandler,
  type ProductSearchHandler,
} from '@xxyy/product-support-runtime';
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
import {
  createAnswerQualityRolloutRuntime,
  loadAnswerQualityRolloutConfig,
  type AnswerQualityRolloutConfig,
  type AnswerQualityRolloutObserver,
} from './answer-quality-rollout.js';
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
import { createXxyyTransactionDiagnosisCapabilityRegistry } from './xxyy-transaction-diagnosis-capabilities.js';
import { createPublicXxyyTransactionDiagnosisTool } from './xxyy-transaction-diagnosis-tool.js';

export interface CreateCustomerAgentChatServiceOptions {
  answerQualityRollout?: AnswerQualityRolloutConfig;
  answerQualityRolloutObserver?: AnswerQualityRolloutObserver;
  answerProvider: AnswerProvider;
  config?: Partial<RagConfig>;
  index?: RagIndex;
  planner?: PlannerModel;
  productCapabilityCaller?: TrustedProductCapabilityCaller;
  productSearch?: ProductSearchHandler;
  publicChainCapabilityCaller?: PublicChainAnalysisCaller;
  publicTransactionClient?: PublicTransactionClient;
  retriever?: Retriever;
  tracer?: QualityTracer;
  xxyyDiagnosisCapabilityCaller?: PublicChainAnalysisCaller;
  xxyyTransactionDiagnosis?: XxyyTransactionDiagnosisHandler;
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

  const productSearch =
    options.productSearch ??
    createProductSearchHandler({
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.index === undefined ? {} : { index: options.index }),
      ...(options.retriever === undefined ? {} : { retriever: options.retriever }),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
  const productCapabilityCaller = options.productCapabilityCaller ?? {
    channel: 'agent',
    principal: 'service',
  };
  const capabilityRegistry = createProductSupportCapabilityRegistry({
    caller: productCapabilityCaller,
    productSearch,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  registry.register(
    createProductSupportSkillTool({
      caller: productCapabilityCaller,
      registry: capabilityRegistry,
    }),
  );

  const hasPublicChainCaller = options.publicChainCapabilityCaller !== undefined;
  const hasPublicChainClient = options.publicTransactionClient !== undefined;
  if (hasPublicChainCaller !== hasPublicChainClient) {
    throw new TypeError(
      'Public browser transaction capability requires both a fixed caller and a client.',
    );
  }
  if (
    options.publicChainCapabilityCaller !== undefined &&
    options.publicTransactionClient !== undefined
  ) {
    const publicChainRegistry = createPublicChainAnalysisCapabilityRegistry({
      caller: options.publicChainCapabilityCaller,
      client: options.publicTransactionClient,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    registry.register(
      createPublicChainTransactionTool({
        caller: options.publicChainCapabilityCaller,
        registry: publicChainRegistry,
      }),
    );
  }

  const hasXxyyDiagnosisCaller = options.xxyyDiagnosisCapabilityCaller !== undefined;
  const hasXxyyDiagnosisRuntime = options.xxyyTransactionDiagnosis !== undefined;
  if (hasXxyyDiagnosisCaller !== hasXxyyDiagnosisRuntime) {
    throw new TypeError(
      'XXYY transaction diagnosis capability requires both a fixed caller and a runtime.',
    );
  }
  if (
    options.xxyyDiagnosisCapabilityCaller !== undefined &&
    options.xxyyTransactionDiagnosis !== undefined
  ) {
    const xxyyDiagnosisRegistry = createXxyyTransactionDiagnosisCapabilityRegistry({
      caller: options.xxyyDiagnosisCapabilityCaller,
      diagnosis: options.xxyyTransactionDiagnosis,
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    registry.register(
      createPublicXxyyTransactionDiagnosisTool({
        caller: options.xxyyDiagnosisCapabilityCaller,
        registry: xxyyDiagnosisRegistry,
      }),
    );
  }

  const planner = options.planner ?? createDefaultPlannerModel(options.config, options.tracer);
  const optimized = createLangGraphCustomerRuntime({
    answerQualityVariant: 'optimized',
    answerProvider: options.answerProvider,
    planner,
    registry,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  if (
    (options.answerQualityRollout === undefined ||
      Object.values(options.answerQualityRollout.channels).every(
        (channel) => channel.mode === 'optimized',
      )) &&
    options.answerQualityRolloutObserver === undefined
  ) {
    return optimized;
  }

  const legacy = createLangGraphCustomerRuntime({
    answerQualityVariant: 'legacy',
    answerProvider: options.answerProvider,
    planner,
    registry,
    ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
  });
  return createAnswerQualityRolloutRuntime({
    config: options.answerQualityRollout ?? loadAnswerQualityRolloutConfig({}),
    legacy,
    ...(options.answerQualityRolloutObserver === undefined
      ? {}
      : { observer: options.answerQualityRolloutObserver }),
    optimized,
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
