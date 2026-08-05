# Transaction Analysis Core

`@orbitrelaylabs/xxyy-transaction-agent-kit` 中的 transaction-analysis 模块是无网络依赖的 EVM 交易快照领域实现。浏览器 runtime 从固定 Explorer 页面提取有限事实，校验后交给 core 生成稳定的交易状态、发送方、接收方、区块、时间、原生价值、gas fee、资产变化、warnings 和 evidence。实现位于独立的 [xxyy-transaction-agent-kit](https://github.com/orbitrelaylabs/xxyy-transaction-agent-kit)。

核心不负责：

- 页面访问、浏览器生命周期或截图；
- RPC、Indexer、call trace 或 archive state；
- 池子发现、价格影响、利润或确定性 Sandwich/MEV 判定；
- Agent 路由和用户可见文案。

页面字段缺失时，调用方必须保留 `partial` 状态和 warning，不能用推断值填补。所有大整数和原始数量保持无损字符串或 bigint 语义。
