import { createHash } from 'node:crypto';

import type {
  ChatChannel,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  SourceType,
} from '@xxyy/shared';
import { noopQualityTracer, type QualityTracer } from '@xxyy/rag-core';

import type { AnswerQualityVariant, CustomerAgentRuntime } from './langgraph-customer-runtime.js';

export type AnswerQualityMode = 'legacy' | 'optimized' | 'shadow';

export interface AnswerQualityChannelRollout {
  mode: AnswerQualityMode;
  optimizedPercentage: number;
}

export interface AnswerQualityRolloutConfig {
  channels: Record<ChatChannel, AnswerQualityChannelRollout>;
  version: '1';
}

export interface AnswerQualityRolloutObservation {
  answerFingerprintEqual?: boolean;
  answerStatus?: ChatResponse['answerStatus'];
  channel: ChatChannel;
  citationCount?: number;
  citationCountDelta?: number;
  configVersion: '1';
  errorName?: string;
  intent?: ChatResponse['intent'];
  intentEqual?: boolean;
  mode: AnswerQualityMode;
  observedAt: string;
  optimizedPercentage: number;
  outcome: 'error' | 'success';
  primaryLatencyMs: number;
  primaryRoute?: ChatResponse['agentRoute'];
  primarySourceTypes?: SourceType[];
  primaryVariant: AnswerQualityVariant;
  schemaVersion: '1';
  shadowAnswerStatus?: ChatResponse['answerStatus'];
  shadowCitationCount?: number;
  shadowErrorName?: string;
  shadowLatencyMs?: number;
  shadowRoute?: ChatResponse['agentRoute'];
  shadowSourceTypes?: SourceType[];
  shadowTotalTokens?: number;
  shadowVariant?: AnswerQualityVariant;
  sourceTypesEqual?: boolean;
  totalTokenDelta?: number;
  totalTokens?: number;
}

export type AnswerQualityRolloutObserver = (
  observation: AnswerQualityRolloutObservation,
) => Promise<void> | void;

export type AnswerQualityRolloutEnv = Partial<
  Record<
    | 'ANSWER_QUALITY_CLI_MODE'
    | 'ANSWER_QUALITY_CLI_OPTIMIZED_PERCENTAGE'
    | 'ANSWER_QUALITY_TELEGRAM_MODE'
    | 'ANSWER_QUALITY_TELEGRAM_OPTIMIZED_PERCENTAGE'
    | 'ANSWER_QUALITY_WEB_MODE'
    | 'ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE',
    string
  >
>;

export class AnswerQualityRolloutConfigurationError extends Error {}

export function loadAnswerQualityRolloutConfig(
  env: AnswerQualityRolloutEnv = process.env,
): AnswerQualityRolloutConfig {
  return {
    channels: {
      cli: channelConfig(env.ANSWER_QUALITY_CLI_MODE, env.ANSWER_QUALITY_CLI_OPTIMIZED_PERCENTAGE),
      telegram: channelConfig(
        env.ANSWER_QUALITY_TELEGRAM_MODE,
        env.ANSWER_QUALITY_TELEGRAM_OPTIMIZED_PERCENTAGE,
      ),
      web: channelConfig(env.ANSWER_QUALITY_WEB_MODE, env.ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE),
    },
    version: '1',
  };
}

export function createAnswerQualityRolloutRuntime(options: {
  config: AnswerQualityRolloutConfig;
  legacy: CustomerAgentRuntime;
  now?: () => number;
  observer?: AnswerQualityRolloutObserver;
  optimized: CustomerAgentRuntime;
  tracer?: QualityTracer;
}): CustomerAgentRuntime {
  const tracer = options.tracer ?? noopQualityTracer;
  const now = options.now ?? Date.now;
  return {
    async ask(request) {
      const decision = rolloutDecision(options.config, request);
      const channelConfig = options.config.channels[request.channel];
      if (decision.shadowVariant === undefined) {
        const startedAt = now();
        try {
          const response = await runtimeForVariant(options, decision.primaryVariant).ask(request);
          await emitRolloutObservation(options.observer, {
            ...observationFromResponse(response),
            channel: request.channel,
            configVersion: options.config.version,
            mode: channelConfig.mode,
            observedAt: new Date(now()).toISOString(),
            optimizedPercentage: channelConfig.optimizedPercentage,
            outcome: 'success',
            primaryLatencyMs: Math.max(0, now() - startedAt),
            primaryVariant: decision.primaryVariant,
            schemaVersion: '1',
          });
          return response;
        } catch (error) {
          await emitRolloutObservation(options.observer, {
            channel: request.channel,
            configVersion: options.config.version,
            errorName: errorName(error),
            mode: channelConfig.mode,
            observedAt: new Date(now()).toISOString(),
            optimizedPercentage: channelConfig.optimizedPercentage,
            outcome: 'error',
            primaryLatencyMs: Math.max(0, now() - startedAt),
            primaryVariant: decision.primaryVariant,
            schemaVersion: '1',
          });
          throw error;
        }
      }
      return await tracer
        .run(
          {
            inputs: {
              channel: request.channel,
              configVersion: options.config.version,
              primaryVariant: decision.primaryVariant,
              shadowVariant: decision.shadowVariant,
            },
            name: 'agent.answer_quality_shadow',
            output: (result) => result.comparison,
            runType: 'chain',
          },
          async () => {
            const primaryRuntime = runtimeForVariant(options, decision.primaryVariant);
            const shadowRuntime = runtimeForVariant(
              options,
              decision.shadowVariant as AnswerQualityVariant,
            );
            const shadowStartedAt = now();
            const shadowPromise = shadowRuntime
              .ask(request)
              .then((response) => ({ latencyMs: Math.max(0, now() - shadowStartedAt), response }))
              .catch((error: unknown) => ({ error: errorName(error) }));
            const primaryStartedAt = now();
            let primary: ChatResponse;
            try {
              primary = await primaryRuntime.ask(request);
            } catch (error) {
              await emitRolloutObservation(options.observer, {
                channel: request.channel,
                configVersion: options.config.version,
                errorName: errorName(error),
                mode: channelConfig.mode,
                observedAt: new Date(now()).toISOString(),
                optimizedPercentage: channelConfig.optimizedPercentage,
                outcome: 'error',
                primaryLatencyMs: Math.max(0, now() - primaryStartedAt),
                primaryVariant: decision.primaryVariant,
                schemaVersion: '1',
                shadowVariant: decision.shadowVariant as AnswerQualityVariant,
              });
              throw error;
            }
            const primaryLatencyMs = Math.max(0, now() - primaryStartedAt);
            const shadow = await shadowPromise;
            await emitRolloutObservation(
              options.observer,
              observationFromShadow({
                channel: request.channel,
                channelConfig,
                configVersion: options.config.version,
                now,
                primary,
                primaryLatencyMs,
                primaryVariant: decision.primaryVariant,
                shadow,
                shadowVariant: decision.shadowVariant as AnswerQualityVariant,
              }),
            );
            return {
              comparison: compareResponses(
                decision.primaryVariant,
                primary,
                primaryLatencyMs,
                decision.shadowVariant as AnswerQualityVariant,
                shadow,
              ),
              primary,
            };
          },
        )
        .then((result) => result.primary);
    },
    async *stream(request) {
      const decision = rolloutDecision(options.config, request);
      const channelConfig = options.config.channels[request.channel];
      const primaryRuntime = runtimeForVariant(options, decision.primaryVariant);
      if (decision.shadowVariant === undefined) {
        const primaryStartedAt = now();
        let answer = '';
        let metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined;
        try {
          for await (const event of primaryRuntime.stream(request)) {
            if (event.type === 'answer_delta') {
              answer += event.delta;
            } else if (event.type === 'metadata') {
              metadata = event;
            }
            yield event;
          }
          const primary = responseFromStream(answer, metadata);
          await emitRolloutObservation(options.observer, {
            ...observationFromResponse(primary),
            channel: request.channel,
            configVersion: options.config.version,
            mode: channelConfig.mode,
            observedAt: new Date(now()).toISOString(),
            optimizedPercentage: channelConfig.optimizedPercentage,
            outcome: 'success',
            primaryLatencyMs: Math.max(0, now() - primaryStartedAt),
            primaryVariant: decision.primaryVariant,
            schemaVersion: '1',
          });
        } catch (error) {
          await emitRolloutObservation(options.observer, {
            channel: request.channel,
            configVersion: options.config.version,
            errorName: errorName(error),
            mode: channelConfig.mode,
            observedAt: new Date(now()).toISOString(),
            optimizedPercentage: channelConfig.optimizedPercentage,
            outcome: 'error',
            primaryLatencyMs: Math.max(0, now() - primaryStartedAt),
            primaryVariant: decision.primaryVariant,
            schemaVersion: '1',
          });
          throw error;
        }
        return;
      }

      const shadowRuntime = runtimeForVariant(options, decision.shadowVariant);
      const shadowStartedAt = now();
      const shadowPromise = shadowRuntime
        .ask(request)
        .then((response) => ({ latencyMs: Math.max(0, now() - shadowStartedAt), response }))
        .catch((error: unknown) => ({ error: errorName(error) }));
      const primaryStartedAt = now();
      let answer = '';
      let metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined;
      try {
        for await (const event of primaryRuntime.stream(request)) {
          if (event.type === 'answer_delta') {
            answer += event.delta;
          } else if (event.type === 'metadata') {
            metadata = event;
          }
          yield event;
        }
      } catch (error) {
        await emitRolloutObservation(options.observer, {
          channel: request.channel,
          configVersion: options.config.version,
          errorName: errorName(error),
          mode: channelConfig.mode,
          observedAt: new Date(now()).toISOString(),
          optimizedPercentage: channelConfig.optimizedPercentage,
          outcome: 'error',
          primaryLatencyMs: Math.max(0, now() - primaryStartedAt),
          primaryVariant: decision.primaryVariant,
          schemaVersion: '1',
          shadowVariant: decision.shadowVariant,
        });
        throw error;
      }
      const shadow = await shadowPromise;
      const primary = responseFromStream(answer, metadata);
      const primaryLatencyMs = Math.max(0, now() - primaryStartedAt);
      await emitRolloutObservation(
        options.observer,
        observationFromShadow({
          channel: request.channel,
          channelConfig,
          configVersion: options.config.version,
          now,
          primary,
          primaryLatencyMs,
          primaryVariant: decision.primaryVariant,
          shadow,
          shadowVariant: decision.shadowVariant,
        }),
      );
      await tracer.run(
        {
          inputs: {
            channel: request.channel,
            configVersion: options.config.version,
            primaryVariant: decision.primaryVariant,
            shadowVariant: decision.shadowVariant,
          },
          name: 'agent.answer_quality_shadow',
          output: (comparison) => comparison,
          runType: 'chain',
        },
        () =>
          Promise.resolve(
            compareResponses(
              decision.primaryVariant,
              primary,
              primaryLatencyMs,
              decision.shadowVariant as AnswerQualityVariant,
              shadow,
            ),
          ),
      );
    },
  };
}

async function emitRolloutObservation(
  observer: AnswerQualityRolloutObserver | undefined,
  observation: AnswerQualityRolloutObservation,
): Promise<void> {
  if (observer === undefined) {
    return;
  }
  try {
    await observer(observation);
  } catch {
    // Rollout observability is a compensating control and must not replace a
    // successfully generated customer response with a monitoring failure.
  }
}

function observationFromResponse(
  response: ChatResponse,
): Pick<
  AnswerQualityRolloutObservation,
  'answerStatus' | 'citationCount' | 'intent' | 'primaryRoute' | 'totalTokens'
> {
  return {
    ...(response.answerStatus === undefined ? {} : { answerStatus: response.answerStatus }),
    citationCount: response.citations.length,
    intent: response.intent,
    ...(response.agentRoute === undefined ? {} : { primaryRoute: response.agentRoute }),
    ...(response.tokenUsage === undefined ? {} : { totalTokens: response.tokenUsage.totalTokens }),
  };
}

function observationFromShadow(input: {
  channel: ChatChannel;
  channelConfig: AnswerQualityChannelRollout;
  configVersion: '1';
  now: () => number;
  primary: ChatResponse;
  primaryLatencyMs: number;
  primaryVariant: AnswerQualityVariant;
  shadow: { error: string } | { latencyMs: number; response: ChatResponse };
  shadowVariant: AnswerQualityVariant;
}): AnswerQualityRolloutObservation {
  return {
    ...observationFromResponse(input.primary),
    channel: input.channel,
    configVersion: input.configVersion,
    mode: input.channelConfig.mode,
    observedAt: new Date(input.now()).toISOString(),
    optimizedPercentage: input.channelConfig.optimizedPercentage,
    outcome: 'success',
    primaryLatencyMs: input.primaryLatencyMs,
    primaryVariant: input.primaryVariant,
    schemaVersion: '1',
    ...('error' in input.shadow
      ? { shadowErrorName: input.shadow.error }
      : {
          answerFingerprintEqual:
            answerFingerprint(input.primary.answer) ===
            answerFingerprint(input.shadow.response.answer),
          citationCountDelta:
            input.primary.citations.length - input.shadow.response.citations.length,
          intentEqual: input.primary.intent === input.shadow.response.intent,
          ...(input.shadow.response.answerStatus === undefined
            ? {}
            : { shadowAnswerStatus: input.shadow.response.answerStatus }),
          shadowCitationCount: input.shadow.response.citations.length,
          shadowLatencyMs: input.shadow.latencyMs,
          ...(input.shadow.response.agentRoute === undefined
            ? {}
            : { shadowRoute: input.shadow.response.agentRoute }),
          shadowSourceTypes: responseSourceTypes(input.shadow.response),
          ...(input.shadow.response.tokenUsage === undefined
            ? {}
            : { shadowTotalTokens: input.shadow.response.tokenUsage.totalTokens }),
          sourceTypesEqual: arraysEqual(
            responseSourceTypes(input.primary),
            responseSourceTypes(input.shadow.response),
          ),
          ...(input.primary.tokenUsage === undefined ||
          input.shadow.response.tokenUsage === undefined
            ? {}
            : {
                totalTokenDelta:
                  input.primary.tokenUsage.totalTokens -
                  input.shadow.response.tokenUsage.totalTokens,
              }),
        }),
    primarySourceTypes: responseSourceTypes(input.primary),
    shadowVariant: input.shadowVariant,
  };
}

function rolloutDecision(
  config: AnswerQualityRolloutConfig,
  request: ChatRequest,
): { primaryVariant: AnswerQualityVariant; shadowVariant?: AnswerQualityVariant } {
  const channel = config.channels[request.channel];
  if (channel.mode === 'legacy' || channel.mode === 'optimized') {
    return { primaryVariant: channel.mode };
  }
  const primaryVariant =
    stablePercentage(request) < channel.optimizedPercentage ? 'optimized' : 'legacy';
  return {
    primaryVariant,
    shadowVariant: primaryVariant === 'optimized' ? 'legacy' : 'optimized',
  };
}

function runtimeForVariant(
  options: { legacy: CustomerAgentRuntime; optimized: CustomerAgentRuntime },
  variant: AnswerQualityVariant,
): CustomerAgentRuntime {
  return variant === 'optimized' ? options.optimized : options.legacy;
}

function compareResponses(
  primaryVariant: AnswerQualityVariant,
  primary: ChatResponse,
  primaryLatencyMs: number,
  shadowVariant: AnswerQualityVariant,
  shadow: { error: string } | { latencyMs: number; response: ChatResponse },
): Record<string, unknown> {
  if ('error' in shadow) {
    return {
      primaryLatencyMs,
      primaryVariant,
      shadowError: shadow.error,
      shadowVariant,
    };
  }
  const primarySourceTypes = responseSourceTypes(primary);
  const shadowSourceTypes = responseSourceTypes(shadow.response);
  return {
    answerEqual: answerFingerprint(primary.answer) === answerFingerprint(shadow.response.answer),
    citationCountDelta: primary.citations.length - shadow.response.citations.length,
    intentEqual: primary.intent === shadow.response.intent,
    primaryAnswerStatus: primary.answerStatus ?? 'unspecified',
    primaryLatencyMs,
    primaryRoute: primary.agentRoute ?? 'unspecified',
    primarySourceTypes,
    primaryVariant,
    shadowAnswerStatus: shadow.response.answerStatus ?? 'unspecified',
    shadowLatencyMs: shadow.latencyMs,
    shadowRoute: shadow.response.agentRoute ?? 'unspecified',
    shadowSourceTypes,
    shadowVariant,
    sourceTypesEqual: arraysEqual(primarySourceTypes, shadowSourceTypes),
    ...(primary.tokenUsage === undefined || shadow.response.tokenUsage === undefined
      ? {}
      : {
          totalTokenDelta: primary.tokenUsage.totalTokens - shadow.response.tokenUsage.totalTokens,
        }),
  };
}

function responseFromStream(
  answer: string,
  metadata: Extract<ChatStreamEvent, { type: 'metadata' }> | undefined,
): ChatResponse {
  return {
    answer,
    ...(metadata?.answerStatus === undefined ? {} : { answerStatus: metadata.answerStatus }),
    citations: metadata?.citations ?? [],
    confidence: metadata?.confidence ?? 0,
    intent: metadata?.intent ?? 'unknown',
    ...(metadata?.agentRoute === undefined ? {} : { agentRoute: metadata.agentRoute }),
    ...(metadata?.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
  };
}

function responseSourceTypes(response: ChatResponse): SourceType[] {
  return [
    ...new Set(
      response.citations.flatMap((citation) =>
        citation.sourceType === undefined ? [] : [citation.sourceType],
      ),
    ),
  ].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function answerFingerprint(answer: string): string {
  return createHash('sha256').update(answer).digest('hex').slice(0, 16);
}

function stablePercentage(request: ChatRequest): number {
  const key = request.requestId ?? request.sessionId ?? `${request.channel}:${request.message}`;
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % 100;
}

function channelConfig(
  rawMode: string | undefined,
  rawPercentage: string | undefined,
): AnswerQualityChannelRollout {
  const mode = normalizeMode(rawMode);
  return {
    mode,
    optimizedPercentage: normalizePercentage(rawPercentage, mode === 'legacy' ? 0 : 100),
  };
}

function normalizeMode(value: string | undefined): AnswerQualityMode {
  const normalized = value?.trim().toLowerCase() ?? 'optimized';
  if (normalized === 'legacy' || normalized === 'optimized' || normalized === 'shadow') {
    return normalized;
  }
  throw new AnswerQualityRolloutConfigurationError(
    'Answer quality mode must be legacy, optimized, or shadow.',
  );
}

function normalizePercentage(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new AnswerQualityRolloutConfigurationError(
      'Answer quality optimized percentage must be an integer from 0 to 100.',
    );
  }
  return parsed;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
