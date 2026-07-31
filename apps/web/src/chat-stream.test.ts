import { afterEach, describe, expect, it, vi } from 'vitest';

import { readChatStream } from './chat-stream.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readChatStream', () => {
  it('does not gate buffered stream events on browser paint', async () => {
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('window', { requestAnimationFrame });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: status',
              'data: {"phase":"answering","message":"正在生成回答"}',
              '',
              'event: answer_delta',
              'data: {"delta":"第一段"}',
              '',
              'event: answer_delta',
              'data: {"delta":"第二段"}',
              '',
              '',
            ].join('\n'),
          ),
        );
        controller.close();
      },
    });
    const events: string[] = [];

    await readChatStream(body, (event) => {
      events.push(event.event);
    });

    expect(events).toEqual(['status', 'answer_delta', 'answer_delta']);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('does not wait for requestAnimationFrame when the page is hidden', async () => {
    const requestAnimationFrame = vi.fn();
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    vi.stubGlobal('window', { requestAnimationFrame });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              'event: status',
              'data: {"phase":"tool","message":"正在查询公开交易"}',
              '',
              'event: answer_delta',
              'data: {"delta":"查询完成"}',
              '',
              '',
            ].join('\n'),
          ),
        );
        controller.close();
      },
    });
    const events: string[] = [];

    await readChatStream(body, (event) => {
      events.push(event.event);
    });

    expect(events).toEqual(['status', 'answer_delta']);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
