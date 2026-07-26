# 开发质量门禁

`pnpm check` 和 GitHub Actions 是项目的权威质量门禁。仓库内置的 Git hooks 是可选的本地快速反馈层，复用同一套提交消息与检查规则。

## 初始化

安装依赖不会修改当前 checkout 的 Git 配置。需要启用本地 hooks 时显式运行：

```bash
pnpm hooks:install
```

该命令执行 `scripts/setup-git-hooks.mjs`，为当前 checkout 配置：

```bash
git config --local core.hooksPath .githooks
git config --local commit.template "$(pwd)/.gitmessage"
```

如果 checkout 移动了路径或需要重新启用 hooks，再次运行 `pnpm hooks:install`。

## 本地 hooks

### pre-commit

`pre-commit` 读取 Git index 中的暂存快照，不会把未暂存改动混入检查。它会：

- 执行 `git diff --cached --check`，拦截冲突标记和新增尾随空格。
- 对暂存的受支持文本执行 Prettier check。
- 对暂存的 JavaScript、TypeScript、MJS 和 CJS 执行 ESLint，warning 也会阻止提交。
- 拒绝 `.env*`、`.rag/`、`node_modules/`、构建产物、本地数据库和私钥文件；允许 `.env.example` 等模板。
- 拒绝超过 95 MiB 的单个暂存文件，在 GitHub 100 MiB 硬限制前给出明确错误。

格式修复后需要重新 `git add`，因为门禁检查的是暂存版本。可手动运行 `pnpm hook:pre-commit`。

### commit-msg

`commit-msg` 调用 `scripts/validate-commit-message.mjs`，执行 `AGENTS.md` 的 Conventional Commits 规则。破坏性变更必须同时包含标题 `!` 和非空的 `BREAKING CHANGE: ...` footer。

可单独验证消息：

```bash
pnpm commit:check -- "feat(rag): return retrieved media attachments"
```

### pre-push

`pre-push` 从 Git 提供的引用更新中计算真正待推送的 commits，逐个复用 `commit-msg` 校验器，然后运行完整 `pnpm check`。仅删除远程引用时不会重复运行代码检查。可在不实际推送时用 `pnpm hook:pre-push` 运行完整门禁；没有 Git stdin 时会直接执行完整检查。

启用 hooks 后禁止使用 `--no-verify` 绕过它们。无论是否启用 hooks，交付前都必须运行
`pnpm check`，远程合并以 GitHub Actions 结果为准。

## 远程 CI

`.github/workflows/ci.yml` 在以下事件运行：

- 指向 `main` 的 pull request。
- 推送到 `main`。
- GitHub merge queue。
- 手工 `workflow_dispatch`。

工作流使用只读 `contents` 权限、取消同分支旧任务、20 分钟超时、无持久化 checkout 凭据、pnpm 缓存和 frozen lockfile。安装依赖前先验证事件 commit range，随后运行 `pnpm check`。

GitHub 分支保护应把 `Quality gate` 设置为 `main` 的 required status check，并禁止未通过检查的直接合并。
