import { Annotation } from '@langchain/langgraph';

import type { AgentRoute, ChatAttachment, ChatRequest, ChatResponse, Citation } from '@xxyy/shared';

import type { EvidenceObservation } from './evidence-observation.js';

export const AGENT_MAX_STEPS_DEFAULT = 4;

export const ALLOWED_AGENT_TOOL_NAMES = [
  'describe_agent_capabilities',
  'get_public_transaction',
  'search_product_docs',
] as const;

// Compatibility for injected runtimes/tests only. The planner schema and production registry
// expose only ALLOWED_AGENT_TOOL_NAMES.
export const LEGACY_AGENT_TOOL_NAMES = ['answer_product_question'] as const;

export type AllowedAgentToolName = (typeof ALLOWED_AGENT_TOOL_NAMES)[number];
export type LegacyAgentToolName = (typeof LEGACY_AGENT_TOOL_NAMES)[number];
export type AgentToolName = AllowedAgentToolName | LegacyAgentToolName;

export type AgentMessage = {
  role: 'assistant' | 'system' | 'tool' | 'user';
  content: string;
};

export type PlannerRoute =
  | 'agent_answer'
  | 'boundary'
  | 'chain_answer'
  | 'clarify'
  | 'product_answer'
  | 'unsupported';

export type FinalPlannerRoute = 'boundary' | 'clarify' | 'unsupported';

export type AgentPlan =
  | {
      kind: 'tool';
      reason: string;
      route: PlannerRoute;
      toolName: AgentToolName;
      input: unknown;
    }
  | {
      kind: 'final';
      reason: string;
      route: FinalPlannerRoute;
      response: ChatResponse;
    };

export type AgentToolCallRecord = {
  input: unknown;
  step: number;
  toolName: string;
};

export type AgentToolResultRecord = {
  output: unknown;
  step: number;
  toolName: string;
};

export type AgentEvidence =
  | {
      kind: 'chat_response';
      response: ChatResponse;
      toolName: string;
    }
  | {
      kind: 'search_results';
      output: {
        attachments?: ChatAttachment[];
        chunks: unknown[];
        citations: Citation[];
        confidence: number;
      };
      toolName: string;
    };

export type AgentPolicyDecision =
  | {
      action: 'continue';
    }
  | {
      action: 'final';
      response: ChatResponse;
    };

export type AgentState = {
  currentStep: number;
  errors: string[];
  evidence: AgentEvidence[];
  finalResponse?: ChatResponse;
  maxSteps: number;
  messages: AgentMessage[];
  observation?: EvidenceObservation;
  plan?: AgentPlan;
  policyDecision?: AgentPolicyDecision;
  request: ChatRequest;
  route?: AgentRoute;
  toolCalls: AgentToolCallRecord[];
  toolResults: AgentToolResultRecord[];
};

export const AgentStateAnnotation = Annotation.Root({
  currentStep: Annotation<number>({
    default: () => 0,
    reducer: (_left, right) => right,
  }),
  errors: Annotation<string[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  evidence: Annotation<AgentEvidence[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  finalResponse: Annotation<ChatResponse | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  maxSteps: Annotation<number>({
    default: () => AGENT_MAX_STEPS_DEFAULT,
    reducer: (_left, right) => right,
  }),
  messages: Annotation<AgentMessage[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  observation: Annotation<EvidenceObservation | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  plan: Annotation<AgentPlan | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  policyDecision: Annotation<AgentPolicyDecision | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  request: Annotation<ChatRequest>({
    reducer: (_left, right) => right,
  }),
  route: Annotation<AgentRoute | undefined>({
    default: () => undefined,
    reducer: (_left, right) => right,
  }),
  toolCalls: Annotation<AgentToolCallRecord[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  toolResults: Annotation<AgentToolResultRecord[]>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
});

export function createInitialAgentState(
  request: ChatRequest,
  options: { maxSteps?: number } = {},
): AgentState {
  return {
    currentStep: 0,
    errors: [],
    evidence: [],
    maxSteps: options.maxSteps ?? AGENT_MAX_STEPS_DEFAULT,
    messages: [{ role: 'user', content: request.message }],
    request,
    toolCalls: [],
    toolResults: [],
  };
}

export function isAllowedAgentToolName(name: string): name is AllowedAgentToolName {
  return ALLOWED_AGENT_TOOL_NAMES.includes(name as AllowedAgentToolName);
}

export function isExecutableAgentToolName(name: string): name is AgentToolName {
  return (
    isAllowedAgentToolName(name) || LEGACY_AGENT_TOOL_NAMES.includes(name as LegacyAgentToolName)
  );
}

export function normalizeAgentRoute(route: PlannerRoute): AgentRoute {
  if (route === 'unsupported') {
    return 'clarify';
  }
  return route;
}
