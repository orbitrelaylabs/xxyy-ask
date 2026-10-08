import { describe, expect, it } from 'vitest';

import { getOpenRouterFreeModelOptions } from './openrouter-request-options.js';

describe('OpenRouter free model request options', () => {
  it.each(['nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/free'])(
    'reserves the output budget for %s responses',
    (model) => {
      expect(getOpenRouterFreeModelOptions('https://openrouter.ai/api/v1/', model)).toEqual({
        reasoning: { enabled: false },
      });
    },
  );

  it.each([
    ['https://api.openai.com/v1', 'test:free'],
    ['https://openrouter.ai.example/v1', 'test:free'],
    ['http://openrouter.ai/api/v1', 'test:free'],
    ['https://openrouter.ai/api/v1', 'nvidia/nemotron-3-super-120b-a12b'],
    ['invalid-url', 'test:free'],
  ])('preserves other provider/model settings: %s %s', (baseUrl, model) => {
    expect(getOpenRouterFreeModelOptions(baseUrl, model)).toEqual({});
  });
});
