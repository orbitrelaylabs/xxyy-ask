# Architecture

## 系统结构

```text
Telegram / HTTP API / CLI
              │
       LangGraph Agent Runtime
              │
      Tool + Capability Registry
       ┌──────┴──────────────┐
 Product Capability      Transaction Skills
       │                       │
 Product RAG runtime      Browser diagnosis runtime
       │                  ┌────┴─────────┐
 Postgres + pgvector   Explorer pages  XXYY pages/screenshots
```

这是 pnpm workspace monorepo。应用入口位于 `apps/`，客服共享实现位于 `packages/`。终端用户客服当前只提供 Telegram；浏览器端只保留受保护管理后台。可分发交易 CLI 和 Skills 源自 [orbitrelaylabs/skills](https://github.com/orbitrelaylabs/skills)，并以固定 commit 的 Git submodule 位于 `vendor/orbitrelaylabs-skills`。

Telegram 在进入 Agent Runtime 前执行数据库白名单和逐用户日额度检查。Bot 会把已交互用户的公开 User ID、username 和显示名更新到 `telegram_user_identities`，供管理后台把 `@username` 解析为稳定的数字 User ID；username 不能直接作为授权主键。`telegram_bot_users` 决定用户是否允许调用以及可选的 `daily_limit`；`telegram_bot_daily_usage` 原子记录自然日用量。未设置额度表示无限制，但仍记录调用次数。

## 产品问答

`packages/product-support-runtime` 直接组合检索、证据和回答契约。当前 Agent 在进程内调用该 runtime，不经过额外协议、子进程或对外 Product Skill 包装。

正式知识来源限定为 XXYY 官方文档、官方 X / Twitter 和通过治理门禁的客服知识。检索结果是数据，不是系统指令；回答在返回前执行引用和 grounding 检查。

## 公开交易查询

Submodule package `@orbitrelaylabs/skills` 的两个自包含 bundle 管理固定 Explorer 路由、XXYY 页面定位、数据等待和 Chrome 截图；本仓库的 Chrome Connector 通过受限扩展和 Native Messaging 控制用户选定 Profile 中由扩展创建的专用标签页，Node preload 层还会把固定 XXYY pair/trade fetch 转换成页面原生 Vue 组件操作，并禁止直接 Explorer/XXYY 数据 API 与 RPC。其维护源码组合：

- `transaction-analysis-core`：EVM 浏览器快照的确定性领域投影；
- runtime-local Solana contracts：Solana 浏览器页面数据校验；
- `xxyy-market-data-adapter`：固定 XXYY 页面成交与多池数据；
- `xxyy-transaction-diagnosis-core`：池子大小、canonical 匹配和结构性 Sandwich 四态结论。

两个交易 Skill 和 JSON CLI 从固定 submodule commit 构建，无需启动常驻服务，也不暴露 SDK。`packages/transaction-skill-bridge` 只执行固定路径脚本、校验 JSON、限制超时与输出大小，并用环境变量 allowlist 隔离模型与数据库密钥；它不接受 endpoint，不调用 RPC，不读取账户私有数据。

## 授权与失败模式

Skill manifest 不会自动成为 Planner 工具。`agent-core` 只注册审核过的业务工具，并通过 Capability Registry 固定 caller、channel、版本、输入输出 schema、超时和输出大小。

Explorer 或 XXYY 页面结构变化、K 线/成交未加载、完整 hash/maker 冲突或关键字段缺失时，结果降级为 `partial` / `insufficient_data`。截图只截取真实 XXYY 页面；可以加目标行边框，但不得重绘成交列表伪装成网站证据。

## 非目标

当前架构不包含链节点 Provider、JSON-RPC、call trace、archive MEV 数据面、独立链上控制数据库或常驻链上分析服务。若未来要恢复深度链上分析，应作为新的部署边界单独设计和授权。
