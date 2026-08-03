# Browser-only Onchain Diagnosis MCP / Skill

公开客服的链上查询已统一为浏览器证据模式。Web、Telegram 与开发 stdio MCP 不读取 RPC 配置、不接受 endpoint，也不会回退到公共或托管 RPC。

## 公开能力

用户提供交易哈希或受支持的 Explorer 链接后，系统按以下顺序处理：

1. 在代码固定 allowlist 中选择 Explorer，以隔离的持久 Chrome Profile 打开页面。
2. 从页面或浏览器加载到的 Explorer JSON 页面提取交易哈希、链、区块/slot、时间、状态、from/to、手续费与可见 Token 地址。
3. 用交易时间、地址、Token 和哈希访问 XXYY 最新成交页，定位目标交易及前后成交。
4. 对“是否被夹”只做同区块/slot、同池、同地址和相反方向的结构性判断；缺少池状态、行为者资产变化或盈亏证据时返回 `likely` 或 `insufficient_data`，不能返回伪造的确认结论。
5. 对“是否买错池子”返回实际池、候选池、流动性和小池策略结果；“正确池”必须来自 `XXYY_CANONICAL_POOL_CONFIG_JSON` 的治理声明，不能把最大池自动当作正确池。
6. 精确匹配成交后生成带目标行标注的 XXYY PNG 截图，既作为查证附件，也作为面向用户的回答附件。

固定浏览器来源目前包括：

| 链              | 浏览器来源                     | 证据限制                                     |
| --------------- | ------------------------------ | -------------------------------------------- |
| Solana          | Solscan 页面及其浏览器网络响应 | 新 Profile 可能要求人工完成一次页面验证      |
| Ethereum        | Ethereum Blockscout JSON 页面  | 单源、partial                                |
| Base            | Base Blockscout JSON 页面      | 单源、partial                                |
| Robinhood Chain | Robinhood Blockscout JSON 页面 | 单源、partial                                |
| BNB Smart Chain | BscScan 交易页面               | 需要已通过站点验证的 Profile；字段缺失则降级 |
| Stable Chain    | Stablescan 交易页面            | 需要已通过站点验证的 Profile；字段缺失则降级 |

## 配置

本地运行至少配置：

```dotenv
XXYY_BROWSER_PROFILE_DIRECTORY=/absolute/path/to/isolated-profile
```

Chrome/Chromium 会从固定系统路径自动发现，也可以复用截图配置中的 `XXYY_SCREENSHOT_CHROME_EXECUTABLE`。Profile 必须专用于该服务，不能与日常浏览器或另一个并发进程共用。

截图需要同时配置：

```dotenv
XXYY_SCREENSHOT_CHROME_EXECUTABLE=/absolute/path/to/chrome
XXYY_SCREENSHOT_DIRECTORY=/absolute/path/to/evidence
```

Web 使用同源 `/xxyy-evidence/<hash>.png` 显示截图；Telegram 直接上传目录中的 PNG 字节，因此不需要截图公网 URL。

池子策略可选配置：

```dotenv
XXYY_SMALL_POOL_MAX_LIQUIDITY_USD=10000
XXYY_SMALL_POOL_MAX_RELATIVE_LIQUIDITY_PPM=100000
XXYY_CANONICAL_POOL_CONFIG_JSON='{"entries":[]}'
```

启动：

```bash
pnpm onchain:mcp:dev
# 兼容别名
pnpm chain:mcp:dev
```

Docker 镜像包含 Chromium，API 与 Telegram 使用独立的持久命名卷，避免 Profile 锁冲突。若目标站点要求交互式验证，需要先在对应 Profile 中完成验证；验证未完成时链上诊断明确返回不可用或数据不足。

## 证据边界

- 浏览器证据始终是单源 `partial`，页面字段缺失不能靠猜测补全。
- 公开路径不提供 EVM call trace、archive block state、任意地址历史或任意区块扫描。
- 浏览器前后成交模式不等于已证明攻击者获利或受害者损失。
- `confirmed` Sandwich 必须有本方案当前不采集的池状态、完整交易顺序、行为者资产闭环和盈亏证据，因此公开浏览器路径不会输出该结论。
- Explorer 页面变化、Cloudflare 验证或 XXYY 页面变化都必须以清晰的降级结果暴露，不能静默切换到 RPC。

仓库中保留的离线交易分析 core 与隔离的历史 readiness/control-plane 包不属于公开客服运行路径，也不会被 API、Telegram 或开发 MCP 调用。
