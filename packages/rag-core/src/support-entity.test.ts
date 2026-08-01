import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from './retrieve.js';
import {
  SUPPORT_ENTITY_EVIDENCE_BOOST,
  extractSupportEntityTokens,
  formatRetrievedChunksDebug,
  isSupportQuestionText,
  latinTokenEditDistance,
  supportEntityEvidenceBoost,
  textMatchesAllSupportEntities,
  textMatchesSupportEntity,
} from './support-entity.js';

describe('support entity helpers', () => {
  it('detects support questions and extracts latin entity tokens', () => {
    expect(isSupportQuestionText('当前支持robinhood么')).toBe(true);
    expect(isSupportQuestionText('支持哪些发射平台？')).toBe(true);
    expect(isSupportQuestionText('XXYY 跟单支持哪些链？')).toBe(true);
    expect(isSupportQuestionText('copy trading 支持哪些 chain？')).toBe(true);
    expect(isSupportQuestionText('Does XXYY support Robinhood?')).toBe(true);
    expect(isSupportQuestionText('钱包监控怎么设置')).toBe(false);

    expect(extractSupportEntityTokens('当前支持Robinhood么')).toEqual(['robinhood']);
    expect(extractSupportEntityTokens('XXYY 支持 OP 吗？')).toEqual(['op']);
    expect(extractSupportEntityTokens('钱包监控怎么设置')).toEqual([]);
  });

  it('matches long latin entities with one-character typos', () => {
    expect(latinTokenEditDistance('robinhood', 'robinbood')).toBe(1);
    expect(textMatchesSupportEntity('Robinbood 链更新 支持扫链', 'robinhood')).toBe(true);
    expect(textMatchesSupportEntity('Robinhood 上线一周', 'robinhood')).toBe(true);
    expect(textMatchesAllSupportEntities('XXYY 支持 Copy Trading', ['op'])).toBe(false);
    expect(textMatchesSupportEntity('XXYY 支持 Base 链', 'robinhood')).toBe(false);
  });

  it('boosts evidence that contains the support entity', () => {
    expect(supportEntityEvidenceBoost('Robinbood 链更新 支持扫链', ['robinhood'])).toBe(
      SUPPORT_ENTITY_EVIDENCE_BOOST,
    );
    expect(supportEntityEvidenceBoost('支持查看持仓量前100的所有地址', ['robinhood'])).toBe(0);
  });

  it('formats retrieve debug lines with entity hits', () => {
    const chunks: RetrievedChunk[] = [
      createChunk({
        id: 'generic-support',
        lexicalScore: 6,
        rank: 1,
        score: 3.5,
        text: '支持查看持仓量前100的所有地址。',
        title: 'Holder',
        vectorScore: 0.4,
      }),
      createChunk({
        id: 'robinhood-post',
        lexicalScore: 1,
        rank: 2,
        score: 1.2,
        text: '👀 Robinhood 上线一周\n已经有超过1700万笔交易',
        title: 'X Post 1',
        vectorScore: 0.35,
      }),
    ];

    const debug = formatRetrievedChunksDebug(chunks, {
      question: '当前支持robinhood么',
    });

    expect(debug).toContain('Support entities: robinhood');
    expect(debug).toContain('entity=no');
    expect(debug).toContain('entity=yes');
    expect(debug).toContain('robinhood-post');
  });
});

function createChunk(input: {
  id: string;
  lexicalScore: number;
  rank: number;
  score: number;
  text: string;
  title: string;
  vectorScore: number;
}): RetrievedChunk {
  return {
    documentId: input.id,
    embedding: [],
    id: input.id,
    lexicalScore: input.lexicalScore,
    metadata: {
      file: `${input.id}.md`,
      headingPath: [],
      module: 'test',
      sourceType: 'x_updates',
      title: input.title,
    },
    rank: input.rank,
    score: input.score,
    sourceBoost: 0,
    text: input.text,
    tokens: [],
    vectorScore: input.vectorScore,
  };
}
