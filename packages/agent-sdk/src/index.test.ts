import { describe, expect, it } from 'vitest';

import { createXxyyAgentClient, XxyyAgentApiError } from './index.js';

describe('createXxyyAgentClient', () => {
  it('calls the authenticated versioned chat API with stable defaults', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const client = createXxyyAgentClient({
      apiKey: 'test-api-key-with-at-least-24-characters',
      baseUrl: 'https://support.example/',
      fetchImpl: (input, init) => {
        calls.push({ input: String(input), ...(init === undefined ? {} : { init }) });
        return Promise.resolve(
          Response.json({ answer: 'ok', citations: [], confidence: 1, intent: 'product_qa' }),
        );
      },
    });

    await expect(client.ask({ message: 'XXYY Pro 权益？' })).resolves.toMatchObject({
      answer: 'ok',
    });
    expect(calls[0]?.input).toBe('https://support.example/api/v1/chat');
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer test-api-key-with-at-least-24-characters',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      channel: 'web',
      message: 'XXYY Pro 权益？',
    });
  });

  it('surfaces structured API failures', async () => {
    const client = createXxyyAgentClient({
      apiKey: 'test-api-key-with-at-least-24-characters',
      baseUrl: 'https://support.example',
      fetchImpl: () =>
        Promise.resolve(
          Response.json({ error: 'unauthorized', message: 'Invalid token.' }, { status: 401 }),
        ),
    });
    const error = await client.ask({ message: 'test' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(XxyyAgentApiError);
    expect(error).toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('parses streamed Agent events across response chunks', async () => {
    const encoder = new TextEncoder();
    const client = createXxyyAgentClient({
      apiKey: 'test-api-key-with-at-least-24-characters',
      baseUrl: 'https://support.example',
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('event: status\ndata: {"type":"status",'));
                controller.enqueue(
                  encoder.encode(
                    '"phase":"planning","message":"规划中"}\n\nevent: answer_delta\ndata: {"type":"answer_delta","delta":"答案"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          ),
        ),
    });
    const events = [];
    for await (const event of client.stream({ message: 'test' })) events.push(event);
    expect(events).toEqual([
      { message: '规划中', phase: 'planning', type: 'status' },
      { delta: '答案', type: 'answer_delta' },
    ]);
  });
});
