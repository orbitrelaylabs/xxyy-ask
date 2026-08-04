# xxyy-ask

XXYY 客服 Agentic RAG monorepo。系统用 LangGraph JS 编排产品问答，并对用户明确提供的公开交易执行浏览器只读查询与 XXYY 成交诊断。

项目提供三个可独立接入的 Agent Skills：

- `xxyy-product-support`：通过受保护 Chat API 使用正式 Product RAG。
- `onchain-transaction-inspector`：通过自包含浏览器 CLI 查询单笔 EVM/Solana 交易基础事实。
- `xxyy-transaction-diagnosis`：通过自包含浏览器 CLI 查询 XXYY 成交、池子和结构性 Sandwich 模式，返回真实 XXYY 标注截图。

交易 Skill 不要求部署额外服务，不调用 RPC，也不接受调用方 endpoint。浏览器证据不能提供 call trace、archive state 或确定性 MEV/损失证明。

## 仓库结构

```text
apps/
  api/             HTTP API、Web 静态资源和管理面
  cli/             RAG ingest/sync/evaluate/ask
  telegram-bot/    Telegram Bot 与知识整理 Worker
  web/             聊天 UI
packages/
  agent-core/      LangGraph runtime、tools 和 Capability Registry
  product-support-runtime/  Product RAG 直接检索 runtime
  knowledge/       文档加载、切分和 embedding
  rag-core/        检索、向量库、回答和边界回复
  xxyy-transaction-diagnosis-runtime/  浏览器交易查询、XXYY 诊断和截图
  xxyy-transaction-diagnosis-core/     池子与结构性 Sandwich 领域判断
  xxyy-market-data-adapter/            固定 XXYY 页面数据适配
  transaction-analysis-core/           EVM 浏览器快照领域分析
  shared/          共享契约
skills/
  xxyy-product-support/
  onchain-transaction-inspector/
  xxyy-transaction-diagnosis/
docs/              架构、状态和产品知识
```

## 环境

需要 Node `24.16.0` 和 pnpm `11.17.0`。先复制环境模板并填写模型与数据库配置：

```bash
cp .env.example .env
pnpm install --frozen-lockfile
```

产品问答的主要配置：

```bash
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=...
POSTGRES_DB=xxyy_ask
POSTGRES_USER=xxyy
POSTGRES_PASSWORD=...
```

embedding 可用 `EMBEDDING_API_KEY`、`EMBEDDING_BASE_URL` 和 `OPENAI_EMBEDDING_MODEL` 独立配置；缺省回退到相应 `OPENAI_*`。

浏览器交易能力不需要 RPC。可选配置：

```bash
XXYY_SCREENSHOT_CHROME_EXECUTABLE=
XXYY_BROWSER_PROFILE_DIRECTORY=
XXYY_SCREENSHOT_DIRECTORY=
XXYY_CANONICAL_POOL_CONFIG_JSON='{"entries":[]}'
```

Chrome 可执行文件为空时自动检测。浏览器使用隔离持久 profile；若 Explorer 有真人验证，需要先在该 profile 中完成。`XXYY_SCREENSHOT_DIRECTORY` 同时供 Web 返回图片和 Telegram 上传 PNG 使用，不需要公共图片 URL。

## 启动

```bash
pnpm run app:dev
```

常用启动方式：

```bash
pnpm run app:dev -- --ingest     # 启动前摄取现有知识
pnpm run app:dev -- --sync       # 空库 bootstrap + 增量官方更新
pnpm run app:dev -- --full-sync  # 全量官网/媒体/X 同步并重建
pnpm run telegram:dev
pnpm telegram:curation:worker
```

生产模式下 `NODE_ENV=production pnpm run app:dev` 不自动启动本地 Docker，也不默认刷新知识库。

## 使用 Skills

### 产品支持

先为 `/api/v1` 创建集成 key，并启动 API：

```bash
pnpm agent:api-key:create -- partner-agent
```

外部 Agent 安装 `skills/xxyy-product-support` 后可执行：

```bash
XXYY_SUPPORT_API_BASE_URL=http://127.0.0.1:3000 \
XXYY_SUPPORT_API_KEY=... \
node skills/xxyy-product-support/scripts/ask.mjs \
  --question "XXYY Pro 有哪些权益？" --pretty
```

### 基础交易查询

```bash
pnpm onchain:inspect -- \
  --reference https://bscscan.com/tx/0x1359025e91b50d561a02f1d368b8b104e4ef40c56f21ec44b0d9a5e6d8830242 \
  --pretty
```

### XXYY 交易诊断

```bash
pnpm xxyy:diagnose -- \
  --reference https://bscscan.com/tx/0x1359025e91b50d561a02f1d368b8b104e4ef40c56f21ec44b0d9a5e6d8830242 \
  --checks sandwich,pool --pretty
```

诊断会访问固定 Explorer 和 XXYY 页面，等待关键页面数据，定位目标成交及相邻行，并生成真实整页标注截图。页面字段不完整时返回 `partial` 或 `insufficient_data`。

重新构建自包含交易脚本：

```bash
pnpm onchain:skill:build
pnpm xxyy:skill:build
```

## 知识库命令

```bash
pnpm docs:sync
pnpm docs:enrich:media
pnpm docs:audit
pnpm rag:migrate
pnpm rag:ingest
pnpm rag:sync:x
pnpm rag:refresh
pnpm rag:stats
pnpm rag:evaluate
pnpm rag:ask -- "XXYY Pro 有哪些权益？"
```

正式知识只接受 `docs.xxyy.io`、`x.com/useXXYYio` 和通过治理门禁的客服知识。API 服务端不负责生产迁移或正式知识写库。

## 验证

```bash
pnpm check
```

该命令执行 Web build、format check、workspace typecheck、测试和 deterministic golden QA。

## API 与边界

- `GET /health`：存活检查。
- `GET /health/deep`：模型、知识库和向量检索检查。
- `POST /api/chat`、`POST /api/chat/stream`：公开客服问答。
- `/api/v1/*`：使用独立 Bearer Key 的外部 Agent API。
- `GET /admin`、`/admin/api/*`：数据库管理员账号和 RBAC 保护的知识治理面。
- `GET /xxyy-evidence/*`：同源返回已生成的 PNG 证据。

系统不查询账户、订单、余额、私有交易、任意地址历史或地址真实归属，不签名或广播交易，不提供投资建议。详细设计见 [docs/README.md](docs/README.md)。
