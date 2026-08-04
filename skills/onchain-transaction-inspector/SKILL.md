---
name: onchain-transaction-inspector
description: Read basic facts for one user-supplied public EVM or Solana transaction from fixed Explorer pages with the bundled browser-only JSON CLI. Use for transaction status, block or slot, timestamp, sender, recipient, fee, value, and token-transfer questions. The Skill does not require RPC or a companion service. Do not use for call traces, wallet-wide history, balances, private transactions, MEV conclusions, signing, simulation, or execution.
---

# Onchain Transaction Inspector

Run:

```bash
node <skill-directory>/scripts/inspect.mjs --reference "<transaction-hash-or-explorer-url>"
```

Add `--network` for a bare ambiguous hash. Prefer an Explorer URL. Return normalized facts and explicitly label `partial` browser evidence as single-source. Do not infer address ownership, intent, profitability, internal calls, or MEV behavior.
