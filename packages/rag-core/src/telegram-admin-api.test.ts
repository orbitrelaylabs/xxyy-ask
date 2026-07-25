import { describe, expect, it, vi } from 'vitest';

import { fetchTelegramCurrentAdministratorIds } from './telegram-admin-api.js';

describe('fetchTelegramCurrentAdministratorIds', () => {
  it('loads human owners and administrators without exposing the token in results', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            { status: 'creator', user: { id: 123, is_bot: false } },
            { status: 'administrator', user: { id: '456', is_bot: false } },
            { status: 'administrator', user: { id: 999, is_bot: true } },
            { status: 'member', user: { id: 777, is_bot: false } },
          ],
        }),
        { status: 200 },
      ),
    );

    const ids = await fetchTelegramCurrentAdministratorIds({
      apiBaseUrl: ' ',
      botToken: 'secret-token',
      chatId: '-100123',
      fetchImpl,
    });

    expect([...ids]).toEqual(['123', '456']);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.telegram.org/botsecret-token/getChatAdministrators',
      expect.objectContaining({ body: '{"chat_id":"-100123"}', method: 'POST' }),
    );
  });

  it('returns an actionable error for Telegram API failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ description: 'chat not found', ok: false }), { status: 400 }),
      );

    await expect(
      fetchTelegramCurrentAdministratorIds({
        botToken: 'secret-token',
        chatId: '-100123',
        fetchImpl,
      }),
    ).rejects.toThrow('Telegram getChatAdministrators failed: chat not found.');
  });
});
