import { createGroundedAnswer } from './answer.js';
import { createChatService } from './chat-service.js';
import { evaluateCases, type EvaluationCase, type EvaluationReport } from './evaluate.js';
import {
  createWikiEvidenceIndex,
  findWikiNavigation,
  validateWikiBundle,
  type WikiBundle,
  type WikiSnapshot,
} from './knowledge-wiki.js';
import { createWikiGuidedRetriever } from './knowledge-wiki-retriever.js';
import { createLocalRetriever, createMetadataReranker, type Retriever } from './retriever.js';
import { aggregateRetrievalResults, evaluateRetrievalRanking } from './retrieval-evaluate.js';

export interface WikiComparison {
  mode: 'offline-deterministic';
  corpusRevision: string;
  publicationAllowed: boolean;
  baseline: EvaluationReport;
  wikiOnly: EvaluationReport;
  hybrid: EvaluationReport;
}

export async function evaluateWiki(options: {
  snapshot: WikiSnapshot;
  bundle: WikiBundle;
  cases: EvaluationCase[];
  topK?: number;
}): Promise<WikiComparison> {
  const bundle = validateWikiBundle(options.bundle, options.snapshot);
  if (options.cases.length === 0) throw new Error('wiki_empty_evaluation');
  const topK = options.topK ?? 6;
  const index = createWikiEvidenceIndex(options.snapshot.chunks);
  const baseline = createLocalRetriever(index, options.snapshot.revision);
  const hybrid = createWikiGuidedRetriever(baseline, { loadBundle: () => Promise.resolve(bundle) });
  const wikiOnly: Retriever = {
    async retrieve(question, retrieveOptions) {
      const navigation = findWikiNavigation(question, bundle);
      if (navigation === undefined) return [];
      // Keep the full original corpus when applying supersession/scope policy.
      // The ablation limits selection to wiki-linked evidence, not generated prose.
      const allowed = new Set(navigation.chunkIds);
      const chunks = await baseline.retrieve(question, {
        ...retrieveOptions,
        topK: index.entries.length,
        wiki: navigation,
      });
      return chunks.filter((chunk) => allowed.has(chunk.id)).slice(0, retrieveOptions.topK ?? topK);
    },
  };
  async function evaluate(retriever: Retriever): Promise<EvaluationReport> {
    let lastIds: string[] = [];
    let searchCount = 0;
    const service = createChatService({
      config: { topK },
      retriever: {
        retrieve(question, retrieveOptions) {
          searchCount += 1;
          return retriever.retrieve(question, retrieveOptions);
        },
      },
      reranker: createMetadataReranker(),
      answerProvider: {
        answer(input) {
          lastIds = input.retrievedChunks.map((chunk) => chunk.id);
          return Promise.resolve(
            createGroundedAnswer(input.question, input.classification, input.retrievedChunks),
          );
        },
      },
    });
    const report = await evaluateCases(
      options.cases,
      {
        async ask(request) {
          lastIds = [];
          searchCount = 0;
          return service.ask(request);
        },
        stream: service.stream,
      },
      { observe: () => ({ retrievedChunkIds: lastIds, searchCount }) },
    );
    for (const result of report.results) {
      result.retrievalEvaluation = evaluateRetrievalRanking({
        relevantChunkIds: result.relevantChunkIds,
        forbiddenChunkIds: result.forbiddenChunkIds,
        retrievedChunkIds: result.retrievedChunkIds,
        topK,
      });
      if (result.retrievedChunkIds.some((id) => result.forbiddenChunkIds.includes(id))) {
        result.passed = false;
        result.failureReasons.push('forbidden original evidence retrieved');
      }
    }
    report.passed = report.results.filter((result) => result.passed).length;
    report.retrievalSummary = aggregateRetrievalResults(
      report.results.flatMap((result) =>
        result.retrievalEvaluation === undefined ? [] : [result.retrievalEvaluation],
      ),
    );
    return report;
  }
  const baselineReport = await evaluate(baseline);
  const wikiReport = await evaluate(wikiOnly);
  const hybridReport = await evaluate(hybrid);
  return {
    mode: 'offline-deterministic',
    corpusRevision: options.snapshot.revision,
    publicationAllowed:
      baselineReport.passed === baselineReport.total &&
      hybridReport.passed === hybridReport.total &&
      hybridReport.results.every(
        (result, index) =>
          (result.retrievalEvaluation?.recallAtK ?? 0) >=
          (baselineReport.results[index]?.retrievalEvaluation?.recallAtK ?? 0),
      ),
    baseline: baselineReport,
    wikiOnly: wikiReport,
    hybrid: hybridReport,
  };
}
