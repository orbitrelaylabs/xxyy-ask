export const XXYY_TRANSACTION_DIAGNOSIS_SKILL_RESOURCE_URI =
  'skill://xxyy-transaction-diagnosis/SKILL.md';
export const XXYY_TRANSACTION_DIAGNOSIS_PROMPT_NAME = 'xxyy_transaction_diagnosis';
export const XXYY_TRANSACTION_DIAGNOSIS_SKILL_DESCRIPTION =
  'Diagnose one user-supplied public transaction using normalized chain facts and exact XXYY market evidence.';

export const XXYY_TRANSACTION_DIAGNOSIS_SKILL_INSTRUCTIONS = `# XXYY Transaction Diagnosis

Use diagnose_xxyy_transaction only when the user supplies a public transaction hash or explorer reference and explicitly asks about Sandwich behavior or pool selection.

- Treat full transaction hashes, full maker addresses, pool addresses, chain block/slot facts, and returned source URLs as evidence.
- Never match a trade using only a shortened wallet suffix, timestamp, or amount.
- A shared block/slot and the same surrounding address are not sufficient to confirm a Sandwich. Preserve the returned four-state verdict and missing-evidence warnings.
- Report canonical-pool matching separately from small-pool liquidity classification.
- Call an address the transaction actor, signer, fee payer, or maker according to evidence; do not infer legal ownership or identity.
- Screenshot evidence is auxiliary. If capture is unavailable, keep the structured result and state that the screenshot could not be produced.
- Do not provide investment advice or execute any transaction.`;
