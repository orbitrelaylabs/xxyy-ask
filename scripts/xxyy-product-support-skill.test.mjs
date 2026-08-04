import { describe, expect, it, vi } from 'vitest';

import { runProductSupportSkill } from '../skills/xxyy-product-support/scripts/ask.mjs';

describe('XXYY product support Skill script', () => {
  it('calls the versioned Agent API and returns its JSON response', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ answer: 'Supported answer', citations: [], confidence: 0.8 }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      runProductSupportSkill({
        argv: ['--question', 'XXYY Pro 有哪些权益？'],
        env: {
          XXYY_SUPPORT_API_BASE_URL: 'https://support.example/',
          XXYY_SUPPORT_API_KEY: 'secret',
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ answer: 'Supported answer' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://support.example/api/v1/chat',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('requires an API key and does not accept it as a command argument', async () => {
    await expect(runProductSupportSkill({ argv: ['--question', 'test'], env: {} })).rejects.toThrow(
      'XXYY_SUPPORT_API_KEY is required',
    );
    await expect(
      runProductSupportSkill({
        argv: ['--question', 'test', '--api-key', 'unsafe'],
        env: { XXYY_SUPPORT_API_KEY: 'secret' },
      }),
    ).rejects.toThrow('Unknown argument: --api-key');
  });
});
