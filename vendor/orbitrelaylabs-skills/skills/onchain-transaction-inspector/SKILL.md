---
name: onchain-transaction-inspector
description: Read basic facts for one user-supplied public transaction on an XXYY-supported chain from fixed Explorer pages with the bundled Chrome/CDP JSON CLI. Use for transaction status, block or slot, timestamp, sender, recipient, fee, value, and token-transfer questions. The Skill does not require RPC or a companion service. Do not use for call traces, wallet-wide history, balances, private transactions, MEV conclusions, signing, simulation, or execution.
---

# Onchain Transaction Inspector

## Runtime prerequisite

Require Node.js 24.16.0 or newer. The bundled script is self-contained and must run directly from the installed Skill; do not install workspace dependencies or clone the source repository.

## Browser prerequisite

All Explorer queries use the host-provided `xxyy-chrome-driver` with an isolated persistent Chrome/Chromium profile. If Chrome or the driver is missing, tell the operator to configure `XXYY_SCREENSHOT_CHROME_EXECUTABLE` and `XXYY_BROWSER_PROFILE_DIRECTORY`, then restart the calling Agent. Do not use a personal browser profile or attempt to bypass human verification. Product-support capabilities remain usable without the browser runtime.

The CLI reuses the persistent `xxyy-onchain-skill-explorer` browser session. If an Explorer requests interactive verification, open the same isolated profile for the operator, wait for confirmation, and retry; do not create a fresh browser context.

Supported mainnets are Solana, Ethereum, BNB Smart Chain, Base, Robinhood Chain, and Stable Chain. Accept only their built-in aliases or allowlisted Explorer transaction URLs; do not accept arbitrary chain IDs or endpoints.

Run:

```bash
node <skill-directory>/scripts/inspect.mjs --reference "<transaction-hash-or-explorer-url>"
```

Add `--network` for a bare ambiguous hash. Prefer an Explorer URL. Return normalized facts and explicitly label `partial` browser evidence as single-source. Do not infer address ownership, intent, profitability, internal calls, or MEV behavior.
