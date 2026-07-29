# Onchain Analysis MCP / Skills

`onchain-analysis` 是与 XXYY 产品域解耦的只读 MCP server。XXYY 可以作为一个宿主为它配置 Capability grant，但 MCP、Tool、Resource、Prompt 和两个 Skills 不使用 XXYY 命名，也不依赖 Product RAG。

## 内置网络

内置网络与 XXYY 当前主站的六条链对齐，但仍使用通用 CAIP-2/EIP-155 标识：

| Network         | Canonical network | 常用别名                | Explorer URL 解析          |
| --------------- | ----------------- | ----------------------- | -------------------------- |
| Solana mainnet  | `solana:mainnet`  | `sol`、`solana`         | Solscan、Solana Explorer   |
| Ethereum        | `eip155:1`        | `eth`、`ethereum`       | Etherscan                  |
| BNB Smart Chain | `eip155:56`       | `bsc`、`bnb`            | BscScan                    |
| Base            | `eip155:8453`     | `base`                  | Basescan、Base Blockscout  |
| Robinhood Chain | `eip155:4663`     | `robin`、`robinhood`    | Robinhood Chain Blockscout |
| Stable Chain    | `eip155:988`      | `stable`、`stablechain` | Stablescan                 |

`get_transaction` 支持以上六条链。`inspect_transaction` 支持其中五条 EVM 链；Solana 当前只返回交易、费用、账户原生余额变化、SPL Token 余额变化和程序 ID。任意其它启动时配置的 EVM 仍可通过 `eip155:<chainId> + transaction hash` 查询。

`detect_sandwich` 只适用于 EVM，而且某条链必须另外配置 archive Provider、factory/pool allowlist、同区块 observation 和兼容的 Uniswap V2/V3 语义后才会出现在 capabilities 中。六链基础查询支持不代表六链 Sandwich 已默认启用。

`get_transaction` 接受支持的 Explorer URL，或接受显式 `network` 与原始 transaction id。URL 仅用于确定网络、校验 transaction id 和生成规范 Explorer 链接；交易事实来自启动时配置的 RPC Provider。

Etherscan V2 与 Solscan Pro API 都需要 API key，因此不作为“免费默认数据源”。未来如需 token 标签、合约验证状态或 Explorer 独有索引字段，应作为可选 enrichment adapter 接入，不能替代 RPC 事实或把 API key 放进工具输入。参考：

- [Etherscan V2 Getting Started](https://docs.etherscan.io/getting-started)
- [Etherscan multichain API](https://docs.etherscan.io/metadata-api/)
- [Solscan Pro API key](https://docs.solscan.io/api-access/how-to-generate-your-solscan-pro-api-key)
- [Solana getTransaction](https://solana.com/docs/rpc/http/gettransaction)

## 启动

先从模板创建本地配置：

```bash
cp .env.example .env
```

然后启动开发或小规模验证入口：

```bash
pnpm onchain:mcp:dev
```

兼容别名：

```bash
pnpm chain:mcp:dev
```

该入口自动读取工作区根目录 `.env`，同名 shell 环境变量优先。`ONCHAIN_RPC_CONFIG_JSON` 在所有 `NODE_ENV` 下都必填；运行时代码不内置 RPC endpoint，也不会按开发/生产环境选择 Provider。

根目录 `.env.example` 提供以下可直接启动的便利配置：

| Network                 | `.env.example` 公共 RPC                    |
| ----------------------- | ------------------------------------------ |
| Ethereum mainnet        | `https://ethereum-rpc.publicnode.com`      |
| BNB Smart Chain mainnet | `https://bsc-dataseed-public.bnbchain.org` |
| Base mainnet            | `https://mainnet.base.org`                 |
| Robinhood Chain mainnet | `https://rpc.mainnet.chain.robinhood.com`  |
| Stable mainnet          | `https://rpc.stable.xyz`                   |
| Solana mainnet          | `https://api.mainnet.solana.com`           |

这些地址均来自链方或公开服务文档。Base、Robinhood 和 Solana 明确说明公共 endpoint 会限流或不建议用于生产；Ethereum PublicNode、BSC 和 Stable 示例值同样不提供本项目可依赖的 SLA。参考：

- [BNB Smart Chain JSON-RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)
- [Base network configuration](https://docs.base.org/base-chain/quickstart/connecting-to-base)
- [Robinhood Chain network configuration](https://docs.robinhood.com/chain/connecting/)
- [Stable mainnet information](https://docs.stable.xyz/en/developers/mainnet/mainnet-information)
- [Solana public RPC endpoints](https://solana.com/zh/docs/references/clusters)
- [Ethereum nodes as a service](https://ethereum.org/developers/docs/nodes-and-clients/nodes-as-a-service/)
- [PublicNode Ethereum endpoint](https://ethereum-rpc.publicnode.com/)

这些示例值没有 SLA，可能限流、阻断或缺少历史/trace 能力，只用于开发、演示和小规模验证。基础交易查询的生产配置沿用同一 `ONCHAIN_RPC_CONFIG_JSON` 结构，但应将 endpoint 替换为有配额和 SLA 的托管 Provider。深度生产数据面不能直接使用该便利配置绕过 readiness-gated composition。任何环境缺少该变量都会启动失败。

## 自定义 RPC

直接编辑根目录 `.env` 中的严格 JSON，或通过进程环境覆盖；配置只在启动时解析，聊天或 MCP Tool 输入不能传 endpoint、header 或任意 RPC method。

```dotenv
ONCHAIN_RPC_CONFIG_JSON='{
  "evm": [
    {
      "chainId": "1",
      "providers": [
        {
          "id": "ethereum_primary",
          "endpoint": "https://your-ethereum-rpc.example"
        }
      ]
    },
    {
      "chainId": "56",
      "providers": [
        {
          "id": "bsc_primary",
          "endpoint": "https://your-bsc-rpc.example"
        }
      ]
    },
    {
      "chainId": "8453",
      "providers": [
        {
          "id": "base_primary",
          "endpoint": "https://your-base-rpc.example"
        }
      ]
    },
    {
      "chainId": "4663",
      "providers": [
        {
          "id": "robinhood_primary",
          "endpoint": "https://your-robinhood-rpc.example"
        }
      ]
    },
    {
      "chainId": "988",
      "providers": [
        {
          "id": "stable_primary",
          "endpoint": "https://your-stable-rpc.example"
        }
      ]
    }
  ],
  "solana": {
    "network": "solana:mainnet",
    "providers": [
      {
        "id": "solana_primary",
        "endpoint": "https://your-solana-rpc.example"
      }
    ]
  }
}'
```

保存 `.env` 后启动：

```bash
pnpm onchain:mcp:dev
```

开发或小规模验证时，严格 JSON 还接受两个可选字段：

- `execution`：`EvmExecutionChainConfig[]`，显式配置 Uniswap V2/V3 factory allowlist。Provider 默认使用固定 `debug_traceTransaction/callTracer`；也可以增加 `traceSource: { kind: "blockscout_v2", ... }`，改由启动时 allowlist 中的 Blockscout `/api/v2/transactions/:hash/raw-trace` 获取调用追踪。
- `mevObservation`：`EvmMevObservationChainConfig[]`，显式配置声明 `archive: true` 的 Provider，以及包含协议、token、fee 和 route policy 的 pool allowlist。

这两个字段不会从 `evm` 自动推导，避免把普通公共 RPC 误认为 trace/archive Provider。没有 `execution` 时，`inspect_transaction` 仍可返回 transaction snapshot，但 trace coverage 会明确为 `not_provided`；没有 `mevObservation` 时，不启用 `detect_sandwich`。

`NODE_ENV=production` 下，公开运行时只接受所有 execution Provider 都显式配置 `blockscout_v2` trace source 的组合，并把 Explorer trace 强制标为 `partial`。生产环境中的 RPC callTracer 配置和全部 `mevObservation` 仍失败关闭，必须使用 `chain:mcp:serve` 的 readiness-gated composition。公开 Explorer 追踪能改善客服可见性，但不等于 archive、多 Provider 对账或 production readiness。

## Robinhood Chain 公共数据与协议范围

`.env.example` 为 Robinhood Chain（chain id `4663`）配置：

- 官方限流公共 RPC `https://rpc.mainnet.chain.robinhood.com`：基础交易、回执、区块和有界只读合约调用。
- 公共 Blockscout `https://robinhoodchain.blockscout.com`：调用追踪；输出始终带单源部分证据警告。
- Uniswap V2 factory `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f`。
- Uniswap V3 factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`。

当前协议策略按 Robinhood 官方生态、XXYY 已展示的发射台和 GMGN 的 Robinhood 交易样本收敛：

| 协议面                                     | 当前处理                                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Uniswap V2 / V3                            | 识别 Swap topic；只有 pool/factory/token/fee 与 factory 反查通过时才完整解码                                                                    |
| Uniswap V4                                 | 识别 `PoolManager` Swap 格式；缺少已验证 PoolKey、Hook 与 singleton 状态时明确标为未安全解码，不输出方向或 MEV 结论                             |
| Rialto                                     | 作为 Robinhood 官方列出的 PropAMM / Aggregator 记录在支持候选中；尚无固定公开合约清单，不猜测成交协议                                           |
| Bags                                       | 已识别已验证 `BagsBondingCurve` 的 `TokensBought` / `TokensSold` 事件格式；当前不误标为标准 DEX，缺少版本化池清单与代币元数据时不推断方向或 MEV |
| Noxa、Virtuals、Bankr、Pons、Flap、Clanker | 视为 XXYY/GMGN 覆盖的发射台或内盘协议，不误标为标准 DEX；在获得版本化合约、事件 ABI 和迁移池规则后逐项接入                                      |

因此，普通 Robinhood 交易和调用树目前可查；Uniswap V2/V3 可在元数据可验证时展开；V4 和 Bags 内盘会显示“识别但未安全解码”，其它发射台在取得可验证 ABI 与合约清单后再接入。公共 RPC 不配置 `mevObservation`，所以不会用不完整证据生成 `confirmed`、`likely` 或 `unlikely` Sandwich 结论。

## XXYY 内部 CLI 集成

开发环境可以通过固定的 `cli/admin` 调用链验证完整 Capability bridge：

```bash
pnpm onchain:query -- transaction --reference <explorer-url>
pnpm onchain:query -- transaction --reference <transaction-id> --network <network>
pnpm onchain:query -- inspect --chain-id <id> --transaction-hash <0x...>
pnpm onchain:query -- sandwich --chain-id <id> --transaction-hash <0x...> --pool-address <0x...>
```

该入口在同一进程内执行 `ToolRegistry → Skill capability → MCP capability → linked MCP transport → onchain-analysis handler`，不会把 MCP discovery 自动注册到公开 Planner。它只使用启动时的 RPC allowlist，不接受 endpoint、credential 或任意 RPC method；`NODE_ENV=production` 时失败关闭。

生产内部查询使用同样的显式子命令，但改走 readiness-gated stdio MCP：

```bash
NODE_ENV=production pnpm onchain:query:production -- transaction --reference <explorer-url>
NODE_ENV=production pnpm onchain:query:production -- inspect --chain-id <id> --transaction-hash <0x...>
NODE_ENV=production pnpm onchain:query:production -- sandwich --chain-id <id> --transaction-hash <0x...> --pool-address <0x...>
```

`onchain:query:production` 固定使用 `cli/admin` grant，启动前校验 data-plane 与 readiness 配置，再通过子进程 stdio 连接 `chain:mcp:serve`。它不读取项目 `.env`，仅传递生产配置 allowlist；门禁失败时不回退到开发 MCP、`ONCHAIN_RPC_CONFIG_JSON` 或公共 RPC。

## Web 与 Telegram 只读链上分析

API 与 Telegram 启动时若存在 `ONCHAIN_RPC_CONFIG_JSON`，会分别以固定的 `web/anonymous` 和 `telegram/service` 身份为三项工具创建六条精确授权。Docker Compose 会把该变量和 `ONCHAIN_ALLOW_INSECURE_LOCALHOST` 显式映射给这两个服务；变量缺失时产品客服保持可用，公开链上分析则明确返回配置提示。

- `chain.skill.get_transaction`
- `chain.mcp.get_transaction`
- `chain.skill.inspect_transaction`
- `chain.mcp.inspect_transaction`
- `chain.skill.detect_sandwich`
- `chain.mcp.detect_sandwich`

用户提供支持的 Explorer URL，或网络名称与原始 transaction id 后，客服运行时通过确定性路由调用对应能力：

- 基础查询一次最多处理三笔并按 network + transaction id 去重，展示状态、区块、地址、金额、手续费与有限数量的公开 Token 转账。
- “调用追踪 / 内部调用 / revert / 深度分析”等请求一次只处理一笔 EVM 交易，展示有界 trace coverage、内部原生币转账、回滚和已验证 Swap；Solana 深度请求会要求改用 EVM 交易。
- “被夹 / Sandwich / MEV”等请求一次只处理一笔 EVM 交易。用户可以提供“池子地址 0x…”；未提供时只在 inspection 产生唯一已验证 pool 时自动选择，否则要求澄清。pool 还必须位于服务端 allowlist。
- `insufficient_data` 不附来源链接；`partial` 明确提示证据缺口；缺 trace/archive/pool 不能映射成 positive 或 negative verdict。

公开运行面不接受 endpoint、Provider id、任意 RPC method、地址历史、任意区块范围或私有账户输入，也不执行任意池发现、地址归属、交易模拟、签名或发送。

生产配置应至少使用独立 Provider、secret manager、共享预算/熔断、缓存、持久审计、监控和告警。现有：

```bash
pnpm onchain:mcp:serve
```

仍是 XXYY 的 readiness-gated production composition：它要求固定 manifest、独立 control DB、完整 Provider/budget lineage 和未过期的 canonical `ready` attestation。通用 MCP 命名不削弱这条生产门禁。

## Skills

- `skills/onchain-transaction-inspector`：路由六条内置链的 Explorer，或显式 network + transaction id，先调用 `get_transaction`；EVM 需要更深证据时再调用 `inspect_transaction`。
- `skills/evm-sandwich-detector`：覆盖 Ethereum、BSC、Base、Robinhood Chain、Stable Chain 以及其它已配置 EVM；先解析并检查交易，只能从验证过的 swap evidence 选择一个 pool，再调用 `detect_sandwich`。

两个 Skills 默认都禁止隐式调用。Skill metadata 不是权限来源；具体 MCP host 仍需显式安装 server、审核 manifest 并配置 grant。

## 安全边界

- 只允许预定义的只读 RPC 操作；不提供 generic RPC proxy。
- 不从工具输入接受 endpoint、Provider id、credential、任意 block range 或私有账户数据。
- 不推断地址所有权、身份或意图。
- 不签名、发送、替换、取消或模拟交易。
- 不把 `partial`、Provider conflict 或 `insufficient_data` 表述成确定结论。
- 免费 RPC 能完成基础交易查询，不代表能可靠完成 Sandwich 检测；后者需要完整同区块排序、transaction-boundary pool state、actor delta 与 archive coverage。
