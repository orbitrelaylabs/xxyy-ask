import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('root quality gate', () => {
  it('runs the deterministic golden QA evaluation as part of pnpm check', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

    expect(packageJson.scripts.check).toContain('pnpm --filter @xxyy/web build');
    expect(packageJson.scripts.check).toContain('pnpm rag:evaluate');
    expect(packageJson.scripts['hook:pre-commit']).toBe('node scripts/validate-staged-files.mjs');
    expect(packageJson.scripts['hook:pre-push']).toBe('node scripts/run-pre-push.mjs');
    expect(packageJson.scripts['hooks:install']).toBe('node scripts/setup-git-hooks.mjs');
    expect(packageJson.scripts.prepare).toBeUndefined();
    expect(packageJson.scripts['commit:range']).toBe('node scripts/validate-commit-range.mjs');
  });
});
