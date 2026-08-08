import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdminApp, CandidateTable } from './AdminApp.js';

describe('AdminApp', () => {
  it('renders a neutral access check before authentication resolves', () => {
    const markup = renderToStaticMarkup(createElement(AdminApp));

    expect(markup).toContain('admin-auth-check-page');
    expect(markup).toContain('正在检查访问权限');
    expect(markup).not.toContain('admin-shell');
    expect(markup).not.toContain('admin-sidebar');
    expect(markup).not.toContain('知识候选');
    expect(markup).not.toContain('管理员账号');
    expect(markup).not.toContain('输入管理员密码');
  });

  it('renders candidates as a simple review table with direct actions', () => {
    const markup = renderToStaticMarkup(
      createElement(CandidateTable, {
        canReview: true,
        candidates: [
          {
            canonicalAnswer: '这是候选答案。',
            contentHash: 'hash-1',
            createdAt: '2026-08-05T00:00:00.000Z',
            id: 'candidate-1',
            question: '候选问题是什么？',
            sourceChannel: 'telegram',
            status: 'pending',
            updatedAt: '2026-08-05T00:00:00.000Z',
          },
        ],
        loading: false,
        onEdit: () => undefined,
        onReview: () => undefined,
      }),
    );

    expect(markup).toContain('问题 / 答案');
    expect(markup).toContain('操作');
    expect(markup).toContain('编辑 Q/A');
    expect(markup).toContain('批准');
    expect(markup).toContain('拒绝');
    expect(markup).toContain('待审核');
  });
});
