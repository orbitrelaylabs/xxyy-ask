export type AdminPermission =
  | 'candidate:read'
  | 'candidate:review'
  | 'import:telegram'
  | 'publication:request'
  | 'quality:baseline'
  | 'quality:read'
  | 'quality:run'
  | 'observability:read'
  | 'support:manage'
  | 'support:read'
  | 'telegram_group:read'
  | 'telegram_user:manage'
  | 'trusted_author:manage'
  | 'user:manage';

export interface TelegramBotUser {
  createdAt: string;
  dailyLimit: number | null;
  status: 'active' | 'disabled';
  telegramUserId: string;
  todayUsed: number;
  updatedAt: string;
  displayName?: string;
  username?: string;
}

export type CandidateStatus = 'approved' | 'pending' | 'published' | 'rejected';
export type PublicationStatus = 'failed' | 'queued' | 'running' | 'succeeded';
export type QualityEvaluationMode = 'deterministic' | 'provider_retrieval' | 'provider';
export type QualityEvaluationJobStatus = 'failed' | 'queued' | 'running' | 'succeeded';

export interface QualityEvaluationJob {
  attemptCount: number;
  createdAt: string;
  id: string;
  mode: QualityEvaluationMode;
  requestedBy: string;
  status: QualityEvaluationJobStatus;
  updatedAt: string;
  withJudge: boolean;
  completedAt?: string;
  errorCode?: string;
  reportId?: string;
  startedAt?: string;
}

export interface QualityEvaluationFailure {
  actualIntent?: string;
  citationCount?: number;
  expectedIntent?: string;
  failures: string[];
  name: string;
  retrieval?: {
    forbiddenHitCount?: number;
    ndcgAtK?: number;
    precisionAtK?: number;
    recallAtK?: number;
    reciprocalRank?: number;
  };
}

export interface QualityEvaluationReport {
  createdAt: string;
  failures: QualityEvaluationFailure[];
  generatedAt: string;
  gatesPassed: boolean;
  gateReasons: string[];
  id: string;
  isBaseline: boolean;
  jobId: string;
  metrics: {
    averageCompleteness?: number;
    averageCorrectness?: number;
    averageGroundedness?: number;
    averageRelevance?: number;
    averageSafeRefusal?: number;
    casePassRate: number;
    forbiddenHitCount?: number;
    meanReciprocalRank?: number;
    ndcgAtK?: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    precisionAtK?: number;
    recallAtK?: number;
    totalTokens?: number;
  };
  mode: QualityEvaluationMode;
  passedCases: number;
  totalCases: number;
  withJudge: boolean;
  approvedAsBaselineAt?: string;
  approvedAsBaselineBy?: string;
}

export type KnowledgeGraphEntityType = 'chain' | 'feature' | 'launchpad' | 'plan' | 'product';
export type KnowledgeGraphRelationStatus = 'approved' | 'rejected';

export interface KnowledgeGraphEntity {
  aliases: string[];
  canonicalName: string;
  id: string;
  type: KnowledgeGraphEntityType;
}

export interface KnowledgeGraphRelation {
  confidence: number;
  evidence: string;
  id: string;
  object: { canonicalName: string; type: KnowledgeGraphEntityType };
  predicate: 'does_not_support_chain' | 'supported_launchpad_on_chain' | 'supports_chain';
  sourceChunkId: string;
  sourceDocumentId: string;
  sourceType: 'admin_verified' | 'official_docs' | 'x_updates';
  status: KnowledgeGraphRelationStatus;
  subject: { canonicalName: string; type: KnowledgeGraphEntityType };
  updatedAt: string;
  sourceUrl?: string;
}

export interface KnowledgeGraphConflict {
  negativeRelationIds: string[];
  object: KnowledgeGraphEntity;
  positiveRelationIds: string[];
  subject: KnowledgeGraphEntity;
}

export interface TelegramGroupRegistryEntry {
  chatId: string;
  chatType: 'group' | 'supergroup';
  firstSeenAt: string;
  lastSeenAt: string;
  membershipStatus: 'active' | 'kicked' | 'left' | 'unknown';
  observationSource: 'message' | 'my_chat_member';
  updatedAt: string;
  joinedAt?: string;
  lastMessageAt?: string;
  leftAt?: string;
  title?: string;
  unprocessedMessageCount?: number;
  curationJob?: {
    attemptCount: number;
    status: 'failed' | 'queued' | 'running' | 'succeeded';
    updatedAt: string;
    errorCode?: string;
  };
}

export interface TelegramGroupMessageRecord {
  authorIsBot: boolean;
  capturedAt: string;
  chatId: string;
  messageId: string;
  sentAt: string;
  text: string;
  authorUserId?: string;
  processedAt?: string;
  replyToMessageId?: string;
  senderChatId?: string;
}

export interface AdminPrincipal {
  displayName: string;
  id: string;
  role: 'admin' | 'publisher' | 'reviewer' | 'viewer';
}

export interface AdminSession {
  permissions: AdminPermission[];
  principal: AdminPrincipal;
}

export interface AdminUser {
  createdAt: string;
  displayName: string;
  id: string;
  role: 'admin' | 'publisher' | 'reviewer' | 'viewer';
  status: 'active' | 'disabled';
  updatedAt: string;
  lastLoginAt?: string;
}

export type SupportTicketStatus = 'closed' | 'in_progress' | 'open' | 'resolved' | 'waiting_user';
export type SupportTicketPriority = 'high' | 'low' | 'normal' | 'urgent';

export interface SupportTicket {
  conversationId: string;
  createdAt: string;
  id: string;
  priority: SupportTicketPriority;
  reason:
    | 'account_or_private_data'
    | 'explicit_human_request'
    | 'low_evidence'
    | 'negative_feedback'
    | 'other'
    | 'repeated_unresolved';
  status: SupportTicketStatus;
  subject: string;
  updatedAt: string;
  assignedTo?: string;
  resolution?: string;
  resolvedAt?: string;
}

export interface SupportOperationsMetrics {
  activeConversationCount: number;
  openTicketCount: number;
  unassignedTicketCount: number;
  waitingUserTicketCount: number;
}

export interface ApiObservabilityDimension {
  key: string;
  requestCount: number;
  rateLimitedCount: number;
  serverErrorCount: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface ApiObservabilitySummary {
  averageDurationMs: number;
  byApiKey: ApiObservabilityDimension[];
  byChannel: ApiObservabilityDimension[];
  byModel: ApiObservabilityDimension[];
  completionTokens: number;
  estimatedCostUsd: number;
  from: string;
  p95DurationMs: number;
  promptTokens: number;
  rateLimitedCount: number;
  requestCount: number;
  serverErrorCount: number;
  timeline: Array<{
    periodStart: string;
    requestCount: number;
    rateLimitedCount: number;
    serverErrorCount: number;
  }>;
  to: string;
  totalTokens: number;
}

export interface ApiObservabilityAlert {
  active: boolean;
  code: 'estimated_cost_usd' | 'rate_limited_ratio' | 'server_error_ratio';
  threshold: number;
  value: number;
}

export interface ApiCallObservation {
  clientHash: string;
  createdAt: string;
  durationMs: number;
  estimatedCostUsd: number;
  id: string;
  method: string;
  model?: string;
  path: string;
  rateLimited: boolean;
  statusCode: number;
  apiKeyId?: string;
  channel?: 'cli' | 'telegram' | 'web';
  errorCode?: string;
  requestId?: string;
  totalTokens?: number;
}

export interface SupportConversation {
  channel: 'cli' | 'telegram' | 'web';
  createdAt: string;
  externalSessionId: string;
  id: string;
  lastMessageAt: string;
  status: 'closed' | 'escalated' | 'open' | 'resolved';
  updatedAt: string;
  summary?: string;
  userIdHash?: string;
}

export interface SupportConversationMessage {
  content: string;
  conversationId: string;
  createdAt: string;
  id: string;
  role: 'assistant' | 'support_agent' | 'system' | 'user';
  citationCount?: number;
  intent?: string;
  requestId?: string;
}

export interface KnowledgeGapRecord {
  answer: string;
  channel: 'cli' | 'telegram' | 'web';
  citationCount: number;
  createdAt: string;
  failureReason?:
    | 'context_misunderstood'
    | 'incorrect'
    | 'incorrect_steps'
    | 'incomplete'
    | 'knowledge_conflict'
    | 'knowledge_missing'
    | 'off_topic'
    | 'other'
    | 'outdated'
    | 'too_verbose'
    | 'unsupported_citation';
  intent: string;
  question: string;
  rating: 'negative' | 'positive';
  diagnosis: {
    category: 'boundary' | 'classification' | 'generation' | 'knowledge' | 'retrieval';
    knowledgeCandidateEligible: false;
    reason: string;
    recommendedAction: string;
  };
  quality: {
    evidence: {
      answerStatus: 'complete' | 'conflict' | 'insufficient' | 'partial';
      citationCount: number;
      conflictCount: number;
      coverageState: 'none' | 'partial' | 'unknown';
      observedSourceTypes: Array<'admin_verified' | 'official_docs' | 'x_updates'>;
      sourceObservation: 'available' | 'unavailable';
      stopReason:
        | 'answer_completed'
        | 'evidence_conflict'
        | 'insufficient_evidence'
        | 'partial_answer';
    };
    queryPlan: {
      maxSearches: number;
      queries: Array<{
        preferredSourceTypes: Array<'admin_verified' | 'official_docs' | 'x_updates'>;
        query: string;
        facet?: string;
      }>;
      requiredFacets: string[];
      strategy: 'clarify' | 'multi_query' | 'single';
      subquestions?: Array<{
        facet: string;
        id: string;
        question: string;
        query: string;
        topK: number;
      }>;
      version: '1';
    };
    retrievalPolicy: {
      anchorDocumentIds: string[];
      diversity: 'balanced' | 'none';
      preferredSourceTypes: Array<'admin_verified' | 'official_docs' | 'x_updates'>;
      temporalScope: 'current' | 'explicit_range' | 'historical' | 'unspecified';
      version: '1';
    };
    understanding: {
      ambiguity: {
        requiresClarification: boolean;
        clarificationQuestion?: string;
        reason?: string;
      };
      confidence: number;
      kind: string;
      subject: 'customer_agent' | 'unknown' | 'xxyy_product';
      temporalScope: 'current' | 'explicit_range' | 'historical' | 'unspecified';
      version: '1';
    };
    version: '1';
  };
  comment?: string;
  sessionId?: string;
}

export interface QualityTrend {
  answerStatusCounts: Record<'complete' | 'conflict' | 'insufficient' | 'partial', number>;
  categoryCounts: Record<
    'boundary' | 'classification' | 'generation' | 'knowledge' | 'retrieval',
    number
  >;
  sampleSize: number;
  version: '1';
  newestAt?: string;
  oldestAt?: string;
}

export interface KnowledgeCandidate {
  canonicalAnswer: string;
  contentHash: string;
  createdAt: string;
  id: string;
  question: string;
  sourceChannel: 'telegram' | 'telegram_export' | 'web';
  status: CandidateStatus;
  updatedAt: string;
  authorVerification?: {
    role?: string;
    source: string;
    status: string;
    userId?: string;
    validFrom?: string;
    validTo?: string;
    verifiedAt?: string;
  };
  conflictChunkIds?: string[];
  contextMessageIds?: string[];
  currentRevision?: number;
  duplicateCandidateIds?: string[];
  effectiveAt?: string;
  evidence?: string;
  extractionMethod?: string;
  proposedModule?: string;
  proposedTitle?: string;
  publishedAt?: string;
  publishedDocumentId?: string;
  qualityScore?: number;
  riskFlags?: string[];
  reviewNote?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  sourceAnswerMessageId?: string;
  sourceAnswerText?: string;
  sourceChatId?: string;
  sourceQuestionMessageId?: string;
  sourceQuestionText?: string;
  sourceUrl?: string;
  supersedes?: string[];
}

export interface CandidateRevision {
  canonicalAnswer: string;
  candidateId: string;
  createdAt: string;
  editedBy: string;
  id: number;
  question: string;
  revision: number;
  evidence?: string;
  proposedModule?: string;
  proposedTitle?: string;
  reason?: string;
}

export interface CandidateReview {
  candidateId: string;
  createdAt: string;
  decision: 'approve' | 'reject';
  id: number;
  reviewedBy: string;
  revision: number;
  note?: string;
}

export interface GovernanceAuditEvent {
  actor: string;
  createdAt: string;
  details: Record<string, unknown>;
  entityId: string;
  entityType: 'candidate' | 'publication' | 'trusted_author';
  eventType: string;
  id: string;
}

export interface ConflictReference {
  content: string;
  documentId: string;
  headingPath: string[];
  id: string;
  module: string;
  sourceType: 'admin_verified' | 'official_docs' | 'x_updates';
  status: 'current' | 'deprecated' | 'historical';
  title: string;
  effectiveAt?: string;
  sourceUrl?: string;
}

export interface PublicationJob {
  attemptCount: number;
  candidateId: string;
  createdAt: string;
  id: string;
  requestedBy: string;
  status: PublicationStatus;
  updatedAt: string;
  completedAt?: string;
  documentId?: string;
  lastError?: string;
  leaseExpiresAt?: string;
  runId?: string;
  startedAt?: string;
  workerId?: string;
}

export interface CandidateDetail {
  candidate: KnowledgeCandidate;
  conflicts: ConflictReference[];
  duplicates: KnowledgeCandidate[];
  history: {
    auditEvents: GovernanceAuditEvent[];
    reviews: CandidateReview[];
    revisions: CandidateRevision[];
  };
  publications: PublicationJob[];
  graphPreview?: Array<{
    confidence: number;
    evidence: string;
    object: { canonicalName: string; type: KnowledgeGraphEntityType };
    predicate: 'does_not_support_chain' | 'supported_launchpad_on_chain' | 'supports_chain';
    subject: { canonicalName: string; type: KnowledgeGraphEntityType };
  }>;
}

export interface KnowledgeCandidateImprovementSuggestion {
  canonicalAnswer: string;
  missingInformation: string[];
  model: string;
  proposedModule: string;
  proposedTitle: string;
  promptVersion: string;
  question: string;
  rationale: string;
  riskFlags: string[];
  status: 'needs_clarification' | 'no_change' | 'suggestion';
}

export interface TrustedAuthor {
  chatId: string;
  createdAt: string;
  id: string;
  role: 'administrator' | 'knowledge_editor' | 'owner';
  updatedAt: string;
  userId: string;
  validFrom: string;
  verificationSource: 'import' | 'manual' | 'telegram_api';
  verifiedAt: string;
  verifiedBy: string;
  validTo?: string;
}

export type KnowledgeCurationMode = 'auto' | 'deterministic' | 'required';

export interface KnowledgeCuratorAgentRunStats {
  attemptedThreadCount: number;
  eligibleThreadCount: number;
  failedThreadCount: number;
  failureCounts: {
    invalid_output: number;
    provider_error: number;
    timeout: number;
    unknown: number;
  };
  modelAvailable: boolean;
  skippedBudgetThreadCount: number;
  skippedByModeThreadCount: number;
  skippedUnavailableThreadCount: number;
  succeededThreadCount: number;
}

export interface TelegramImportResult {
  adminReplyCount: number;
  agentCandidateCount: number;
  agentRunStats: KnowledgeCuratorAgentRunStats;
  candidateCount: number;
  created: KnowledgeCandidate[];
  curationMode: KnowledgeCurationMode;
  deterministicCandidateCount: number;
  duplicateCount: number;
  messageCount: number;
  rejectedAgentProposalCount: number;
  runId: string;
  skippedBoundaryCount: number;
  skippedMissingReplyCount: number;
  threadCount: number;
  unverifiedAuthorMessageCount: number;
  verifiedAuthorMessageCount: number;
  automation?: {
    approvedCount: number;
    policyVersion: string;
    publicationQueuedCount: number;
    rejectedCount: number;
  };
}
