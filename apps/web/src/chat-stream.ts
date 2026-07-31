import type { ChatMetadata, ChatStreamEvent } from './types.js';

export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    buffer += decoder.decode(result.value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (event !== undefined) {
        onEvent(event);
      }
    }
  }

  buffer += decoder.decode();
  const finalEvent = parseSseBlock(buffer);
  if (finalEvent !== undefined) {
    onEvent(finalEvent);
  }
}

function parseSseBlock(block: string): ChatStreamEvent | undefined {
  const trimmed = block.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let eventName = 'message';
  const data: string[] = [];
  for (const line of trimmed.split(/\r?\n/u)) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trim());
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  const payload = JSON.parse(data.join('\n')) as unknown;
  if (eventName === 'answer_delta') {
    return { event: 'answer_delta', payload: payload as { delta?: string } };
  }
  if (eventName === 'status') {
    return { event: 'status', payload: payload as { message?: string; phase?: string } };
  }
  if (eventName === 'metadata') {
    return { event: 'metadata', payload: payload as ChatMetadata };
  }
  if (eventName === 'error') {
    return { event: 'error', payload: payload as { message?: string } };
  }

  return { event: 'unknown', eventName, payload };
}
