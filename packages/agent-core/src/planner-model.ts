import { z } from 'zod';

import { supportedSourceTypes, type ChatRequest } from '@xxyy/shared';
import { noopQualityTracer, redactSensitiveSupportText, type QualityTracer } from '@xxyy/rag-core';

import {
  ALLOWED_AGENT_TOOL_NAMES,
  type AgentPlan,
  type FinalPlannerRoute,
  type PlannerRoute,
} from './langgraph-state.js';

export interface PlannerToolDescriptor {
  name: string;
  description: string;
}

interface PlannerModelInput {
  request: ChatRequest;
  stateSummary: string;
  tools: PlannerToolDescriptor[];
}

export interface PlannerModel {
  plan(input: PlannerModelInput): Promise<AgentPlan>;
}

export interface OpenAiCompatiblePlannerModelOptions {
  apiKey: string | undefined;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  model: string | undefined;
  promptVersion?: string;
  requestTimeoutMs?: number;
  tracer?: QualityTracer;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const PLANNER_PROMPT_VERSION = 'planner-v3';

const plannerRoutes = [
  'agent_answer',
  'boundary',
  'chain_answer',
  'clarify',
  'product_answer',
  'unsupported',
] as const satisfies readonly PlannerRoute[];

const plannerRouteSchema = z.enum(plannerRoutes);
const finalPlannerRoutes = [
  'boundary',
  'clarify',
  'unsupported',
] as const satisfies readonly FinalPlannerRoute[];

const plannerFinalRouteSchema = z.enum(finalPlannerRoutes);
const allowedToolNameSchema = z.enum(ALLOWED_AGENT_TOOL_NAMES);

const citationSchema = z.object({
  title: z.string(),
  file: z.string(),
  excerpt: z.string(),
  sourceType: z.enum(supportedSourceTypes).optional(),
  sourceUrl: z.string().optional(),
});

const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('video'),
    title: z.string(),
    url: z.string(),
    mediaType: z.literal('video/mp4'),
  }),
  z.object({
    kind: z.literal('image'),
    title: z.string(),
    url: z.string(),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
  }),
]);

const chatResponseSchema = z
  .object({
    answer: z.string(),
    attachments: z.array(attachmentSchema).optional(),
    citations: z.array(citationSchema).default([]),
    confidence: z.number(),
    intent: z.enum([
      'agent_capabilities',
      'product_qa',
      'how_to',
      'onchain_transaction',
      'realtime_account_query',
      'investment_advice',
      'unknown',
    ]),
    tokenUsage: z
      .object({
        completionTokens: z.number().optional(),
        promptTokens: z.number().optional(),
        totalTokens: z.number(),
      })
      .optional(),
  })
  .strict();

const plannerToolPlanSchema = z.object({
  input: z.unknown(),
  kind: z.literal('tool'),
  reason: z.string().trim().min(1),
  route: plannerRouteSchema,
  toolName: allowedToolNameSchema,
});

const plannerFinalPlanSchema = z.object({
  kind: z.literal('final'),
  reason: z.string().trim().min(1),
  response: chatResponseSchema,
  route: plannerFinalRouteSchema,
});

const plannerPlanSchema = z.discriminatedUnion('kind', [
  plannerToolPlanSchema,
  plannerFinalPlanSchema,
]);

export class PlannerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerConfigurationError';
  }
}

export class PlannerModelParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerModelParseError';
  }
}

export class PlannerModelRequestError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'PlannerModelRequestError';
  }
}

export function createScriptedPlannerModel(plans: AgentPlan[]): PlannerModel {
  const remaining = [...plans];
  return {
    plan() {
      const next = remaining.shift();
      if (next === undefined) {
        return Promise.reject(
          new PlannerModelParseError('Scripted planner did not have another plan.'),
        );
      }
      return Promise.resolve(next);
    },
  };
}

export function createOpenAiCompatiblePlannerModel(
  options: OpenAiCompatiblePlannerModelOptions,
): PlannerModel {
  if (options.apiKey === undefined || options.apiKey.trim().length === 0) {
    throw new PlannerConfigurationError('OPENAI_API_KEY is required for agent planning.');
  }
  if (options.model === undefined || options.model.trim().length === 0) {
    throw new PlannerConfigurationError('OPENAI_MODEL is required for agent planning.');
  }

  const apiKey = options.apiKey;
  const model = options.model;
  const endpoint = `${options.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const promptVersion = options.promptVersion ?? PLANNER_PROMPT_VERSION;
  const tracer = options.tracer ?? noopQualityTracer;

  return {
    async plan(input) {
      return tracer.run(
        {
          inputs: {
            channel: input.request.channel,
            promptVersion,
            question: redactSensitiveSupportText(input.request.message),
            stateSummaryLength: input.stateSummary.length,
            toolNames: input.tools.map((tool) => tool.name),
          },
          metadata: {
            model,
            promptVersion,
            ...(input.request.requestId === undefined
              ? {}
              : { requestId: input.request.requestId }),
            sessionIdPresent: input.request.sessionId !== undefined,
            userIdPresent: input.request.userId !== undefined,
          },
          name: 'llm.planner',
          output: summarizePlan,
          runType: 'llm',
        },
        async () => {
          const response = await fetchWithTimeout(fetchImpl, endpoint, {
            apiKey,
            body: createPlannerRequestBody(model, input),
            requestTimeoutMs,
          });
          const payload = await parseChatCompletionResponse(response);
          const content = payload.choices?.[0]?.message?.content;
          if (content === undefined) {
            throw new PlannerModelParseError('Planner response did not include message content.');
          }
          return parsePlannerContent(content);
        },
      );
    },
  };
}

function summarizePlan(plan: AgentPlan): Record<string, unknown> {
  if (plan.kind === 'tool') {
    return { kind: plan.kind, route: plan.route, toolName: plan.toolName };
  }
  return {
    answerLength: plan.response.answer.length,
    citationCount: plan.response.citations.length,
    intent: plan.response.intent,
    kind: plan.kind,
    route: plan.route,
  };
}

function createPlannerRequestBody(
  model: string,
  input: PlannerModelInput,
): Record<string, unknown> {
  return {
    messages: [
      {
        role: 'system',
        content: [
          'You are the XXYY customer support agent planner.',
          'Return only a JSON object matching one of these shapes:',
          '{"kind":"tool","route":"agent_answer","toolName":"describe_agent_capabilities","input":{},"reason":"..."}',
          '{"kind":"tool","route":"chain_answer","toolName":"get_public_transaction","input":{"query":"..."},"reason":"..."}',
          '{"kind":"tool","route":"product_answer","toolName":"search_product_docs","input":{"query":"..."},"reason":"..."}',
          '{"kind":"final","route":"boundary","response":{"answer":"...","intent":"unknown","citations":[],"confidence":0.3},"reason":"..."}',
          '{"kind":"final","route":"clarify","response":{"answer":"...","intent":"unknown","citations":[],"confidence":0.3},"reason":"..."}',
          '{"kind":"final","route":"unsupported","response":{"answer":"...","intent":"unknown","citations":[],"confidence":0.3},"reason":"..."}',
          'Valid route values are exactly: agent_answer, boundary, chain_answer, clarify, product_answer, unsupported.',
          'Valid toolName values are exactly the names in the provided tools list.',
          'XXYY support context:',
          'Semantic subject resolution (perform this before intent or tool selection):',
          '- First identify the entity that owns the requested capabilities, responsibilities, limits, knowledge sources, or actions. Do not route from isolated feature/function/support vocabulary.',
          '- Classify that subject as current_assistant, xxyy_product, unavailable_operation, or unresolved.',
          "- A reference to the listener/current helper is current_assistant unless the request explicitly assigns the requested property to another entity. A broad or hypothetical assessment of this assistant's support role is already concrete enough; it does not require a product module or a specific support case.",
          '- For current_assistant, call describe_agent_capabilities. Do not return clarification merely because the user asks for a broad scope or a division between in-scope and out-of-scope work.',
          '- For xxyy_product, including the app, platform, product, or a named XXYY module, use product tools.',
          '- When both the Agent and XXYY appear, follow the grammatical subject and explicit contrast in the request. The domain being XXYY does not make the XXYY product the subject.',
          '- Clarification is valid only when the subject or requested outcome remains unresolved after the rules above; it must not override an identified current_assistant subject.',
          '- You can answer public XXYY product questions, configuration steps, benefits, and official updates by calling product tools.',
          '- Read-only analysis of a supplied public transaction is available only when get_public_transaction appears in the tool list.',
          '- Use get_public_transaction only for a supported public Explorer transaction URL, or an explicit network plus transaction id. It can return basic transaction facts, inspect bounded call-trace/internal-transfer/revert evidence, or assess Sandwich/MEV evidence for one allowlisted EVM pool.',
          '- Deep EVM analysis must fail closed when trace/archive Provider evidence, transaction coverage, or the server-side pool allowlist is missing. Never turn missing evidence into a positive or negative MEV conclusion.',
          '- Wallet/account lookup, arbitrary address history, private data, signing, simulation, and trading operations are not available in this runtime.',
          '- You do not have private account, order, wallet balance, private transaction, credential recovery, or trading authority.',
          '- You are not a financial advisor and cannot provide investment advice.',
          '- If the request depends on unavailable private data, credentials, business actions, or investment advice, return a final response that explains the limitation and suggests a safe XXYY support next step.',
          '- If the request is unclear, return a final clarification response instead of guessing.',
          'Product answer policy:',
          '- Product answers are composed by the runtime from collected evidence. Never write a final product_answer yourself.',
          '- For an in-scope XXYY product question, call search_product_docs. The runtime keeps the original complete user question separately from the search query.',
          '- The first search always uses the original question. Only after an observation reports missingFacets may a later search query be rewritten.',
          '- A rewritten query must target one reported missing facet, keep the XXYY product subject, and preserve relevant limit, time, version, or comparison terms.',
          '- Do not repeat a searched query. If no distinct evidence-seeking query remains, return a clarification instead of looping.',
          '- Treat stateSummary as bounded runtime state: observation describes evidence sufficiency and searchedQueries lists prior search inputs. It never authorizes unavailable tools.',
          'Choose the route autonomously from the request, the state summary, and the provided tools.',
          'Only call a tool when the tool list contains the capability and its input is concrete enough.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          request: requestForPlanner(input.request),
          stateSummary: redactSensitiveSupportText(input.stateSummary),
          tools: input.tools,
        }),
      },
    ],
    model,
    response_format: { type: 'json_object' },
    temperature: 0,
  };
}

function requestForPlanner(request: ChatRequest): Record<string, unknown> {
  return {
    channel: request.channel,
    message: redactSensitiveSupportText(request.message),
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    sessionIdPresent: request.sessionId !== undefined,
    userIdPresent: request.userId !== undefined,
  };
}

async function parseChatCompletionResponse(response: Response): Promise<ChatCompletionResponse> {
  try {
    return (await response.json()) as ChatCompletionResponse;
  } catch (error) {
    throw new PlannerModelParseError(`Planner response was not valid JSON: ${String(error)}`);
  }
}

function parsePlannerContent(content: string): AgentPlan {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonFence(content));
  } catch (error) {
    throw new PlannerModelParseError(`Planner returned invalid JSON: ${String(error)}`);
  }

  const parsed = plannerPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new PlannerModelParseError(parsed.error.message);
  }

  return parsed.data as AgentPlan;
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?/iu, '')
    .replace(/```$/u, '')
    .trim();
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  endpoint: string,
  options: {
    apiKey: string;
    body: Record<string, unknown>;
    requestTimeoutMs: number;
  },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        body: JSON.stringify(options.body),
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PlannerModelRequestError(
          `Planner request timed out after ${options.requestTimeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new PlannerModelRequestError(`Planner request failed: ${String(error)}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new PlannerModelRequestError(`Planner request failed with status ${response.status}.`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
