import { describe, expect, it } from 'vitest';

import {
  createKnowledgeAliasQueryTokens,
  expandKnowledgeAliasText,
  matchKnowledgeAliases,
} from './knowledge-aliases.js';

describe('knowledge aliases', () => {
  it('normalizes product shorthand without losing the original query', () => {
    expect(expandKnowledgeAliasText('发射台支持哪些链')).toContain('发射平台');
    expect(matchKnowledgeAliases('ETH 和 SOL 支持哪些发射台')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonical: 'Ethereum', type: 'chain' }),
        expect.objectContaining({ canonical: 'Solana', type: 'chain' }),
        expect.objectContaining({ canonical: '发射平台', type: 'feature' }),
      ]),
    );
  });

  it('does not append a canonical name that is already present', () => {
    expect(expandKnowledgeAliasText('XXYY Pro 支持什么？')).toBe('XXYY Pro 支持什么？');
  });

  it('adds canonical tokens for keyword retrieval', () => {
    const tokens = createKnowledgeAliasQueryTokens('robinhood 支持哪些发射台');
    expect(tokens).toEqual(expect.arrayContaining(['robinhood', 'chain', '发射平台']));
  });

  it('does not match short latin aliases inside unrelated words', () => {
    expect(matchKnowledgeAliases('baseball statistics')).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ canonical: 'Base' })]),
    );
  });
});
