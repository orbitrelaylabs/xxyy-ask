# Allowlisted Read-only EVM Data Adapter v0.1

## 当前状态

`@xxyy/evm-data-adapter` 是 `@xxyy/transaction-analysis-core` 之前的只读数据边界。它通过受控的标准 EVM JSON-RPC 获取公开 transaction、receipt、chain id 和 block，将 hex quantity 无精度损失地转换为 normalized `EvmTransactionSnapshot`，再由离线领域核心计算交易事实。本 adapter 的四方法 allowlist 不扩大；额外 trace 和 pool metadata 由独立的 [EVM Execution Data Adapter](evm-execution-data-adapter.md) 获取并验证。

该包已经实现且被通用 `onchain-analysis` 开发 composition 与隔离的私有生产 data-plane composition 引用。开发 composition 可从启动配置或非生产公共默认值获取基础 EVM snapshot；内部生产 composition 仍需 canonical readiness 门禁。adapter 自身不是 MCP server/capability adapter。公开 LangGraph、API、Web 和 Telegram 仍不注册链上 Tool，收到交易、Explorer、链上取证或 MEV 问题时继续返回现有边界回复。通用配置见 [Onchain Analysis MCP / Skills](onchain-analysis-mcp.md)，私有生产路径见 [Chain Analysis Provider & Worker Data Plane](chain-data-plane-operations.md)。

## 组件边界

```mermaid
flowchart LR
  Config["启动时 Chain / Provider Allowlist"] --> Adapter["EVM Data Adapter"]
  Request["chainId + transactionHash + providerIds"] --> Adapter
  Adapter --> Guard["HTTPS / Chain ID / Timeout / Size Guard"]
  Guard --> RPC["只读 JSON-RPC"]
  RPC --> Normalize["Hex -> Decimal Snapshot"]
  Normalize --> Reconcile["Provider Diagnostics + Conflicts"]
  Reconcile --> Snapshot["EvmTransactionSnapshot"]
  Snapshot --> Core["Transaction Analysis Core"]

  Internal["Internal Chain MCP"] --> Adapter
  Runtime["Public CustomerAgentRuntime"] -. "未接线" .-> Internal
```

领域核心仍然没有网络依赖。adapter 不计算 success/reverted 的资产变化，不解码 ERC-20，也不调用 LLM；它只负责可信获取、校验、归一化和来源协调。

## Allowlist 与 SSRF 边界

- RPC URL 只能出现在启动时 `chains[].providers[]` 配置中；运行时输入不接受 URL，只能选择已配置的 `chainId` 和 `providerIds`。
- endpoint 默认必须使用 HTTPS。只有显式设置 `allowInsecureLocalhost` 时才允许 `localhost`、`127.0.0.0/8` 或 `::1` 的 HTTP 开发节点。
- URL user/password 和 fragment 被拒绝；provider path/query 可以承载供应商路由，但 provenance 只输出 origin，避免泄露 path/query token。
- HTTP 请求固定 `redirect: "error"`，不跟随 endpoint 重定向。
- 自定义 header 最多 32 个；Host、Content-Length、Content-Type、Connection、Transfer-Encoding 和 Proxy-Authorization 等由 adapter 控制。认证 header 只留在 client 闭包，不进入 snapshot、diagnostic 或公开错误。
- 低层 client 只接受 `eth_getTransactionByHash`、`eth_getTransactionReceipt`、`eth_chainId` 和 `eth_getBlockByNumber`，不能构造签名、模拟、广播或写链调用。

配置本身属于受信任的部署权限边界。未来若由管理面维护 provider 配置，必须继续走独立 RBAC 和密钥存储，不能允许聊天输入动态添加 endpoint。

## 有界传输

默认限制：

| 项目          | 默认值   | 绝对上限 |
| ------------- | -------- | -------- |
| 单批 RPC 数量 | 4        | 20       |
| 响应正文      | 1 MiB    | 5 MiB    |
| 单次请求超时  | 10 秒    | 120 秒   |
| 自动重试      | 1 次     | 3 次     |
| 基础退避      | 100 毫秒 | 2 秒     |
| 单链 provider | 配置决定 | 8 个     |

adapter 首批固定使用三调用 batch：transaction、receipt 和 `eth_chainId`。只有 HTTP 408/425/429、5xx、网络错误和 timeout 可以有界重试；调用方 abort、4xx、响应超限、非法 JSON/JSON-RPC 和非法 provider payload 不重试。响应正文通过 stream 累计字节，不能用缺失或伪造的 Content-Length 绕过上限。

`EvmRpcRequestError` 只公开稳定 code、provider id、attempts、retryable、可选 HTTP status 和 size limit。底层 fetch/JSON error 不作为 `cause` 暴露，避免日志间接记录 endpoint 密钥或响应片段。

## Provider Contract 流程

1. 校验 chain、provider 选择和 transaction hash；provider 顺序来自启动配置，不受请求排序影响。
2. 并行调用最多 8 个已选择 provider；单个 provider 内批量读取 transaction、receipt 和 chain id。
3. `eth_chainId` 与配置不一致、不可用或格式非法时 fail closed：该 provider 的 transaction/receipt 不进入 snapshot。
4. 把 canonical hex quantity 直接通过 `bigint` 转为十进制字符串；transaction/log index 只有验证不超过领域上限后才转为 number。
5. 根据已验证的 receipt 或 transaction block number 读取 block，并校验 transaction hash、receipt hash、block number 和 transaction index 关联。
6. 每个来源记录稳定 provider id、观测时间、脱敏 origin 和原始响应 SHA-256；不保存 RPC body。
7. 按配置顺序选择首个有效 canonical transaction/receipt/block，同时把 provider 间 presence 和关键字段差异写入 snapshot `conflicts`。

adapter 返回独立状态：

- `success`：存在有效 transaction，且没有 provider diagnostic 或 conflict；
- `partial`：存在有效 transaction，但 provider 缺失、失败、不一致或多来源冲突；
- `insufficient_data`：没有任何可以接纳的目标 transaction。

下游领域核心仍会独立验证 snapshot，并生成自己的 `SkillResult` 状态、Evidence、warnings 和 diagnostics。adapter 状态不能替代领域分析状态。

## 可重放测试资产

`packages/evm-data-adapter/src/fixtures` 包含合成 JSON-RPC batch/block 响应，覆盖：

- 成功 transaction、receipt、chain 和 block；
- 第二 provider 的 transaction、receipt 和 block 冲突；
- out-of-order batch response 和 provider 扩展字段。

provider contract tests 另外覆盖 missing result、错误 chain、hash/index/block 不一致、非法 hex、单 provider 失败/多 provider 降级、HTTP retry、timeout、abort、chunked response 超限、非法 JSON/JSON-RPC、只读方法 allowlist、endpoint/header 限制和错误脱敏。测试全部使用注入的 `fetch`，不访问真实网络。

## 明确未实现

- 在 `.env`、Docker、API、CLI 或后台任务中配置和启用真实 RPC provider；
- provider 级 QPS 配额、共享熔断、缓存、持久化审计和生产 metrics；
- 本包内的 Indexer、Explorer、trace/debug RPC、pool metadata 或 archive node adapter；trace/pool 已由权限隔离的独立 adapter 实现；
- adapter 内的 internal transfer、revert reason 或协议计算；这些确定性语义位于独立 enrichment core；
- 本包内的 pool metadata 链上交叉验证、价格影响或 Sandwich 检测；pool/factory 验证位于独立 execution adapter，price-impact/Sandwich 判定位于独立离线 core；
- Capability manifest/adapter、MCP client/server、LangGraph bridge 或任何用户可见入口；
- 私有账户查询、签名、模拟、交易发送或其他写操作。

受控 trace/debug RPC 与 pool metadata 验证已在独立 [EVM Execution Data Adapter](evm-execution-data-adapter.md) 实现；[MEV Observation Data Adapter](evm-mev-observation-data-adapter.md) 已能用 canonical block、pool logs 和 V2/V3 state replay 构建同区块输入；离线价格影响与四态判断由 [EVM Price Impact / Sandwich Core](evm-price-impact-sandwich.md) 完成；[Chain Analysis Harness](evm-chain-analysis-harness.md) 已负责离线组合、合成回放评测与质量门禁；[Readiness Control Plane](evm-chain-analysis-readiness.md) 已定义 reviewed corpus 和生产证据契约。各包仍未接入客服。只有实际部署真实 provider data plane、采集 reviewed 主网 corpus、完成内部 channel 授权/Capability bridge 并通过端到端门禁后，才考虑注册链上能力。
