import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('root quality gate', () => {
  it('keeps the manual build, formatting, typecheck, test, and golden QA checks', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

    expect(packageJson.scripts.check).toContain('pnpm --filter @xxyy/web build');
    expect(packageJson.scripts.check).toContain('pnpm format:check');
    expect(packageJson.scripts.check).toContain('pnpm typecheck');
    expect(packageJson.scripts.check).toContain('pnpm test');
    expect(packageJson.scripts.check).toContain('pnpm rag:evaluate');
    expect(packageJson.scripts.check).not.toContain('pnpm lint');
    expect(packageJson.scripts.prepare).toBeUndefined();
  });
});
