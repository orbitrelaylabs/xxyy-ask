# AGENTS.md

给 Codex 和其他代码代理使用的项目指令。本文件适用于整个仓库；子目录若有更具体说明，以最近者为准，但不得削弱本文的安全、密钥与验证底线。

## 开始工作前

1. 完整阅读用户请求与相关包/应用代码。
2. 检查 `git status --short`，保留无关改动。
3. 触及 RAG/链上/密钥边界时先读本文件「开发约束」与相关 docs。
4. 除非用户明确要求，不要 commit、push、tag、改历史或部署。

## 项目定位

这是 XXYY 客服 Agentic RAG 系统。当前阶段使用 LangGraph JS 作为 Agent Runtime，运行面以知识库产品问答为主，并为用户明确提供的公开交易引用提供只读查询与证据受控的深度分析：产品问题调用 Product RAG，系统会自动根据官方 X / Twitter 和产品文档更新知识库；链上查询只读取启动时 allowlist 中的公开链数据源。

当前边界：

- 可以回答 XXYY 产品功能、配置步骤、权益说明和官方更新相关问题。
- Telegram 可以对获授权用户提供的公开交易哈希/Explorer 链接执行浏览器基础查询与 XXYY 交易诊断。公开路径不提供 EVM call trace 或 archive MEV；被夹判断只基于浏览器交易事实和 XXYY 前后成交结构，证据不足时必须返回部分数据或数据不足，不能编造结论。
- 产品问答由当前 Agent 在进程内直接调用 Product RAG；另提供两个可独立接入的交易 project Skills：`onchain-transaction-inspector` 和 `xxyy-transaction-diagnosis`。交易查询通过自包含浏览器 JSON CLI 接入，不要求配套常驻服务。
- 不直接查询用户账户、订单、钱包余额或私有交易记录。
- 不提供投资建议。
- 对边界问题必须返回边界回复，不要编造实时数据。

## 技术栈

- TypeScript ESM
- pnpm workspace
- Vitest
- LangGraph JS
- Node `fetch`
- Postgres + pgvector
- OpenAI-compatible `/embeddings` 和 `/chat/completions`

## 目录职责

- `packages/shared`：共享类型和聊天契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize 和 OpenAI embedding provider。
- `packages/rag-core`：意图分类、检索接口、pgvector store、LLM answer provider、边界回复和配置错误类型。
- `packages/agent-core`：LangGraph 客服 Agent runtime、planner、tool registry、Capability Registry，以及内部产品能力和两个公开交易 Skill 的显式授权 bridge。
- `packages/product-support-runtime`：产品知识检索的直接 runtime 与输入输出契约。
- `packages/transaction-skill-bridge`：只执行固定提交依赖中的两个 Skill JSON CLI，校验输入输出、限制超时和输出大小，并只向子进程传递浏览器/XXYY 配置环境变量；不暴露浏览器内部 API 或模型/数据库密钥。
- `@orbitrelaylabs/xxyy-transaction-skills`：来自 [orbitrelaylabs/skills](https://github.com/orbitrelaylabs/skills) 的固定提交依赖；包含自包含的 EVM/Solana 浏览器查询与 XXYY 成交/池子/Sandwich/截图 JSON CLI，不提供 SDK。
- `apps/cli`：`rag:ingest`、`rag:sync:x`、`rag:migrate`、`rag:stats`、`rag:evaluate`、`rag:ask`。
- `apps/api`：HTTP API 和受保护管理面服务入口。
- `apps/telegram-bot`：Telegram Bot long polling 与独立群知识整理 Worker；群消息实时写入本地 PostgreSQL 审计缓冲并入持久化队列，群内保持静默，Worker 自动生成待审候选，管理员批准后才进入发布队列，Bot 和整理 Worker 都不执行 pgvector 发布。
- `apps/web`：仅用于受保护管理后台的 React UI；不提供公开 Web 客服。
- `scripts/rag-refresh.mjs`：供外部 scheduler 调用的固定知识刷新 Job；提供 dry-run、同工作区锁和脱敏回执，并在最后自动对账、重试和执行群聊知识发布，不嵌入 API/Telegram 进程。
- 外部仓库的 `onchain-transaction-inspector`：通用 EVM / Solana 单交易查询与证据解释 Skill；默认禁止隐式调用。
- 外部仓库的 `xxyy-transaction-diagnosis`：单笔公开交易的 XXYY 成交、池子与 Sandwich 证据诊断；默认禁止隐式调用。
- `docs/product-features`：知识库种子文档和静态资产。

## 运行模式

当前项目保留正式 Agentic RAG 路径：Postgres + pgvector + OpenAI-compatible embeddings/chat。

```bash
POSTGRES_DB=xxyy_ask
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=xxyy
POSTGRES_PASSWORD=replace_me_with_a_strong_password
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
KNOWLEDGE_ADMIN_MAX_BODY_BYTES=5242880
KNOWLEDGE_ADMIN_RATE_LIMIT_MAX=30
KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS=60000
TRUST_PROXY=false
```

`pnpm run app:dev`、`pnpm run *:dev` 和 `pnpm rag:*` 会读取项目根目录 `.env`。同名 shell 环境变量优先于 `.env`。

`OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 配置 Chat/Planner。宿主机本地模型服务需要为 Docker Compose 设置 `COMPOSE_OPENAI_BASE_URL`（Docker Desktop 通常使用 `http://host.docker.internal:<端口>/v1`），避免容器把 `localhost` 解释为自身。可用 `EMBEDDING_API_KEY` 和 `EMBEDDING_BASE_URL` 将 embedding 请求发送到独立的 OpenAI-compatible 服务；未配置时回退使用对应的 `OPENAI_*` 配置。

主入口：

- `pnpm run app:dev`：本地会尝试启动 pgvector，然后启动 API + 管理后台；默认不刷新知识库。
- `pnpm run app:dev -- --sync`：启动前检查知识库，空库时 ingest，然后执行增量 X / Twitter 抓取和 `rag:sync:x`。
- `pnpm run app:dev -- --full-sync`：启动前全量同步 `docs.xxyy.io` 中英文页面、图片 OCR、视频字幕/关键帧和 `x.com/useXXYYio` 更新，经审计后重建知识库。
- `pnpm run app:dev -- --ingest`：启动前只执行知识库 ingest。
- `pnpm rag:refresh`：独立增量刷新 Job；`--full` 执行官网/媒体/X 全量重建，两种模式最后都会运行严格自动知识治理与发布队列；`--dry-run` 只验证固定计划。生产定时任务优先使用该入口。
- `pnpm onchain:inspect -- --reference <tx>`：运行自包含的浏览器基础交易查询 Skill JSON CLI；不启动 daemon 或端口。
- `pnpm xxyy:diagnose -- --reference <tx> --checks sandwich,pool`：运行自包含 XXYY Skill JSON CLI；不启动 daemon 或端口，不接受 RPC endpoint 或 RPC 配置。
- `NODE_ENV=production pnpm run app:dev`：生产模式跳过本地 Docker，默认不刷新知识库；可加 `--sync` 或 `--full-sync` 显式更新。
- `pnpm run telegram:dev`：启动 Telegram Bot long polling。
- `pnpm telegram:curation:worker`：启动群聊知识自动清洗 Worker；消费持久化队列，只生成待人工审批的候选。
- `pnpm check`：管理后台 build、format check、typecheck、tests 和 deterministic golden QA。

API 保留的公开服务面：

- `GET /`：跳转到 `/admin`，不提供公开 Web 客服。
- `GET /health`：轻量存活检查。
- `GET /health/deep`：模型连通性检查，检查必填配置、pgvector 知识库、embedding 模型和 chat LLM。
- `POST /api/chat`：非流式客服问答。
- `POST /api/chat/stream`：流式客服问答。
- `POST /api/feedback`：记录 Web 回答的有用/无用反馈；不要求鉴权。
- `GET /assets/*`：产品视频、图片等静态资产。

独立受保护的管理面：`GET /admin` 提供知识治理和 Telegram 用户权限 UI，`/admin/api/*` 使用 PostgreSQL 管理员账号、密码哈希、可撤销 Session 和 RBAC。Telegram Bot 只允许 `telegram_bot_users` 中状态为 active 的用户调用；逐用户 `daily_limit` 为空表示无限制。

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
- `/admin` 在数据库没有管理员时提供一次性首管理员初始化；后续账号、角色、启停和密码全部通过受保护管理后台维护。
- `pnpm rag:knowledge:automation:work`：自动决定遗留候选、补建发布任务、重试少于三次的失败任务，并按 `--limit` 执行发布队列；正常流程不需要逐条人工审核。
- `pnpm rag:knowledge:publication:work`：领取一条持久化 PublicationJob，执行发布门禁与事务性 ingest；生产 API 不直接执行发布。
- `pnpm rag:migrate`：只执行数据库迁移，不调用 embedding 或 LLM。
- `pnpm rag:stats`：查看当前知识库文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。
- `pnpm rag:evaluate`：运行便宜的 deterministic golden QA 子集；`pnpm rag:evaluate -- --provider` 使用正式 Agent/pgvector/OpenAI-compatible provider 做人工全链路评估。
- `pnpm rag:ask -- "问题"`：命令行临时调用客服 Agent。
- `pnpm onchain:inspect`：运行浏览器版单交易基础信息 Skill CLI。
- `pnpm xxyy:diagnose`：运行浏览器版 XXYY 交易诊断 Skill CLI，读取固定 Explorer 与 XXYY 页面；浏览器证据只能给出部分事实和结构性 Sandwich 判断，不能给出深度 trace 或确定性 MEV 结论。
- `pnpm agent:smoke`：检查已启动服务的 health、产品问题路线和边界路线。

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
- 生产 API 服务端不负责迁移；迁移和正式知识写库由独立 `pnpm rag:refresh` Job、`pnpm rag:knowledge:automation:work`、`pnpm run app:dev -- --sync`、`pnpm run app:dev -- --full-sync`、`pnpm rag:ingest` 或 `pnpm rag:sync:x` 完成。本地 `pnpm run app:dev -- --sync` 可以为空知识库做首次 bootstrap。Telegram Bot 只允许创建、自动决定候选和排队，不直接写 pgvector。
- Product RAG capability 只能读取正式产品知识；公开交易 Skill runtime 只能通过固定 Explorer 与 XXYY 页面读取用户明确提供的公开交易，不接受 endpoint、任意请求方法、任意区块范围或私有账户输入。新增 Skill 必须固定 manifest/source/version、配置精确 grant，再通过显式 Tool bridge 暴露，禁止把目录发现结果自动注册到 Planner。
- 公开运行时不得发起 RPC。浏览器必须使用隔离、持久的 Profile，页面来源固定在代码 allowlist 中；页面验证失败、字段缺失或来源冲突时返回 partial/insufficient_data。浏览器与 XXYY 前后成交行只能支持结构性 Sandwich 判断，不能伪装成深度 trace、池状态、盈亏证明或 production-ready 证据。
- Chain Capability bridge 只接受 composition root 固定的可信 caller。程序化 API 使用 `web/anonymous`、Telegram 使用 `telegram/service`；公开路径只接浏览器客户端。
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

- `type` 必须是 `feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`build`、`ci`、`chore` 或 `revert`。
- `scope` 可省略；优先使用 `shared`、`knowledge`、`rag`、`agent`、`cli`、`api`、`web`、`telegram`、`docs`、`infra`、`deps`。涉及多个模块且没有单一主模块时省略 scope。
- `subject` 使用简洁、具体的英文祈使句；普通单词小写开头，产品名或缩写保持原样；不要使用 `update files`、`changes`、`misc`、`WIP` 等模糊描述。
- 标题最长 100 个字符，末尾不加句号、问号或感叹号。
- 有破坏性变更时使用 `<type>(<scope>)!: <subject>`，并在 footer 中添加 `BREAKING CHANGE: ...`。
- 需要正文时，标题与正文之间空一行；正文说明原因和影响，不复述文件列表。

常用 scope 映射：

- `packages/knowledge` 和 `docs/product-features`：`knowledge`
- `packages/rag-core`：`rag`
- `packages/agent-core`：`agent`
- `packages/product-support-runtime` 和 `skills/*`：`agent`
- `packages/shared`：`shared`
- `apps/api`、`apps/web`、`apps/cli`、`apps/telegram-bot`：分别使用 `api`、`web`、`cli`、`telegram`
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

## 完成定义

- [ ] 行为完成且不破坏产品/链上/密钥边界
- [ ] `pnpm check` 通过或披露跳过原因
- [ ] 边界变更已同步文档
- [ ] 交接列出文件、验证与风险

## 仓库工程基线

- 本地开发和 Docker 镜像使用根目录 `.nvmrc` 固定的 Node `24.16.0`。
- 包管理器由根目录 `package.json` 的 `packageManager` 字段固定为 pnpm `11.17.0`。
- 依赖安装使用 pnpm frozen lockfile；不要混用 npm、Yarn 或 Bun lockfile。
- 仓库不配置 GitHub Actions、ESLint 或 Git hooks；安装依赖不得自动修改 Git 配置。
- 交付前按改动风险运行 `pnpm check`。
