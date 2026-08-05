# Skill Capability Plane

项目使用显式 Capability Registry 控制 Agent 可以调用的业务能力。Skill 是面向 Agent 的工作流和分发单元，协议层不是能力前提。

## 当前能力

| 能力                            | 应用内实现                                     | 外部接入                  | 数据来源                   |
| ------------------------------- | ---------------------------------------------- | ------------------------- | -------------------------- |
| Product Support                 | `product-support-runtime` 直接调用 Product RAG | 不提供独立 Skill          | 正式产品知识库             |
| `onchain-transaction-inspector` | 固定 Skill CLI 子进程桥接                      | 独立仓库 JSON CLI / Skill | 固定 Explorer 页面         |
| `xxyy-transaction-diagnosis`    | 固定 Skill CLI 子进程桥接                      | 独立仓库 JSON CLI / Skill | 固定 Explorer 与 XXYY 页面 |

## 调用原则

- Planner 只能看到代码显式注册的工具，扫描 Skill 目录不会自动扩权。
- Capability manifest 固定 id、版本、来源、输入输出 schema 和数据范围。
- Web/API、Telegram 和 CLI 使用各自固定 principal 与 channel grant。
- 输入在工具边界重新校验；超时、取消、输出大小和脱敏审计由 registry 统一处理。
- 产品问答由当前 Agent 在同一进程直接调用检索 runtime，不维护额外的对外 Skill 包装。
- 交易工具只接受用户明确给出的单笔公开交易引用，不接受调用方提供 endpoint。
- 浏览器证据缺失或来源冲突时返回 `partial` 或 `insufficient_data`，不能升级为确定性结论。

## 链上边界

公开交易能力不调用 RPC，不提供 call trace、archive state、钱包历史、余额、地址归属或确定性 MEV 证明。XXYY 被夹判断只基于目标成交及其前后成交的结构模式；截图是用户可见证据附件，也是判定可追溯材料。
