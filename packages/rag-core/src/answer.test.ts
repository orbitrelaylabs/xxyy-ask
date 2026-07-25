import { describe, expect, it } from 'vitest';

import type { Classification } from '@xxyy/shared';

import {
  createBoundaryAnswer,
  createGroundedAnswer,
  createSupportConclusionFromEvidence,
  selectGroundingChunks,
} from './answer.js';
import { retrieve, type RetrievedChunk } from './retrieve.js';
import { createFixtureIndex } from './test-fixtures.js';

const productClassification: Classification = {
  intent: 'product_qa',
  confidence: 0.8,
  reason: 'product keyword',
};

describe('createGroundedAnswer', () => {
  it('answers product questions in Chinese using retrieved excerpts and citations', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:pro:chunk:0001',
        title: 'XXYY Pro 权益',
        sourceType: 'official_docs',
        sourceUrl: 'https://docs.xxyy.io/pro',
        file: '/docs/pro.md',
        text: 'XXYY Pro 支持 Telegram 钱包监控，并提供更高频率的产品提醒。',
      },
    ]);
    const retrieved = retrieve('XXYY Pro 支持 Telegram 钱包监控吗？', index);

    const response = createGroundedAnswer(
      'XXYY Pro 支持 Telegram 钱包监控吗？',
      productClassification,
      retrieved,
    );

    expect(response.intent).toBe('product_qa');
    expect(response.answer).toContain('支持');
    expect(response.answer).toContain('Telegram 钱包监控');
    expect(response.citations).toHaveLength(1);
    const citation = response.citations[0];
    expect(citation).toBeDefined();
    if (citation === undefined) {
      throw new Error('Expected a product answer citation');
    }
    expect(citation.excerpt).toContain('Telegram 钱包监控');
    expect(citation.file).toBe('docs/pro.md');
    expect(citation.title).toBe('XXYY Pro 权益');
    expect(citation.sourceType).toBe('official_docs');
    expect(citation.sourceUrl).toBe('https://docs.xxyy.io/pro');
    expect(response.confidence).toBeGreaterThan(0.5);
  });

  it('uses a conservative fallback when product context is unavailable', () => {
    const response = createGroundedAnswer('XXYY Pro 有哪些权益？', productClassification, []);

    expect(response.answer).toContain('暂时没有找到');
    expect(response.citations).toEqual([]);
    expect(response.confidence).toBeLessThan(0.5);
  });

  it('extracts video attachments from grounded product context', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:mobile-app:chunk:0001',
        title: '移动端桌面入口',
        sourceType: 'official_docs',
        file: '/docs/product-features/pages/mobile-app.md',
        text: 'XXYY 暂时没有独立 App，但可以添加到桌面，和 App 体验差不多。[添加到桌面演示](/assets/xxyy-add-to-home.mp4)',
      },
    ]);
    const retrieved = retrieve('XXYY 有 APP 吗？', index);

    const response = createGroundedAnswer('XXYY 有 APP 吗？', productClassification, retrieved);

    expect(response.answer).toContain('添加到桌面');
    expect(response.attachments).toEqual([
      {
        kind: 'video',
        mediaType: 'video/mp4',
        title: '添加到桌面演示',
        url: '/assets/xxyy-add-to-home.mp4',
      },
    ]);
  });

  it('returns the original screenshot carried by a retrieved OCR chunk', () => {
    const index = createFixtureIndex([
      {
        id: 'official_docs:telegram-ocr:chunk:0001',
        title: 'Telegram 钱包监控配置截图',
        sourceType: 'official_docs',
        file: '/docs/product-features/enriched/media/telegram.md',
        text: '在 Telegram 群组设置中，将 XXYY Bot 设置为管理员并保存。',
        attachments: [
          {
            kind: 'image',
            mediaType: 'image/png',
            title: 'Telegram 钱包监控配置截图',
            url: '/assets/xxyy-docs-telegram.png',
          },
        ],
      },
    ]);
    const retrieved = retrieve('Telegram 钱包监控怎么配置？', index);

    const response = createGroundedAnswer(
      'Telegram 钱包监控怎么配置？',
      productClassification,
      retrieved,
    );

    expect(response.attachments).toEqual([
      {
        kind: 'image',
        mediaType: 'image/png',
        title: 'Telegram 钱包监控配置截图',
        url: '/assets/xxyy-docs-telegram.png',
      },
    ]);
  });

  it('extracts inline screenshots and external video links from grounded context', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'official-doc-media',
        text: [
          '钱包监控配置步骤。',
          '<figure><img src="/assets/wallet-monitor.png" alt="钱包监控配置"></figure>',
          '演示视频：https://www.youtube.com/watch?v=mzTSPHqP8UA',
        ].join('\n'),
        title: '钱包监控教程',
      }),
    ];

    const response = createGroundedAnswer(
      '钱包监控配置步骤是什么？',
      productClassification,
      retrieved,
    );

    expect(response.attachments).toEqual([
      {
        kind: 'image',
        mediaType: 'image/png',
        title: '钱包监控配置',
        url: '/assets/wallet-monitor.png',
      },
      {
        kind: 'video',
        mediaType: 'text/html',
        title: '钱包监控教程',
        url: 'https://www.youtube.com/watch?v=mzTSPHqP8UA',
      },
    ]);
  });

  it('uses only the standard customer answer chunk when it is present', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'mobile-app',
        text: '标准客服回答：可以添加到桌面，和 App 体验差不多。演示视频：[添加到桌面演示](/assets/xxyy-add-to-home.mp4)',
        title: '移动端桌面入口',
      }),
      createRetrievedChunk({
        id: 'token-info',
        text: '代币基本信息：合约地址、价格、流动性、市值、安全性数据。',
        title: '代币信息区',
      }),
    ];

    const response = createGroundedAnswer('XXYY 有 APP 吗？', productClassification, retrieved);

    expect(response.answer).toContain('添加到桌面');
    expect(response.answer).not.toContain('标准客服回答');
    expect(response.answer).not.toContain('用户问');
    expect(response.answer).not.toContain('代币基本信息');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.title).toBe('移动端桌面入口');
    expect(response.citations[0]?.excerpt).toBe('可以添加到桌面，和 App 体验差不多。');
    expect(response.attachments).toEqual([
      {
        kind: 'video',
        mediaType: 'video/mp4',
        title: '添加到桌面演示',
        url: '/assets/xxyy-add-to-home.mp4',
      },
    ]);
  });

  it('returns a scoped standard customer answer verbatim for support questions', () => {
    const standardAnswer =
      '如果你指 Robinhood Chain（Robinhood 链），XXYY 当前已支持扫链、NOXA 内盘交易和钱包监控地址自动同步。当前资料仅说明 Robinhood Chain 的产品能力，不表示支持 Robinhood 券商账户、订单或其他私有服务。';
    const retrieved = [
      createRetrievedChunk({
        id: 'robinhood-chain-support',
        text: `标准客服回答：${standardAnswer}`,
        title: 'Robinhood Chain 支持范围',
      }),
    ];

    const response = createGroundedAnswer('支持robinhood么?', productClassification, retrieved);

    expect(response.answer).toBe(standardAnswer);
    expect(response.citations[0]?.excerpt).toBe(standardAnswer);
  });

  it('does not let a standard customer answer hide another source for comparison questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'pro-benefits',
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
        title: 'XXYY Pro 权益',
      }),
      createRetrievedChunk({
        id: 'wallet-management',
        text: 'XXYY 每个用户每条链最多创建100个交易钱包，Pro 用户最多创建500个交易钱包。',
        title: '钱包管理',
      }),
    ];

    const response = createGroundedAnswer(
      '请比较 XXYY Pro 权益和钱包管理上限',
      productClassification,
      retrieved,
    );

    expect(response.citations).toHaveLength(2);
    expect(response.answer).toContain('独享服务器和节点');
    expect(response.answer).toContain('每个用户每条链最多创建100个交易钱包');
  });

  it('does not let an unrelated standard answer override direct how-to evidence', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'upgrade-pro',
        text: '点击会员积分查看积分，交易积分按买卖笔数和金额计算。',
        title: '如何升级为 Pro',
      }),
      createRetrievedChunk({
        id: 'pro-benefits',
        rank: 2,
        text: '标准客服回答：XXYY Pro 权益包括独享服务器和节点。',
        title: 'XXYY Pro 权益',
      }),
    ];

    const response = createGroundedAnswer(
      '我的账户怎么升级 Pro？',
      { ...productClassification, intent: 'how_to' },
      retrieved,
    );

    expect(response.answer).toContain('会员积分');
    expect(response.answer).not.toContain('独享服务器和节点');
  });

  it('deduplicates mirrored official content before selecting the citation window', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'member-points-rollup',
        text: '来源：https://docs.xxyy.io/pro 点击右上角个人中心的会员积分，可查看当前地址积分数量，并可继续查看积分说明与升级要求。',
        title: 'XXYY 产品功能整理文档',
      }),
      createRetrievedChunk({
        id: 'member-points-page',
        sourceUrl: 'https://docs.xxyy.io/pro',
        text: '点击右上角个人中心的会员积分，可查看当前地址积分数量，并可继续查看积分说明与升级要求。',
        title: '如何升级为 Pro',
      }),
      createRetrievedChunk({
        id: 'airdrop-page',
        text: '积分会在每天 UTC 0 点准时空投到地址账户内。',
        title: '如何升级为 Pro',
      }),
      createRetrievedChunk({
        id: 'trade-points-page',
        text: '交易积分根据当前地址下所有交易地址的买入卖出笔数和金额综合计算。',
        title: '如何升级为 Pro',
      }),
    ];

    const selected = selectGroundingChunks('我的账户怎么升级 Pro？', retrieved);

    expect(selected.map((chunk) => chunk.id)).toEqual([
      'member-points-page',
      'airdrop-page',
      'trade-points-page',
    ]);
  });

  it('uses only the direct X post chunk for tweet source questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'wallet-note-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
        text: '钱包备注支持最多 1 万条，快速捕捉前排地址。',
        title: 'X Post 2030954722350575916',
      }),
      createRetrievedChunk({
        id: 'copy-trading-summary',
        sourceType: 'x_updates',
        text: '跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
    ];

    const response = createGroundedAnswer(
      '钱包备注支持最多 1 万条是哪条推文？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toContain('钱包备注支持最多 1 万条');
    expect(response.answer).not.toContain('跟单功能上线');
    expect(response.citations).toEqual([
      {
        excerpt: '钱包备注支持最多 1 万条，快速捕捉前排地址。',
        file: 'docs/wallet-note-post.md',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
        title: 'X Post 2030954722350575916',
      },
    ]);
  });

  it('includes source publication dates in citations when available', () => {
    const response = createGroundedAnswer(
      '交易 API 和 Agent Skill 是什么时候开放的？',
      productClassification,
      [
        createRetrievedChunk({
          effectiveAt: '2026-03-06T09:30:00.000Z',
          id: 'api-agent-skill',
          text: 'XXYY 开放交易 API，并将其封装为 Agent Skill。',
          title: 'X Post 123',
        }),
      ],
    );

    expect(response.citations[0]?.excerpt).toContain('发布日期：2026-03-06');
  });

  it('keeps executable command evidence in citations for installation questions', () => {
    const response = createGroundedAnswer(
      'XXYY Agent Skill 如何从 GitHub 安装？',
      { ...productClassification, intent: 'how_to' },
      [
        createRetrievedChunk({
          id: 'agent-skill-install',
          text: [
            '**第 1 步** — 添加市场源：',
            '```bash\n/plugin marketplace add Jimmy-Holiday/xxyy-trade-skill\n```',
            '**第 2 步** — 安装插件：',
            '打开 `/plugin` → 切换到 Marketplaces 标签页 → 选择 xxyy-trade-skill → Browse plugins → 安装 xxyy-trade。',
          ].join('\n\n'),
          title: 'XXYY Agent Skill 安装',
        }),
      ],
    );

    expect(response.citations[0]?.excerpt).toContain(
      '/plugin marketplace add Jimmy-Holiday/xxyy-trade-skill',
    );
  });

  it('selects the direct X post that best matches the source question text', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'holders-note-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2063938732311601370',
        text: 'Holders数据新增备注、Dev、新钱包、老鼠仓、捆绑信息。',
        title: 'X Post 2063938732311601370',
      }),
      createRetrievedChunk({
        id: 'wallet-note-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
        text: '钱包备注支持最多 1 万条，快速捕捉前排地址。',
        title: 'X Post 2030954722350575916',
      }),
    ];

    const response = createGroundedAnswer(
      '钱包备注支持最多 1 万条是哪条推文？',
      productClassification,
      retrieved,
    );

    expect(response.citations).toEqual([
      expect.objectContaining({
        sourceUrl: 'https://x.com/useXXYYio/status/2030954722350575916',
        title: 'X Post 2030954722350575916',
      }),
    ]);
    expect(response.answer).toContain('钱包备注支持最多 1 万条');
    expect(response.answer).not.toContain('Holders数据');
  });

  it('keeps only strong P1/P2/P3 evidence for trade-setting preset questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'p123-summary',
        sourceType: 'x_updates',
        text: '支持 P1/P2/P3 交易设置档位，不同买卖和挂单场景可使用不同 gas 与滑点。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
      createRetrievedChunk({
        id: 'p123-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2026285686907883612',
        text: '交易设置多档位切换 P1 P2 P3，买卖/挂单支持不同gas与滑点。',
        title: 'X Post 2026285686907883612',
      }),
      createRetrievedChunk({
        id: 'speed-summary',
        sourceType: 'x_updates',
        text: '全面提速：扫链新盘秒出，K 线 0 延迟，图片实时推送。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
    ];

    const response = createGroundedAnswer(
      'P1/P2/P3 是什么交易设置？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toContain('P1/P2/P3');
    expect(response.answer).toContain('P1 P2 P3');
    expect(response.answer).not.toContain('全面提速');
    expect(response.citations).toHaveLength(2);
    expect(response.citations.map((citation) => citation.title)).toEqual([
      'XXYY X 历史推文产品更新汇总',
      'X Post 2026285686907883612',
    ]);
  });

  it('keeps only direct Base B20 support evidence for short entity questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'base-b20-question',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2070536322838831188',
        text: '今晚有人一起蹲 #BASE 链的 B20 上线吗？',
        title: 'X Post 2070536322838831188',
      }),
      createRetrievedChunk({
        id: 'base-b20-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2070536322838831188',
        text: '全面支持B20代币交易，同时在代币详情和扫链页面都增加了专属标识。',
        title: 'X Post 2070536322838831188',
      }),
      createRetrievedChunk({
        id: 'generic-trade-settings',
        text: '滑点、交易模式、交易 Fee 支持自定义，设置完成后交易组件中默认使用该值。',
        title: '交易设置',
      }),
    ];

    const response = createGroundedAnswer(
      'XXYY 是否支持 Base B20？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toContain('全面支持B20代币交易');
    expect(response.answer).not.toContain('有人一起蹲');
    expect(response.answer).not.toContain('交易 Fee');
    expect(response.citations).toEqual([
      expect.objectContaining({
        sourceUrl: 'https://x.com/useXXYYio/status/2070536322838831188',
        title: 'X Post 2070536322838831188',
      }),
    ]);
  });

  it('summarizes support evidence as a short conclusion instead of dumping raw excerpts', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'copy-trading-summary',
        sourceType: 'x_updates',
        text: '- FourMeme Agentic 模式支持：在 XXYY 完成 BSC 代币交易后可自动 mint Agent NFT。 - 跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链，可查看地址利润和胜率，自定义跟单金额、卖出比例、gas、滑点和过滤条件。 - 开放交易 API。',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
      createRetrievedChunk({
        id: 'copy-trading-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2029522365408067746',
        text: '🔗支持6大公链，#SOL #BSC #Base #ETH #XLayer #Plasma 📈输入地址即可查看利润、胜率数据，判断是否值得跟单 ⚙️自定义跟单金额、卖出比例、gas/滑点/交易设置，速度更快',
        title: 'X Post 2029522365408067746',
      }),
    ];

    const response = createGroundedAnswer('支持跟单么', productClassification, retrieved);

    expect(response.answer).toBe(
      '支持。跟单功能上线，支持 SOL、BSC、Base、ETH、X Layer、Plasma 六条链，可查看地址利润和胜率，自定义跟单金额、卖出比例、gas、滑点和过滤条件。',
    );
    expect(response.answer).not.toContain('FourMeme');
    expect(response.answer).not.toContain('🔗');
    expect(response.citations).toHaveLength(2);
  });

  it('returns a concise insufficient-evidence answer for unsupported external support entities', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'xpl-post',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/1973056573695242527',
        text: 'https://t.co/vtLDOyE6Hd is the first tool to support $XPL with both charting and trading in one place🚀',
        title: 'X Post 1973056573695242527',
      }),
      createRetrievedChunk({
        id: 'scan-summary',
        sourceType: 'x_updates',
        text: '| 日期 | 更新点 | 推文 | | --- | --- | --- | | 2024-11-29 | Beta V0.1.2：秒线、1 分钟趋势、监控钱包分组 |',
        title: 'XXYY X 历史推文产品更新汇总',
      }),
    ];

    const response = createGroundedAnswer(
      'XXYY当前是否支持robinhood',
      productClassification,
      retrieved,
    );

    expect(response.answer).toBe('当前知识库没有明确说明 XXYY 支持 robinhood，不能确认已支持。');
    expect(response.answer).not.toContain('XPL');
    expect(response.answer).not.toContain('| 日期 |');
    expect(response.citations).toEqual([]);
    expect(response.confidence).toBeLessThan(0.5);
  });

  it('does not combine partial support evidence from unrelated sources for a multi-entity query', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'robinhood-launchpads',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/2075891974192947704',
        text: 'Robinhood 链更新，扫链支持筛选发射台 Noxa、Virtuals 和 Bankr。',
        title: 'Robinhood 发射台更新',
      }),
      createRetrievedChunk({
        id: 'base-long-launchpad',
        rank: 2,
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/another-post',
        text: 'Base 链当前支持 LONG 发射平台筛选。',
        title: 'Base LONG 发射平台',
      }),
    ];

    const response = createGroundedAnswer(
      '支持robinhood链的long么？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toBe(
      '当前知识库没有明确说明 XXYY 支持 robinhood 与 long 的组合，不能确认已支持。',
    );
    expect(response.answer).not.toMatch(/^支持。/u);
    expect(response.citations).toEqual([]);
    expect(response.confidence).toBeLessThan(0.5);
  });

  it('answers a multi-entity support query only when one evidence scope covers every entity', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'robinhood-long-launchpad',
        sourceType: 'x_updates',
        sourceUrl: 'https://x.com/useXXYYio/status/robinhood-long',
        text: 'XXYY 当前支持 Robinhood Chain 的 LONG 发射平台筛选。',
        title: 'Robinhood LONG 发射平台',
      }),
    ];

    const response = createGroundedAnswer(
      '支持robinhood链的long么？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toBe('支持。XXYY 当前支持 Robinhood Chain 的 LONG 发射平台筛选。');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.title).toBe('Robinhood LONG 发射平台');
  });

  it('uses complete subject coverage for multi-dimensional support questions', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'partial-wallet-support',
        text: '支持自托管钱包交易，私钥只储存在本地设备中。',
        title: '钱包安全',
      }),
      createRetrievedChunk({
        id: 'complete-wallet-support',
        rank: 2,
        text: '支持每个用户创建交易钱包。创建后可在钱包管理列表中查看和管理已经创建的钱包。',
        title: '钱包管理',
      }),
    ];

    const response = createGroundedAnswer(
      'XXYY 支持创建和管理交易钱包吗？',
      productClassification,
      retrieved,
    );

    expect(response.answer).toContain('创建交易钱包');
    expect(response.answer).toContain('钱包管理列表');
    expect(response.answer).not.toContain('私钥只储存在本地设备');
    expect(response.citations[0]?.title).toBe('钱包管理');
  });

  it('does not treat roadmap language as current support evidence', () => {
    expect(
      createSupportConclusionFromEvidence('Does XXYY support Robinhood?', [
        'XXYY 计划支持 Robinhood，预计下季度上线。',
      ]),
    ).toBeUndefined();
  });

  it('excludes historical progression summaries from current-state grounding', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'current-capacity',
        rank: 1,
        text: '钱包监控目前最多支持5000个地址。',
        title: '钱包监控当前容量',
      }),
      createRetrievedChunk({
        id: 'capacity-history',
        rank: 2,
        text: '钱包监控容量从早期1000个逐步提高到3000个，再到目前5000个地址。',
        title: '容量历史汇总',
      }),
      createRetrievedChunk({
        id: 'wallet-monitor',
        rank: 3,
        text: '钱包监控支持关注地址并查看交易提醒。',
        title: '钱包监控',
      }),
    ];

    const selected = selectGroundingChunks('现在钱包监控最多支持多少个地址？', retrieved);

    expect(selected.map((chunk) => chunk.id)).toContain('current-capacity');
    expect(selected.map((chunk) => chunk.id)).not.toContain('capacity-history');
  });

  it('keeps explicitly historical evidence when a dated question also says maximum', () => {
    const selected = selectGroundingChunks('2025年9月24日当时钱包监控上限是多少？', [
      createRetrievedChunk({
        effectiveAt: '2025-09-24T07:57:10.000Z',
        id: 'historical-capacity',
        rank: 1,
        status: 'historical',
        text: '当时每条链的钱包监控上限为3000个。',
        title: '2025 钱包监控上限',
      }),
      createRetrievedChunk({
        effectiveAt: '2026-03-10T11:36:55.000Z',
        id: 'current-capacity',
        rank: 2,
        status: 'current',
        text: '当前钱包监控最多支持5000个地址。',
        title: '当前钱包监控上限',
      }),
      createRetrievedChunk({
        id: 'undated-rollup',
        rank: 3,
        text: '钱包监控后来提升到每条链最多5000个地址。',
        title: '容量历史汇总',
      }),
    ]);

    expect(selected[0]?.id).toBe('historical-capacity');
    expect(selected[0]?.text).toContain('3000');
    expect(selected.map((chunk) => chunk.id)).not.toContain('current-capacity');
    expect(selected.map((chunk) => chunk.id)).not.toContain('undated-rollup');
  });

  it('uses a scoped current standard answer for colloquial old-vs-new conflicts', () => {
    const selected = selectGroundingChunks(
      '群里有人说 Pro 只能监控2000个钱包，也有人说5000个，现在到底是多少？',
      [
        createRetrievedChunk({
          id: 'current-pro',
          rank: 1,
          status: 'current',
          text: '标准客服回答：XXYY Pro 每条链最多监控5000个钱包。',
          title: 'XXYY Pro 权益',
        }),
        createRetrievedChunk({
          id: 'old-pro',
          rank: 2,
          status: 'historical',
          text: 'Pro 用户支持监控2000个钱包。',
          title: '旧 Pro 权益',
        }),
      ],
    );

    expect(selected.map((chunk) => chunk.id)).toEqual(['current-pro']);
  });

  it('keeps structured evidence within the anchor document when it is sufficient', () => {
    const selected = selectGroundingChunks('永久 PRO 额外有哪些权益？', [
      createRetrievedChunk({
        documentId: 'permanent-pro',
        id: 'permanent-pro-features',
        rank: 1,
        text: '永久 PRO 支持定制化功能开发、一次升级长期有效。',
        title: '永久 PRO',
      }),
      createRetrievedChunk({
        documentId: 'permanent-pro',
        id: 'permanent-pro-support',
        rank: 2,
        text: '永久 PRO 提供专属客服随时答疑。',
        title: '永久 PRO',
      }),
      createRetrievedChunk({
        id: 'old-promotion',
        rank: 3,
        text: '春节期间 PRO 限时一折兑换。',
        title: '旧促销推文',
      }),
    ]);

    expect(selected.map((chunk) => chunk.id)).toEqual([
      'permanent-pro-features',
      'permanent-pro-support',
    ]);
  });

  it('matches short support entities as exact tokens instead of substrings', () => {
    expect(
      createSupportConclusionFromEvidence('XXYY 支持 OP 吗？', ['XXYY 支持 Copy Trading。']),
    ).toBeUndefined();
  });

  it('selects direct entity support evidence before an unrelated standard answer', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'mobile-app',
        text: '标准客服回答：可以添加到桌面，和 App 体验差不多。',
        title: '移动端桌面入口',
      }),
      createRetrievedChunk({
        id: 'robinhood-support',
        text: 'XXYY 当前支持 Robinhood。',
        title: 'Robinhood 支持范围',
      }),
    ];

    const response = createGroundedAnswer(
      'Does XXYY support Robinhood?',
      productClassification,
      retrieved,
    );

    expect(response.answer).toBe('支持。XXYY 当前支持 Robinhood。');
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.title).toBe('Robinhood 支持范围');
  });

  it('accepts one-character entity typos and entity hits outside the top citation window', () => {
    const retrieved = [
      createRetrievedChunk({
        id: 'generic-holder',
        rank: 1,
        score: 4,
        text: 'Holder页面会展示当前代币持有者的所有地址汇总情况，支持查看持仓量前100的所有地址。',
        title: 'Holder',
      }),
      createRetrievedChunk({
        id: 'generic-wallet',
        rank: 2,
        score: 3.8,
        text: '钱包监控支持全链开关，开启后支持全链交易推送。',
        title: '钱包监控',
      }),
      createRetrievedChunk({
        id: 'generic-base',
        rank: 3,
        score: 3.5,
        text: '支持 #Base 链交易，目前已支持四大公链。',
        title: 'Base 更新',
      }),
      createRetrievedChunk({
        id: 'robinbood-typo-post',
        rank: 4,
        score: 1.1,
        text: 'Robinbood 链更新 支持扫链、NOXA 内盘交易、钱包监控地址自动同步。',
        title: 'X Post robinbood',
      }),
    ];

    const response = createGroundedAnswer('当前支持robinhood么', productClassification, retrieved);

    expect(response.answer).toContain('支持');
    expect(response.answer.toLowerCase()).toMatch(/robinb[ho]od/);
    expect(response.citations).toHaveLength(1);
    expect(response.citations[0]?.title).toBe('X Post robinbood');
  });

  it.each([
    ['realtime_account_query', '我不能直接查询你的钱包余额、订单、账户或交易记录'],
    ['investment_advice', '我不能提供买卖建议、喊单或收益承诺'],
    ['unknown', '我还不确定你想咨询的具体问题'],
  ] as const)(
    'does not use retrieved chunks as factual answers for %s',
    (intent, expectedBoundary) => {
      const index = createFixtureIndex([
        {
          id: 'official_docs:unsafe:chunk:0001',
          title: '不应被引用',
          sourceType: 'official_docs',
          text: '你的余额是 100 SOL，这笔交易确定被夹，建议马上买入。',
        },
      ]);
      const retrieved = retrieve('帮我查余额', index);
      const response = createGroundedAnswer(
        '帮我查余额',
        {
          intent,
          confidence: 0.9,
          reason: 'boundary intent',
        },
        retrieved,
      );

      expect(response.answer).toContain(expectedBoundary);
      expect(response.answer).not.toContain('100 SOL');
      expect(response.answer).not.toContain('马上买入');
      expect(response.citations).toEqual([]);
    },
  );
});

function createRetrievedChunk(input: {
  documentId?: string;
  effectiveAt?: string;
  id: string;
  rank?: number;
  score?: number;
  sourceType?: RetrievedChunk['metadata']['sourceType'];
  sourceUrl?: string;
  status?: RetrievedChunk['metadata']['status'];
  text: string;
  title: string;
}): RetrievedChunk {
  return {
    documentId: input.documentId ?? input.id,
    embedding: [],
    id: input.id,
    lexicalScore: 1,
    metadata: {
      file: `/docs/${input.id}.md`,
      headingPath: [input.title],
      module: input.title,
      sourceType: input.sourceType ?? 'official_docs',
      ...(input.status === undefined ? {} : { status: input.status }),
      title: input.title,
      ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
      ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
    },
    rank: input.rank ?? 1,
    score: input.score ?? 1,
    sourceBoost: 0,
    text: input.text,
    tokens: [],
    vectorScore: 1,
  };
}

describe('createBoundaryAnswer', () => {
  it('returns a business-action boundary when the unknown reason is action execution', () => {
    const response = createBoundaryAnswer({
      confidence: 0.4,
      intent: 'unknown',
      reason: 'business action execution request',
    });

    expect(response).toMatchObject({
      citations: [],
      confidence: 0.4,
      intent: 'unknown',
    });
    expect(response.answer).toContain('不能代你开通、取消、修改');
    expect(response.answer).toContain('退款、赔偿');
    expect(response.answer).toContain('可以继续问我开通或升级的操作步骤');
    expect(response.answer).not.toMatch(/人工接管|工单|转人工|人工客服/u);
  });
});
