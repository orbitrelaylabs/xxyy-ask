# Feature Status

本文档记录当前功能状态。项目当前定位是 XXYY 产品客服 Agent：用产品文档和官方 X / Twitter 更新回答产品支持问题，并对用户明确提供的公开交易引用执行只读基础查询与证据受控的 EVM 深度分析。

## Current First Slice

- [x] LangGraph 客服 Runtime：`packages/agent-core` 使用 LangGraph JS 组织策略保护、planner、检索工具、证据观察和回答合成。产品问答注册 `search_product_docs`；配置链上 RPC 时，Web/Telegram 另注册确定性的 `get_public_transaction`。账户、订单、钱包余额、私有交易记录、深度链上分析和投资建议仍进入边界或澄清回复。
- [x] Product RAG：产品问题会检索 Postgres + pgvector 中的知识库 chunks，并通过 OpenAI-compatible chat completion 生成带引用回答。正式来源限定为 `docs.xxyy.io` 官方文档、`x.com/useXXYYio` 官方更新，以及通过严格自动治理发布的客服群知识。
- [x] Scheduler-safe 知识刷新：`pnpm rag:refresh` 提供外部 scheduler 可调用的 X 增量 Job，`--full` 执行官网/媒体/X 全量重建，最后统一对账知识候选、补建/重试发布任务并执行队列；`--dry-run` 验证固定计划。实际运行有同工作区锁、stale recovery、步骤级脱敏回执和失败退出。
- [x] HTTP 服务面：保留 `GET /`、`GET /health`、`GET /health/deep`、`GET /api/knowledge-refresh-status`、`POST /api/chat`、`POST /api/chat/stream` 和 `GET /assets/*`。
- [x] Web UI：`GET /` 提供静态聊天界面，支持普通回答、流式回答、引用展示、产品知识库附件，以及基于调度器脱敏回执的自动更新状态徽标。
- [x] 客服运营闭环：Web 会话和有界多轮上下文持久化到 PostgreSQL；用户显式转人工后创建幂等工单，`/admin` 可查看脱敏会话、指派、回复、解决/关闭并观察知识缺口，Web 会自动接收人工回复。
- [x] Admin 回答质量中心：`/admin` 可创建快速确定性、正式 pgvector/Embedding 召回和完整 Agent/Judge 三类白名单评测任务，查看通过率、Recall、Precision、MRR、nDCG、错误知识命中、延迟、Token、Judge 分数、门禁原因和脱敏失败案例。任务由独立本地 `quality-worker` 从 PostgreSQL 租约队列执行；`viewer/publisher/admin` 分别承担查看、运行和基线批准权限，API 不执行任意命令。
- [x] Versioned Agent SDK/API：`@xxyy/agent-sdk` 封装问答、SSE、反馈和转人工；`/api/v1` 使用独立 Bearer Key 并提供 OpenAPI 3.1，未配置 Key 时失败关闭。
- [x] Telegram Bot：`pnpm run telegram:dev` 通过 Telegram Bot API long polling 接收消息；私聊文本直接回答。群聊默认只读，不发送命令回复、客服答案、媒体或异常。群文本实时幂等写入本地 PostgreSQL 收件箱，不在 Update 内创建候选；原始消息默认保留 30 天。Web 不采集客服对话用于知识演进。
- [x] Telegram 群注册表与收件箱：Bot 订阅 `my_chat_member` 并登记群元数据，同时保存 Telegram 已交付的群文本、Reply 关系、作者 ID、编辑和处理状态。`GET /admin` 的“Telegram 群聊”页面显示待整理数量、最近消息和一键整理入口。
- [x] Knowledge Curator Auto Mode：后台整理本地 Telegram 收件箱时，会合并连续发言、识别 Reply 与紧邻管理员普通回答，并按角色有效期验证作者、脱敏、分类、标准化、去重、检查正式 chunk 冲突并生成质量/风险信息。
- [x] 候选 AI 优化建议：Pending 候选可由 reviewer 按需请求证据受控的规范问题、答案、标题、模块、缺失信息和风险建议；服务端拒绝新增无证据数字或 URL，Admin 展示原文/建议对比。建议不自动写库、审批或发布，应用后仍需保存不可变 Revision。
- [x] 分来源知识治理：官方同步和遗留自动来源继续由 `knowledge-automation-v1` 执行严格自动决策；本地 Telegram 收件箱候选固定带 `manual_review_required`，自动对账不会批准或拒绝，必须由后台管理员审核。批准后自动创建发布任务，模型不能决定发布。
- [x] 知识治理管理面：`GET /admin` 使用 PostgreSQL 管理员账号、scrypt 密码哈希和可撤销 Session，并提供 `viewer/reviewer/publisher/admin` RBAC、账号启停/改密/角色管理、本人验证原密码改密、其他会话撤销和本人角色/状态误操作保护，以及候选上下文、自动原因、重复/冲突对比、revision/history、可信作者、Telegram 导入和发布状态；人工操作只保留为有审计的紧急恢复面，公开客服 API 仍不暴露知识写入能力。
- [x] 可靠自动发布任务：自动治理幂等创建 `PublicationJob`；`pnpm rag:knowledge:automation:work` 对账遗留状态、补建任务、最多重试三次并用租约执行现有发布门禁，最终候选状态与 pgvector ingest 在同一数据库事务完成。
- [x] 新旧规则策略：当前问题默认排除被 `supersedes` 替代的知识，历史追溯问题仍可检索旧版本。
- [x] RAG Trustworthiness v0.2：知识正文和标题/章节元数据先执行凭证脱敏与 prompt injection 隔离；回答上下文按 chunk、完整句子和限制条件打包；模型回答在返回前执行本地 claim grounding，未被安全证据支持的数字、限制、支持状态或操作事实会降级为确定性回答。流式路径先完成同一校验，避免无证据 token 已发送后无法撤回。
- [x] Bounded Agent Loop v0.3：普通产品问题用完整原问题执行一次检索后直接合成；比较/多模块问题由 observation 识别缺失维度并允许一次或多次受限 query rewrite。max steps、重复输入和无新增证据共同阻止死循环，ask/stream 使用同一充分性与 composer 契约。
- [x] Capability Plane v0.2：`packages/agent-core` 的 manifest/adapter/registry、默认拒绝授权、确认/幂等硬门禁、timeout/cancellation/output limit 和脱敏审计已接入产品检索；`product.skill.search_docs` 只能在固定 channel/principal grant 下调用 `product.mcp.search_docs`，其它能力不会因 discovery 自动进入 Planner。
- [x] Product MCP / Skill v1.0：`packages/product-qa-mcp` 提供 stdio 与 linked in-memory 两种 MCP transport、只读 `search_product_docs`、Skill Resource 和 Prompt；`skills/xxyy-product-support` 已按项目 Skill 结构落地。Web/API、CLI 和 Telegram 共用 `ToolRegistry → Skill capability → MCP capability → MCP protocol → Product RAG` 链路，公开 Chat API 契约不变。
- [x] Read-only EVM Transaction Analysis Core v0.1：独立纯 TypeScript 包离线分析 normalized transaction snapshot，确定性输出 success/reverted/pending/unknown、原生/ERC-20 资产变化、精确 gas fee、timeline、统一 Evidence/SkillResult、warnings 和 diagnostics；核心自身仍无网络/MCP/Agent 依赖，由内部 Chain MCP composition 调用。
- [x] Allowlisted Read-only EVM Data Adapter v0.1：独立包用启动时 chain/provider allowlist 调用四个标准只读 JSON-RPC，验证 chain/hash/block/index，限制 endpoint、redirect、header、batch、timeout、retry 和 response bytes，将多 provider 结果无损归一化为 snapshot 并保留 diagnostics/conflicts；三项公开 Chain 能力复用该基础交易快照，仓库仍不内置生产 endpoint。
- [x] EVM Execution Enrichment Core v0.1：独立离线包校验最多 250 节点/32 层的扁平 call trace，只有成功 receipt 且调用及祖先均成功时才应用 internal native transfer；严格解码 Solidity Error/Panic/custom selector 和带显式 pool/token metadata 的 Uniswap V2/V3 swap；规范识别 Uniswap V4 `PoolManager` Swap 与 Bags `TokensBought` / `TokensSold` 内盘事件，但缺 PoolKey/Hook 或版本化发射台元数据时明确降级而不猜方向；核心自身无网络/MCP/Agent 依赖。
- [x] Allowlisted EVM Execution Data Adapter v0.1：使用启动时 chain/provider/factory allowlist 获取固定 Geth callTracer，或从显式 HTTPS Blockscout v2 source 获取有界 raw trace；在精确 block 验证 pool/factory code、token、V3 fee 和 factory `getPair/getPool` 反查。Explorer trace 强制标为部分证据；限制 endpoint、redirect、method、calldata、timeout、响应、trace 和 pool 资源，并保留脱敏 diagnostics/conflicts。
- [x] EVM Price Impact / Sandwich Detection Core v0.1：独立离线包校验最多 256 笔同区块同 pool swap、pre/post state、actor token delta、coverage 和 conflicts；用 bigint 复刻 V2 exact-input 与 V3 单 active-range rounding，输出 price impact、counterfactual victim loss 和 `confirmed | likely | unlikely | insufficient_data` 四态 verdict；核心自身无网络或 LLM 依赖，由内部 Chain MCP composition 调用。
- [x] Allowlisted MEV Observation Data Adapter v0.1：内部只读包从启动时冻结的 archive provider、chain 和 V2/V3 pool allowlist 验证 canonical block/order、精确 pool logs 与成功 receipts；用 parent/end state 锚定 V2 Sync 或 V3 单 active-range event replay，计算 transaction actor 的直接 token delta，并将多 provider block/swap/state/delta conflicts 投影到 price-impact/Sandwich core；具备进程内 QPS、并发、缓存、熔断、成本和脱敏 metrics 控制，已由 readiness-gated Chain MCP composition 调用，但没有真实 endpoint 或公开运行面接线。
- [x] EVM Chain Analysis Composition & Evaluation Harness v0.1：独立离线包把 normalized snapshot、可选 execution trace/metadata、已验证 MEV observation 和 price-impact/Sandwich core 组合为阶段化、fail-closed、可重放结果；定义 `chain.inspect_transaction` / `chain.detect_sandwich` 最小契约，提供 synthetic/reviewed corpus 分层、precision/recall/abstention/coverage/cost/determinism 报告及 regression/internal-readiness 门禁；当前只有合成回归样本，公开运行面仍不调用。
- [x] Generic Onchain MCP / Skills v0.3：`packages/chain-analysis-mcp` 的 MCP identity 已解耦为 `onchain-analysis`，提供 `get_transaction`、`inspect_transaction`、`detect_sandwich`、capabilities/Skill Resources 与 Prompts。内置网络与 XXYY 当前主站对齐为 Solana、Ethereum、BSC、Base、Robinhood Chain、Stable Chain，并支持对应 Explorer 链接；其它 EVM 可使用显式 `eip155:<chainId>`。`packages/solana-data-adapter` 只允许 `getTransaction` 并对账余额变化。公开客服为固定 `web/anonymous` 与 `telegram/service` 创建三项工具的六条精确 grant。`pnpm onchain:mcp:dev` 在所有环境都要求同一 `ONCHAIN_RPC_CONFIG_JSON`；运行时代码不内置 RPC，基础快照、execution 与 MEV observation 均只能来自显式启动配置。
- [x] Public Read-only Chain Analysis v0.2：Web/API/Telegram 对支持的 Explorer URL 或显式 network + transaction id 使用确定性路由，执行 `ToolRegistry → chain.skill.* → chain.mcp.* → linked MCP transport → allowlisted RPC`。基础查询一次最多三笔并去重；inspection/Sandwich 一次只处理一笔 EVM 交易。Robinhood 组合官方公共 RPC 与 Blockscout trace，调用追踪输出有界内部转账、回滚和 Swap 证据，并始终把 Explorer 单源标为 `partial`；Sandwich 只对服务端 allowlisted pool 输出四态 verdict。无答案不返回来源，`partial`/`insufficient_data` 明确降级。
- [x] Internal Onchain CLI Integration v0.2：`pnpm onchain:query` 固定为 `cli/admin` 调用方，在同一进程执行 `ToolRegistry → chain.skill.* → chain.mcp.* → linked MCP transport`，支持显式 transaction、inspect 和 sandwich 子命令并复用启动时 RPC allowlist；该开发入口在 `NODE_ENV=production` 下失败关闭。`pnpm onchain:query:production` 复用相同 Tool/Skill grants，通过通用 MCP transport client 与子进程 stdio 连接 readiness-gated production composition；只传生产配置 allowlist，不加载 `.env`，不回退公共 RPC。这两个内部 CLI 入口不会额外创建 Web/API/Telegram grant。
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
- [x] Web/API/Telegram 只处理用户明确提供的公开交易引用；支持单笔 EVM 调用追踪与 allowlisted pool Sandwich/MEV，仍不处理任意地址历史、地址归属、任意池发现或无具体交易的泛链上取证。
- [x] 产品知识库、embedding、chat LLM 或 vector store 配置缺失时，对外错误应清晰区分配置缺失和运行时不可用。

## Paused

- [ ] XXYY 深度链上生产数据面仍未就绪：`inspect_transaction` 与 `detect_sandwich` 已向 Web/API/Telegram 精确授权，但免费公共 RPC 默认没有可靠 trace/archive/pool evidence，不构成 production readiness；真实 Provider、reviewed 主网 corpus、SLO/security/runbook evidence 和 canonical `ready` attestation 尚未提供。

## Planned Or Not Yet Complete

- [ ] 产品知识质量增强：继续补官方文档、X / Twitter 更新和回归样本，让 Product RAG 对新功能更新更稳。
- [ ] 更多渠道接入：在不改变客服 Agent 核心边界的前提下，继续接入更多入口。
- [x] Telegram 来源变更撤回：编辑事件自动撤回旧候选并重新评估，已发布来源通过持久 tombstone 退出统计和检索；普通群消息删除由管理员在工作台确认群 ID / 消息 ID 后撤回，定期导出可作为删除发现与对账来源。
- [ ] 安全与隐私增强：继续完善数据保留、删除策略和生产告警；Product RAG 的 prompt injection 隔离与敏感信息脱敏已落地。
- [ ] 链上生产激活（Goal 20B）待 owner 执行：仓库已提供受控 request/plan、Ed25519 machine attestation、独立数据库 CLI、15 分钟 application window、receipt/8-grant lineage/audit verification、内部 MCP/Skills 与 readiness-gated composition root。真实受控人工账号、四个 service account、authority key/policy evidence、目标生产 Postgres、Provider、workers、主网 corpus 和 readiness attestation 仍未部署；完成前内部入口按设计不能启动，也不声明 production ready。
