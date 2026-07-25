import { describe, expect, it, vi } from 'vitest';

import { createTelegramApiClient } from './telegram-api.js';
import type { TelegramApiError } from './telegram-api.js';

function createJsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: init.status ?? 200,
  });
}

describe('createTelegramApiClient', () => {
  it('uses the official API base when the configured value is blank', async () => {
    const fetch = vi.fn(() => Promise.resolve(createJsonResponse({ ok: true, result: [] })));
    const api = createTelegramApiClient({
      apiBaseUrl: ' ',
      botToken: '123:abc',
      fetch,
    });

    await api.getUpdates({ limit: 25, timeout: 12 });

    expect(fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123:abc/getUpdates',
      expect.any(Object),
    );
  });

  it('does not propagate credential-bearing transport errors', async () => {
    const fetch = vi.fn(() =>
      Promise.reject(
        new TypeError('Failed to fetch https://api.telegram.org/bot123:abc/getUpdates'),
      ),
    );
    const api = createTelegramApiClient({
      botToken: '123:abc',
      fetch,
    });

    const request = api.getUpdates({ limit: 25, timeout: 12 });

    await expect(request).rejects.toThrow(
      'Telegram Bot API getUpdates failed: Transport request failed.',
    );
    await expect(request).rejects.not.toThrow('123:abc');
  });

  it('calls getUpdates with Telegram Bot API JSON payload', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        createJsonResponse({
          ok: true,
          result: [{ update_id: 1 }],
        }),
      ),
    );
    const api = createTelegramApiClient({
      apiBaseUrl: 'https://telegram.test',
      botToken: '123:abc',
      fetch,
    });

    const updates = await api.getUpdates({ limit: 25, offset: 42, timeout: 12 });

    expect(updates).toEqual([{ update_id: 1 }]);
    expect(fetch).toHaveBeenCalledWith('https://telegram.test/bot123:abc/getUpdates', {
      body: JSON.stringify({
        allowed_updates: ['message'],
        limit: 25,
        offset: 42,
        timeout: 12,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
  });

  it('sends messages, typing actions, photos, and videos through Bot API methods', async () => {
    const fetch = vi.fn(() => Promise.resolve(createJsonResponse({ ok: true, result: true })));
    const api = createTelegramApiClient({
      apiBaseUrl: 'https://telegram.test/',
      botToken: '123:abc',
      fetch,
    });

    await api.sendMessage({
      chatId: -100,
      parseMode: 'HTML',
      replyToMessageId: 11,
      text: '<b>hello</b>',
    });
    if (api.sendChatAction === undefined) {
      throw new Error('Expected sendChatAction to be implemented.');
    }
    await api.sendChatAction({ action: 'typing', chatId: -100 });
    if (api.sendMessageDraft === undefined) {
      throw new Error('Expected sendMessageDraft to be implemented.');
    }
    await api.sendMessageDraft({ chatId: -100, draftId: 7, text: 'partial answer' });
    await api.sendPhoto({
      caption: '截图',
      chatId: -100,
      photo: 'https://ask.example.com/a.png',
      replyToMessageId: 11,
    });
    if (api.sendVideo === undefined) {
      throw new Error('Expected sendVideo to be implemented.');
    }
    await api.sendVideo({
      caption: '演示视频',
      chatId: -100,
      replyToMessageId: 11,
      video: 'https://ask.example.com/demo.mp4',
    });

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://telegram.test/bot123:abc/sendMessage', {
      body: JSON.stringify({
        chat_id: -100,
        parse_mode: 'HTML',
        reply_parameters: { message_id: 11 },
        text: '<b>hello</b>',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://telegram.test/bot123:abc/sendChatAction', {
      body: JSON.stringify({ action: 'typing', chat_id: -100 }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://telegram.test/bot123:abc/sendMessageDraft', {
      body: JSON.stringify({ chat_id: -100, draft_id: 7, text: 'partial answer' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(fetch).toHaveBeenNthCalledWith(4, 'https://telegram.test/bot123:abc/sendPhoto', {
      body: JSON.stringify({
        caption: '截图',
        chat_id: -100,
        photo: 'https://ask.example.com/a.png',
        reply_parameters: { message_id: 11 },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(fetch).toHaveBeenNthCalledWith(5, 'https://telegram.test/bot123:abc/sendVideo', {
      body: JSON.stringify({
        caption: '演示视频',
        chat_id: -100,
        video: 'https://ask.example.com/demo.mp4',
        reply_parameters: { message_id: 11 },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
  });

  it('throws a TelegramApiError when Telegram returns ok false', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        createJsonResponse({
          description: 'Bad Request: chat not found',
          ok: false,
        }),
      ),
    );
    const api = createTelegramApiClient({
      apiBaseUrl: 'https://telegram.test',
      botToken: '123:abc',
      fetch,
    });

    await expect(api.sendMessage({ chatId: 1, text: 'hello' })).rejects.toMatchObject({
      description: 'Bad Request: chat not found',
      method: 'sendMessage',
      name: 'TelegramApiError',
    } satisfies Partial<TelegramApiError>);
  });
});
