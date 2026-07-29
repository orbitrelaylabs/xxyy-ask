# Chain Analysis Governance Persistence & Shared Provider Controls v0.1

## 当前状态

`@xxyy/evm-chain-analysis-control-store` 是 `@xxyy/evm-chain-analysis-readiness` 的独立 Postgres backend。它把已存在的 content-addressed sampling、reviewed replay 治理、readiness evidence 和 provider-control 契约落到事务、行锁、generation fence、不可变 artifact 表和哈希链审计中，但不改变任何客服运行面。

当前包：

- 不读取环境变量，也不创建数据库连接；composition root 必须显式注入 `PgControlClientLike`；
- 不访问 RPC、Indexer、Explorer、HTTP、secret manager 或 provider endpoint；
- 不导入 Agent、LangGraph、Capability、MCP、API 或 Telegram；仅由隔离的 `apps/chain-control-cli` 与 `apps/chain-operations-cli` 注入 client；
- 不包含真实主网样本、真实 reviewer 身份、生产 grant、provider credential 或生产 readiness evidence；
- 除两个隔离的私有运维 app 外，不被 API、Web、Telegram、RAG CLI、`agent-core` 或 `rag-core` 直接引用；公开三项 Chain 能力默认使用独立启动配置，不连接本 control store。

它是可部署 backend 实现，不是“已经部署并通过生产评审”的证明。包级 contract-only fixture、fake PostgreSQL client 和迁移测试不能作为主网 corpus、故障演练或 `ready` attestation。

## 设计位置

```mermaid
flowchart LR
  Contract["Readiness content-addressed contracts"] --> Store["Postgres control store"]
  Identity["External identity / provisioning"] --> CLI["Private chain-control CLI"]
  CLI --> Grant["Immutable role grants"]
  Grant --> Store
  Store --> Sampling["Approval / policy / plan / manifest"]
  Sampling --> Handoff["Manifest → candidate handoff"]
  Handoff --> ReviewQueue["Single-owner review work queue"]
  Store --> Governance["Candidate / review / decision / promotion"]
  ReviewQueue --> Governance
  Handoff --> Governance
  Store --> Retention["Leased retention worker state"]
  Store --> Budget["Global budget windows / leases / settlements"]
  Store --> Circuit["Circuit history + CAS head"]
  Governance --> Audit["Append-only hash-chained audit"]
  Retention --> Audit
  Budget --> Audit
  Circuit --> Audit
  Sampling --> Audit
  Sampling --> Governance
  Governance --> Export["Governed corpus export"]
  Publisher["Governance publisher"] --> Policy["Readiness policy"]
  Operator["Provider operator"] --> Ops["Operations evidence"]
  Export --> Ledger["Reproducible evidence ledger"]
  Policy --> Ledger
  Ops --> Ledger
  Ledger --> Harness["Recompute corpus + readiness evaluators"]
  Harness --> Attestation["Persisted result + exact lineage"]
```

职责边界保持明确：readiness 包负责 schema 和纯状态机，本包负责 Postgres 一致性；独立 data-plane 包与私有 operations CLI 负责连接池、opaque secret 解析、worker 执行、脱敏 metrics/alert 和 provider 请求。真实部署仍由平台环境负责。

## 数据模型

### 不可变 artifact

以下表只允许 `INSERT`，migration 为其安装 `BEFORE UPDATE OR DELETE` 拒绝触发器：

- reviewer/worker/operator authorization 与 revocation；
- replay candidate、review、governance decision、promotion 和 tombstone；
- reviewed corpus export、readiness policy、operations evidence、corpus evaluation report 与 readiness attestation；
- sampling source approval、policy、plan、sample manifest、manifest/candidate handoff 和 coverage run；
- audit event；
- budget policy、lease 和 settlement；
- circuit state history；
- 带 manifest、provider configuration、request fingerprint 和 budget lease lineage 的 provider request event。

每次读取 JSONB payload 后都会重新执行原始 Zod schema；每次业务写入还会重新调用 readiness 纯函数，例如 `reviseReviewedReplayCandidate()`、`recordReviewedReplayDecision()`、`promoteReviewedReplayCandidate()`、`settleProviderBudgetLease()` 和 `transitionSharedProviderCircuitState()`。因此数据库中即使出现字段篡改、旧指纹复用或非法状态跳转，也不会被当成有效 artifact。

### 可变协调状态

只有协调所需的小型 head/state 表允许受控更新：

| 状态                   | 更新约束                                                               |
| ---------------------- | ---------------------------------------------------------------------- |
| audit head             | stream 行锁；sequence 必须从前一值加一                                 |
| retention job          | `queued → running → completed`；worker lease 和过期重领                |
| sampling intake job    | `queued → running → succeeded/failed`；lease、attempt 与 planner retry |
| review work job        | `queued/failed → running → succeeded/failed`；reviewer/attempt fence   |
| active budget policy   | advisory lock + generation/fingerprint CAS                             |
| budget window counters | policy/window 行锁；reserved 与 used 分开对账                          |
| circuit head           | provider identity 行锁 + expected generation/state fingerprint CAS     |

完整 artifact 始终保留在不可变历史表，head 只指向当前版本。

## 治理写入流程

1. 外部受控 provisioning 先写入 content-addressed role grant。可用角色包括 submitter、independent reviewer、publisher、retention worker、sampling planner/worker、readiness attestor 和 provider operator。
2. 每个业务事务按 artifact id 或业务唯一键获取 transaction-scoped advisory lock，并在操作时间点检查有效 grant 和未生效/已生效 revocation。
3. 普通 candidate 写入会验证初始创建或完整 revision/supersession 转移，并同时创建唯一 retention job；sampling handoff 还会重新读取 manifest、重算完整 handoff，并原子创建初始 candidate 与一个 owner review work slot。
4. review 写入强制 actor hash 等于 reviewer hash、reviewer 不等于 submitter，并以 `(candidate, reviewer)` 唯一约束阻止同一身份改写决定；handoff candidate 还必须持有匹配 `jobId + attemptCount` 的有效 lease。
5. decision 从当前持久化 reviews 重新计算；promotion 必须引用一个已持久化、仍能由当前 review 集合重算出的 `approved` decision。
6. corpus export 从所有 promotion/tombstone 构建确定性 snapshot；attestor 只能从 persisted export 生成 corpus report，再引用已持久化的 report、operations evidence 和 policy 重新执行 readiness evaluator。
7. artifact 与对应 audit link 在同一事务提交；任一步失败都回滚。

公共 governance/sampling store 不再暴露可直接写 grant 或 source approval 的 `recordAuthorization()` / `recordSourceApproval()`；对应 artifact writer 仅供包内 production provisioning 事务调用，不能通过 package export 绕过 automated authority verifier。生产部署应使用 `createPgEvmChainAnalysisProductionProvisioningStore()`：它把已确认的 chain/source/retention/owner baseline、八条 role binding、单 owner approval 和 authorization 固定为一个 content-addressed plan；至少 15 分钟确认窗口和自动验证通过后，才在一个事务内写入 approval、八个 grants、immutable receipt 和哈希链审计。活动 approval/grant 漂移、owner/service/verifier principal 分离失败、verifier/数据库/审计失败全部拒绝。完整设计见 [Chain Analysis Production Approval & Identity Provisioning](evm-chain-analysis-production-provisioning.md)。

仓库现已提供独立 `apps/chain-control-cli` 和 Ed25519 verifier：owner request → immutable plan → machine attestation → bounded apply → receipt/audit verification。它要求独立数据库、固定 public key/authority id、受限文件和实际时钟窗口，且不被客服运行面导入。仓库仍没有真实 evidence、受控账号登记、部署后的 verifier identity、生产 grant 或 receipt；测试 key 和 contract-only hash 不能作为真实 provisioning。运维流程见 [Chain Control Production Provisioning Operations](chain-control-provisioning-operations.md)。

## Retention worker contract

candidate 入库后生成一个唯一 job：

- `claimRetentionJob()` 只选择已到期的 queued job 或 lease 已过期的 running job，使用 `FOR UPDATE SKIP LOCKED` 支持多 worker 竞争；
- worker 必须持有操作时间有效的 `retention_worker` grant；
- `completeRetentionJob()` 要求同一 worker 在 lease 到期前完成；
- 未晋升 candidate 写入 `retention_expired` decision，结果为 `expired_unpromoted`；
- 已晋升 candidate 同时生成不可变 `retention_expired` tombstone，结果为 `tombstoned`。

worker 调度、重试频率和告警由未来部署层负责，本包不启动后台进程。

## Sampling evidence intake contract

`createPgEvmChainAnalysisSamplingStore()` 实现采样 artifact 和 job 的事务边界：

1. `sampling_planner` 依次记录 source/retention approval、policy 和 plan；每次写入都会读取上游 artifact 并重新执行 readiness 纯函数，不能跳过 approval anchor 或自行改写 quota。
2. plan insert 与所有稳定 slot 对应的 queued job 在同一事务提交；同一 slot 只有一个 job，默认最多尝试三次。
3. `claimIntakeJob()` 只领取已进入采样窗口、未过期、attempt 未耗尽的 queued job 或 lease 已过期的 running job，并用 `FOR UPDATE SKIP LOCKED` 支持多个 worker。
4. `sampling_worker` 只能在自己的有效 lease 内 `completeIntakeJob()` 或 `failIntakeJob()`；失败只能由 planner 显式 `retryIntakeJob()`。
5. 完成前重新校验 manifest 的 plan/policy/approval/slot/stratum/source/time anchor，并检查 slot 与 `(chainId, transactionHash)` 唯一性。
6. manifest insert、job success、manifest audit 和 completion audit 同事务提交；coverage run 从数据库中的 plan/approval/manifests 重新执行纯 evaluator 后保存。
7. `candidate_submitter` 显式调用 `recordCandidateHandoff()`；store 从持久化 manifest 重算 chain/transaction/block、dimension、source/scan/retention/time lineage，不能信任调用方自哈希对象。
8. handoff、revision-1 candidate、唯一 retention job、一个确定性 review job、`candidate_recorded` 和 `sampling_candidate_handoff_recorded` 在同一事务提交；manifest/candidate 一对一，相同 handoff 幂等，target deviation 不会触发筛除。

approval/policy/plan/manifest/handoff/run 是 append-only artifact；job 是协调状态。control store 不采集 payload、不调用 provider，也不会后台自动触发 handoff 或 review；未来受控部署层必须显式提交已归一化并扫描的 replay payload。contract-only tests 不能代表来源或法律评审完成。详细设计见 [Mainnet Sampling Plan & Evidence Intake Control Plane](evm-chain-analysis-sampling.md)、[Sampling Manifest → Reviewed Replay Candidate Handoff](evm-chain-analysis-sampling-handoff.md) 与 [Single-owner Review Work Queue](evm-chain-analysis-review-work-queue.md)。

## Single-owner review work contract

每个 sampling handoff candidate 有且只有一个 content-derived owner slot。`createPgEvmChainAnalysisReviewWorkStore()` 提供 claim、fail、get 和 list：

- claim 在操作时间验证 `independent_reviewer` grant，以 `FOR UPDATE SKIP LOCKED` 选择 queued、可重试 failed 或 lease 已过期的 running job；
- candidate submitter 和已经提交 review 的 reviewer 会被排除；
- reviewer advisory lock、partial unique index 和 replay review 唯一约束共同封闭并发重复领取；
- claim 增加 attempt，lease 不得越过 candidate retention expiry；失败保存 hashed reason、释放 lease，attempt 达上限后不再领取；
- handoff review 必须把 claim 返回的 `jobId + attemptCount` 传给 `recordReview()`，旧 generation、过期 lease、错误 reviewer 或 candidate 全部 fail closed；
- review insert、job success、`review_recorded` 与 `review_job_completed` 使用同一事务和 audit chain head；
- 非 handoff candidate 保持原有直接 review 契约，不能伪造 work lease 混入 handoff 路径。

owner 拒绝后使用既有 `rejected` 与 revision/supersession 流程；调用方额外提交冲突或重复身份 review 时保持 `disputed`，不会自动增加匿名裁决槽。完整状态机见 [Single-owner Review Work Queue](evm-chain-analysis-review-work-queue.md)。

## Reproducible readiness evidence ledger

`createPgEvmChainAnalysisReadinessEvidenceStore()` 把 readiness 判定从“调用方提交自算 result”改为“store 重读精确输入并重新计算”：

- `governance_publisher` 记录 content-addressed policy，`provider_operator` 独立记录 operations evidence；
- `readiness_attestor` 的 `evaluateCorpus()` 只接受 persisted corpus export fingerprint 和时间，并确定性运行 harness evaluator；
- `evaluateReadiness()` 重新读取 export/report/evidence/policy，按 report 时间再次派生 corpus report，之后调用固定 `evaluateProductionReadiness()`；
- attestation row 保存 report/evidence/policy 三个外键，result 与四类 artifact/audit 都是 append-only；
- raw caller-provided readiness writer 已移除，legacy null lineage、missing artifact、wrong lineage、backdated record 和数据库失败全部 fail closed；
- 正常但未达到固定质量门禁的输入会保存可审计 `blocked`，不会被误当成控制面错误或伪造为 `ready`。

完整模型、迁移兼容和验证见 [Reproducible Readiness Evidence Ledger](evm-chain-analysis-readiness-evidence-ledger.md)。当前 contract-only operations bundle 只是 schema 测试输入，不是实际 provider、SLO、演练、安全或 runbook 证明。

## 跨实例 provider controls

### Budget

`createPgEvmChainAnalysisProviderControlStore()` 实现 readiness 的 `ProviderBudgetCoordinator`：

- active policy 使用 budget advisory lock 和 generation fence 安装；
- reservation request fingerprint 唯一，重试返回同一 lease；
- active policy 行锁串行化同一 budget 的窗口初始化、全局并发统计和 reserved usage 更新；
- aggregate `used + reserved + requested` 不能超过 cost/request/bytes/RPC limits；
- settlement 对 lease 唯一，先释放 reserved，再把实际 usage 计入原窗口；
- `reconcileExpiredLeases()` 用 `FOR UPDATE SKIP LOCKED` 把未结算过期 lease 归档为按完整 reserved usage 计费的保守 `cancelled` settlement，避免未知已发请求被低估。

数据库不可用、active policy 不匹配、窗口额度不足、全局并发耗尽或对账失配都会抛出明确错误并回滚，不能退化为 provider-local 非原子额度。

### Shared circuit

每个 `(adapter, chain, provider)` 保存不可变 state history 和一个 current head：

- 初始化只能从 generation `0` 开始；
- transition 必须保留 provider identity、时间向前且 generation 只增加一次；
- `compareAndSet()` 同时检查 expected generation 和 expected state fingerprint；
- retry 若已经到达完全相同的 next state，会幂等返回；
- stale caller 在写 history 前失败，head 更新还会再次使用 SQL `WHERE generation + fingerprint` fencing。

## 审计链

治理和 provider control 使用两个独立 stream。append 时锁定 stream head，事件包含 sequence、previous event fingerprint、actor hash、entity fingerprint、payload fingerprint 和时间，再对完整 link 计算 event fingerprint。event 表拒绝 update/delete；`readAudit()` 会重新解析每个事件并验证从 sequence 1 开始的全部 predecessor link。

审计 payload 只保存 hash、状态、计数和稳定 reason，不保存 endpoint、credential 或原始 provider body。生产环境仍需额外配置数据库加密、最小权限、备份/WORM 策略、访问审计和故障告警；本实现本身不能宣称这些运维控制已通过。

## 使用与验证

本包本身仍不读取环境或创建连接；私有 `apps/chain-control-cli` 负责 provisioning，`apps/chain-operations-cli` 负责 provider/worker data plane。生产操作需要显式：

1. 通过 `CHAIN_CONTROL_DATABASE_URL` 连接与 Product RAG 分离的 PostgreSQL，远程连接验证 TLS；
2. 用部署 migration 身份运行 `pnpm chain:control:migrate`；
3. 用受保护 Ed25519 机器身份生成 attestation，并通过 runtime public key 验证后原子写入 approval、identity grants 与 receipt；
4. 独立运行 sampling、review、retention 和 expired-lease reconciliation worker；
5. 由受控 publisher/operator/attestor 分别提交真实 policy/evidence、生成 report 并重新计算 attestation；
6. 把 backend unavailable、预算耗尽和 stale CAS 纳入真实故障演练。

当前验证命令：

```bash
pnpm --filter @xxyy/evm-chain-analysis-control-store typecheck
pnpm exec vitest run packages/evm-chain-analysis-control-store/src
pnpm --filter @xxyy/chain-control-cli test
pnpm check
```

单 owner provisioning CLI 已在一次性真实 PostgreSQL 数据库验证 migration 二次执行、签名、apply/retry、receipt/normalized lineage、完整 audit chain 和 append-only trigger，随后删除测试数据库；它不是生产证据。readiness ledger 仍验证了四类 artifact 单行幂等、精确 getter/lineage、无 lineage insert 拒绝及 contract-only `blocked` 结果；真实激活前需在目标 PostgreSQL 重跑 provisioning、单槽 handoff/review、三次失败终止、hash-chain audit、幂等和 append-only 验证。

下一阶段仍需：由 owner 完成真实 sampling source/legal-retention 审批和二次确认，部署 owner/service identities、数据库与 workers，配置 secret manager、metrics/alerting 和 provider failover，按 plan 采集并由 owner 复核主网 corpus，运行故障演练与长期 SLO，再由 readiness evaluator 生成可独立审计的结论。满足这些条件前不得接入 Capability 或客服运行面。
