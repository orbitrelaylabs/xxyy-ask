import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateCommitMessage } from './validate-commit-message.mjs';

describe('commit message validation', () => {
  it.each([
    'feat(knowledge): improve markdown chunk boundaries',
    'fix(api): route container model requests to the host',
    'docs: document the knowledge sync workflow',
    'feat(api)!: remove the legacy response contract\n\nBREAKING CHANGE: clients must use v2',
    "Merge branch 'main'",
    'Revert "feat(api): remove the legacy response contract"',
    'fixup! fix(api): route container model requests to the host',
  ])('accepts %s', (message) => {
    expect(validateCommitMessage(message)).toEqual([]);
  });

  it.each([
    ['plain title', 'Improve project configuration', '标题必须符合'],
    ['unsupported type', 'feature(api): add health checks', 'type 只能是'],
    ['unsupported style type', 'style(web): reformat styles', 'type 只能是'],
    ['invalid scope', 'fix(API): handle timeout', '标题必须符合'],
    ['capitalized subject', 'fix(api): Handle timeout', '小写开头'],
    ['trailing punctuation', 'fix(api): handle timeout.', '末尾不能使用'],
    ['vague subject', 'chore: update files', '模糊描述'],
    ['missing body separator', 'fix(api): handle timeout\nExplain why', '空行'],
    ['missing breaking footer', 'feat(api)!: remove legacy API', '必须添加 BREAKING CHANGE'],
    [
      'missing breaking marker',
      'feat(api): remove legacy API\n\nBREAKING CHANGE: clients must use v2',
      '标题必须使用 !',
    ],
    [
      'empty breaking footer',
      'feat(api)!: remove legacy API\n\nBREAKING CHANGE:',
      '必须说明具体影响',
    ],
    ['empty message', '# template comment only', '不能为空'],
  ])('rejects a %s', (_name, message, expectedError) => {
    expect(validateCommitMessage(message).join('\n')).toContain(expectedError);
  });

  it('rejects headers longer than 100 characters', () => {
    const message = `feat(api): ${'a'.repeat(91)}`;

    expect(validateCommitMessage(message).join('\n')).toContain('不能超过 100');
  });

  it('accepts the argument separator forwarded by pnpm run', () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./validate-commit-message.mjs', import.meta.url)),
        '--message',
        '--',
        'chore(infra): enforce conventional commit messages',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commit message is valid.');
  });
});
