import type { Classification, Intent } from '@xxyy/shared';

type IntentRule = {
  intent: Intent;
  confidence: number;
  reason: string;
  patterns: RegExp[];
};

const userSpecificLookupPatterns = [
  /帮我查/u,
  /查一下/u,
  /我的/u,
  /我(的)?(钱包|账户|账号|订单|交易)/u,
  /\bmy\b/u,
  /\bmine\b/u,
  /\blookup\b/u,
];

const unsafeOperationPatterns = [
  /\bhack\b/u,
  /\bexploit\b/u,
  /\bsteal\b/u,
  /\bphish\b/u,
  /盗号|攻击|破解|钓鱼/u,
];

const businessActionRequestPatterns = [
  /(?:帮我|替我|给我|帮忙|麻烦(?:你)?帮我|请(?:你)?帮我).*(?:开通|升级|取消|关闭|解绑|修改|更改|重置|恢复|处理|执行|下单|挂单|提现|转账|认领|退款|退费|赔偿|补偿)/u,
  /\b(?:please|can you|could you|i need you to)\b.*\b(?:open|activate|enable|upgrade|cancel|close|change|modify|reset|recover|execute|place|withdraw|transfer|claim|refund|compensate)\b/u,
];

const privateCredentialPatterns = [
  /\b(private\s+key|seed\s+phrase|mnemonic|secret\s+recovery\s+phrase)\b/u,
  /(?:我的)?(?:密码|登录密码)\s*(?:是|为|:|：|=)\s*\S+/u,
  /(?:api\s*key|access\s*token|auth\s*token|访问令牌)\s*(?:是|为|:|：|=)\s*\S+/u,
  /\b(?:my\s+)?(?:password|api\s*key|access\s*token|auth\s*token)\s*(?:is|:|=)\s*\S+/u,
  /\bbearer\s+\S+/u,
  /\bsecret\s+key\s*(?:is|:|=)\s*\S+/u,
  /私钥|助记词|恢复词|密钥/u,
];

const productOperationPatterns = [
  /如何.*(买入|卖出|交易|挂单|swap|设置)/u,
  /怎么.*(买入|卖出|交易|挂单|swap|设置|操作|登录|导出|导入|生成|升级)/u,
  /(swap|挂单|交易).*怎么操作/u,
  /操作.*(买入|卖出|交易|挂单|swap)/u,
  /(?:手机|手机版|手机上|移动端|app).{0,16}(?:怎么用|如何用|怎么打开|如何打开|怎么添加|如何添加|怎么登录|如何登录)/u,
  /(?:小币种|小币|小额资产).{0,20}怎么(?:隐藏|显示|不显示)/u,
  /怎么(?:隐藏|显示|不显示).{0,20}(?:小币种|小币|小额资产)/u,
  /(?:哪里|在哪(?:里)?)(?:能|可以)?(?:看|查看).{0,20}(?:收益|盈亏|赚.{0,6}倍|亏损)/u,
];

const unsupportedTransactionAnalysisPatterns = [
  /\b(?:0x)?[a-f0-9]{64}\b/u,
  /(?:solscan\.io|solana\.fm|etherscan\.io|bscscan\.com|basescan\.org)\/(?:tx|transaction)\//u,
  /交易哈希|tx\s*hash|transaction\s*hash|explorer|浏览器链接|池子查询|链上取证|链上交易|夹子|sandwich|\bmev\b/u,
];

const productSupportDomainPattern =
  /跟单|扫链|挂单|监控|交易|钱包|移动端|手机版|手机上|app|telegram|swap|base|b20|p1\/p2\/p3|k\s*线|pump|tag\s*holder|holder|订单|批量导入|止盈|止损|会员版|小币种|小额代币|持仓|盈亏|收益倍数|wallet\s+(?:monitoring|management)|limit\s+orders?|automated\s+trading|quick\s+trading|trading\s+(?:settings?|modes?)|chart\s+area|avg\.?\s+price\s+line|average\s+(?:purchase|buy|cost)\s+line|cost\s+basis|token\s+information|watchlist|new\s+pairs|meme\s+scanner/u;

const supportQuestionPattern =
  /是否支持|当前支持|现在支持|支持.*(?:吗|么|不)|(?:does|do|can|is|are).*\bsupport\b|\bsupport(?:s|ed)?\b/u;

const nonProductSupportLatinTokens = new Set([
  'are',
  'can',
  'current',
  'currently',
  'do',
  'does',
  'i',
  'is',
  'me',
  'my',
  'now',
  'please',
  'support',
  'supported',
  'supports',
  'the',
  'this',
  'you',
]);

const rules: IntentRule[] = [
  {
    intent: 'investment_advice',
    confidence: 0.9,
    reason: 'asks for trading recommendation or profit promise',
    patterns: [
      /可以买|该买|该卖|推荐.*(币|token)|喊单|保证.*(盈利|赚钱|收益)|收益承诺|profit promise/u,
      /\bguarantee\b.*\b(profit|return|yield|earnings?)\b/u,
      /\b(profit|return|yield|earnings?)\b.*\bguarantee\b/u,
      /\b(make|earn|get)\b.*\b(profit|return|yield|earnings?)\b/u,
      /\b(profit|return|yield|earnings?)\b.*\b(from|with|in)\b/u,
      /\b(investment|trading)\s+recommendation\b/u,
      /\bwhich\b.*\b(token|coin|crypto|sol|eth|btc)\b.*\b(buy|sell)\b/u,
      /\b(should|can)\b.*\b(buy|sell)\b.*\b(token|coin|crypto|sol|eth|btc)\b/u,
      /\b(buy|sell|recommend)\b.*\b(token|coin|crypto|sol|eth|btc)\b/u,
    ],
  },
  {
    intent: 'how_to',
    confidence: 0.84,
    reason: 'asks for setup or operation instructions',
    patterns: [
      /如何|怎么操作|怎么设置|怎样设置|设置.*(教程|步骤)|操作步骤/u,
      /\bhow to\b|\bhow-to\b|\bsetup\b|\bset up\b/u,
    ],
  },
  {
    intent: 'realtime_account_query',
    confidence: 0.86,
    reason: 'asks for user-specific account, order, wallet, or transaction data',
    patterns: [/(钱包|余额|订单|账户|账号|交易记录|交易查询|transaction|balance|account|order)/u],
  },
  {
    intent: 'product_qa',
    confidence: 0.78,
    reason: 'asks about XXYY product, features, updates, or Pro plan',
    patterns: [
      /\bxxyy\b|\bpro\b|\bproduct\b|\bfeature(s)?\b|\bupdate(s)?\b/u,
      /产品|功能|更新|权益|版本|提醒|监控|telegram/u,
      /钱包备注|监控上限|监控数量|历史更新|更新记录|推特|推文|tweet|x\.com/u,
      /扫链|打满|趋势|收藏|持仓管理|收益统计|快捷交易|自动交易|钱包管理|关注钱包|移动端|手机版|手机上/u,
      /swap|degen|交易设置|交易模式|极速模式|防夹模式|k\s*线|平均买入成本线|代币信息区/u,
      /pump\s*早鸟|最新成交|tag\s*holder|holder|订单管理|批量导入|持仓盈亏|自动止盈止损|会员版|小币种|小额代币|收益倍数|赚.{0,8}(?:多少|几).{0,4}倍/u,
      /交易\s*api|agent\s*skill|p1\/p2\/p3/u,
      /wallet\s+(?:monitoring|management)|limit\s+orders?|automated\s+trading|quick\s+trading|trading\s+(?:settings?|modes?)|anti[- ]?mev|chart\s+area|avg\.?\s+price\s+line|average\s+(?:purchase|buy|cost)\s+line|cost\s+basis|token\s+information|watchlist|new\s+pairs|meme\s+scanner|referral\s+program|mobile\s+(?:device\s+)?login/u,
    ],
  },
];

export function classifyQuestion(question: string): Classification {
  const normalized = question.normalize('NFKC').trim().toLowerCase();
  if (normalized.length < 2) {
    return createClassification('unknown', 0.2, 'question is too short or unclear');
  }

  if (unsafeOperationPatterns.some((pattern) => pattern.test(normalized))) {
    return createClassification('unknown', 0.3, 'unsafe or unsupported operation request');
  }

  if (businessActionRequestPatterns.some((pattern) => pattern.test(normalized))) {
    return createClassification('unknown', 0.4, 'business action execution request');
  }

  if (privateCredentialPatterns.some((pattern) => pattern.test(normalized))) {
    return createClassification('unknown', 0.35, 'private credential or seed phrase disclosure');
  }

  const investmentRule = rules.find((rule) => rule.intent === 'investment_advice');
  if (investmentRule !== undefined && matchesRule(investmentRule, normalized)) {
    return createClassification(
      investmentRule.intent,
      investmentRule.confidence,
      investmentRule.reason,
    );
  }

  if (
    unsupportedTransactionAnalysisPatterns.some((pattern) => pattern.test(normalized)) &&
    !isAntiMevModeDocumentationQuestion(normalized)
  ) {
    return createClassification('unknown', 0.7, 'unsupported transaction or mev analysis request');
  }

  if (productOperationPatterns.some((pattern) => pattern.test(normalized))) {
    return createClassification('how_to', 0.84, 'asks for product operation instructions');
  }

  if (isProductSupportQuestion(normalized)) {
    return createClassification(
      'product_qa',
      0.72,
      'asks whether a product capability is supported',
    );
  }

  const realtimeRule = rules.find((rule) => rule.intent === 'realtime_account_query');
  if (realtimeRule !== undefined && matchesRule(realtimeRule, normalized)) {
    const isUserSpecific = userSpecificLookupPatterns.some((pattern) => pattern.test(normalized));
    if (isUserSpecific) {
      return createClassification(
        realtimeRule.intent,
        realtimeRule.confidence,
        realtimeRule.reason,
      );
    }
  }

  for (const rule of rules) {
    if (rule.intent === 'investment_advice' || rule.intent === 'realtime_account_query') {
      continue;
    }

    if (matchesRule(rule, normalized)) {
      return createClassification(rule.intent, rule.confidence, rule.reason);
    }
  }

  if (realtimeRule !== undefined && matchesRule(realtimeRule, normalized)) {
    return createClassification(realtimeRule.intent, realtimeRule.confidence, realtimeRule.reason);
  }

  return createClassification('unknown', 0.25, 'no deterministic product support intent matched');
}

function isAntiMevModeDocumentationQuestion(normalizedQuestion: string): boolean {
  return (
    /anti[- ]?mev\s+mode/u.test(normalizedQuestion) &&
    !/tx\s*hash|transaction\s*hash|explorer|solscan|etherscan|bscscan|basescan|sandwich|交易哈希|链上取证|链上交易|池子/u.test(
      normalizedQuestion,
    )
  );
}

export function hasProductDomainSignal(question: string): boolean {
  const normalized = question.normalize('NFKC').trim().toLowerCase();
  const productRule = rules.find((rule) => rule.intent === 'product_qa');

  return (
    productOperationPatterns.some((pattern) => pattern.test(normalized)) ||
    productSupportDomainPattern.test(normalized) ||
    (productRule !== undefined && matchesRule(productRule, normalized))
  );
}

function matchesRule(rule: IntentRule, normalizedQuestion: string): boolean {
  return rule.patterns.some((pattern) => pattern.test(normalizedQuestion));
}

function isProductSupportQuestion(normalizedQuestion: string): boolean {
  if (!supportQuestionPattern.test(normalizedQuestion)) {
    return false;
  }

  if (productSupportDomainPattern.test(normalizedQuestion)) {
    return true;
  }

  if (!hasExternalSupportEntity(normalizedQuestion)) {
    return false;
  }

  return (
    /是否支持|当前支持|现在支持|支持.*(?:吗|么|不)/u.test(normalizedQuestion) ||
    /(?:does|do|can|is|are)\s+xxyy\b.*\bsupport\b|\bxxyy\b.*\bsupport(?:s|ed)?\b/u.test(
      normalizedQuestion,
    )
  );
}

function hasExternalSupportEntity(normalizedQuestion: string): boolean {
  const tokens = normalizedQuestion.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/gu) ?? [];
  return tokens.some(
    (token) =>
      token.length > 1 &&
      token !== 'xxyy' &&
      token !== 'pro' &&
      !nonProductSupportLatinTokens.has(token),
  );
}

function createClassification(intent: Intent, confidence: number, reason: string): Classification {
  return {
    intent,
    confidence,
    reason,
  };
}
