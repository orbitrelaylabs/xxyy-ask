# xxyy-ask

XXYY 客服 Agentic RAG 项目。当前阶段暂时收敛为知识库产品问答：使用 LangGraph JS 编排客服回答，从 [XXYY 官方文档](https://docs.xxyy.io/)、[官方 X 更新](https://x.com/useXXYYio) 和通过严格自动治理发布的客服群知识中检索依据，并通过 OpenAI-compatible chat completion 生成带引用回答。群聊知识按“验证管理员 → 清洗/提取 → 确定性自动决策 → 隔离发布门禁”闭环更新，不需要逐条人工审批。

当前运行面提供知识库问答与受控公开链只读分析：

- 产品功能、配置步骤、权益说明和官方更新相关问题会走 Product RAG。
- Web 与 Telegram 已接入公开交易只读查询：基础查询返回状态、区块、地址、金额、手续费和公开转账事实；单笔 EVM 深度查询可返回调用追踪、内部转账与回滚证据；指定或唯一推断的 allowlisted pool 可执行 Sandwich/MEV 四态判断。
- Telegram Bot 会订阅加群/退群事件，并在收到群消息时更新本地群注册表；`/admin` 可查看 Bot 已识别的群 ID、名称、成员状态和最近活动时间。注册表不保存普通群消息正文，升级前已加入的群会在收到下一条新消息后补登记。
- 已接入只读 `xxyy-product-support` MCP server 和同名 project Skill。另已实现与产品域解耦的 `onchain-analysis` MCP、onchain transaction inspector / EVM Sandwich detector Skills；公开运行面为固定 `web/anonymous` 与 `telegram/service` 创建三项工具的六条 Skill/MCP 精确授权。深度结果仍受 trace/archive Provider、池子 allowlist 和生产 readiness 门禁约束。内置网络为 Solana、Ethereum、BSC、Base、Robinhood Chain、Stable Chain。
- 不查询用户账户、订单、钱包余额或私有交易记录，不提供投资建议。

最终产品需求与总体设计见 [docs/target-product-design.md](docs/target-product-design.md)，当前功能状态见 [docs/feature-status.md](docs/feature-status.md)，知识采集、审批与发布流程见 [docs/knowledge-evolution.md](docs/knowledge-evolution.md)，知识图谱、别名与三路混合召回见 [docs/knowledge-graph-retrieval.md](docs/knowledge-graph-retrieval.md)，MCP / Skill 安全执行与当前接入见 [docs/capability-plane.md](docs/capability-plane.md)，通用链上 MCP、Explorer 和 RPC 配置见 [docs/onchain-analysis-mcp.md](docs/onchain-analysis-mcp.md)，离线 EVM 交易核心见 [docs/transaction-analysis-core.md](docs/transaction-analysis-core.md)，执行语义增强见 [docs/evm-execution-enrichment.md](docs/evm-execution-enrichment.md)，价格影响与 Sandwich 判定见 [docs/evm-price-impact-sandwich.md](docs/evm-price-impact-sandwich.md)，受控标准 RPC 数据边界见 [docs/evm-data-adapter.md](docs/evm-data-adapter.md)，受控执行数据边界见 [docs/evm-execution-data-adapter.md](docs/evm-execution-data-adapter.md)，同区块 MEV observation 数据边界见 [docs/evm-mev-observation-data-adapter.md](docs/evm-mev-observation-data-adapter.md)，离线组合与评测见 [docs/evm-chain-analysis-harness.md](docs/evm-chain-analysis-harness.md)，主网采样计划与 evidence intake 见 [docs/evm-chain-analysis-sampling.md](docs/evm-chain-analysis-sampling.md)，manifest 到 candidate 的无偏交接见 [docs/evm-chain-analysis-sampling-handoff.md](docs/evm-chain-analysis-sampling-handoff.md)，单 owner 复核任务队列见 [docs/evm-chain-analysis-review-work-queue.md](docs/evm-chain-analysis-review-work-queue.md)，reviewed replay 与生产数据面就绪控制见 [docs/evm-chain-analysis-readiness.md](docs/evm-chain-analysis-readiness.md)，Postgres 治理与共享控制 backend 见 [docs/evm-chain-analysis-control-store.md](docs/evm-chain-analysis-control-store.md)，production provisioning 运维见 [docs/chain-control-provisioning-operations.md](docs/chain-control-provisioning-operations.md)，Provider/worker data plane 运维见 [docs/chain-data-plane-operations.md](docs/chain-data-plane-operations.md)，可重算 readiness 证据账本见 [docs/evm-chain-analysis-readiness-evidence-ledger.md](docs/evm-chain-analysis-readiness-evidence-ledger.md)，生产运行说明见 [docs/production-readiness.md](docs/production-readiness.md)，后续规划见 [docs/roadmap.md](docs/roadmap.md)。

## 项目结构

```text
apps/
  api/          HTTP API 和 Web UI 服务入口
  chain-control-cli/  隔离的 production provisioning 与 receipt/audit 验证入口
  chain-operations-cli/  隔离的双 Provider、共享控制、worker 运维与 readiness-gated Chain MCP 入口
  cli/          RAG ingest、X sync、migrate、stats、ask 命令
  telegram-bot/ Telegram Bot long polling 入口
  web/          静态聊天页面
packages/
  shared/       共享类型和聊天契约
  knowledge/    产品文档加载、Markdown chunk、tokenize、embedding provider
  rag-core/     意图分类、检索、pgvector store、LLM 回答和边界回复
  agent-core/   LangGraph 客服 runtime、tool registry，以及已接入产品检索的 MCP/Skill capability plane
  agent-sdk/    版本化 HTTP API 的可复用 TypeScript 客户端
  product-qa-mcp/  只读产品知识 MCP server/client、Skill Resource/Prompt 和 stdio 入口
  chain-analysis-mcp/  通用 EVM/Solana 交易查询与 EVM Sandwich MCP server/client、Skill Resource/Prompt
  transaction-analysis-core/  无网络依赖、由内部 Chain MCP 组合的只读 EVM 交易事实计算
  evm-data-adapter/  私有、allowlisted 且有资源上限的只读 EVM JSON-RPC 归一化
  solana-data-adapter/  只读 Solana getTransaction、余额变化归一化与多 Provider 对账
  evm-execution-enrichment-core/  由内部 Chain MCP 组合的离线 trace/revert/Uniswap swap 语义增强
  evm-execution-data-adapter/  私有 allowlisted callTracer 和 pool/factory metadata 验证
  evm-price-impact-sandwich-core/  由内部 Chain MCP 组合的离线 price impact 和 Sandwich 四态判定
  evm-mev-observation-data-adapter/  私有 allowlisted 同区块 MEV observation 构建与验证
  evm-chain-analysis-harness/  内部 Chain MCP 复用的离线链上分析组合、回放评测与质量门禁
  evm-chain-analysis-readiness/  sampling/handoff/reviewed replay 治理与生产就绪控制面
  evm-chain-analysis-control-store/  Postgres sampling/handoff/review/readiness ledger/共享控制 backend
  evm-chain-analysis-data-plane/  私有双 Provider composition、secret、budget/circuit/cache/audit/worker runtime
docs/
  product-features/ 产品知识库种子文档和静态资产
skills/
  xxyy-product-support/  通过只读 MCP 检索正式产品知识的项目 Skill
  onchain-transaction-inspector/  通用 EVM / Solana 单交易证据解释 Skill
  evm-sandwich-detector/  通用 allowlisted EVM pool Sandwich 四态判断 Skill
```

## 环境准备

本地开发和 Docker 镜像统一使用 Node.js `24.16.0` 与 pnpm `11.17.0`。精确版本分别由
`.nvmrc` 和 `package.json#packageManager` 固定。

```bash
corepack enable
corepack install
pnpm install --frozen-lockfile
cp .env.example .env
```

`pnpm run app:dev`、`pnpm run *:dev` 和 `pnpm rag:*` 会读取项目根目录 `.env`。如果同名变量已经在 shell 里导出，则 shell 环境变量优先。

核心配置示例：

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
# Required by pnpm onchain:mcp:dev. Copy the six-chain public example from .env.example,
# then replace its endpoints with managed Providers for production.
ONCHAIN_RPC_CONFIG_JSON='{"evm":[...],"solana":{...}}'
ONCHAIN_ALLOW_INSECURE_LOCALHOST=false

OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=...
COMPOSE_OPENAI_BASE_URL=
EMBEDDING_API_KEY=...
EMBEDDING_BASE_URL=https://api.openai.com/v1
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
OPENAI_REQUEST_TIMEOUT_MS=30000
OPENAI_MAX_RETRIES=1

RAG_TOP_K=6

ANSWER_QUALITY_WEB_MODE=optimized
ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE=100
ANSWER_QUALITY_TELEGRAM_MODE=optimized
ANSWER_QUALITY_TELEGRAM_OPTIMIZED_PERCENTAGE=100
ANSWER_QUALITY_CLI_MODE=optimized
ANSWER_QUALITY_CLI_OPTIMIZED_PERCENTAGE=100
ANSWER_QUALITY_OBSERVABILITY_ENABLED=false

KNOWLEDGE_AUTO_REFRESH_ENABLED=false
KNOWLEDGE_AUTO_REFRESH_INCREMENTAL_DAILY_AT=08:00
KNOWLEDGE_AUTO_REFRESH_TIME_ZONE=Asia/Shanghai
KNOWLEDGE_AUTO_REFRESH_STALE_AFTER_MINUTES=1560

API_CORS_ORIGIN=
API_ENABLE_DEEP_HEALTH=
API_MAX_BODY_BYTES=65536
API_RATE_LIMIT_MAX=60
API_RATE_LIMIT_WINDOW_MS=60000
TRUST_PROXY=false
XXYY_AGENT_API_KEYS_JSON=
KNOWLEDGE_ADMIN_MAX_BODY_BYTES=5242880
KNOWLEDGE_ADMIN_RATE_LIMIT_MAX=30
KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS=60000

TELEGRAM_BOT_TOKEN=
TELEGRAM_API_BASE_URL=
TELEGRAM_GROUP_RESPONSES_ENABLED=false
TELEGRAM_GROUP_MESSAGE_RETENTION_DAYS=30
```

数据库默认从 `POSTGRES_*` 组装连接串；使用托管数据库时可以配置 `DATABASE_URL` 覆盖。`OPENAI_*` 配置 Chat/Planner；`EMBEDDING_API_KEY` 和 `EMBEDDING_BASE_URL` 可把向量请求发送到独立的 OpenAI-compatible 服务，未配置时回退使用 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`。`pnpm run app:up` 会把 `ONCHAIN_RPC_CONFIG_JSON` 和 `ONCHAIN_ALLOW_INSECURE_LOCALHOST` 显式映射给 API 与 Telegram；未配置时产品客服仍可用，但公开交易查询会返回配置提示。当 `OPENAI_BASE_URL` 指向宿主机上的本地服务时，设置 `COMPOSE_OPENAI_BASE_URL=http://host.docker.internal:<端口>/v1`，让容器访问宿主机，同时保留 `app:dev` 使用的 `localhost` 地址。OpenAI-compatible 请求默认 30 秒超时、重试 1 次。默认 embedding 维度是 `1536`，匹配 `text-embedding-3-small`；更换 embedding 模型和维度时需要同步调整 `EMBEDDING_DIMENSION`，备份数据库后显式运行 `pnpm rag:ingest -- --rebuild-embedding-schema`。`.env.example` 会列出当前代码支持的环境变量。

回答质量流程可以按 Web、Telegram 和 CLI 独立设置 `optimized`、`legacy` 或 `shadow`。`shadow` 按对应的 `*_OPTIMIZED_PERCENTAGE` 稳定选择主流程，同时在后台运行另一流程；只把主回答返回给用户，追踪中仅保存路线、状态、来源类型、引用数量差、答案指纹是否一致、延迟和 Token 差，不保存两份回答正文或具体答案指纹，也不从 Shadow 结果创建知识候选。Shadow 或灰度前应设置 `ANSWER_QUALITY_OBSERVABILITY_ENABLED=true`；Web API 和 Telegram 会输出 `event=answer_quality_rollout` 的 JSON line，记录渠道、模式、稳定分流比例、主/影子流程和上述脱敏差异，不包含问题、答案、用户 ID、会话 ID或请求 ID。紧急回滚可只把受影响渠道的 `*_MODE` 改为 `legacy`；回滚只切换 Query Plan、多轮补检和证据充分性策略，不改变客服边界、工具授权或知识发布门禁。

真实 Shadow/灰度观察结束后，先使用 `pnpm rag:rollout:evidence` 从严格 JSONL 和已审批控制文件生成证据包，再使用 `pnpm rag:rollout:gate` 校验预先批准的质量、P95、错误率、人工抽检和供应商账单预算。缺少任一证据时命令失败关闭；完整命令、格式和模板见 `docs/eval/README.md`。

本地 Docker Compose 会把这些变量显式传给 API 和 Telegram。可用下面的方式启动 10%
本地 Shadow；门禁通过后把两个 `*_MODE` 改为 `optimized`、比例改为 `100` 重新执行即可
本地扩量，改成 `legacy` 和 `0` 可验证回滚：

```bash
ANSWER_QUALITY_OBSERVABILITY_ENABLED=true \
ANSWER_QUALITY_WEB_MODE=shadow \
ANSWER_QUALITY_WEB_OPTIMIZED_PERCENTAGE=10 \
ANSWER_QUALITY_TELEGRAM_MODE=shadow \
ANSWER_QUALITY_TELEGRAM_OPTIMIZED_PERCENTAGE=10 \
docker compose up --detach --build api telegram
```

这些 shell 覆盖只作用于本次容器创建；外部部署仍应在受控环境配置中持久化，并重新执行独立
审批和观察窗口。

例如 Chat/Planner 使用 Sub2API Grok、embedding 使用独立服务：

```bash
OPENAI_API_KEY=your_sub2api_key
OPENAI_BASE_URL=https://your-sub2api.example/v1
OPENAI_MODEL=grok-4.5

EMBEDDING_API_KEY=your_embedding_key
EMBEDDING_BASE_URL=https://your-embedding-provider.example/v1
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
```

仅更换 Chat/Planner 模型不需要重建知识库。更换 embedding 供应商时，只有确认新服务实际提供与现有知识库相同的 embedding 模型和维度才能复用现有向量；否则必须执行 embedding schema 重建和全量 ingest。

## 启动

### 后台一键试运行（推荐）

安装 Docker Desktop，并在根目录 `.env` 填好数据库、OpenAI-compatible 模型和 Telegram 配置后运行：

```bash
pnpm run app:up
```

该命令会构建统一应用镜像，在后台启动 PostgreSQL + pgvector，等待数据库健康，执行迁移，只在知识库为空时执行首次 `rag:ingest`，然后启动 API/Web 和 Telegram long polling。容器使用 `restart: unless-stopped`，终端关闭后仍会运行，Docker 重启后也会恢复。

常用运维命令：

```bash
pnpm run app:status   # 查看容器和健康状态
pnpm run app:logs     # 跟随 API 与 Telegram 日志，Ctrl+C 只退出日志
pnpm run app:restart  # 重启 API 与 Telegram
pnpm run app:stop     # 停止 API 与 Telegram，保留数据库运行
pnpm run app:down     # 停止并移除容器，保留数据库 volume
```

默认只监听本机 `127.0.0.1:3000`，访问 `http://localhost:3000` 后可以直接使用 XXYY Agent 问答。不要运行 `docker compose down -v`，该命令会删除本地数据库 volume。

以后迁移到普通 Linux 服务器时可以使用相同的 `pnpm run app:up`。推荐让 Caddy/Nginx 代理本机 `127.0.0.1:3000` 并负责 HTTPS；只有明确配置防火墙或反向代理时才把 `APP_BIND_HOST` 改为 `0.0.0.0`。使用外部托管数据库时设置容器可访问的 `COMPOSE_DATABASE_URL`。

`rag:knowledge:publish` 应在保存 Git 工作区的主机上执行；发布生成的 `docs/product-features/admin-verified/*.md` 需要提交到 Git，不能只留在一次性容器中。

### 前台开发运行

本地启动完整问答服务：

```bash
pnpm run app:dev
```

本地模式下，启动脚本会尝试启动本地 pgvector，构建最新 Web 静态资源，然后启动 API + Web。默认不刷新知识库，避免每次开发启动都触发抓取或写库。

需要在启动前更新知识库时显式传参：

```bash
pnpm run app:dev -- --sync       # 增量抓取 X / Twitter 并同步知识库后启动
pnpm run app:dev -- --full-sync  # 全量同步官网与 X / Twitter 并重建知识库后启动
pnpm run app:dev -- --ingest     # 只重建知识库后启动
```

生产模式不会启动本地 Docker：

```bash
NODE_ENV=production pnpm run app:dev
NODE_ENV=production pnpm run app:dev -- --sync
```

启动后访问：

```text
http://localhost:3000
```

## 同步与命令

常用入口：

```bash
pnpm run app:dev                 # 启动 API + Web，默认不刷新知识库
pnpm run app:up                  # Docker Compose 后台启动 API + Web + Telegram + pgvector
pnpm run app:status              # 查看后台服务状态
pnpm run app:logs                # 查看后台服务日志
pnpm run app:dev -- --sync       # 启动前增量更新知识库
pnpm run app:dev -- --full-sync  # 启动前全量同步官网与 X / Twitter 并重建知识库
pnpm run api:dev                 # 只启动 API + Web 服务入口
pnpm run web:dev                 # 只启动 Vite Web
pnpm run telegram:dev            # 启动 Telegram Bot
pnpm product:mcp:dev             # 启动只读产品知识 stdio MCP server
pnpm onchain:mcp:dev             # 从根目录 .env 启动通用六链查询 MCP
pnpm onchain:query -- help       # 内部 cli/admin 通过 Tool → Skill → MCP 查询
NODE_ENV=production pnpm onchain:query:production -- help # readiness-gated 生产内部查询
pnpm chain:mcp:serve             # readiness 通过后启动内部链上分析 stdio MCP
pnpm check                       # Web build + format check + typecheck + tests + deterministic golden QA
```

仓库不配置 GitHub Actions、ESLint 或 Git hooks。提交和推送前可按改动风险手动运行
`pnpm check`；安装依赖不会修改 checkout 的 Git 配置。详见[开发验证](docs/development-workflow.md)。

`pnpm product:mcp:dev` 暴露一个 read-only MCP tool `search_product_docs`，以及 `xxyy://skills/product-support` Skill Resource 和 `xxyy_product_support` Prompt。API、CLI 和 Telegram 不需要额外进程：它们在同一进程内通过 MCP SDK 的 linked in-memory transport 调用完全相同的 server，再由 Capability Registry 对 `product.skill.search_docs → product.mcp.search_docs` 两层执行精确授权、超时、输出大小和脱敏审计。MCP discovery 不会自动扩展 Planner 工具列表。

`pnpm onchain:mcp:dev` 启动与产品域解耦的 `onchain-analysis` server，暴露 `get_transaction`、`inspect_transaction`、`detect_sandwich`、capabilities Resource、两个 Skill Resources 和 Prompts。它自动读取根目录 `.env`，解析 Solscan/Solana Explorer、Etherscan、BscScan、Basescan/Base Blockscout、Robinhood Blockscout、Stablescan 链接，并从必填的 `ONCHAIN_RPC_CONFIG_JSON` 获取 RPC allowlist。`evm` / `solana` 配置基础快照；可选 `execution` 显式配置 trace source 和 factory allowlist；可选 `mevObservation` 显式配置 archive Provider 与 pool allowlist。代码不内置 endpoint，也不按 `NODE_ENV` 选择 Provider；`.env.example` 的 Robinhood 示例组合官方公共 RPC 与 Blockscout raw trace，因此可返回带明确部分证据警告的调用树，仍不能作为可靠 Sandwich 或 production readiness 证据。

`pnpm onchain:query` 是内部集成入口，固定使用 `cli/admin` grant，并在同一进程内执行 `ToolRegistry → chain.skill.* → chain.mcp.* → MCP protocol`。它自动读取开发 MCP 的 `ONCHAIN_RPC_CONFIG_JSON`，支持 `transaction`、`inspect` 和 `sandwich` 三个显式子命令；`NODE_ENV=production` 时失败关闭，不能绕过 `pnpm chain:mcp:serve` 的生产 readiness 门禁。Web/API/Telegram 复用同一启动时 allowlist，并以固定公开 caller 注册三项只读能力的六条精确 grant。

`pnpm onchain:query:production` 是对应的受控生产查询入口，同样固定为 `cli/admin` 并保留 Tool → Skill → MCP 两层精确授权。它要求 `NODE_ENV=production`，只把 allowlist 中的 chain-control、manifest、secret mount 和 Product RAG 数据库身份配置传给子进程，然后通过无额外 stdout 包装的 Node/stdio transport 启动与 `pnpm chain:mcp:serve` 相同的生产 MCP 入口。该入口不读取项目 `.env`、不接受 RPC endpoint 参数，也不会在生产门禁失败时回退到 `ONCHAIN_RPC_CONFIG_JSON` 或公共 RPC。

`pnpm chain:mcp:serve` 启动相同 MCP surface 的 XXYY 内部 production composition。该命令不自动加载 `.env`，stdout 只承载 MCP protocol；启动前必须固定 `CHAIN_ANALYSIS_DATA_PLANE_MANIFEST_FINGERPRINT` 与 `CHAIN_ANALYSIS_READINESS_FINGERPRINT`，并从独立 control DB 重读 attestation、operations evidence 和 policy。证明缺失、非 `ready`、过期或 Provider/budget lineage 漂移都会失败关闭；进程启动后每次调用仍检查有效时间窗。仓库当前没有真实生产证明，因此这不是公开客服入口或 production-ready 声明。通用配置与能力矩阵见 [Onchain Analysis MCP / Skills](docs/onchain-analysis-mcp.md)。

RAG 和数据库命令：

```bash
pnpm docs:sync
pnpm docs:enrich:media
pnpm docs:audit
pnpm rag:ingest
pnpm rag:ingest -- --rebuild-embedding-schema # 仅用于有意更换 embedding 维度
pnpm rag:sync:x
pnpm rag:refresh -- --dry-run
pnpm rag:refresh
pnpm rag:refresh -- --full
pnpm rag:migrate
pnpm rag:stats
pnpm rag:evaluate
pnpm rag:quality:evaluation:worker # Admin 评测队列的隔离本地 Worker
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
pnpm rag:knowledge:author:trust -- --chat-id -100123 --user-id 123 --role knowledge_editor --valid-from 2026-07-01 --reviewer ops:alice
pnpm rag:knowledge:import:telegram -- export.json
pnpm rag:knowledge:import:telegram -- export.json --curation-mode required
pnpm rag:knowledge:list -- --status rejected
pnpm rag:knowledge:automation:work -- --limit 20
```

私有 chain-control 命令不属于客服运行面，也不会自动加载 `.env`：

```bash
pnpm chain:control:migrate
pnpm chain:provision:plan -- --input /secure/request.json --out /secure/plan.json
pnpm chain:provision:attest -- --plan /secure/plan.json --private-key /run/secrets/authority.pem --policy-evidence-hash sha256:... --authority-system-id platform_policy_verifier --out /secure/attestation.json
pnpm chain:provision:apply -- --plan /secure/plan.json --attestation /secure/attestation.json --out /secure/receipt.json
pnpm chain:provision:receipt -- --plan-id production_provisioning_plan_...
pnpm chain:provision:verify -- --plan-id production_provisioning_plan_... --attestation /secure/attestation.json
pnpm chain:mcp:serve
```

这些命令要求与 Product RAG 分离的数据库、真实 evidence fingerprint 和受保护 Ed25519 机器身份。完整时间窗口、密钥、TLS、最小权限和核验流程见 [Chain Control Production Provisioning Operations](docs/chain-control-provisioning-operations.md)。

- `pnpm docs:sync` 根据 `docs.xxyy.io` 中英文 sitemap 同步全部官网 Markdown 页面和站内图片；同步后运行 `pnpm rag:ingest` 写入 pgvector。
- 正式知识库只加载 `docs.xxyy.io`、`x.com/useXXYYio` 和通过严格自动治理发布的客服群知识；仓库中的外部参考资料仅归档，不参与检索。
- `pnpm docs:enrich:media` 对官网图片执行本地 OCR，并为本地视频抽取关键帧；YouTube 优先读取公开字幕，无字幕时仅在配置 `TRANSCRIPTION_MODEL` 后执行音频转写。视频本身的提取状态与知识覆盖状态分开记录；正文已覆盖的视频会保存上下文文件 SHA，不会被误报为知识缺失。结果写入独立 sidecar Markdown 和哈希清单，不覆盖官网原文。
- OCR、字幕、转写和关键帧文字参与检索，原始图片或视频地址随 chunk 保存；命中相关依据时，API 会返回媒体附件，Web 可直接显示截图和本地视频，Telegram 可发送常用图片格式和本地 MP4。
- `pnpm docs:audit` 校验页面空页/404 状态、图片、OCR、视频知识覆盖、正文覆盖证据和英文审核兜底；默认未转写但正文已覆盖的视频仅作为 Notice，`MEDIA_REQUIRE_ALL=true` 仍可要求每个视频本身都必须提取成功。
- `pnpm rag:ingest` 执行数据库迁移、重新生成 embeddings，并在同一事务内替换 pgvector chunks 和记录 ingestion run。
- `pnpm rag:ingest -- --rebuild-embedding-schema` 会事务性清空知识 chunks、按当前 `EMBEDDING_DIMENSION` 重建 embedding 列和向量索引，再写入完整知识库；只在有意更换维度且已备份时使用。
- `pnpm rag:sync:x` 只同步官方 X / Twitter 更新中新增或变更的 chunks，不会 prune 旧知识块。
- `pnpm rag:refresh` 是供 cron/systemd/云调度器调用的一次性安全刷新 Job：默认执行 X 抓取与增量入库，`--full` 执行官网、媒体、审计、全量 X 和正式 ingest；两种模式最后都会自动对账群聊候选、补建/重试发布任务并执行队列。`--dry-run` 只展示固定命令计划。实际运行使用 `.rag/knowledge-refresh/refresh.lock` 防止同工作区重入，并写入不含环境变量或异常原文的 latest/历史 JSON 回执。
- `pnpm rag:migrate` 只执行非破坏性数据库迁移，不调用 embedding 或 LLM；若检测到现有向量维度不匹配会明确失败，不会自动删列。
- `pnpm rag:stats` 查看文档数、chunk 数、source URL 数、最新 chunk 更新时间和最近一次 ingestion run。
- `pnpm rag:evaluate` 运行便宜的 deterministic golden QA 子集；`pnpm rag:evaluate -- --provider` 使用正式 Agent/pgvector/OpenAI-compatible provider 做人工全链路评估。
- `pnpm rag:evaluate -- --report-out .rag/quality-report.json` 生成不含回答正文的版本化发布前报告；加 `--baseline .rag/quality-baseline.json` 会拒绝用例通过率、Recall、MRR 或 nDCG 回退。Provider 模式还会在 P95 延迟或总 Token 相对基线增加超过 20% 时失败。
- `pnpm rag:evaluate -- --provider --case <golden-name>` 可按精确用例名做低成本诊断抽检；可重复传入，未知名称失败关闭。局部抽检不能与 `--baseline` 联用，也不能替代全量发布门禁。
- `pnpm rag:evaluate -- --provider --judge` 在人工验收时额外使用 `EVAL_JUDGE_MODEL` 评分；judge 不进入默认 `pnpm check`，也不会回退复用 `OPENAI_MODEL`。
- `pnpm rag:evaluate -- --failures-out .rag/eval-failures.jsonl` 把失败项写成已脱敏、必须人工审核的 JSONL，不会直接修改 golden QA。
- `pnpm rag:ask` 从命令行调用客服 Agent。
- `pnpm rag:knowledge:author:trust/list` 维护按群和有效期生效的可信作者名册。实时群回复默认用 Telegram Bot API 自动识别当前管理员；历史导出只有当前角色却无法证明历史角色时会失败关闭，不会伪装成历史已验证。
- `pnpm rag:knowledge:import:telegram` 用于受控导入 Telegram Desktop JSON；日常群聊由 Bot 实时写入本地 Inbox。管理员在 `/admin` 选择群并点击整理后，系统合并连续管理员消息、重建 reply 关系并执行脱敏、边界、去重、冲突与质量检查，生成必须人工审核的 `pending` 候选。
- `pnpm rag:knowledge:automation:work` 对账异常遗留候选、幂等补建发布任务、自动重试少于三次的失败任务并执行队列。正式发布仍必须通过边界、检索命中、deterministic golden QA、embedding 和事务 ingest 门禁。
- `pnpm rag:knowledge:list/history` 用于只读审计；revise/approve/reject/publish 保留为有认证和审计的紧急恢复命令，不属于日常自动化路径。
- 首次打开 `/admin` 且数据库没有管理员时，页面会进入一次性初始化流程；首个账号固定为 `admin` 角色，后续用户、角色和启停在“管理员用户”页面维护。所有角色都可以在“我的账号”验证当前密码后修改本人密码；当前会话保留，其他会话撤销。
- 管理后台在 `GET /admin`，用于查看 Telegram Inbox、整理消息、审核候选、管理发布任务和审计。Telegram 候选必须人工批准；批准后自动创建发布任务，再由独立 Worker 执行入库门禁。完整流程见 [知识采集、审批与发布](docs/knowledge-evolution.md)。

检索质量：

- 知识入库按 Markdown 标题层级保留完整 `headingPath`，默认单块上限 900 字符。长正文优先按中英文句末切分并保留最多 100 字符语义重叠；列表、表格和 fenced code 按结构行切分，避免把操作步骤拆在中间。若同一文档包含至少 3 个短章节且合并后仍不超过上限，会在保留叶子块的同时追加一个文档概览父块，用于回答“有哪些区域/功能”这类跨章节问题。
- 空图片、空注释、孤立代码围栏、水平分隔线和许可证链接不会生成检索块。X / Twitter 原始消息每条独立成文档，只索引正文，账号、帖子 ID、URL 和发布时间继续保留在结构化元数据中。
- embedding 检索文本包含标题、模块与完整章节路径。进入回答模型前，知识正文及可展示元数据会先脱敏并隔离疑似 prompt injection，再按 chunk 公平预算、完整句子、列表和限制条件打包为 JSON 资料字段；长 chunk 不再固定截取前 900 个字符。
- 正式产品问答使用 pgvector 向量、Postgres 全文关键词和支持实体候选，并通过 RRF 合并不同分数尺度的 rank；候选阶段保留 source/debug scores 便于评测和排障。
- 内置 `createMetadataReranker()` 是本地 deterministic reranker，使用问题覆盖率、标题/模块/heading、直接来源、列表/步骤证据和当前有效状态做通用二阶段排序，不调用外部模型，也不按具体产品 case 写规则。
- 明确分类为 `product_qa` / `how_to` 的普通问题直接用完整原问题执行一次 `search_product_docs`，随后由 `answer_composer` 回答，不增加 Planner 调用。比较/多模块问题若缺少证据维度，observation 才允许 Planner 针对缺失维度改写后续 query；original question 始终独立保留。
- Agent loop 受 max steps、重复工具输入和无新增证据三重保护；即使 query 不同但返回同一批 chunk/引用也会停止，并以部分证据说明或澄清安全结束。
- 模型答案返回前会在本地校验关键 claim 的数字、限制、支持状态和操作事实；无证据输出降级为 deterministic grounded answer，成功输出只保留实际支撑 claim 的引用。该校验不调用第二个模型。流式答案先缓冲完成校验，防止已经发出的幻觉 token 无法撤回。
- LLM relevance judge 或外部 reranker provider 可以按同一接口接入，但应默认关闭，并在有评估用例证明收益后再启用，以避免额外成本和延迟。

## 回答质量闭环

管理后台“回答质量”页面把日常质量治理集中到 UI：管理员可以查看持久化历史报告和失败案例，按权限创建快速、正式召回或完整 Agent/Judge 评测，并把全量通过且门禁通过的报告批准为同模式基线。Admin API 只写 PostgreSQL 任务；Docker Compose 中独立的 `quality-worker` 执行固定白名单评测并写回脱敏结果，不接受命令、路径或任意参数。工程构建、类型检查和单元测试仍由 `pnpm check` 执行，不属于管理后台远程能力。

默认 `pnpm rag:evaluate` 同时输出答案断言和已标注样本的 Recall@K、Precision@K、MRR、nDCG@K、forbidden hit；没有 retrieval 标注的案例不会被当作零分。发布或模型/检索变更时再显式运行 provider-backed 路径：

```bash
pnpm rag:evaluate -- --provider
EVAL_JUDGE_MODEL=your-judge-model pnpm rag:evaluate -- --provider --judge
pnpm rag:evaluate -- --provider --failures-out .rag/provider-failures.jsonl
```

LLM judge 只是辅助信号，不能替代 deterministic gate 和人工核验。失败 JSONL 与 `pnpm rag:feedback:backlog` 一样属于 review queue；审核者应核对官方来源、补齐精确 facts/chunk IDs/引用要求并添加审核签名，再用 `pnpm rag:feedback:promote -- .rag/reviewed-feedback.jsonl --reviewer <id>` 将去隐私后的稳定案例受控晋升到 Golden QA。该命令不会写知识库。完整规则见 [docs/eval/README.md](docs/eval/README.md)。

Provider-backed 评测只使用进程内质量追踪记录，不向外部追踪平台上传请求、知识片段或回答内容；进程结束后记录即释放。

服务验收：

```bash
pnpm agent:smoke
```

默认检查 `GET /health`、产品问题路由和边界问题路由。

## Telegram Bot

```bash
pnpm run telegram:dev
```

配置 `TELEGRAM_BOT_TOKEN` 后，Bot 会通过 long polling 接收消息，并以 `channel: "telegram"` 调用同一套 LangGraph 客服 Agent。私聊文本直接触发回答。`TELEGRAM_GROUP_RESPONSES_ENABLED=false` 是默认的群聊只读模式：Bot 可以接收 Telegram 允许它看到的群消息并交给受控知识观察流程，但不会发送命令回复、客服答案、typing、媒体或错误消息。

未来需要恢复群内客服回答时才显式设置 `TELEGRAM_GROUP_RESPONSES_ENABLED=true`；启用后，group/supergroup 中只有 Bot 命令、精确 `@BotUsername` 或直接回复当前 Bot 的消息才触发客服回答。Bot 通过 `getMe` 获取并缓存自身 ID/username；身份暂不可用时群聊回答失败关闭并在后续消息重试，不会退化为回复所有群消息。

Bot 通过实时 Update 将 group/supergroup 文本写入本地 PostgreSQL 收件箱，但不会在 Telegram update 内生成或发布知识。后台“Telegram 群聊”页面可以查看待整理数量和最近消息；管理员点击“整理待处理消息”后，系统才会合并同一作者的连续发言，识别管理员显式 Reply 与紧邻普通回答，并执行作者验证、脱敏、产品边界、质量、去重和冲突检查。官方答疑群中的链、代币、交易等省略式产品问题会继承 XXYY 上下文，但无关闲聊仍会过滤。问答配对不设置时间间隔上限，但非 Reply 不跨越其他作者消息猜测。生成的 Telegram 候选带 `manual_review_required` 并保持 `pending`，必须在“知识候选”页面人工编辑、批准或拒绝；批准后自动创建发布任务，再由隔离 Worker 执行正式发布门禁。如果一次整理既没有创建候选也没有识别到重复项，消息会保留为待整理并展示过滤统计；管理员也可以显式重新整理已经处理的消息。原始消息只保存在本地数据库，默认保留 30 天，可用 `TELEGRAM_GROUP_MESSAGE_RETENTION_DAYS` 调整。Bot、匿名 `sender_chat` 内容不会进入候选。要采集普通群消息，需要关闭 BotFather Privacy Mode，或把 Bot 设为群管理员，并授予读取消息及查询管理员列表所需权限。

Bot 同时订阅 `edited_message`：编辑后的正文会覆盖本地收件箱记录并重新标记为待整理。Telegram Bot API 不提供通用删除事件，因此删除消息目前不能自动同步；已生成的错误候选需要管理员在后台拒绝，已经发布的错误知识需要走受审计的修订或撤回流程。

Bot 菜单中的 `/status` 会显示知识库自动更新是否启用、增量/全量计划、最近刷新时间和结果。Web 聊天页头部显示同一状态；两端只读取调度器的脱敏回执，不获得知识写入权限。安装外部 scheduler 后设置 `KNOWLEDGE_AUTO_REFRESH_ENABLED=true`，并确保 `.rag/knowledge-refresh` 对客服容器只读可见。成功回执超过 `KNOWLEDGE_AUTO_REFRESH_STALE_AFTER_MINUTES` 后，状态会显示为刷新延迟。

如果 Telegram 容器所在网络需要 HTTP 代理，设置
`TELEGRAM_NODE_USE_ENV_PROXY=1` 和 `TELEGRAM_HTTPS_PROXY=http://<proxy-host>:<port>`。
Docker Compose 只把这些值映射给 Telegram 服务，不会改变 API/Web 的模型请求；按需使用
`TELEGRAM_NO_PROXY` 保留数据库和本地地址直连。

## HTTP API

Web UI：

```http
GET /
```

健康检查：

```http
GET /health
GET /health/deep
GET /api/knowledge-refresh-status
```

`/health` 是轻量存活检查，不会调用外部模型。`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM，供 Web 的“模型测试”直接调用，不要求鉴权。部署平台的 liveness probe 应使用 `/health`，不要使用 `/health/deep`。

聊天：

```http
POST /api/chat
POST /api/chat/stream
POST /api/feedback
POST /api/support/escalate
GET /api/support/status?sessionId=...
```

请求示例：

```json
{
  "message": "XXYY Pro 有哪些权益？",
  "channel": "web"
}
```

静态资产：

```http
GET /assets/*
```

用于返回产品文档中的视频、图片等静态资源。

外部复用使用认证和版本化接口：

```http
GET  /api/v1/openapi.json
POST /api/v1/chat
POST /api/v1/chat/stream
POST /api/v1/feedback
POST /api/v1/support/escalate
```

运行 `pnpm agent:api-key:create -- partner-service` 生成只显示一次的 Key 和
`XXYY_AGENT_API_KEYS_JSON` 哈希记录。`packages/agent-sdk` 提供 `createXxyyAgentClient()`，封装问答、SSE、反馈和转人工；未配置 Key 时 `/api/v1` 失败关闭。

受保护的知识管理面：

```http
GET /admin
GET /admin/api/me
GET /admin/api/candidates
GET /admin/api/candidates/:id
PATCH /admin/api/candidates/:id
POST /admin/api/candidates/:id/approve
POST /admin/api/candidates/:id/reject
POST /admin/api/candidates/:id/publication
GET /admin/api/publications
POST /admin/api/publications/:id/retry
GET|POST /admin/api/trusted-authors
POST /admin/api/imports/telegram
GET /admin/api/support/metrics
GET|PATCH /admin/api/support/tickets/:id
GET|POST /admin/api/support/conversations/:id/messages
GET /admin/api/support/knowledge-gaps
GET /admin/api/quality/overview
GET|POST /admin/api/quality/jobs
GET /admin/api/quality/reports
GET /admin/api/quality/reports/:id
POST /admin/api/quality/reports/:id/baseline
```

`/admin` 使用 PostgreSQL 管理员账号和密码登录，并按 `viewer`、`reviewer`、`publisher`、`admin` 实施 RBAC。密码只保存 scrypt 哈希，登录后签发有期限、可撤销的数据库 Session；管理员重置其他账号密码或禁用账号会撤销其现有 Session，本人验证当前密码改密时保留当前会话并撤销其他会话。后台阻止当前管理员修改自己的角色或状态，避免误锁定。没有数据库管理员时页面自动进入一次性首管理员初始化，创建成功后入口永久关闭；公开聊天不受影响。管理页面主要用于自动治理可观测与紧急恢复；日常发布不依赖人工登录。页面使用同源请求、严格 CSP、`no-store` 和独立限流，不给公开 `/api/chat` 增加鉴权。

通过 `pnpm run app:dev` 或 `pnpm run api:dev` 启动的 API 会为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 结构化日志，包含 channel、intent、agentRoute、引用数、耗时、状态码、错误码、消息长度和脱敏截断后的消息预览等字段。日志只记录 `sessionId/userId` 是否存在，不打印用户 ID 明文，并会脱敏密钥、交易哈希、地址、邮箱和手机号等敏感片段。

API 默认限制 JSON 请求体最大 `65536` 字节，并对聊天、反馈、转人工和人工回复轮询按客户端地址做基础限流。默认不信任 `x-forwarded-for` / `x-real-ip`；只有服务确实位于可信反向代理后，才设置 `TRUST_PROXY=true`。同源客服问答和反馈接口不要求鉴权，`/api/v1` 外部接口要求独立 Bearer Key。Web 的 👍/👎 会写入 `rag_feedback`；Web/Telegram 中无引用的产品问答也会自动记录为 `automatic_low_evidence`，只进入后台知识缺口和离线评测队列，不会直接进入知识自动发布路径。完整客服系统 Goal、数据流与限制见 [docs/agent-customer-service-goal.md](docs/agent-customer-service-goal.md)。跨域接入前端时配置 `API_CORS_ORIGIN`，支持单个 origin、逗号分隔多个 origin 或 `*`。公开部署前请先阅读 [production readiness](docs/production-readiness.md)。

## 边界

当前 Agent 回答 XXYY 产品支持知识库问题，并支持用户提供的公开交易基础查询、单笔 EVM 调用追踪和受控 Sandwich/MEV 分析。以下请求必须走边界或澄清回复：

- 用户账户、订单、钱包余额、私有交易记录等实时私有数据查询。
- 代开通、代取消、代修改等账户或订单操作。
- 投资建议、收益承诺、买卖建议。
- 任意地址历史、地址真实归属、未提供具体交易的泛链上取证，以及要求绕过 Provider/readiness/pool allowlist 的 MEV 结论。

对边界问题不要编造实时数据；产品问题缺少数据库、embedding 或 chat LLM 配置时应明确失败原因。
