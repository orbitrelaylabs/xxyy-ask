import type { ChatChannel, ChatRequest, ChatResponse, ChatStreamEvent, Intent } from '@xxyy/shared';

export interface XxyyAgentClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface XxyyAgentRequest {
  message: string;
  channel?: ChatChannel;
  requestId?: string;
  sessionId?: string;
  userId?: string;
}

export interface XxyyFeedbackRequest {
  answer: string;
  citationCount: number;
  intent: Intent;
  question: string;
  rating: 'negative' | 'positive';
  channel?: ChatChannel;
  comment?: string;
  sessionId?: string;
}

export interface XxyyEscalationRequest {
  sessionId: string;
  subject: string;
  channel?: ChatChannel;
  priority?: 'high' | 'low' | 'normal' | 'urgent';
  reason?:
    | 'account_or_private_data'
    | 'explicit_human_request'
    | 'low_evidence'
    | 'negative_feedback'
    | 'other'
    | 'repeated_unresolved';
  userId?: string;
}

export interface XxyySupportTicket {
  conversationId: string;
  createdAt: string;
  id: string;
  priority: 'high' | 'low' | 'normal' | 'urgent';
  reason: NonNullable<XxyyEscalationRequest['reason']>;
  status: 'closed' | 'in_progress' | 'open' | 'resolved' | 'waiting_user';
  subject: string;
  updatedAt: string;
  assignedTo?: string;
  resolution?: string;
  resolvedAt?: string;
}

export class XxyyAgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'XxyyAgentApiError';
  }
}

export interface XxyyAgentClient {
  ask(request: XxyyAgentRequest): Promise<ChatResponse>;
  escalate(request: XxyyEscalationRequest): Promise<XxyySupportTicket>;
  recordFeedback(request: XxyyFeedbackRequest): Promise<void>;
  stream(request: XxyyAgentRequest): AsyncIterable<ChatStreamEvent>;
}

export function createXxyyAgentClient(options: XxyyAgentClientOptions): XxyyAgentClient {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (options.apiKey.trim().length < 24) {
    throw new Error('apiKey must contain at least 24 characters.');
  }

  const request = async (path: string, body: unknown): Promise<Response> => {
    const response = await fetchImpl(`${baseUrl}/api/v1${path}`, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        message?: unknown;
      };
      throw new XxyyAgentApiError(
        typeof payload.message === 'string'
          ? payload.message
          : `Agent API returned ${response.status}.`,
        response.status,
        typeof payload.error === 'string' ? payload.error : undefined,
      );
    }
    return response;
  };

  return {
    async ask(input) {
      const response = await request('/chat', normalizeChatRequest(input));
      return (await response.json()) as ChatResponse;
    },
    async escalate(input) {
      const response = await request('/support/escalate', {
        ...input,
        channel: input.channel ?? 'web',
        priority: input.priority ?? 'normal',
        reason: input.reason ?? 'explicit_human_request',
      });
      const payload = (await response.json()) as { ticket: XxyySupportTicket };
      return payload.ticket;
    },
    async recordFeedback(input) {
      await request('/feedback', { ...input, channel: input.channel ?? 'web' });
    },
    async *stream(input) {
      const response = await request('/chat/stream', normalizeChatRequest(input));
      if (response.body === null) {
        throw new XxyyAgentApiError('Streaming response body is unavailable.', 502);
      }
      yield* parseServerSentEvents(response.body);
    },
  };
}

function normalizeChatRequest(input: XxyyAgentRequest): ChatRequest {
  return { ...input, channel: input.channel ?? 'web' };
}

async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ChatStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data.length > 0) yield JSON.parse(data) as ChatStreamEvent;
      }
      if (result.done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
