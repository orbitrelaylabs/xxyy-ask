# Roadmap

本文档记录当前工程方向。当前功能状态见 [feature-status.md](feature-status.md)。

## Completed First Slice

- [x] LangGraph 客服 Runtime：`CustomerAgentRuntime` 已迁移到 LangGraph JS，统一处理产品问答、边界回复、工具降级和最终回答合成。
- [x] Product RAG：产品问题基于 Postgres + pgvector 检索产品文档和官方 X / Twitter 更新，再调用 OpenAI-compatible chat completion 生成带引用回答。
- [x] 官方 X / Twitter 同步：`pnpm run app:dev -- --sync` 做增量抓取和入库后启动服务，`pnpm run app:dev -- --full-sync` 做低频全量重建后启动服务。
- [x] 服务基础面：Web UI、health/deep health、chat/stream、static assets、请求体限制、基础限流和 CORS 配置已保留。
- [x] Telegram Bot：long polling 入口复用同一套客服 Agent runtime，并窄化采集群内当前管理员对用户问题的直接回复。
- [x] Knowledge Curator MVP：可信作者与角色有效期、Telegram 线程重建、确定性/可选 Agent 提取、脱敏、去重、冲突、质量评分、候选 revision/review/audit、管理 CLI 和发布门禁已具备。
- [x] Knowledge Curator Auto Mode：默认自动识别确定性路径未覆盖的复杂可信作者线程，模型缺失/单线程失败安全降级，支持三态策略、调用预算和脱敏运行统计。
- [x] Knowledge Governance Admin Console MVP：独立管理认证与 RBAC、候选上下文/冲突对比、可信作者、Telegram 导入、自动决策原因、PublicationJob 状态/租约和紧急恢复已具备；公开客服接口保持无鉴权只读。
- [x] Fully Automated Knowledge Governance：严格确定性策略自动批准或拒绝候选，批准项自动入队；对账 Worker 补建任务、最多重试三次并执行完整发布门禁，正常流程无需逐条人工审核。
- [x] 基础可信度建设：deterministic guard、planner route、tool registry、stream schema 校验、golden QA、基础 reranker extension point 已具备。

## Goal 21 Knowledge Curator Auto Mode

目标：让群聊知识清洗在不扩大作者权限的前提下自动使用 Curator Agent，同时把成本和 Provider 故障限制在单次导入内；最终发布决定由独立确定性自动策略负责，不交给模型。

- [x] `auto` 成为 CLI、管理 API 和后台默认模式；只选择包含已验证作者且未被确定性直接回复路径完整覆盖的复杂线程，模型未配置时保留确定性结果。
- [x] 提供 `auto | deterministic | required` 三态策略；原 `--agent` 映射为 required，新增统一 `--curation-mode`，required 遇到模型缺失、调用失败或超预算时 fail closed。
- [x] 单次导入最多尝试 20 个稳定排序的 Agent 线程；auto 模式按线程隔离失败并丢弃该线程的部分 proposal，不影响其他线程或确定性候选。
- [x] 只返回 eligible/attempted/succeeded/failed/跳过计数和 `timeout | provider_error | invalid_output | unknown` 分类，不返回 Provider 异常或消息原文。
- [x] 管理后台显示模式和脱敏运行统计；作者验证、PII 脱敏、产品边界、去重/冲突与 PublicationJob 发布门禁保持不变，后续严格策略取代逐条人工审核。
- [x] 使用直接、受控的 Curator 模型调用作为固定流水线叶节点；该流程不需要新增 LangGraph 图，也不向模型暴露批准或发布工具。

成功标准：无模型配置的默认导入仍可运行；auto 中一个 Agent 线程失败不会丢失确定性候选；required 不会静默降级；大导入不会产生无界模型调用；模型没有批准或发布能力。

## Goal 22 Scheduler-safe Knowledge Refresh

目标：把已有官网/X 刷新流水线变成可由外部 scheduler 安全调用的一次性 Job，不让 API 或 Telegram 进程承担抓取、迁移和知识写入。

- [x] 暴露正式 `pnpm rag:refresh`：默认执行官方 X 抓取与增量 `rag:sync:x`，`--full` 固定执行官网同步、媒体 enrichment、文档审计、全量 X 和 `rag:ingest`。
- [x] `--dry-run` 展示相同 allowlist 计划但不执行命令、不取写锁、不写回执；未知参数和任意 command 注入全部拒绝。
- [x] 每次实际运行生成稳定 run id，按步骤记录 label、固定 `pnpm` 参数、时间、退出码及 `nonzero_exit | command_error`，失败立即停止。
- [x] 回执只接受固定计划并丢弃未知字段，原子写入 `.rag/knowledge-refresh/latest.json` 和历史文件；不保存 stdout/stderr、异常原文、环境变量、endpoint 或 credential。
- [x] 同一工作区使用 mode `0600` 排他锁；活跃同机 PID 阻止重入，死进程锁可恢复，跨主机锁使用 6 小时保守阈值，release token 防止旧执行器删除新锁。
- [x] 明确外部 cron/systemd/CronJob 负责时间调度、single concurrency 和告警；本地锁不冒充分布式协调，命令不自动 commit/push 抓取结果。

成功标准：同一工作区的增量/全量 Job 不重叠；失败产生非零退出和脱敏 receipt；dry-run 零副作用；Telegram 只写治理记录而不写 pgvector；调度平台可以基于退出码和 receipt 新鲜度告警。详细设计见 [Scheduler-safe Knowledge Refresh](knowledge-refresh-operations.md)。

## Goal 23 Single-owner Governance Profile

目标：让链上分析生产准备流程符合当前只有一名真实 owner 的事实，不再把第二名真人作为硬依赖，同时保留服务账号隔离、自动验证、冷静期、不可变审计和 readiness fail-closed。

- [x] 来源、Provider、runbook 和 security approval 允许一个唯一 owner hash；不会把自动 verifier 描述为第二名人工 approver。
- [x] 每个 sampling handoff 只创建一个 owner review slot；candidate submitter 必须是不同的 service-account principal，一次 owner 批准或拒绝即可产生确定性治理结论。
- [x] Production provisioning 固定 `single_owner` profile、一个人工 owner、四个隔离 service account、八条 role binding 和八条 authorization。
- [x] 同一个 owner principal 可承载 planner/publisher/reviewer/attestor 四个独立 grant；角色证据、有效期、撤销和审计仍分别保存。
- [x] 精确 plan 必须等待至少 15 分钟，并由 plan 外的自动 authority verifier 校验 fingerprint、证据和策略；verifier 不能复用 owner 或 runtime principal。
- [x] 保持双 Provider、最小权限 Postgres、secret manager、故障演练、真实主网 corpus 和 canonical readiness evaluator 要求不变。

成功标准：单人维护者可以真实完成审批与样本复核，不需要伪造第二个人；自动执行身份不能替代 owner 判断；没有真实 Provider、evidence、数据库、演练和质量门禁时仍不能声明 `ready`。

## Goal 24 Fully Automated Knowledge Governance

目标：移除客服群知识的逐条人工审核前置步骤，在不降低身份、安全和发布门禁的条件下闭合采集、决策、排队、重试和发布。

- [x] `knowledge-automation-v1` 以确定性规则验证来源、提取方式、作者时效、最低 `0.8` 质量、重复/冲突、风险、Agent lineage 和 prompt injection。
- [x] 合格候选以固定系统主体自动批准并幂等创建 `PublicationJob`；不合格候选自动拒绝并保存稳定原因码。
- [x] Telegram Bot 实时采集 group/supergroup 中当前管理员的直接回复，管理员证据缓存 5 分钟，验证时间与消息时间最多相差 10 分钟。
- [x] `rag:knowledge:automation:work` 对账遗留 `pending/approved/failed`，自动补建任务、最多重试三次并执行有租约和 fencing 的发布队列。
- [x] `rag:refresh` 的增量、全量和 skip-scrape 固定计划都在最后运行自动治理 Worker。
- [x] 管理后台改为自动治理可观测与紧急恢复面；正常流程不依赖登录、逐条批准或发布申请。

成功标准：可信实时管理员回复可以在 scheduler 周期内自动进入正式知识库；任何身份不明、历史角色无法证明、低质量、重复、冲突、敏感或疑似注入内容都会自动拒绝；失败不会绕过门禁或无限重试。

## Paused / Out of Scope

- [ ] 链上 MCP / Skill 的生产与公开激活：内部 server/client、两个 Skills、精确 Capability factory 和 fail-closed stdio composition 已实现；真实 production readiness 通过前不能启动，Web/API/Telegram 仍不注册、不授权、不暴露。
- [ ] 公开交易分析、池子查询和链上取证入口：当前客服入口只做知识库产品回答，相关问题进入边界/澄清回复；离线 EVM transaction/execution/MEV cores 和未接线 RPC data adapters 不扩大运行面。
- [ ] 账户、订单、钱包余额、私有交易记录和投资建议：长期保持边界，不进入自动回答或自动操作链路。

## v0.2 RAG Trustworthiness

目标：让产品知识库回答更可信、可追溯，并能处理官方文档与 X / Twitter 更新之间的新旧冲突。

- [x] 知识新旧与冲突策略：official docs / X updates / admin verified 支持 freshness、effective time、current / historical / deprecated 和 `supersedes`；当前问题使用更新规则，历史问题保留旧版本回溯。
- [x] Citation grounding：模型回答返回前，本地逐条验证关键 claim 的数字、限制、支持状态和操作事实；无证据 claim 安全降级，引用只保留实际支撑回答的 chunk。
- [x] Chunk-aware context packing：按 chunk 公平分配预算，按问题相关度、完整句子、列表和限制条件选择内容，不再固定截取每个 chunk 的前缀。
- [x] Prompt injection 防护：知识正文和可展示元数据先脱敏并检测角色覆盖、忽略规则、提示词泄露和伪造工具调用；命中片段隔离后再以 JSON 字符串进入模型上下文。
- [x] Golden QA 扩充：48 个 deterministic 用例覆盖真实客服问法、当前/历史冲突、边界、限制条件和引用稳定性；另有注入、context packing、claim grounding 与流式泄漏单元测试。

成功标准：默认回答当前有效规则；显式日期问题使用对应时间窗口；冲突时不混合旧/新事实；关键事实有可验证引用；`pnpm check` 覆盖核心回归样本。

## v0.3 Bounded Agent Loop

目标：在保持客服边界的前提下，让 Agent 支持复杂产品问题的受控多步检索与证据观察。

- [x] 拆分工具职责：生产只注册 `search_product_docs`；检索证据由 state 累积，`answer_composer` 聚合去重 chunks 后调用 AnswerProvider，不再用“大工具”同时检索和回答。
- [x] 增加 observe 节点：`tool_executor` 后按问题维度覆盖、可验证引用、distinct evidence 和 latest new evidence 形成结构化 observation，决定继续规划、回答或安全停止。
- [x] 增加有界 loop：支持 `search -> observe -> planner -> search -> observe -> answer`；max steps、标准化后的重复工具输入和不同 query 无新增 chunk/引用都会停止。
- [x] Planner query rewrite policy：首次检索固定使用完整 original question；仅在 observation 报告缺失维度后允许 rewritten query，且必须保留产品范围与时间/版本限定并命中缺失维度。
- [x] Evidence sufficiency：普通问题有直接引用即可回答；比较/多模块问题要求各维度都有证据，不足时定向二次检索，停止后返回带引用的部分证据说明或澄清。

成功标准：普通问题仍保持单次检索且不调用 Planner；复杂比较 / 多模块问题可以针对缺失维度多步检索；loop 不会死循环、重复调用同一工具输入或因 query 不同而反复消费相同证据。

## v0.4 Evaluation & Feedback Loop

目标：把评测从基础 golden QA 扩展为持续回归、线上反馈沉淀和发布前验收体系。

- [x] 扩展 golden QA 到 30+ realistic support cases：当前 48 个用例覆盖产品 FAQ、how-to、套餐限制、链支持、历史更新、边界拒答和引用稳定性。
- [x] 加入 citation grounding eval、answer completeness 辅助 judge、Recall@K / Precision@K / MRR / nDCG / forbidden-hit 指标。
- [x] Provider-backed evaluation report：`pnpm rag:evaluate -- --provider` 输出分层报告，可显式启用独立 judge。
- [x] Feedback-to-eval backlog：负反馈和 failed eval 都能输出脱敏、待审核 JSONL。
- [x] Regression workflow：文档定义失败样本人工审核、去隐私、补来源后升级 golden QA 的流程。

成功标准：常规 CI 能跑便宜稳定的 deterministic eval；发布前可以跑 provider-backed eval；线上失败可以持续回流为测试资产。

## v0.5 Production Readiness, Safety & Observability

目标：让服务具备更强的生产安全、观测、配额、部署与运维能力。

- [x] Request tracing：通过 `requestId`、客服 runtime 传递和 API 结构化日志串联 route、intent、fallback/error、citation count 和耗时。
- [x] 可选 nested tracing：vendor-neutral tracer 覆盖 planner、tool、retrieval、rerank、grounding 和 answer，LangSmith adapter 默认关闭并强制脱敏与采样。
- [x] API abuse control：基础请求体限制、IP 限流、网关级配额要求和异常监控建议已落地。
- [x] Data privacy：日志、feedback、用户输入和 LLM prompt 的脱敏、保留和删除策略已记录。
- [x] Deployment docs：已补齐 production migration、backup、pgvector index tuning 和 multi-instance rate limit 方案。
- [x] Human handoff / ticketing readiness：未来工单或人工客服接入前的权限、审计和人工确认边界已定义。

成功标准：服务能安全暴露给真实用户；异常请求、错误回答和模型成本可观测；敏感数据有明确处理策略。

## v0.6 MCP / Skill Capability Plane And Product Integration

目标：在不扩大当前客服能力边界的前提下，建立与 LangGraph 解耦、默认拒绝、可审计的 MCP / Skill 执行契约，并先接入正式产品知识检索。

- [x] Transport-neutral manifest：能力显式声明 namespace id、精确 semver、source、risk、side effect、data scopes、确认/幂等要求和单次资源限制。
- [x] 独立 CapabilityRegistry：目录只暴露冻结后的 manifest，不暴露 adapter；注册校验来源一致性和重复 id，不会自动加入 Planner 工具列表。
- [x] Deny-by-default policy：grant 必须精确覆盖 capability/version/source、channel/principal、风险、副作用和全部数据范围；无 grant 时在业务输入解析前拒绝。
- [x] Bounded executor：使用 manifest 与全局限制中的更小值执行 timeout、上游 cancellation、input/output schema、JSON 边界和最大输出字节检查。
- [x] 副作用硬门禁：外部写入和金融交易必须声明并提供确认与 idempotency key，即使替换自定义 policy 也不能绕过；持久化去重和 exactly-once 留给未来 adapter / coordinator。
- [x] 脱敏审计：`agent.capability` 只记录固定 manifest/policy 元数据、值类型、字段/元素数量和输出大小，不记录字段名、payload 或 idempotency key 原文。
- [x] Product MCP server：`packages/product-qa-mcp` 通过 stdio 对外提供只读 `search_product_docs`、Skill Resource 和 Prompt；应用内使用 MCP SDK linked in-memory transport，不需要旁路子进程。
- [x] Project Skill：`skills/xxyy-product-support` 定义检索、引用、证据不足和客服边界工作流，并声明同名 MCP 依赖。
- [x] 显式 Agent bridge：生产 `search_product_docs` 依次执行 `product.skill.search_docs → product.mcp.search_docs`，两层都固定 source/version/data scope/channel/principal grant；Web/API、CLI、Telegram 共用该路径。
- [x] Planner 隔离：MCP discovery 和 Skill 元数据不会自动注册工具，Planner 仍只看到审查过的 `search_product_docs`。
- [x] 通用链上只读 MCP / Skills：MCP identity 已解耦为 `onchain-analysis`，提供 `get_transaction` / `inspect_transaction` / `detect_sandwich`；`onchain-transaction-inspector` 与 `evm-sandwich-detector` 默认不隐式调用。基础交易查询的内置网络与 XXYY 当前主站对齐为 Solana、Ethereum、BSC、Base、Robinhood Chain、Stable Chain，并继续支持配置其它 EVM chain id；XXYY bridge 仍只有内部/CLI admin grants，公开 Planner 不自动获得工具。
- [ ] Chain MCP 生产激活：提供真实 Provider、governed mainnet corpus、operations evidence 与 canonical `ready` attestation，验证实际部署后再启动内部进程；公开客服接入另行评审。

成功标准：产品检索实际穿过 MCP protocol 和 Skill/MCP 双层 Capability；未授权、版本漂移、来源/通道/数据范围不匹配和缺少确认/幂等的调用全部失败；超时、取消、超限与非 JSON 输出有稳定错误；当前客服边界和 Chat API 契约保持不变。详细设计见 [capability-plane.md](capability-plane.md)。

## v0.7 Read-only EVM Transaction Analysis Core

目标：先把交易事实计算实现为可测试、可重放、与 Agent/MCP/provider 解耦的领域包，为后续只读 adapter 和 Sandwich Skill 提供可信输入与证据。

- [x] 统一领域契约：`packages/shared` 提供 Zod `EvidenceItem`、`SkillFinding`、`SkillDiagnostic` 和 `SkillResult`，校验 id 唯一性和 finding/evidence/diagnostic 引用完整性。
- [x] Normalized EVM snapshot：校验 chain id、transaction/receipt/block、来源、source conflicts、address/hash/topics/bytes、canonical decimal 与 uint256 上限；金额和区块号不经过 JS number。
- [x] 确定性交易事实：区分 success/reverted/pending/unknown；只有成功 receipt 才应用原生 value，回滚仍精确计算 fee。
- [x] ERC-20 Transfer：按标准 topic 解码 from/to/raw amount 和 log index，识别 transfer/mint/burn，并聚合 signed raw asset delta。
- [x] Evidence 与 timeline：transaction、receipt、log、block 和 fee calculation 都映射到稳定 evidence ids 与 findings；输出结构化 timeline 和资产变化。
- [x] 不完整/冲突处理：缺 transaction 返回 `insufficient_data`；缺 receipt、hash/block/source 不一致、来源冲突及 removed/重复/畸形日志返回 `partial`、warnings 和 diagnostics，不静默补全事实。
- [x] 可重放 fixtures：覆盖成功原生+ERC-20、回滚、缺 receipt、双来源冲突+畸形日志和缺 transaction；fixtures 全部使用合成公开数据。
- [x] 运行面隔离：领域包不包含网络、LLM、LangGraph 或 MCP 依赖，未被 Agent/API/Telegram/CLI/CapabilityRegistry 引用，当前交易问题仍走边界回复。
- [x] 实现 allowlisted 只读 EVM data adapter 和 provider contract tests，将标准 RPC 数据转换为 normalized snapshot；adapter 没有真实 endpoint 配置且不注册 capability。
- [x] 增加有界 trace/internal transfer、Solidity revert 和 Uniswap V2/V3 pool swap decoder；LLM 不参与事实计算。
- [x] 独立 price-impact/Sandwich core 已在 v0.11 实现：缺局部三笔关键池状态、来源一致性或 actor 资产闭环时不能输出 confirmed；更宽 block coverage 不完整时整体状态必须降为 partial。

成功标准：相同 snapshot 重放得到相同 lossless 结果；成功/回滚的 value、ERC-20 和 fee 计算正确；缺失、冲突和畸形数据安全降级；完整 `pnpm check` 与现有客服边界回归通过。详细范围见 [transaction-analysis-core.md](transaction-analysis-core.md)。

## v0.8 Allowlisted Read-only EVM Data Adapter

目标：用独立、未接线的数据边界把受控标准 JSON-RPC 转换为 v0.7 normalized snapshot，同时不让 URL、密钥、任意 RPC 方法或网络失败进入 Agent/LLM 边界。

- [x] 启动时 allowlist：chain/provider 配置限制唯一 id、HTTPS endpoint、header 数量与保留 header；运行时只接受配置内的 chain/provider id，不接受 URL。
- [x] SSRF 与密钥边界：默认拒绝 HTTP，仅显式允许 loopback 开发节点；拒绝 URL credentials/fragment 和 redirect；provenance 只输出 origin，错误不暴露底层 cause。
- [x] 只读 RPC contract：只允许 transaction、receipt、chain id 和 block 四个方法；先验证 `eth_chainId`，配错链 fail closed。
- [x] 有界 transport：限制 batch、timeout、retry/backoff、provider 数量和 chunked response bytes；区分 abort、timeout、transport、HTTP、size、JSON 和 JSON-RPC 错误。
- [x] 无损归一化：canonical hex quantity 通过 `bigint` 转十进制，index 有界后才转 number；校验 uint256、receipt fee product、hash/block/index 关联。
- [x] 多 provider 协调：按配置顺序确定 canonical 数据，保留 missing/invalid/present 状态、关键字段 conflicts、来源观测时间和响应 SHA-256。
- [x] Adapter 状态：独立输出 `success | partial | insufficient_data` 和稳定 diagnostics；下游 core 仍独立生成领域 SkillResult。
- [x] 可重放 provider contract tests：使用注入 fetch 和合成 JSON-RPC fixtures 覆盖成功、缺失、冲突、错误链、非法 payload、重试、timeout、abort、响应超限和公开边界隔离。
- [ ] 配置真实生产 provider、共享 QPS/熔断/缓存/metrics，并用 canonical `ready` attestation 激活已实现的内部 Capability bridge；需单独安全目标和授权后才能启用。

成功标准：运行时不能注入 endpoint 或写 RPC；错误 chain fail closed，hash/block/index 关联不一致显式降级；相同 fixtures 生成字节一致、无精度损失且带 provenance 的 snapshot；provider 局部失败和冲突安全降级；现有 Agent/API/Telegram/CLI 行为不变。详细设计见 [evm-data-adapter.md](evm-data-adapter.md)。

## v0.9 EVM Execution Enrichment Core

目标：在不接入网络和客服运行面的前提下，为 normalized snapshot 增加可重放的执行 trace、revert 和首批 DEX 事件语义，作为后续价格影响与 Sandwich 检测的可信离线输入。

- [x] 有界扁平 trace：最多 250 节点、32 层，每个 input/output 最多 8 KiB；要求唯一 path、单 root、完整 parent 和统一 source，并校验 root 与 transaction 的 chain/hash/from/to/value/input。
- [x] Internal native transfer：排除已由 transaction core 处理的 root value；只有 receipt success、当前调用成功且全部祖先成功时，才对 call/create/create2/selfdestruct 应用转账；结果资产变化必须净和为零。
- [x] Revert 语义：严格解码 canonical `Error(string)` 和 `Panic(uint256)`；未知 custom error 只保留 selector，不猜 ABI 名称；empty/畸形数据分别建模，Evidence 不保存原始 trace output。
- [x] Allowlisted swap decoder：仅识别 Uniswap V2/V3 官方 `Swap` ABI；token0/token1 必须由显式、带来源的 pool metadata 提供，不从地址或模型推测。
- [x] Lossless pool delta：V2 保留四个 in/out uint256 并计算 pool delta；V3 解码 signed int256 delta、uint160 price、uint128 liquidity 和 int24 tick；只有一正一负时才给出 token direction。
- [x] Coverage 与降级：缺失/无效/不匹配 trace、receipt、metadata，removed/重复/畸形 log、来源缺口和超过 250 个 swap 时返回 `partial` 与稳定 diagnostics；缺 transaction 或 hash 不匹配返回 `insufficient_data`。
- [x] 可重放测试：四组 JSON fixtures 和 30 个包级测试覆盖成功、整体回滚、被捕获子调用回滚、祖先回滚、V2/V3、ABI 边界、资源上限、元数据缺失和 Evidence/结果不变量。
- [x] 运行面隔离：包不依赖网络、LLM、LangGraph、Capability、MCP 或 data adapter；没有 app/CLI/API/Telegram 导入。
- [x] 独立的受控 trace/pool metadata adapter 与交叉 provider replay 已在后续 v0.10 完成；本 core 仍只消费 normalized 输入。

成功标准：相同输入重放得到字节一致结果；回滚路径不产生已提交转账；Error/Panic/unknown selector 不混淆；swap 只有显式 token metadata 才产生 token 语义；所有引用和资产守恒由 schema 二次校验；完整 `pnpm check` 与公开客服边界回归通过。详细设计见 [evm-execution-enrichment.md](evm-execution-enrichment.md)。

## v0.10 Allowlisted EVM Execution Data Adapter

目标：在不扩大基础 snapshot RPC client 权限、也不接入客服运行面的前提下，从启动时 allowlisted provider 获取 normalized call trace，并在精确 block 验证 Uniswap V2/V3 pool metadata。

- [x] 专用 RPC contract：只允许 `eth_chainId`、固定 Geth `debug_traceTransaction/callTracer`、精确 block 的 `eth_getCode`，以及六个固定 pool/factory ABI selector；运行时不能注入 endpoint、tracer、method 或任意 calldata。
- [x] Endpoint 与资源边界：复用受控 provider header schema，强制 HTTPS 或显式 loopback HTTP、禁止 redirect，限制 timeout、retry、response bytes、batch、provider 和 pool 数量。
- [x] Trace 归一化：递归 call frame 用显式 stack 转成扁平 path；限制 250 节点、32 层和单 bytes 8 KiB，quantity 无损转十进制，provider error 只保留稳定脱敏 code。
- [x] Pool/factory 验证：读取非空 code、factory/token0/token1/V3 fee；要求非零排序 token、protocol-specific factory allowlist，并用 factory `getPair/getPool` 反查候选地址。
- [x] Provenance 与协调：结果保留观测时间、payload/code SHA-256、verified pool fact；最多四 provider 按配置顺序选 canonical 数据，semantic fingerprint 区分等价与真实 trace/metadata 冲突。
- [x] 状态与降级：独立输出 `success | partial | insufficient_data`、稳定 diagnostics 和 conflicts；先验证 chain 再调用高成本 trace/metadata，provider 局部失败不丢弃健康来源。
- [x] 可重放测试：两组 provider fixtures 和 31 个包级测试覆盖成功、冲突、错误链、transport、timeout、abort、响应超限、trace 资源、factory spoof、fee/protocol/pool 配额和 enrichment core 直连。
- [x] 运行面隔离：没有真实 endpoint、环境变量 loader、生产 composition root、Capability/MCP/Agent/API/CLI/Telegram 引用。
- [ ] 生产数据面：共享 QPS/并发预算、熔断、缓存、成本计量、metrics、告警、持久化审计和真实 provider 配置；需要后续独立安全目标。

成功标准：任意 RPC/debug/eth_call 无法越过专用 schema；错误链不触发 trace 或 metadata 请求；伪造 getter 不能绕过 factory 反查；等价 provider 不产生伪冲突、差异来源显式降级；输出无需转换即可进入 enrichment core；完整 `pnpm check` 与公开客服边界回归通过。详细设计见 [evm-execution-data-adapter.md](evm-execution-data-adapter.md)。

## v0.11 Price Impact / Sandwich Detection Core

目标：先用离线、可重放的 block 邻近交易、pool state 和资产变化事实生成价格影响与 Sandwich 四态 verdict，不接入生产 provider 或用户运行面。

- [x] 有界输入契约：最多 256 笔同区块同 pool observation，要求唯一 hash/index、显式 actor、directional swap、pre/post state、route/mode/token behavior、coverage、provenance 和 source conflicts。
- [x] Lossless V2：复刻官方 `997/1000` exact-input quote、uint112 reserve 与 uint256 中间边界，校验 event delta 后的 post-state 和 observed output。
- [x] Lossless V3 单 active-range：复刻 exact-input fee、amount0/amount1 sqrt-price 舍入与 output delta；expected price/output 必须匹配 event/post-state，跨 initialized tick 显式不支持。
- [x] Price impact：用约分分数输出 raw execution/spot price、expected output 和 signed ppm；不经过浮点、token decimals、USD 或 LLM。
- [x] Sandwich 四态：`confirmed` 要求相邻排序、同一非 victim actor、方向反转、state continuity、counterfactual victim loss、pool-token 正收益和精确 actor asset loop；缺 delta 只能 `likely`，完整证据反驳才可 `unlikely`，冲突/缺口为 `insufficient_data`。
- [x] 显式降级：multi-hop、aggregator、exact-output、fee-on-transfer、rebase、unknown token behavior、V3 tick crossing、quote/state mismatch 和 incomplete neighborhood 都不会进入高置信 verdict。
- [x] 可重放基线：两组完全合成 V2/V3 fixtures 和 22 个包级 deterministic tests 覆盖四态、counterfactual loss、actor delta 反例、source conflict、unsupported 语义、资源与 Evidence 不变量。
- [x] 运行面隔离：无网络、环境变量、LLM、Capability/MCP/Agent/API/CLI/Telegram 引用；公开客服边界不变。

成功标准：相同 replay 字节一致；官方 V2/V3 支持范围内 quote 与 post-state 精确一致；只有完整严格资产闭环才 confirmed；缺数据不输出假阴性 unlikely；结果 Evidence 引用闭合；完整 `pnpm check` 和客服边界回归通过。详细设计见 [evm-price-impact-sandwich.md](evm-price-impact-sandwich.md)。

## v0.12 Allowlisted MEV Observation Data Adapter

目标：在不注册 Capability 或改变客服运行面的前提下，为 v0.11 生成真实、受控、可审计的同区块 swap neighborhood、transaction-boundary pool state 和 actor token delta。

- [x] 定义独立于基础/trace clients 的最小标准 JSON-RPC allowlist，运行时不能注入 endpoint、method、tracer、calldata 或任意 block range；历史 state call 固定使用 EIP-1898 canonical block hash。
- [x] 获取并验证完整 block transaction order、成功 receipt、allowlisted pool Swap/Transfer logs 和 transaction actor；限制单 block transaction、pool log、relevant transaction 和 receipt log 数量。
- [x] V2 用 parent/end reserves 锚定 `Sync` / `Swap` 顺序重放；V3 获取 parent/end slot0、active liquidity、tick spacing、bounded initialized tick range，并用 Swap event 重放单 active-range transaction-boundary state。
- [x] 由 token0/token1 标准 Transfer 计算 transaction `from` 的直接 actor delta，并与 pool Swap delta 对账；不做多地址聚类或从 router/recipient 猜最终受益人。
- [x] 最多四个 provider 独立构建输入，交叉验证 canonical block/order、swap、pool state 与 actor delta fingerprint；冲突投影到下游 core 并 fail closed。
- [x] 增加 provider-local QPS/并发预算、熔断、immutable-call cache、成本/字节计量、脱敏 metrics 和 `archive: true` 启动门禁。
- [x] 建立两组完全合成、脱敏的 V2/V3 provider replay 和 35 个 contract/integration/determinism/security tests；保持无 Agent/MCP/API/CLI/Telegram 接线。
- [ ] 真实 provider 配置、跨实例共享配额、持久化审计、告警/SLA 和主网抽样人工标注不属于本 adapter v0.1，转入后续生产数据面与评测目标。

成功标准：任意 generic/write/debug RPC 或任意 calldata/block range 无法越过专用 schema；block/log/receipt/state 无法闭合或 provider 有分歧时不产生高置信结论；支持范围内的 V2/V3 replay 可直接、字节稳定地进入 v0.11 core；完整 `pnpm check` 与公开客服边界回归通过。详细设计见 [evm-mev-observation-data-adapter.md](evm-mev-observation-data-adapter.md)。

## v0.13 Chain Analysis Composition & Evaluation Harness

目标：在不配置生产 endpoint、不注册 Capability、也不改变客服运行面的前提下，把已有 transaction、execution 和 MEV 包组合成一个离线、可重放、可量化质量的完整分析 pipeline。

- [x] 定义 transport-neutral pipeline 输入/输出和阶段化 provenance，把 transaction snapshot、execution trace/metadata、MEV observation 与 price-impact/Sandwich result 串联，禁止阶段间隐式补值。
- [x] 对成功、partial、insufficient、provider conflict 和 unsupported semantics 建立稳定的组合状态矩阵与 diagnostic 映射。
- [x] 建立去隐私 replay corpus schema，把 synthetic fixture 与带 hashed reviewer/source provenance 的 reviewed 样本分层，并按 chain/protocol/router/data-state/tier 生成 coverage matrix；当前不伪造 reviewed 样本。
- [x] 六个合成 case 覆盖 V2 confirmed、V3 unlikely、provider conflict、unsupported aggregator、observation 缺失和 execution inspection；复杂路由、特殊代币、reorg 及更多 chain 的主网 reviewed coverage 留给 v0.14。
- [x] 输出 precision/recall、false-positive/false-negative、positive abstention、coverage、unsupported-rate、provider cost、expected-match 和 replay determinism 报告，并提供 synthetic regression 与 internal readiness 两层门禁。
- [x] 定义未来 `chain.inspect_transaction` / `chain.detect_sandwich` Capability adapter 的最小 public-chain 输入、结构化输出和拒绝策略，但不注册 manifest、不创建授权 grant、不接入 LangGraph/MCP/API/CLI/Telegram。
- [x] 验证 package graph 与运行面隔离，完整 `pnpm check` 和客服边界回归持续通过。

成功标准：相同输入 byte-deterministic；跨阶段锚点不闭合时不运行 MEV core；provider conflict 和 unsupported 不产生假阴性；合成样本只通过 regression gate、不能通过 internal readiness；报告和 corpus 有稳定指纹；完整 `pnpm check` 与公开客服边界回归通过。详细设计见 [evm-chain-analysis-harness.md](evm-chain-analysis-harness.md)。

## v0.14a Reviewed Replay & Production Readiness Control Plane

目标：不接入公开客服、不注册 Capability，先把公开主网样本治理和真实 provider 生产证据定义为可校验、fail-closed 的离线控制面。

- [x] 定义 content-addressed intake 和确定性敏感信息扫描；reviewable payload 强制 public-chain、无 credential、无 private data，并用 scanner/source payload hash 固定证据。
- [x] 实现 owner 复核、submitter/reviewer 分离、标签指纹、争议/拒绝/过期状态，以及 reviewer identity hash 和审核证据闭合；后续单 owner profile 将必需审核数收敛为一。
- [x] 实现 revision/supersession、retention/deletion tombstone、approved promotion 和带 promotion/approval lineage 的确定性 reviewed corpus export。
- [x] 定义只接受 `secretref:` 的 provider descriptor、budget policy/reservation/lease/settlement、脱敏持久审计 event、共享 circuit state/coordinator、SLO/告警、故障演练、安全和 incident runbook evidence contract。
- [x] 实现综合 readiness evaluator：治理 export 必须与 harness report 指纹一致，并使用不可由调用方替换的 `internalReadinessQualityGate`；provider/运维/安全证据缺失或过期为 `blocked`，实时 SLO/circuit/drill 失败为 `degraded`，全部满足才为 `ready`。
- [x] 增加 contract-only fixtures、16 个治理/预算/运维/readiness/隔离测试和静态运行面 import 检查；fixture 明确不是 reviewed 主网样本或生产证明。
- [x] 保持 Capability manifest/grant、MCP、LangGraph、API、CLI 和 Telegram 未接线，公开客服边界不变。

成功标准：治理 artifact 可重新验证内容指纹；缺少 owner review、submitter 自审、重复 reviewer、证据/标签不闭合、过期或被篡改的候选不能晋升；明文 endpoint/credential 不能进入契约；caller 不能弱化 quality gate；没有真实 reviewed corpus 时稳定 `blocked`，不伪造 `ready`。详细设计见 [evm-chain-analysis-readiness.md](evm-chain-analysis-readiness.md)。

## v0.14b1 Governance Persistence & Shared Provider Controls

目标：先把 v0.14a 的纯契约落到独立、可审计、跨实例一致的 Postgres backend，但不配置生产身份、provider、主网数据或运行面入口。

- [x] 新增独立 control-store package 和幂等 migration；artifact JSONB 重新执行原始 schema，候选 revision、review、decision、promotion、tombstone 和 export 写入重新运行 readiness 纯状态机。
- [x] 持久化 content-addressed authorization/revocation，按操作时间检查 submitter、independent reviewer、publisher、retention worker、readiness attestor 和 provider operator role；同一 candidate/reviewer 只能有一个不可变 review。
- [x] candidate 入库原子创建 retention job；多 worker 用 `FOR UPDATE SKIP LOCKED` 和 lease 领取，到期后生成 retention decision，并对已晋升 case 生成 tombstone。
- [x] 治理与 provider control 使用独立 append-only hash-chain audit stream；artifact/audit 同事务提交，event/head 使用 sequence 和 previous fingerprint 闭合。
- [x] 实现 Postgres active budget policy CAS、滚动窗口原子 reservation、全局并发、幂等 lease/settlement、usage reconciliation 和 expired-lease worker contract。
- [x] 实现不可变 circuit state history 与 current head；row lock、expected generation/state fingerprint 和 SQL CAS 双重 fencing，retry 到相同 next state 幂等。
- [x] 增加 14 个 contract/store/migration/isolation tests；backend 不读取环境变量、不自行创建连接、不访问 RPC/HTTP，也未被 Agent/API/CLI/Telegram/RAG 导入。

成功标准：非法角色或同一 reviewer 改写 fail closed；artifact 篡改不能通过重新解析；并发预算和 circuit 不退化为本地状态；backend unavailable 回滚；迁移可重复；没有真实主网 fixture、生产 grant 或伪造 readiness evidence。详细设计见 [evm-chain-analysis-control-store.md](evm-chain-analysis-control-store.md)。

## v0.14b2a Mainnet Sampling Plan & Evidence Intake Control Plane

目标：在不采集真实主网数据、不声称来源/法务审批已完成、也不接入运行面的前提下，把采样范围、quota、manifest 和 intake worker 定义为可审计、fail-closed 的离线契约与 Postgres 状态机。

- [x] 定义 content-addressed 来源/法律/保留审批 evidence contract，固定 owner hash、source kinds、public-only/无 credential/无 private data、有效期、保留策略与外部 evidence hash；仓库只验证结构，不伪造真实审批。
- [x] 定义分层 sampling policy，强制覆盖目标 chain、Uniswap V2/V3、direct/allowlisted/complex route、positive/negative/unsupported、complete/partial、provider conflict、reorg 和特殊 token。
- [x] 将每个 stratum quota 确定性展开为最多 500 个稳定 slot；policy、plan、slot 与 approval fingerprint 全部闭合并可重算。
- [x] 定义公开链 sample manifest：固定 chain/transaction/block、来源 payload hash、provider observation hash、scan、retention 和 slot 维度；provider conflict/reorg 有额外证据门禁，chain/transaction identity 跨 slot 去重。
- [x] 实现 coverage/gap evaluator：foreign/dimension mismatch、重复 slot/identity 显式拒绝；审批未生效、过期或 anchor 不一致时 `blocked`，窗口结束仍缺 quota 时 `incomplete`。
- [x] 扩展 Postgres control store：新增 sampling planner/worker RBAC、不可变 approval/policy/plan/manifest/run、确定性 job enqueue、`FOR UPDATE SKIP LOCKED` claim、lease fencing、fail/retry/complete、attempt limit 和 hash-chain audit。
- [x] contract-only 单元/隔离测试和一次性真实 PostgreSQL 验证通过；迁移幂等、append-only trigger、失败重试、3 个 quota job 与 complete coverage 已验证，临时数据库已删除。
- [x] 保持无 RPC/HTTP/provider、无真实主网样本/生产 grant/审批声明，且不被 Agent/Capability/MCP/API/CLI/Telegram 导入。

成功标准：同一 policy/plannedAt 展开相同 slots；审批过期、manifest 越界、重复 transaction、非法角色、过期 lease 和数据库失败全部 fail closed；测试 fixture 不能被描述为真实审批、主网 evidence 或 reviewed corpus。详细设计见 [evm-chain-analysis-sampling.md](evm-chain-analysis-sampling.md)。

## v0.14b2a2 Sampling Manifest → Reviewed Replay Candidate Handoff

目标：在不访问网络、不创建真实样本、不声称审核完成且不接入运行面的前提下，消除 persisted manifest 与 reviewed replay candidate 之间的人工拼接，建立无目标标签偏置、可重算、可审计的原子交接。

- [x] 定义 self-contained content-addressed handoff，内嵌精确 manifest/candidate、additional source lineage、target comparison、固定 selection policy 和完整 fingerprint/id 闭合。
- [x] 确定性验证 chain/transaction/block/index、protocol/route/data-state、snapshot source hash、payload re-scan、retention policy/deadline，以及 collection → scan → submission → expiry 时间链；complete 样本要求完整锚点。
- [x] sampling target 仅作 planning bucket；`matched` 与 `deviated` 均生成 `pending_review` candidate，固定 `target_agnostic_no_exclusion`，禁止借 target 筛除 false positive/false negative/`not_applicable`。
- [x] 将 retention policy id 从 approval 经 policy/plan 传播到 manifest 和 candidate，handoff 不允许调用方延长截止时间或替换策略。
- [x] 扩展 Postgres control store：`candidate_submitter` 授权下，同一事务写入 revision-1 candidate、唯一 retention job、manifest/candidate 一对一 handoff，以及 candidate/handoff 两条 hash-chain event。
- [x] 相同 handoff 幂等返回；同一 manifest/candidate 的冲突绑定、绕过 handoff 预先写入 candidate、非法 actor、来源/时间/锚点不闭合和数据库失败全部 fail closed。
- [x] contract-only unit/store/migration/isolation tests 与一次性真实 PostgreSQL 验证通过；偏差 handoff、唯一行数、幂等 retry 和 append-only trigger 已验证，临时数据库已删除。
- [x] 保持 readiness/control-store 不访问 RPC/HTTP/provider，不含真实主网 payload/审批/reviewer 结论，也不被 Agent/Capability/MCP/API/CLI/Telegram 导入。

成功标准：handoff 可由 persisted manifest 和显式 payload 输入逐字节重算；target mismatch 不能阻止入候选；candidate、retention、handoff 和 audit 要么全部提交要么全部回滚；contract-only fixture 不得被描述为主网 reviewed evidence。详细设计见 [evm-chain-analysis-sampling-handoff.md](evm-chain-analysis-sampling-handoff.md)。

## v0.14b2a3 Single-owner Review Work Queue

目标：在不部署真实 owner、不创建主网审核结论且不接入运行面的前提下，把 sampling handoff candidate 的 owner 复核变为可领取、可恢复、attempt-fenced 且可审计的 Postgres 工作队列。

- [x] 每个新 handoff candidate 在原有单事务内创建一个由 candidate id/fingerprint 与 slot ordinal 派生的 queued review job；相同 handoff 幂等重试不重复入队。
- [x] 新增 `independent_reviewer` claim store：操作时间 RBAC、submitter 排除、已有 review 排除、稳定排序和 `FOR UPDATE SKIP LOCKED`。
- [x] claim 增加 attempt 并生成不越过 candidate expiry 的 lease；failed attempt 保存 hashed reason 并释放，未耗尽任务可重领，达到默认三次上限后终止领取。
- [x] handoff review 强制携带 `jobId + attemptCount`；旧 generation、过期 lease、错误 reviewer/candidate fail closed。
- [x] 不可变 review、job success、`review_recorded` 与 `review_job_completed` 在同一事务提交；普通非 handoff candidate 保留既有直接 review 契约。
- [x] 补齐 schema/migration、unit/store/isolation tests 与文档；旧双槽一次性 PostgreSQL 验证已被单 owner profile 取代，真实激活前需重跑单槽验证。
- [x] 保持无 RPC/HTTP/provider、无真实 reviewer/主网 evidence，且不被 Agent/Capability/MCP/API/CLI/Telegram 导入。

成功标准：handoff、candidate、retention、一个 review slot 与原有 audit 原子提交；只有持有当前 attempt lease 且不同于 submitter 的 owner 能提交；并发、失败重领和旧执行者不能产生重复或越权 review；contract-only 通过不能被描述为真实复核完成。详细设计见 [evm-chain-analysis-review-work-queue.md](evm-chain-analysis-review-work-queue.md)。

## v0.14b2a4 Reproducible Readiness Evidence Ledger

目标：在不创建真实运维证明、不产生 `ready` 声明且不接入运行面的前提下，移除 caller-supplied readiness result 的信任缺口，使每个 attestation 都能从已持久化的精确输入重新生成。

- [x] 新增不可变、content-addressed readiness policy、production operations evidence 和 corpus evaluation report 表；report 必须引用 persisted governed corpus export。
- [x] 移除 governance store 的 raw `recordReadinessAttestation(result)` 路径；调用方不能再提交自算结果。
- [x] `evaluateCorpus()` 从 persisted export 确定性执行 harness evaluator；`evaluateReadiness()` 重读 export/report/evidence/policy、重新派生 report，并调用固定 `evaluateProductionReadiness()` 后原子写入 attestation。
- [x] attestation 保存 report/evidence/policy 三个精确外键；fresh schema 强制 `NOT NULL`，升级 schema 用 `NOT VALID` check 阻止新无 lineage row，legacy null lineage 读取也 fail closed。
- [x] 按 `governance_publisher`、`provider_operator`、`readiness_attestor` 分离角色；artifact/attestation 用 advisory lock、content fingerprint、lineage check 和 hash-chain audit 实现幂等与冲突拒绝。
- [x] 补齐 missing artifact、wrong lineage、legacy lineage、角色缺失、数据库失败、幂等、migration 和 runtime isolation tests。
- [x] 一次性真实 PostgreSQL 验证迁移二次执行、四类 artifact 单行幂等、getter 重读、七事件 hash chain、无 lineage insert 拒绝和 append-only update 拒绝；临时数据库与脚本已删除。
- [x] contract-only operations bundle 不被描述为真实运维证据；综合结果保持 `blocked / corpus_quality_gate_failed`，没有创建生产 grant、真实 corpus 或 `ready` attestation。

成功标准：任何 readiness 结论都只能由持久化 export、确定性 report、operations evidence 和 policy 的精确指纹重新计算；调用方不能绕过 evaluator 或替换 lineage；数据库/授权/指纹/lineage 失败全部回滚，正常但不达标的证据产生可审计 `blocked`。详细设计见 [evm-chain-analysis-readiness-evidence-ledger.md](evm-chain-analysis-readiness-evidence-ledger.md)。

## v0.14b2b Reviewed Mainnet Evidence & Provider Operations Validation（计划）

目标：在包外部署 v0.14b1/v0.14b2a backend，完成真实审批并形成能够被独立审计的主网 corpus 与生产数据面证据；仍不注册 Capability 或改变客服运行面。

当前执行单元是 **v0.14b2b1 / Goal 19：Production Environment & Governance Decision Gate**：

- [x] 审计现有 chain/protocol/adapter/source/role/drill/readiness 契约和 Product RAG 部署边界，确认仓库尚无链上生产 composition root、worker、Provider/secret 或身份映射。
- [x] 建立不含密钥的决策记录；草案项在确认前保持 `proposed`，真实来源/法律/保留审批、Provider、grant、evidence 和 readiness 继续保持 `unapproved/pending`。
- [x] 将最终决策映射到既有 canonical validators；不创建可携带 `TBD` 的平行配置 schema，避免草案被误当成真实 approval/provider/readiness artifact。
- [x] 产品负责人确认首批 Ethereum 主网 full-chain-analysis、双独立 Provider、私有控制面/独立数据库、`public_rpc` 与 `official_explorer_export`、90 天保留期、平台 service account/受控人工账号及四类责任 owner。

确认记录见 [Chain Analysis Production Environment & Governance Decision Gate](evm-chain-analysis-production-decision-gate.md)。该技术决策仍不等于真实审批、grant、Provider 配置、主网 evidence 或 `ready` 声明。

已完成执行单元 **v0.14b2b2a / Goal 20A：Production Provisioning Boundary**：

- [x] 固定 Ethereum chain 1、V2/V3、两类公开来源、90 天保留、已确认 owner baseline 和 `single_owner` content-addressed provisioning plan。
- [x] 一个 owner principal 承担四个人工角色，四个执行角色使用隔离 service account；八条 role binding、evidence、有效期和撤销分别记录。
- [x] 增加无默认实现的 automated authority verifier、至少 15 分钟确认窗口，以及 owner/runtime/verifier principal 分离。
- [x] 增加带 approval/role schedule advisory lock 的 active approval/grant preflight；预先撤销、并发漂移或数据库失败时回滚，原子写入 source approval、八个 grants、带规范化 FK lineage 的 immutable receipt 与治理 audit chain，并支持精确幂等。
- [x] 将既有 authorization revocation 纳入相同 role schedule lock；撤销保持 append-only、可审计且不能被重复 provisioning 静默恢复。
- [x] 从公共 governance store 移除未验证的 `recordAuthorization()` grant bootstrap；authorization artifact writer 仅在 package 内由 production provisioning 事务调用。
- [x] 从公共 sampling store 移除可绕过 external verifier 的 `recordSourceApproval()`；sampling policy/plan 只能从已持久化、已验证 approval 开始。
- [x] 保持无姓名/邮箱/证件/endpoint/credential/secret，无 Agent/Capability/MCP/API/CLI/Telegram 接线；contract-only verifier/hash 不被描述为真实授权。
- [x] 旧双人 profile 的一次性 PostgreSQL 验证已明确作废；当前确定性测试覆盖 1 approval / 8 grants / 1 receipt / 8 FK lineage，真实激活前需在目标数据库重跑。
- [x] 单人开发阶段不伪造第二名 approver/reviewer；自动 verifier 明确是机器补偿控制，不拥有人工审批语义。

仓库侧设计见 [Chain Analysis Production Approval & Identity Provisioning](evm-chain-analysis-production-provisioning.md)。

待执行发布门禁 **v0.14b2b2b / Goal 20B：Production Activation Gate**：

状态：`pending_owner_execution`。第二名真人不再是前置条件；当前仍缺少真实生产基础设施、Provider、evidence、workers、主网 corpus 和演练，因此继续阻止已实现内部 Capability bridge 的实际启动和任何 production-ready 声明。

后续执行顺序固定为：

1. **Goal 20B-1 / Real Production Provisioning**：仓库侧受控 request/plan、Ed25519 attestation、独立数据库 CLI、首次 apply 时间窗口、receipt/lineage/audit verification 和一次性 PostgreSQL 验证已完成；真实受控 owner/service identities、authority key/policy evidence、目标生产数据库和 production receipt 仍待 owner 执行。
2. **Goal 20B-2 / Provider & Worker Data Plane**：仓库侧已增加双独立 Provider manifest、mounted secret resolver、三个 adapter 的私有 composition root、共享 budget/circuit、bounded cache、failover/持久审计/脱敏 metrics-alert 契约、四类 worker handler runtime、bootstrap/probe/retention/reconciliation CLI，并通过一次性空库 PostgreSQL 原子结算/审计验证；真实两家 Provider、credential、scheduler/collector/on-call route 和 sampling/review handler 仍待生产部署与验证。
3. **Goal 20B-3 / Reviewed Mainnet Corpus**：按 plan 采集 Ethereum 主网公开样本，完成 manifest → candidate handoff，由唯一 owner 从单槽队列重放并批准/拒绝，形成真实 governed corpus。
4. **Goal 20B-4 / Production Readiness Gate**：执行故障演练，形成 SLO/security/runbook evidence，在固定 corpus 上收敛误报、漏报与 abstention，并由 evidence ledger 重算真实 readiness attestation；成功标准只能是 canonical evaluator 返回 `ready`。
5. **Goal 24 / Generic Onchain MCP-Skill Capability**：仓库实现已提前完成并解耦产品命名：`chain.get_transaction`、`chain.inspect_transaction` 与 `chain.detect_sandwich` 已封装为通用只读 MCP/Skills，具备显式授权、超时、成本、审计与结构化错误。基础开发 MCP 已覆盖 XXYY 当前六条产品链；XXYY 深度生产 composition 仍必须等 20B-4 返回未过期 `ready` 并通过 readiness/manifest lineage 门禁，免费公共 RPC 或现有 Product MCP/Skill 都不构成链上 readiness 证据。
6. **Goal 25 / Agent Multi-capability Orchestration**：Product RAG 继续处理产品知识，链上意图路由到已授权能力；LangGraph 负责有界工具循环、证据聚合、拒答和最终回答，输出来源、置信度、完整性与 unsupported reason。
7. **Goal 26 / Product Entry & Continuous Operations**：在独立安全/产品评审后逐步开放 Web/Telegram 链上入口，并并行推进 Telegram 教学命令、知识质量、更多渠道、删除/保留、隐私和生产告警。

依赖顺序不可跳过：`20B-1 → 20B-2 → 20B-3 → 20B-4 → 24 → 25 → 26`。仓库代码、fixture、空数据库集成测试或 Markdown 状态都不能替代真实生产证据。

- [ ] owner 正式批准已选 Ethereum 主网、来源、法律条件和 90 天数据保留策略，将真实审批 evidence 与八条 role binding 安全写入控制面；contract-only artifact 不等于审批。
- [ ] 提供真实 automated authority verifier，在确认窗口后核验精确 plan；在已迁移的生产 Postgres 中持久化并核对 receipt、八条 grant lineage 和 audit chain。
- [ ] 部署最小权限 Postgres、一个受控 owner principal、四个隔离 service-account principal、对应 grant，以及 sampling/review/retention/reconciliation workers。
- [ ] 按 plan 采集、通过 handoff 入候选，并由 owner 从单槽 work queue 领取、重放和复核公开主网样本；manifest、handoff、queued slot 或 contract-only fixture 不能直接当作 reviewed evidence。
- [ ] 实现 secret manager 配置解析、metrics/alerting 和 provider failover；配置数据库最小权限、加密、备份、保留策略，并验证 budget/circuit/audit backend unavailable 时 fail closed。
- [ ] 执行 timeout、rate limit、provider conflict、reorg、审计/预算/circuit backend unavailable 等演练，提交新鲜 SLO、告警、security 和 runbook evidence。
- [ ] 在固定 governed corpus 上持续运行 harness，逐条审阅 false positive、false negative 和 positive abstention，实际达到并锁定 internal-readiness gate。
- [ ] 通过 evidence ledger 持久化精确 policy/evidence/report、重新计算真实 readiness attestation 并输出独立审计记录；只有 evaluator 为 `ready` 才能向已实现的内部 Capability Adapter & Authorization Bridge 提供生产启动配置。

只有 Goal 20B 和后续 v0.14b2b internal-readiness gate 实际通过，且真实 provider 安全与运维评审完成后，已实现的内部 Capability Adapter & Authorization Bridge 才能生产激活；公开客服接入仍需另行决策。

## GitHub Planning Convention

- Roadmap 记录长期方向和阶段目标。
- Epic issue 记录一个大方向的目标、范围和任务列表。
- 普通 issue 记录可以由一个 PR 完成的具体任务。
- 每个 PR 应尽量关联一个具体 issue；大功能通过 Epic issue 追踪整体进度。
