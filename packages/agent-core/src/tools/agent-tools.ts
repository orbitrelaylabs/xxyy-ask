import { z } from 'zod';

import type { ChatResponse } from '@xxyy/shared';

import type { ToolDefinition } from '../tool-registry.js';

export const AGENT_TOOL_NAMES = ['describe_agent_capabilities'] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

const agentCapabilitiesInputSchema = z.object({}).strict();

const agentCapabilitiesOutputSchema = z.object({
  agentRoute: z.literal('agent_answer'),
  answer: z.string(),
  citations: z.array(z.never()),
  confidence: z.number(),
  intent: z.literal('agent_capabilities'),
});

const capabilityFacts = [
  '回答 XXYY 产品功能、Pro 权益和官方更新相关问题',
  '提供产品配置与操作步骤，例如交易设置、钱包监控和 Telegram 配置',
  '基于 XXYY 官方文档和官方 X 更新回答，并提供来源引用；客服群知识仅在人工审核发布后参与回答',
  '区分当前规则与历史更新，默认采用最新有效规则，也可以说明历史变更',
  '查询用户提供的公开 Explorer 交易链接，返回基础交易状态、区块、地址、金额、手续费和公开转账事实',
  '对用户提供的一笔公开 EVM 或 Solana 交易查询浏览器可见的状态、区块或 Slot、时间、地址、金额、手续费和 Token 转账',
  '对用户提供的一笔公开交易核对 XXYY 成交，分别给出结构性 Sandwich 四态和 canonical/小池判断，并在证据就绪时附真实 XXYY 标注截图',
  '知识不足时明确说明或请求补充信息，不编造实时数据',
] as const;

const boundaryFacts = [
  '查询账户、订单、余额、私有交易记录、任意地址历史或地址真实归属',
  '代用户执行账户或交易操作',
  '把浏览器单源证据描述成调用追踪、确定性 MEV、精确损失或攻击者收益证明',
  '提供投资建议、喊单或收益承诺',
] as const;

export function createAgentTools(): ToolDefinition<AgentToolName>[] {
  return [
    {
      name: 'describe_agent_capabilities',
      description:
        'Describe the current customer-support Agent itself: its responsibilities, available actions, knowledge sources, operating scope, and limitations. Use it for broad or hypothetical assessments of the assistant support role; no product module or concrete support case is required. Do not use it when the grammatical subject is the XXYY product or one of its modules.',
      inputSchema: agentCapabilitiesInputSchema,
      outputSchema: agentCapabilitiesOutputSchema,
      execute() {
        return createAgentCapabilitiesResponse();
      },
    },
  ];
}

function createAgentCapabilitiesResponse(): ChatResponse {
  return {
    agentRoute: 'agent_answer',
    answer: [
      '我是 XXYY 产品客服 Agent。目前我可以：',
      '',
      ...capabilityFacts.map((fact, index) => `${index + 1}. ${fact}。`),
      '',
      `我不能${boundaryFacts.join('、')}。`,
    ].join('\n'),
    citations: [],
    confidence: 0.98,
    intent: 'agent_capabilities',
  };
}
