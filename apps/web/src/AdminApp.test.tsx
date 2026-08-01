import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdminApp } from './AdminApp.js';

describe('AdminApp', () => {
  it('renders a database administrator login before loading governance data', () => {
    const markup = renderToStaticMarkup(createElement(AdminApp));

    expect(markup).toContain('知识库管理后台');
    expect(markup).toContain('管理员账号');
    expect(markup).toContain('管理员密码');
    expect(markup).toContain('管理员用户页面维护');
    expect(markup).not.toContain('知识候选审核');
  });
});
