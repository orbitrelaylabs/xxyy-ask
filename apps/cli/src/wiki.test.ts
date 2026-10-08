import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './index.js';

describe('wiki CLI arguments', () => {
  it('accepts a read-only plan and exact build IDs', () => {
    expect(parseCliArgs(['wiki:build', '--', '--dry-run'])).toEqual({
      command: 'wiki:build',
      dryRun: true,
    });
    expect(parseCliArgs(['wiki:build'])).toEqual({ command: 'wiki:build', dryRun: false });
    const buildId = 'b5807d15-1d3d-42c0-9f92-6174fce84d0a';
    expect(parseCliArgs(['wiki:publish', '--', buildId])).toEqual({
      command: 'wiki:publish',
      buildId,
    });
    expect(parseCliArgs(['wiki:evaluate', buildId])).toEqual({ command: 'wiki:evaluate', buildId });
  });
  it.each([
    ['wiki:build', '--force'],
    ['wiki:publish', '../other'],
    ['wiki:evaluate'],
    ['wiki:unknown'],
  ])('rejects unsupported arguments %j', (...args) => {
    expect(parseCliArgs(args).command).toBe('help');
  });
});
