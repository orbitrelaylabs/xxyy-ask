# Feature Status

本文档记录当前功能状态。项目当前定位是 XXYY 产品客服 Agent：用产品文档和官方 X / Twitter 更新回答产品支持问题。

## Current First Slice

- [x] LangGraph 客服 Runtime：`packages/agent-core` 使用 LangGraph JS 组织策略保护、planner、检索工具、证据观察和回答合成。当前只注册 `search_product_docs` 业务工具；账户、订单、钱包余额、私有交易记录、交易分析和投资建议请求会先进入边界或澄清回复。
- [x] Product RAG：产品问题会检索 Postgres + pgvector 中的知识库 chunks，并通过 OpenAI-compatible chat completion 生成带引用回答。正式来源限定为 `docs.xxyy.io` 官方文档、`x.com/useXXYYio` 官方更新，以及通过严格自动治理发布的客服群知识。
- [x] Scheduler-safe 知识刷新：`pnpm rag:refresh` 提供外部 scheduler 可调用的 X 增量 Job，`--full` 执行官网/媒体/X 全量重建，最后统一对账知识候选、补建/重试发布任务并执行队列；`--dry-run` 验证固定计划。实际运行有同工作区锁、stale recovery、步骤级脱敏回执和失败退出。
- [x] HTTP 服务面：保留 `GET /`、`GET /health`、`GET /health/deep`、`GET /api/knowledge-refresh-status`、`POST /api/chat`、`POST /api/chat/stream` 和 `GET /assets/*`。
- [x] Web UI：`GET /` 提供静态聊天界面，支持普通回答、流式回答、引用展示、产品知识库附件，以及基于调度器脱敏回执的自动更新状态徽标。
- [x] Telegram Bot：`pnpm run telegram:dev` 通过 Telegram Bot API long polling 接收文本消息，并以 `channel: "telegram"` 复用同一套 LangGraph 客服 Agent；Bot 菜单提供 `/status` 查看自动更新状态，并提供 `/learning`、`/learning_on`、`/learning_off` 查看和由管理员持久化控制本群自动学习。启用后只在内存中保留有界 reply 对话链，当前管理员回复用户时自动验证身份并进入知识治理；Web 不采集客服对话用于知识演进。
- [x] Knowledge Curator Auto Mode：Telegram 实时回复和 Desktop JSON 可按角色有效期验证作者、重建 reply 线程、脱敏、分类、标准化、去重、检查正式 chunk 冲突并生成质量/风险信息；默认 `auto` 只把确定性路径未覆盖的复杂线程交给已配置模型，模型缺失或单线程失败时安全降级并返回脱敏统计，同时保留 deterministic/required 模式和调用预算。
- [x] 严格自动知识治理：`knowledge-automation-v1` 以确定性规则验证来源、提取方式、作者时效、最低质量、重复/冲突、风险、Agent lineage 和 prompt injection；合格候选自动批准并入队，其余自动拒绝。模型不能决定发布，正常流程没有逐条人工审核。
- [x] 知识治理管理面：`GET /admin` 提供独立 Bearer Token 认证和 `viewer/reviewer/publisher/admin` RBAC，支持候选上下文、自动原因、重复/冲突对比、revision/history、可信作者、Telegram 导入和发布状态；人工操作只保留为有审计的紧急恢复面，公开客服 API 仍不暴露知识写入能力。
- [x] 可靠自动发布任务：自动治理幂等创建 `PublicationJob`；`pnpm rag:knowledge:automation:work` 对账遗留状态、补建任务、最多重试三次并用租约执行现有发布门禁，最终候选状态与 pgvector ingest 在同一数据库事务完成。
- [x] 新旧规则策略：当前问题默认排除被 `supersedes` 替代的知识，历史追溯问题仍可检索旧版本。
- [x] RAG Trustworthiness v0.2：知识正文和标题/章节元数据先执行凭证脱敏与 prompt injection 隔离；回答上下文按 chunk、完整句子和限制条件打包；模型回答在返回前执行本地 claim grounding，未被安全证据支持的数字、限制、支持状态或操作事实会降级为确定性回答。流式路径先完成同一校验，避免无证据 token 已发送后无法撤回。
- [x] Bounded Agent Loop v0.3：普通产品问题用完整原问题执行一次检索后直接合成；比较/多模块问题由 observation 识别缺失维度并允许一次或多次受限 query rewrite。max steps、重复输入和无新增证据共同阻止死循环，ask/stream 使用同一充分性与 composer 契约。
- [x] Capability Plane v0.2：`packages/agent-core` 的 manifest/adapter/registry、默认拒绝授权、确认/幂等硬门禁、timeout/cancellation/output limit 和脱敏审计已接入产品检索；`product.skill.search_docs` 只能在固定 channel/principal grant 下调用 `product.mcp.search_docs`，其它能力不会因 discovery 自动进入 Planner。
- [x] Product MCP / Skill v1.0：`packages/product-qa-mcp` 提供 stdio 与 linked in-memory 两种 MCP transport、只读 `search_product_docs`、Skill Resource 和 Prompt；`skills/xxyy-product-support` 已按项目 Skill 结构落地。Web/API、CLI 和 Telegram 共用 `ToolRegistry → Skill capability → MCP capability → MCP protocol → Product RAG` 链路，公开 Chat API 契约不变。
- [x] Read-only EVM Transaction Analysis Core v0.1：独立纯 TypeScript 包离线分析 normalized transaction snapshot，确定性输出 success/reverted/pending/unknown、原生/ERC-20 资产变化、精确 gas fee、timeline、统一 Evidence/SkillResult、warnings 和 diagnostics；核心自身仍无网络/MCP/Agent 依赖，由内部 Chain MCP composition 调用。
- [x] Allowlisted Read-only EVM Data Adapter v0.1：独立包用启动时 chain/provider allowlist 调用四个标准只读 JSON-RPC，验证 chain/hash/block/index，限制 endpoint、redirect、header、batch、timeout、retry 和 response bytes，将多 provider 结果无损归一化为 snapshot 并保留 diagnostics/conflicts；没有生产 endpoint 或运行面接线。
- [x] EVM Execution Enrichment Core v0.1：独立离线包校验最多 250 节点/32 层的扁平 call trace，只有成功 receipt 且调用及祖先均成功时才应用 internal native transfer；严格解码 Solidity Error/Panic/custom selector 和带显式 pool/token metadata 的 Uniswap V2/V3 swap，缺失或畸形输入显式降级；核心自身无网络/MCP/Agent 依赖，由内部 Chain MCP composition 调用。
- [x] Allowlisted EVM Execution Data Adapter v0.1：独立未接线包用启动时 chain/provider/factory allowlist 获取固定 Geth callTracer，在精确 block 验证 pool/factory code、token、V3 fee 和 factory `getPair/getPool` 反查；限制 endpoint、method、calldata、timeout、响应、trace 和 pool 资源，保留脱敏 diagnostics 与 semantic provider conflicts；没有生产 provider 或运行面接线。
- [x] EVM Price Impact / Sandwich Detection Core v0.1：独立离线包校验最多 256 笔同区块同 pool swap、pre/post state、actor token delta、coverage 和 conflicts；用 bigint 复刻 V2 exact-input 与 V3 单 active-range rounding，输出 price impact、counterfactual victim loss 和 `confirmed | likely | unlikely | insufficient_data` 四态 verdict；核心自身无网络或 LLM 依赖，由内部 Chain MCP composition 调用。
- [x] Allowlisted MEV Observation Data Adapter v0.1：内部只读包从启动时冻结的 archive provider、chain 和 V2/V3 pool allowlist 验证 canonical block/order、精确 pool logs 与成功 receipts；用 parent/end state 锚定 V2 Sync 或 V3 单 active-range event replay，计算 transaction actor 的直接 token delta，并将多 provider block/swap/state/delta conflicts 投影到 price-impact/Sandwich core；具备进程内 QPS、并发、缓存、熔断、成本和脱敏 metrics 控制，已由 readiness-gated Chain MCP composition 调用，但没有真实 endpoint 或公开运行面接线。
- [x] EVM Chain Analysis Composition & Evaluation Harness v0.1：独立离线包把 normalized snapshot、可选 execution trace/metadata、已验证 MEV observation 和 price-impact/Sandwich core 组合为阶段化、fail-closed、可重放结果；定义 `chain.inspect_transaction` / `chain.detect_sandwich` 最小契约，提供 synthetic/reviewed corpus 分层、precision/recall/abstention/coverage/cost/determinism 报告及 regression/internal-readiness 门禁；当前只有合成回归样本，公开运行面仍不调用。
- [x] Generic Onchain MCP / Skills v0.3：`packages/chain-analysis-mcp` 的 MCP identity 已解耦为 `onchain-analysis`，提供 `get_transaction`、`inspect_transaction`、`detect_sandwich`、capabilities/Skill Resources 与 Prompts。内置网络与 XXYY 当前主站对齐为 Solana、Ethereum、BSC、Base、Robinhood Chain、Stable Chain，并支持对应 Explorer 链接；其它 EVM 可使用显式 `eip155:<chainId>`。`packages/solana-data-adapter` 只允许 `getTransaction` 并对账余额变化。两个通用 Skills 为 `onchain-transaction-inspector` 与 `evm-sandwich-detector`，默认 `allow_implicit_invocation: false`；`agent-core` 只为 `internal/(service|admin)` 或 `cli/admin` 创建六条精确 Skill/MCP grants。`pnpm onchain:mcp:dev` 在所有环境都要求同一 `ONCHAIN_RPC_CONFIG_JSON`，自动读取根目录 `.env`；运行时代码不内置 RPC，`.env.example` 提供六链公共便利配置。`pnpm chain:mcp:serve` 仍要求固定 manifest/readiness 指纹、未过期 `ready` attestation 和完整 Provider/budget lineage。
- [x] Reviewed Replay & Production Readiness Control Plane v0.1（single-owner profile）：独立离线包定义 content-addressed candidate、敏感信息拒绝、单 owner 复核、标签争议、revision/supersession、retention/tombstone 和 reviewed corpus 导出；同时定义 secret reference、跨实例预算 lease/settlement、脱敏审计、共享 circuit、SLO/告警、故障演练、安全/runbook evidence 与综合 `blocked | degraded | ready` evaluator。当前只有 contract-only 测试 fixture，没有真实 reviewed 主网样本、已部署 provider backend 或运行面接线，因此不会产生可发布的 ready 结论。
- [x] Mainnet Sampling Plan & Evidence Intake Control Plane v0.1：readiness 包定义 content-addressed source/legal/retention approval evidence、强制 V2/V3/route/outcome/data/conflict/reorg/special-token coverage 的 strata policy、确定性 quota slots、public-chain manifest 和 coverage gap evaluator；所有 fixture 都是 contract-only，不代表真实审批、采集或 reviewed evidence。
- [x] Sampling Manifest → Reviewed Replay Candidate Handoff v0.1：readiness 包确定性闭合 manifest 与初始 candidate 的 chain/transaction/block、dimension、source/scan/retention/time lineage，并用 `target_agnostic_no_exclusion` 显式保留 target deviation；control store 原子写 candidate、retention job、handoff 与审计。它不代表 replay/标签已审核，也不创建真实样本。
- [x] Single-owner Review Work Queue v0.1：每个 sampling handoff 在同一事务创建一个确定性 review slot；control store 以 reviewer RBAC、submitter 分离、`FOR UPDATE SKIP LOCKED`、lease/attempt fencing、失败重领/上限和原子 review/job/audit 完成保护 owner 复核。它没有启动真实 review worker，也不代表任何主网样本已审核。
- [x] Chain Analysis Governance Persistence & Shared Controls v0.1：独立 Postgres 包实现 authorization/revocation、sampling approval/policy/plan/manifest/handoff/run、candidate/review/decision/promotion/tombstone/export artifact 持久化、sampling/retention/review lease worker、append-only hash-chain audit、跨实例 budget reservation/settlement/reconciliation 和 circuit generation CAS。它只接受注入的数据库 client，未部署生产数据库、真实 grant/审批、主网 corpus、secret/metrics/provider backend，也未接入运行面。
- [x] Reproducible Readiness Evidence Ledger v0.1：control store 按 publisher/operator/attestor 角色持久化不可变 policy、operations evidence 和由 persisted governed corpus 确定性生成的 evaluation report；attestation 只能引用这些精确指纹并在事务内重新执行 evaluator，旧的 caller-supplied result writer 已移除。contract-only 验证结果仍为 `blocked`，不是生产运维证明或 `ready` 声明。
- [x] 静态资产：`GET /assets/*` 返回产品文档视频、图片等静态资源。
- [x] 服务保护：API 对 JSON 请求体大小、聊天 POST 请求频率和跨域来源做基础限制，配置项为 `API_MAX_BODY_BYTES`、`API_RATE_LIMIT_MAX`、`API_RATE_LIMIT_WINDOW_MS` 和 `API_CORS_ORIGIN`。
- [x] 本地开发命令：启动入口统一为 `pnpm run app:dev`、`pnpm run api:dev`、`pnpm run web:dev` 和 `pnpm run telegram:dev`；启动前更新可用 `app:dev` 的 `--sync`、`--full-sync` 或 `--ingest`，独立调度使用 `pnpm rag:refresh`。

## Explicit Boundaries

- [x] 不查询用户账户、订单、钱包余额或私有交易记录。
- [x] 不执行代开通、代取消、代修改等账户或订单动作。
- [x] 不提供投资建议、收益承诺或买卖建议。
- [x] Web/API/Telegram 收到交易哈希、交易链接、池子查询、链上取证和泛 MEV 分析请求时当前不处理；内部 Chain MCP 的存在不改变公开路由。
- [x] 产品知识库、embedding、chat LLM 或 vector store 配置缺失时，对外错误应清晰区分配置缺失和运行时不可用。

## Paused

- [ ] XXYY 链上公开交易分析入口仍暂停：通用 `onchain-analysis` MCP/Skills 可由独立 MCP host 在开发环境使用，但 XXYY Web/API/Telegram 不创建 chain grant、不注册 chain Tool。免费公共 RPC 不构成 production readiness；真实 Provider、reviewed 主网 corpus、SLO/security/runbook evidence 和 canonical `ready` attestation 尚未提供，XXYY 聊天中的交易、Explorer、链上取证和 MEV 问题继续进入边界/澄清回复。

## Planned Or Not Yet Complete

- [ ] 产品知识质量增强：继续补官方文档、X / Twitter 更新和回归样本，让 Product RAG 对新功能更新更稳。
- [ ] 更多渠道接入：在不改变客服 Agent 核心边界的前提下，继续接入更多入口。
- [ ] Telegram 知识覆盖增强：有界多消息 reply 线程已接入；后续仍需评估编辑/删除事件，在保持严格自动决策与管理员回复来源约束的前提下补齐变更撤回语义，不引入 `/approve`、`/reject` 逐条人工流程。
- [ ] 安全与隐私增强：继续完善数据保留、删除策略和生产告警；Product RAG 的 prompt injection 隔离与敏感信息脱敏已落地。
- [ ] 链上生产激活（Goal 20B）待 owner 执行：仓库已提供受控 request/plan、Ed25519 machine attestation、独立数据库 CLI、15 分钟 application window、receipt/8-grant lineage/audit verification、内部 MCP/Skills 与 readiness-gated composition root。真实受控人工账号、四个 service account、authority key/policy evidence、目标生产 Postgres、Provider、workers、主网 corpus 和 readiness attestation 仍未部署；完成前内部入口按设计不能启动，也不声明 production ready。
