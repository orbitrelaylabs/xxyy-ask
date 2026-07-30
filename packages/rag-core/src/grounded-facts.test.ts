import { describe, expect, it } from 'vitest';

import type { RetrievedChunk } from './retrieve.js';
import {
  extractGroundedFacts,
  formatGroundedFactsForPrompt,
  shouldBlockOnGroundedFactConflicts,
  validateGroundedFactScope,
} from './grounded-facts.js';

describe('grounded facts', () => {
  it('extracts scoped facts with evidence provenance', () => {
    const report = extractGroundedFacts('XXYY Pro 钱包监控上限是多少？', [
      chunk('current-pro', 'XXYY Pro 当前最多可以监控 2000 个钱包。'),
    ]);

    expect(report).toMatchObject({
      conflicts: [],
      version: '1',
    });
    expect(report.facts).toContainEqual(
      expect.objectContaining({
        claim: 'XXYY Pro 当前最多可以监控 2000 个钱包。',
        evidenceIds: ['current-pro'],
        scope: expect.stringContaining('Pro'),
        status: 'current',
        subject: '钱包监控上限',
        unit: '个',
        value: '2000',
      }),
    );
    expect(formatGroundedFactsForPrompt(report.facts)).toContain('evidence=current-pro');
  });

  it('reports conflicting current numeric facts in the same scope', () => {
    const report = extractGroundedFacts('XXYY Pro 钱包监控上限是多少？', [
      chunk('current-2000', 'XXYY Pro 当前最多可以监控 2000 个钱包。'),
      chunk('current-3000', 'XXYY Pro 当前最多可以监控 3000 个钱包。'),
    ]);

    expect(report.conflicts).toEqual([
      {
        evidenceIds: ['current-2000', 'current-3000'],
        subject: '会员 / Pro / 钱包监控上限',
        values: ['2000', '3000'],
      },
    ]);
  });

  it('does not treat historical values as current conflicts', () => {
    const report = extractGroundedFacts('XXYY Pro 钱包监控上限历史变化', [
      chunk('historical-3000', 'XXYY Pro 当时最多可以监控 3000 个钱包。', {
        status: 'historical',
      }),
      chunk('current-2000', 'XXYY Pro 当前最多可以监控 2000 个钱包。'),
    ]);

    expect(report.conflicts).toEqual([]);
    expect(report.facts.map((fact) => fact.status)).toEqual(
      expect.arrayContaining(['current', 'historical']),
    );
  });

  it('honors explicit supersedes metadata when reconciling current facts', () => {
    const report = extractGroundedFacts('XXYY Pro 钱包监控上限是多少？', [
      chunk('old-current', 'XXYY Pro 当前最多可以监控 3000 个钱包。'),
      chunk('new-current', 'XXYY Pro 当前最多可以监控 2000 个钱包。', {
        supersedes: ['old-current'],
      }),
    ]);

    expect(report.conflicts).toEqual([]);
  });

  it('does not mistake one source enumerating several allowed values for a conflict', () => {
    const report = extractGroundedFacts('K 线支持哪些秒级周期？', [
      chunk('kline-list', 'K 线支持 1 秒、5 秒和 15 秒周期。', {
        module: '行情',
      }),
    ]);

    expect(report.conflicts).toEqual([]);
  });

  it('blocks relevant numeric conflicts without blocking incidental numbers in a settings list', () => {
    const numericValidation = validateGroundedFactScope(
      '钱包监控上限是多少？',
      extractGroundedFacts('钱包监控上限是多少？', [chunk('limit', '钱包监控上限是 2000 个钱包。')])
        .facts,
    );
    const settingsValidation = validateGroundedFactScope(
      'Swap 可以设置哪些内容？',
      extractGroundedFacts('Swap 可以设置哪些内容？', [
        chunk('settings', '可以设置 4 个金额档位。', { title: 'Swap' }),
      ]).facts,
    );

    expect(shouldBlockOnGroundedFactConflicts('钱包监控上限是多少？', numericValidation)).toBe(
      true,
    );
    expect(shouldBlockOnGroundedFactConflicts('Swap 可以设置哪些内容？', settingsValidation)).toBe(
      false,
    );
  });

  it('keeps structured list continuations when the selected chunk heading matches the question', () => {
    const report = extractGroundedFacts('如何设置挂单交易？', [
      chunk(
        'limit-order',
        [
          '挂单条件包括：',
          '挂单',
          '狙击',
          '价格上涨：设置上涨百分比。',
          '价格下跌：设置下跌百分比。',
          '有效时间：设置挂单有效小时数。',
        ].join('\n'),
        { headingPath: ['挂单交易'], title: '挂单交易' },
      ),
    ]);

    expect(report.facts.map((fact) => fact.claim)).toEqual(
      expect.arrayContaining([
        '挂单',
        '狙击',
        '价格上涨：设置上涨百分比。',
        '价格下跌：设置下跌百分比。',
        '有效时间：设置挂单有效小时数。',
      ]),
    );
  });

  it('keeps all governed capability catalog facets as grounded facts', () => {
    const report = extractGroundedFacts('支持哪些功能', [
      chunk(
        'capability-overview',
        '标准客服回答：XXYY 当前功能主要包括：1. Swap 和挂单；2. 数据分析；3. 钱包监控；4. 移动端登录。',
        {
          headingPath: ['当前功能总览'],
          title: 'XXYY 当前支持的产品功能总览',
        },
      ),
    ]);

    expect(report.facts.map((fact) => fact.claim).join(' ')).toContain('钱包监控');
    expect(report.facts.map((fact) => fact.claim).join(' ')).toContain('移动端登录');
  });

  it('keeps sibling section labels when a question asks for page areas', () => {
    const report = extractGroundedFacts('扫链页面有哪些区域？', [
      chunk('scan-new-pairs', '是指 Pump 项目新发射的所有项目。', {
        headingPath: ['扫链页面', '新交易对'],
        title: '扫链页面',
      }),
    ]);

    expect(report.facts.map((fact) => fact.claim)).toContain(
      '新交易对：是指 Pump 项目新发射的所有项目。',
    );
  });

  it('keeps factual continuation lines in a relevant X update paragraph', () => {
    const report = extractGroundedFacts('XXYY 跟单支持哪些链？', [
      chunk(
        'copy-trading-update',
        [
          '跟单功能上线。',
          '',
          '支持6大公链，SOL、BSC、Base、ETH、XLayer、Plasma。',
          '输入地址即可查看利润、胜率数据，判断是否值得跟单。',
          '',
          '欢迎留言，祝大家发财。',
        ].join('\n'),
        {
          headingPath: ['X Post'],
          sourceType: 'x_updates',
          title: 'X Post 1',
        },
      ),
    ]);
    const claims = report.facts.map((fact) => fact.claim);

    expect(claims).toContain('支持6大公链，SOL、BSC、Base、ETH、XLayer、Plasma。');
    expect(claims.join(' ')).not.toContain('祝大家发财');
  });

  it('rejects facts from another explicit plan and historical facts for a current question', () => {
    const basicFacts = extractGroundedFacts('Basic 钱包监控上限', [
      chunk('basic-limit', 'XXYY Basic 当前最多可以监控 50 个钱包。'),
    ]).facts;
    const historicalFacts = extractGroundedFacts('Pro 钱包监控历史上限', [
      chunk('historical-limit', 'XXYY Pro 当时最多可以监控 3000 个钱包。', {
        status: 'historical',
      }),
    ]).facts;

    expect(
      validateGroundedFactScope('XXYY Pro 当前钱包监控上限是多少？', [
        ...basicFacts,
        ...historicalFacts,
      ]),
    ).toMatchObject({
      acceptedFacts: [],
      rejectedEvidenceIds: ['basic-limit', 'historical-limit'],
      requiresNumericValue: true,
      valid: false,
      version: '1',
    });
  });

  it('allows historical evidence when the question explicitly asks for history', () => {
    const facts = extractGroundedFacts('Pro 钱包监控历史上限', [
      chunk('historical-limit', 'XXYY Pro 当时最多可以监控 3000 个钱包。', {
        status: 'historical',
      }),
    ]).facts;

    expect(validateGroundedFactScope('XXYY Pro 以前钱包监控上限是多少？', facts)).toMatchObject({
      acceptedFacts: [expect.objectContaining({ status: 'historical', value: '3000' })],
      valid: true,
    });
  });

  it('inherits permanent Pro scope from the document title for sibling benefit sections', () => {
    const facts = extractGroundedFacts('永久 PRO 比普通 Pro 额外多什么？', [
      chunk('permanent-extra', '**支持定制化功能开发**\n**专属客服随时答疑**', {
        headingPath: ['在PRO权益的基础上享受'],
        module: 'XXYY Pro 权益',
        title: '永久PRO',
      }),
    ]).facts;
    const validation = validateGroundedFactScope('永久 PRO 比普通 Pro 额外多什么？', facts);

    expect(validation.valid).toBe(true);
    expect(validation.rejectedEvidenceIds).toEqual([]);
    expect(validation.acceptedFacts.map((fact) => fact.claim)).toEqual([
      '支持定制化功能开发',
      '专属客服随时答疑',
    ]);
  });
});

function chunk(
  id: string,
  text: string,
  metadata: Partial<RetrievedChunk['metadata']> = {},
): RetrievedChunk {
  return {
    documentId: `document-${id}`,
    embedding: [],
    id,
    lexicalScore: 1,
    metadata: {
      file: `docs/${id}.md`,
      headingPath: ['钱包监控'],
      module: '会员',
      sourceType: 'official_docs',
      status: 'current',
      title: 'XXYY Pro 权益',
      ...metadata,
    },
    rank: 1,
    score: 1,
    sourceBoost: 0,
    text,
    tokens: [],
    vectorScore: 0,
  };
}
