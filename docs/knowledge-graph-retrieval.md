# 知识图谱与增强检索

XXYY 客服使用 PostgreSQL 内的三路召回，不引入额外图数据库：

1. `pgvector` 语义召回，处理自然语言改写和相近表达。
2. PostgreSQL FTS、Token 与 `pg_trgm` 标题模糊召回，处理产品名、链名、平台名和拼写差异。
3. 证据绑定的知识图谱召回，处理“功能支持哪些链”“某条链有哪些发射平台”等关系问题。

三路候选继续经过既有 RRF、元数据重排、时效性过滤和回答证据校验。知识图谱只扩大检索候选，不直接生成最终答案；最终回答必须引用原始正式知识 Chunk。

## 实体与别名

当前支持 `product`、`feature`、`chain`、`launchpad` 和 `plan`。别名归一化同时用于关键词和语义查询，例如：

- `发射台` → `发射平台`
- `SOL` → `Solana`
- `ETH` → `Ethereum`
- `Robinhood` → `Robinhood Chain`
- `copy trading` → `跟单`

别名不是事实，只用于理解和检索。链与功能是否存在支持关系，必须来自正式证据。

## 发布与治理边界

- 官方文档、官方 X 更新以及审批后发布的 Telegram 知识会在 Chunk 写入时提取关系。
- Telegram 收件箱和知识候选不会直接写入有效图谱。管理后台候选详情只显示关系预览。
- 候选仍需通过可信作者、清洗、重复/冲突检查、审批和 Publication Worker 门禁。
- `/admin` 的“知识图谱”页面可以查看实体、关系、来源证据，并停用或恢复关系。
- 停用关系只会让该关系退出图谱召回，不会删除原始文档和审计证据。
- 全量 ingest 会更新关系并清理已不存在 Chunk 的关系；人工停用状态不会被普通重建覆盖。

## 数据库对象

- `knowledge_chunks.search_vector`：基于规范 Token 的 FTS 向量。
- `knowledge_graph_entities`：规范实体和别名。
- `knowledge_graph_relations`：带来源 Chunk、证据、置信度和治理状态的关系。

数据库迁移由 `pnpm rag:migrate`、`pnpm rag:ingest`、知识刷新 Job或本地同步入口执行。生产 API 仍不负责迁移。

## 验证

```bash
pnpm rag:migrate
pnpm rag:ingest
pnpm rag:evaluate
pnpm check
```

管理接口：

- `GET /admin/api/knowledge-graph/entities`
- `GET /admin/api/knowledge-graph/relations?status=approved`
- `PATCH /admin/api/knowledge-graph/relations/:id`

接口沿用知识管理后台的数据库账号、Session 和 RBAC，不属于公开客服 API。
