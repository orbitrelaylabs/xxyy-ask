import { stat } from 'node:fs/promises';

import { findWikiNavigation, type WikiBundle } from './knowledge-wiki.js';
import { readPublishedWiki } from './knowledge-wiki-storage.js';
import { isHistoricalOrTweetQuestion } from './retrieve.js';
import type { Retriever } from './retriever.js';
import { noopQualityTracer, type QualityTracer } from './quality-trace.js';

export function createWikiGuidedRetriever(
  retriever: Retriever,
  options: {
    loadBundle: () => Promise<WikiBundle>;
    tracer?: QualityTracer;
  },
): Retriever {
  return {
    async retrieve(question, retrieveOptions) {
      // Historical/direct-source questions continue to use the original route.
      if (isHistoricalOrTweetQuestion(question))
        return retriever.retrieve(question, retrieveOptions);
      const result = await (options.tracer ?? noopQualityTracer).run(
        {
          name: 'rag.wiki_navigation',
          runType: 'retriever',
          inputs: {},
          output: (result) => ({
            status: result.status,
            candidateCount: result.navigation?.chunkIds.length ?? 0,
          }),
        },
        async () => {
          try {
            const navigation = findWikiNavigation(question, await options.loadBundle());
            return { navigation, status: navigation === undefined ? 'no_match' : 'matched' };
          } catch {
            return { navigation: undefined, status: 'unavailable' };
          } // A missing/broken wiki never takes down original retrieval.
        },
      );
      return retriever.retrieve(question, {
        ...retrieveOptions,
        ...(result.navigation === undefined ? {} : { wiki: result.navigation }),
      });
    },
  };
}

export function createConfiguredWikiRetriever(
  retriever: Retriever,
  file: string | undefined,
  tracer?: QualityTracer,
): Retriever {
  if (!file) return retriever;
  let cached: { signature: string; bundle: WikiBundle } | undefined;
  return createWikiGuidedRetriever(retriever, {
    loadBundle: async () => {
      const info = await stat(file);
      const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (cached?.signature === signature) return cached.bundle;
      const bundle = (await readPublishedWiki(file)).bundle;
      cached = { signature, bundle };
      return bundle;
    },
    ...(tracer === undefined ? {} : { tracer }),
  });
}
