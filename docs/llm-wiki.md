# 产品 LLM Wiki 试点

LLM Wiki 为现有 Agentic RAG 增加离线主题整理与导航。它不替代 LangGraph、pgvector、原始知识或交易 Skills，也不创建第四种官方来源。默认关闭在线 Wiki 检索。

首版覆盖 Pro 权益、交易模式、钱包监控、公链支持和发射平台五个固定主题。编译器从数据库中已发布的正式知识选取证据，用现有 OpenAI-compatible Chat 配置生成带逐条原文引文的主题页。每个主题最多 24 个候选 chunk、48,000 字符输入，一次完整编译最多五次模型调用；不调用 embedding，不迁移或修改数据库。

## 产物与来源

编译输出保存在忽略目录 `.rag/wiki/builds/<build-id>/`：

- `index.md` 和主题 Markdown：供运营阅读的派生页面，包含原文引文、来源链接、生效时间和主题链接。
- `bundle.json`：不可变编译结果，包括引用的完整原始 chunk 快照、来源元数据、知识版本、编译器版本和模型名。

LLM 只能引用编译输入中存在的 chunk，引文必须逐字匹配，并通过现有事实 grounding 校验。未知引用、无依据数字、提示注入、无效主题链接和未经允许的来源会让编译失败。确定性校验不能证明任意自然语言改写完全正确，因此 Wiki 内容始终只是派生导航，不能作为回答的最终证据。

使用 OpenRouter 的 `:free` 模型或 `openrouter/free` 编译时，会要求上游支持严格 JSON Schema，并关闭推理输出，将输出预算用于主题页正文；结论优先逐字摘录完整原文句子。原始引用与 grounding 门禁仍全部执行，不会为免费模型放宽。免费模型有每日请求量和提供方限流，适合离线试点，不能据此承诺生产可用性。

原始群聊、待审候选和被撤回的知识不进入编译输入；群聊知识必须先经过现有管理员审批和发布流程。只编译有效的 `current` 来源，排除已被明确替代的 chunk。原始事实、例外条件和引用仍由正式检索与回答检查处理。

## 使用

先完成现有的正式知识入库。下列命令读取项目 `.env`，shell 同名变量优先。

```bash
# 只读预检，不调用模型、不写文件
pnpm rag:wiki:build -- --dry-run

# 编译草稿；输出 buildId 和本地目录
pnpm rag:wiki:build

# 用同一数据库快照跑三组完整 deterministic Golden QA
pnpm rag:wiki:evaluate -- <build-id>

# 重新验证来源和完整评估，成功后原子发布本地导航包
pnpm rag:wiki:publish -- <build-id>
```

三组分别是原始检索、仅通过 Wiki 导航选择原始证据、以及混合检索。所有组均使用原文回答和引用；“Wiki-only”衡量导航覆盖率，不衡量让模型直接相信 Wiki 正文的效果。评估报告保存到 `.rag/wiki/evaluations/`，包含答案断言、引用、召回率、精确率和禁止证据命中。原方案与混合方案均须通过全部 Golden QA，混合方案逐例 Recall@K 不得下降。Wiki-only 只作为对照，不阻止混合方案发布。

这些是本地 hash embedding 和确定性回答的离线结果，不代表生产模型准确率、向量召回、P95 或费用。线上扩流仍遵循 [现有观测与灰度门禁](eval/README.md#shadow-and-gray-rollout-gate)。

发布目标是 `.rag/wiki/published.json`，不会自动改环境变量、重启服务或启用生产流量。发布失败会保留上一个版本。需要回退时可重新发布仍匹配当前知识版本的旧 build；撤掉 `RAG_WIKI_PATH` 并重启对应进程即可完全关闭 Wiki 路径。

## 显式启用评估或运行时

`RAG_WIKI_PATH` 必须是当前进程可读的绝对路径。只有通过发布门禁的包会被使用。

```bash
RAG_WIKI_PATH="$PWD/.rag/wiki/published.json" pnpm rag:evaluate -- --provider --retrieval-only
RAG_WIKI_PATH="$PWD/.rag/wiki/published.json" pnpm rag:evaluate -- --provider
RAG_WIKI_PATH="$PWD/.rag/wiki/published.json" pnpm rag:ask -- "XXYY 不同交易模式有什么区别？"
```

API、Telegram 和 CLI 的产品检索入口都支持这个配置。文件缺失、损坏或没有匹配主题时退回原始检索；历史和具体推文问题直接沿用原路径。Docker 中的路径必须指向容器内挂载的文件，宿主机绝对路径不会自动在容器中生效。

运行时仅从主题页提取原始 chunk ID，并在同一条 PostgreSQL 查询内校验知识版本、撤回标记、替代关系、时效和问题范围。返回给 Agent 的文本、元数据、附件与引用全部来自正式 `knowledge_chunks`，不会返回 Wiki 生成正文。

## 更新与失效

首版使用保守的全库版本：正式知识的新增、内容、适用范围、生效时间、替代关系或撤回发生变化，旧 Wiki 立即失去导航资格，原始检索继续可用。重新执行编译、评估和发布后才能恢复导航。编译期间或发布前发生知识变化也会阻止发布；发布后竞态由查询内版本校验兜底。

当前是手动离线试点，不自动加入 `rag:refresh`，也不创建定时任务。定时整理和仅重编译受影响主题可在评估证明收益后扩展。Markdown 和 bundle 都不能复制到 `docs/product-features/` 再入库，避免派生内容成为自身的证据。

## 验证

```bash
pnpm exec vitest run packages/rag-core/src/knowledge-wiki.test.ts packages/rag-core/src/pgvector-store.test.ts apps/cli/src/wiki.test.ts
pnpm check
```

测试覆盖来源变更与撤回、未知引用、数字错误、提示注入、过期导航、原文引用、文件损坏降级、发布失败保留旧版本、模型响应限额与超时。不得把 `.rag/`、原始群聊或 provider 响应正文提交到仓库。
