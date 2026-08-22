import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  AdminApp,
  AdminUsersPanel,
  CandidateTable,
  groupTelegramMessagesIntoConversations,
  parseAdminTab,
} from './AdminApp.js';

describe('AdminApp', () => {
  it('restores the selected admin tab from the URL after refresh', () => {
    expect(parseAdminTab('?tab=telegram-users')).toBe('telegram-users');
    expect(parseAdminTab('?tab=users&source=refresh')).toBe('users');
    expect(parseAdminTab('?tab=unknown')).toBe('candidates');
  });

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
    expect(markup).toContain('candidate-source-cell');
  });

  it('prevents password managers from filling the new administrator form with login data', () => {
    const markup = renderToStaticMarkup(
      createElement(AdminUsersPanel, {
        currentUserId: 'admin',
        permissions: new Set(['user:manage'] as const),
        token: 'test-token',
      }),
    );

    expect(markup).toContain('<form autoComplete="off"');
    expect(markup.match(/autoComplete="new-password"/gu)).toHaveLength(2);
  });

  it('groups Telegram replies into selectable conversations without losing standalone messages', () => {
    const base = {
      authorIsBot: false,
      authorUserId: '123',
      capturedAt: '2026-08-22T01:00:00.000Z',
      chatId: '-100123',
      sentAt: '2026-08-22T01:00:00.000Z',
      text: 'message',
    };
    const conversations = groupTelegramMessagesIntoConversations([
      { ...base, messageId: '1', text: '问题' },
      { ...base, messageId: '2', replyToMessageId: '1', text: '追问' },
      { ...base, messageId: '3', replyToMessageId: '2', text: '管理员回答' },
      { ...base, messageId: '4', text: '单独消息' },
      { ...base, messageId: '5', replyToMessageId: '9', text: '缺失根消息的回复' },
      { ...base, messageId: '6', replyToMessageId: '9', text: '同一缺失根消息的另一条回复' },
    ]);

    expect(conversations.map((conversation) => conversation.id)).toEqual(['1', '4', 'reply:9']);
    expect(conversations.map((conversation) => conversation.messageIds)).toEqual([
      ['1', '2', '3'],
      ['4'],
      ['5', '6'],
    ]);
  });
});
