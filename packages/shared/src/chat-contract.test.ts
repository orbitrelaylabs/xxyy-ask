import { describe, expect, it } from 'vitest';

import {
  chatStreamEventSchema,
  knowledgeSourceCatalog,
  supportedAgentRoutes,
  supportedChannels,
  supportedIntents,
  type ChatRequest,
  type ChatResponse,
} from './index.js';

describe('chat contract', () => {
  it('defines the three canonical XXYY knowledge sources', () => {
    expect(knowledgeSourceCatalog).toEqual({
      admin_verified: {
        canonicalUrl: undefined,
        label: 'XXYY 客服群审核知识',
      },
      official_docs: {
        canonicalUrl: 'https://docs.xxyy.io/',
        label: 'XXYY 官方文档',
      },
      x_updates: {
        canonicalUrl: 'https://x.com/useXXYYio',
        label: 'XXYY 官方 X 更新',
      },
    });
  });

  it('defines the supported entry channels', () => {
    expect(supportedChannels).toEqual(['cli', 'web', 'telegram']);
  });

  it('defines stable product support and boundary intents', () => {
    expect(supportedIntents).toEqual([
      'agent_capabilities',
      'product_qa',
      'how_to',
      'onchain_transaction',
      'realtime_account_query',
      'investment_advice',
      'unknown',
    ]);
  });

  it('defines the direct agent answer route separately from product answers', () => {
    expect(supportedAgentRoutes).toEqual([
      'agent_answer',
      'boundary',
      'chain_answer',
      'clarify',
      'product_answer',
    ]);
  });

  it('allows channel-neutral chat responses with citations', () => {
    const request: ChatRequest = {
      channel: 'web',
      message: 'XXYY Pro 有什么权益？',
      requestId: 'req-contract-1',
      sessionId: 'session-1',
    };

    const response: ChatResponse = {
      answer: '根据知识库，XXYY Pro 提供更多产品权益。',
      attachments: [
        {
          kind: 'video',
          mediaType: 'video/mp4',
          title: '添加到桌面演示',
          url: '/assets/xxyy-add-to-home.mp4',
        },
      ],
      citations: [
        {
          excerpt: 'Pro 权益',
          file: 'docs/product-features/pages/61-getting-started__xxyy-pro-quan-yi__pro.md',
          sourceType: 'official_docs',
          title: 'Pro',
        },
      ],
      confidence: 0.8,
      intent: 'product_qa',
      tokenUsage: {
        completionTokens: 36,
        promptTokens: 120,
        totalTokens: 156,
      },
    };

    expect(request.channel).toBe('web');
    expect(request.requestId).toBe('req-contract-1');
    expect(response.citations[0]?.title).toBe('Pro');
    expect(response.attachments?.[0]?.kind).toBe('video');
    expect(response.tokenUsage?.totalTokens).toBe(156);
  });

  it('allows image attachments for product knowledge responses', () => {
    const response: ChatResponse = {
      answer: '产品功能截图如下。',
      attachments: [
        {
          kind: 'image',
          mediaType: 'image/svg+xml',
          title: '产品功能截图',
          url: '/assets/xxyy-feature-card.svg',
        },
      ],
      citations: [],
      confidence: 0.8,
      intent: 'product_qa',
    };

    expect(response.attachments?.[0]?.kind).toBe('image');
  });

  it('allows linked external videos with an optional poster image', () => {
    const event = chatStreamEventSchema.parse({
      type: 'metadata',
      attachments: [
        {
          kind: 'video',
          mediaType: 'text/html',
          posterUrl: 'https://pbs.twimg.com/video-thumb.jpg',
          title: '官方 X 演示视频',
          url: 'https://x.com/useXXYYio/status/1/video/1',
        },
      ],
      citations: [],
      confidence: 0.8,
      intent: 'product_qa',
    });

    expect(event).toMatchObject({
      attachments: [{ kind: 'video', mediaType: 'text/html' }],
      type: 'metadata',
    });
  });

  it('validates chat stream events at runtime', () => {
    expect(
      chatStreamEventSchema.parse({
        type: 'answer_delta',
        delta: 'partial answer',
      }),
    ).toEqual({
      type: 'answer_delta',
      delta: 'partial answer',
    });

    expect(
      chatStreamEventSchema.parse({
        type: 'status',
        phase: 'retrieving',
        message: '正在检索知识库…',
      }),
    ).toEqual({
      type: 'status',
      phase: 'retrieving',
      message: '正在检索知识库…',
    });

    expect(
      chatStreamEventSchema.parse({
        type: 'metadata',
        citations: [],
        confidence: 0.8,
        intent: 'product_qa',
      }),
    ).toMatchObject({
      type: 'metadata',
      intent: 'product_qa',
    });

    expect(() =>
      chatStreamEventSchema.parse({
        type: 'metadata',
        confidence: 0.8,
        intent: 'unsupported_intent',
      }),
    ).toThrow();
  });
});
