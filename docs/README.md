# xxyy-ask 文档

本文只作为文档导航。运行方式、环境变量和命令以仓库根目录
[README](../README.md) 为准；代理开发约束与安全边界以
[AGENTS](../AGENTS.md) 为准，避免在多个入口重复维护同一份说明。

## 产品、状态与架构

- [目标产品需求与总体设计](target-product-design.md)
- [当前功能状态](feature-status.md)
- [后续 Roadmap](roadmap.md)
- [业务架构](architecture.md)
- [完整 Agent 客服系统 Goal](agent-customer-service-goal.md)
- [Agent 回答质量优化 Goal](agent-answer-quality-goal.md)
- [知识来源与分类](knowledge-sources.md)
- [开发质量门禁](development-workflow.md)

## 产品知识与知识治理

- [Product RAG 种子知识库](product-features/README.md)
- [全自动知识演进与 Knowledge Curator](knowledge-evolution.md)
- [Scheduler-safe Knowledge Refresh](knowledge-refresh-operations.md)
- [评测数据与门禁](eval/README.md)

`product-features/pages/`、`product-features/enriched/`、
`product-features/assets/`、`product-features/source/` 与 manifest
是同步、媒体增强或摄取流程的输入，不是普通项目说明文档，不能按“无 Markdown
引用”删除。

## Agent、MCP 与链上能力

- [MCP / Skill Capability Plane](capability-plane.md)
- [通用 Onchain Analysis MCP / Skills](onchain-analysis-mcp.md)
- [Transaction Analysis Core](transaction-analysis-core.md)
- [Allowlisted EVM Data Adapter](evm-data-adapter.md)
- [EVM Execution Enrichment Core](evm-execution-enrichment.md)
- [Allowlisted EVM Execution Data Adapter](evm-execution-data-adapter.md)
- [EVM Price Impact / Sandwich Detection Core](evm-price-impact-sandwich.md)
- [Allowlisted MEV Observation Data Adapter](evm-mev-observation-data-adapter.md)
- [EVM Chain Analysis Composition & Evaluation Harness](evm-chain-analysis-harness.md)

## 链上生产控制与运维

- [Mainnet Sampling Plan & Evidence Intake](evm-chain-analysis-sampling.md)
- [Sampling Manifest → Reviewed Replay Candidate Handoff](evm-chain-analysis-sampling-handoff.md)
- [Single-owner Review Work Queue](evm-chain-analysis-review-work-queue.md)
- [Reviewed Replay 与 Production Readiness](evm-chain-analysis-readiness.md)
- [Governance Persistence 与 Shared Controls](evm-chain-analysis-control-store.md)
- [Reproducible Readiness Evidence Ledger](evm-chain-analysis-readiness-evidence-ledger.md)
- [Chain Analysis Production Environment & Governance Decision Gate](evm-chain-analysis-production-decision-gate.md)
- [Production Approval & Identity Provisioning](evm-chain-analysis-production-provisioning.md)
- [Control Plane Provisioning 运维](chain-control-provisioning-operations.md)
- [Provider & Worker Data Plane 运维](chain-data-plane-operations.md)
- [生产运行、安全与观测](production-readiness.md)

这些文档分别固定 package contract、授权边界、数据来源、readiness lineage
或运维流程；即使内容相关，也不能在没有同步修改代码、测试和安全契约时合并或删除。

## 保留规则

- 根目录只保留项目入口与代理约束；详细设计统一放在 `docs/`。
- `docs/product-features/` 保留可追溯的正式知识源、manifest 和媒体 sidecar。
- `.rag/`、`dist/`、评测输出和生成图片是本地产物，不提交到仓库。
- 新文档必须在本页归类；已经完成但仍被测试或安全契约引用的 Goal 不作为临时文件删除。
