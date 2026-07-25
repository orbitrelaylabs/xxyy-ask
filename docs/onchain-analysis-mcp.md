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

开发或小规模验证：

```bash
pnpm onchain:mcp:dev
```

兼容别名：

```bash
pnpm chain:mcp:dev
```

未设置 `ONCHAIN_RPC_CONFIG_JSON` 且 `NODE_ENV` 不是 `production` 时，固定使用：

| Network                 | 默认 RPC                                   |
| ----------------------- | ------------------------------------------ |
| Ethereum mainnet        | `https://ethereum-rpc.publicnode.com`      |
| BNB Smart Chain mainnet | `https://bsc-dataseed-public.bnbchain.org` |
| Base mainnet            | `https://mainnet.base.org`                 |
| Robinhood Chain mainnet | `https://rpc.mainnet.chain.robinhood.com`  |
| Stable mainnet          | `https://rpc.stable.xyz`                   |
| Solana mainnet          | `https://api.mainnet.solana.com`           |

这些地址均来自链方或公开服务文档。Base、Robinhood 和 Solana 明确说明公共 endpoint 会限流或不建议用于生产；Ethereum PublicNode、BSC 和 Stable 默认值同样不提供本项目可依赖的 SLA。参考：

- [BNB Smart Chain JSON-RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)
- [Base network configuration](https://docs.base.org/base-chain/quickstart/connecting-to-base)
- [Robinhood Chain network configuration](https://docs.robinhood.com/chain/connecting/)
- [Stable mainnet information](https://docs.stable.xyz/en/developers/mainnet/mainnet-information)
- [Solana public RPC endpoints](https://solana.com/zh/docs/references/clusters)
- [Ethereum nodes as a service](https://ethereum.org/developers/docs/nodes-and-clients/nodes-as-a-service/)
- [PublicNode Ethereum endpoint](https://ethereum-rpc.publicnode.com/)

这些默认值没有 SLA，可能限流、阻断或缺少历史/trace 能力，只用于开发、演示和小规模验证。`NODE_ENV=production` 时缺少显式配置会启动失败。

## 自定义 RPC

通过进程环境传入严格 JSON；配置只在启动时解析，聊天或 MCP Tool 输入不能传 endpoint、header 或任意 RPC method。

```bash
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
}' pnpm onchain:mcp:dev
```

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
