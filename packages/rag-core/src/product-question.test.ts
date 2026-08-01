import { describe, expect, it } from 'vitest';

import { classifyQuestion } from './classify.js';
import {
  createInitialProductSearchQuery,
  createProductQueryPlan,
  createProductRetrievalPolicy,
  createStandaloneProductQuestion,
  decomposeProductQuestion,
  isCapabilityOverviewQuestion,
  selectNextProductQuery,
  understandProductQuestion,
} from './product-question.js';

describe('product question understanding', () => {
  it.each(['支持哪些功能', 'XXYY 有哪些功能？', '当前都支持什么功能？'])(
    'recognizes broad product capability overviews: %s',
    (question) => {
      const understanding = understandProductQuestion(question, classifyQuestion(question));

      expect(understanding).toMatchObject({
        kind: 'capability_overview',
        subject: 'xxyy_product',
        temporalScope: 'current',
      });
      expect(isCapabilityOverviewQuestion(question)).toBe(true);
      expect(createInitialProductSearchQuery(question, understanding)).toContain(
        'XXYY 当前支持的产品功能总览',
      );
    },
  );

  it('keeps module-specific lists out of the product overview path', () => {
    const question = '扫链筛选支持哪些条件？';
    const understanding = understandProductQuestion(question, classifyQuestion(question));

    expect(understanding.kind).toBe('feature_support');
    expect(createInitialProductSearchQuery(question, understanding)).toBe(question);
  });

  it.each([
    ['XXYY Pro 有哪些权益？', 'plan_entitlement'],
    ['钱包监控最多支持多少地址？', 'limit_or_quota'],
    ['最近更新了什么？', 'recent_updates'],
    ['钱包监控以前支持多少地址？', 'historical_change'],
    ['怎么设置止盈止损？', 'how_to'],
  ] as const)('classifies "%s" as %s', (question, kind) => {
    expect(understandProductQuestion(question, classifyQuestion(question)).kind).toBe(kind);
  });

  it('creates a versioned bounded multi-query plan for capability overviews', () => {
    const question = '支持哪些功能';
    const understanding = understandProductQuestion(question, classifyQuestion(question));
    const plan = createProductQueryPlan(question, question, understanding);

    expect(plan).toMatchObject({
      maxSearches: 3,
      requiredFacets: ['交易', '钱包', '监控', '移动端'],
      strategy: 'multi_query',
      temporalScope: 'current',
      version: '1',
    });
    expect(plan.queries).toHaveLength(3);
    expect(
      selectNextProductQuery(plan, ['钱包', '监控', '移动端'], [plan.queries[0]?.query ?? '']),
    ).toContain('钱包监控');
    expect(createProductRetrievalPolicy(understanding)).toEqual({
      anchorDocumentIds: ['official_docs:pages/00-current-capability-overview'],
      diversity: 'balanced',
      preferredSourceTypes: ['admin_verified', 'official_docs', 'x_updates'],
      temporalScope: 'current',
      version: '1',
    });
  });

  it('prioritizes official X evidence only for update and history intents', () => {
    const updates = understandProductQuestion(
      '最近更新了什么？',
      classifyQuestion('最近更新了什么？'),
    );
    const howTo = understandProductQuestion('怎么设置止损？', classifyQuestion('怎么设置止损？'));

    expect(createProductRetrievalPolicy(updates).preferredSourceTypes[0]).toBe('x_updates');
    expect(createProductRetrievalPolicy(howTo).preferredSourceTypes[0]).toBe('official_docs');
  });

  it('rewrites a bounded contextual follow-up into a standalone product question', () => {
    expect(
      createStandaloneProductQuestion('那免费版呢？', [
        { content: 'XXYY Pro 有哪些权益？', role: 'user' },
        { content: 'XXYY Pro 提供进阶权益。', role: 'assistant' },
      ]),
    ).toBe('XXYY Basic 免费版当前有哪些功能和权益？');
  });

  it('uses a bot-owned reply answer when the original user question is unavailable', () => {
    expect(
      createStandaloneProductQuestion('那免费版呢？', [
        { content: 'XXYY Pro 提供进阶功能和权益。', role: 'assistant' },
      ]),
    ).toBe('XXYY Basic 免费版当前有哪些功能和权益？');
  });

  it('rewrites device and quota follow-ups without copying the whole conversation', () => {
    expect(
      createStandaloneProductQuestion('手机端呢？', [
        { content: '怎么设置止盈止损？', role: 'user' },
        { content: '请进入交易设置。', role: 'assistant' },
      ]),
    ).toBe('XXYY 移动端怎么设置止盈止损');
    expect(
      createStandaloneProductQuestion('有数量限制吗？', [
        { content: 'XXYY 钱包监控怎么设置？', role: 'user' },
      ]),
    ).toBe('XXYY 钱包监控有数量限制吗？');
  });

  it('decomposes a compound request into bounded standalone subquestions', () => {
    const question = 'XXYY Pro 有什么权益，怎么升级，升级后是否永久有效？';
    const understanding = understandProductQuestion(question, classifyQuestion(question));
    const plan = createProductQueryPlan(question, question, understanding);

    expect(decomposeProductQuestion(question)).toEqual([
      expect.objectContaining({ id: 'sq1', question: 'XXYY Pro 有什么权益' }),
      expect.objectContaining({ id: 'sq2', question: 'XXYY Pro 怎么升级' }),
      expect.objectContaining({ id: 'sq3', question: 'XXYY Pro 升级后是否永久有效' }),
    ]);
    expect(plan).toMatchObject({
      maxSearches: 3,
      strategy: 'multi_query',
    });
    expect(plan.queries.map((query) => query.query)).toEqual([
      'XXYY Pro 有什么权益',
      'XXYY Pro 怎么升级',
      'XXYY Pro 升级后是否永久有效',
    ]);
    expect(plan.queries.map((query) => query.topK)).toEqual([6, 8, 6]);
  });

  it('keeps a single how-to request as one dynamically sized query', () => {
    const question = 'XXYY 怎么设置止盈止损？';
    const understanding = understandProductQuestion(question, classifyQuestion(question));
    const plan = createProductQueryPlan(question, question, understanding);

    expect(plan.strategy).toBe('single');
    expect(plan.subquestions).toHaveLength(1);
    expect(plan.queries[0]).toMatchObject({ topK: 8 });
  });
});
