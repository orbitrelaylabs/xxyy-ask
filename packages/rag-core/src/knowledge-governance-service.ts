import type {
  KnowledgeCandidate,
  KnowledgeCandidateHistory,
  KnowledgeCandidateSourceChannel,
  KnowledgeCandidateStatus,
  PgKnowledgeCandidateStore,
  ReviseKnowledgeCandidateInput,
} from './knowledge-candidates.js';
import type {
  KnowledgeAutomationController,
  KnowledgeAutomationRunResult,
} from './knowledge-automation.js';
import type {
  KnowledgeConflictReference,
  KnowledgeGovernanceReferenceStore,
} from './knowledge-governance-references.js';
import {
  runKnowledgeCurator,
  type KnowledgeCurationMode,
  type KnowledgeCuratorModel,
  type KnowledgeMatchInspector,
  type KnowledgeCuratorRunResult,
} from './knowledge-curator.js';
import {
  extractTelegramKnowledgeCandidates,
  readTelegramKnowledgeExport,
} from './telegram-knowledge.js';
import type {
  ListTrustedAuthorsOptions,
  PgTrustedAuthorStore,
  TrustedAuthor,
  TrustAuthorInput,
} from './trusted-authors.js';

export interface KnowledgeGovernanceServiceOptions {
  automation?: KnowledgeAutomationController;
  candidateStore: PgKnowledgeCandidateStore;
  trustedAuthorStore: PgTrustedAuthorStore;
  curatorModel?: KnowledgeCuratorModel;
  inspector?: KnowledgeMatchInspector;
  maxAgentThreads?: number;
  referenceStore?: KnowledgeGovernanceReferenceStore;
}

export interface ImportTelegramKnowledgeInput {
  curationMode?: KnowledgeCurationMode;
  rawExport: unknown;
  currentAdministratorUserIds?: ReadonlySet<string>;
  currentAdministratorVerifiedAt?: string;
  explicitAdminUserIds?: ReadonlySet<string>;
  manualReviewRequired?: boolean;
  runAutomation?: boolean;
  runId?: string;
  sourceChannel?: Extract<KnowledgeCandidateSourceChannel, 'telegram' | 'telegram_export'>;
  /** @deprecated Use curationMode. true maps to required; false maps to deterministic. */
  useAgent?: boolean;
}

export interface ImportTelegramKnowledgeResult {
  agentCandidateCount: number;
  agentRunStats: KnowledgeCuratorRunResult['agentRunStats'];
  adminReplyCount: number;
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
  automation?: KnowledgeAutomationRunResult;
}

export interface KnowledgeGovernanceService {
  approve(input: {
    id: string;
    reviewedBy: string;
    effectiveAt?: string;
    note?: string;
    sourceUrl?: string;
    supersedes?: string[];
  }): Promise<KnowledgeCandidate>;
  getCandidate(id: string): Promise<KnowledgeCandidate | undefined>;
  getCandidateDetail(id: string): Promise<KnowledgeCandidateDetail | undefined>;
  getCandidateHistory(id: string): Promise<KnowledgeCandidateHistory>;
  importTelegram(input: ImportTelegramKnowledgeInput): Promise<ImportTelegramKnowledgeResult>;
  listCandidates(options?: {
    limit?: number;
    status?: KnowledgeCandidateStatus;
  }): Promise<KnowledgeCandidate[]>;
  listTrustedAuthors(options?: ListTrustedAuthorsOptions): Promise<TrustedAuthor[]>;
  migrate(): Promise<void>;
  reject(input: { id: string; reviewedBy: string; note?: string }): Promise<KnowledgeCandidate>;
  retractTelegramSource(input: {
    actor: string;
    messageId: string;
    sourceChatId: string;
    reason: 'source_deleted' | 'source_edited';
  }): Promise<{ publishedCandidateIds: string[]; retractedCandidateIds: string[] }>;
  revise(input: ReviseKnowledgeCandidateInput): Promise<KnowledgeCandidate>;
  trustAuthor(input: TrustAuthorInput): Promise<TrustedAuthor>;
}

export interface KnowledgeCandidateDetail {
  candidate: KnowledgeCandidate;
  conflicts: KnowledgeConflictReference[];
  duplicates: KnowledgeCandidate[];
  history: KnowledgeCandidateHistory;
}

export class UnverifiedTelegramKnowledgeAuthorError extends Error {
  constructor() {
    super(
      'No verified Telegram knowledge author matched this export. Add a time-bounded trusted author, configure Telegram current-administrator lookup, or pass an explicit administrator ID.',
    );
    this.name = 'UnverifiedTelegramKnowledgeAuthorError';
  }
}

export function createKnowledgeGovernanceService(
  options: KnowledgeGovernanceServiceOptions,
): KnowledgeGovernanceService {
  return {
    approve(input) {
      return options.candidateStore.review({
        decision: 'approve',
        id: input.id,
        reviewedBy: input.reviewedBy,
        ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      });
    },

    getCandidate(id) {
      return options.candidateStore.get(id);
    },

    async getCandidateDetail(id): Promise<KnowledgeCandidateDetail | undefined> {
      const candidate = await options.candidateStore.get(id);
      if (candidate === undefined) {
        return undefined;
      }
      const history = await options.candidateStore.getHistory(id);
      const duplicates: KnowledgeCandidate[] = [];
      for (const duplicateId of candidate.duplicateCandidateIds ?? []) {
        const duplicate = await options.candidateStore.get(duplicateId);
        if (duplicate !== undefined) {
          duplicates.push(duplicate);
        }
      }
      const conflicts =
        options.referenceStore === undefined
          ? []
          : await options.referenceStore.getByIds(candidate.conflictChunkIds ?? []);
      return { candidate, conflicts, duplicates, history };
    },

    getCandidateHistory(id) {
      return options.candidateStore.getHistory(id);
    },

    async importTelegram(input): Promise<ImportTelegramKnowledgeResult> {
      const curationMode = resolveCurationMode(input);
      if (curationMode === 'required' && options.curatorModel === undefined) {
        throw new Error('Knowledge Curator Agent is required but no curator model is configured.');
      }
      const normalizedExport = readTelegramKnowledgeExport(input.rawExport);
      const trustedAuthors =
        normalizedExport.chatId === undefined
          ? []
          : await options.trustedAuthorStore.list({
              chatId: normalizedExport.chatId,
              limit: 500,
            });
      const extraction = extractTelegramKnowledgeCandidates(input.rawExport, {
        trustedAuthors,
        ...(input.sourceChannel === 'telegram' || input.sourceChannel === 'telegram_export'
          ? { productContext: 'xxyy' as const }
          : {}),
        ...(input.currentAdministratorUserIds === undefined
          ? {}
          : { currentAdministratorUserIds: input.currentAdministratorUserIds }),
        ...(input.currentAdministratorVerifiedAt === undefined
          ? {}
          : { currentAdministratorVerifiedAt: input.currentAdministratorVerifiedAt }),
        ...(input.explicitAdminUserIds === undefined
          ? {}
          : { explicitAdminUserIds: input.explicitAdminUserIds }),
      });
      if (extraction.verifiedAuthorMessageCount === 0) {
        throw new UnverifiedTelegramKnowledgeAuthorError();
      }
      const curated = await runKnowledgeCurator({
        extraction,
        ...(options.inspector === undefined ? {} : { inspector: options.inspector }),
        ...(options.maxAgentThreads === undefined
          ? {}
          : { maxAgentThreads: options.maxAgentThreads }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(normalizedExport.chatId === undefined ? {} : { sourceChatId: normalizedExport.chatId }),
        mode: curationMode,
        ...(options.curatorModel === undefined ? {} : { model: options.curatorModel }),
      });
      const candidates =
        input.sourceChannel === undefined && input.manualReviewRequired !== true
          ? curated.candidates
          : curated.candidates.map((candidate) => ({
              ...candidate,
              ...(input.sourceChannel === undefined ? {} : { sourceChannel: input.sourceChannel }),
              ...(input.manualReviewRequired === true
                ? {
                    riskFlags: [
                      ...new Set([...(candidate.riskFlags ?? []), 'manual_review_required']),
                    ],
                  }
                : {}),
            }));
      const persisted = await options.candidateStore.createMany(candidates);
      const automation =
        options.automation === undefined || input.runAutomation === false
          ? undefined
          : await options.automation.process(persisted.created);
      return createImportResult(extraction, curated, persisted, automation);
    },

    listCandidates(input = {}) {
      return options.candidateStore.list(input);
    },

    listTrustedAuthors(input = {}) {
      return options.trustedAuthorStore.list(input);
    },

    async migrate(): Promise<void> {
      await options.candidateStore.migrate();
    },

    reject(input) {
      return options.candidateStore.review({
        decision: 'reject',
        id: input.id,
        reviewedBy: input.reviewedBy,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
    },

    retractTelegramSource(input) {
      if (options.candidateStore.retractTelegramSource === undefined) {
        throw new Error('Telegram source retraction is not supported by this candidate store.');
      }
      return options.candidateStore.retractTelegramSource(input);
    },

    revise(input) {
      return options.candidateStore.revise(input);
    },

    trustAuthor(input) {
      return options.trustedAuthorStore.trust(input);
    },
  };
}

function createImportResult(
  extraction: ReturnType<typeof extractTelegramKnowledgeCandidates>,
  curated: KnowledgeCuratorRunResult,
  persisted: Awaited<ReturnType<PgKnowledgeCandidateStore['createMany']>>,
  automation: KnowledgeAutomationRunResult | undefined,
): ImportTelegramKnowledgeResult {
  const created =
    automation === undefined
      ? persisted.created
      : automation.decisions.map((outcome) => outcome.candidate);
  return {
    adminReplyCount: extraction.adminReplyCount,
    agentCandidateCount: curated.agentCandidateCount,
    agentRunStats: curated.agentRunStats,
    candidateCount: curated.candidates.length,
    created,
    curationMode: curated.curationMode,
    deterministicCandidateCount: curated.deterministicCandidateCount,
    duplicateCount: persisted.duplicateCount,
    messageCount: extraction.messageCount,
    rejectedAgentProposalCount: curated.rejectedAgentProposalCount,
    runId: curated.runId,
    skippedBoundaryCount: extraction.skippedBoundaryCount,
    skippedMissingReplyCount: extraction.skippedMissingReplyCount,
    threadCount: extraction.threads.length,
    unverifiedAuthorMessageCount: extraction.unverifiedAuthorMessageCount,
    verifiedAuthorMessageCount: extraction.verifiedAuthorMessageCount,
    ...(automation === undefined ? {} : { automation }),
  };
}

function resolveCurationMode(input: ImportTelegramKnowledgeInput): KnowledgeCurationMode {
  if (input.curationMode !== undefined && input.useAgent !== undefined) {
    throw new Error('Specify curationMode or deprecated useAgent, not both.');
  }
  if (input.curationMode !== undefined) {
    return input.curationMode;
  }
  if (input.useAgent !== undefined) {
    return input.useAgent ? 'required' : 'deterministic';
  }
  return 'auto';
}
