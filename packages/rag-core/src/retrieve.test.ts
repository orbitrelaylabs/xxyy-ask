import { describe, expect, it } from 'vitest';

import { createLocalHashEmbedding, tokenize } from '@xxyy/knowledge';
import type { IndexEntry, RagIndex } from '@xxyy/shared';

import { createLexicalRetrieveQueryTokens, retrieve } from './retrieve.js';
import { createFixtureIndex } from './test-fixtures.js';

describe('retrieve', () => {
  it('keeps informative lexical tokens while removing single characters and question noise', () => {
    expect(createLexicalRetrieveQueryTokens('XXYY 扫链筛选支持哪些条件？')).toEqual(
      expect.arrayContaining(['扫链', '筛选', '条件']),
    );
    expect(createLexicalRetrieveQueryTokens('XXYY 扫链筛选支持哪些条件？')).not.toEqual(
      expect.arrayContaining(['xxyy', '扫', '支持', '哪些']),
    );
  });

  it('combines lexical and local vector scores into ranked chunks', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/pro',
        text: 'XXYY Pro 支持 Telegram 钱包监控、更多提醒频率和产品功能。',
      },
      {
        id: 'official_docs:fees:chunk:0001',
        title: '费用说明',
        sourceType: 'official_docs',
        text: '普通版本说明费用和基础账户设置。',
      },
      {
        id: 'x_updates:launch:chunk:0001',
        title: 'X 更新',
        sourceType: 'x_updates',
        text: '我们发布了社区活动和运营消息。',
      },
    ]);

    const results = retrieve('XXYY Pro 支持 Telegram 钱包监控吗？', index, { topK: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('official_docs:pro:chunk:0001');
    expect(results[0]?.rank).toBe(1);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    expect(results[0]?.lexicalScore).toBeGreaterThan(0);
    expect(results[0]?.sourceBoost).toBeGreaterThan(0);
    expect(results[0]?.vectorScore).toBeGreaterThan(0);
  });

  it('prefers official docs over x updates when scores tie', () => {
    const index = createFixtureIndex([
      {
        id: 'x_updates:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'x_updates',
        text: 'XXYY Pro 支持 Telegram 钱包监控。',
      },
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        text: 'XXYY Pro 支持 Telegram 钱包监控。',
      },
    ]);

    const results = retrieve('Pro Telegram 钱包监控', index);

    expect(results[0]?.id).toBe('official_docs:pro:chunk:0001');
    expect(results[1]?.id).toBe('x_updates:pro:chunk:0001');
  });

  it('pins governed anchor documents before candidate truncation', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:feature:chunk:0001',
        title: '钱包监控',
        sourceType: 'official_docs',
        text: '钱包监控支持 Telegram 通知。',
      },
      {
        id: 'official_docs:capability-overview:chunk:0001',
        title: '当前功能目录',
        sourceType: 'official_docs',
        text: '经治理的当前产品能力目录。',
      },
    ]);

    const results = retrieve('钱包监控 Telegram 通知', index, {
      policy: {
        anchorDocumentIds: ['official_docs:capability-overview'],
        diversity: 'balanced',
        preferredSourceTypes: ['official_docs'],
        temporalScope: 'current',
        version: '1',
      },
      topK: 1,
    });

    expect(results.map((chunk) => chunk.id)).toEqual([
      'official_docs:capability-overview:chunk:0001',
    ]);
  });

  it('returns an empty list for blank questions or empty indexes', () => {
    expect(retrieve('   ', createFixtureIndex([]))).toEqual([]);
    expect(retrieve('Pro', createFixtureIndex([]))).toEqual([]);
  });

  it('boosts rare support-entity evidence above generic support phrasing', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:holder:chunk:0001',
        title: 'Holder',
        sourceType: 'official_docs',
        text: 'Holder页面会展示当前代币持有者的所有地址汇总情况，支持查看持仓量前100的所有地址。',
      },
      {
        id: 'x_updates:robinhood:chunk:0001',
        title: 'X Post robinhood',
        sourceType: 'x_updates',
        text: 'Robinbood 链更新 支持扫链、NOXA 内盘交易、钱包监控地址自动同步。',
      },
    ]);

    const results = retrieve('当前支持robinhood么', index, { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('x_updates:robinhood:chunk:0001');
  });

  it('does not return vector-only hash matches without lexical evidence', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:wallet:chunk:0001',
        title: '钱包监控',
        sourceType: 'official_docs',
        text: '钱包监控支持 Telegram 提醒。',
      },
    ]);

    const results = retrieve('completely unrelated english phrase', index);

    expect(results).toEqual([]);
  });

  it('keeps strong vector matches even when lexical score is zero', () => {
    const question = 'XXYY copy trading supported chains';
    const index: RagIndex = {
      builtAt: '2026-06-01T00:00:00.000Z',
      entries: [
        {
          documentId: 'copy-trading',
          embedding: createLocalHashEmbedding(question),
          id: 'x_updates:copy-trading:chunk:0001',
          metadata: {
            file: 'docs/product-features/xxyy-x-updates.md',
            headingPath: ['Copy Trading'],
            module: 'X Updates',
            sourceType: 'x_updates',
            title: 'Copy Trading Update',
          },
          text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
          tokens: ['跟单', '功能', '上线'],
        },
      ],
      version: 1,
    };

    const results = retrieve(question, index, { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'x_updates:copy-trading:chunk:0001',
      lexicalScore: 0,
      rank: 1,
      vectorScore: 1,
    });
  });

  it('expands product synonyms for paraphrased membership limit questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro-limits:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        text: 'XXYY Pro 可监控 2000 个钱包，并支持提醒频率。',
      },
      {
        id: 'official_docs:fees:chunk:0001',
        title: '费用说明',
        sourceType: 'official_docs',
        text: '普通版本说明服务费用和账户设置。',
      },
    ]);

    const results = retrieve('付费套餐能追踪多少地址？', index, { topK: 1 });

    expect(results[0]?.id).toBe('official_docs:pro-limits:chunk:0001');
    expect(results[0]?.lexicalScore).toBeGreaterThan(0);
  });

  it.each([
    [
      '会员版都有啥',
      'official_docs:pro-benefits:chunk:0001',
      'XXYY Pro 权益',
      'XXYY Pro 权益包括独享服务器和节点。',
    ],
    [
      '扫链都能按啥条件过滤',
      'official_docs:scan-filters:chunk:0001',
      '扫链筛选',
      '扫链筛选支持按创建时间、市值、Dev Buy 金额和 Holder 人数设置条件。',
    ],
    [
      '小币种资产怎么不显示',
      'official_docs:small-assets:chunk:0001',
      '持仓管理',
      '持仓管理支持隐藏小额代币，也可以选择展示所有代币。',
    ],
    [
      '手机上怎么用',
      'official_docs:mobile:chunk:0001',
      '移动端桌面入口',
      '使用手机浏览器打开 XXYY，并添加到主屏幕。',
    ],
    [
      '哪里看赚了多少倍',
      'official_docs:pnl:chunk:0001',
      '持仓盈亏',
      '持仓盈亏页面会展示盈亏倍率和收益统计。',
    ],
  ] as const)(
    'expands colloquial query "%s" toward its canonical product terminology',
    (question, expectedId, title, text) => {
      const index = createFixtureIndex([
        {
          id: expectedId,
          title,
          sourceType: 'official_docs',
          text,
        },
        {
          id: 'x_updates:generic-promotion:chunk:0001',
          title: '产品活动',
          sourceType: 'x_updates',
          text: '查看最新活动、交易奖励和社区消息。',
        },
      ]);

      const results = retrieve(question, index, { topK: 1 });

      expect(results[0]?.id).toBe(expectedId);
      expect(results[0]?.lexicalScore).toBeGreaterThan(0);
    },
  );

  it('expands Pro upgrade questions with the membership-point concepts needed for instructions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro-upgrade:member-points',
        title: '如何升级为 Pro',
        sourceType: 'official_docs',
        text: '点击右上角个人中心的会员积分，可查看当前地址积分数量。',
      },
      {
        id: 'official_docs:pro-upgrade:trade-points',
        title: '如何升级为 Pro',
        sourceType: 'official_docs',
        text: '交易积分根据当前地址下所有交易地址的买入卖出笔数和金额综合计算。',
      },
      {
        id: 'official_docs:pro-upgrade:airdrop',
        title: '如何升级为 Pro',
        sourceType: 'official_docs',
        text: '积分会在每天 UTC 0 点准时空投到地址账户内。',
      },
    ]);

    const resultIds = retrieve('我的账户怎么升级 Pro？', index, { topK: 2 }).map(
      (chunk) => chunk.id,
    );

    expect(resultIds).toHaveLength(2);
    expect(resultIds).toEqual(
      expect.arrayContaining([
        'official_docs:pro-upgrade:member-points',
        'official_docs:pro-upgrade:trade-points',
      ]),
    );
  });

  it('keeps both sides of Basic and Pro comparison questions in top results', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:basic:chunk:0001',
        title: 'XXYY Basic 权益',
        sourceType: 'official_docs',
        text: 'XXYY Basic 提供基础钱包监控和默认提醒频率。',
      },
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        text: 'XXYY Pro 支持更多钱包监控数量和更高提醒频率。',
      },
      {
        id: 'official_docs:telegram:chunk:0001',
        title: 'Telegram 通知',
        sourceType: 'official_docs',
        text: 'Telegram 通知用于接收产品提醒。',
      },
    ]);

    const resultIds = retrieve('Basic 和 Pro 权益有什么区别？', index, { topK: 2 }).map(
      (chunk) => chunk.id,
    );

    expect(resultIds).toEqual(['official_docs:basic:chunk:0001', 'official_docs:pro:chunk:0001']);
  });

  it('prefers trading operation pages for buy-token how-to questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro-upgrade:chunk:0001',
        title: '如何升级为 Pro',
        module: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        text: '交易积分是根据当前地址下所有交易地址的买入卖出笔数、买入卖出金额综合计算。',
      },
      {
        id: 'official_docs:swap:chunk:0001',
        title: 'Swap 交易',
        module: '交易代币',
        sourceType: 'official_docs',
        text: 'XXYY 支持一键买卖代币。交易金额可以自定义买入的 SOL 数量或者卖出代币的比例。',
      },
    ]);

    const results = retrieve('如何在 XXYY 买入代币？', index);

    expect(results[0]?.id).toBe('official_docs:swap:chunk:0001');
  });

  it('separates end-user trading questions from explicit API integration questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:swap:chunk:0001',
        title: 'Swap 交易',
        module: '交易代币',
        sourceType: 'official_docs',
        text: '在产品页面选择钱包和金额，然后买入或卖出代币。',
      },
      {
        id: 'official_docs:api:chunk:0001',
        title: 'XXYY API 参考文档',
        module: 'XXYY API',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/xxyy-api-can-kao-wen-dang',
        text: 'Swap API 使用 Authorization Bearer API Key 请求买入或卖出代币。',
      },
    ]);

    expect(retrieve('如何在 XXYY 买入代币？', index, { topK: 2 })[0]?.id).toBe(
      'official_docs:swap:chunk:0001',
    );
    expect(retrieve('如何通过 XXYY API 买入代币？', index, { topK: 2 })[0]?.id).toBe(
      'official_docs:api:chunk:0001',
    );
  });

  it('isolates external Agent Skill references from ordinary product questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:swap:chunk:0001',
        title: 'Swap 交易',
        module: '交易代币',
        sourceType: 'official_docs',
        text: '在产品页面选择钱包和金额，然后买入或卖出代币。',
      },
      {
        id: 'official_docs:external-skill:chunk:0001',
        title: 'XXYY Trade Skill',
        module: 'Developer / Agent Skill',
        sourceType: 'official_docs',
        sourceUrl: 'https://github.com/Jimmy-Holiday/xxyy-trade-skill/blob/abc/SKILL.md',
        text: 'Agent Skill 通过 GitHub 安装，并调用 XXYY API 执行交易。',
      },
    ]);

    expect(retrieve('如何在 XXYY 买入代币？', index, { topK: 2 }).map((item) => item.id)).toEqual([
      'official_docs:swap:chunk:0001',
    ]);
    expect(retrieve('XXYY Agent Skill 如何从 GitHub 安装？', index, { topK: 2 })[0]?.id).toBe(
      'official_docs:external-skill:chunk:0001',
    );
  });

  it('uses dated product updates instead of the API reference for API launch-history questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:api:chunk:0001',
        title: 'XXYY API 参考文档',
        module: 'XXYY API',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/xxyy-api-can-kao-wen-dang',
        text: '交易 API 使用 Bearer API Key 认证。',
      },
      {
        id: 'x_updates:api-launch:chunk:0001',
        title: 'X Post 2029875008730976415',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2029875008730976415',
        text: '2026 年 XXYY 开放交易 API，并将交易 API 封装为 Agent Skill。',
      },
    ]);

    expect(
      retrieve('交易 API 和 Agent Skill 是什么时候开放的？', index, { topK: 2 }).map(
        (chunk) => chunk.id,
      ),
    ).toEqual(['x_updates:api-launch:chunk:0001']);
  });

  it('routes changelog, legal, and English mirrors only to matching question scopes', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:product:chunk:0001',
        title: '钱包管理',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/getting-started/qian-bao-guan-li',
        text: '钱包管理支持创建和管理交易钱包。',
      },
      {
        id: 'official_docs:changelog:chunk:0001',
        title: '功能更新',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/changelog',
        text: '最新版本更新了钱包管理。',
      },
      {
        id: 'official_docs:privacy:chunk:0001',
        title: 'XXYY 隐私协议',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/wang-zhan-xie-yi/xxyy-yin-si-xie-yi',
        text: '隐私协议介绍个人信息处理规则。',
      },
      {
        id: 'official_docs:english:chunk:0001',
        title: 'Wallet Management',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/en/wallet-management',
        text: 'Manage trading wallets in XXYY.',
      },
    ]);

    expect(retrieve('钱包管理支持什么？', index, { topK: 4 }).map((chunk) => chunk.id)).toEqual([
      'official_docs:product:chunk:0001',
    ]);
    expect(retrieve('最近版本更新了哪些钱包功能？', index, { topK: 4 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'official_docs:changelog:chunk:0001' }),
      ]),
    );
    expect(retrieve('XXYY 如何处理个人信息？', index, { topK: 4 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'official_docs:privacy:chunk:0001' })]),
    );
    expect(retrieve('How does wallet management work?', index, { topK: 4 })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'official_docs:english:chunk:0001' })]),
    );
  });

  it('accepts relative product-asset source URLs without treating them as English docs', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:video:chunk:0001',
        title: '添加到桌面演示',
        module: '产品教程视频',
        sourceType: 'official_docs',
        sourceUrl: '/assets/xxyy-add-to-home.mp4',
        text: '在 Safari 分享菜单选择添加到主屏幕。',
      },
    ]);

    expect(retrieve('怎么添加到主屏幕？', index, { topK: 1 })[0]?.id).toBe(
      'official_docs:video:chunk:0001',
    );
  });

  it('prioritizes exact feature mentions from X updates for short Chinese feature questions', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:orders:chunk:0001',
        title: '挂单交易',
        sourceType: 'official_docs',
        text: 'XXYY 提供挂单买卖功能，一键设置，按理想价格买入或卖出代币。',
      },
      {
        id: 'x_updates:copy-trading:chunk:0001',
        title: 'XXYY X 历史推文产品更新汇总',
        sourceType: 'x_updates',
        text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
      },
    ]);

    const results = retrieve('XXYY支持跟单么', index);

    expect(results[0]?.id).toBe('x_updates:copy-trading:chunk:0001');
  });

  it('prefers a newer current X update over older official docs for current-rule questions', () => {
    const currentXUpdate = createScoredEntry({
      effectiveAt: '2026-07-01T00:00:00.000Z',
      id: 'x_updates:wallet-limit-5000:chunk:0001',
      sourceType: 'x_updates',
      status: 'current',
      text: '钱包监控每条链最多支持 5000 个地址。',
      title: '钱包监控上限更新',
    });
    const olderOfficialDoc = createScoredEntry({
      effectiveAt: '2025-02-13T00:00:00.000Z',
      id: 'official_docs:wallet-limit-2000:chunk:0001',
      sourceType: 'official_docs',
      status: 'current',
      text: '钱包监控每条链最多支持 2000 个地址。',
      title: '钱包监控上限',
    });
    const index: RagIndex = {
      builtAt: '2026-07-01T00:00:00.000Z',
      entries: [olderOfficialDoc, currentXUpdate],
      version: 1,
    };

    const results = retrieve('现在钱包监控每条链最多支持多少地址？', index, { topK: 2 });

    expect(results[0]).toMatchObject({
      id: 'x_updates:wallet-limit-5000:chunk:0001',
      metadata: {
        effectiveAt: '2026-07-01T00:00:00.000Z',
        sourceType: 'x_updates',
        status: 'current',
      },
    });
    expect(results[1]?.id).toBe('official_docs:wallet-limit-2000:chunk:0001');
  });

  it('keeps deprecated chunks below current chunks for default product questions', () => {
    const currentDoc = createScoredEntry({
      effectiveAt: '2026-01-01T00:00:00.000Z',
      id: 'official_docs:wallet-limit-current:chunk:0001',
      sourceType: 'official_docs',
      status: 'current',
      text: '钱包监控每条链最多支持 5000 个地址。',
      title: '钱包监控当前上限',
    });
    const deprecatedUpdate = createScoredEntry({
      effectiveAt: '2025-01-01T00:00:00.000Z',
      id: 'x_updates:wallet-limit-old:chunk:0001',
      sourceType: 'x_updates',
      status: 'deprecated',
      text: '钱包监控每条链最多支持 1000 个地址。',
      title: '钱包监控旧上限',
    });
    const index: RagIndex = {
      builtAt: '2026-07-01T00:00:00.000Z',
      entries: [deprecatedUpdate, currentDoc],
      version: 1,
    };

    const results = retrieve('钱包监控每条链最多支持多少地址？', index, { topK: 2 });

    expect(results.map((chunk) => chunk.id)).toEqual([
      'official_docs:wallet-limit-current:chunk:0001',
      'x_updates:wallet-limit-old:chunk:0001',
    ]);
  });

  it('hides superseded knowledge by default but keeps it for historical questions', () => {
    const oldDocument = createScoredEntry({
      effectiveAt: '2025-01-01T00:00:00.000Z',
      id: 'official_docs:wallet-limit-old:chunk:0001',
      sourceType: 'official_docs',
      status: 'current',
      text: '钱包监控每条链最多支持 2000 个地址。',
      title: '钱包监控旧上限',
    });
    const reviewedUpdate = createScoredEntry({
      effectiveAt: '2026-07-01T00:00:00.000Z',
      id: 'admin_verified:wallet-limit-new:chunk:0001',
      sourceType: 'admin_verified',
      status: 'current',
      supersedes: [oldDocument.documentId],
      text: '钱包监控每条链最多支持 5000 个地址。',
      title: '钱包监控当前上限',
    });
    const index: RagIndex = {
      builtAt: '2026-07-01T00:00:00.000Z',
      entries: [oldDocument, reviewedUpdate],
      version: 1,
    };

    expect(
      retrieve('现在钱包监控每条链最多支持多少地址？', index, { topK: 2 }).map((chunk) => chunk.id),
    ).toEqual(['admin_verified:wallet-limit-new:chunk:0001']);
    expect(
      retrieve('以前钱包监控每条链最多支持多少地址？', index, { topK: 2 }).map((chunk) => chunk.id),
    ).toEqual(
      expect.arrayContaining([
        'admin_verified:wallet-limit-new:chunk:0001',
        'official_docs:wallet-limit-old:chunk:0001',
      ]),
    );
  });
});

function createScoredEntry(input: {
  effectiveAt: string;
  id: string;
  sourceType: 'admin_verified' | 'official_docs' | 'x_updates';
  status: 'current' | 'historical' | 'deprecated';
  supersedes?: string[];
  text: string;
  title: string;
}): IndexEntry {
  const headingPath = [input.title];
  const searchableText = [input.title, 'XXYY', ...headingPath, input.text].join('\n');
  return {
    documentId: input.id.replace(/:chunk:\d+$/u, ''),
    embedding: createLocalHashEmbedding(searchableText),
    id: input.id,
    metadata: {
      effectiveAt: input.effectiveAt,
      file: `/fixtures/${input.id}.md`,
      headingPath,
      module: 'XXYY',
      sourceType: input.sourceType,
      status: input.status,
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      title: input.title,
    },
    text: input.text,
    tokens: tokenize(searchableText),
  };
}
