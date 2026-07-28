import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ChatMessage } from './types.js';
import * as appModule from './App.js';

type AppendAnswerDelta = (message: ChatMessage, delta: string) => ChatMessage;

describe('appendAssistantAnswerDelta', () => {
  it('removes transient status metadata while appending streamed text', () => {
    const appendAssistantAnswerDelta = (
      appModule as typeof appModule & { appendAssistantAnswerDelta?: AppendAnswerDelta }
    ).appendAssistantAnswerDelta;
    expect(appendAssistantAnswerDelta).toBeTypeOf('function');
    if (appendAssistantAnswerDelta === undefined) {
      throw new Error('Expected appendAssistantAnswerDelta to be implemented.');
    }

    const message: ChatMessage = {
      attachments: [],
      citations: [],
      id: 'assistant-1',
      meta: '正在分析问题…',
      rawAnswer: '第一段',
      role: 'assistant',
      status: 'streaming',
      statusMessage: '正在分析问题…',
      text: '第一段',
    };

    expect(appendAssistantAnswerDelta(message, '第二段')).toEqual({
      attachments: [],
      citations: [],
      id: 'assistant-1',
      rawAnswer: '第一段第二段',
      role: 'assistant',
      status: 'streaming',
      text: '第一段第二段',
    });
  });
});

describe('AttachmentList', () => {
  it('renders local videos, screenshots, and external video links', () => {
    const markup = renderToStaticMarkup(
      createElement(appModule.AttachmentList, {
        attachments: [
          {
            kind: 'video',
            mediaType: 'video/mp4',
            title: '本地演示',
            url: '/assets/demo.mp4',
          },
          {
            kind: 'image',
            mediaType: 'image/png',
            title: '配置截图',
            url: '/assets/demo.png',
          },
          {
            kind: 'video',
            mediaType: 'text/html',
            posterUrl: 'https://pbs.twimg.com/thumb.jpg',
            title: '官方 X 视频',
            url: 'https://x.com/useXXYYio/status/1/video/1',
          },
        ],
      }),
    );

    expect(markup).toContain('<video');
    expect(markup).toContain('src="/assets/demo.mp4"');
    expect(markup).toContain('src="/assets/demo.png"');
    expect(markup).toContain('href="https://x.com/useXXYYio/status/1/video/1"');
    expect(markup).toContain('src="https://pbs.twimg.com/thumb.jpg"');
    expect(markup).toContain('打开原始视频');
  });
});

describe('CitationList', () => {
  it('shows a friendly official-source link without exposing the internal JSONL path', () => {
    const markup = renderToStaticMarkup(
      createElement(appModule.CitationList, {
        citations: [
          {
            excerpt: '最高享受 50% 返佣和 30% 返现。',
            file: 'docs/product-features/sources/usexxyyio-x-posts.jsonl',
            sourceType: 'x_updates',
            sourceUrl: 'https://x.com/useXXYYio/status/1997871585991229871',
            title: 'XXYY 官方 X 更新',
          },
        ],
      }),
    );

    expect(markup).toContain('查看官方 X 更新');
    expect(markup).toContain('href=\"https://x.com/useXXYYio/status/1997871585991229871\"');
    expect(markup).toContain('最高享受 50% 返佣和 30% 返现。');
    expect(markup).not.toContain('jsonl');
    expect(markup).not.toContain('docs/product-features/sources');
  });
});

describe('KnowledgeRefreshBadge', () => {
  it('renders enabled scheduling and freshness state', () => {
    const markup = renderToStaticMarkup(
      createElement(appModule.KnowledgeRefreshBadge, {
        result: {
          kind: 'loaded',
          status: {
            enabled: true,
            lastRun: {
              finishedAt: '2026-07-27T06:48:33.456Z',
              mode: 'incremental',
              status: 'succeeded',
            },
            schedule: {
              fullMode: 'manual',
              incrementalDailyAt: '08:00',
              timeZone: 'Asia/Shanghai',
            },
            state: 'healthy',
          },
        },
      }),
    );

    expect(markup).toContain('知识库自动更新已开启');
    expect(markup).toContain('最近刷新');
    expect(markup).toContain('每日 08:00 增量更新');
    expect(markup).toContain('全量更新仅手动执行');
    expect(markup).toContain('Asia/Shanghai');
    expect(markup).toContain('is-healthy');
  });

  it('renders unavailable state without claiming that refresh is enabled', () => {
    const markup = renderToStaticMarkup(
      createElement(appModule.KnowledgeRefreshBadge, {
        result: { kind: 'error' },
      }),
    );

    expect(markup).toContain('状态暂不可用');
    expect(markup).not.toContain('自动更新已开启');
    expect(markup).toContain('is-error');
  });
});
