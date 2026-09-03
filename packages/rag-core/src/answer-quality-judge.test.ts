import { describe, expect, it, vi } from 'vitest';

import {
  AnswerJudgeConfigurationError,
  createOpenAiAnswerQualityJudge,
} from './answer-quality-judge.js';

const judgeInput = {
  actualIntent: 'product_qa' as const,
  answer: 'api key: sk-answer-secret；钱包监控支持5000个地址。',
  boundaryExpected: false,
  citations: [
    {
      excerpt: '当前钱包监控支持5000个地址。',
      file: '/docs/wallet-monitor.md',
      title: '钱包监控',
    },
  ],
  expectedIntent: 'product_qa' as const,
  question: 'api key: sk-question-secret；现在支持多少地址？',
  referenceFacts: ['5000个地址'],
};

describe('createOpenAiAnswerQualityJudge', () => {
  it('requires an explicit judge model', () => {
    expect(() =>
      createOpenAiAnswerQualityJudge({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1',
        model: undefined,
      }),
    ).toThrow(AnswerJudgeConfigurationError);
  });

  it('sends a deterministic redacted request and parses strict scores', async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers; url: string }> = [];
    const fetchImpl: typeof fetch = (input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected a string request body.');
      }
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push({
        body: JSON.parse(init.body) as Record<string, unknown>,
        headers: new Headers(init?.headers),
        url,
      });
      return Promise.resolve(
        jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  correctness: 0.9,
                  groundedness: 1,
                  completeness: 0.8,
                  relevance: 0.95,
                  safeRefusal: 1,
                  reason: 'The required fact is present and cited.',
                }),
              },
            },
          ],
        }),
      );
    };
    const judge = createOpenAiAnswerQualityJudge({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1/',
      fetchImpl,
      model: 'judge-test',
    });

    await expect(judge.judge(judgeInput)).resolves.toEqual({
      completeness: 0.8,
      correctness: 0.9,
      groundedness: 1,
      reason: 'The required fact is present and cited.',
      relevance: 0.95,
      safeRefusal: 1,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://llm.example/v1/chat/completions');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer test-key');
    expect(requests[0]?.body).toMatchObject({
      max_completion_tokens: 512,
      model: 'judge-test',
      response_format: { type: 'json_object' },
      temperature: 0,
    });
    const serializedBody = JSON.stringify(requests[0]?.body);
    expect(serializedBody).toContain('[sensitive_credential]');
    expect(serializedBody).toContain('5000个地址');
    expect(serializedBody).not.toContain('sk-question-secret');
    expect(serializedBody).not.toContain('sk-answer-secret');
    expect(serializedBody).not.toContain('test-key');
  });

  it.each([
    ['invalid JSON', 'not json'],
    [
      'missing field',
      JSON.stringify({
        completeness: 1,
        correctness: 1,
        groundedness: 1,
        relevance: 1,
        reason: 'ok',
      }),
    ],
    [
      'out-of-range score',
      JSON.stringify({
        completeness: 1,
        correctness: 2,
        groundedness: 1,
        relevance: 1,
        safeRefusal: 1,
        reason: 'ok',
      }),
    ],
  ])('rejects %s judge output', async (_name, content) => {
    const judge = createOpenAiAnswerQualityJudge({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl: () => Promise.resolve(jsonResponse({ choices: [{ message: { content } }] })),
      model: 'judge-test',
    });

    await expect(judge.judge(judgeInput)).rejects.toThrow('Invalid answer judge response');
  });

  it('rejects non-success responses', async () => {
    const judge = createOpenAiAnswerQualityJudge({
      apiKey: 'test-key',
      baseUrl: 'https://llm.example/v1',
      fetchImpl: () => Promise.resolve(new Response('', { status: 503 })),
      model: 'judge-test',
    });

    await expect(judge.judge(judgeInput)).rejects.toThrow('status 503');
  });

  it('aborts requests after the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      const judge = createOpenAiAnswerQualityJudge({
        apiKey: 'test-key',
        baseUrl: 'https://llm.example/v1',
        fetchImpl,
        model: 'judge-test',
        requestTimeoutMs: 10,
      });
      const pending = judge.judge(judgeInput);
      const rejection = expect(pending).rejects.toThrow('timed out after 10ms');

      await vi.advanceTimersByTimeAsync(10);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}
