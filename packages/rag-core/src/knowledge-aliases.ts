import { tokenize } from '@xxyy/knowledge';

export interface KnowledgeAliasMatch {
  canonical: string;
  matchedAlias: string;
  type: 'chain' | 'feature' | 'launchpad' | 'plan';
}

const KNOWLEDGE_ALIASES = [
  { canonical: 'Solana', type: 'chain', aliases: ['solana', 'sol', 'sol链', 'solana链'] },
  { canonical: 'BSC', type: 'chain', aliases: ['bsc', 'bnb chain', 'bnbchain', '币安智能链'] },
  { canonical: 'Ethereum', type: 'chain', aliases: ['ethereum', 'eth', '以太坊', 'eth链'] },
  { canonical: 'Base', type: 'chain', aliases: ['base', 'base链'] },
  {
    canonical: 'Robinhood Chain',
    type: 'chain',
    aliases: ['robinhood chain', 'robinhood', 'robinhood链'],
  },
  { canonical: 'Stable Chain', type: 'chain', aliases: ['stable chain', 'stable', 'stable链'] },
  {
    canonical: '发射平台',
    type: 'feature',
    aliases: ['发射平台', '发射台', 'launchpad', 'launch platform'],
  },
  { canonical: '跟单', type: 'feature', aliases: ['跟单', 'copy trading', 'copy trade'] },
  { canonical: '扫链', type: 'feature', aliases: ['扫链', 'scan', 'scanner'] },
  {
    canonical: '钱包监控',
    type: 'feature',
    aliases: ['钱包监控', '钱包监听', 'wallet monitoring'],
  },
  { canonical: '挂单', type: 'feature', aliases: ['挂单', '限价单', 'limit order'] },
  { canonical: 'Pump', type: 'launchpad', aliases: ['pump', 'pump.fun', 'pumpfun'] },
  { canonical: 'LetsBonk', type: 'launchpad', aliases: ['letsbonk', 'bonkfun', 'bonk.fun'] },
  {
    canonical: 'Raydium Launchlab',
    type: 'launchpad',
    aliases: ['raydium launchlab', 'launchlab'],
  },
  { canonical: 'Four.meme', type: 'launchpad', aliases: ['four.meme', 'fourmeme'] },
  { canonical: 'Klik', type: 'launchpad', aliases: ['klik'] },
  { canonical: 'Noxa', type: 'launchpad', aliases: ['noxa'] },
  { canonical: 'Virtuals', type: 'launchpad', aliases: ['virtuals'] },
  { canonical: 'Bankr', type: 'launchpad', aliases: ['bankr'] },
  { canonical: 'Varo', type: 'launchpad', aliases: ['varo'] },
  { canonical: 'XXYY Pro', type: 'plan', aliases: ['xxyy pro', 'pro会员', 'pro套餐'] },
] as const satisfies readonly {
  aliases: readonly string[];
  canonical: string;
  type: KnowledgeAliasMatch['type'];
}[];

export function matchKnowledgeAliases(text: string): KnowledgeAliasMatch[] {
  const normalized = normalizeAliasText(text);
  const matches: KnowledgeAliasMatch[] = [];
  for (const entry of KNOWLEDGE_ALIASES) {
    const matchedAlias = entry.aliases.find((alias) => containsAlias(normalized, alias));
    if (matchedAlias !== undefined) {
      matches.push({ canonical: entry.canonical, matchedAlias, type: entry.type });
    }
  }
  return matches;
}

export function expandKnowledgeAliasText(text: string): string {
  const normalizedText = normalizeAliasText(text);
  const canonicalTerms = matchKnowledgeAliases(text)
    .map((match) => match.canonical)
    .filter((canonical) => !containsAlias(normalizedText, canonical));
  return canonicalTerms.length === 0 ? text : `${text} ${canonicalTerms.join(' ')}`;
}

export function createKnowledgeAliasQueryTokens(text: string): string[] {
  return Array.from(new Set(tokenize(expandKnowledgeAliasText(text))));
}

export function aliasesForCanonicalName(canonicalName: string): string[] {
  const entry = KNOWLEDGE_ALIASES.find((candidate) => candidate.canonical === canonicalName);
  return entry === undefined ? [] : [...entry.aliases];
}

function normalizeAliasText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[_/]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function containsAlias(normalizedText: string, alias: string): boolean {
  const normalizedAlias = normalizeAliasText(alias);
  if (/^[a-z0-9 .-]+$/u.test(normalizedAlias)) {
    const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u').test(normalizedText);
  }
  return normalizedText.includes(normalizedAlias);
}
