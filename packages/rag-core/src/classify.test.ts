import { describe, expect, it } from 'vitest';

import { classifyQuestion } from './classify.js';

describe('classifyQuestion', () => {
  it.each([
    ['XXYY Pro 有哪些权益和功能更新？', 'product_qa'],
    ['XXYY 有 APP 吗？', 'product_qa'],
    ['钱包备注上限提升到 1 万条在哪条推特里？', 'product_qa'],
    ['钱包监控上限历史更新记录在哪里？', 'product_qa'],
    ['如何设置 Telegram 钱包监控？', 'how_to'],
    ['怎么操作订单查询？', 'how_to'],
    ['新功能怎么使用？', 'how_to'],
    ['如何在 XXYY 买入代币？', 'how_to'],
    ['XXYY 的 Swap 交易怎么操作买入和卖出？', 'how_to'],
    ['如何设置挂单买入？', 'how_to'],
    ['移动端怎么登录 XXYY？', 'how_to'],
    ['怎么导出监控钱包？', 'how_to'],
    ['我的账户怎么升级 Pro？', 'how_to'],
    ['我的钱包怎么设置止盈止损？', 'how_to'],
    ['Swap 交易可以设置哪些内容？', 'product_qa'],
    ['Degen 模式有什么特点和注意？', 'product_qa'],
    ['交易设置里能设置哪些参数？', 'product_qa'],
    ['扫链页面有哪些区域？', 'product_qa'],
    ['扫链筛选支持哪些条件？', 'product_qa'],
    ['打满 Alert 是什么？', 'product_qa'],
    ['趋势列表支持哪些时间维度？', 'product_qa'],
    ['收藏代币可以备注和分组吗？', 'product_qa'],
    ['持仓管理能隐藏小额代币吗？', 'product_qa'],
    ['持仓管理里怎么隐藏小额代币？', 'product_qa'],
    ['收益统计展示哪些交易信息？', 'product_qa'],
    ['K 线支持哪些秒级时间区间？', 'product_qa'],
    ['K 线交易标记有哪些？', 'product_qa'],
    ['平均买入成本线怎么计算？', 'product_qa'],
    ['代币信息区会展示哪些安全性数据？', 'product_qa'],
    ['Pump 早鸟信号是怎么来的？', 'product_qa'],
    ['最新成交支持哪些筛选？', 'product_qa'],
    ['Holder 页面能查看哪些地址信息？', 'product_qa'],
    ['Tag Holder 持仓量小于1表示什么？', 'product_qa'],
    ['订单管理能看到哪些订单类型？', 'product_qa'],
    ['批量导入钱包支持哪两种导入方式？', 'product_qa'],
    ['持仓盈亏怎么计算盈亏倍率？', 'product_qa'],
    ['自动止盈止损是什么时候上线的？', 'product_qa'],
    ['交易 API 和 Agent Skill 是什么时候开放的？', 'product_qa'],
    ['P1/P2/P3 是什么交易设置？', 'product_qa'],
    ['How does the Avg. Price Line work?', 'product_qa'],
    ['What does Anti-MEV mode do?', 'product_qa'],
    ['Which fields are shown in Token Information?', 'product_qa'],
    ['How do I set up wallet monitoring?', 'how_to'],
    ['XXYY 支持管理我的交易钱包吗？', 'product_qa'],
    ['当前支持robinhood么', 'product_qa'],
    ['支持跟单么', 'product_qa'],
    ['支持哪些发射平台？', 'product_qa'],
    ['支持哪些发射台？', 'product_qa'],
    ['支持哪些链？', 'product_qa'],
    ['Which launchpads are supported?', 'product_qa'],
    ['copy trading 支持哪些 chain？', 'product_qa'],
    ['会员版都有啥', 'product_qa'],
    ['手机上怎么用', 'how_to'],
    ['小币种资产怎么不显示', 'how_to'],
    ['哪里看赚了多少倍', 'how_to'],
    ['我想盯几个地址，有啥提醒能配', 'product_qa'],
    ['你支持哪些功能？', 'agent_capabilities'],
    ['这个客服 Agent 能做什么？', 'agent_capabilities'],
    ['What can you do?', 'agent_capabilities'],
    ['支持哪些功能', 'product_qa'],
    ['帮我查一下钱包余额和账户交易记录', 'realtime_account_query'],
    [
      '查询 https://robinhoodchain.blockscout.com/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      'onchain_transaction',
    ],
    ['这个 tx hash 是不是被夹了，有 MEV sandwich 吗？', 'unknown'],
    [
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 这个交易是不是被夹了？',
      'onchain_transaction',
    ],
    [
      '这笔交易是不是三明治攻击：https://robinhoodchain.blockscout.com/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      'onchain_transaction',
    ],
    ['现在可以买 SOL 吗，推荐一个能保证盈利的 token', 'investment_advice'],
    ['嗯？', 'unknown'],
  ] as const)('classifies "%s" as %s', (question, expectedIntent) => {
    const classification = classifyQuestion(question);

    expect(classification.intent).toBe(expectedIntent);
    expect(classification.confidence).toBeGreaterThan(0);
    expect(classification.reason.length).toBeGreaterThan(0);
  });

  it('prefers realtime account lookup over generic product wording for user-specific data', () => {
    expect(classifyQuestion('帮我查 XXYY 钱包余额').intent).toBe('realtime_account_query');
  });

  it('classifies business action execution requests as an unsupported boundary', () => {
    expect(classifyQuestion('帮我开通 XXYY Pro')).toMatchObject({
      confidence: 0.4,
      intent: 'unknown',
      reason: 'business action execution request',
    });
    expect(classifyQuestion('请帮我取消订单')).toMatchObject({
      confidence: 0.4,
      intent: 'unknown',
      reason: 'business action execution request',
    });
    expect(classifyQuestion('麻烦帮我退款')).toMatchObject({
      confidence: 0.4,
      intent: 'unknown',
      reason: 'business action execution request',
    });
    expect(classifyQuestion('Can you refund my XXYY Pro charge?')).toMatchObject({
      confidence: 0.4,
      intent: 'unknown',
      reason: 'business action execution request',
    });
    expect(classifyQuestion('如何开通 XXYY Pro？').intent).toBe('how_to');
  });

  it('routes concrete deep transaction analysis to the read-only chain path', () => {
    expect(
      classifyQuestion(
        '帮我查一下这笔交易 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 是否被夹',
      ).intent,
    ).toBe('onchain_transaction');
    expect(
      classifyQuestion(
        'lookup this transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef sandwich?',
      ).intent,
    ).toBe('onchain_transaction');
    expect(
      classifyQuestion(
        '这笔交易是不是三明治攻击：https://robinhoodchain.blockscout.com/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      ).intent,
    ).toBe('onchain_transaction');
  });

  it('does not treat operational sandwich attack instructions as read-only analysis', () => {
    expect(
      classifyQuestion(
        '教我如何实施三明治攻击 https://robinhoodchain.blockscout.com/tx/0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      ),
    ).toMatchObject({
      intent: 'unknown',
      reason: 'unsafe or unsupported operation request',
    });
  });

  it('keeps MEV and sandwich checks outside the current knowledge-base route', () => {
    expect(classifyQuestion('我的交易是不是被夹子夹了？').intent).toBe('unknown');
  });

  it('keeps generic MEV questions unknown without a product knowledge signal', () => {
    expect(classifyQuestion('什么是 MEV sandwich？').intent).toBe('unknown');
  });

  it.each([
    '这个 tx hash 是不是被夹了，有 MEV sandwich 吗？',
    '帮我查这个池子有没有夹子',
    '分析一下这笔链上交易',
  ])('classifies unsupported transaction analysis before product planning: %s', (question) => {
    expect(classifyQuestion(question)).toMatchObject({
      intent: 'unknown',
      reason: 'unsupported transaction or mev analysis request',
    });
  });

  it('routes basic public transaction references while requiring one transaction for deep checks', () => {
    expect(
      classifyQuestion(
        [
          '帮我查这两笔哪个被夹了',
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        ].join(' '),
      ).intent,
    ).toBe('onchain_transaction');
    expect(
      classifyQuestion(
        [
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          '0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        ].join(' '),
      ).intent,
    ).toBe('onchain_transaction');
    expect(
      classifyQuestion('Base 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'),
    ).toMatchObject({
      intent: 'onchain_transaction',
      reason: 'queries supplied public transaction reference',
    });
  });

  it('keeps investment advice higher priority than transaction wording', () => {
    expect(
      classifyQuestion(
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef 可以买 SOL 保证盈利吗？',
      ).intent,
    ).toBe('investment_advice');
  });

  it.each([
    'Can XXYY guarantee profit for SOL?',
    'What investment recommendation does XXYY make for BTC?',
    'Can XXYY help me make profit from SOL?',
    'Which token should I buy to make profit in XXYY?',
    '如何在 XXYY 买入能保证盈利的 token？',
    '如何买入 SOL，可以保证盈利吗？',
  ])('classifies English profit/recommendation requests as investment advice: %s', (question) => {
    expect(classifyQuestion(question).intent).toBe('investment_advice');
  });

  it('does not classify account hacking requests as how-to product support', () => {
    expect(classifyQuestion('How to hack XXYY account?').intent).toBe('unknown');
  });

  it('requires a product signal for generic English support questions', () => {
    expect(classifyQuestion('Can you support me with my homework?').intent).toBe('unknown');
    expect(classifyQuestion('Does XXYY support Robinhood?').intent).toBe('product_qa');
  });

  it('classifies private key and seed phrase disclosure as a credential boundary', () => {
    expect(
      classifyQuestion(
        '我的助记词是 abandon ability able about above absent absorb abstract absurd abuse access accident',
      ),
    ).toMatchObject({
      confidence: 0.35,
      intent: 'unknown',
      reason: 'private credential or seed phrase disclosure',
    });
    expect(
      classifyQuestion(
        'Here is my private key: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toMatchObject({
      confidence: 0.35,
      intent: 'unknown',
      reason: 'private credential or seed phrase disclosure',
    });
  });

  it('classifies password and API key disclosure as a credential boundary without blocking token setup questions', () => {
    expect(classifyQuestion('我的密码是 hunter2')).toMatchObject({
      confidence: 0.35,
      intent: 'unknown',
      reason: 'private credential or seed phrase disclosure',
    });
    expect(classifyQuestion('my api key is sk-test-123456')).toMatchObject({
      confidence: 0.35,
      intent: 'unknown',
      reason: 'private credential or seed phrase disclosure',
    });
    expect(classifyQuestion('Bearer sk-live-1234567890abcdef')).toMatchObject({
      confidence: 0.35,
      intent: 'unknown',
      reason: 'private credential or seed phrase disclosure',
    });
    expect(classifyQuestion('secret key = xxyy-secret-123456')).toMatchObject({
      confidence: 0.35,
      intent: 'unknown',
      reason: 'private credential or seed phrase disclosure',
    });
    expect(classifyQuestion('Telegram bot token 怎么设置？').intent).toBe('how_to');
  });
});
