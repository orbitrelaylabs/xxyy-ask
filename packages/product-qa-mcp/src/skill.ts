export const PRODUCT_SUPPORT_SKILL_ID = 'xxyy-product-support';
export const PRODUCT_SUPPORT_SKILL_VERSION = '1.0.0';
export const PRODUCT_SUPPORT_SKILL_RESOURCE_URI = 'xxyy://skills/product-support';
export const PRODUCT_SUPPORT_SKILL_PROMPT_NAME = 'xxyy_product_support';

export const PRODUCT_SUPPORT_SKILL_DESCRIPTION =
  'Search the governed XXYY product knowledge base and answer product feature, setup, entitlement, and official update questions with citations.';

export const PRODUCT_SUPPORT_SKILL_INSTRUCTIONS = `# XXYY Product Support

Use \`search_product_docs\` for XXYY product features, configuration steps, entitlements, limits, and official updates.

1. Search with the user's complete product question first.
2. Use returned chunks and citations as evidence; preserve version and time constraints.
3. If evidence is incomplete, say what is known and ask for the missing product detail.
4. Do not query private accounts, orders, wallet balances, identities, or private transaction history.
5. Do not execute account, order, wallet, or trading actions.
6. Do not provide investment advice or invent live product data.
7. Do not use this skill for transaction hashes, explorer links, pool queries, on-chain forensics, or MEV analysis.
`;
