import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '../tool-registry.js';
import { AGENT_TOOL_NAMES, createAgentTools } from './agent-tools.js';

describe('createAgentTools', () => {
  it('exposes one semantic Agent capability tool without question patterns', async () => {
    expect(AGENT_TOOL_NAMES).toEqual(['describe_agent_capabilities']);

    const registry = createToolRegistry();
    for (const tool of createAgentTools()) {
      registry.register(tool);
    }

    const output = (await registry.execute('describe_agent_capabilities', {})) as {
      answer: string;
    };
    expect(output).toMatchObject({
      agentRoute: 'agent_answer',
      citations: [],
      confidence: 0.98,
      intent: 'agent_capabilities',
    });
    expect(output.answer).toContain('EVM 或 Solana');
    expect(output.answer).toContain('真实 XXYY 标注截图');
    expect(output.answer).not.toContain('readiness');
    expect(output.answer).not.toContain('archive 证据');
  });
});
