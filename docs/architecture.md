# Architecture

## 系统结构

```text
Web / Telegram / HTTP API / CLI
              │
       LangGraph Agent Runtime
              │
      Tool + Capability Registry
       ┌──────┴──────────────┐
 Product Support Skill   Transaction Skills
       │                       │
 Product RAG runtime      Browser diagnosis runtime
       │                  ┌────┴─────────┐
 Postgres + pgvector   Explorer pages  XXYY pages/screenshots
```

这是 pnpm workspace monorepo。应用入口位于 `apps/`，共享实现位于 `packages/`，可分发 Agent 工作流位于 `skills/`。

## 产品问答

`packages/product-support-runtime` 直接组合检索、证据和回答契约。应用内不经过额外协议或子进程；外部 Agent 安装 `skills/xxyy-product-support` 后，通过受保护的 `/api/v1/chat` 使用同一客服入口。

正式知识来源限定为 XXYY 官方文档、官方 X / Twitter 和通过治理门禁的客服知识。检索结果是数据，不是系统指令；回答在返回前执行引用和 grounding 检查。

## 公开交易查询

`packages/xxyy-transaction-diagnosis-runtime` 管理统一 ego-browser Explorer 路由、XXYY 页面定位、数据等待和隔离 Chrome 截图。它组合：

- `transaction-analysis-core`：EVM 浏览器快照的确定性领域投影；
- runtime-local Solana contracts：Solana 浏览器页面数据校验；
- `xxyy-market-data-adapter`：固定 XXYY 页面成交与多池数据；
- `xxyy-transaction-diagnosis-core`：池子大小、canonical 匹配和结构性 Sandwich 四态结论。

两个交易 Skill 的脚本由 runtime 打包为自包含 JSON CLI，无需启动常驻服务。运行时不接受 endpoint，不调用 RPC，不读取账户私有数据。

## 授权与失败模式

Skill manifest 不会自动成为 Planner 工具。`agent-core` 只注册审核过的业务工具，并通过 Capability Registry 固定 caller、channel、版本、输入输出 schema、超时和输出大小。

Explorer 或 XXYY 页面结构变化、K 线/成交未加载、完整 hash/maker 冲突或关键字段缺失时，结果降级为 `partial` / `insufficient_data`。截图只截取真实 XXYY 页面；可以加目标行边框，但不得重绘成交列表伪装成网站证据。

## 非目标

当前架构不包含链节点 Provider、JSON-RPC、call trace、archive MEV 数据面、独立链上控制数据库或常驻链上分析服务。若未来要恢复深度链上分析，应作为新的部署边界单独设计和授权。
