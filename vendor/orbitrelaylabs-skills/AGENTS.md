# Repository instructions

This repository contains public, read-only transaction inspection and XXYY evidence diagnosis.

The public product surface is the two self-contained Skill directories and their JSON CLIs. TypeScript under `src/` is build-time implementation only; do not add an SDK, package exports, a daemon, or a required companion service.

- Preserve fixed Explorer and `https://www.xxyy.io` allowlists.
- Never add public RPC, arbitrary endpoints, wallet history, balances, signing, simulation, or execution.
- Keep canonical-pool matching separate from small-liquidity classification.
- Preserve `confirmed | likely | unlikely | insufficient_data` Sandwich semantics.
- Browser-only evidence must remain partial and cannot independently prove confirmed MEV.
- Add tests for behavior changes and run `pnpm check` before delivery.
- Never commit `.env`, browser profiles, screenshots, transaction evidence, or secrets.
- Use Conventional Commits.
