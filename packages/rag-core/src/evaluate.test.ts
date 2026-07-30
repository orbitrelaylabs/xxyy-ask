import { describe, expect, it } from 'vitest';

import type { AnswerProvider } from './answer-provider.js';
import { createChatService, type ChatService } from './chat-service.js';
import { evaluateCases } from './evaluate.js';
import { createFixtureIndex } from './test-fixtures.js';

describe('evaluateCases', () => {
  it('enforces structured intent, source, facet, standalone, search, and answer-state gates', async () => {
    const service: ChatService = {
      ask: () =>
        Promise.resolve({
          answer: 'XXYY 当前支持交易、钱包、监控和移动端登录。',
          answerStatus: 'complete',
          citations: [
            {
              excerpt: '交易、钱包、监控、移动端。',
              file: 'docs/overview.md',
              sourceType: 'official_docs',
              title: '当前功能总览',
            },
          ],
          confidence: 0.9,
          intent: 'product_qa',
        }),
      async *stream() {},
    };

    const report = await evaluateCases(
      [
        {
          expectedAnswerStatus: 'complete',
          expectedClarification: false,
          expectedFineGrainedIntent: 'capability_overview',
          expectedIntent: 'product_qa',
          expectedPartialAnswer: false,
          expectedSearchCountRange: [1, 2],
          expectedStandaloneQuestionTerms: ['支持', '功能'],
          expectedSubject: 'xxyy_product',
          maximumXSourceCount: 0,
          minimumFacetCoverage: 1,
          name: 'overview quality contract',
          request: { channel: 'web', message: '支持哪些功能' },
          requiredFacets: ['交易', '钱包', '监控', '移动端'],
          requiredSourceTypes: ['official_docs'],
        },
      ],
      service,
      { observe: () => ({ searchCount: 1 }) },
    );

    expect(report.passed).toBe(1);
  });

  it('ignores presentational whitespace and Markdown punctuation in required facts', async () => {
    const service: ChatService = {
      ask: () =>
        Promise.resolve({
          answer: '最多支持 **5000 个地址**，并提供 P1/P2/P3 档位。',
          citations: [],
          confidence: 0.8,
          intent: 'product_qa',
        }),
      async *stream() {},
    };

    const report = await evaluateCases(
      [
        {
          name: 'format-independent facts',
          request: { channel: 'web', message: '支持多少地址和哪些档位？' },
          expectedIntent: 'product_qa',
          requiredAnswerIncludes: ['5000个地址', 'P1 P2 P3'],
        },
      ],
      service,
    );

    expect(report.passed).toBe(1);
  });

  it('checks expected intent and minimum citation counts', async () => {
    const answerProvider: AnswerProvider = {
      answer({ classification, retrievedChunks }) {
        return Promise.resolve({
          answer: 'XXYY Pro 支持 Telegram 钱包监控。',
          citations: retrievedChunks.map((chunk) => ({
            excerpt: chunk.text,
            file: chunk.metadata.file,
            title: chunk.metadata.title,
          })),
          confidence: classification.confidence,
          intent: classification.intent,
        });
      },
    };
    const service = createChatService({
      answerProvider,
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          file: '/docs/pro.md',
          text: 'XXYY Pro 支持 Telegram 钱包监控。',
        },
      ]),
    });

    const report = await evaluateCases(
      [
        {
          name: 'pro citations',
          request: { channel: 'web', message: 'XXYY Pro 支持什么？' },
          expectedIntent: 'product_qa',
          minCitations: 1,
        },
        {
          name: 'intent mismatch',
          request: { channel: 'web', message: '帮我查钱包余额' },
          expectedIntent: 'product_qa',
          minCitations: 1,
        },
      ],
      service,
    );

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.results[0]).toMatchObject({
      name: 'pro citations',
      passed: true,
      actualIntent: 'product_qa',
      citationCount: 1,
    });
    expect(report.results[1]).toMatchObject({
      name: 'intent mismatch',
      passed: false,
      actualIntent: 'realtime_account_query',
      citationCount: 0,
    });
  });

  it('reports progress after each evaluated case', async () => {
    const answerProvider: AnswerProvider = {
      answer({ classification, retrievedChunks }) {
        return Promise.resolve({
          answer: 'XXYY Pro 支持 Telegram 钱包监控。',
          citations: retrievedChunks.map((chunk) => ({
            excerpt: chunk.text,
            file: chunk.metadata.file,
            title: chunk.metadata.title,
          })),
          confidence: classification.confidence,
          intent: classification.intent,
        });
      },
    };
    const service = createChatService({
      answerProvider,
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          file: '/docs/pro.md',
          text: 'XXYY Pro 支持 Telegram 钱包监控。',
        },
      ]),
    });
    const progress: string[] = [];

    await evaluateCases(
      [
        {
          name: 'pro citations',
          request: { channel: 'web', message: 'XXYY Pro 支持什么？' },
          expectedIntent: 'product_qa',
          minCitations: 1,
        },
        {
          name: 'account boundary',
          request: { channel: 'web', message: '帮我查一下钱包余额' },
          expectedIntent: 'realtime_account_query',
        },
      ],
      service,
      {
        onResult(result, index, total) {
          progress.push(`${index}/${total}:${result.name}:${result.passed ? 'PASS' : 'FAIL'}`);
        },
      },
    );

    expect(progress).toEqual(['1/2:pro citations:PASS', '2/2:account boundary:PASS']);
  });

  it('checks answer content and required citation sources', async () => {
    const answerProvider: AnswerProvider = {
      answer({ classification, question, retrievedChunks }) {
        const isBadAnswer = question.includes('错误示例');
        return Promise.resolve({
          answer: isBadAnswer
            ? 'XXYY Pro 可以帮你判断今天买哪个币，这是投资建议。'
            : 'XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
          citations: isBadAnswer
            ? []
            : retrievedChunks.map((chunk) => ({
                excerpt: chunk.text,
                file: chunk.metadata.file,
                title: chunk.metadata.title,
                ...(chunk.metadata.sourceUrl === undefined
                  ? {}
                  : { sourceUrl: chunk.metadata.sourceUrl }),
              })),
          confidence: classification.confidence,
          intent: classification.intent,
        });
      },
    };
    const service = createChatService({
      answerProvider,
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          sourceUrl: 'https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi',
          file: '/docs/pro.md',
          text: 'XXYY Pro 权益包括独享服务器和节点、监控2000个钱包、收藏1000个代币。',
        },
      ]),
    });

    const report = await evaluateCases(
      [
        {
          name: 'pro answer quality',
          request: { channel: 'web', message: 'XXYY Pro 权益有哪些？' },
          expectedIntent: 'product_qa',
          minCitations: 1,
          requiredAnswerIncludes: ['独享服务器和节点', '监控2000个钱包'],
          forbiddenAnswerIncludes: ['投资建议'],
          requiredCitationFiles: ['/docs/pro.md'],
          requiredCitationTitles: ['XXYY Pro 权益'],
          requiredSourceUrls: ['https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi'],
        },
        {
          name: 'bad pro answer quality',
          request: { channel: 'web', message: 'XXYY Pro 权益错误示例？' },
          expectedIntent: 'product_qa',
          minCitations: 1,
          requiredAnswerIncludes: ['独享服务器和节点'],
          forbiddenAnswerIncludes: ['投资建议'],
          requiredCitationFiles: ['/docs/pro.md'],
          requiredCitationTitles: ['XXYY Pro 权益'],
          requiredSourceUrls: ['https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi'],
        },
        {
          name: 'stale citation precision',
          request: { channel: 'web', message: 'XXYY Pro 权益有哪些？' },
          expectedIntent: 'product_qa',
          forbiddenCitationFiles: ['/docs/pro.md'],
          forbiddenSourceUrls: ['https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi'],
        },
      ],
      service,
    );

    expect(report.passed).toBe(1);
    expect(report.results[0]).toMatchObject({
      name: 'pro answer quality',
      passed: true,
      failureReasons: [],
    });
    expect(report.results[1]).toMatchObject({
      name: 'bad pro answer quality',
      passed: false,
      failureReasons: [
        'citations 0/1',
        'answer missing required text: 独享服务器和节点',
        'answer contains forbidden text: 投资建议',
        'missing citation file: /docs/pro.md',
        'missing citation title: XXYY Pro 权益',
        'missing source URL: https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi',
      ],
    });
    expect(report.results[2]).toMatchObject({
      name: 'stale citation precision',
      passed: false,
      failureReasons: [
        'forbidden citation file: /docs/pro.md',
        'forbidden source URL: https://docs.xxyy.io/getting-started/xxyy-pro-quan-yi',
      ],
    });
  });

  it('checks required answer text is supported by citation excerpts when requested', async () => {
    const answerProvider: AnswerProvider = {
      answer({ classification }) {
        return Promise.resolve({
          answer: 'XXYY Pro 权益包括独享服务器和节点、监控2000个钱包。',
          citations: [
            {
              excerpt: 'XXYY Pro 权益包括独享服务器和节点。',
              file: '/docs/pro.md',
              title: 'XXYY Pro 权益',
            },
          ],
          confidence: classification.confidence,
          intent: classification.intent,
        });
      },
    };
    const service = createChatService({
      answerProvider,
      index: createFixtureIndex([
        {
          id: 'official_docs:pro:chunk:0001',
          title: 'XXYY Pro 权益',
          sourceType: 'official_docs',
          file: '/docs/pro.md',
          text: 'XXYY Pro 权益包括独享服务器和节点。',
        },
      ]),
    });

    const report = await evaluateCases(
      [
        {
          name: 'grounding',
          request: { channel: 'web', message: 'XXYY Pro 权益有哪些？' },
          expectedIntent: 'product_qa',
          requiredAnswerIncludes: ['独享服务器和节点', '监控2000个钱包'],
          requireCitationSupport: true,
        },
      ],
      service,
    );

    expect(report.results[0]).toMatchObject({
      passed: false,
      failureReasons: ['answer text is not supported by citations: 监控2000个钱包'],
    });
  });

  it('captures observations and checks route and exact tool trajectory', async () => {
    const response = {
      agentRoute: 'product_answer' as const,
      answer: '钱包监控当前支持5000个地址。',
      citations: [],
      confidence: 0.9,
      intent: 'product_qa' as const,
    };
    const service: ChatService = {
      ask: () => Promise.resolve(response),
      async *stream() {
        await Promise.resolve();
        yield {
          type: 'metadata' as const,
          citations: [],
          confidence: response.confidence,
          intent: response.intent,
        };
      },
    };
    const cases = [
      {
        name: 'observed trajectory',
        request: { channel: 'web' as const, message: '现在支持多少地址？' },
        expectedIntent: 'product_qa' as const,
        expectedAgentRoute: 'product_answer' as const,
        expectedToolNames: ['search_product_docs'],
        forbiddenChunkIds: ['chunk-old'],
        referenceFacts: ['5000个地址'],
        relevantChunkIds: ['chunk-current'],
      },
      {
        name: 'trajectory mismatch',
        request: { channel: 'web' as const, message: '现在支持多少地址？' },
        expectedIntent: 'product_qa' as const,
        expectedAgentRoute: 'clarify' as const,
        expectedToolNames: ['lookup_other_tool'],
      },
      {
        name: 'legacy case',
        request: { channel: 'web' as const, message: '现在支持多少地址？' },
        expectedIntent: 'product_qa' as const,
      },
    ];

    const report = await evaluateCases(cases, service, {
      observe(testCase, observedResponse) {
        expect(observedResponse).toBe(response);
        return testCase.name === 'legacy case'
          ? {}
          : {
              retrievedChunkIds: ['chunk-current'],
              toolNames: ['search_product_docs'],
            };
      },
    });

    expect(report.results[0]).toMatchObject({
      actualAgentRoute: 'product_answer',
      forbiddenChunkIds: ['chunk-old'],
      passed: true,
      referenceFacts: ['5000个地址'],
      relevantChunkIds: ['chunk-current'],
      response,
      retrievedChunkIds: ['chunk-current'],
      toolNames: ['search_product_docs'],
    });
    expect(report.results[1]).toMatchObject({
      passed: false,
      failureReasons: [
        'agent route product_answer != clarify',
        'tool trajectory search_product_docs != lookup_other_tool',
      ],
    });
    expect(report.results[2]).toMatchObject({
      passed: true,
      retrievedChunkIds: [],
      toolNames: [],
    });
  });
});
