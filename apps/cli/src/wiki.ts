import {
  compileWiki,
  createPgPool,
  createWikiCompilerModel,
  evaluateWiki,
  loadRagConfig,
  loadWikiBuild,
  planWikiTopics,
  publishWikiBuild,
  readWikiRevision,
  readWikiSnapshot,
  saveWikiBuild,
  validateWikiBundle,
  writeWikiReport,
  type EvaluationCase,
  type RagEnv,
} from '@xxyy/rag-core';

export type WikiCommand =
  | { command: 'wiki:build'; dryRun: boolean }
  | { command: 'wiki:evaluate'; buildId: string }
  | { command: 'wiki:publish'; buildId: string };

export function parseWikiArgs(
  command: string,
  args: readonly string[],
): WikiCommand | { command: 'help'; error: string } {
  const rest = args.filter((arg) => arg !== '--');
  if (
    command === 'wiki:build' &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === '--dry-run'))
  )
    return { command, dryRun: rest.length === 1 };
  if (
    (command === 'wiki:evaluate' || command === 'wiki:publish') &&
    rest.length === 1 &&
    /^[a-f0-9-]{36}$/u.test(rest[0] ?? '')
  )
    return { command, buildId: rest[0]! };
  return {
    command: 'help',
    error: 'Use wiki:build [--dry-run], wiki:evaluate <build-id>, or wiki:publish <build-id>.',
  };
}

export async function runWikiCommand(
  command: WikiCommand,
  options: {
    cwd: string;
    env: RagEnv;
    loadCases: () => Promise<EvaluationCase[]>;
    log: (value: string) => void;
  },
): Promise<number> {
  const config = loadRagConfig(options.env);
  const pool = createPgPool(config.databaseUrl);
  try {
    const snapshot = await readWikiSnapshot(pool);
    if (command.command === 'wiki:build') {
      const plans = await planWikiTopics(snapshot);
      options.log(
        JSON.stringify({
          corpusRevision: snapshot.revision,
          topics: plans.map(({ topic, sources }) => ({
            id: topic.id,
            sourceCount: sources.length,
          })),
          dryRun: command.dryRun,
        }),
      );
      if (command.dryRun) return 0;
      const model = createWikiCompilerModel({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: config.openAiModel,
        requestTimeoutMs: config.openAiRequestTimeoutMs,
      });
      const bundle = await compileWiki(snapshot, model);
      if ((await readWikiRevision(pool)) !== snapshot.revision)
        throw new Error('wiki_source_revision_changed');
      const build = await saveWikiBuild(options.cwd, bundle);
      options.log(
        JSON.stringify({
          buildId: build.id,
          directory: build.directory,
          pageCount: bundle.pages.length,
          status: 'draft',
        }),
      );
      return 0;
    }
    const bundle = validateWikiBundle(await loadWikiBuild(options.cwd, command.buildId), snapshot);
    const comparison = await evaluateWiki({
      snapshot,
      bundle,
      cases: await options.loadCases(),
      topK: config.topK,
    });
    await writeWikiReport(options.cwd, command.buildId, comparison);
    options.log(
      JSON.stringify({
        mode: comparison.mode,
        publicationAllowed: comparison.publicationAllowed,
        variants: [comparison.baseline, comparison.wikiOnly, comparison.hybrid].map(
          (report, index) => ({
            name: ['baseline', 'wiki-only', 'hybrid'][index],
            passed: report.passed,
            total: report.total,
            retrieval: report.retrievalSummary,
            failedCases: report.results
              .filter((result) => !result.passed)
              .map((result) => result.name),
          }),
        ),
      }),
    );
    if (!comparison.publicationAllowed) return 1;
    if (command.command === 'wiki:publish') {
      const file = await publishWikiBuild({
        cwd: options.cwd,
        bundle,
        goldenCaseCount: comparison.hybrid.total,
        verify: async () => {
          if ((await readWikiRevision(pool)) !== snapshot.revision)
            throw new Error('wiki_source_revision_changed');
        },
      });
      options.log(
        JSON.stringify({
          publishedFile: file,
          enabled: false,
          nextStep: 'Use RAG_WIKI_PATH for an explicitly enabled evaluation or rollout.',
        }),
      );
    }
    return 0;
  } finally {
    await pool.end();
  }
}
