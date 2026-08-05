# 当前功能状态

## 已完成

- LangGraph 客服 Agent、Product RAG、Postgres + pgvector、OpenAI-compatible chat/embedding。
- Web、HTTP API、Telegram Bot、流式回答、引用、反馈和管理后台。
- 官方产品文档、媒体、X / Twitter 更新的同步、审计、摄取和知识治理。
- Product Support capability：当前 Agent 在应用内直接调用 Product RAG，不维护独立对外 Skill 包装。
- `onchain-transaction-inspector` Skill：用自包含浏览器 JSON CLI 查询用户提供的 EVM/Solana 单笔公开交易基础事实。
- `xxyy-transaction-diagnosis` Skill：用固定 Explorer 与 XXYY 页面分析成交、池子和结构性 Sandwich 模式，并返回用户可见标注截图。
- Capability Registry：固定 manifest/grant、schema、超时、输出限制和脱敏审计；Skill 目录不会自动注册 Planner 工具。
- 交易运行面不要求单独服务、不调用 RPC，也不接受调用方 endpoint。

## 明确边界

- 不查询账户、订单、钱包余额、私有交易、任意地址历史或地址真实归属。
- 不签名、不广播交易，不提供投资建议。
- 浏览器交易事实始终是有限网页证据；不提供 EVM call trace、archive state 或确定性 MEV/损失证明。
- 池子是否 canonical 与池子流动性大小分别判断；没有明确 canonical 声明时不猜测“正确池”。
- 页面验证失败、字段缺失或来源冲突时返回 `partial` / `insufficient_data`。

## 后续

- 持续补充官方知识与回归样本。
- 提升 Explorer/XXYY 页面变化检测、K 线加载等待和截图稳定性。
- 若未来确需深度 trace/archive 分析，应作为单独产品重新评审数据源、成本、审计和部署边界，不在当前浏览器 Skill 中隐式恢复。
