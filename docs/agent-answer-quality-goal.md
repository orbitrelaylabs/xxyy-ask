# Agent 回答质量优化 Goal

## Goal

把 XXYY 客服 Agent 从“规则分类后检索相关片段并生成有引用回答”升级为“能够理解问题主体和范围、生成受约束检索计划、验证证据完整性并持续评测”的生产级回答系统。

优化必须覆盖 Web、Telegram、CLI 和 `@xxyy/agent-sdk` 共用的 Agent Runtime，同时保持现有产品知识、公开链上只读、隐私、密钥、Capability Registry 和知识发布边界。

本 Goal 的最终结果不是让模型回答得更长，而是让系统稳定做到：

- 该直接回答时快速、准确地回答。
- 该补充上下文时生成可独立检索的问题。
- 该澄清时只询问一个最有价值的问题。
- 宽泛问题先拆解，再按模块覆盖，而不是把偶然召回的推文整理成完整答案。
- 当前事实优先使用当前、权威、范围匹配的证据。
- 证据只覆盖部分条件时明确给出部分答案和缺口。
- 每个重要结论都能映射到实际检索证据。
- 低质量回答进入评测和知识治理队列，但不能直接修改正式知识库。

## 状态

`completed_local`

Phase 0–6 已在用户指定的本地部署范围完成，包括版本化问题理解与 Query Plan、Evidence
Report、Telegram 有界上下文、质量治理、Shadow、10% 本地 Web 灰度、回滚演练和扩量到
optimized 100%。本状态不表示外部生产环境、真实付费 Provider 或真实 Telegram 群流量已经
灰度；如果未来扩大到外部部署，必须重新审批预算并完成独立观察窗口。

本文是 [完整 Agent 客服系统 Goal](agent-customer-service-goal.md) 的回答质量专项 Goal。客服系统 Goal 负责会话、工单、管理面、SDK 和知识治理基础设施；本文负责问题理解、检索计划、证据判断、答案生成和质量闭环。

## 当前基线与已确认问题

当前运行链路为：

```text
用户消息
  → 确定性意图分类和边界检查
  → LangGraph Planner
  → Product/Chain Tool
  → pgvector 混合检索与 metadata rerank
  → 证据观察
  → Answer Provider
  → claim grounding
  → 渠道回复
```

现有系统已经具备规则意图分类、Product MCP、向量与词法混合检索、metadata rerank、当前/历史状态、引用、claim grounding、Golden QA 和低证据信号，但仍存在以下质量缺口：

1. `product_qa` 与 `how_to` 首轮使用确定性计划，通常绕过 LLM Planner。
2. 第一次 `search_product_docs` 强制使用原始问题，不能采用安全的规范化 Query。
3. “功能”等宽泛关键词会直接触发产品检索，无法稳定区分产品能力和 Agent 能力。
4. “支持哪些功能”被当作单一问题；存在一条 citation 就可能被判定为证据充分。
5. 列表密集、包含“支持/功能”的 X 更新可能压过权威功能目录或详细官网文档。
6. Telegram 请求包含 `sessionId`，但没有将持久会话历史或 reply chain 转为 `ChatRequest.history`。
7. 现有二次 Query 改写只在第一次证据不足后触发，而宽泛问题容易过早停止。
8. grounding 可以约束答案不脱离片段，但不能证明召回证据与用户真实意图相关或足够完整。
9. 当前评测对精确事实和引用较强，对歧义处理、功能总览覆盖、来源多样性和多轮改写覆盖不足。

基线案例：

```text
用户：支持哪些功能

当前风险：
  → 因“功能”被分类为 product_qa
  → 使用“支持哪些功能”直接检索
  → 命中两条列表密集的 X 更新
  → 单一问题有 citation，被判定为 sufficient
  → 将局部更新整理成类似完整功能总览的回答
```

## 非目标

- 不通过自动训练或在线修改模型权重实现“自学习”。
- 不允许模型或 Telegram Bot 直接写入 pgvector。
- 不开放用户账户、订单、余额、私有交易或任意 RPC。
- 不改变 Chain MCP 的 allowlist、Provider 和 readiness 门禁。
- 不把外部网页、普通群成员发言或未经治理的内容直接纳入正式知识。
- 不仅靠更换模型、增加 Top K 或扩大 Prompt 掩盖分类和检索缺陷。
- 不在没有测量证据前迁移到 Elasticsearch、知识图谱或新的向量数据库。

## 目标架构

```text
Web / Telegram / CLI / SDK
              |
              v
        Request Context
  渠道、用户、会话、reply chain
              |
              v
      Deterministic Pre-Guard
  私有数据、投资建议、危险输入、链上边界
              |
              v
       Question Understanding
  intent / subject / entities / time / ambiguity
              |
      +-------+--------+
      |                |
      v                v
 Clarification      Query Plan
                standalone question
                queries / facets / source policy
                         |
                         v
                Product/Chain Capability
                         |
                         v
                 Retrieval Pipeline
          hybrid recall / rerank / diversity
                         |
                         v
                  Evidence Report
       coverage / freshness / conflicts / gaps
                         |
               +---------+---------+
               |                   |
               v                   v
          Continue Search     Answer Composer
                                  |
                                  v
                         Claim Grounding Gate
                                  |
                                  v
                    Response + Quality Observation
                                  |
                  +---------------+---------------+
                  |                               |
                  v                               v
             用户回复                    评测/反馈/治理候选
```

## 工作流一：结构化问题理解

### 意图模型

新增内部细粒度意图，不立即破坏公开 `ChatResponse.intent`：

```ts
type ProductQuestionIntent =
  | 'capability_overview'
  | 'feature_support'
  | 'how_to'
  | 'limit_or_quota'
  | 'plan_entitlement'
  | 'comparison'
  | 'recent_updates'
  | 'historical_change'
  | 'agent_capabilities'
  | 'unknown';
```

结构化结果至少包含：

```ts
interface QuestionUnderstanding {
  intent: ProductQuestionIntent;
  subject: 'xxyy_product' | 'customer_agent' | 'public_transaction' | 'unknown';
  entities: string[];
  modules: string[];
  temporalScope: 'current' | 'historical' | 'explicit_range' | 'unspecified';
  language: 'zh' | 'en' | 'mixed';
  ambiguity: {
    requiresClarification: boolean;
    reason?: string;
    clarificationQuestion?: string;
  };
  confidence: number;
}
```

### 路由原则

- 确定性 Pre-Guard 继续优先处理安全、隐私、投资建议和公开交易引用。
- 明确、单一、低风险的问题可直接产生确定性 Query Plan。
- 宽泛总览、比较、多条件、上下文依赖和多意图问题必须经过结构化理解。
- 低置信度时不得靠检索结果反向猜测用户主体。
- 澄清问题必须短、单一且能改变后续路线。
- 在 XXYY 官方客服渠道中，裸问题“支持哪些功能”可默认解释为产品总览；“你/客服/机器人能做什么”解释为 Agent 能力。

### 兼容策略

- 对外继续返回现有 `product_qa`、`how_to` 等顶层 intent。
- 细粒度意图作为 trace metadata、评测字段和内部策略输入。
- 不根据 MCP discovery 动态注册或授权工具。

## 工作流二：上下文与 Query 改写

### Standalone Question

将当前消息与有界历史改写为无需历史也可理解的问题：

```text
历史：XXYY Pro 有哪些权益？
当前：那免费版呢？

Standalone Question：
XXYY Basic 免费版当前有哪些功能和权益？
```

改写约束：

- 保留原问题主体、实体、否定、比较关系和时间范围。
- 不引入用户未提供的账户、地址、交易或产品事实。
- 改写失败时使用原问题或澄清，不能悄悄改变问题。
- 原问题用于最终回答；Standalone Question 只用于理解和检索。
- 原问题、改写结果和改写原因进入脱敏 trace。

### Query Plan

新增受约束 Query Plan：

```ts
interface ProductQueryPlan {
  originalQuestion: string;
  standaloneQuestion: string;
  strategy: 'single' | 'multi_query' | 'clarify';
  queries: Array<{
    query: string;
    facet?: string;
    preferredSourceTypes: Array<'admin_verified' | 'official_docs' | 'x_updates'>;
  }>;
  requiredFacets: string[];
  temporalScope: QuestionUnderstanding['temporalScope'];
  maxSearches: number;
}
```

执行规则：

- 首次检索允许使用通过验证的 `standaloneQuestion` 或 Query Plan，不再无条件强制原问题。
- 精确支持、教程和限额问题默认单 Query。
- 功能总览、比较和多模块问题使用有界多 Query。
- Query 数量、长度、总 Token、总检索次数和超时均设硬上限。
- 二次查询必须覆盖缺失 facet 或解决冲突，不允许只改同义词重复搜索。
- `search_product_docs.question` 始终保留原始/Standalone Question，`query` 承载具体检索词。

## 工作流三：按意图选择检索策略

### 来源优先级

| 问题类型  | 首选来源                           | 补充来源                 | 限制                         |
| --------- | ---------------------------------- | ------------------------ | ---------------------------- |
| 功能总览  | `admin_verified`、当前官网功能目录 | 当前官网详情、当前 X     | X 不能单独构成完整目录       |
| 操作教程  | 当前官网操作文档                   | `admin_verified`         | 营销推文不得作为主要步骤证据 |
| 是否支持  | 当前且范围匹配的官网/管理员知识    | 当前 X 上线公告          | 历史 X 不能单独证明当前支持  |
| 数值/限额 | 当前结构化或明确数值证据           | 当前官网/X               | 必须执行同范围冲突检查       |
| 套餐权益  | 当前权益文档                       | `admin_verified`、当前 X | 活动权益与长期权益分开       |
| 最近更新  | 当前 X、Changelog                  | 当前官网                 | 必须保留更新时间             |
| 历史变化  | 历史 X、Changelog                  | 旧官网证据               | 回答必须标明历史时间         |

### 召回与重排

- 保留 pgvector 向量、词法和实体三路召回。
- Query Plan 的每个 facet 独立召回，再统一去重和重排。
- 总览问题优先执行文档级召回，再选择同一权威文档的相关章节。
- 同一 X Post、同一文档相邻 chunk 和重复事实合并。
- 引入来源多样性和模块覆盖，避免 Top K 被同一种来源占满。
- 对非更新问题限制最终 grounding 中的 X 来源数量。
- “哪些”只能说明用户期望结构化结果，不能单独奖励营销列表或年度总结。
- 权威性、当前状态和范围匹配必须独立于语义相似度计分。
- 保留历史问题对历史来源的显式例外，不能全局删除历史资料。

### 功能目录

建立一份可治理的当前功能目录，至少记录：

```ts
interface ProductCapabilityRecord {
  capabilityId: string;
  module: string;
  name: string;
  summary: string;
  status: 'current' | 'deprecated' | 'unknown';
  plans?: string[];
  supportedChains?: string[];
  evidenceIds: string[];
  effectiveAt?: string;
  lastVerifiedAt: string;
}
```

该目录是功能总览的权威锚点，不替代详细官网文档。任何记录仍必须引用正式知识来源并经过现有发布门禁。

## 工作流四：证据完整性和冲突判断

### Evidence Report

每次产品检索生成：

```ts
interface ProductEvidenceReport {
  sufficient: boolean;
  coverage: number;
  requiredFacets: string[];
  coveredFacets: string[];
  missingFacets: string[];
  sourceTypes: string[];
  currentEvidenceCount: number;
  historicalEvidenceCount: number;
  conflicts: Array<{
    subject: string;
    values: string[];
    evidenceIds: string[];
  }>;
  nextAction: 'answer' | 'continue_search' | 'clarify' | 'partial_answer';
}
```

### 按意图定义充分性

- `feature_support`：目标实体、支持结论、适用范围和当前状态全部满足。
- `capability_overview`：命中权威目录，或达到主要模块覆盖门槛且来源不是全部为 X。
- `how_to`：存在可执行步骤及必要前置条件；只有功能宣传不充分。
- `limit_or_quota`：存在明确数值、单位、适用套餐/链/模块和当前时间证据。
- `comparison`：每个对象和每个要求比较的维度都有证据。
- `recent_updates`：证据在请求的时间窗口内并带有效时间。
- `historical_change`：当前与历史证据按时间排序，不能混写成当前状态。

停止规则：

- 单一问题不再等同于“有一条 citation 即充分”。
- 达到最大检索次数时，有部分证据则返回部分答案和缺口。
- 无直接证据时返回知识不足，不使用常识或营销片段补齐。
- 同范围当前事实冲突时停止生成唯一结论，返回冲突说明并创建治理信号。

## 工作流五：回答生成与校验

### 两阶段回答

第一阶段从证据中提取结构化事实：

```ts
interface GroundedFact {
  subject: string;
  claim: string;
  status: 'current' | 'historical' | 'uncertain';
  scope?: string;
  evidenceIds: string[];
}
```

第二阶段只使用 `GroundedFact[]` 生成客服回答。

### 回答策略

- 第一段直接回答，不先复述问题。
- 功能总览按稳定模块组织，不按检索结果顺序拼接。
- 教程使用前置条件、步骤、注意事项和失败处理。
- 支持判断明确输出“支持 / 不支持 / 当前证据不足”。
- 当前与历史信息显式区分。
- 过滤 hashtag、活动口号、互动邀请、祝福和 KOL 营销内容。
- 引用尽量贴近支持的结论；引用数量不是完整性的替代指标。
- 部分回答必须说明已覆盖和未覆盖的范围。
- 回答长度与问题复杂度匹配，Telegram 保持移动端可读。

### 校验门禁

- 保留现有 claim grounding。
- 新增结构完整性校验：输出是否覆盖 Evidence Report 要求的 facet。
- 新增范围校验：套餐、链、时间和模块不能在生成时丢失。
- 新增冲突校验：存在未解决冲突时禁止输出确定性唯一事实。
- 流式回答继续先缓冲和验证，不能在校验前泄漏不受支持 Token。

## 工作流六：Telegram 多轮上下文

### 会话隔离

建议会话键：

```text
私聊：chatId + userId
群聊：chatId + topicId + userId
回复链：chatId + rootMessageId + userId
```

要求：

- 复用客服系统已实现的脱敏持久会话，不新增进程内无限记忆。
- Telegram reply 请求包含被回复的 Bot 消息摘要和有界最近历史。
- 群聊不能自动读取其他用户的私人上下文。
- 历史默认最多 6～10 轮，并受字符、Token 和过期时间限制。
- 管理员知识回复采集与普通客服上下文继续走两条独立路径。
- 删除、编辑和知识 tombstone 行为不因会话上下文改变。

## 工作流七：质量观测、评测和治理闭环

### 每次请求的脱敏质量观测

至少记录：

- 顶层 intent 和细粒度 intent。
- subject、时间范围、歧义和澄清决策。
- Standalone Question 的哈希或脱敏文本。
- Query 数量、检索次数和每次新增证据数。
- 召回来源分布、模块覆盖、当前/历史分布。
- Evidence Report、停止原因和冲突数量。
- grounding coverage、回答 route、延迟和 Token 使用。
- 用户反馈和是否形成知识缺口。

不得记录密钥、完整私钥/助记词、未经脱敏的私有内容或 Provider credential。

### Golden QA 扩展

新增以下评测维度：

- `expectedFineGrainedIntent`
- `expectedSubject`
- `expectedClarification`
- `expectedStandaloneQuestionTerms`
- `requiredFacets`
- `minimumFacetCoverage`
- `requiredSourceTypes`
- `maximumXSourceCount`
- `expectedSearchCountRange`
- `expectedPartialAnswer`
- `forbiddenMarketingPhrases`

新增问题集：

- 产品能力与 Agent 能力歧义。
- 宽泛功能总览。
- 单功能支持。
- 当前数值与历史冲突。
- 多套餐、多模块比较。
- Telegram reply 和省略表达。
- 中英文与中英混合口语。
- 只有 X 宣传但无当前正式证据。
- 检索部分覆盖和知识不足。
- 链上、私有数据、投资建议边界回归。

基线回归：

```text
问题：支持哪些功能

必须满足：
- 识别为产品功能总览，或在非 XXYY 渠道明确澄清主体。
- 不直接使用原始宽泛 Query 做唯一一次检索。
- 答案按产品模块组织。
- X Post 不能作为唯一来源。
- 不包含营销互动和祝福文案。
- 缺少权威功能目录时明确说明答案不是完整目录。
```

### 质量指标

上线门槛以经审核评测集为准：

| 指标                            | 目标           |
| ------------------------------- | -------------- |
| 顶层安全边界路由准确率          | `>= 99%`       |
| 细粒度意图准确率                | `>= 95%`       |
| Retrieval Recall@6              | `>= 90%`       |
| 禁止/冲突 chunk 命中            | `0` 个严重命中 |
| 功能总览主要 facet 覆盖         | `>= 85%`       |
| 当前事实时效正确率              | `>= 95%`       |
| Grounded critical claims        | `>= 98%`       |
| 功能总览仅 X 来源比例           | `< 5%`         |
| 多轮 Standalone Question 正确率 | `>= 90%`       |
| 严重边界回归                    | `0`            |

指标目标是发布门禁，不是对当前状态的声明。首次实施前必须保存基线报告，后续报告同时展示质量、P50/P95 延迟、模型调用数和成本变化。

### 知识治理闭环

```text
低置信度 / 负反馈 / 重复追问 / 冲突
  → 脱敏质量信号
  → 评测草稿或知识候选
  → 去重、来源和冲突检查
  → 自动策略与必要的管理员治理
  → PublicationJob
  → 独立 Worker
  → 正式知识库
```

Agent、API 和 Telegram Bot 不直接发布正式知识。对话样本先进入评测通常比先补知识更安全：只有确认问题是知识缺口，而不是分类、检索或生成缺陷后，才创建知识候选。

## 分阶段实施

### Phase 0：基线和可观测性

- [x] 为“支持哪些功能”等已知失败新增 Golden QA，并保留首次 Provider `34/55` 失败基线。
- [x] 在 trace 中区分分类、Query、召回、证据、生成和 grounding 阶段。
- [x] 输出来源分布、facet 覆盖、搜索停止原因和延迟。
- [x] 保存 deterministic、provider retrieval-only 和 provider full-chain 基线。

成功标准：能够回答“问题坏在哪一层”，且观测数据不包含敏感信息。

### Phase 1：首轮高收益修复

- [x] 新增 `capability_overview` 与 `agent_capabilities`。
- [x] 允许首次检索使用经过约束的 Standalone Question。
- [x] 修正单 citation 即充分的规则。
- [x] 为功能总览添加来源策略和 X 数量限制。
- [x] 过滤营销文案。
- [x] 增加对应单元、Agent 轨迹和 Golden QA。

成功标准：“支持哪些功能”不再只根据两条 X 更新输出类似完整目录的回答。

### Phase 2：Query Plan 与检索策略

- [x] 引入结构化 `QuestionUnderstanding` 和 `ProductQueryPlan`。
- [x] 实现有界多 Query 和缺失 facet 补查。
- [x] 实现文档级锚点、来源多样性和重复来源惩罚。
- [x] 按意图应用来源、时效和范围策略。
- [x] 建立并治理当前产品功能目录。

成功标准：总览、比较和多条件问题可以量化覆盖率，重复检索不会被误认为新增证据。

### Phase 3：Evidence Report 与回答生成

- [x] 用按意图的充分性判断替换统一 citation 门槛。
- [x] 增加范围一致性、数值冲突和当前/历史检查。
- [x] 先提取 `GroundedFact[]`，再生成客服答案。
- [x] 将部分答案、知识不足和冲突变成明确输出状态。
- [x] 保留并扩展流式 grounding 门禁。

成功标准：答案完整性、相关性和 grounding 可以分别评测；部分证据不能生成完整结论。

### Phase 4：Telegram 多轮上下文

- [x] 将 Telegram 请求接入持久会话历史。
- [x] 支持 reply chain 和 topic/user 隔离。
- [x] 实现有界 Standalone Question 改写。
- [x] 增加群聊交叉用户、编辑消息、长历史和敏感输入测试。

成功标准：“那免费版呢”等追问能正确恢复主体，且不会读取其他群成员上下文。

### Phase 5：质量闭环与管理面

- [x] 管理面展示意图、Query、证据覆盖、来源和停止原因。
- [x] 低质量回答按分类/检索/知识/生成/边界分诊。
- [x] 支持将经审核样本提升为 Golden QA。
- [x] 只有确认是知识缺口时才创建知识候选。
- [x] 建立质量趋势、回归告警和发布前报告。

成功标准：运营人员可以从负反馈定位根因，并通过受控流程修复而不是直接编辑向量数据。

### Phase 6：Shadow、灰度和发布

- [x] 新旧流程并行 Shadow，对比路线、来源、状态、引用数、答案指纹、延迟和 Token。
- [x] 对 Web/Telegram 分别设置独立功能开关。
- [x] 输出不含问题、答案和用户标识的 Web/Telegram 灰度观察事件。
- [x] 提供审批、观察窗口、人工抽检和供应商账单证据齐备才通过的灰度门禁 CLI。
- [x] 从严格 JSONL 自动生成去标识、去重、按时间排序的灰度证据包和差异率报告。
- [x] 本地 Web 以 10% optimized 主桶执行小比例 Shadow 灰度，监控质量、延迟、错误率和本地模型用量。
- [x] 本地门禁通过并完成回滚演练后，API/Telegram 扩量到 optimized 100%。
- [x] 保留回滚到当前确定性路径的开关和兼容契约。

成功标准：无安全边界回归，质量达到门槛，P95 延迟和调用成本在批准预算内。

### 2026-07-30 本地发布门禁实测

- Deterministic：`55/55`，Recall@6 `1.0`，forbidden hit `0`，最新 P95 `32.27ms`。
- Provider retrieval-only：`49/49`，Recall@6 `1.0`，forbidden hit `0`。
- Provider full-chain：从首轮 `34/55`、第二轮 `41/55` 提升到 `55/55`；Recall@6 `1.0`，
  forbidden hit `0`，P50 `3.56s`，P95 `8.11s`，回答模型响应 `4` 次、合计 `6261`
  tokens，本地质量发布门禁通过。
- `pnpm check` 通过：Web build、format check、24 个 workspace package typecheck、
  `1246` tests（另有 `2` skipped）和 deterministic Golden QA 全部通过。
- 三类评测产物保存在本地忽略目录 `.rag/`；失败样本产物可能包含 Golden QA 的观察答案和
  引用，仅用于本地诊断，不得提交。
- 以上是离线发布门禁；随后已完成下节记录的本地小流量灰度和观察窗口。外部生产环境仍未
  灰度，也没有使用本地证据替代外部审批或付费 Provider 账单。
- 灰度前置能力已补齐：Web/Telegram 可输出有界 `answer_quality_rollout` 事件，
  `rag:rollout:gate` 会验证预先审批、逐渠道样本、P95/错误率/完整率、人工抽检、边界回归和
  同窗口供应商成本证据；缺少或混入未批准渠道时失败关闭。证据模板故意保持不可通过状态，
  真实观察和报告只能保存在忽略目录 `.rag/`。
- 生产 no-op tracer 不再造成 Shadow 差异不可见：rollout event 直接包含脱敏的答案一致性、
  来源类型、引用差、状态、路线、延迟和 Token 差；`rag:rollout:evidence` 严格验证并汇总
  JSONL，门禁报告按渠道显示答案与来源类型差异率。

### 2026-07-30 本地灰度与扩量实测

- Docker Compose 已把回答质量模式、比例和观测开关显式传给 API/Telegram；本地镜像使用
  Node `24.18.0` 重建，API health 通过。
- Web 在 `shadow / 10%` 下执行 5 条受控请求：1 条 optimized 主桶、4 条 legacy 主桶，
  覆盖功能总览、Pro 权益、how-to、Agent 能力和钱包余额边界。
- 首轮发现“如何设置止损”把 X 营销文案标为完整教程。修复后，X-only how-to 只提取可证实
  动作、过滤营销措辞，并返回 `partial` 和缺失入口/参数说明；真实 API、单元测试和
  `personal-wallet-stop-loss-how-to` Golden QA 均通过。
- 本地证据门禁 `PASS`：5/5 人工抽检通过，严重边界回归 `0`，主/Shadow 错误率 `0`，
  complete rate `0.8`（1 条预期 partial），答案/来源差异率 `0`，P95 `14.007s`，
  本地无计费模型平均可见 Chat Token `564.8`，外部费用 `0`。
- 已演练切换到 `legacy / 0%` 并验证健康与回答，然后扩量到 API/Telegram
  `optimized / 100%`；`ANSWER_QUALITY_OBSERVABILITY_ENABLED=true` 保持开启，最终
  optimized 请求与 rollout event 已验证。
- 审批、原始 JSONL、证据包和门禁报告仅保存在忽略目录 `.rag/`，不会进入仓库。

### 2026-07-31 问答准确率专项复验

- 按“本地优先、暂缓 MCP/Skill 扩展”的范围重新执行 Provider 全链路基线，定位到两个后段
  证据使用问题：来源定位题只返回推文编号而遗漏事实；包含 `P1/P2/P3` 的精确实体题被泛化
  的“交易设置”文档覆盖。
- 来源定位题改为使用已选定证据生成“事实 + 来源”的确定性回答，避免模型压缩掉用户问题中
  要确认的事实；包含多个字母数字编号的结构化问题，只有同时覆盖全部编号的证据才能进入
  最终 grounding，精确实体优先于泛化标题。
- 修复前 Provider full-chain 为 `53/55`；定向复验 `2/2`、全量复验 `55/55`，质量发布
  门禁通过。全量 Recall@6 `1.0`、forbidden hit `0`、P50 `3.97s`、P95 `8.05s`，回答
  模型响应 `4` 次、合计 `6290` tokens。
- `pnpm check` 通过：Web build、format check、24 个 workspace package typecheck、
  `1248` tests（另有 `2` skipped）和 deterministic Golden QA `55/55` 全部通过。
- MCP、Skill、链上能力、知识发布和生产部署配置均未修改。

## 代码落点

| 模块                      | 主要职责                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| `packages/shared`         | Question Understanding、Query Plan、Evidence Report 和 trace 契约                |
| `packages/agent-core`     | 上下文恢复、意图/主体理解、澄清、Planner、LangGraph 状态与停止条件               |
| `packages/rag-core`       | Query 规范化、动态来源策略、多路召回、rerank、多样性、Evidence Report、grounding |
| `packages/product-qa-mcp` | 接受受约束检索计划，保持只读产品知识边界                                         |
| `packages/knowledge`      | 功能目录和正式知识的加载、chunk、metadata 与 embedding                           |
| `apps/telegram-bot`       | 会话历史、reply chain、topic/user 隔离和低质量反馈                               |
| `apps/api`                | 质量观测、管理查询和版本化兼容接口                                               |
| `apps/web`                | 管理员质量诊断和评测/知识缺口分诊                                                |
| `apps/cli`                | 基线、retrieval-only、full-chain、差异和发布前质量报告                           |
| `docs/eval`               | Golden QA、标注规范、基线与发布门槛                                              |
| `docs/product-features`   | 经治理的当前功能目录及其正式来源                                                 |

## 发布、兼容与回滚

- 新内部字段先设为可选，避免一次性破坏 Web、Telegram、SDK 和 MCP 契约。
- 旧顶层 intent 和 `ChatResponse` 保持兼容，细粒度结果先进入内部 metadata。
- Query Plan 和新 Evidence Report 必须版本化。
- 功能目录缺失时系统回退到官网文档检索，但必须降低完整性声明。
- 语义理解模型不可用时，明确回退到安全确定性分类；边界规则不得依赖 LLM 可用性。
- 多 Query 超时允许使用已有证据返回部分答案，不能无限重试。
- Shadow 结果不发送给用户、不写正式知识，只保存有界脱敏差异。
- 回滚不能删除已产生的质量审计和评测记录。

## 风险与控制

| 风险                         | 控制                                                  |
| ---------------------------- | ----------------------------------------------------- |
| LLM Query 改写改变用户意图   | 范围/实体/时间约束、低置信度澄清、轨迹测试            |
| 多 Query 增加延迟和成本      | 按意图启用、硬上限、并行召回、缓存、预算指标          |
| 过度澄清降低体验             | XXYY 渠道默认主体、只对影响路线的歧义澄清             |
| X 被过度降权导致错过最新事实 | 按意图动态来源策略，更新问题继续优先 X                |
| 功能目录过期                 | 证据引用、有效时间、刷新 Job、冲突治理和发布门禁      |
| 群聊历史交叉污染             | chat/topic/user/reply 隔离、脱敏、有界保留            |
| 新 Planner 扩大工具权限      | Capability Registry 固定授权，禁止 discovery 自动注册 |
| 反馈导致错误“自学习”         | 反馈先进入评测/候选，禁止直接发布                     |
| 指标改善但真实体验下降       | Golden QA、Shadow、人工抽检和真实负反馈联合门禁       |

## 完成定义

- [x] 目标架构在 Web、Telegram、CLI 和 SDK 共用 Runtime 生效。
- [x] 细粒度意图、主体、时间范围、歧义和 Query Plan 有版本化契约。
- [x] 首次检索不再无条件使用原始问题。
- [x] 宽泛总览、比较和多条件问题支持有界拆解。
- [x] 来源策略、当前/历史、模块覆盖和冲突进入 Evidence Report。
- [x] 单 citation 不再自动代表复杂或总览问题证据充分。
- [x] Telegram 支持隔离、有界、脱敏的多轮上下文和 reply chain。
- [x] 回答使用结构化事实并通过 claim、范围和冲突校验。
- [x] 管理面可定位分类、检索、知识、生成和边界问题。
- [x] 低质量信号不会绕过知识治理和独立发布 Worker。
- [x] 新增 Golden QA、单元测试、Agent 轨迹测试和渠道集成测试。
- [x] `pnpm rag:evaluate`、retrieval-only 基线、provider 全链路抽检和 `pnpm check` 通过。
- [x] 本地 Shadow/灰度达到批准的质量、P95、Token 和零外部费用门槛。
- [x] 无产品、链上、隐私、密钥、Capability 或生产发布边界回归。
