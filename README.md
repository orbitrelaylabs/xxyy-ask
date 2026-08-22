# xxyy-ask

XXYY 客服 Agentic RAG monorepo。系统用 LangGraph JS 编排产品问答，并对用户明确提供的公开交易执行浏览器只读查询与 XXYY 成交诊断。

产品问答由当前 Agent 在进程内直接调用 Product RAG。交易能力源自 [orbitrelaylabs/skills](https://github.com/orbitrelaylabs/skills)，并以固定 commit 的 Git submodule 保存在 `vendor/orbitrelaylabs-skills`：

- `onchain-transaction-inspector`：通过自包含浏览器 CLI 查询单笔 EVM/Solana 交易基础事实。
- `xxyy-transaction-diagnosis`：通过自包含浏览器 CLI 查询 XXYY 成交、池子和结构性 Sandwich 模式，返回真实 XXYY 标注截图。

交易 Skill 不要求部署额外服务，不调用 RPC，也不接受调用方 endpoint。浏览器证据不能提供 call trace、archive state 或确定性 MEV/损失证明。

## 仓库结构

```text
apps/
  api/             HTTP API 和管理面服务入口
  cli/             RAG ingest/sync/evaluate/ask
  telegram-bot/    Telegram Bot 与知识整理 Worker
  web/             仅用于受保护管理后台的 React UI
packages/
  agent-core/      LangGraph runtime、tools 和 Capability Registry
  product-support-runtime/  Product RAG 直接检索 runtime
  knowledge/       文档加载、切分和 embedding
  rag-core/        检索、向量库、回答和边界回复
  shared/          共享契约
  transaction-skill-bridge/  固定 Skill JSON CLI 子进程桥接
docs/              架构、状态和产品知识

external dependency:
  vendor/orbitrelaylabs-skills  @orbitrelaylabs/skills Git submodule
```

## 环境

需要 Node `24.18.0` 和 pnpm `11.17.0`。先复制环境模板并填写模型与数据库配置：

```bash
cp .env.example .env
git submodule update --init --recursive
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

所有公开 Explorer 查询统一使用仓库自带的 Chrome/CDP 驱动。宿主机默认发现 Google Chrome，容器默认使用 `/usr/bin/chromium`；可显式确认浏览器版本：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
# 或：/usr/bin/chromium --version
```

未安装 Chrome/Chromium 不影响产品知识问答，但所有公开交易查询都会返回配置提示。当前固定支持 Solana、Ethereum、BNB Smart Chain、Base、Robinhood Chain 和 Stable Chain。

Chrome/CDP 只导航固定 Explorer和 XXYY页面，从 DOM/Vue原生组件提取事实并生成浏览器证据，不直接调用 Explorer API、XXYY数据 API或 RPC。`XXYY_BROWSER_PROFILE_DIRECTORY` 下的 `explorer-chrome` 子目录保存独立验证状态；同一根目录仍供 XXYY原生截图使用。Chrome可执行文件为空时自动检测；`XXYY_SCREENSHOT_DIRECTORY/explorer` 保存按页面 URL哈希命名的浏览器 PNG，目录根部的 XXYY证据 PNG供 Telegram上传，不需要公共图片 URL。

需要公开链上查询时，可只在 Docker 中运行 PostgreSQL，并在宿主机运行 API 与 Telegram，使所有 Explorer 共用同一个独立 Chrome Profile：

```bash
docker compose up -d postgres
docker compose stop api telegram

# 终端 1
pnpm run app:dev

# 终端 2
pnpm run telegram:dev
```

这种模式不需要 MCP、Explorer API 或 RPC。检测到 Cloudflare 验证时系统会明确提示人工验证，不会自动绕过。使用 `pnpm explorer:verify -- <Explorer交易URL>` 打开同一个隔离 Chrome 完成人工验证；维护时可用 `pnpm explorer:stop` 关闭持久浏览器。`/health/deep` 会将缺少 Chrome/Chromium 标记为不可用于可靠 Explorer 查询。

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

## 使用交易能力

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

JSON CLI 和 Skill 由 `vendor/orbitrelaylabs-skills` submodule 固定到审核过的上游 commit。该包不提供 SDK；本仓库只通过受限子进程桥接调用两个构建完成的 bundle。更新时先在 Skill 仓库提交并推送，再在本仓库提交新的 submodule 指针。

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

该命令执行管理后台 build、format check、workspace typecheck、测试和 deterministic golden QA。

## API 与边界

- `GET /health`：存活检查。
- `GET /health/deep`：模型、知识库和向量检索检查。
- `GET /`：跳转到受保护的 `/admin`，不再提供公开 Web 客服页面。
- `POST /api/chat`、`POST /api/chat/stream`：保留的程序化客服 API；当前终端用户客服只开发 Telegram 端。
- `/api/v1/*`：使用独立 Bearer Key 的外部 Agent API。
- `GET /admin`、`/admin/api/*`：数据库管理员账号和 RBAC 保护的知识治理面。
- `GET /xxyy-evidence/*`：同源返回已生成的 PNG 证据。

系统不查询账户、订单、余额、私有交易、任意地址历史或地址真实归属，不签名或广播交易，不提供投资建议。详细设计见 [docs/README.md](docs/README.md)。

Telegram Bot 使用数据库白名单。管理员在 `/admin` 的“Telegram 用户”页面可使用数字 User ID，或使用已先向 Bot 发送过消息的 `@username` 添加允许调用的用户；实际权限始终绑定稳定的数字 User ID。管理员可为每个用户设置每日对话次数，额度留空表示无限制。未加入白名单或已禁用的用户不能调用客服 Agent。额度自然日时区由 `TELEGRAM_DAILY_QUOTA_TIME_ZONE` 配置，默认 `Asia/Shanghai`。
