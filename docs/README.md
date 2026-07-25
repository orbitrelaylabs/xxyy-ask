# xxyy-ask 文档

## 项目状态

- [目标产品需求与总体设计](target-product-design.md)
- [业务架构](architecture.md)
- [知识来源与分类](knowledge-sources.md)
- [开发质量门禁](development-workflow.md)
- [功能状态](feature-status.md)
- [MCP / Skill Capability Plane](capability-plane.md)
- [通用 Onchain Analysis MCP / Skills](onchain-analysis-mcp.md)
- [生产运行、安全与观测](production-readiness.md)
- [全自动知识演进与 Knowledge Curator](knowledge-evolution.md)
- [Scheduler-safe Knowledge Refresh](knowledge-refresh-operations.md)
- [Allowlisted MEV Observation Data Adapter](evm-mev-observation-data-adapter.md)
- [EVM Chain Analysis Composition & Evaluation Harness](evm-chain-analysis-harness.md)
- [Mainnet Sampling Plan & Evidence Intake Control Plane](evm-chain-analysis-sampling.md)
- [Sampling Manifest → Reviewed Replay Candidate Handoff](evm-chain-analysis-sampling-handoff.md)
- [Single-owner Review Work Queue](evm-chain-analysis-review-work-queue.md)
- [Reviewed Replay Corpus Governance & Production Data-plane Readiness](evm-chain-analysis-readiness.md)
- [Chain Analysis Governance Persistence & Shared Provider Controls](evm-chain-analysis-control-store.md)
- [Chain Analysis Provider & Worker Data Plane](chain-data-plane-operations.md)
- [Reproducible Readiness Evidence Ledger](evm-chain-analysis-readiness-evidence-ledger.md)
- [Chain Analysis Production Environment & Governance Decision Gate](evm-chain-analysis-production-decision-gate.md)
- [Chain Analysis Production Approval & Identity Provisioning](evm-chain-analysis-production-provisioning.md)
- [Roadmap](roadmap.md)

## 完整官网与产品知识库

- [XXYY 完整知识库](product-features/README.md)
- [XXYY 历史产品功能聚合归档](product-features/xxyy-product-functions.md)
- [XXYY X 历史推文产品更新汇总](product-features/xxyy-x-updates.md)
- [官网中英文页面及客服补充](product-features/pages/)
- [页面元数据 manifest](product-features/manifest.jsonl)

这些文档完整同步 `docs.xxyy.io` 中英文 sitemap、站内图片和官方 X 更新，是当前 Product RAG 的种子知识库。

## 当前系统

当前项目是 XXYY 产品客服 Agentic RAG 系统，正式路径为 LangGraph JS + Postgres + pgvector + OpenAI-compatible embeddings/chat completion。公开运行面只保留知识库产品问答；Product MCP/Skill 已正式接入，Chain MCP/Skills 仅完成内部、readiness-gated 的受控接入，交易分析客服入口仍不开放。

- `packages/shared`：共享类型与聊天请求/响应契约。
- `packages/knowledge`：产品文档加载、Markdown chunk、tokenize 和 embedding provider。
- `packages/rag-core`：意图分类、检索、pgvector、可信作者、Knowledge Curator、知识治理服务、LLM answer provider 和边界回复。
- `packages/agent-core`：LangGraph customer runtime、planner/state 合约、Capability Registry 和产品问答 Skill bridge。
- `packages/product-qa-mcp`：只读产品知识 MCP server/client、Skill Resource/Prompt 和 stdio 入口。
- `packages/chain-analysis-mcp`：与产品域解耦的只读 EVM/Solana 交易查询、EVM 深度检查与 Sandwich 判断 MCP server/client、Skill Resource/Prompt 和 readiness 调用门禁。
- `packages/solana-data-adapter`：只允许 `getTransaction` 的 Solana mainnet 数据适配与多 Provider 对账。
- `skills/xxyy-product-support`：项目级产品支持 Skill。
- `skills/onchain-transaction-inspector` / `skills/evm-sandwich-detector`：默认不隐式调用的通用链上分析 Skills；XXYY 公开客服是否授权属于独立宿主决策。
- `packages/evm-chain-analysis-harness`：内部 Chain MCP 复用的 transaction/execution/MEV 离线组合、replay corpus 评测和质量门禁。
- `packages/evm-chain-analysis-readiness`：sampling plan/evidence intake、manifest/candidate handoff、reviewed replay 治理、生产运维证据契约和综合 readiness evaluator；当前不含真实审批、主网 corpus 或 provider backend。
- `packages/evm-chain-analysis-control-store`：Postgres sampling/handoff/治理 artifact、sampling/retention/review work queue、可重算 readiness evidence ledger、哈希链审计、共享 budget 和 circuit CAS backend；当前不含生产配置、真实授权/审批或主网证据。
- `packages/evm-chain-analysis-data-plane`：由运维入口与 readiness-gated Chain MCP 使用的私有双 Provider composition、opaque secret resolver、共享 budget/circuit、bounded cache、持久请求审计、metrics/alert 与四类 worker handler runtime；当前不含真实 credential、部署或 readiness 证明。
- `apps/cli`：`rag:ask`、`rag:ingest`、`rag:migrate`、`rag:stats`、`rag:sync:x`，以及可信作者、Telegram 候选导入、修订、审核和发布命令。
- `apps/api`：`GET /`、`GET /health`、`GET /health/deep`、`POST /api/chat`、`POST /api/chat/stream`、`GET /assets/*`。
- `apps/telegram-bot`：Telegram Bot long polling 入口，复用 LangGraph 客服 Agent。
- `apps/web`：静态聊天 UI。
- `scripts/rag-refresh.mjs`：供外部 scheduler 调用的固定知识刷新 Job，提供 dry-run、同工作区锁和脱敏回执；不嵌入服务进程。

## 常用命令

```bash
pnpm run app:dev                 # 启动 API + Web，默认不刷新知识库
pnpm run app:up                  # 后台启动 pgvector、API/Web 和 Telegram
pnpm run app:status              # 查看后台容器状态
pnpm run app:logs                # 跟随后台服务日志
pnpm run app:dev -- --sync       # 启动前增量抓取 X 更新并同步知识库
pnpm run app:dev -- --full-sync  # 启动前全量重抓 X 更新并重建知识库
pnpm product:mcp:dev             # 启动只读产品知识 stdio MCP server
pnpm onchain:mcp:dev             # 用可配置 RPC 启动通用链上查询 MCP；非生产有免费默认值
pnpm chain:mcp:serve             # 仅在 canonical readiness 有效时启动内部 Chain MCP
pnpm check                       # lint + format check + typecheck + tests + deterministic golden QA
pnpm agent:smoke                 # 轻量验证已启动服务的 health 和核心 agentRoute
```

聚焦命令：

```bash
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
pnpm docs:sync
pnpm docs:enrich:media
pnpm docs:audit
pnpm rag:ingest
pnpm rag:sync:x
pnpm rag:refresh -- --dry-run
pnpm rag:refresh
pnpm rag:refresh -- --full
pnpm rag:stats
pnpm rag:evaluate
pnpm run telegram:dev
pnpm product:mcp:dev
pnpm onchain:mcp:dev
pnpm chain:mcp:serve
```

`pnpm run app:dev -- --sync` 会执行增量 `x:scrape` 和 `rag:sync:x` 后启动服务；`--full-sync` 会同步官网、图片/视频可检索内容，执行文档审计和全量 X scrape，再正式 ingest。生产定时刷新使用独立 `pnpm rag:refresh` Job，不由 API/Telegram 自行运行。外部参考资料不进入正式知识库。

## HTTP 交互

```http
GET /health
GET /health/deep
GET /assets/*
POST /api/chat
POST /api/chat/stream
```

`/health` 是轻量存活检查，不调用外部模型。`/health/deep` 会检查必填配置、pgvector 知识库、embedding 模型和 chat LLM，供 Web 的“模型测试”直接调用，不要求鉴权。

`POST /api/chat` 和 `POST /api/chat/stream` 是无需鉴权的客服入口。Agent 当前只在 `boundary`、`clarify` 和 `product_answer` 之间规划路线。

## Telegram Bot

```bash
pnpm run telegram:dev
```

Bot 通过 Telegram Bot API long polling 接收文本消息，转成 `channel: "telegram"` 的客服请求；在群内还会自动验证并治理当前管理员对用户问题的直接回复。默认只需要配置 `TELEGRAM_BOT_TOKEN`，采集普通群消息时需按部署需要关闭 BotFather Privacy Mode。图片附件公网 URL、轮询超时和重试间隔都有默认处理，只有特殊部署才需要额外覆盖。

## 边界

当前客服 Agent 回答 XXYY 产品功能、配置步骤、权益说明和官方更新相关问题。

以下请求必须走边界或澄清回复：

- 用户账户、订单、钱包余额、私有交易记录等实时私有数据查询。
- 代开通、代取消、代修改等账户或订单操作。
- 投资建议。
- 交易哈希、交易链接、池子查询、链上取证和泛 MEV 分析请求。
- 无法从公开产品知识库得到依据的实时数据。
