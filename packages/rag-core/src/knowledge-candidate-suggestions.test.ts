import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeCandidate } from './knowledge-candidates.js';
import {
  createOpenAiKnowledgeCandidateSuggestionProvider,
  KnowledgeCandidateSuggestionResponseError,
} from './knowledge-candidate-suggestions.js';

describe('knowledge candidate improvement suggestions', () => {
  it('creates a bounded, evidence-only suggestion for human review', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        max_completion_tokens: number;
        messages: Array<{ content: string; role: string }>;
      };
      expect(request.max_completion_tokens).toBe(1_024);
      expect(request.messages[0]?.content).toContain('Use only facts explicitly present');
      expect(request.messages[1]?.content).toContain('Bsc的可以用usdt交易吗');
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                canonicalAnswer: '根据群管理员回复，BSC 场景下不支持 USDT，需要使用 BNB。',
                missingInformation: ['需要确认 BNB 指交易币种、报价币种还是 Gas 代币。'],
                proposedModule: '交易设置',
                proposedTitle: 'BSC 场景下使用的代币',
                question: 'XXYY 在 BSC 场景下是否支持使用 USDT？',
                rationale: '在不增加事实的前提下消除口语表达。',
                riskFlags: ['ambiguous_scope'],
                status: 'needs_clarification',
              }),
            },
          },
        ],
      });
    });
    const provider = createOpenAiKnowledgeCandidateSuggestionProvider({
      apiKey: 'test-key',
      baseUrl: 'https://model.example/v1',
      fetchImpl,
      model: 'test-model',
    });

    const suggestion = await provider.suggest({ candidate: candidate(), conflicts: [] });

    expect(suggestion).toMatchObject({
      model: 'test-model',
      promptVersion: 'knowledge-candidate-improvement-v1',
      status: 'needs_clarification',
    });
  });

  it('rejects numbers introduced without source evidence', async () => {
    const provider = createOpenAiKnowledgeCandidateSuggestionProvider({
      apiKey: 'test-key',
      baseUrl: 'https://model.example/v1',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    canonicalAnswer: '需要使用 2 个 BNB。',
                    missingInformation: [],
                    proposedModule: '交易设置',
                    proposedTitle: 'BSC 交易',
                    question: 'XXYY 在 BSC 场景下如何交易？',
                    rationale: '优化表达。',
                    riskFlags: [],
                    status: 'suggestion',
                  }),
                },
              },
            ],
          }),
        ),
      model: 'test-model',
    });

    await expect(
      provider.suggest({ candidate: candidate(), conflicts: [] }),
    ).rejects.toBeInstanceOf(KnowledgeCandidateSuggestionResponseError);
  });
});

function candidate(): KnowledgeCandidate {
  return {
    canonicalAnswer: '不行，用bnb的',
    contentHash: 'hash',
    createdAt: '2026-08-02T01:00:00.000Z',
    id: 'candidate-1',
    proposedModule: '产品功能',
    proposedTitle: 'BSC 交易币种',
    question: '关于 XXYY，Bsc的可以用usdt交易吗',
    sourceAnswerText: '不行，用bnb的',
    sourceChannel: 'telegram',
    sourceQuestionText: 'Bsc的可以用usdt交易吗',
    status: 'pending',
    updatedAt: '2026-08-02T01:00:00.000Z',
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}
