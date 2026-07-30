import { describe, expect, it } from 'vitest';

import {
  extractEvidenceFacets,
  isAllowedSearchQueryRewrite,
  observeProductEvidence,
  queryTargetsMissingFacet,
} from './evidence-observation.js';

describe('evidence observation', () => {
  it('accepts one cited result for a normal product question', () => {
    expect(
      observeProductEvidence(
        'XXYY Pro 有哪些权益？',
        [attempt('XXYY Pro 有哪些权益？', ['pro'], ['pro-source'], ['XXYY Pro 提供独享节点。'])],
        4,
      ),
    ).toMatchObject({
      complexity: 'single_part',
      shouldContinue: false,
      stopReason: 'sufficient',
      sufficient: true,
    });
  });

  it('requires broad capability overviews to cover core facets with authoritative evidence', () => {
    const xOnly = observeProductEvidence(
      '支持哪些功能',
      [
        attempt(
          '支持哪些功能',
          ['x-1', 'x-2'],
          ['x-source-1', 'x-source-2'],
          ['支持 BSC 快捷交易和挂单。', '支持钱包监控和移动端登录。'],
          ['x_updates', 'x_updates'],
        ),
      ],
      4,
    );

    expect(xOnly).toMatchObject({
      authoritativeCitationCount: 0,
      authoritativeOverviewCitationCount: 0,
      coverage: 1,
      nextAction: 'continue_search',
      questionKind: 'capability_overview',
      shouldContinue: true,
      sourceTypes: ['x_updates'],
      sufficient: false,
      version: '1',
      xCitationCount: 2,
    });

    const authoritative = observeProductEvidence(
      '支持哪些功能',
      [
        attempt(
          'XXYY 当前支持的产品功能总览',
          ['docs-1', 'docs-2'],
          ['docs-source-1', 'docs-source-2'],
          ['交易和钱包功能。', '钱包监控、移动端登录。'],
          ['official_docs', 'official_docs'],
        ),
      ],
      4,
    );

    expect(authoritative).toMatchObject({
      authoritativeCitationCount: 2,
      authoritativeOverviewCitationCount: 0,
      coveredFacets: ['交易', '钱包', '监控', '移动端'],
      nextAction: 'answer',
      questionKind: 'capability_overview',
      sourceTypes: ['official_docs'],
      stopReason: 'sufficient',
      sufficient: true,
      xCitationCount: 0,
    });

    const catalog = observeProductEvidence(
      '支持哪些功能',
      [
        attempt(
          'XXYY 当前支持的产品功能总览',
          ['catalog'],
          ['catalog-source'],
          ['XXYY 当前支持的产品功能总览：交易、钱包、监控、移动端。'],
          ['official_docs'],
        ),
      ],
      4,
    );

    expect(catalog).toMatchObject({
      authoritativeCitationCount: 1,
      authoritativeOverviewCitationCount: 1,
      stopReason: 'sufficient',
      sufficient: true,
    });
  });

  it('identifies an uncovered comparison facet and proposes a bounded follow-up query', () => {
    const observation = observeProductEvidence(
      '请比较 XXYY Pro 权益和钱包管理上限',
      [
        attempt(
          '请比较 XXYY Pro 权益和钱包管理上限',
          ['pro'],
          ['pro-source'],
          ['XXYY Pro 权益包括独享节点。'],
        ),
      ],
      4,
    );

    expect(observation).toMatchObject({
      complexity: 'multi_part',
      coveredFacets: ['XXYY Pro 权益'],
      missingFacets: ['钱包管理上限'],
      shouldContinue: true,
      sufficient: false,
      suggestedQuery: 'XXYY 钱包管理上限',
    });
  });

  it('accepts multi-part evidence only after every extracted facet is covered', () => {
    const observation = observeProductEvidence(
      '请比较 XXYY Pro 权益和钱包管理上限',
      [
        attempt('XXYY Pro 权益', ['pro'], ['pro-source'], ['XXYY Pro 权益包括独享节点。']),
        attempt(
          '钱包管理上限',
          ['wallet'],
          ['wallet-source'],
          ['钱包管理：每条链最多创建 100 个交易钱包。'],
        ),
      ],
      4,
    );

    expect(observation).toMatchObject({
      coveredFacets: ['XXYY Pro 权益', '钱包管理上限'],
      missingFacets: [],
      stopReason: 'sufficient',
      sufficient: true,
    });
  });

  it('stops when a distinct rewritten query returns no new chunk or citation', () => {
    const observation = observeProductEvidence(
      '请比较 XXYY Pro 权益和钱包管理上限',
      [
        attempt('XXYY Pro 权益', ['pro'], ['pro-source'], ['XXYY Pro 权益包括独享节点。']),
        attempt(
          '钱包管理上限',
          ['pro'],
          ['pro-source-with-a-different-excerpt'],
          ['XXYY Pro 权益包括独享节点。'],
        ),
      ],
      4,
    );

    expect(observation).toMatchObject({
      latestNewEvidenceCount: 0,
      shouldContinue: false,
      stopReason: 'no_new_evidence',
      sufficient: false,
    });
  });

  it('stops at the configured search-step limit', () => {
    const observation = observeProductEvidence(
      '这个不存在的功能怎么配置？',
      [attempt('不存在的功能', [], [], [])],
      1,
    );

    expect(observation).toMatchObject({
      shouldContinue: false,
      stopReason: 'max_steps',
      sufficient: false,
    });
  });

  it('extracts comparison facets and validates rewritten-query focus', () => {
    const facets = extractEvidenceFacets('Pro 和永久 PRO 有什么区别？');

    expect(facets).toEqual(['Pro', '永久 PRO']);
    expect(queryTargetsMissingFacet('XXYY 永久 Pro 权益', ['永久 PRO'])).toBe(true);
    expect(queryTargetsMissingFacet('XXYY 钱包管理', ['永久 PRO'])).toBe(false);
  });

  it('rejects rewrites that leave the original scope or drop a time qualifier', () => {
    expect(
      isAllowedSearchQueryRewrite('2025 年当时 XXYY Pro 的钱包监控上限是多少？', '天气怎么样', []),
    ).toBe(false);
    expect(
      isAllowedSearchQueryRewrite(
        '2025 年当时 XXYY Pro 的钱包监控上限是多少？',
        'XXYY Pro 钱包监控上限',
        [],
      ),
    ).toBe(false);
    expect(
      isAllowedSearchQueryRewrite(
        '2025 年当时 XXYY Pro 的钱包监控上限是多少？',
        '2025 年当时 XXYY Pro 钱包监控上限',
        [],
      ),
    ).toBe(true);

    const observation = observeProductEvidence(
      '请比较 2025 年当时 XXYY Pro 权益和钱包管理上限',
      [attempt('原问题', ['pro'], ['pro-source'], ['2025 年当时 XXYY Pro 权益包括独享节点。'])],
      4,
    );
    expect(observation.suggestedQuery).toContain('2025 年');
    expect(observation.suggestedQuery).toContain('当时');
  });
});

function attempt(
  query: string,
  chunkIds: string[],
  citationKeys: string[],
  evidenceTexts: string[],
  citationSourceTypes?: Array<'admin_verified' | 'official_docs' | 'x_updates'>,
) {
  return {
    chunkIds,
    citationKeys,
    ...(citationSourceTypes === undefined ? {} : { citationSourceTypes }),
    evidenceTexts,
    query,
  };
}
