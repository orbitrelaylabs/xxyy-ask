import { describe, expect, it } from 'vitest';

import {
  AGENT_MAX_STEPS_DEFAULT,
  createInitialAgentState,
  isAllowedAgentToolName,
  isExecutableAgentToolName,
  normalizeAgentRoute,
} from './langgraph-state.js';

describe('langgraph agent state helpers', () => {
  it('creates initial state from a chat request', () => {
    const state = createInitialAgentState({
      channel: 'web',
      message: 'XXYY Pro 有哪些权益？',
      sessionId: 's1',
    });

    expect(state).toMatchObject({
      currentStep: 0,
      errors: [],
      evidence: [],
      maxSteps: AGENT_MAX_STEPS_DEFAULT,
      messages: [{ role: 'user', content: 'XXYY Pro 有哪些权益？' }],
      request: {
        channel: 'web',
        message: 'XXYY Pro 有哪些权益？',
        sessionId: 's1',
      },
      toolCalls: [],
      toolResults: [],
    });
  });

  it('allows only reviewed customer support tools', () => {
    expect(isAllowedAgentToolName('describe_agent_capabilities')).toBe(true);
    expect(isAllowedAgentToolName('get_public_transaction')).toBe(true);
    expect(isAllowedAgentToolName('answer_product_question')).toBe(false);
    expect(isAllowedAgentToolName('search_product_docs')).toBe(true);
    expect(isExecutableAgentToolName('answer_product_question')).toBe(true);
    expect(isAllowedAgentToolName('unsupported_tool')).toBe(false);
    expect(isAllowedAgentToolName('boundary_reply')).toBe(false);
    expect(isAllowedAgentToolName('clarify_request')).toBe(false);
    expect(isAllowedAgentToolName('list_analysis_reports')).toBe(false);
    expect(isAllowedAgentToolName('sync_telegram_support')).toBe(false);
  });

  it('normalizes planner routes into shared agent routes', () => {
    expect(normalizeAgentRoute('agent_answer')).toBe('agent_answer');
    expect(normalizeAgentRoute('chain_answer')).toBe('chain_answer');
    expect(normalizeAgentRoute('product_answer')).toBe('product_answer');
    expect(normalizeAgentRoute('boundary')).toBe('boundary');
    expect(normalizeAgentRoute('clarify')).toBe('clarify');
    expect(normalizeAgentRoute('unsupported')).toBe('clarify');
  });
});
