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
    subquestionId?: string;
    topK?: number;
  }>;
  requiredFacets: string[];
  standaloneQuestion: string;
  strategy: 'clarify' | 'multi_query' | 'single';
  subquestions: ProductSubquestion[];
  temporalScope: ProductQuestionUnderstanding['temporalScope'];
  version: '1';
}

export interface ProductSubquestion {
  facet: string;
  id: string;
  question: string;
  query: string;
  topK: number;
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
const COPY_TRADING_DOCUMENT_ID = 'official_docs:pages/138-getting-started__gen-dan';
const CURRENT_SUPPORTED_CHAINS_DOCUMENT_ID = 'x_updates:pages/139-current-supported-chains';
const CURRENT_LAUNCHPAD_SUPPORT_DOCUMENT_ID = 'x_updates:pages/140-current-launchpad-support';

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
    !/^(?:那|那么|这个|该|它|还有|然后|另外)(?:呢|吗|么|怎么|如何)?[？?。.]?$/u.test(
      message.content.trim(),
    ) && /xxyy|\bpro\b|\bbasic\b|功能|权益|套餐|钱包|交易|监控|提醒|设置/iu.test(message.content);
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

  if (
    /^(?:那|那么)?\s*(?:手机端|移动端|手机上)(?:呢|怎么操作|怎么设置|如何操作)?[？?。.]?$/u.test(
      current,
    )
  ) {
    const action = productActionFromContext(previousContext);
    return action === undefined ? 'XXYY 移动端支持哪些相关功能？' : `XXYY 移动端${action}`;
  }

  if (/^(?:那|那么)?\s*(?:有)?(?:数量)?(?:上限|限制)(?:吗|么|呢)?[？?。.]?$/u.test(current)) {
    const topic = productTopicFromContext(previousContext);
    if (topic !== undefined) {
      return `${topic}有数量限制吗？`;
    }
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
    const subquestions: ProductSubquestion[] = [
      createSubquestion('功能目录', 'XXYY 当前支持的产品功能总览', 8, 1),
      createSubquestion('交易', 'XXYY 当前交易、数据分析和行情功能', 7, 2),
      createSubquestion('钱包、监控、移动端', 'XXYY 当前钱包管理、钱包监控和移动端功能', 7, 3),
    ];
    return {
      maxSearches: 3,
      originalQuestion,
      queries: [
        {
          facet: '功能目录',
          preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
          query: createInitialProductSearchQuery(standaloneQuestion, understanding),
          subquestionId: 'sq1',
          topK: 8,
        },
        {
          facet: '交易',
          preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
          query: 'XXYY 当前交易 数据分析 行情 K线 支持功能 官方文档',
          subquestionId: 'sq2',
          topK: 7,
        },
        {
          facet: '钱包',
          preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
          query: 'XXYY 当前钱包管理 钱包监控 Telegram 通知 移动端支持功能 官方文档',
          subquestionId: 'sq3',
          topK: 7,
        },
      ],
      requiredFacets: ['交易', '钱包', '监控', '移动端'],
      standaloneQuestion,
      strategy: 'multi_query',
      subquestions,
      temporalScope: understanding.temporalScope,
      version: '1',
    };
  }

  const subquestions = decomposeProductQuestion(standaloneQuestion);
  if (subquestions.length > 1) {
    return {
      maxSearches: Math.min(4, subquestions.length),
      originalQuestion,
      queries: subquestions.map((subquestion) => ({
        facet: subquestion.facet,
        preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
        query: subquestion.query,
        subquestionId: subquestion.id,
        topK: subquestion.topK,
      })),
      requiredFacets: subquestions.map((subquestion) => subquestion.facet),
      standaloneQuestion,
      strategy: 'multi_query',
      subquestions,
      temporalScope: understanding.temporalScope,
      version: '1',
    };
  }

  const singleSubquestion =
    subquestions[0] ??
    createSubquestion(
      createProductSubquestionFacet(standaloneQuestion),
      standaloneQuestion,
      topKForQuestion(standaloneQuestion),
      1,
    );

  return {
    maxSearches: 2,
    originalQuestion,
    queries: [
      {
        preferredSourceTypes: retrievalPolicy.preferredSourceTypes,
        query: standaloneQuestion,
        subquestionId: singleSubquestion.id,
        topK: singleSubquestion.topK,
      },
    ],
    requiredFacets: [],
    standaloneQuestion,
    strategy: 'single',
    subquestions: [singleSubquestion],
    temporalScope: understanding.temporalScope,
    version: '1',
  };
}

export function decomposeProductQuestion(question: string): ProductSubquestion[] {
  const normalized = question.normalize('NFKC').trim();
  if (normalized.length === 0) return [];
  const marked = normalized
    .replace(/[？?；;]+\s*/gu, '|')
    .replace(
      /[，,]\s*(?=(?:怎么|如何|是否|能否|可以|还有|另外|升级后|开通后|设置后|并且|同时|when|how|what|which|is|can))/giu,
      '|',
    )
    .replace(/\s+(?:and|also)\s+(?=(?:how|what|which|is|can|does|when)\b)/giu, '|')
    .replace(/(?:以及|并且|另外|同时)\s*(?=(?:怎么|如何|是否|能否|可以|还有))/gu, '|')
    .replace(/和\s*(?=(?:怎么|如何|是否|能否|可以))/gu, '|');
  const segments = marked
    .split('|')
    .map((segment) => segment.replace(/^[，,。.!！\s]+|[，,。.!！\s]+$/gu, '').trim())
    .filter((segment) => segment.length >= 2);
  if (segments.length <= 1) {
    return [
      createSubquestion(
        createProductSubquestionFacet(normalized),
        normalized,
        topKForQuestion(normalized),
        1,
      ),
    ];
  }

  const sharedSubject = extractSharedProductSubject(normalized);
  return [...new Set(segments)].slice(0, 4).map((segment, index) => {
    const standaloneSegment =
      sharedSubject === undefined || hasExplicitProductSubject(segment)
        ? segment
        : `${sharedSubject} ${segment}`;
    return createSubquestion(
      createProductSubquestionFacet(standaloneSegment),
      standaloneSegment,
      topKForQuestion(standaloneSegment),
      index + 1,
    );
  });
}

export function createProductSubquestionFacet(question: string): string {
  const facet = question
    .replace(/[？?。.!！]/gu, '')
    .replace(/^(?:请|帮我|麻烦|想知道|请问)\s*/u, '')
    .replace(/(?:当前|现在|目前)?(?:都)?(?:有|是)?(?:哪些|什么)(?=\S)/gu, '')
    .replace(/(?:怎么|如何|怎样)(?=\S)/gu, '')
    .replace(/(?:是否|能否|可否|可以不可以)/gu, '')
    .replace(/(?:升级|开通|设置)后(?=永久|长期|有效)/gu, '')
    .replace(/(?:吗|么|呢)$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return (facet.length >= 2 ? facet : question.trim()).slice(0, 80);
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
      understanding.kind === 'capability_overview'
        ? [CURRENT_CAPABILITY_OVERVIEW_DOCUMENT_ID]
        : understanding.modules.includes('发射平台')
          ? [CURRENT_LAUNCHPAD_SUPPORT_DOCUMENT_ID]
          : understanding.modules.includes('跟单')
            ? [COPY_TRADING_DOCUMENT_ID]
            : understanding.modules.includes('链支持')
              ? [CURRENT_SUPPORTED_CHAINS_DOCUMENT_ID]
              : [],
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
  return selectNextProductQuerySpec(plan, missingFacets, searchedQueries)?.query;
}

export function selectNextProductQuerySpec(
  plan: ProductQueryPlan,
  missingFacets: readonly string[],
  searchedQueries: readonly string[],
): ProductQueryPlan['queries'][number] | undefined {
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
  );
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
          ['跟单', /跟单|copy\s*trad(?:e|ing)/iu],
          ['发射平台', /发射台|发射平台|launch\s*(?:pad|platform)/iu],
          [
            '链支持',
            /支持(?:哪些|什么|哪几)(?:条)?(?:公)?链|(?:哪些|什么|哪几)(?:条)?(?:公)?链支持|supported\s+chains?/iu,
          ],
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
    /^(?:那|那么|这个|该|它|还有|然后|以及|另外|怎么|如何|能否|可以|是否|为什么|在哪里|多少钱|多久|手机端|移动端|手机上|有数量|数量上限|数量限制|有限制|有上限)/u.test(
      question,
    )
  );
}

function productActionFromContext(context: string): string | undefined {
  const normalized = context
    .normalize('NFKC')
    .replace(/^关于[“"]?|[”"]$/gu, '')
    .replace(/^(?:请|请问|帮我|麻烦)?\s*(?:XXYY\s*)?/iu, '')
    .replace(/[？?。.!！]+$/u, '')
    .trim();
  if (normalized.length < 2) return undefined;
  if (/^(?:怎么|如何|怎样|在哪里|能否|可以)/u.test(normalized)) return normalized;
  if (/设置|配置|登录|升级|开通|操作|使用/u.test(normalized)) return `如何${normalized}`;
  return undefined;
}

function productTopicFromContext(context: string): string | undefined {
  const normalized = context
    .normalize('NFKC')
    .replace(/^(?:请|请问|帮我|麻烦)?\s*/u, '')
    .replace(/(?:怎么|如何|怎样)(?:设置|配置|使用|操作)?/gu, '')
    .replace(/(?:有)?(?:数量)?(?:上限|限制)(?:吗|么)?/gu, '')
    .replace(/[？?。.!！]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length < 2) return undefined;
  return /xxyy/iu.test(normalized) ? normalized : `XXYY ${normalized}`;
}

function createSubquestion(
  facet: string,
  question: string,
  topK: number,
  index: number,
): ProductSubquestion {
  const normalizedQuestion = question.trim().replace(/[。.!！]+$/u, '');
  return {
    facet: facet.trim().slice(0, 80),
    id: `sq${index}`,
    question: normalizedQuestion,
    query: normalizedQuestion,
    topK,
  };
}

function topKForQuestion(question: string): number {
  if (/比较|对比|区别|分别|compare|versus|\bvs\b/iu.test(question)) return 8;
  if (/如何|怎么|怎样|步骤|设置|配置|how\s+to/iu.test(question)) return 8;
  if (/哪些|列表|包括|包含|所有|全部/iu.test(question)) return 7;
  return 6;
}

function extractSharedProductSubject(question: string): string | undefined {
  const explicit = question.match(/\bXXYY\b\s*(?:Pro|Basic)?|XXYY\s*(?:Pro|Basic)?/iu)?.[0];
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();
  const plan = question.match(/\b(?:Pro|Basic)\b/iu)?.[0];
  return plan === undefined ? 'XXYY' : `XXYY ${plan}`;
}

function hasExplicitProductSubject(question: string): boolean {
  return /\bXXYY\b|XXYY|\bPro\b|\bBasic\b/iu.test(question);
}

function compactQuery(query: string): string {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
