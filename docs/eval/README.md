# Golden QA maintenance

`golden-qa.jsonl` is the cheap deterministic regression set that runs in `pnpm check`.
Keep it stable, source-grounded, and focused on customer-support behavior.
The current set contains 55 reviewed cases, including current-vs-historical conflicts,
colloquial support questions, constraint preservation, boundary replies, and citation stability.

## Record format

Each line is one JSON object:

```json
{
  "name": "wallet-monitor-current-capacity",
  "question": "现在钱包监控最多支持多少个地址？",
  "expectedIntent": "product_qa",
  "mustContain": ["5000个地址"],
  "mustNotContain": ["2000个钱包"],
  "expectedCitationFiles": ["docs/product-features/sources/usexxyyio-x-posts.jsonl"],
  "expectedCitationTitles": ["X Post 2031333475010355227"],
  "expectedSourceUrls": ["https://x.com/useXXYYio/status/2031333475010355227"],
  "forbiddenCitationFiles": ["docs/product-features/pages/59-getting-started__xxyy-pro-quan-yi.md"],
  "referenceFacts": ["钱包监控最多支持5000个地址"],
  "relevantChunkIds": ["x_updates:sources/usexxyyio-x-posts/2031333475010355227:chunk:0001"],
  "forbiddenChunkIds": ["official_docs:pages/59-getting-started__xxyy-pro-quan-yi:chunk:0002"],
  "requireCitationSupport": true,
  "boundaryExpected": false
}
```

Supported checks:

- `expectedIntent`: required intent.
- `mustContain`: answer phrases that must appear.
- `mustNotContain`: phrases that must not appear.
- `expectedCitationFiles`: exact citation file paths expected in the response.
- `expectedCitationTitles`: exact citation titles expected in the response.
- `expectedSourceUrls`: exact source URLs expected in the response.
- `forbiddenCitationFiles`: exact citation file paths that must not appear; use this for stale or conflicting sources.
- `forbiddenSourceUrls`: exact source URLs that must not appear.
- `requireCitationSupport`: when true, each `mustContain` phrase that appears in the answer must also appear in citation excerpts, ignoring whitespace.
- `boundaryExpected`: marks boundary cases that should not require citations.
- `referenceFacts`: short source-verified facts used by the optional judge and human review.
- `relevantChunkIds`: exact chunk IDs that should be recalled. Only cases with this field contribute retrieval metrics.
- `forbiddenChunkIds`: stale, conflicting, or unsafe chunks that must not enter the evaluated ranking.
- `expectedAgentRoute` and `expectedToolNames`: optional exact route and ordered tool trajectory checks for provider-backed cases with trace observations.
  普通产品问题的标准轨迹是 `['search_product_docs']`；复杂比较问题可以出现多个该工具调用，但 rewritten query 必须不同且每次带来新证据。`agent.observe` 和 `agent.answer_composer` 是 chain spans，不计入 toolNames。

Chunk IDs must come from `prepareKnowledgeChunks`, not from hand-written guesses. Keep annotations small: list the chunks required to answer the question, not every vaguely related chunk.

## Current and historical facts

- For questions about the current product, use the latest explicit official update as the expected fact.
- A newer update only supersedes the scope it names, such as a specific chain, plan, or user tier.
- Put older conflicting chunks in `forbiddenChunkIds` for current-product cases.
- Historical questions may cite older chunks, but the expected answer must make the historical timeframe clear.
- If official sources do not uniquely identify the applicable scope, keep the case in review instead of inventing a golden answer.

## Layered metrics

- Recall@K: retrieved relevant chunks divided by all annotated relevant chunks.
- Precision@K: relevant chunks divided by returned chunks within K.
- MRR: reciprocal rank of the first relevant chunk.
- nDCG@K: binary relevance with `1 / log2(rank + 1)` discount.
- forbidden hits: count of annotated stale/conflicting chunks returned within K.

Unannotated cases are excluded from retrieval averages. The deterministic answer checks remain the merge gate; retrieval metrics explain why an answer may be weak, and an LLM judge supplies an additional review signal only when explicitly requested.

## When to add cases

Add or update a golden case when:

- fixing an answer-quality bug;
- changing retrieval, reranking, chunking, prompts, or source metadata;
- adding product docs for important limits, eligibility, supported chains, or current-vs-historical rules;
- tightening a safety boundary for account data, transaction forensics, private credentials, or investment advice.

Prefer realistic user wording. Keep assertions short and factual; avoid checking prose style unless the style is the behavior under test.

Trustworthiness changes need two layers of regression evidence:

- Golden QA records verify real source selection, current/historical conflict handling, required facts, forbidden stale facts, and stable citation files/URLs.
- Unit tests verify adversarial properties that should not be inserted into production knowledge, including prompt injection quarantine, sentence-aware context budgets, unsupported numeric/step claim fallback, and streamed-token non-leakage.

`requireCitationSupport` is a deterministic literal check for the selected required phrases. The runtime answer provider additionally performs claim-level local grounding for the complete model answer; provider-backed evaluation exercises that runtime path.

## Verification

Run:

```bash
pnpm rag:evaluate
pnpm check
```

Use `pnpm rag:evaluate -- --provider` only for human review before releases or model/retriever changes; it may call configured external providers.

During diagnosis, run one or more exact reviewed cases without paying for the entire suite:

```bash
pnpm rag:evaluate -- --provider \
  --case order-management-types \
  --case broad-current-capability-overview
```

`--case` matches the Golden QA `name` exactly, rejects unknown names, and is recorded in `--report-out` reports. It cannot be combined with `--baseline`, because a partial sample is not comparable to a full-suite baseline. Passing a selected sample is diagnostic evidence only and does not replace the full release gate.

To measure the production pgvector + embedding retrieval path without involving the Agent planner or answer model, run:

```bash
pnpm rag:evaluate -- --provider --retrieval-only
```

This evaluates only cases with `relevantChunkIds`, applies the same candidate multiplier and metadata reranker as the product tools, and reports Recall@K, Precision@K, MRR, nDCG@K, and forbidden hits. Use it for before/after retrieval baselines when chat-provider failures would otherwise contaminate retrieval metrics. Retrieval failures can be exported under `.rag/` with `--failures-out`.
To add the optional judge, configure a separate model and use:

```bash
EVAL_JUDGE_MODEL=your-judge-model pnpm rag:evaluate -- --provider --judge
```

`--judge` requires `--provider`. Scores cover correctness, groundedness, completeness, relevance, and safe refusal. They do not change deterministic pass/fail and must not be promoted without source review.
Provider-backed reports include per-case expected intent, actual intent, and citation counts so reviewers can quickly inspect weak answers:

```text
Evaluation (provider-backed): 35/36 passed
[PASS] pro-benefits (expected product_qa, actual product_qa, citations 3/0)
[FAIL] bad-answer (expected product_qa, actual unknown, citations 0/1)
  - intent unknown != product_qa
```

## Feedback Backlog

Use feedback backlog export to turn stored negative feedback and no-citation feedback into review-only eval drafts:

```bash
pnpm rag:feedback:backlog
```

The command reads `rag_feedback` and prints JSONL records with `_review` metadata. Treat these as a triage queue: a reviewer must fill in precise `mustContain`, `mustNotContain`, expected citations, source URLs, or another executable assertion. Do not copy the observed answer into assertions without checking it against an official source.

Save and review the queue under `.rag/`. After source verification and privacy review, add an explicit approval to every accepted record:

```json
{
  "_review": {
    "source": "rag_feedback",
    "approved": true,
    "reviewer": "admin:alice",
    "reviewedAt": "2026-07-30T12:00:00.000Z"
  }
}
```

Then use the controlled promotion command:

```bash
pnpm rag:feedback:promote -- .rag/reviewed-feedback.jsonl --reviewer admin:alice
```

The command requires the CLI reviewer to match every record, rejects unapproved or assertion-free drafts, strips `_review` and `observedAnswer`, deduplicates by case name and normalized question, and atomically writes only the allowlisted Golden QA fields to `docs/eval/golden-qa.jsonl`. A name collision with different assertions fails closed. Promotion does not publish knowledge or write pgvector.

Web 的 👍/👎 通过 `/api/feedback` 写入该表。Web 和 Telegram 的无引用产品回答会以 `automatic_low_evidence` 评论自动写入；这些记录仍然只生成待审核草稿，不会自动进入 golden QA 或知识库。

Failed evals can be exported through an explicit repository-local path:

```bash
pnpm rag:evaluate -- --provider --failures-out .rag/provider-failures.jsonl
```

The file contains only failing cases and bounded observations, is redacted, and is never written by the default command. Review checklist:

1. Reproduce the failure and verify the intended answer against official docs or official X updates.
2. Decide whether the defect is classification, retrieval, freshness/conflict handling, grounding, answer generation, or a safety boundary.
3. Replace user identifiers and private details with synthetic wording.
4. Add exact facts, relevant/forbidden chunk IDs, answer phrases, and citations.
5. Run `pnpm rag:evaluate` and `pnpm check`; only then promote the case to golden QA.

Postgres + pgvector remains the default retrieval backend. Elasticsearch should be considered only after measured lexical/hybrid recall failures cannot be corrected with the existing hybrid query/reranker. Neo4j should be considered only when the product requires multi-hop relationship queries with a maintained graph schema. Neither is justified merely to add observability or improve answer prose.

## Shadow and gray rollout gate

Offline Golden QA passing is necessary but does not authorize production traffic expansion. Before a
Shadow or gray observation window, an owner must approve the exact channels, mode, percentage,
window, quality thresholds, P95 latency budget, and provider cost/token budgets. The approval
timestamp must precede the observation window.

Enable bounded runtime observations for Web API and Telegram:

```bash
ANSWER_QUALITY_OBSERVABILITY_ENABLED=true
```

Collect only JSON lines whose `event` is `answer_quality_rollout`. These observations contain no
question, answer, concrete answer fingerprint, user, session, or request identifiers. They do include
bounded comparisons for answer-fingerprint equality, source types, citation counts, routes, statuses,
latency, and tokens. Copy `docs/eval/answer-quality-rollout-gate.template.json` to an ignored `.rag/`
control path, replace every policy and window value with the approved values, and keep its
`observations` array empty.

The remaining evidence must be supplied independently:

- `review` records a source-verified human sample from the same observations. Any customer-boundary
  regression fails the gate.
- `billing` comes from the provider billing or usage export for exactly the same window and channels.
  `requestCount` means customer requests and must exactly equal the observation count. Runtime
  `totalTokens` can be partial and is not authoritative billing evidence.
- Every approved channel must meet its own minimum sample size, error rate, completion rate, Shadow
  error rate, and P95 budget. The report also shows answer and source-type difference rates. Evidence
  from an unapproved channel or a successful Shadow event without its bounded comparison fails the
  gate.

Build the evidence artifact from the approved control and an extracted JSONL file:

```bash
pnpm rag:rollout:evidence -- \
  .rag/answer-quality-rollout-control.json \
  .rag/answer-quality-rollout-observations.jsonl \
  --out .rag/answer-quality-rollout-evidence.json
```

The preparation command accepts only files under `.rag/`, strips the log-only `event` field, sorts
events by timestamp, and rejects malformed lines, unknown/privacy-sensitive fields, duplicates,
pre-populated observations, empty input, or input above 50 MiB. It does not make a rollout decision.
Then run the fail-closed gate and persist its redacted report:

```bash
pnpm rag:rollout:gate -- .rag/answer-quality-rollout-evidence.json \
  --report-out .rag/answer-quality-rollout-report.json
```

Exit code `0` means the supplied observation window satisfies the approved policy. Exit code `1`
means traffic must not be expanded. The checked-in template intentionally fails until real approval,
observations, review, and billing evidence are supplied. Keep evidence and reports under `.rag/`;
do not commit them.
