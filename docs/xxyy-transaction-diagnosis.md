# XXYY Transaction Diagnosis MCP / Skill

## 定位

该能力处理用户明确提供的一笔公开交易，回答两个问题：是否具备 Sandwich 证据，以及实际成交池是否匹配已声明 canonical pool、是否属于版本化阈值下的小流动性池。它不查询钱包历史、余额、账户或私有订单，不推断地址真实归属，也不提供交易建议。

通用 `onchain-analysis` 继续与 XXYY 产品域解耦。XXYY 页面/API、成交行交叉验证和截图位于独立 `xxyy-onchain-support` MCP 中。

## 包边界

- `@xxyy/xxyy-transaction-diagnosis-core`：无网络 I/O；执行精确十进制流动性比较和 Sandwich 四态投影。
- `@xxyy/xxyy-market-data-adapter`：只访问固定 `https://www.xxyy.io/api/data/search/v3` 和 `/api/data/trades/search`；输入不接受 endpoint、任意 HTTP 方法或任意页面。
- `@xxyy/xxyy-onchain-support-mcp`：组合通用 Chain MCP、XXYY 市场适配器、判定 core 和可选截图提供器。
- `skills/xxyy-transaction-diagnosis`：禁止隐式调用的项目 Skill。

Web 和 Telegram 只在 `ONCHAIN_RPC_CONFIG_JSON` 存在时注册 `diagnose_xxyy_transaction`，并分别为固定 `web/anonymous`、`telegram/service` 创建 `xxyy.skill.diagnose_transaction → xxyy.mcp.diagnose_transaction` 两条精确授权链。

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
- XXYY `exact | conflict | not_found` 成交匹配和全部候选池；
- 可选 `poolAssessment`；
- 可选 `sandwichAssessment`；
- `ready | unavailable` 截图状态、结构化 warning 和整体 `success | partial | insufficient_data`。

`swapIndex` 已保留给多 Swap 的确定性选择；当前数据不能把 XXYY 重复成交行可靠映射到链上指令索引时仍返回 conflict，不按数组顺序猜测。

## 成交匹配

成交只在以下条件成立时视为 exact：完整 transaction ID 精确相等，链匹配，链上唯一 actor 可用时完整 maker 也一致，并且只得到一个可归属的候选池。钱包后六位、时间和金额只用于缩小/展示范围，不能单独建立匹配。

真实联调已观察到 XXYY 可能在多个候选池查询中返回同一完整交易行。此时适配器返回 `multiple_transaction_matches` conflict；在链上池解析补齐前不能把请求使用的 pair 参数当作成交池事实。

## Sandwich 四态

- `confirmed`：完整证据验证同池前/目标/后顺序、同一非目标 actor、方向闭环、受害者反事实损失、攻击者正收益和 actor 资产闭环。
- `likely`：结构模式成立但 coverage 不完整。
- `unlikely`：受支持且完整的 evidence 反驳模式。
- `insufficient_data`：邻域、顺序、池状态、盈亏、actor delta 或来源一致性不足。

EVM 在 archive/MEV data plane 和 pool allowlist 可用时复用通用 `detect_sandwich`；缺失时降级。当前 Solana 基础 `getTransaction` 快照没有同 slot 完整排序与池状态，因此不能仅凭 XXYY 前后行确认 Sandwich。

## Pool 结论

`canonicalMatch` 与 `liquidityClass` 是两个独立维度：

- canonical 必须来自独立配置/解析，不能把最高流动性池自动称作 canonical；
- 小池要求实际流动性同时低于绝对阈值和相对主导池 PPM 阈值；默认 policy v1.0.0 为 `10000 USD` 与 `100000 ppm`，可由环境变量覆盖；
- 缺 canonical 声明返回 `unknown`，缺流动性返回 `liquidityClass=unknown`。

canonical 声明通过启动时 `XXYY_CANONICAL_POOL_CONFIG_JSON={"entries":[...]}` 注入，每项固定 `chain`、`tokenAddress` 与 `pairAddress`；同一 chain/token 重复声明会使启动失败。

## 截图证据

截图不是判定来源。只有结构化 API 已精确核对完整 transaction ID、完整 maker 和唯一池后，隔离 Chrome 提供器才打开固定 XXYY pair URL、按 maker 后六位定位可视行、加红框和截屏。后六位仅负责定位已经验证的行。

截图默认关闭。启用时必须同时配置：

```bash
XXYY_SCREENSHOT_CHROME_EXECUTABLE=/absolute/path/to/chrome
XXYY_SCREENSHOT_DIRECTORY=/isolated/xxyy-evidence
XXYY_SCREENSHOT_PUBLIC_BASE_URL=https://support.example/xxyy-evidence/
```

API 只从该目录公开名称为 64 位小写 SHA-256 加 `.png` 的文件。Chrome 启动失败、页面未显示已验证成交、配置缺失或保存失败都只会返回截图 unavailable，不覆盖结构化结论。容器部署需要显式安装/挂载 Chrome 和独立目录。
