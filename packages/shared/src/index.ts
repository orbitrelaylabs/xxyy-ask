import { z } from 'zod';

export {
  createSkillResultSchema,
  evidenceItemSchema,
  evidenceKinds,
  jsonValueSchema,
  skillDiagnosticSchema,
  skillFindingSchema,
  skillResultBaseShape,
  skillResultSchema,
  skillResultStatuses,
} from './domain-contract.js';
export type {
  EvidenceItem,
  EvidenceKind,
  JsonValue,
  SkillDiagnostic,
  SkillFinding,
  SkillResult,
  SkillResultStatus,
} from './domain-contract.js';

export const supportedChannels = ['cli', 'web', 'telegram'] as const;

export type ChatChannel = (typeof supportedChannels)[number];

export const knowledgeRefreshStates = [
  'disabled',
  'healthy',
  'pending',
  'stale',
  'failed',
  'unavailable',
] as const;

export type KnowledgeRefreshState = (typeof knowledgeRefreshStates)[number];

export interface KnowledgeRefreshStatus {
  enabled: boolean;
  state: KnowledgeRefreshState;
  schedule: {
    fullDailyAt: string;
    incrementalEveryMinutes: number;
    timeZone: string;
  };
  lastRun?: {
    finishedAt: string;
    mode: 'full' | 'incremental';
    status: 'failed' | 'succeeded';
  };
}

export const supportedIntents = [
  'agent_capabilities',
  'product_qa',
  'how_to',
  'realtime_account_query',
  'investment_advice',
  'unknown',
] as const;

export type Intent = (typeof supportedIntents)[number];

export const supportedAgentRoutes = [
  'agent_answer',
  'boundary',
  'clarify',
  'product_answer',
] as const;

export type AgentRoute = (typeof supportedAgentRoutes)[number];

const supportedStreamStatusPhases = ['planning', 'retrieving', 'answering'] as const;

type StreamStatusPhase = (typeof supportedStreamStatusPhases)[number];

export const supportedSourceTypes = ['admin_verified', 'official_docs', 'x_updates'] as const;

export type SourceType = (typeof supportedSourceTypes)[number];
export type KnowledgeStatus = 'current' | 'historical' | 'deprecated';

export const knowledgeSourceCatalog = {
  official_docs: {
    canonicalUrl: 'https://docs.xxyy.io/',
    label: 'XXYY 官方文档',
  },
  x_updates: {
    canonicalUrl: 'https://x.com/useXXYYio',
    label: 'XXYY 官方 X 更新',
  },
  admin_verified: {
    canonicalUrl: undefined,
    label: 'XXYY 客服群审核知识',
  },
} as const satisfies Record<SourceType, { canonicalUrl: string | undefined; label: string }>;

export interface ChatRequest {
  message: string;
  channel: ChatChannel;
  requestId?: string;
  sessionId?: string;
  userId?: string;
}

export interface Citation {
  title: string;
  file: string;
  excerpt: string;
  sourceType?: SourceType;
  sourceUrl?: string;
}

export type ChatAttachment =
  | {
      kind: 'video';
      title: string;
      url: string;
      mediaType: 'video/mp4' | 'text/html';
      posterUrl?: string;
    }
  | {
      kind: 'image';
      title: string;
      url: string;
      mediaType:
        | 'image/png'
        | 'image/jpeg'
        | 'image/webp'
        | 'image/svg+xml'
        | 'image/gif'
        | 'image/avif';
    };

export interface ChatResponse {
  answer: string;
  intent: Intent;
  citations: Citation[];
  confidence: number;
  agentRoute?: AgentRoute;
  attachments?: ChatAttachment[];
  tokenUsage?: ChatTokenUsage;
}

export interface ChatTokenUsage {
  completionTokens?: number;
  promptTokens?: number;
  totalTokens: number;
}

const citationSchema = z.object({
  excerpt: z.string(),
  file: z.string(),
  sourceType: z.enum(supportedSourceTypes).optional(),
  sourceUrl: z.string().optional(),
  title: z.string(),
});

const chatAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('video'),
    mediaType: z.enum(['video/mp4', 'text/html']),
    posterUrl: z.string().optional(),
    title: z.string(),
    url: z.string(),
  }),
  z.object({
    kind: z.literal('image'),
    mediaType: z.enum([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/svg+xml',
      'image/gif',
      'image/avif',
    ]),
    title: z.string(),
    url: z.string(),
  }),
]);

const chatTokenUsageSchema = z.object({
  completionTokens: z.number().int().nonnegative().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
});

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('answer_delta'),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('status'),
    phase: z.enum(supportedStreamStatusPhases),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('metadata'),
    agentRoute: z.enum(supportedAgentRoutes).optional(),
    attachments: z.array(chatAttachmentSchema).optional(),
    citations: z.array(citationSchema),
    confidence: z.number(),
    intent: z.enum(supportedIntents),
    tokenUsage: chatTokenUsageSchema.optional(),
  }),
]);

export type ChatStreamEvent =
  | {
      type: 'answer_delta';
      delta: string;
    }
  | {
      type: 'status';
      phase: StreamStatusPhase;
      message: string;
    }
  | {
      type: 'metadata';
      intent: Intent;
      citations: Citation[];
      confidence: number;
      agentRoute?: AgentRoute;
      attachments?: ChatAttachment[];
      tokenUsage?: ChatTokenUsage;
    };

export interface SourceDocument {
  id: string;
  title: string;
  module: string;
  sourceType: SourceType;
  file: string;
  content: string;
  attachments?: ChatAttachment[];
  effectiveAt?: string;
  sourceUrl?: string;
  order?: number;
  retrievedAt?: string;
  status?: KnowledgeStatus;
  supersedes?: string[];
}

export interface ChunkMetadata {
  title: string;
  module: string;
  sourceType: SourceType;
  file: string;
  headingPath: string[];
  attachments?: ChatAttachment[];
  sourceUrl?: string;
  order?: number;
  effectiveAt?: string;
  retrievedAt?: string;
  status?: KnowledgeStatus;
  supersedes?: string[];
}

export interface RagChunk {
  id: string;
  documentId: string;
  text: string;
  metadata: ChunkMetadata;
}

export interface IndexEntry extends RagChunk {
  tokens: string[];
  embedding: number[];
}

export interface RagIndex {
  version: 1;
  builtAt: string;
  entries: IndexEntry[];
}

export interface Classification {
  intent: Intent;
  confidence: number;
  reason: string;
}
