import type { AgentRoute, ChatRequest, ChatResponse, Intent, SourceType } from '@xxyy/shared';

import type { ChatService } from './chat-service.js';
import type { AnswerQualityScores } from './answer-quality-judge.js';
import { classifyQuestion } from './classify.js';
import {
  createProductQueryPlan,
  createStandaloneProductQuestion,
  understandProductQuestion,
  type ProductQuestionKind,
} from './product-question.js';
import type {
  RetrievalEvaluationResult,
  RetrievalEvaluationSummary,
} from './retrieval-evaluate.js';

interface AnswerQualityEvaluationSummary {
  averageCompleteness: number;
  averageCorrectness: number;
  averageGroundedness: number;
  averageRelevance: number;
  averageSafeRefusal: number;
  judgedCaseCount: number;
}

export interface EvaluationCase {
  name: string;
  request: ChatRequest;
  expectedIntent: Intent;
  expectedAgentRoute?: AgentRoute;
  expectedAnswerStatus?: ChatResponse['answerStatus'];
  expectedClarification?: boolean;
  expectedFineGrainedIntent?: ProductQuestionKind;
  expectedPartialAnswer?: boolean;
  expectedSearchCountRange?: [number, number];
  expectedStandaloneQuestionTerms?: string[];
  expectedSubquestionCount?: number;
  expectedSubquestionTerms?: string[];
  expectedSubject?: 'customer_agent' | 'unknown' | 'xxyy_product';
  expectedToolNames?: string[];
  forbiddenChunkIds?: string[];
  minCitations?: number;
  minimumFacetCoverage?: number;
  maximumXSourceCount?: number;
  referenceFacts?: string[];
  relevantChunkIds?: string[];
  requiredAnswerIncludes?: string[];
  requiredFacets?: string[];
  forbiddenAnswerIncludes?: string[];
  requiredCitationFiles?: string[];
  requiredCitationTitles?: string[];
  requiredSourceUrls?: string[];
  requiredSourceTypes?: SourceType[];
  forbiddenCitationFiles?: string[];
  forbiddenSourceUrls?: string[];
  requireCitationSupport?: boolean;
}

export interface EvaluationResult {
  actualAgentRoute?: AgentRoute;
  name: string;
  passed: boolean;
  expectedAgentRoute?: AgentRoute;
  expectedIntent: Intent;
  expectedToolNames: string[];
  forbiddenChunkIds: string[];
  actualIntent: Intent;
  minCitations: number;
  question: string;
  citationCount: number;
  failureReasons: string[];
  judgeScores?: AnswerQualityScores;
  latencyMs?: number;
  referenceFacts: string[];
  relevantChunkIds: string[];
  response: ChatResponse;
  retrievedChunkIds: string[];
  retrievalEvaluation?: RetrievalEvaluationResult;
  toolNames: string[];
}

export interface EvaluationReport {
  judgeSummary?: AnswerQualityEvaluationSummary;
  runtimeSummary?: {
    averageTotalTokens?: number;
    modelResponseCount: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    totalTokens: number;
  };
  total: number;
  passed: number;
  retrievalSummary?: RetrievalEvaluationSummary;
  results: EvaluationResult[];
}

export interface EvaluateCasesOptions {
  observe?(
    testCase: EvaluationCase,
    response: ChatResponse,
  ): EvaluationObservation | Promise<EvaluationObservation>;
  onResult?(result: EvaluationResult, index: number, total: number): void;
}

interface EvaluationObservation {
  retrievedChunkIds?: string[];
  searchCount?: number;
  toolNames?: string[];
}

export async function evaluateCases(
  cases: EvaluationCase[],
  service: ChatService,
  options: EvaluateCasesOptions = {},
): Promise<EvaluationReport> {
  const results: EvaluationResult[] = [];

  for (const testCase of cases) {
    const startedAt = performance.now();
    const response = await service.ask(testCase.request);
    const latencyMs = Number((performance.now() - startedAt).toFixed(3));
    const observation = (await options.observe?.(testCase, response)) ?? {};
    const retrievedChunkIds = [...(observation.retrievedChunkIds ?? [])];
    const toolNames = [...(observation.toolNames ?? [])];
    const minCitations = testCase.minCitations ?? 0;
    const citationCount = response.citations.length;
    const standaloneQuestion = createStandaloneProductQuestion(
      testCase.request.message,
      testCase.request.history,
    );
    const understanding = understandProductQuestion(
      standaloneQuestion,
      classifyQuestion(standaloneQuestion),
    );
    const queryPlan = createProductQueryPlan(
      testCase.request.message,
      standaloneQuestion,
      understanding,
    );
    const failureReasons = collectFailureReasons({
      actualAnswerStatus: response.answerStatus,
      actualIntent: response.intent,
      actualFineGrainedIntent: understanding.kind,
      actualSubject: understanding.subject,
      answer: response.answer,
      citationCount,
      citationExcerpts: response.citations.map((citation) => citation.excerpt),
      citationFiles: response.citations.map((citation) => citation.file),
      citationTitles: response.citations.map((citation) => citation.title),
      actualAgentRoute: response.agentRoute,
      minCitations,
      searchCount: observation.searchCount,
      sourceUrls: response.citations.flatMap((citation) =>
        citation.sourceUrl === undefined ? [] : [citation.sourceUrl],
      ),
      sourceTypes: response.citations.flatMap((citation) =>
        citation.sourceType === undefined ? [] : [citation.sourceType],
      ),
      standaloneQuestion,
      subquestions: queryPlan.subquestions.map((subquestion) => subquestion.question),
      testCase,
      toolNames,
    });

    const result: EvaluationResult = {
      ...(response.agentRoute === undefined ? {} : { actualAgentRoute: response.agentRoute }),
      name: testCase.name,
      passed: failureReasons.length === 0,
      ...(testCase.expectedAgentRoute === undefined
        ? {}
        : { expectedAgentRoute: testCase.expectedAgentRoute }),
      expectedIntent: testCase.expectedIntent,
      expectedToolNames: [...(testCase.expectedToolNames ?? [])],
      forbiddenChunkIds: [...(testCase.forbiddenChunkIds ?? [])],
      actualIntent: response.intent,
      latencyMs,
      minCitations,
      question: testCase.request.message,
      citationCount,
      failureReasons,
      referenceFacts: [...(testCase.referenceFacts ?? [])],
      relevantChunkIds: [...(testCase.relevantChunkIds ?? [])],
      response,
      retrievedChunkIds,
      toolNames,
    };
    results.push(result);
    options.onResult?.(result, results.length, cases.length);
  }

  return {
    total: cases.length,
    passed: results.filter((result) => result.passed).length,
    results,
    runtimeSummary: summarizeEvaluationRuntime(results),
  };
}

function summarizeEvaluationRuntime(
  results: readonly EvaluationResult[],
): NonNullable<EvaluationReport['runtimeSummary']> {
  const latencies = results
    .flatMap((result) => (result.latencyMs === undefined ? [] : [result.latencyMs]))
    .sort((left, right) => left - right);
  const tokenUsages = results.flatMap((result) =>
    result.response.tokenUsage === undefined ? [] : [result.response.tokenUsage.totalTokens],
  );
  const totalTokens = tokenUsages.reduce((sum, value) => sum + value, 0);
  return {
    ...(tokenUsages.length === 0
      ? {}
      : { averageTotalTokens: Number((totalTokens / tokenUsages.length).toFixed(3)) }),
    modelResponseCount: tokenUsages.length,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    totalTokens,
  };
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );
  return sortedValues[index] ?? 0;
}

function collectFailureReasons(input: {
  actualAgentRoute: AgentRoute | undefined;
  actualAnswerStatus: ChatResponse['answerStatus'];
  actualFineGrainedIntent: ProductQuestionKind;
  actualIntent: Intent;
  actualSubject: 'customer_agent' | 'unknown' | 'xxyy_product';
  answer: string;
  citationCount: number;
  citationExcerpts: string[];
  citationFiles: string[];
  citationTitles: string[];
  minCitations: number;
  searchCount: number | undefined;
  sourceUrls: string[];
  sourceTypes: SourceType[];
  standaloneQuestion: string;
  subquestions: string[];
  testCase: EvaluationCase;
  toolNames: string[];
}): string[] {
  const failures: string[] = [];

  if (input.actualIntent !== input.testCase.expectedIntent) {
    failures.push(`intent ${input.actualIntent} != ${input.testCase.expectedIntent}`);
  }

  if (
    input.testCase.expectedFineGrainedIntent !== undefined &&
    input.actualFineGrainedIntent !== input.testCase.expectedFineGrainedIntent
  ) {
    failures.push(
      `fine intent ${input.actualFineGrainedIntent} != ${input.testCase.expectedFineGrainedIntent}`,
    );
  }

  if (
    input.testCase.expectedSubject !== undefined &&
    input.actualSubject !== input.testCase.expectedSubject
  ) {
    failures.push(`subject ${input.actualSubject} != ${input.testCase.expectedSubject}`);
  }

  if (
    input.testCase.expectedAnswerStatus !== undefined &&
    input.actualAnswerStatus !== input.testCase.expectedAnswerStatus
  ) {
    failures.push(
      `answer status ${input.actualAnswerStatus ?? 'undefined'} != ${input.testCase.expectedAnswerStatus}`,
    );
  }

  if (
    input.testCase.expectedClarification !== undefined &&
    (input.actualAgentRoute === 'clarify') !== input.testCase.expectedClarification
  ) {
    failures.push(
      `clarification ${String(input.actualAgentRoute === 'clarify')} != ${String(input.testCase.expectedClarification)}`,
    );
  }

  if (
    input.testCase.expectedPartialAnswer !== undefined &&
    (input.actualAnswerStatus === 'partial') !== input.testCase.expectedPartialAnswer
  ) {
    failures.push(
      `partial answer ${String(input.actualAnswerStatus === 'partial')} != ${String(input.testCase.expectedPartialAnswer)}`,
    );
  }

  for (const term of input.testCase.expectedStandaloneQuestionTerms ?? []) {
    if (!normalizedTextIncludes(input.standaloneQuestion, term)) {
      failures.push(`standalone question missing term: ${term}`);
    }
  }

  if (
    input.testCase.expectedSubquestionCount !== undefined &&
    input.subquestions.length !== input.testCase.expectedSubquestionCount
  ) {
    failures.push(
      `subquestion count ${input.subquestions.length} != ${input.testCase.expectedSubquestionCount}`,
    );
  }
  for (const term of input.testCase.expectedSubquestionTerms ?? []) {
    if (!input.subquestions.some((subquestion) => normalizedTextIncludes(subquestion, term))) {
      failures.push(`subquestions missing term: ${term}`);
    }
  }

  if (
    input.testCase.expectedAgentRoute !== undefined &&
    input.actualAgentRoute !== input.testCase.expectedAgentRoute
  ) {
    failures.push(
      `agent route ${input.actualAgentRoute ?? 'undefined'} != ${input.testCase.expectedAgentRoute}`,
    );
  }

  if (
    input.testCase.expectedToolNames !== undefined &&
    !sameOrderedValues(input.toolNames, input.testCase.expectedToolNames)
  ) {
    failures.push(
      `tool trajectory ${formatTrajectory(input.toolNames)} != ${formatTrajectory(input.testCase.expectedToolNames)}`,
    );
  }

  if (input.citationCount < input.minCitations) {
    failures.push(`citations ${input.citationCount}/${input.minCitations}`);
  }

  for (const sourceType of input.testCase.requiredSourceTypes ?? []) {
    if (!input.sourceTypes.includes(sourceType)) {
      failures.push(`missing source type: ${sourceType}`);
    }
  }

  const xSourceCount = input.sourceTypes.filter((sourceType) => sourceType === 'x_updates').length;
  if (
    input.testCase.maximumXSourceCount !== undefined &&
    xSourceCount > input.testCase.maximumXSourceCount
  ) {
    failures.push(`X source count ${xSourceCount}/${input.testCase.maximumXSourceCount}`);
  }

  if (input.testCase.expectedSearchCountRange !== undefined) {
    const [minimum, maximum] = input.testCase.expectedSearchCountRange;
    if (
      input.searchCount === undefined ||
      input.searchCount < minimum ||
      input.searchCount > maximum
    ) {
      failures.push(
        `search count ${input.searchCount ?? 'unobserved'} outside ${minimum}-${maximum}`,
      );
    }
  }

  const requiredFacets = input.testCase.requiredFacets ?? [];
  if (requiredFacets.length > 0) {
    const evidenceText = [input.answer, ...input.citationExcerpts].join('\n');
    const coveredFacetCount = requiredFacets.filter((facet) =>
      normalizedTextIncludes(evidenceText, facet),
    ).length;
    const coverage = coveredFacetCount / requiredFacets.length;
    const minimumCoverage = input.testCase.minimumFacetCoverage ?? 1;
    if (coverage < minimumCoverage) {
      failures.push(
        `facet coverage ${coverage.toFixed(3)} < ${minimumCoverage.toFixed(3)} (${coveredFacetCount}/${requiredFacets.length})`,
      );
    }
  }

  for (const requiredText of input.testCase.requiredAnswerIncludes ?? []) {
    if (!normalizedTextIncludes(input.answer, requiredText)) {
      failures.push(`answer missing required text: ${requiredText}`);
    }
  }

  for (const forbiddenText of input.testCase.forbiddenAnswerIncludes ?? []) {
    if (normalizedTextIncludes(input.answer, forbiddenText)) {
      failures.push(`answer contains forbidden text: ${forbiddenText}`);
    }
  }

  for (const requiredFile of input.testCase.requiredCitationFiles ?? []) {
    if (!input.citationFiles.includes(requiredFile)) {
      failures.push(`missing citation file: ${requiredFile}`);
    }
  }

  for (const requiredTitle of input.testCase.requiredCitationTitles ?? []) {
    if (!input.citationTitles.includes(requiredTitle)) {
      failures.push(`missing citation title: ${requiredTitle}`);
    }
  }

  for (const requiredSourceUrl of input.testCase.requiredSourceUrls ?? []) {
    if (!input.sourceUrls.includes(requiredSourceUrl)) {
      failures.push(`missing source URL: ${requiredSourceUrl}`);
    }
  }

  for (const forbiddenFile of input.testCase.forbiddenCitationFiles ?? []) {
    if (input.citationFiles.includes(forbiddenFile)) {
      failures.push(`forbidden citation file: ${forbiddenFile}`);
    }
  }

  for (const forbiddenSourceUrl of input.testCase.forbiddenSourceUrls ?? []) {
    if (input.sourceUrls.includes(forbiddenSourceUrl)) {
      failures.push(`forbidden source URL: ${forbiddenSourceUrl}`);
    }
  }

  if (input.testCase.requireCitationSupport === true) {
    const normalizedCitationText = normalizeGroundingText(input.citationExcerpts.join('\n'));
    for (const requiredText of input.testCase.requiredAnswerIncludes ?? []) {
      if (
        normalizedTextIncludes(input.answer, requiredText) &&
        !normalizedCitationText.includes(normalizeGroundingText(requiredText))
      ) {
        failures.push(`answer text is not supported by citations: ${requiredText}`);
      }
    }
  }

  return failures;
}

function sameOrderedValues(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function formatTrajectory(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(',');
}

function normalizeGroundingText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[−–—]/gu, '-')
    .replace(/[\s*_`#「」『』“”"'，,。！!？?：:；;（）()【】[\]{}<>/\\]+/gu, '');
}

function normalizedTextIncludes(text: string, expected: string): boolean {
  return normalizeGroundingText(text).includes(normalizeGroundingText(expected));
}
