# AGENTS.md

给 Codex 和其他代码代理使用的项目指令。

## 项目目标

这是 XXYY 客服 Agentic RAG 系统。当前阶段使用 LangGraph JS 作为 Agent Runtime，但运行面暂时收敛为知识库产品问答：产品问题调用 Product RAG，系统会自动根据官方 X / Twitter 和产品文档更新知识库。

当前边界：

- 可以回答 XXYY 产品功能、配置步骤、权益说明和官方更新相关问题。
- 交易哈希、公开 explorer 链接、池子查询、链上取证和泛 MEV 问题暂不分析，必须返回边界或澄清回复。
- 已提供只读 `xxyy-product-support` MCP server 和同名 project Skill；另有内部专用、readiness-gated 的 `xxyy-chain-analysis` MCP，以及 transaction inspector / Sandwich detector 两个 project Skills。公开客服仍不分析交易或 MEV。
- 不直接查询用户账户、订单、钱包余额或私有交易记录。
- 不提供投资建议。
- 对边界问题必须返回边界回复，不要编造实时数据。
- 未接线的链上生产准备采用 `single_owner`：一个受控人工 principal 承担 planner/publisher/reviewer/attestor，采集、Provider 和保留使用隔离 service account；自动 verifier 是补偿控制，不得描述为第二名人工审批人。

## 技术栈

- TypeScript ESM
- pnpm workspace
- Vitest
- LangGraph JS
- Model Context Protocol TypeScript SDK
- Node `fetch`
- Postgres + pgvector
- OpenAI-compatible `/embeddings` 和 `/chat/completions`

## 目录职责

- `packages/shared`：共享类型和聊天契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize 和 OpenAI embedding provider。
- `packages/rag-core`：意图分类、检索接口、pgvector store、LLM answer provider、边界回复和配置错误类型。
- `packages/agent-core`：LangGraph 客服 Agent runtime、planner、tool registry、Capability Registry，以及 Product Skill → MCP 显式授权 bridge。
- `packages/product-qa-mcp`：只读产品知识 MCP server/client、`search_product_docs` 契约、Skill Resource/Prompt 和 stdio 入口。
- `packages/chain-analysis-mcp`：内部只读链上分析 MCP server/client、`inspect_transaction` / `detect_sandwich`、Skill Resource/Prompt、输出投影与 readiness 时间窗门禁。
- `packages/transaction-analysis-core`：无网络依赖的 EVM transaction snapshot 领域分析；由内部 Chain MCP composition 调用。
- `packages/evm-data-adapter`：启动时 allowlist 的只读 EVM JSON-RPC 获取、归一化和 provider 协调；只接入私有 data plane。
- `packages/evm-execution-enrichment-core`：离线的 EVM call trace、revert 和 allowlisted DEX swap 语义增强；由内部 Chain MCP composition 调用。
- `packages/evm-execution-data-adapter`：启动时 allowlist 的 callTracer 获取和 Uniswap V2/V3 pool/factory 元数据验证；只接入私有 data plane。
- `packages/evm-chain-analysis-harness`：不执行网络 I/O 的 transaction/execution/MEV 离线组合、replay corpus 评测和质量门禁；内部 Chain MCP 只传入已验证对象。
- `packages/evm-chain-analysis-readiness`：无网络 I/O 的 sampling plan/evidence intake、manifest/candidate handoff、单 owner reviewed replay 治理、生产数据面证据契约和综合 readiness evaluator；不含真实来源/法务审批、主网样本或 provider backend，Chain MCP 只消费持久化 evaluator 结果。
- `packages/evm-chain-analysis-control-store`：通过注入 client 执行 SQL 的 Postgres sampling/handoff/单 owner 治理证据存储、sampling/retention/review worker contract、可重算 readiness evidence ledger、哈希链审计、共享 provider budget 和 circuit CAS backend；不自行创建连接、不访问 RPC/HTTP、不含生产 grant/审批/真实证据。
- `packages/evm-chain-analysis-data-plane`：私有双 Provider composition root；从 opaque secret resolver 构建三个只读 adapter，在 HTTP 外层执行共享 budget/circuit、bounded cache、持久脱敏审计、metrics/alert 以及四类 worker handler contract；仅由运维入口和 readiness-gated Chain MCP 使用，不含真实 endpoint/credential 或生产部署证明。
- `packages/evm-price-impact-sandwich-core`：离线的 lossless AMM price impact 和 Sandwich 四态判定；由内部 Chain MCP composition 调用。
- `packages/evm-mev-observation-data-adapter`：启动时 allowlist 的同区块 swap、transaction-boundary pool state、actor token delta 和多 provider 冲突验证；只接入私有 data plane。
- `apps/chain-control-cli`：与客服运行面隔离的生产 provisioning composition root；从受控 plan 与 Ed25519 attestation 写入独立 control Postgres，并重读 receipt/grant lineage/audit chain。
- `apps/chain-operations-cli`：与客服运行面隔离的 Provider/worker 运维入口；还提供只有固定 manifest、canonical readiness attestation 与 Provider/budget lineage 全部有效时才启动的内部 chain-analysis stdio MCP composition root。
- `apps/cli`：`rag:ingest`、`rag:sync:x`、`rag:migrate`、`rag:stats`、`rag:evaluate`、`rag:ask`。
- `apps/api`：HTTP API 和 Web UI 服务入口。
- `apps/telegram-bot`：Telegram Bot long polling 入口；群内当前管理员直接回复会进入严格自动知识治理，但 Bot 不执行 pgvector 发布。
- `apps/web`：静态聊天 UI。
- `scripts/rag-refresh.mjs`：供外部 scheduler 调用的固定知识刷新 Job；提供 dry-run、同工作区锁和脱敏回执，并在最后自动对账、重试和执行群聊知识发布，不嵌入 API/Telegram 进程。
- `skills/xxyy-product-support`：项目级 XXYY 产品支持 Skill；只依赖同名只读 MCP，不扩大客服边界。
- `skills/xxyy-evm-transaction-inspector`：内部 EVM 单交易证据解释 Skill；默认禁止隐式调用。
- `skills/xxyy-evm-sandwich-detector`：内部 allowlisted pool Sandwich 四态判断 Skill；默认禁止隐式调用。
- `docs/product-features`：知识库种子文档和静态资产。

## 运行模式

当前项目保留正式 Agentic RAG 路径：Postgres + pgvector + OpenAI-compatible embeddings/chat。

```bash
POSTGRES_DB=xxyy_ask
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=xxyy
POSTGRES_PASSWORD=replace_me_with_a_strong_password
CHAIN_CONTROL_DATABASE_URL=
CHAIN_CONTROL_AUTHORITY_SYSTEM_ID=
CHAIN_CONTROL_AUTHORITY_PUBLIC_KEY_FILE=
CHAIN_ANALYSIS_DATA_PLANE_MANIFEST_FINGERPRINT=
CHAIN_ANALYSIS_READINESS_FINGERPRINT=
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=...
COMPOSE_OPENAI_BASE_URL=
EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
OPENAI_REQUEST_TIMEOUT_MS=30000
OPENAI_MAX_RETRIES=1
RAG_TOP_K=6
API_CORS_ORIGIN=
API_ENABLE_DEEP_HEALTH=
API_MAX_BODY_BYTES=65536
API_RATE_LIMIT_MAX=60
API_RATE_LIMIT_WINDOW_MS=60000
KNOWLEDGE_ADMIN_TOKENS_JSON=
KNOWLEDGE_ADMIN_MAX_BODY_BYTES=5242880
KNOWLEDGE_ADMIN_RATE_LIMIT_MAX=30
KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS=60000
TRUST_PROXY=false
```

`pnpm run app:dev`、`pnpm run *:dev` 和 `pnpm rag:*` 会读取项目根目录 `.env`。同名 shell 环境变量优先于 `.env`。

`OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 配置 Chat/Planner。宿主机本地模型服务需要为 Docker Compose 设置 `COMPOSE_OPENAI_BASE_URL`（Docker Desktop 通常使用 `http://host.docker.internal:<端口>/v1`），避免容器把 `localhost` 解释为自身。可用 `EMBEDDING_API_KEY` 和 `EMBEDDING_BASE_URL` 将 embedding 请求发送到独立的 OpenAI-compatible 服务；未配置时回退使用对应的 `OPENAI_*` 配置。

主入口：

- `pnpm run app:dev`：本地会尝试启动 pgvector，然后启动 API + Web；默认不刷新知识库。
- `pnpm run app:dev -- --sync`：启动前检查知识库，空库时 ingest，然后执行增量 X / Twitter 抓取和 `rag:sync:x`。
- `pnpm run app:dev -- --full-sync`：启动前全量同步 `docs.xxyy.io` 中英文页面、图片 OCR、视频字幕/关键帧和 `x.com/useXXYYio` 更新，经审计后重建知识库。
- `pnpm run app:dev -- --ingest`：启动前只执行知识库 ingest。
- `pnpm rag:refresh`：独立增量刷新 Job；`--full` 执行官网/媒体/X 全量重建，两种模式最后都会运行严格自动知识治理与发布队列；`--dry-run` 只验证固定计划。生产定时任务优先使用该入口。
- `pnpm product:mcp:dev`：以 stdio 启动只读产品知识 MCP server；API、CLI 和 Telegram 内部使用同一 MCP server 的 in-memory transport。
- `pnpm chain:mcp:serve`：启动内部 `xxyy-chain-analysis` stdio MCP；不自动读取 `.env`，且必须同时通过固定 manifest、未过期 `ready` attestation、完整 Provider/budget lineage 与独立 control DB 门禁。
- `pnpm chain:control:migrate` 与 `pnpm chain:provision:*`：只用于隔离的链上控制面 provisioning；不自动加载 `.env`，不接入客服或 Agent。
- `NODE_ENV=production pnpm run app:dev`：生产模式跳过本地 Docker，默认不刷新知识库；可加 `--sync` 或 `--full-sync` 显式更新。
- `pnpm run telegram:dev`：启动 Telegram Bot long polling。
- `pnpm check`：lint、format check、typecheck、tests 和 deterministic golden QA。

API 保留的公开服务面：

- `GET /`：Web UI。
- `GET /health`：轻量存活检查。
- `GET /health/deep`：模型连通性检查，检查必填配置、pgvector 知识库、embedding 模型和 chat LLM；Web 的“模型测试”直接调用，不要求鉴权。
- `POST /api/chat`：非流式客服问答。
- `POST /api/chat/stream`：流式客服问答。
- `POST /api/feedback`：记录 Web 回答的有用/无用反馈；不要求鉴权。
- `GET /assets/*`：产品视频、图片等静态资产。

独立受保护的管理面：`GET /admin` 提供知识治理 UI，`/admin/api/*` 必须使用配置在 `KNOWLEDGE_ADMIN_TOKENS_JSON` 中的 Bearer Token 哈希记录并经过 RBAC。它不是公开客服 API；未配置令牌时管理 API 失败关闭，不影响公开聊天。

API 默认限制 JSON 请求体最大 `65536` 字节，并对 `/api/chat`、`/api/chat/stream` 和 `/api/feedback` 按客户端地址做 `60` 次 / `60000` 毫秒的基础限流。默认不信任 `x-forwarded-for` / `x-real-ip`；仅在可信反向代理后设置 `TRUST_PROXY=true`。客服问答和反馈接口不要求鉴权。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。

## 常用验证

修改代码后优先跑：

```bash
pnpm check
```

更新产品文档、X / Twitter 数据或检索/回答逻辑后，优先跑：

```bash
pnpm run app:dev -- --sync
pnpm check
```

如果改了正式文档结构、需要重建全部知识库，或要做发布前全量确认，再跑：

```bash
pnpm run app:dev -- --full-sync
```

命令说明：

- `pnpm docs:sync`：根据 `docs.xxyy.io` 中英文 sitemap 同步全部官网 Markdown 页面和站内图片；同步后需要执行 `pnpm rag:ingest`。
- 正式知识库只接受 `docs.xxyy.io`、`x.com/useXXYYio` 和通过严格自动策略与发布门禁的客服群知识；外部参考资料不参与入库。
- `pnpm docs:enrich:media`：为官网图片和视频生成独立的 OCR/字幕/转写 sidecar；视频提取状态与经 SHA 校验的正文知识覆盖状态分开记录，无公开字幕且需要完整转写的视频需显式配置 `TRANSCRIPTION_MODEL`。
- `pnpm docs:audit`：检查官网空页/404、资源 SHA、OCR、视频知识覆盖及其正文证据和英文兜底。
- `pnpm rag:ingest`：执行数据库迁移、重新生成全部 embeddings、写入 pgvector，并记录 ingestion run。
- `pnpm rag:sync:x`：同步官方 X / Twitter 更新，只 embedding 新增或变更的 X chunks，不会 prune 旧 chunk。
- `pnpm rag:refresh`：执行 scheduler-safe 知识刷新，使用 `.rag/knowledge-refresh/refresh.lock` 防止同工作区重入，并写入不含环境变量或异常原文的 latest/历史 receipt；固定计划最后运行 `rag:knowledge:automation:work`，外部 scheduler 仍需配置 single concurrency 和失败告警。
- `pnpm admin:token:create -- <id> <role>`：生成只显示一次的管理令牌和 SHA-256 配置记录。
- `pnpm rag:knowledge:automation:work`：自动决定遗留候选、补建发布任务、重试少于三次的失败任务，并按 `--limit` 执行发布队列；正常流程不需要逐条人工审核。
- `pnpm rag:knowledge:publication:work`：领取一条持久化 PublicationJob，执行发布门禁与事务性 ingest；生产 API 不直接执行发布。
- `pnpm rag:migrate`：只执行数据库迁移，不调用 embedding 或 LLM。
- `pnpm rag:stats`：查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。
- `pnpm rag:evaluate`：运行便宜的 deterministic golden QA 子集；`pnpm rag:evaluate -- --provider` 使用正式 Agent/pgvector/OpenAI-compatible provider 做人工全链路评估。
- `pnpm rag:ask -- "问题"`：命令行临时调用客服 Agent。
- `pnpm product:mcp:dev`：为外部 MCP host 启动 `xxyy-product-support` stdio server，暴露只读 `search_product_docs`、Skill Resource 和 Prompt。
- `pnpm chain:mcp:serve`：为受控内部 MCP host 启动 `xxyy-chain-analysis`，只暴露 `inspect_transaction` 与 `detect_sandwich`；任何 readiness 缺失、过期或 lineage 漂移都会失败关闭。
- `pnpm agent:smoke`：检查已启动服务的 health、产品问题路线和边界路线。
- `pnpm chain:control:migrate`：迁移独立 chain-control PostgreSQL。
- `pnpm chain:provision:plan/attest/apply/receipt/verify`：生成 plan、机器签名、窗口内原子 apply，并验证 receipt、八条 grant lineage 和治理 audit chain；真实输入不得提交到仓库。

关键行为验证：

```bash
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD -u OPENAI_API_KEY -u OPENAI_MODEL pnpm rag:ask -- "帮我查一下钱包余额"
env -u DATABASE_URL -u POSTGRES_DB -u POSTGRES_USER -u POSTGRES_PASSWORD OPENAI_API_KEY=test-key OPENAI_MODEL=test-model OPENAI_EMBEDDING_MODEL=text-embedding-3-small pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

期望：

- 边界问题不需要 DB/API key，应该返回 `realtime_account_query` 或其它边界/澄清结果。
- 产品问题缺 `DATABASE_URL` 或 `POSTGRES_*` 应明确失败。

## 开发约束

- 优先遵循现有模块边界，不要随意重构 monorepo 结构。
- 不要提交 `.rag/`、`.env`、数据库数据或密钥。
- 不要在 `docker-compose.yml` 写死数据库密码；使用 `.env` 注入。
- 不要把真实 API key 写入测试、README 或日志。
- 不要提交 chain-control request、plan、attestation、receipt、authority private key 或真实 identity/evidence fingerprint；通过受保护的运维通道提供。远程 control DB 必须验证 TLS，且不能与 Product RAG 共库。
- 生产 API 服务端不负责迁移；迁移和正式知识写库由独立 `pnpm rag:refresh` Job、`pnpm rag:knowledge:automation:work`、`pnpm run app:dev -- --sync`、`pnpm run app:dev -- --full-sync`、`pnpm rag:ingest` 或 `pnpm rag:sync:x` 完成。本地 `pnpm run app:dev -- --sync` 可以为空知识库做首次 bootstrap。Telegram Bot 只允许创建、自动决定候选和排队，不直接写 pgvector。
- Product MCP 只能读取正式产品知识；Chain MCP 只能读取 allowlisted 的公开 Ethereum/Uniswap 数据，不能接受 endpoint、任意 RPC、任意区块范围或私有账户输入。新增 MCP/Skill 必须分别固定 manifest/source/version、配置精确 grant，再通过显式 Tool bridge 暴露，禁止把 discovery 结果自动注册到 Planner。
- Chain Capability bridge 仅允许 `internal/(service|admin)` 或 `cli/admin` 可信调用方；Web/API/Telegram 不得创建 chain grant 或注册 chain Tool。生产 stdio 入口还必须逐次检查 readiness 有效时间窗，不能把仓库 fixture 或启动成功描述为 production ready。
- 新增行为需要加测试；风险较高的改动跑 `pnpm check`。
- 对外错误信息应清晰区分：
  - LLM 配置缺失
  - embedding 配置缺失
  - vector store 配置缺失
  - vector store 运行时不可用

## Commit message 规范

Codex Desktop、Codex CLI 和人工创建 Git 提交时统一使用 Conventional Commits。用户在 Codex Desktop 点击 Commit 或 Commit & Push 后，生成的提交消息也必须遵循本节。

生成消息前先检查 `git diff --cached --stat` 和 `git diff --cached`，只描述暂存区中的改动；不要把未暂存文件、历史改动或猜测写进提交消息。暂存区包含多个无关改动时应先拆分提交。单纯执行 Push 时，不要为了改写措辞而修改已有合规提交。

标题格式：

```text
<type>(<scope>): <subject>
```

- `type` 必须是 `feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`style` 或 `revert`。
- `scope` 可省略；优先使用 `shared`、`knowledge`、`rag`、`agent`、`cli`、`api`、`web`、`telegram`、`docs`、`infra`、`deps`。涉及多个模块且没有单一主模块时省略 scope。
- `subject` 使用简洁、具体的英文祈使句；普通单词小写开头，产品名或缩写保持原样；不要使用 `update files`、`changes`、`misc`、`WIP` 等模糊描述。
- 标题最长 100 个字符，末尾不加句号、问号或感叹号。
- 有破坏性变更时使用 `<type>(<scope>)!: <subject>`，并在 footer 中添加 `BREAKING CHANGE: ...`。
- 需要正文时，标题与正文之间空一行；正文说明原因和影响，不复述文件列表。
- 不得使用 `--no-verify` 绕过项目的 `commit-msg` 校验。

仓库 hooks 分工：`pre-commit` 检查暂存快照的格式、lint、危险路径和文件大小；`commit-msg` 校验本节规范；`pre-push` 校验待推送提交并运行完整 `pnpm check`。GitHub Actions 还会验证事件 commit range，规则实现必须保持共享，不要在 hook 和 CI 中复制不同正则。

常用 scope 映射：

- `packages/knowledge` 和 `docs/product-features`：`knowledge`
- `packages/rag-core`：`rag`
- `packages/agent-core`：`agent`
- `packages/product-qa-mcp`、`packages/chain-analysis-mcp` 和 `skills/*`：`agent`
- `packages/shared`：`shared`
- `apps/api`、`apps/web`、`apps/cli`、`apps/telegram-bot`：分别使用 `api`、`web`、`cli`、`telegram`；`apps/chain-control-cli` 与 `apps/chain-operations-cli` 使用 `infra`
- 开发文档：`docs`；Docker、脚本和仓库工具链：`infra`；依赖更新：`deps`

示例：

```text
feat(knowledge): improve markdown chunk boundaries
fix(api): route container model requests to the host
docs: document the knowledge sync workflow
chore(infra): enforce conventional commit messages
```

## Git 状态提示

当前本地 `main` 可能领先 `origin/main`。提交前先看：

```bash
git status --short --branch
```
