import { describe, expect, it } from 'vitest';

import { renderAdminPage } from './index.js';

describe('renderAdminPage', () => {
  it('renders a noindex shell using the same reviewed Vite bundle', () => {
    const html = renderAdminPage();

    expect(html).toContain('<title>XXYY Knowledge Admin</title>');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain('/web-assets/index.js');
    expect(html).not.toContain('/api/chat/stream');
  });
});
