# XXYY Transaction Diagnosis Runtime / Skill

## 定位

该能力处理用户明确提供的一笔公开交易，回答是否具备 Sandwich 证据、实际成交池是否匹配已声明 canonical pool、是否属于版本化阈值下的小流动性池，并在发现小池或疑似 Sandwich 时给出证据受控的成交偏差估算。它不查询钱包历史、余额、账户或私有订单，不推断地址真实归属，也不提供交易建议。

基础公开交易查询与 XXYY 产品诊断保持解耦。XXYY 页面/API、成交行交叉验证、截图、JSON CLI 和 Skills 位于独立仓库 [orbitrelaylabs/skills](https://github.com/orbitrelaylabs/skills)。该仓库不提供 SDK；本仓库通过固定提交依赖和受限 JSON CLI 子进程桥接集成。

## 包边界

- 独立仓库维护源码中的 diagnosis core：无网络 I/O；执行精确十进制流动性比较和 Sandwich 四态投影。
- 独立仓库维护源码中的 market-data 模块：只访问固定 `https://www.xxyy.io/api/data/search/v3` 和 `/api/data/trades/search`；输入不接受 endpoint、任意 HTTP 方法或任意页面。
- `skills/xxyy-transaction-diagnosis/scripts/diagnose.mjs`：组合固定 Explorer 浏览器证据、XXYY 市场适配器、判定 core 和截图提供器的自包含 JSON CLI。
- `packages/transaction-skill-bridge`：本仓库内部固定路径调用、输入输出校验、取消、超时与输出上限边界。

程序化 HTTP API 和 Telegram 在本机发现 `ego-browser` 后注册固定 Explorer 浏览器证据模式，不存在 RPC 回退。两者分别为固定 `web/anonymous`、`telegram/service` 创建 `xxyy.skill.diagnose_transaction` 精确授权，并通过同一 CLI bridge 调用固定 Skill bundle。公开 Web 客服页面已经移除。

浏览器模式只打开固定 Explorer 页面并读取页面自身的受限响应，整体交易状态固定为 `partial`。当前覆盖 Solana、Ethereum、BNB Smart Chain、Base、Robinhood Chain 和 Stable Chain；六条链全部通过本机 `ego-browser` 复用同一用户验证状态，不再按站点分流到隔离 Chrome。代码只根据已校验交易哈希构造固定 allowlist 页面/API URL，不接受任意 chain ID、用户 endpoint 或页面脚本。EVM 深度 trace、池状态、反事实损失与攻击者收益不在公开路径采集，因此不会给出 `confirmed`。

## 工具契约

```bash
pnpm xxyy:diagnose -- \
  --reference "<transaction-hash-or-explorer-url>" \
  --checks sandwich,pool
```

输出包含：

- 浏览器 runtime 归一化的交易事实；
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
- `unlikely`：完整的相邻成交位置与链上区块/Slot 已解析，且同区块/Slot、同一前后地址或方向闭环中的至少一项明确反驳模式；排除结构不要求无关的池状态或盈亏证据。
- `insufficient_data`：邻域、顺序、池状态、盈亏、actor delta 或来源一致性不足。

EVM 或 Solana 的 XXYY 周边行若在时间上包围目标、解析到同区块/Slot、前后 maker 相同且买卖方向闭环，可支持 `likely`。公开浏览器快照没有池状态和收益/损失证明，因此不能仅凭该结构确认 `confirmed`。

## 用户损失估算

发现小流动性池或 `likely | confirmed` Sandwich 时，客服回答会尝试计算“可观测成交偏差”，而不是声称得到确定性反事实损失：

- 基准固定为目标成交前最近一笔同池、同方向的 XXYY 成交均价；缺少该成交时返回数据不足，不根据流动性大小猜金额；
- 买入偏差为 `实际支付原生币 - 实际获得代币 × 基准单价`，卖出偏差为 `实际卖出代币 × 基准单价 - 实际收到原生币`；只报告大于零的不利偏差；
- 目标成交带有 USD 金额时，用该成交隐含的原生币 USD 单价换算近似美元金额；
- 小池和 Sandwich 同时出现时只计算一次，标注影响不可拆分，不能把金额相加；多池交易只覆盖当前选定分析成交腿；
- 结果不包含 Gas、Token 税、其他路由腿或后续价格波动，也不是无攻击或主导池状态下的反事实报价、赔付依据或攻击者收益证明。

## Pool 结论

`canonicalMatch` 与 `liquidityClass` 是两个独立维度：

- canonical 必须来自独立配置/解析，不能把最高流动性池自动称作 canonical；
- 小池要求实际流动性同时低于绝对阈值和相对主导池 PPM 阈值；默认 policy v1.0.0 为 `10000 USD` 与 `100000 ppm`，可由环境变量覆盖；
- 缺 canonical 声明返回 `unknown`，缺流动性返回 `liquidityClass=unknown`。

canonical 声明通过 `XXYY_CANONICAL_POOL_CONFIG_JSON={"entries":[...]}` 注入，每项固定 `chain`、`tokenAddress` 与 `pairAddress`；同一 chain/token 重复声明会使该次诊断失败关闭。

## 截图证据

截图不是判定来源，但它是诊断成功后的正式用户可见交付物。只有结构化 API 已精确核对完整 transaction ID、完整 maker 和唯一池后，隔离 Chrome 提供器才打开固定 XXYY pair URL，并用 maker 后六位、买卖方向、成交时间、Token/原生币/USD 数量共同为候选行评分；多个候选无法唯一定位时失败关闭，不圈选可能错误的行。生成成功时 runtime 将截图标记为 `required` image attachment；Skill CLI 额外返回绝对 `filePath`，Telegram 必须发送图片，即使用户的问题中没有“截图”关键词。

XXYY 历史成交请求固定带页面使用的 `X-CHAIN`、`X-LANGUAGE` 与 `X-VERSION` 请求头，并从交易时间前后 2 秒开始逐级扩大到 15 秒、120 秒，避免高频池的 50 条响应上限把目标哈希挤出结果。返回的 `blockNumber` 与 `logIndex` 会保留到目标和相邻成交证据中；EVM 周边成交已有这些字段时不再为每一行重复打开 Explorer。

截图提供器调用 XXYY 页面自身 Vue 成交组件的原生历史筛选动作来定位目标时间窗，并且只允许给 XXYY 原生“最新成交”行增加红色轮廓。提供器不会绘制、注入或拼接成交列表，也不会在截图流程中直接请求成交 API；即使结构化查询已返回目标数据，只要站点原生表格没有渲染出可唯一定位的成交行，截图也必须返回 unavailable，不能生成合成证据图。

截图保存前还会检查 TradingView iframe 已返回有效 OHLC 数值，并从原生 K 线 canvas 中检测到实际行情颜色像素；条件必须连续三次稳定。首次超时会强制刷新固定 XXYY 页面，再完整重做历史筛选、目标行居中和 K 线校验；第二次仍未就绪时返回截图 unavailable，不交付空白 K 线图片。

独立 Skill CLI 默认要求截图；本仓库只有在配置可交付目录时启用截图，否则显式传递 `--screenshot disabled` 并返回 `not_configured`。启用时配置 Chrome 和一个隔离目录：

```bash
XXYY_SCREENSHOT_CHROME_EXECUTABLE=/absolute/path/to/chrome
XXYY_SCREENSHOT_DIRECTORY=/isolated/xxyy-evidence
```

API 只从该目录公开名称为 64 位小写 SHA-256 加 `.png` 的文件。Chrome 启动失败、页面未显示已验证成交、配置缺失或保存失败都只会返回截图 unavailable，不覆盖结构化结论。容器部署需要显式安装/挂载 Chrome 和独立目录。

## 零 RPC 浏览器模式

公开交易查询只要求已完成首次引导的 ego-browser：

```bash
command -v ego-browser
```

Solscan、Blockscout 和 Scan 系 Explorer 都通过同一个受控页面读取器访问。API、Telegram 和两个 Skill CLI 分别复用固定命名的持久 Task Space，避免每笔交易创建新浏览器上下文而反复丢失验证状态；页面验证过期或 Cloudflare 再次拦截时返回包含 Task Space 名称的验证提示，不尝试绕过，也不回退到未知 endpoint 或无头 Chrome。`XXYY_SCREENSHOT_CHROME_EXECUTABLE`、`XXYY_BROWSER_PROFILE_DIRECTORY` 和 `XXYY_SCREENSHOT_DIRECTORY` 仅配置 XXYY 原生截图提供器；其隔离 Profile 不得指向个人日常 Chrome Profile，也不得提交仓库。

程序化 API 可通过同源 `/xxyy-evidence/<hash>.png` 获取图片；Telegram 从截图目录读取 PNG 并直接上传，不要求截图公网 URL。canonical pool 声明和小池阈值均为可选策略配置，不是浏览器访问的前提。
