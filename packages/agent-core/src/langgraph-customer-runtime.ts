import { END, START, StateGraph } from '@langchain/langgraph';

import type {
  AgentRoute,
  ChatAttachment,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  Classification,
} from '@xxyy/shared';
import {
  classifyQuestion,
  createInitialProductSearchQuery,
  createProductQueryPlan,
  createStandaloneProductQuestion,
  createBoundaryAnswer,
  detectGroundedFactConflicts,
  filterQuestionRelevantAttachments,
  extractGroundedFacts,
  createInsufficientKnowledgeAnswer,
  createSupportConclusionFromEvidence,
  hasProductDomainSignal,
  LlmConfigurationError,
  noopQualityTracer,
  redactSensitiveSupportText,
  selectGroundingChunks,
  type AnswerProvider,
  type QualityTracer,
  type RetrievedChunk,
  shouldBlockOnGroundedFactConflicts,
  shouldUseDeterministicSupportAnswer,
  selectNextProductQuerySpec,
  understandProductQuestion,
  validateGroundedFactScope,
  VectorStoreConfigurationError,
} from '@xxyy/rag-core';

import {
  isAllowedSearchQueryRewrite,
  observeProductEvidence,
  type EvidenceObservation,
  type SearchEvidenceAttempt,
} from './evidence-observation.js';

import {
  AGENT_MAX_STEPS_DEFAULT,
  AgentStateAnnotation,
  createInitialAgentState,
  isAllowedAgentToolName,
  isExecutableAgentToolName,
  normalizeAgentRoute,
  type AgentEvidence,
  type AgentPlan,
  type AgentPolicyDecision,
  type AgentState,
  type FinalPlannerRoute,
} from './langgraph-state.js';
import {
  PlannerConfigurationError,
  type PlannerModel,
  type PlannerToolDescriptor,
} from './planner-model.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';
import {
  PUBLIC_TRANSACTION_TOOL_NAME,
  resolveSinglePublicTransactionInput,
} from './public-transaction-tool.js';
import { PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME } from './xxyy-transaction-diagnosis-tool.js';

const KNOWLEDGE_ONLY_CLARIFICATION =
  '当前只支持基于 XXYY 知识库回答产品功能、配置步骤、权益说明和官方更新相关问题。请补充一个具体的 XXYY 产品问题。';
const MAX_COLLECTED_EVIDENCE_CHUNKS = 20;

export interface CustomerAgentRuntime {
  ask(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export type AnswerQualityVariant = 'legacy' | 'optimized';

export interface CreateLangGraphCustomerRuntimeOptions {
  answerQualityVariant?: AnswerQualityVariant;
  answerProvider?: AnswerProvider;
  maxSteps?: number;
  planner: PlannerModel;
  registry: ToolRegistry;
  tracer?: QualityTracer;
}

type CustomerRuntimeNode = 'answer_composer' | 'observe' | 'planner' | 'tool_executor';

type LangGraphAgentState = Omit<
  AgentState,
  'finalResponse' | 'observation' | 'plan' | 'policyDecision' | 'route'
> & {
  finalResponse: ChatResponse | undefined;
  observation: EvidenceObservation | undefined;
  plan: AgentPlan | undefined;
  policyDecision: AgentPolicyDecision | undefined;
  route: AgentRoute | undefined;
};

export function createLangGraphCustomerRuntime(
  options: CreateLangGraphCustomerRuntimeOptions,
): CustomerAgentRuntime {
  const maxSteps = options.maxSteps ?? AGENT_MAX_STEPS_DEFAULT;
  const answerQualityVariant = options.answerQualityVariant ?? 'optimized';
  const graph = createCustomerGraph(options);
  const tracer = options.tracer ?? noopQualityTracer;

  async function askInternal(request: ChatRequest): Promise<ChatResponse> {
    const contextualRequest = contextualizePublicTransactionFollowup(request);
    const guardedResponse = await tracePreGuard(
      contextualRequest,
      tracer,
      options.registry,
      answerQualityVariant,
    );
    if (guardedResponse !== undefined) {
      return guardedResponse;
    }

    const finalState = (await graph.invoke(
      createInitialAgentState(contextualRequest, { maxSteps }),
    )) as LangGraphAgentState;

    return finalState.finalResponse ?? createClarificationResponse('无法生成可靠回答。');
  }

  async function* streamInternal(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const contextualRequest = contextualizePublicTransactionFollowup(request);
    const guardedResponse = await tracePreGuard(
      contextualRequest,
      tracer,
      options.registry,
      answerQualityVariant,
    );
    if (guardedResponse !== undefined) {
      yield* streamChatResponse(guardedResponse);
      return;
    }

    yield* streamRuntimeRequest(contextualRequest, options, maxSteps);
  }

  return {
    ask(request) {
      return tracer.run(createRequestSpan(request, answerQualityVariant), () =>
        askInternal(request),
      );
    },

    stream(request) {
      return tracer.stream(createRequestStreamSpan(request, answerQualityVariant), () =>
        streamInternal(request),
      );
    },
  };
}

function createRequestSpan(request: ChatRequest, answerQualityVariant: AnswerQualityVariant) {
  return {
    inputs: requestSummary(request),
    metadata: requestMetadata(request, answerQualityVariant),
    name: 'chat.request',
    output: summarizeResponse,
    runType: 'chain' as const,
  };
}

function createRequestStreamSpan(request: ChatRequest, answerQualityVariant: AnswerQualityVariant) {
  return {
    event: summarizeStreamEvent,
    inputs: requestSummary(request),
    metadata: requestMetadata(request, answerQualityVariant),
    name: 'chat.request',
    output: (events: readonly Record<string, unknown>[]) => ({
      eventCount: events.length,
      eventTypes: events.map((event) => event.type),
    }),
    runType: 'chain' as const,
  };
}

function requestSummary(request: ChatRequest): Record<string, unknown> {
  return {
    channel: request.channel,
    historyMessageCount: request.history?.length ?? 0,
    messageLength: request.message.length,
    sessionIdPresent: request.sessionId !== undefined,
    userIdPresent: request.userId !== undefined,
  };
}

function requestMetadata(
  request: ChatRequest,
  answerQualityVariant: AnswerQualityVariant,
): Record<string, unknown> {
  return {
    answerQualityVariant,
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
  };
}

function summarizeResponse(response: ChatResponse): Record<string, unknown> {
  return {
    ...(response.agentRoute === undefined ? {} : { agentRoute: response.agentRoute }),
    ...(response.answerStatus === undefined ? {} : { answerStatus: response.answerStatus }),
    attachmentCount: response.attachments?.length ?? 0,
    citationCount: response.citations.length,
    intent: response.intent,
    ...(response.tokenUsage === undefined ? {} : { tokenUsage: response.tokenUsage }),
  };
}

function summarizeStreamEvent(event: ChatStreamEvent): Record<string, unknown> {
  if (event.type === 'metadata') {
    return {
      ...(event.agentRoute === undefined ? {} : { agentRoute: event.agentRoute }),
      ...(event.answerStatus === undefined ? {} : { answerStatus: event.answerStatus }),
      attachmentCount: event.attachments?.length ?? 0,
      citationCount: event.citations.length,
      intent: event.intent,
      type: event.type,
    };
  }
  return event.type === 'status' ? { phase: event.phase, type: event.type } : { type: event.type };
}

async function tracePreGuard(
  request: ChatRequest,
  tracer: QualityTracer,
  registry: ToolRegistry,
  answerQualityVariant: AnswerQualityVariant,
): Promise<ChatResponse | undefined> {
  const classification = await tracer.run(
    {
      inputs: { answerQualityVariant, messageLength: request.message.length },
      name: 'agent.classify',
      output: (result) => {
        const standaloneQuestion = productQuestionForRequest(request);
        const contextualClassification =
          standaloneQuestion === request.message ? result : classifyQuestion(standaloneQuestion);
        const understanding = understandProductQuestion(
          standaloneQuestion,
          contextualClassification,
        );
        const queryPlan = createProductQueryPlan(
          request.message,
          standaloneQuestion,
          understanding,
        );
        return {
          ambiguityRequiresClarification: understanding.ambiguity.requiresClarification,
          confidence: result.confidence,
          contextualIntent: contextualClassification.intent,
          fineGrainedIntent: understanding.kind,
          intent: result.intent,
          queryCount: queryPlan.queries.length,
          queryPlanVersion: queryPlan.version,
          queryStrategy: queryPlan.strategy,
          requiredFacetCount: queryPlan.requiredFacets.length,
          standaloneQuestionChanged: standaloneQuestion !== request.message,
          subject: understanding.subject,
          temporalScope: understanding.temporalScope,
        };
      },
      runType: 'chain',
    },
    () => Promise.resolve(classifyQuestion(request.message)),
  );
  return tracer.run(
    {
      inputs: { intent: classification.intent },
      name: 'agent.guard',
      output: (response) => ({
        blocked: response !== undefined,
        ...(response?.agentRoute === undefined ? {} : { agentRoute: response.agentRoute }),
        ...(response === undefined ? {} : { intent: response.intent }),
      }),
      runType: 'chain',
    },
    () => Promise.resolve(deterministicPreGuard(request, classification, registry)),
  );
}

async function* streamRuntimeRequest(
  request: ChatRequest,
  options: CreateLangGraphCustomerRuntimeOptions,
  maxSteps: number,
): AsyncIterable<ChatStreamEvent> {
  let state = createInitialAgentState(request, { maxSteps }) as LangGraphAgentState;

  while (state.finalResponse === undefined) {
    yield {
      type: 'status',
      phase: 'planning',
      message: '正在分析问题…',
    };
    state = applyStatePatch(state, await plannerNode(state, options));
    if (state.finalResponse !== undefined) {
      break;
    }

    const plan = state.plan;
    if (plan === undefined || plan.kind === 'final') {
      state = applyStatePatch(
        state,
        await traceAnswerComposerNode(
          state,
          options.answerProvider,
          options.tracer ?? noopQualityTracer,
        ),
      );
      break;
    }

    if (plan.toolName === 'answer_product_question') {
      const toolInput = inputForToolExecution(plan, state);
      try {
        const toolStream = options.registry.stream(
          plan.toolName,
          toolInput,
          toolContextFromRequest(request),
        );
        if (toolStream !== undefined) {
          for await (const event of toolStream) {
            yield withStreamAgentRoute(event as ChatStreamEvent, 'product_answer');
          }
          return;
        }
      } catch (error) {
        if (isProductConfigurationError(error)) {
          throw error;
        }
        yield* streamChatResponse(withAgentRoute(toolFailureResponse(plan.toolName), 'clarify'));
        return;
      }
    }

    const progress = progressForTool(plan.toolName);
    yield {
      type: 'status',
      phase: progress.phase,
      message: progress.message,
    };
    state = applyStatePatch(state, await toolExecutorNode(state, options.registry));
    state = applyStatePatch(
      state,
      await traceObserveNode(
        state,
        options.tracer ?? noopQualityTracer,
        options.answerQualityVariant ?? 'optimized',
      ),
    );
    if (shouldComposeProductAnswer(state)) {
      yield {
        type: 'status',
        phase: 'answering',
        message: '正在生成回答…',
      };
      yield* traceProductAnswerStream(
        state,
        options.answerProvider,
        options.tracer ?? noopQualityTracer,
      );
      return;
    }
  }

  if (state.finalResponse === undefined) {
    state = applyStatePatch(
      state,
      await traceAnswerComposerNode(
        state,
        options.answerProvider,
        options.tracer ?? noopQualityTracer,
      ),
    );
  }

  yield* streamChatResponse(
    state.finalResponse ?? createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
  );
}

function applyStatePatch(
  state: LangGraphAgentState,
  patch: Partial<AgentState>,
): LangGraphAgentState {
  return {
    ...state,
    ...patch,
    errors: [...state.errors, ...(patch.errors ?? [])],
    evidence: [...state.evidence, ...(patch.evidence ?? [])],
    finalResponse: patch.finalResponse ?? state.finalResponse,
    messages: [...state.messages, ...(patch.messages ?? [])],
    plan: patch.plan ?? state.plan,
    policyDecision: patch.policyDecision ?? state.policyDecision,
    route: patch.route ?? state.route,
    toolCalls: [...state.toolCalls, ...(patch.toolCalls ?? [])],
    toolResults: [...state.toolResults, ...(patch.toolResults ?? [])],
  };
}

function deterministicPreGuard(
  request: ChatRequest,
  classification: Classification = classifyQuestion(request.message),
  registry?: ToolRegistry,
): ChatResponse | undefined {
  if (
    classification.intent === 'onchain_transaction' &&
    registry?.get(PUBLIC_TRANSACTION_TOOL_NAME) === undefined
  ) {
    return createPublicTransactionUnavailableResponse();
  }
  if (!shouldReturnDeterministicBoundary(classification)) {
    return undefined;
  }

  return withAgentRoute(createBoundaryAnswer(classification), 'boundary');
}

function shouldReturnDeterministicBoundary(classification: Classification): boolean {
  if (
    classification.intent === 'realtime_account_query' ||
    classification.intent === 'investment_advice'
  ) {
    return true;
  }

  return classification.intent === 'unknown' && isBoundaryUnknownReason(classification.reason);
}

function isBoundaryUnknownReason(reason: string): boolean {
  return (
    reason === 'unsafe or unsupported operation request' ||
    reason === 'business action execution request' ||
    reason === 'private credential or seed phrase disclosure' ||
    reason === 'unsupported transaction or mev analysis request'
  );
}

function createCustomerGraph(options: CreateLangGraphCustomerRuntimeOptions) {
  const tracer = options.tracer ?? noopQualityTracer;
  const answerQualityVariant = options.answerQualityVariant ?? 'optimized';
  return new StateGraph(AgentStateAnnotation)
    .addNode('planner', (state) => plannerNode(state, options))
    .addNode('tool_executor', (state) => toolExecutorNode(state, options.registry))
    .addNode('observe', (state) => traceObserveNode(state, tracer, answerQualityVariant))
    .addNode('answer_composer', (state) =>
      traceAnswerComposerNode(state, options.answerProvider, tracer),
    )
    .addEdge(START, 'planner')
    .addConditionalEdges('planner', routeAfterPlanner)
    .addEdge('tool_executor', 'observe')
    .addConditionalEdges('observe', routeAfterObserve)
    .addEdge('answer_composer', END)
    .compile();
}

async function plannerNode(
  state: LangGraphAgentState,
  options: CreateLangGraphCustomerRuntimeOptions,
): Promise<Partial<AgentState>> {
  if (state.currentStep >= state.maxSteps) {
    return {
      finalResponse: responseForStoppedSearch(
        state,
        '当前问题需要更多步骤才能可靠处理，请补充更具体的问题。',
      ),
      route: searchEvidenceList(state.evidence).length > 0 ? 'product_answer' : 'clarify',
    };
  }

  const deterministicPlan = deterministicInitialPlan(
    state,
    options.registry,
    options.answerQualityVariant ?? 'optimized',
  );
  if (deterministicPlan !== undefined) {
    return {
      currentStep: state.currentStep + 1,
      plan: deterministicPlan,
      route: normalizeAgentRoute(deterministicPlan.route),
    };
  }

  const deterministicContinuation =
    options.answerQualityVariant === 'legacy'
      ? undefined
      : deterministicProductContinuationPlan(state, options.registry);
  if (deterministicContinuation !== undefined) {
    return {
      currentStep: state.currentStep + 1,
      plan: deterministicContinuation,
      route: 'product_answer',
    };
  }

  let plan: AgentPlan;
  const plannerInput = {
    request: state.request,
    stateSummary: summarizeState(state),
    tools: listPlannerTools(options.registry, state),
  };
  const planningErrors: string[] = [];
  try {
    plan = await options.planner.plan(plannerInput);
  } catch (error) {
    if (error instanceof PlannerConfigurationError || error instanceof LlmConfigurationError) {
      throw error;
    }

    planningErrors.push(`Planner failed: ${errorMessageFrom(error)}`);
    try {
      plan = await options.planner.plan(plannerInput);
    } catch (retryError) {
      if (
        retryError instanceof PlannerConfigurationError ||
        retryError instanceof LlmConfigurationError
      ) {
        throw retryError;
      }

      return {
        errors: [...planningErrors, `Planner retry failed: ${errorMessageFrom(retryError)}`],
        finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
        route: 'clarify',
      };
    }
  }

  plan = normalizePlannerPlan(plan, state);
  if (
    plan.kind === 'tool' &&
    plan.toolName === 'search_product_docs' &&
    !canSearchProductKnowledge(state.request.message)
  ) {
    return {
      currentStep: state.currentStep + 1,
      errors: [...planningErrors, 'Planner selected product search outside the product domain.'],
      finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
      route: 'clarify',
    };
  }

  if (plan.kind === 'tool' && isRepeatedToolInput(plan, state)) {
    return {
      currentStep: state.currentStep + 1,
      errors: [...planningErrors, `Repeated tool input: ${plan.toolName}`],
      finalResponse: responseForStoppedSearch(
        state,
        '已停止重复检索同一组工具输入。请补充更具体的产品功能、模块或时间范围。',
      ),
      route: searchEvidenceList(state.evidence).length > 0 ? 'product_answer' : 'clarify',
    };
  }

  return {
    currentStep: state.currentStep + 1,
    ...(planningErrors.length > 0 ? { errors: planningErrors } : {}),
    plan,
    route: normalizeAgentRoute(plan.route),
  };
}

function deterministicInitialPlan(
  state: LangGraphAgentState,
  registry: ToolRegistry,
  answerQualityVariant: AnswerQualityVariant,
): AgentPlan | undefined {
  if (state.toolCalls.length > 0 || state.evidence.length > 0) {
    return undefined;
  }

  const productQuestion = productQuestionForRequest(state.request);
  const classification = classifyQuestion(productQuestion);
  const understanding = understandProductQuestion(productQuestion, classification);
  const registeredToolNames = new Set(registry.list().map((tool) => tool.name));
  const xxyyDiagnosisChecks = requestedXxyyDiagnosisChecks(state.request.message);
  const xxyyTransactionInput = resolveSinglePublicTransactionInput(state.request.message);
  if (
    xxyyDiagnosisChecks.length > 0 &&
    xxyyTransactionInput !== undefined &&
    registeredToolNames.has(PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME)
  ) {
    return {
      input: { ...xxyyTransactionInput, checks: xxyyDiagnosisChecks },
      kind: 'tool',
      reason: 'deterministic XXYY transaction diagnosis request',
      route: 'chain_answer',
      toolName: PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME,
    };
  }
  if (
    classification.intent === 'onchain_transaction' &&
    registeredToolNames.has(PUBLIC_TRANSACTION_TOOL_NAME)
  ) {
    return {
      input: { query: state.request.message },
      kind: 'tool',
      reason: 'deterministic public transaction reference classification',
      route: 'chain_answer',
      toolName: PUBLIC_TRANSACTION_TOOL_NAME,
    };
  }

  if (
    classification.intent === 'agent_capabilities' &&
    registeredToolNames.has('describe_agent_capabilities')
  ) {
    return {
      input: {},
      kind: 'tool',
      reason: 'deterministic customer-support Agent capability classification',
      route: 'agent_answer',
      toolName: 'describe_agent_capabilities',
    };
  }

  if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
    return undefined;
  }

  const toolName = registeredToolNames.has('search_product_docs')
    ? 'search_product_docs'
    : registeredToolNames.has('answer_product_question')
      ? 'answer_product_question'
      : undefined;
  if (toolName === undefined) {
    return undefined;
  }

  const queryPlan = createProductQueryPlan(state.request.message, productQuestion, understanding);
  const initialQuerySpec = queryPlan.queries[0];
  const initialQuery =
    answerQualityVariant === 'legacy'
      ? productQuestion
      : (initialQuerySpec?.query ??
        createInitialProductSearchQuery(productQuestion, understanding));
  return {
    input:
      toolName === 'search_product_docs'
        ? {
            query: initialQuery,
            ...(answerQualityVariant === 'legacy' || initialQuerySpec?.topK === undefined
              ? {}
              : { topK: initialQuerySpec.topK }),
          }
        : { question: productQuestion },
    kind: 'tool',
    reason: `deterministic ${classification.intent} classification`,
    route: 'product_answer',
    toolName,
  };
}

function requestedXxyyDiagnosisChecks(query: string): Array<'sandwich' | 'pool'> {
  const normalized = query.normalize('NFKC');
  const checks: Array<'sandwich' | 'pool'> = [];
  const asksForLoss = /损失|亏损|多付|少收|滑点损耗|loss/iu.test(normalized);
  const asksForAmountMismatch =
    /扣了|扣款|扣除|花了|支付(?:了)?|支出/iu.test(normalized) &&
    /显示(?:买入|成交|支付)?|成交(?:显示)?|买入(?:显示)?/iu.test(normalized) &&
    /\d/iu.test(normalized);
  if (
    /detect[_\s-]?sandwich|被夹|夹子|三明治(?:攻击)?|sandwich|\bmev\b|front[- ]?run|back[- ]?run/iu.test(
      normalized,
    )
  ) {
    checks.push('sandwich');
  }
  if (
    /小池(?:子)?|小流动性池|买错(?:了)?池(?:子)?|错误池(?:子)?|(?:正确|官方|canonical|主流动性)池(?:子)?|(?:走|经过|执行|用了?|拆分到).{0,8}(?:几个|多少个|哪些)?池(?:子)?|(?:几个|多少个|哪些)池(?:子)?|wrong\s+pool|small(?:[-\s]+liquidity)?\s+pool/iu.test(
      normalized,
    )
  ) {
    checks.push('pool');
  }
  if (asksForLoss && checks.length === 0) {
    checks.push('sandwich', 'pool');
  } else if (asksForAmountMismatch && !checks.includes('pool')) {
    checks.push('pool');
  }
  return checks;
}

function deterministicProductContinuationPlan(
  state: LangGraphAgentState,
  registry: ToolRegistry,
): AgentPlan | undefined {
  if (
    state.observation?.shouldContinue !== true ||
    registry.get('search_product_docs') === undefined
  ) {
    return undefined;
  }

  const standaloneQuestion = productQuestionForRequest(state.request);
  const understanding = understandProductQuestion(
    standaloneQuestion,
    classifyQuestion(standaloneQuestion),
  );
  const queryPlan = createProductQueryPlan(
    state.request.message,
    standaloneQuestion,
    understanding,
  );
  const searchedQueries = state.toolCalls.flatMap((toolCall) => {
    if (toolCall.toolName !== 'search_product_docs' || !isRecord(toolCall.input)) {
      return [];
    }
    const query = nonEmptyString(toolCall.input.query);
    return query === undefined ? [] : [query];
  });
  if (searchedQueries.length >= queryPlan.maxSearches) {
    return undefined;
  }
  if (queryPlan.strategy !== 'multi_query') {
    return undefined;
  }
  const nextQuery = selectNextProductQuerySpec(
    queryPlan,
    state.observation.missingFacets,
    searchedQueries,
  );
  if (nextQuery === undefined) {
    return undefined;
  }

  return {
    input: {
      query: nextQuery.query,
      ...(nextQuery.topK === undefined ? {} : { topK: nextQuery.topK }),
    },
    kind: 'tool',
    reason: `deterministic product facet search: ${state.observation.missingFacets.join(', ')}`,
    route: 'product_answer',
    toolName: 'search_product_docs',
  };
}

function routeAfterPlanner(state: LangGraphAgentState): CustomerRuntimeNode {
  if (state.finalResponse !== undefined) {
    return 'answer_composer';
  }

  return state.plan?.kind === 'tool' ? 'tool_executor' : 'answer_composer';
}

function routeAfterObserve(state: LangGraphAgentState): CustomerRuntimeNode {
  if (state.finalResponse !== undefined || state.observation?.sufficient === true) {
    return 'answer_composer';
  }

  return 'planner';
}

async function toolExecutorNode(
  state: LangGraphAgentState,
  registry: ToolRegistry,
): Promise<Partial<AgentState>> {
  const plan = state.plan;
  if (plan?.kind !== 'tool') {
    return {};
  }

  if (!isExecutableAgentToolName(plan.toolName)) {
    return {
      errors: [`Unauthorized tool requested: ${String(plan.toolName)}`],
      finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
      route: 'clarify',
    };
  }

  let output: unknown;
  const executionErrors: string[] = [];
  const toolInput = inputForToolExecution(plan, state);
  try {
    output = await registry.execute(
      plan.toolName,
      toolInput,
      toolContextFromRequest(state.request),
    );
  } catch (error) {
    if (isProductConfigurationError(error)) {
      throw error;
    }
    executionErrors.push(`Tool ${plan.toolName} failed: ${errorMessageFrom(error)}`);
    if (plan.toolName !== 'search_product_docs') {
      return {
        errors: executionErrors,
        finalResponse: toolFailureResponse(plan.toolName),
        route: 'clarify',
      };
    }
    try {
      output = await registry.execute(
        plan.toolName,
        toolInput,
        toolContextFromRequest(state.request),
      );
    } catch (retryError) {
      if (isProductConfigurationError(retryError)) {
        throw retryError;
      }
      return {
        errors: [
          ...executionErrors,
          `Tool ${plan.toolName} retry failed: ${errorMessageFrom(retryError)}`,
        ],
        finalResponse: toolFailureResponse(plan.toolName),
        route: 'clarify',
      };
    }
  }
  const evidence = evidenceFromToolOutput(plan.toolName, output);

  return {
    ...(executionErrors.length === 0 ? {} : { errors: executionErrors }),
    evidence: [evidence],
    route: routeForToolName(plan.toolName),
    toolCalls: [
      {
        input: toolInput,
        step: state.currentStep,
        toolName: plan.toolName,
      },
    ],
    toolResults: [
      {
        output,
        step: state.currentStep,
        toolName: plan.toolName,
      },
    ],
  };
}

function observeNode(
  state: LangGraphAgentState,
  answerQualityVariant: AnswerQualityVariant,
): Partial<AgentState> {
  const evidence = state.evidence.at(-1);
  if (evidence === undefined) {
    return {};
  }

  if (evidence.kind === 'chat_response') {
    return {
      finalResponse: responseFromEvidence(evidence, state.request.message),
    };
  }

  const observation = createEvidenceObservation(state, answerQualityVariant);
  if (observation.sufficient || observation.shouldContinue) {
    return { observation };
  }

  const stopMessage =
    observation.stopReason === 'no_new_evidence'
      ? '连续检索后没有找到新的知识库证据。请补充更具体的产品功能、模块、时间范围或官方更新线索。'
      : '已达到当前问题的检索步骤上限，请缩小比较范围或补充更具体的产品模块。';
  const finalResponse = responseForStoppedSearch(state, stopMessage, observation);
  return {
    finalResponse,
    observation,
    route: finalResponse.agentRoute ?? 'clarify',
  };
}

function traceObserveNode(
  state: LangGraphAgentState,
  tracer: QualityTracer,
  answerQualityVariant: AnswerQualityVariant,
): Promise<Partial<AgentState>> {
  return tracer.run(
    {
      inputs: {
        answerQualityVariant,
        evidenceCount: state.evidence.length,
        searchAttemptCount: searchEvidenceList(state.evidence).length,
      },
      name: 'agent.observe',
      output: (patch) => ({
        finalResponsePresent: patch.finalResponse !== undefined,
        ...(patch.observation === undefined
          ? {}
          : {
              authoritativeCitationCount: patch.observation.authoritativeCitationCount,
              authoritativeOverviewCitationCount:
                patch.observation.authoritativeOverviewCitationCount,
              complexity: patch.observation.complexity,
              conflictCount: patch.observation.conflicts.length,
              coverage: patch.observation.coverage,
              currentEvidenceCount: patch.observation.currentEvidenceCount,
              distinctCitationCount: patch.observation.distinctCitationCount,
              facetCoverage: patch.observation.facetCoverage.map((item) => ({
                covered: item.covered,
                evidenceCount: item.evidenceIds.length,
                facet: redactSensitiveSupportText(item.facet),
              })),
              historicalEvidenceCount: patch.observation.historicalEvidenceCount,
              latestNewEvidenceCount: patch.observation.latestNewEvidenceCount,
              missingFacetCount: patch.observation.missingFacets.length,
              nextAction: patch.observation.nextAction,
              questionKind: patch.observation.questionKind,
              shouldContinue: patch.observation.shouldContinue,
              sourceTypes: patch.observation.sourceTypes,
              stopReason: patch.observation.stopReason,
              sufficient: patch.observation.sufficient,
              version: patch.observation.version,
              xCitationCount: patch.observation.xCitationCount,
            }),
      }),
      runType: 'chain',
    },
    () => Promise.resolve(observeNode(state, answerQualityVariant)),
  );
}

function inputForToolExecution(
  plan: Extract<AgentPlan, { kind: 'tool' }>,
  state: LangGraphAgentState,
) {
  if (plan.toolName === 'answer_product_question') {
    return { question: productQuestionForRequest(state.request) };
  }

  if (plan.toolName === 'search_product_docs') {
    return inputForSearchProductDocs(plan.input, state);
  }

  return plan.input;
}

function inputForSearchProductDocs(input: unknown, state: LangGraphAgentState) {
  const fallbackQuery = productQuestionForRequest(state.request);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { question: fallbackQuery, query: fallbackQuery };
  }

  const record = input as Record<string, unknown>;
  const proposedQuery =
    nonEmptyString(record.query) ?? nonEmptyString(record.question) ?? fallbackQuery;
  const hasPreviousSearch = state.toolCalls.some(
    (toolCall) => toolCall.toolName === 'search_product_docs',
  );
  const missingFacets = state.observation?.missingFacets ?? [];
  const query = !hasPreviousSearch
    ? proposedQuery === fallbackQuery ||
      isAllowedSearchQueryRewrite(state.request.message, proposedQuery, [])
      ? proposedQuery
      : fallbackQuery
    : isAllowedSearchQueryRewrite(fallbackQuery, proposedQuery, missingFacets)
      ? proposedQuery
      : (state.observation?.suggestedQuery ?? fallbackQuery);
  const topK = positiveInteger(record.topK);

  return {
    question: fallbackQuery,
    query: query.slice(0, 240),
    ...(topK === undefined ? {} : { topK }),
  };
}

function productQuestionForRequest(request: ChatRequest): string {
  return createStandaloneProductQuestion(
    request.message,
    (request.history?.slice(-10) ?? []).map((message) => ({
      ...message,
      content: redactSensitiveSupportText(message.content).slice(0, 800),
    })),
  );
}

function contextualizePublicTransactionFollowup(request: ChatRequest): ChatRequest {
  if (
    resolveSinglePublicTransactionInput(request.message) !== undefined ||
    !isContextDependentTransactionFollowup(request.message)
  ) {
    return request;
  }

  const transaction = findRecentPublicTransactionInput(request.history ?? []);
  if (transaction === undefined) return request;

  return {
    ...request,
    message:
      `${request.message}\n上下文公开交易：${transaction.network ?? ''} ${transaction.reference}`.trim(),
  };
}

function isContextDependentTransactionFollowup(message: string): boolean {
  const normalized = message.normalize('NFKC');
  return (
    /这笔|这个交易|该交易|该笔|刚才(?:那笔)?|上(?:一|面)笔|前面(?:那笔)?|它|那(?:大概)?(?:损失|亏损)/iu.test(
      normalized,
    ) &&
    /交易|池(?:子)?|被夹|夹子|三明治|sandwich|\bmev\b|成交腿|路由|损失|亏损|多付|少收/iu.test(
      normalized,
    )
  );
}

function findRecentPublicTransactionInput(
  history: NonNullable<ChatRequest['history']>,
): ReturnType<typeof resolveSinglePublicTransactionInput> {
  for (const message of history.slice(-10).reverse()) {
    const content = message.content.slice(0, 8_192);
    const direct = resolveSinglePublicTransactionInput(content);
    if (direct !== undefined) return direct;

    const transactionId = content.match(
      /(?:^|\n)\s*(?:交易|交易哈希|transaction(?:\s+hash)?)\s*[：:]\s*`?(0x[a-f0-9]{64})`?/iu,
    )?.[1];
    const network = content.match(/(?:^|\n)\s*(?:链|网络|network)\s*[：:]\s*([^\n\r]+)/iu)?.[1];
    if (transactionId === undefined || network === undefined) continue;

    const labeled = resolveSinglePublicTransactionInput(`${network} ${transactionId}`);
    if (labeled !== undefined) return labeled;
  }
  return undefined;
}

function normalizePlannerPlan(plan: AgentPlan, state: LangGraphAgentState): AgentPlan {
  if (plan.kind !== 'tool' || plan.toolName !== 'search_product_docs') {
    return plan;
  }

  return {
    ...plan,
    input: inputForSearchProductDocs(plan.input, state),
  };
}

function canSearchProductKnowledge(question: string): boolean {
  const classification = classifyQuestion(question);
  return (
    classification.intent === 'product_qa' ||
    classification.intent === 'how_to' ||
    hasProductDomainSignal(question)
  );
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim().length === 0 ? undefined : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function answerComposerNode(
  state: LangGraphAgentState,
  answerProvider: AnswerProvider | undefined,
): Promise<Partial<AgentState>> {
  if (state.finalResponse !== undefined) {
    return {};
  }

  if (state.plan?.kind === 'final') {
    if (!isFinalPlannerRoute(state.plan.route)) {
      return {
        errors: [`Invalid final planner route: ${String(state.plan.route)}`],
        finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
        route: 'clarify',
      };
    }

    return {
      finalResponse: withAgentRoute(state.plan.response, normalizeAgentRoute(state.plan.route)),
    };
  }

  const evidence = state.evidence.at(-1);
  if (evidence !== undefined) {
    const searchEvidence = searchEvidenceList(state.evidence);
    if (searchEvidence.length > 0) {
      let response: ChatResponse;
      try {
        response = await composeProductAnswer(searchEvidence, state, answerProvider);
      } catch (error) {
        if (isProductConfigurationError(error)) {
          throw error;
        }
        return {
          errors: [`Answer composer failed: ${errorMessageFrom(error)}`],
          finalResponse: withAgentRoute(
            responseFromProductSearchEvidence(searchEvidence, state),
            'product_answer',
          ),
        };
      }
      return {
        finalResponse: withAgentRoute(response, 'product_answer'),
      };
    }

    return {
      finalResponse: responseFromEvidence(evidence, state.request.message),
    };
  }

  return {
    finalResponse: createClarificationResponse(KNOWLEDGE_ONLY_CLARIFICATION),
  };
}

function traceAnswerComposerNode(
  state: LangGraphAgentState,
  answerProvider: AnswerProvider | undefined,
  tracer: QualityTracer,
): Promise<Partial<AgentState>> {
  return tracer.run(
    {
      inputs: answerComposerInputs(state),
      name: 'agent.answer_composer',
      output: (patch) => ({
        composed: patch.finalResponse !== undefined,
        ...(patch.finalResponse === undefined ? {} : summarizeResponse(patch.finalResponse)),
      }),
      runType: 'chain',
    },
    () => answerComposerNode(state, answerProvider),
  );
}

function listPlannerTools(
  registry: ToolRegistry,
  state: LangGraphAgentState,
): PlannerToolDescriptor[] {
  const continuingProductSearch = searchEvidenceList(state.evidence).length > 0;
  return registry
    .list()
    .filter((tool) => isAllowedAgentToolName(tool.name))
    .filter((tool) => !continuingProductSearch || tool.name === 'search_product_docs')
    .map((tool) => ({
      description: tool.description,
      name: tool.name,
    }));
}

function summarizeState(state: LangGraphAgentState): string {
  const searchEvidence = searchEvidenceList(state.evidence);
  return JSON.stringify({
    currentStep: state.currentStep,
    evidenceCount: state.evidence.length,
    observation:
      state.observation === undefined
        ? undefined
        : {
            authoritativeCitationCount: state.observation.authoritativeCitationCount,
            authoritativeOverviewCitationCount:
              state.observation.authoritativeOverviewCitationCount,
            complexity: state.observation.complexity,
            conflictCount: state.observation.conflicts.length,
            coverage: state.observation.coverage,
            coveredFacets: state.observation.coveredFacets.map(redactSensitiveSupportText),
            currentEvidenceCount: state.observation.currentEvidenceCount,
            distinctCitationCount: state.observation.distinctCitationCount,
            historicalEvidenceCount: state.observation.historicalEvidenceCount,
            latestNewEvidenceCount: state.observation.latestNewEvidenceCount,
            missingFacets: state.observation.missingFacets.map(redactSensitiveSupportText),
            facetCoverage: state.observation.facetCoverage.map((item) => ({
              covered: item.covered,
              evidenceCount: item.evidenceIds.length,
              facet: redactSensitiveSupportText(item.facet),
            })),
            nextAction: state.observation.nextAction,
            questionKind: state.observation.questionKind,
            shouldContinue: state.observation.shouldContinue,
            sourceTypes: state.observation.sourceTypes,
            stopReason: state.observation.stopReason,
            sufficient: state.observation.sufficient,
            xCitationCount: state.observation.xCitationCount,
            ...(state.observation.suggestedQuery === undefined
              ? {}
              : {
                  suggestedQuery: redactSensitiveSupportText(state.observation.suggestedQuery),
                }),
          },
    route: state.route,
    searchCitationSourceCount: distinctSearchCitationKeys(searchEvidence).size,
    searchedQueries: state.toolCalls.flatMap((toolCall) => {
      if (toolCall.toolName !== 'search_product_docs' || !isRecord(toolCall.input)) {
        return [];
      }
      const query = nonEmptyString(toolCall.input.query);
      return query === undefined ? [] : [redactSensitiveSupportText(query)];
    }),
    toolCallCount: state.toolCalls.length,
  });
}

function evidenceFromToolOutput(toolName: string, output: unknown): AgentEvidence {
  if (toolName === 'search_product_docs') {
    return {
      kind: 'search_results',
      output: output as AgentEvidenceForSearch,
      toolName,
    };
  }

  return {
    kind: 'chat_response',
    response: output as ChatResponse,
    toolName,
  };
}

function responseFromEvidence(evidence: AgentEvidence, question: string): ChatResponse {
  if (evidence.kind === 'search_results') {
    return withAgentRoute(
      responseFromSearchEvidence(evidence.output, question),
      routeForToolName(evidence.toolName),
    );
  }

  return withAgentRoute(
    evidence.response,
    evidence.response.agentRoute ?? routeForToolName(evidence.toolName),
  );
}

function withStreamAgentRoute(event: ChatStreamEvent, route: AgentRoute): ChatStreamEvent {
  if (event.type !== 'metadata') {
    return event;
  }

  return {
    ...event,
    agentRoute: route,
  };
}

function routeForToolName(toolName: string): AgentRoute {
  if (toolName === 'describe_agent_capabilities') {
    return 'agent_answer';
  }
  return toolName === PUBLIC_TRANSACTION_TOOL_NAME ||
    toolName === PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME
    ? 'chain_answer'
    : 'product_answer';
}

type AgentEvidenceForSearch = Extract<AgentEvidence, { kind: 'search_results' }>['output'];

function responseFromSearchEvidence(
  output: AgentEvidenceForSearch,
  question: string,
): ChatResponse {
  return responseFromSearchEvidenceList(
    [{ kind: 'search_results', output, toolName: 'search_product_docs' }],
    question,
  );
}

async function composeProductAnswer(
  evidenceList: AgentEvidence[],
  state: LangGraphAgentState,
  answerProvider: AnswerProvider | undefined,
): Promise<ChatResponse> {
  const retrievedChunks = collectedRetrievedChunks(evidenceList);
  if (answerProvider === undefined || retrievedChunks.length === 0) {
    return responseFromProductSearchEvidence(evidenceList, state);
  }
  return answerProvider.answer(answerProviderInput(state, retrievedChunks));
}

async function* streamProductAnswer(
  state: LangGraphAgentState,
  answerProvider: AnswerProvider | undefined,
): AsyncIterable<ChatStreamEvent> {
  const evidenceList = searchEvidenceList(state.evidence);
  const retrievedChunks = collectedRetrievedChunks(evidenceList);
  if (answerProvider?.stream !== undefined && retrievedChunks.length > 0) {
    const bufferedEvents: ChatStreamEvent[] = [];
    try {
      for await (const event of answerProvider.stream(
        answerProviderInput(state, retrievedChunks),
      )) {
        bufferedEvents.push(event);
      }
    } catch (error) {
      if (isProductConfigurationError(error)) {
        throw error;
      }
      yield* streamChatResponse(
        withAgentRoute(responseFromProductSearchEvidence(evidenceList, state), 'product_answer'),
      );
      return;
    }
    for (const event of bufferedEvents) {
      yield withStreamAgentRoute(event, 'product_answer');
    }
    return;
  }

  yield* streamChatResponse(
    withAgentRoute(
      await composeProductAnswer(evidenceList, state, answerProvider),
      'product_answer',
    ),
  );
}

function answerProviderInput(state: LangGraphAgentState, retrievedChunks: RetrievedChunk[]) {
  const standaloneQuestion = productQuestionForRequest(state.request);
  const understanding = understandProductQuestion(
    standaloneQuestion,
    classifyQuestion(standaloneQuestion),
  );
  const queryPlan = createProductQueryPlan(
    state.request.message,
    standaloneQuestion,
    understanding,
  );
  return {
    classification: classificationForProductAnswer(standaloneQuestion),
    ...(state.observation === undefined
      ? {}
      : { evidenceCoverage: state.observation.facetCoverage }),
    question: state.request.message,
    retrievedChunks,
    standaloneQuestion,
    subquestions: queryPlan.subquestions,
  };
}

function traceProductAnswerStream(
  state: LangGraphAgentState,
  answerProvider: AnswerProvider | undefined,
  tracer: QualityTracer,
): AsyncIterable<ChatStreamEvent> {
  return tracer.stream(
    {
      event: summarizeStreamEvent,
      inputs: answerComposerInputs(state),
      name: 'agent.answer_composer',
      output: (events) => ({
        eventCount: events.length,
        eventTypes: events.map((event) => event.type),
      }),
      runType: 'chain',
    },
    () => streamProductAnswer(state, answerProvider),
  );
}

function answerComposerInputs(state: LangGraphAgentState): Record<string, unknown> {
  return {
    evidenceChunkCount: searchEvidenceList(state.evidence).reduce((count, evidence) => {
      return evidence.kind === 'search_results' ? count + evidence.output.chunks.length : count;
    }, 0),
    evidenceCount: state.evidence.length,
    evidenceSufficient: state.observation?.sufficient === true,
    searchAttemptCount: searchEvidenceList(state.evidence).length,
  };
}

function shouldComposeProductAnswer(state: LangGraphAgentState): boolean {
  return (
    state.finalResponse === undefined &&
    state.observation?.sufficient === true &&
    searchEvidenceList(state.evidence).length > 0
  );
}

function classificationForProductAnswer(question: string): Classification {
  const classification = classifyQuestion(question);
  if (classification.intent === 'product_qa' || classification.intent === 'how_to') {
    return classification;
  }

  return {
    confidence: 0.7,
    intent: 'product_qa',
    reason: 'planner selected bounded product knowledge search',
  };
}

function collectedRetrievedChunks(evidenceList: AgentEvidence[]): RetrievedChunk[] {
  const chunkLists = evidenceList.flatMap((evidence) => {
    if (evidence.kind !== 'search_results') {
      return [];
    }
    return [
      evidence.output.chunks.flatMap((rawChunk, index) => {
        const chunk = toRetrievedChunk(rawChunk, index + 1);
        return chunk === undefined ? [] : [chunk];
      }),
    ];
  });
  const byId = new Map<string, RetrievedChunk>();
  const maxListLength = chunkLists.reduce((max, chunks) => Math.max(max, chunks.length), 0);
  for (let chunkIndex = 0; chunkIndex < maxListLength; chunkIndex += 1) {
    for (const chunks of chunkLists) {
      const chunk = chunks[chunkIndex];
      if (chunk !== undefined && !byId.has(chunk.id)) {
        byId.set(chunk.id, chunk);
        if (byId.size >= MAX_COLLECTED_EVIDENCE_CHUNKS) {
          return [...byId.values()].map((entry, index) => ({ ...entry, rank: index + 1 }));
        }
      }
    }
  }

  return [...byId.values()].map((chunk, index) => ({ ...chunk, rank: index + 1 }));
}

function toRetrievedChunk(value: unknown, fallbackRank: number): RetrievedChunk | undefined {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    return undefined;
  }

  const id = nonEmptyString(value.id);
  const documentId = nonEmptyString(value.documentId);
  const text = nonEmptyString(value.text);
  const file = nonEmptyString(value.metadata.file);
  const moduleName = nonEmptyString(value.metadata.module);
  const title = nonEmptyString(value.metadata.title);
  const sourceType = value.metadata.sourceType;
  const headingPath = value.metadata.headingPath;
  if (
    id === undefined ||
    documentId === undefined ||
    text === undefined ||
    file === undefined ||
    moduleName === undefined ||
    title === undefined ||
    !isSourceType(sourceType) ||
    !Array.isArray(headingPath) ||
    !headingPath.every((heading) => typeof heading === 'string')
  ) {
    return undefined;
  }

  return {
    documentId,
    embedding: [],
    id,
    lexicalScore: finiteNumber(value.lexicalScore),
    metadata: {
      ...value.metadata,
      file,
      headingPath,
      module: moduleName,
      sourceType,
      title,
    },
    rank: positiveInteger(value.rank) ?? fallbackRank,
    score: finiteNumber(value.score),
    sourceBoost: finiteNumber(value.sourceBoost),
    text,
    tokens: [],
    vectorScore: finiteNumber(value.vectorScore),
  };
}

function isSourceType(value: unknown): value is RetrievedChunk['metadata']['sourceType'] {
  return value === 'admin_verified' || value === 'official_docs' || value === 'x_updates';
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function responseFromSearchEvidenceList(
  evidenceList: AgentEvidence[],
  question: string,
): ChatResponse {
  const outputs = evidenceList
    .filter((evidence): evidence is Extract<AgentEvidence, { kind: 'search_results' }> => {
      return evidence.kind === 'search_results';
    })
    .map((evidence) => evidence.output);
  const citations = uniqueCitations(outputs.flatMap((output) => output.citations));
  const attachments = filterQuestionRelevantAttachments(
    question,
    uniqueAttachments(outputs.flatMap((output) => output.attachments ?? [])),
  );
  const excerpts = citations.map((citation) => citation.excerpt);
  const supportConclusion = createSupportConclusionFromEvidence(question, excerpts);
  const confidence = outputs.reduce((max, output) => Math.max(max, output.confidence), 0);

  return {
    answer:
      excerpts.length === 0
        ? '当前知识库没有找到直接相关的产品资料。'
        : (supportConclusion ?? `根据知识库，${excerpts.join(' ')}`),
    answerStatus: excerpts.length === 0 ? 'insufficient' : 'complete',
    citations,
    confidence: Number(Math.min(0.9, Math.max(0.55, confidence / 10)).toFixed(2)),
    intent: 'product_qa',
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function responseFromProductSearchEvidence(
  evidenceList: AgentEvidence[],
  state: LangGraphAgentState,
): ChatResponse {
  const standaloneQuestion = productQuestionForRequest(state.request);
  const understanding = understandProductQuestion(
    standaloneQuestion,
    classifyQuestion(standaloneQuestion),
  );
  const queryPlan = createProductQueryPlan(
    state.request.message,
    standaloneQuestion,
    understanding,
  );
  if (queryPlan.strategy !== 'multi_query' || queryPlan.subquestions.length <= 1) {
    return responseFromSearchEvidenceList(evidenceList, state.request.message);
  }

  const searchOutputs = evidenceList.flatMap((evidence) =>
    evidence.kind === 'search_results' ? [evidence.output] : [],
  );
  const searchQueries = state.toolCalls.flatMap((toolCall) => {
    if (toolCall.toolName !== 'search_product_docs' || !isRecord(toolCall.input)) return [];
    const query = nonEmptyString(toolCall.input.query);
    return query === undefined ? [] : [query];
  });
  const outputByQuery = new Map<string, AgentEvidenceForSearch>();
  searchQueries.forEach((query, index) => {
    const output = searchOutputs[index];
    if (output !== undefined) outputByQuery.set(query, output);
  });

  const sections = queryPlan.subquestions.map((subquestion, index) => {
    const plannedQuery = queryPlan.queries.find(
      (query) => query.subquestionId === subquestion.id,
    )?.query;
    const output = plannedQuery === undefined ? undefined : outputByQuery.get(plannedQuery);
    const excerpts = uniqueCitations(output?.citations ?? []).map((citation) => citation.excerpt);
    const conclusion = createSupportConclusionFromEvidence(subquestion.question, excerpts);
    const body =
      excerpts.length === 0
        ? '当前知识库没有找到能够直接支持这一项的证据。'
        : (conclusion ?? excerpts.join(' '));
    return `${index + 1}. ${subquestion.facet}\n${body}`;
  });
  const citations = uniqueCitations(searchOutputs.flatMap((output) => output.citations));
  const attachments = filterQuestionRelevantAttachments(
    state.request.message,
    uniqueAttachments(searchOutputs.flatMap((output) => output.attachments ?? [])),
  );
  const confidence = searchOutputs.reduce(
    (maximum, output) => Math.max(maximum, output.confidence),
    0,
  );
  const coveredCount = state.observation?.facetCoverage.filter((item) => item.covered).length ?? 0;
  const answerStatus =
    coveredCount === 0
      ? 'insufficient'
      : state.observation?.sufficient === true
        ? 'complete'
        : 'partial';

  return {
    answer: sections.join('\n\n'),
    answerStatus,
    citations,
    confidence: Number(Math.min(0.9, Math.max(0.35, confidence / 10)).toFixed(2)),
    intent: classificationForProductAnswer(standaloneQuestion).intent,
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function noEvidenceSupportResponseForQuestion(question: string): ChatResponse | undefined {
  if (!shouldUseDeterministicSupportAnswer(question)) {
    return undefined;
  }

  const classification = classifyQuestion(question);
  if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
    return undefined;
  }

  return createInsufficientKnowledgeAnswer(question, classification.intent);
}

function searchEvidenceList(evidenceList: AgentEvidence[]): AgentEvidence[] {
  return evidenceList.filter((evidence) => evidence.kind === 'search_results');
}

function createEvidenceObservation(
  state: LangGraphAgentState,
  answerQualityVariant: AnswerQualityVariant,
): EvidenceObservation {
  const searchEvidence = searchEvidenceList(state.evidence);
  const searchCalls = state.toolCalls.filter(
    (toolCall) => toolCall.toolName === 'search_product_docs',
  );
  const attempts: SearchEvidenceAttempt[] = searchEvidence.map((evidence, index) => {
    if (evidence.kind !== 'search_results') {
      return { chunkIds: [], citationKeys: [], evidenceTexts: [], query: '' };
    }
    const queryInput = searchCalls[index]?.input;
    return {
      chunkIds: evidence.output.chunks.flatMap((chunk) => {
        if (!isRecord(chunk)) {
          return [];
        }
        const id = nonEmptyString(chunk.id);
        return id === undefined ? [] : [id];
      }),
      citationKeys: evidence.output.citations.map(citationKey),
      citationSourceTypes: evidence.output.citations.map((citation) => citation.sourceType),
      currentEvidenceCount: evidence.output.chunks.filter(
        (chunk) => !isHistoricalEvidenceChunk(chunk),
      ).length,
      evidenceTexts: evidence.output.citations.map(
        (citation) => `${citation.title}\n${citation.excerpt}`,
      ),
      historicalEvidenceCount: evidence.output.chunks.filter(isHistoricalEvidenceChunk).length,
      query:
        isRecord(queryInput) && nonEmptyString(queryInput.query) !== undefined
          ? (nonEmptyString(queryInput.query) ?? '')
          : '',
    };
  });

  const productQuestion = productQuestionForRequest(state.request);
  const understanding = understandProductQuestion(
    productQuestion,
    classifyQuestion(productQuestion),
  );
  const queryPlan = createProductQueryPlan(state.request.message, productQuestion, understanding);
  const maxSearches =
    queryPlan.strategy === 'multi_query'
      ? Math.min(state.maxSteps, queryPlan.maxSearches)
      : state.maxSteps;
  const observation = observeProductEvidence(productQuestion, attempts, maxSearches);
  const groundingChunks = selectGroundingChunks(
    productQuestion,
    collectedRetrievedChunks(searchEvidence),
  );
  const factReport = extractGroundedFacts(productQuestion, groundingChunks);
  const scopeValidation = validateGroundedFactScope(productQuestion, factReport.facts);
  const scopedConflicts = detectGroundedFactConflicts(
    scopeValidation.acceptedFacts,
    groundingChunks,
  );
  if (
    scopedConflicts.length === 0 ||
    !shouldBlockOnGroundedFactConflicts(productQuestion, scopeValidation)
  ) {
    if (answerQualityVariant === 'legacy' && observation.distinctCitationCount > 0) {
      return {
        ...observation,
        conflicts: [],
        nextAction: 'answer',
        shouldContinue: false,
        sufficient: true,
      };
    }
    return observation;
  }

  const stopReason =
    attempts.length >= maxSearches
      ? 'max_steps'
      : attempts.length >= 2 && observation.latestNewEvidenceCount === 0
        ? 'no_new_evidence'
        : undefined;
  const { stopReason: _stopReason, suggestedQuery: _suggestedQuery, ...base } = observation;
  const conflictSubject = scopedConflicts[0]?.subject ?? '当前事实';
  return {
    ...base,
    conflicts: scopedConflicts,
    nextAction: stopReason === undefined ? 'continue_search' : 'partial_answer',
    shouldContinue: stopReason === undefined,
    ...(stopReason === undefined ? {} : { stopReason }),
    sufficient: false,
    ...(stopReason === undefined
      ? { suggestedQuery: `XXYY ${conflictSubject} 当前 官方文档` }
      : {}),
  };
}

function isHistoricalEvidenceChunk(chunk: unknown): boolean {
  if (!isRecord(chunk) || !isRecord(chunk.metadata)) {
    return false;
  }
  return chunk.metadata.status === 'historical';
}

function responseForStoppedSearch(
  state: LangGraphAgentState,
  fallbackMessage: string,
  observation: EvidenceObservation | undefined = state.observation,
): ChatResponse {
  const searchEvidence = searchEvidenceList(state.evidence);
  if (searchEvidence.length === 0) {
    return createClarificationResponse(fallbackMessage);
  }

  const outputs = searchEvidence
    .filter((evidence): evidence is Extract<AgentEvidence, { kind: 'search_results' }> => {
      return evidence.kind === 'search_results';
    })
    .map((evidence) => evidence.output);
  const citations = uniqueCitations(outputs.flatMap((output) => output.citations));
  if (citations.length > 0) {
    const conflict = observation?.conflicts[0];
    if (conflict !== undefined) {
      return {
        agentRoute: 'product_answer',
        answerStatus: 'conflict',
        answer: `当前知识库对“${conflict.subject}”存在同范围的当前值冲突（${conflict.values.join('、')}），无法可靠给出唯一结论。相关证据已保留，需要先由知识治理确认后再更新正式答案。`,
        citations,
        confidence: 0.2,
        intent: classificationForProductAnswer(state.request.message).intent,
      };
    }
    const missing = observation?.missingFacets ?? [];
    const missingMessage =
      missing.length === 0
        ? '但证据仍不足以完整回答全部条件'
        : `但缺少“${missing.join('、')}”的直接证据`;
    const attachments = uniqueAttachments(outputs.flatMap((output) => output.attachments ?? []));
    return {
      agentRoute: 'product_answer',
      answerStatus: 'partial',
      answer: `当前知识库找到了一部分相关资料，${missingMessage}，暂时无法可靠给出完整结论。${fallbackMessage}`,
      citations,
      confidence: 0.4,
      intent: classificationForProductAnswer(state.request.message).intent,
      ...(attachments.length === 0 ? {} : { attachments }),
    };
  }

  const noEvidenceSupportResponse = noEvidenceSupportResponseForQuestion(state.request.message);
  if (noEvidenceSupportResponse !== undefined) {
    return withAgentRoute(noEvidenceSupportResponse, 'product_answer');
  }

  return createClarificationResponse(fallbackMessage);
}

function distinctSearchCitationKeys(evidenceList: AgentEvidence[]): Set<string> {
  return new Set(
    evidenceList.flatMap((evidence) => {
      if (evidence.kind !== 'search_results') {
        return [];
      }
      return evidence.output.citations.map((citation) => citationKey(citation));
    }),
  );
}

function uniqueCitations(
  citations: AgentEvidenceForSearch['citations'],
): AgentEvidenceForSearch['citations'] {
  const byKey = new Map<string, AgentEvidenceForSearch['citations'][number]>();
  for (const citation of citations) {
    byKey.set(citationKey(citation), citation);
  }
  return [...byKey.values()];
}

function uniqueAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const byKey = new Map<string, ChatAttachment>();
  for (const attachment of attachments) {
    byKey.set(
      [attachment.kind, attachment.mediaType, attachment.url, attachment.title].join('\0'),
      attachment,
    );
  }
  return [...byKey.values()];
}

function citationKey(citation: AgentEvidenceForSearch['citations'][number]): string {
  return [
    citation.sourceType ?? '',
    citation.file,
    citation.title,
    citation.sourceUrl ?? '',
    citation.excerpt,
  ].join('\0');
}

function isRepeatedToolInput(plan: AgentPlan, state: LangGraphAgentState): boolean {
  if (plan.kind !== 'tool') {
    return false;
  }

  const nextInput = inputForToolExecution(plan, state);
  if (plan.toolName === 'search_product_docs') {
    const nextQuery = normalizedSearchQuery(nextInput);
    if (nextQuery !== undefined) {
      return state.toolCalls.some(
        (toolCall) =>
          toolCall.toolName === 'search_product_docs' &&
          normalizedSearchQuery(toolCall.input) === nextQuery,
      );
    }
  }

  const nextInputKey = stableJson(nextInput);
  return state.toolCalls.some(
    (toolCall) =>
      toolCall.toolName === plan.toolName && stableJson(toolCall.input) === nextInputKey,
  );
}

function normalizedSearchQuery(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const query = nonEmptyString(input.query);
  if (query === undefined) {
    return undefined;
  }
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJsonValue(entryValue)]),
    );
  }

  return value;
}

function toolFailureResponse(toolName: string): ChatResponse {
  if (toolName === PUBLIC_TRANSACTION_TOOL_NAME) {
    return createClarificationResponse(
      '公开交易浏览器查证暂时失败。请确认 Explorer 链接可公开访问，并联系管理员检查隔离 Chrome/CDP 运行时、持久 Profile 或站点人机验证状态。',
    );
  }
  if (toolName === PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME) {
    return createClarificationResponse(
      'XXYY 交易诊断暂时失败，当前无法可靠核对目标成交、前后成交或截图。请稍后重试；系统不会用缺失证据猜测被夹或池子结论。',
    );
  }
  return createClarificationResponse(
    `当前知识库检索或 AI 服务暂时不可用，${toolName} 无法可靠处理这个请求。请稍后重试，或检查 AI/embedding 服务和向量库健康状态。`,
  );
}

function progressForTool(toolName: string): {
  message: string;
  phase: 'answering' | 'retrieving';
} {
  if (toolName === 'search_product_docs') {
    return { message: '正在检索知识库…', phase: 'retrieving' };
  }
  if (toolName === PUBLIC_TRANSACTION_TOOL_NAME) {
    return { message: '正在执行公开链上只读分析…', phase: 'retrieving' };
  }
  if (toolName === PUBLIC_XXYY_TRANSACTION_DIAGNOSIS_TOOL_NAME) {
    return { message: '正在核对链上交易与 XXYY 成交证据…', phase: 'retrieving' };
  }
  return { message: '正在生成回答…', phase: 'answering' };
}

function isFinalPlannerRoute(route: unknown): route is FinalPlannerRoute {
  return route === 'boundary' || route === 'clarify' || route === 'unsupported';
}

function toolContextFromRequest(request: ChatRequest): ToolContext {
  return {
    channel: request.channel,
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    userIdPresent: request.userId !== undefined,
  };
}

function createClarificationResponse(answer: string): ChatResponse {
  return {
    agentRoute: 'clarify',
    answer,
    citations: [],
    confidence: 0.35,
    intent: 'unknown',
  };
}

function createPublicTransactionUnavailableResponse(): ChatResponse {
  return {
    agentRoute: 'clarify',
    answer:
      '公开链上浏览器查证当前不可用。请稍后重试，或联系管理员检查隔离的浏览器 Profile 和目标 Explorer 页面。',
    citations: [],
    confidence: 0.2,
    intent: 'onchain_transaction',
  };
}

function withAgentRoute(response: ChatResponse, agentRoute: AgentRoute): ChatResponse {
  return {
    ...response,
    agentRoute,
  };
}

function errorMessageFrom(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isProductConfigurationError(error: unknown): boolean {
  if (error instanceof LlmConfigurationError || error instanceof VectorStoreConfigurationError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.constructor.name === 'EmbeddingConfigurationError' ||
    error.message.includes('required for embedding generation')
  );
}

async function* streamChatResponse(response: ChatResponse): AsyncIterable<ChatStreamEvent> {
  for (const delta of chunkAnswerForStreaming(response.answer)) {
    yield { type: 'answer_delta', delta };
    // Small delay so SSE/draft clients receive progressive frames instead of one burst.
    await delay(STREAM_CHUNK_DELAY_MS);
  }

  yield {
    type: 'metadata',
    ...(response.agentRoute === undefined ? {} : { agentRoute: response.agentRoute }),
    ...(response.answerStatus === undefined ? {} : { answerStatus: response.answerStatus }),
    ...(response.attachments === undefined ? {} : { attachments: response.attachments }),
    citations: response.citations,
    confidence: response.confidence,
    intent: response.intent,
    ...(response.tokenUsage === undefined ? {} : { tokenUsage: response.tokenUsage }),
  };
}

const STREAM_CHUNK_DELAY_MS = 20;

function chunkAnswerForStreaming(answer: string, chunkSize = 18): string[] {
  if (answer.length === 0) {
    return [];
  }
  if (answer.length <= chunkSize) {
    return [answer];
  }

  const chunks: string[] = [];
  for (let index = 0; index < answer.length; index += chunkSize) {
    chunks.push(answer.slice(index, index + chunkSize));
  }
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
