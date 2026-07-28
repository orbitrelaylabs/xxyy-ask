# Production Readiness

本文档记录 XXYY 客服 Agentic RAG 服务公开部署前的安全、观测、配额、迁移、备份和交接要求。当前运行面只暴露产品知识库问答，不接入账户、订单、钱包余额、链上取证、投资建议或自动工单操作。

## Request Tracing

每个 chat 请求都应带 `requestId`。如果调用方没有传入，API 会生成一个 request id；Telegram Bot 使用 `telegram:<chat_id>:<message_id>` 作为请求 id。`requestId` 会进入客服 runtime、planner 和结构化日志，用于把一次请求的 guard、planner route、tool route、最终 intent、引用数量和错误码串起来。

API 为 `/api/chat` 和 `/api/chat/stream` 输出 JSON line 日志。核心字段包括：

- `requestId`、`route`、`channel`、`statusCode`、`durationMs`、`outcome`。
- `agentRoute`、`intent`、`confidence`、`citationCount`、`attachmentCount`。
- `messageLength` 和脱敏截断后的 `messagePreview`。
- `sessionIdPresent`、`userIdPresent`，不记录 session id 或 user id 明文。
- 错误时记录 `error`，例如配置缺失、vector store 不可用或 LLM 配置缺失。

日志不打印 API key、私钥、助记词、密码、交易哈希、地址、邮箱和手机号等敏感片段。模型 prompt 侧也会对用户问题和检索片段执行同一类敏感文本脱敏；知识正文及标题/章节元数据还会执行 prompt injection 检测与隔离，避免只在日志层防护。

客服链路保留 vendor-neutral 的 `QualityTracer` 接口，API、普通 CLI 和 Telegram composition root 默认使用 no-op tracer，不连接或上传到外部追踪平台。`pnpm rag:evaluate -- --provider` 会临时启用进程内 tracer，收集 `chat.request`、planner、tool、retrieval、rerank、grounding 和 answer 的结构化摘要来生成评测观察；这些记录不跨进程持久化。

进程内 trace 只包含长度、存在性、route/tool、chunk ID/分数、模型/prompt 版本、token usage、context packing 计数、grounding coverage/claim 计数和 bounded event type。禁止保存完整 system/user prompt、完整 chunk、完整答案、unsupported claim 文本或流式 delta、session/user ID、Authorization/API key 和错误堆栈。

## Abuse Control

API 内置基础保护：

- `API_MAX_BODY_BYTES` 限制 JSON 请求体大小，默认 `65536` 字节。
- `API_RATE_LIMIT_MAX` 和 `API_RATE_LIMIT_WINDOW_MS` 对 `/api/chat`、`/api/chat/stream` 和 `/api/feedback` 按客户端地址限流，默认 `60` 次 / `60000` 毫秒。
- `KNOWLEDGE_ADMIN_RATE_LIMIT_MAX` 和 `KNOWLEDGE_ADMIN_RATE_LIMIT_WINDOW_MS` 独立限制 `/admin/api/*`，默认 `30` 次 / `60000` 毫秒；未认证请求同样计数，降低令牌暴力尝试风险。
- `KNOWLEDGE_ADMIN_MAX_BODY_BYTES` 限制管理请求和 Telegram JSON 导入，默认 `5242880` 字节。网关限制不得高于服务端限制太多。
- `TRUST_PROXY=false` 时只使用 socket 地址；只有在可信反向代理后才设置 `TRUST_PROXY=true` 并读取 `x-forwarded-for` / `x-real-ip`。

公开部署时仍应在网关层增加共享配额，因为进程内限流不适合多实例全局控制：

- 按 session、channel 和 IP 组合限流。
- 对匿名 Web 流量设置更低 burst，对 Telegram 或可信服务端调用设置独立配额。
- 对 429、5xx、超大请求体和高成本模型调用做告警。
- 多实例部署时使用网关、Redis 或 API gateway 的共享限流，而不是依赖单个 Node 进程内存。

## Knowledge Administration Security

知识管理默认关闭。使用 `pnpm admin:token:create -- <id> <role>` 生成高熵令牌，只把 SHA-256 record 配置到 `KNOWLEDGE_ADMIN_TOKENS_JSON`，明文令牌进入组织密码管理器。生产要求：

- 强制 HTTPS；管理入口优先限制在 VPN、零信任代理或独立管理域名。
- 按 `viewer`、`reviewer`、`publisher`、`admin` 最小授权；正常自动化不需要日常审核账号，管理令牌只用于可观测、身份配置和紧急恢复。
- 轮换或撤销令牌时更新配置并滚动重启 API；审计记录使用稳定 actor ID，不写入令牌。
- `/admin` 页面设置 CSP、`no-store`、`X-Frame-Options: DENY` 和 `no-referrer`；管理 API 不开放跨域。
- API 管理面只导入、自动决定候选、维护可信作者及创建发布任务，不在 HTTP 请求内执行长时间 ingest，也不直接编辑 pgvector。Telegram Bot 的实时采集使用相同自动治理，并只写候选、review 和任务。
- 外部 scheduler 运行 `pnpm rag:knowledge:automation:work`（`rag:refresh` 已包含该步骤）对账状态、补建任务、重试少于三次的失败并执行发布。完成/失败写入受 worker ID 与 attempt count fencing 保护；对达到三次仍 `failed`、租约频繁过期、attempt count 异常和长期 queued 建立告警。
- 部署先执行 `pnpm rag:migrate`。API 进程不会自行迁移管理表。

当前 Bearer Token adapter 是本地 MVP 的认证边界；接入企业 IdP 时应保持同一 `KnowledgeAdminPrincipal` 与权限契约，避免把身份提供方逻辑写入知识治理核心。

## Data Privacy And Retention

当前系统不主动查询私有账户、订单、钱包余额或私有交易记录。对用户主动贴入的敏感文本，处理原则如下：

- 日志只保留脱敏后的 `messagePreview` 和长度，不保留完整明文问题。
- `rag_feedback` 会写入反馈问题、答案、intent、引用数和评论；写入前会脱敏凭证类文本。
- Web 的显式 👍/👎 和 Web/Telegram 的无引用产品回答会进入 `rag_feedback`；`automatic_low_evidence` 只作为离线评测和质量告警信号，不会进入知识自动发布路径。
- LLM prompt 会脱敏用户问题和检索片段中的凭证类文本。
- `requestId` 可以用于排查单次请求，但不要把它设计成长期用户标识。
- 进程内评测 trace 不存 session/user ID 明文，不跨进程持久化；requestId 只用于单次评测关联。

建议保留策略：

- API 请求日志：默认 30 天，安全事件可按事件号延长。
- 负反馈和 eval backlog：默认 90 到 180 天，进入 golden QA 的案例应由人工改写，去掉用户私有信息。
- `rag_ingestion_runs`：作为知识库版本和发布审计记录长期保留。
- 原始 `.env`、临时导出、模型请求样本和手工排障文件不应进入仓库。

删除流程：

1. 根据 `requestId`、`sessionId`、时间窗口或外部工单号定位日志和反馈记录。
2. 删除或匿名化 `rag_feedback` 中对应记录。
3. 删除对象存储、日志平台和本地排障文件中的相同样本。
4. 记录删除动作的操作者、时间和范围，不记录被删除的敏感正文。

## Deployment And Operations

生产模式不会启动本地 Docker，也不会由 API 服务自动迁移或写正式知识。管理 API 和 Telegram Bot 只可写治理候选、决策与发布任务；迁移、embedding 和 pgvector 写入必须走独立 Job。

Docker / container 要求：

- 镜像只包含构建产物和依赖，不包含 `.env`、`.rag/`、数据库数据或密钥。
- 运行时通过平台 secret 注入 `OPENAI_API_KEY` 和数据库凭据。
- 容器启动命令只启动 API / Web 服务；迁移、ingest 和 sync 使用独立 release job 或一次性任务执行。
- liveness probe 使用 `/health`，readiness 或发布自检可以使用 `/health/deep`。
- 启用群聊知识实时采集时，确认 Bot 已加入目标群、可调用 `getChatAdministrators`，并按部署需要通过 BotFather 关闭 Privacy Mode；无法验证管理员时自动失败关闭。

单机 Docker Compose 试运行可使用 `pnpm run app:up`。它会后台启动 pgvector、执行迁移、在空库时首次 ingest，并启动 API/Web 与 Telegram；`app:status`、`app:logs`、`app:restart`、`app:stop` 和 `app:down` 用于日常管理。默认端口仅绑定 `127.0.0.1`，服务器应通过 Caddy/Nginx 提供 HTTPS。`app:down` 保留数据库 volume，禁止在没有已验证备份时执行 `docker compose down -v`。

推荐发布流程：

1. 准备生产环境变量，使用密钥管理系统注入，不把 `.env` 打包进镜像。
2. 运行 `pnpm rag:migrate`，只执行数据库迁移，不调用 embedding 或 LLM。
3. 首次部署或全量重建时运行 `pnpm rag:ingest`。
4. 日常同步由外部 scheduler 运行 `pnpm rag:refresh`；低频官网/媒体全量重建运行 `pnpm rag:refresh -- --full`。先用 `--dry-run` 验证固定计划。
5. 启动服务后用 `/health` 做 liveness，用 `/health/deep` 做发布或值班自检。
6. 运行 `pnpm agent:smoke` 验证 health、产品问题路线和边界路线。

刷新 Job 必须与 API/Telegram 进程分离，并在调度平台配置 single concurrency / `Forbid`。仓库侧还用 `.rag/knowledge-refresh/refresh.lock` 防止同一工作区重入，实际运行将脱敏步骤回执原子写入 `.rag/knowledge-refresh/latest.json` 和历史目录；非零退出或回执过期应触发告警。该本地锁不是分布式协调，不得用于替代多实例 scheduler 的并发策略。详见 [Scheduler-safe Knowledge Refresh](knowledge-refresh-operations.md)。

备份要求：

- 对 Postgres 做定期 `pg_dump` 或托管快照，并覆盖 `knowledge_chunks`、`knowledge_candidates`、`rag_ingestion_runs` 和 `rag_feedback`。
- 每次 embedding 模型、`EMBEDDING_DIMENSION` 或正式文档结构变化前先备份。
- 定期在临时库恢复备份，并运行 `pnpm rag:stats` 和 `pnpm rag:evaluate` 验证可用性。

pgvector 注意事项：

- 当前迁移会创建 `vector` extension、`knowledge_chunks_embedding_idx` cosine `ivfflat` 索引和 `knowledge_chunks_tokens_idx` GIN 索引。
- 普通 `pnpm rag:migrate` 是非破坏性的；如果现有 `knowledge_chunks.embedding` 维度与 `EMBEDDING_DIMENSION` 不一致，它会失败并提示显式 rebuild，不会自动删除已有向量。
- 更换 embedding 模型和维度时，必须先备份、同步调整 `EMBEDDING_DIMENSION`，再运行 `pnpm rag:ingest -- --rebuild-embedding-schema`。该命令会在同一事务内清空知识 chunks、重建 embedding 列和向量索引、写入完整 chunks，并记录 ingestion run；任一步失败都会回滚。
- 调整 `RAG_TOP_K`、索引参数或重建索引后，先跑 `pnpm check` 和 provider-backed eval 抽样，确认引用质量没有下降。

## Future Chain-analysis Data-plane Readiness

`packages/evm-chain-analysis-readiness` 已定义未来只读链上分析的 reviewed replay 治理和 production evidence 契约，但它不是当前产品服务的 health/readiness probe，也没有接入部署流程。它要求：

- governed corpus export 与 harness evaluation report 的 corpus id/fingerprint/时间闭合；
- 使用固定 `internalReadinessQualityGate`，调用方不能传入更弱阈值；
- 每个目标 chain/adapter 有 owner 审批的 provider descriptor、`secretref:` 配置和 budget policy；
- 跨实例预算、append-only 审计、告警、共享 circuit、安全和 runbook 控制有未过期 evidence；
- 每个 provider 有新鲜 SLO window 和 circuit snapshot，每类要求的故障演练有新鲜结果；
- blocking evidence 缺口为 `blocked`，结构完整但实时 SLO/circuit/drill 失败为 `degraded`，全部通过才为 `ready`。

仓库已在独立、未接线的 readiness/control-store/data-plane 包中实现 sampling approval/policy/plan/manifest/coverage、target-agnostic manifest/candidate handoff、单槽 owner review work queue、Postgres sampling/governance/budget/circuit/audit backend，以及双 Provider secret/composition/cache/fail-closed transport 和 worker runtime，但没有真实部署或 credential，也没有真实来源/法务审批、生产授权、真实 owner/provider、metrics collector/on-call route、sampling/review handler 或 reviewed 主网 corpus。实现存在不等于审批或运维 evidence 已通过；创建 review slot 也不等于 replay 或标签审核完成。仍需真实 backend-unavailable 演练、访问控制、加密/备份和告警证明。contract-only 测试 fixture 不得写入生产 evidence store，也不得作为发布证明。详细边界见 [Mainnet Sampling Plan & Evidence Intake Control Plane](evm-chain-analysis-sampling.md)、[Sampling Manifest → Reviewed Replay Candidate Handoff](evm-chain-analysis-sampling-handoff.md)、[Single-owner Review Work Queue](evm-chain-analysis-review-work-queue.md)、[Reviewed Replay Corpus Governance & Production Data-plane Readiness](evm-chain-analysis-readiness.md)、[Chain Analysis Governance Persistence & Shared Provider Controls](evm-chain-analysis-control-store.md) 与 [Chain Analysis Provider & Worker Data Plane](chain-data-plane-operations.md)。

## Human Handoff And Tickets

当前服务不创建工单、不承诺人工接管，也不执行账户、订单或钱包操作。未来如果接入 ticketing / CRM，必须先满足这些边界：

- 工单工具必须有独立权限和审计，不能沿用公开客服入口的访问机制。
- 自动创建工单前需要用户确认要提交哪些字段。
- 工单正文不得包含私钥、助记词、API key、密码或完整钱包敏感信息。
- 工单记录至少包含 `requestId`、channel、用户确认时间、提交字段摘要和操作者来源。
- 工单保留、删除和导出策略必须和 `rag_feedback`、日志平台一致。

在这些条件完成前，客服 Agent 只能给出自助下一步或边界说明，不能暗示已经有人接管。
