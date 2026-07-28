# Scheduler-safe Knowledge Refresh

## 定位

`pnpm rag:refresh` 是官方文档、官方 X / Twitter 和客服群候选知识的一次性自动更新 Job，不是常驻 daemon。cron、systemd timer、Kubernetes CronJob 或云调度器负责按计划启动它。API 和客服 Agent 只读正式知识；Telegram Bot 可以创建、自动决定候选并写入发布队列，但不执行迁移、embedding 或 pgvector 发布。

该入口只执行仓库内固定 allowlist 命令，不接受任意 shell command、URL、endpoint、header 或 credential 参数。

## 模式

先用 dry-run 验证部署中的命令计划：

```bash
pnpm rag:refresh -- --dry-run
pnpm rag:refresh -- --dry-run --full
```

dry-run 不运行子命令、不获取写锁，也不写运行回执。

日常增量刷新：

```bash
pnpm rag:refresh
```

固定步骤：

1. `pnpm x:scrape`
2. `pnpm rag:sync:x`
3. `pnpm rag:knowledge:automation:work -- --limit 20`

官网、媒体和 X 的低频全量刷新：

```bash
pnpm rag:refresh -- --full
```

固定步骤：

1. `pnpm docs:sync`
2. `pnpm docs:enrich:media`
3. `pnpm docs:audit`
4. `pnpm x:scrape -- --full`
5. `pnpm rag:ingest`
6. `pnpm rag:knowledge:automation:work -- --limit 20`

`--skip-scrape` 只用于已经由受控上游准备好源文件的恢复或重放：增量模式执行 `rag:sync:x` 后运行知识自动化，全量模式执行 `rag:ingest` 后运行知识自动化。它不会从任意外部目录导入内容。

最后一步会自动决定异常遗留的 `pending`，为 `approved` 候选幂等补建发布任务，重试尝试次数少于 3 的失败任务，并最多执行 20 条发布。它不会放宽身份、内容或发布门禁；达到重试上限的任务保持失败。

任一步返回非零或无法启动，Job 立即停止并以非零退出；后续步骤不会运行。抓取或审计在最终 ingest 前失败时，线上 pgvector 保持原版本，但工作区中的源文件可能已经变化，需要先审阅差异再重试。命令不会自动创建 Git commit 或 push。

## 防重入

实际运行会在以下位置获取 mode `0600` 的排他锁：

```text
.rag/knowledge-refresh/refresh.lock
```

- 同一工作区已有活跃 Job 时，新 Job 失败关闭。
- 同机锁记录的 PID 已不存在时，可以回收该 stale lock。
- 无法验证另一主机 PID 时，只在锁文件已超过 6 小时后视为 stale。
- release 会核对随机 token；旧 Job 不能删除后来 Job 的锁。

该锁只保护一个共享工作区，不是分布式数据库锁。多副本部署必须同时在外部调度器设置 `Forbid`/single concurrency，并让增量与全量任务共享同一个 concurrency group。不要依赖 6 小时兜底去协调跨主机任务。

## 脱敏运行回执

每次实际运行都生成稳定 run id，并原子写入：

```text
.rag/knowledge-refresh/latest.json
.rag/knowledge-refresh/receipts/<run-id>.json
```

回执只包含：

- version、run id、增量/全量模式、开始和结束时间；
- `planned | succeeded | failed` 状态与退出码；
- 固定 allowlist 步骤的 label、`pnpm` 参数、时间、退出码和 `nonzero_exit | command_error`；
- 失败时的固定步骤名称。

回执不会保存 stdout/stderr、异常原文、环境变量、数据库地址、模型 endpoint、token 或 credential。`.rag/` 已被 Git 忽略；这些本地回执用于调度告警和排障，不替代数据库中的 ingestion run。

## 客服端状态展示

Web 页头和 Telegram `/status` 可以只读展示外部 scheduler 的运行状态。设置
`KNOWLEDGE_AUTO_REFRESH_ENABLED=true` 后，两端读取
`.rag/knowledge-refresh/latest.json`，显示增量/全量计划、最近刷新时间和结果；Docker
Compose 将该回执目录以只读方式挂载到 API 和 Telegram 容器。

状态展示不会启动、停止或修改 scheduler，也不会给公开客服增加知识写入权限。成功回执超过
`KNOWLEDGE_AUTO_REFRESH_STALE_AFTER_MINUTES` 后显示为延迟；最近回执失败、缺失或无法解析时分别显示失败、等待首次刷新或状态不可用。只有外部调度确实安装后才能把 enabled
标志设为 true，不能用静态标志替代 scheduler 和回执监控。

## 单人阶段推荐调度

对于当前单人维护阶段：

- 当前部署按 `Asia/Shanghai` 每日 08:00 运行一次增量 `pnpm rag:refresh`；
- 全量更新不配置定时任务，只在官网/媒体结构显著变化、发布前重建或明确需要时手动运行
  `pnpm rag:refresh -- --full`；
- 调度器把非零退出视为失败并通知维护者；
- 监控 `latest.json` 的 `status`、`finishedAt` 和预期新鲜度；
- 全量 Job 前确认工作区可写、Postgres 已备份且 embedding 配置稳定；
- 定期执行 `pnpm rag:stats` 和 `pnpm rag:evaluate -- --provider` 做自动健康检查，并对长期 `failed` PublicationJob 建立告警。

调度器应使用受控工作目录和平台 secret 注入环境变量，不在 crontab、命令参数、回执或仓库中写密钥。不可变生产镜像可把该命令作为独立 release/CronJob 运行，但需要为官方源文件提供受控可写工作区；API 容器本身不应获得该写权限。

## 故障处理

1. 查看调度器退出码和 `.rag/knowledge-refresh/latest.json` 的 `failedStep`。
2. 查看该步骤自己的受控日志；回执不会复制可能含敏感信息的输出。
3. 确认没有仍在运行的同工作区 Job，不要手工删除活跃锁。
4. 若同机进程已退出，下一次运行会自动回收锁；跨主机锁未到 6 小时时先核实远端任务。
5. 检查抓取造成的工作区差异，修复来源、Provider 或数据库问题后重跑相同模式。
6. 用 `pnpm rag:stats` 确认 ingestion run 和 chunk 时间，再执行必要的问答抽查。

如果 receipt 写入失败，Job 也会以失败结束；知识步骤可能已经成功，因此必须结合数据库 ingestion run 核对，而不是盲目重复全量重建。
