import type { ChatHistoryMessage, Classification, SourceType } from '@xxyy/shared';

export const productQuestionKinds = [
  'capability_overview',
  'feature_support',
  'how_to',
  'limit_or_quota',
  'plan_entitlement',
  'comparison',
  'recent_updates',
  'historical_change',
  'agent_capabilities',
  'unknown',
] as const;

export type ProductQuestionKind = (typeof productQuestionKinds)[number];

export interface ProductQuestionUnderstanding {
  ambiguity: {
    requiresClarification: boolean;
    clarificationQuestion?: string;
    reason?: string;
  };
  confidence: number;
  entities: string[];
  kind: ProductQuestionKind;
  language: 'en' | 'mixed' | 'zh';
  modules: string[];
  subject: 'customer_agent' | 'unknown' | 'xxyy_product';
  temporalScope: 'current' | 'explicit_range' | 'historical' | 'unspecified';
  version: '1';
}

export interface ProductQueryPlan {
  maxSearches: number;
  originalQuestion: string;
  queries: Array<{
    preferredSourceTypes: SourceType[];
    query: string;
    facet?: string;
  }>;
  requiredFacets: string[];
  standaloneQuestion: string;
  strategy: 'clarify' | 'multi_query' | 'single';
  temporalScope: ProductQuestionUnderstanding['temporalScope'];
  version: '1';
}

export interface ProductRetrievalPolicy {
  anchorDocumentIds: string[];
  diversity: 'balanced' | 'none';
  preferredSourceTypes: SourceType[];
  temporalScope: ProductQuestionUnderstanding['temporalScope'];
  version: '1';
}

const CURRENT_CAPABILITY_OVERVIEW_DOCUMENT_ID =
  'official_docs:pages/00-current-capability-overview';

const capabilityOverviewPatterns = [
  /^(?:请|麻烦)?(?:介绍|说明|说)?(?:一下)?\s*(?:xxyy(?:\s*产品)?\s*)?(?:(?:目前|当前|现在)\s*)?(?:都|主要)?(?:支持|包含|提供|有)?\s*(?:哪些|什么|哪几)(?:主要)?(?:产品)?功能(?:[？?。.]|$)/u,
  /^(?:xxyy(?:\s*产品)?)\s*(?:是做什么的?|能做什么|有哪些能力)(?:[？?。.]|$)/u,
  /^(?:what|which)\s+(?:product\s+)?features?\s+(?:does\s+)?xxyy\s+(?:support|provide|have)/iu,
];

export function understandProductQuestion(
  question: string,
  classification: Classification,
): ProductQuestionUnderstanding {
  const normalized = question.normalize('NFKC').trim().toLowerCase();
  const common = understandingContext(question);

  if (classification.intent === 'agent_capabilities') {
    return {
      ...common,
      confidence: classification.confidence,
      kind: 'agent_capabilities',
      subject: 'customer_agent',
      temporalScope: 'unspecified',
    };
  }

  if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
    return {
      ...common,
      confidence: classification.confidence,
      kind: 'unknown',
      subject: 'unknown',
      temporalScope: temporalScopeForQuestion(normalized),
    };
  }

  const temporalScope = temporalScopeForQuestion(normalized);
  if (classification.intent === 'how_to') {
    return {
      ...common,
      confidence: classification.confidence,
      kind: 'how_to',
      subject: 'xxyy_product',
      temporalScope,
    };
  }

  if (capabilityOverviewPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      ...common,
      confidence: 0.9,
      kind: 'capability_overview',
      subject: 'xxyy_product',
      temporalScope: temporalScope === 'unspecified' ? 'current' : temporalScope,
    };
  }

  if (/比较|对比|区别|分别|\bcompare\b|\bversus\b|\bvs\.?\b/iu.test(normalized)) {
    return {
      ...common,
      confidence: 0.88,
      kind: 'comparison',
      subject: 'xxyy_product',
      temporalScope,
    };
  }

  if (/历史|以前|过去|当时|曾经|哪次更新|什么时候上线|何时上线/u.test(normalized)) {
    return {
      ...common,
      confidence: 0.88,
      kind: 'historical_change',
      subject: 'xxyy_product',
      temporalScope: 'historical',
    };
  }

  if (/最近|最新|近期|本次|这次.{0,8}更新|更新了什么/u.test(normalized)) {
    return {
      ...common,
      confidence: 0.88,
      kind: 'recent_updates',
      subject: 'xxyy_product',
      temporalScope: 'current',
    };
  }

  if (/多少|最多|最少|上限|下限|限制|额度|几条|几个|几种/u.test(normalized)) {
    return {
      ...common,
      confidence: 0.86,
      kind: 'limit_or_quota',
      subject: 'xxyy_product',
      temporalScope,
    };
  }

  if (/\bpro\b|\bbasic\b|会员|权益|套餐|永久\s*pro/iu.test(normalized)) {
    return {
      ...common,
      confidence: 0.86,
      kind: 'plan_entitlement',
      subject: 'xxyy_product',
      temporalScope,
    };
  }

  return {
    ...common,
    confidence: classification.confidence,
    kind: 'feature_support',
    subject: 'xxyy_product',
    temporalScope,
  };
}

export function createInitialProductSearchQuery(
  question: string,
  understanding: ProductQuestionUnderstanding,
): string {
  if (understanding.kind !== 'capability_overview') {
    return question;
  }

  return 'XXYY 当前支持的产品功能总览 交易 钱包监控 数据分析 移动端';
}

export function createStandaloneProductQuestion(
  question: string,
  history: readonly ChatHistoryMessage[] = [],
): string {
  const current = question.trim();
  if (!isContextDependentQuestion(current) || history.length === 0) {
    return current;
  }

  const recentHistory = history.slice(-10).reverse();
  const isProductContext = (message: ChatHistoryMessage) =>
    !isContextDependentQuestion(message.content) &&
    /xxyy|\bpro\b|\bbasic\b|功能|权益|套餐|钱包|交易|监控|提醒|设置/iu.test(message.content);
  const previousContext =
    recentHistory.find((message) => message.role === 'user' && isProductContext(message))
      ?.content ?? recentHistory.find(isProductContext)?.content;
  if (previousContext === undefined) {
    return current;
  }

  if (/^(?:那|那么)?\s*(?:免费版|basic)(?:呢|怎么样|有什么)?[？?。.]?$/iu.test(current)) {
    const focus = /权益/u.test(previousContext) ? '功能和权益' : '功能';
    return `XXYY Basic 免费版当前有哪些${focus}？`;
  }

  const conciseCurrent = current.replace(/^(?:那|那么|这个|该|它)\s*/u, '').trim();
  return `关于“${previousContext.slice(0, 160)}”，${conciseCurrent}`.slice(0, 400);
}

export function createProductQueryPlan(
  originalQuestion: string,
  standaloneQuestion: string,
  understanding: ProductQuestionUnderstanding,
): ProductQueryPlan {
  const retrievalPolicy = createProductRetrievalPolicy(understanding);
  if (understanding.kind === 'capability_overview') {
    return {
      maxSearches: 3,
      originalQuestion,
      queries: [
        {
          facet: '功能目录',
          preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
          query: createInitialProductSearchQuery(standaloneQuestion, understanding),
        },
        {
          facet: '交易',
          preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
          query: 'XXYY 当前交易 数据分析 行情 K线 支持功能 官方文档',
        },
        {
          facet: '钱包',
          preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
          query: 'XXYY 当前钱包管理 钱包监控 Telegram 通知 移动端 官方文档',
        },
      ],
      requiredFacets: ['交易', '钱包', '监控', '移动端'],
      standaloneQuestion,
      strategy: 'multi_query',
      temporalScope: understanding.temporalScope,
      version: '1',
    };
  }

  return {
    maxSearches: 2,
    originalQuestion,
    queries: [
      {
        preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
        query: standaloneQuestion,
      },
    ],
    requiredFacets: [],
    standaloneQuestion,
    strategy: 'single',
    temporalScope: understanding.temporalScope,
    version: '1',
  };
}

export function createProductRetrievalPolicy(
  understanding: ProductQuestionUnderstanding,
): ProductRetrievalPolicy {
  const preferredSourceTypes: SourceType[] =
    understanding.kind === 'recent_updates' || understanding.kind === 'historical_change'
      ? ['x_updates', 'official_docs', 'admin_verified']
      : understanding.kind === 'how_to'
        ? ['official_docs', 'admin_verified', 'x_updates']
        : ['admin_verified', 'official_docs', 'x_updates'];
  return {
    anchorDocumentIds:
      understanding.kind === 'capability_overview' ? [CURRENT_CAPABILITY_OVERVIEW_DOCUMENT_ID] : [],
    diversity:
      understanding.kind === 'capability_overview' || understanding.kind === 'comparison'
        ? 'balanced'
        : 'none',
    preferredSourceTypes,
    temporalScope: understanding.temporalScope,
    version: '1',
  };
}

export function selectNextProductQuery(
  plan: ProductQueryPlan,
  missingFacets: readonly string[],
  searchedQueries: readonly string[],
): string | undefined {
  const searched = new Set(searchedQueries.map((query) => compactQuery(query)));
  const candidates = plan.queries.filter(
    (candidate) => !searched.has(compactQuery(candidate.query)),
  );
  return (
    candidates.find((candidate) =>
      missingFacets.some(
        (facet) => candidate.query.includes(facet) || candidate.facet?.includes(facet),
      ),
    ) ?? candidates[0]
  )?.query;
}

export function isCapabilityOverviewQuestion(question: string): boolean {
  const normalized = question.normalize('NFKC').trim().toLowerCase();
  return capabilityOverviewPatterns.some((pattern) => pattern.test(normalized));
}

function temporalScopeForQuestion(
  normalizedQuestion: string,
): ProductQuestionUnderstanding['temporalScope'] {
  if (
    /(?:19|20)\d{2}\s*(?:年|[-/]\d{1,2})?\s*(?:到|至|[-~～])\s*(?:19|20)\d{2}/u.test(
      normalizedQuestion,
    )
  ) {
    return 'explicit_range';
  }
  if (/历史|以前|过去|当时|曾经|(?:19|20)\d{2}/u.test(normalizedQuestion)) {
    return 'historical';
  }
  if (/当前|现在|目前|最近|最新|today|current|currently|latest/iu.test(normalizedQuestion)) {
    return 'current';
  }
  return 'unspecified';
}

function understandingContext(
  question: string,
): Pick<
  ProductQuestionUnderstanding,
  'ambiguity' | 'entities' | 'language' | 'modules' | 'version'
> {
  return {
    ambiguity: { requiresClarification: false },
    entities: [
      ...new Set(
        question.match(/\b(?:XXYY|Basic|Pro|Telegram|BSC|Solana|EVM)\b/giu)?.map(String) ?? [],
      ),
    ],
    language: languageForQuestion(question),
    modules: [
      ...new Set(
        [
          ['交易', /交易|swap|挂单|止盈|止损/iu],
          ['钱包', /钱包|wallet/iu],
          ['监控', /监控|提醒|通知|monitor/iu],
          ['数据分析', /行情|k\s*线|数据|分析|holder/iu],
          ['移动端', /移动端|手机|mobile/iu],
          ['会员', /\bpro\b|\bbasic\b|权益|套餐|会员/iu],
        ].flatMap(([module, pattern]) =>
          (pattern as RegExp).test(question) ? [module as string] : [],
        ),
      ),
    ],
    version: '1',
  };
}

function languageForQuestion(question: string): ProductQuestionUnderstanding['language'] {
  const hasHan = /\p{Script=Han}/u.test(question);
  const hasLatin = /[A-Za-z]/u.test(question);
  return hasHan && hasLatin ? 'mixed' : hasHan ? 'zh' : 'en';
}

function isContextDependentQuestion(question: string): boolean {
  return (
    question.length <= 48 &&
    /^(?:那|那么|这个|该|它|还有|然后|以及|另外|怎么|如何|能否|可以|是否|为什么|在哪里|多少钱|多久)/u.test(
      question,
    )
  );
}

function compactQuery(query: string): string {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
