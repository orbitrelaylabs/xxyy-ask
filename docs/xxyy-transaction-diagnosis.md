# XXYY Transaction Diagnosis MCP / Skill

## 定位

该能力处理用户明确提供的一笔公开交易，回答两个问题：是否具备 Sandwich 证据，以及实际成交池是否匹配已声明 canonical pool、是否属于版本化阈值下的小流动性池。它不查询钱包历史、余额、账户或私有订单，不推断地址真实归属，也不提供交易建议。

通用 `onchain-analysis` 继续与 XXYY 产品域解耦。XXYY 页面/API、成交行交叉验证和截图位于独立 `xxyy-onchain-support` MCP 中。

## 包边界

- `@xxyy/xxyy-transaction-diagnosis-core`：无网络 I/O；执行精确十进制流动性比较和 Sandwich 四态投影。
- `@xxyy/xxyy-market-data-adapter`：只访问固定 `https://www.xxyy.io/api/data/search/v3` 和 `/api/data/trades/search`；输入不接受 endpoint、任意 HTTP 方法或任意页面。成交查询不按 maker 过滤，以便在同一受限时间窗内保留目标行前后的最多六条成交，目标行仍必须通过完整哈希和完整 maker 复核。
- `@xxyy/xxyy-onchain-support-mcp`：组合通用 Chain MCP 或固定 Explorer 浏览器证据、XXYY 市场适配器、判定 core 和可选截图提供器。
- `skills/xxyy-transaction-diagnosis`：禁止隐式调用的项目 Skill。

Web 和 Telegram 只通过 `XXYY_BROWSER_PROFILE_DIRECTORY` 注册固定 Explorer 浏览器证据模式，不存在 RPC 回退。两者分别为固定 `web/anonymous`、`telegram/service` 创建 `xxyy.skill.diagnose_transaction → xxyy.mcp.diagnose_transaction` 两条精确授权链。

浏览器模式只打开固定 Explorer 页面并读取页面自身的受限响应，整体交易状态固定为 `partial`。当前覆盖 Solana、Ethereum、BSC、Base、Robinhood Chain 和 Stable Chain；EVM 深度 trace、池状态、反事实损失与攻击者收益不在公开路径采集，因此不会给出 `confirmed`。

## 工具契约

```ts
diagnose_xxyy_transaction({
  reference: string,
  network?: string,
  checks: Array<'sandwich' | 'pool'>,
  swapIndex?: number,
})
```

输出包含：

- 通用 MCP 归一化的交易事实；
- XXYY `exact | conflict | not_found` 成交匹配、全部候选池和最多六条周边成交；
- 可选 `poolAssessment`；
- 可选 `sandwichAssessment`；
- 周边成交的完整 maker、交易哈希、方向、时间、Token/原生币/USD 数量，以及可解析时的区块或 Slot；
- `ready | unavailable` 截图状态、结构化 warning 和整体 `success | partial | insufficient_data`。

`swapIndex` 已保留给多 Swap 的确定性选择；当前数据不能把 XXYY 重复成交行可靠映射到链上指令索引时仍返回 conflict，不按数组顺序猜测。

## 成交匹配

成交只在以下条件成立时视为 exact：完整 transaction ID 精确相等，链匹配，链上唯一 actor 可用时完整 maker 也一致，并且只得到一个可归属的候选池。钱包后六位、时间和金额只用于缩小/展示范围，不能单独建立匹配。

真实联调已观察到 XXYY 可能在多个候选池查询中返回同一完整交易行。适配器只在链上交易账户集合中恰好出现一个候选 pair 时消解该重复；否则返回 `multiple_transaction_matches` conflict，不能把最高流动性或请求使用的 pair 参数当作成交池事实。

## Sandwich 四态

- `confirmed`：完整证据验证同池前/目标/后顺序、同一非目标 actor、方向闭环、受害者反事实损失、攻击者正收益和 actor 资产闭环。
- `likely`：结构模式成立但 coverage 不完整。
- `unlikely`：受支持且完整的 evidence 反驳模式。
- `insufficient_data`：邻域、顺序、池状态、盈亏、actor delta 或来源一致性不足。

EVM 或 Solana 的 XXYY 周边行若在时间上包围目标、解析到同区块/Slot、前后 maker 相同且买卖方向闭环，可支持 `likely`。公开浏览器快照没有池状态和收益/损失证明，因此不能仅凭该结构确认 `confirmed`。

## Pool 结论

`canonicalMatch` 与 `liquidityClass` 是两个独立维度：

- canonical 必须来自独立配置/解析，不能把最高流动性池自动称作 canonical；
- 小池要求实际流动性同时低于绝对阈值和相对主导池 PPM 阈值；默认 policy v1.0.0 为 `10000 USD` 与 `100000 ppm`，可由环境变量覆盖；
- 缺 canonical 声明返回 `unknown`，缺流动性返回 `liquidityClass=unknown`。

canonical 声明通过启动时 `XXYY_CANONICAL_POOL_CONFIG_JSON={"entries":[...]}` 注入，每项固定 `chain`、`tokenAddress` 与 `pairAddress`；同一 chain/token 重复声明会使启动失败。

## 截图证据

截图不是判定来源，但它是诊断成功后的正式用户可见交付物。只有结构化 API 已精确核对完整 transaction ID、完整 maker 和唯一池后，隔离 Chrome 提供器才打开固定 XXYY pair URL，并用 maker 后六位、买卖方向、成交时间、Token/原生币/USD 数量共同为候选行评分；多个候选无法唯一定位时失败关闭，不圈选可能错误的行。生成成功时 MCP 将截图标记为 `required` image attachment；Web 必须内联展示，Telegram 必须发送图片，即使用户的问题中没有“截图”关键词。

截图默认关闭。启用时必须同时配置：

```bash
XXYY_SCREENSHOT_CHROME_EXECUTABLE=/absolute/path/to/chrome
XXYY_SCREENSHOT_DIRECTORY=/isolated/xxyy-evidence
XXYY_SCREENSHOT_PUBLIC_BASE_URL=https://support.example/xxyy-evidence/
```

API 只从该目录公开名称为 64 位小写 SHA-256 加 `.png` 的文件。Chrome 启动失败、页面未显示已验证成交、配置缺失或保存失败都只会返回截图 unavailable，不覆盖结构化结论。容器部署需要显式安装/挂载 Chrome 和独立目录。

## 零 RPC 浏览器模式

公开诊断只需一个隔离、持久的浏览器 Profile：

```bash
XXYY_BROWSER_PROFILE_DIRECTORY=/isolated/xxyy-browser-profile
```

Chrome/Chromium 会从固定系统路径自动发现；非标准安装可复用 `XXYY_SCREENSHOT_CHROME_EXECUTABLE` 指定。Solscan 会阻止全新无状态 headless 会话，因此首次启用前需用同一 Profile 正常打开 Solscan、完成站点验证并关闭该 Chrome，再启动 API/Telegram。不得指向个人日常 Chrome Profile；Profile 目录属于运行时状态，不得提交仓库。页面验证过期或 Cloudflare 再次拦截时返回浏览器证据不可用，不回退到未知 endpoint。

截图交付仍需前述截图目录与公开 URL；Telegram 还需要已有的 `TELEGRAM_PUBLIC_BASE_URL` 能解析相对附件地址。canonical pool 声明和小池阈值均为可选策略配置，不是浏览器访问的前提。
