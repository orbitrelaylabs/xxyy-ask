# 开发验证

仓库面向单人开发，不配置 GitHub Actions、ESLint 或 Git hooks，也不会在安装依赖时修改
checkout 的 Git 配置。验证由开发者按改动风险手动执行。

## 初始化

```bash
corepack enable
corepack install
pnpm install --frozen-lockfile
```

## 手动检查

完整检查：

```bash
pnpm check
```

该命令依次执行：

- Web build。
- Prettier format check。
- TypeScript typecheck。
- Vitest tests。
- deterministic golden QA。

只修改文档时可先运行 `pnpm format:check`。修改代码或运行逻辑时应运行完整
`pnpm check`；涉及正式产品知识或检索回答逻辑时，继续遵循 `AGENTS.md` 中的同步与评估要求。

## 提交与推送

提交前手动检查 `git status --short`、暂存差异以及是否误包含 `.env`、`.rag/`、数据库、
密钥或构建产物。提交消息继续遵循 `AGENTS.md` 的 Conventional Commits 约定，但仓库不通过
hook 或远程 CI 强制校验。
