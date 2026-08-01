import {
  KNOWLEDGE_INJECTION_QUARANTINE_MARKER,
  hasUsableKnowledgeText,
  sanitizeUntrustedKnowledgeText,
} from './knowledge-content-safety.js';
import {
  InvalidKnowledgeCandidateStateError,
  type KnowledgeCandidate,
  type PgKnowledgeCandidateStore,
} from './knowledge-candidates.js';
import type {
  KnowledgePublicationJob,
  PgKnowledgePublicationJobStore,
} from './knowledge-publication-jobs.js';

export const KNOWLEDGE_AUTOMATION_POLICY_VERSION = 'knowledge-automation-v1';
export const KNOWLEDGE_AUTOMATION_REVIEWER = `system:${KNOWLEDGE_AUTOMATION_POLICY_VERSION}`;

export const knowledgeAutomationReasonCodes = [
  'approved_strict_policy',
  'blocking_risk_flag',
  'conflicting_knowledge',
  'duplicate_knowledge',
  'invalid_agent_lineage',
  'invalid_author_validity',
  'low_quality',
  'missing_effective_at',
  'unsafe_content',
  'unsupported_extraction',
  'unsupported_source',
  'unverified_author',
] as const;

export type KnowledgeAutomationReasonCode = (typeof knowledgeAutomationReasonCodes)[number];

export interface KnowledgeAutomationDecision {
  decision: 'approve' | 'reject';
  policyVersion: typeof KNOWLEDGE_AUTOMATION_POLICY_VERSION;
  reasonCodes: KnowledgeAutomationReasonCode[];
}

export interface KnowledgeAutomationOutcome {
  candidate: KnowledgeCandidate;
  decision: KnowledgeAutomationDecision;
  publication?: KnowledgePublicationJob;
}

export interface KnowledgeAutomationRunResult {
  approvedCount: number;
  decisions: KnowledgeAutomationOutcome[];
  policyVersion: typeof KNOWLEDGE_AUTOMATION_POLICY_VERSION;
  publicationQueuedCount: number;
  rejectedCount: number;
}

export interface KnowledgeAutomationController {
  process(candidates: readonly KnowledgeCandidate[]): Promise<KnowledgeAutomationRunResult>;
  reconcile(options?: { limit?: number }): Promise<KnowledgeAutomationRunResult>;
}

const MINIMUM_AUTOMATIC_QUALITY = 0.8;
const MAX_CONTEMPORARY_ADMIN_VERIFICATION_AGE_MS = 10 * 60 * 1_000;
const MAX_AUTOMATIC_PUBLICATION_ATTEMPTS = 3;
const AUTOMATION_ALLOWED_RISK_FLAGS = new Set(['agent_generated', 'missing_official_source']);
const TRUSTED_AUTHOR_ROLES = new Set(['administrator', 'knowledge_editor', 'owner']);

export function evaluateKnowledgeCandidateAutomation(
  candidate: KnowledgeCandidate,
): KnowledgeAutomationDecision {
  const reasonCodes = new Set<KnowledgeAutomationReasonCode>();

  if (candidate.sourceChannel !== 'telegram' && candidate.sourceChannel !== 'telegram_export') {
    reasonCodes.add('unsupported_source');
  }
  if (
    candidate.extractionMethod !== 'deterministic_adjacent_admin_message' &&
    candidate.extractionMethod !== 'deterministic_direct_reply' &&
    candidate.extractionMethod !== 'agent_assisted'
  ) {
    reasonCodes.add('unsupported_extraction');
  }
  if (candidate.effectiveAt === undefined || !isTimestamp(candidate.effectiveAt)) {
    reasonCodes.add('missing_effective_at');
  }
  if (!isAutomationAuthorVerified(candidate)) {
    reasonCodes.add('unverified_author');
  }
  if (!isAuthorValidityClosed(candidate)) {
    reasonCodes.add('invalid_author_validity');
  }
  if (
    candidate.qualityScore === undefined ||
    !Number.isFinite(candidate.qualityScore) ||
    candidate.qualityScore < MINIMUM_AUTOMATIC_QUALITY
  ) {
    reasonCodes.add('low_quality');
  }
  if ((candidate.duplicateCandidateIds?.length ?? 0) > 0) {
    reasonCodes.add('duplicate_knowledge');
  }
  if ((candidate.conflictChunkIds?.length ?? 0) > 0) {
    reasonCodes.add('conflicting_knowledge');
  }
  if ((candidate.riskFlags ?? []).some((flag) => !AUTOMATION_ALLOWED_RISK_FLAGS.has(flag))) {
    reasonCodes.add('blocking_risk_flag');
  }
  if (
    candidate.extractionMethod === 'agent_assisted' &&
    (candidate.curatorModel === undefined ||
      candidate.curatorPromptVersion === undefined ||
      candidate.curatorRunId === undefined)
  ) {
    reasonCodes.add('invalid_agent_lineage');
  }
  const publishedTexts = [
    candidate.question,
    candidate.canonicalAnswer,
    ...(candidate.proposedTitle === undefined ? [] : [candidate.proposedTitle]),
    ...(candidate.proposedModule === undefined ? [] : [candidate.proposedModule]),
  ];
  if (
    publishedTexts.some(
      (text) =>
        sanitizeUntrustedKnowledgeText(text).detected ||
        text.includes(KNOWLEDGE_INJECTION_QUARANTINE_MARKER),
    ) ||
    !hasUsableKnowledgeText(candidate.question) ||
    !hasUsableKnowledgeText(candidate.canonicalAnswer)
  ) {
    reasonCodes.add('unsafe_content');
  }

  return reasonCodes.size === 0
    ? {
        decision: 'approve',
        policyVersion: KNOWLEDGE_AUTOMATION_POLICY_VERSION,
        reasonCodes: ['approved_strict_policy'],
      }
    : {
        decision: 'reject',
        policyVersion: KNOWLEDGE_AUTOMATION_POLICY_VERSION,
        reasonCodes: [...reasonCodes].sort(),
      };
}

export function createKnowledgeAutomationController(options: {
  candidateStore: Pick<PgKnowledgeCandidateStore, 'get' | 'list' | 'review'>;
  publicationJobStore: Pick<PgKnowledgePublicationJobStore, 'request' | 'retry'>;
}): KnowledgeAutomationController {
  async function ensurePublication(
    candidate: KnowledgeCandidate,
  ): Promise<KnowledgePublicationJob> {
    const publication = await options.publicationJobStore.request({
      candidateId: candidate.id,
      requestedBy: KNOWLEDGE_AUTOMATION_REVIEWER,
    });
    if (
      publication.status === 'failed' &&
      publication.attemptCount < MAX_AUTOMATIC_PUBLICATION_ATTEMPTS
    ) {
      return options.publicationJobStore.retry({
        id: publication.id,
        requestedBy: KNOWLEDGE_AUTOMATION_REVIEWER,
      });
    }
    return publication;
  }

  async function process(
    candidates: readonly KnowledgeCandidate[],
  ): Promise<KnowledgeAutomationRunResult> {
    const decisions: KnowledgeAutomationOutcome[] = [];
    for (const candidate of candidates) {
      if (
        candidate.status !== 'pending' ||
        candidate.riskFlags?.includes('manual_review_required') === true
      ) {
        continue;
      }
      const decision = evaluateKnowledgeCandidateAutomation(candidate);
      let reviewed: KnowledgeCandidate;
      try {
        reviewed = await options.candidateStore.review({
          decision: decision.decision,
          id: candidate.id,
          reviewedBy: KNOWLEDGE_AUTOMATION_REVIEWER,
          note: automationReviewNote(decision),
          ...(decision.decision === 'approve' && candidate.effectiveAt !== undefined
            ? { effectiveAt: candidate.effectiveAt }
            : {}),
          ...(decision.decision === 'approve' && candidate.sourceUrl !== undefined
            ? { sourceUrl: candidate.sourceUrl }
            : {}),
          ...(decision.decision === 'approve' && candidate.supersedes !== undefined
            ? { supersedes: candidate.supersedes }
            : {}),
        });
      } catch (error) {
        if (!(error instanceof InvalidKnowledgeCandidateStateError)) {
          throw error;
        }
        const current = await options.candidateStore.get(candidate.id);
        if (current?.status !== 'approved') {
          if (current?.status === 'published' || current?.status === 'rejected') {
            continue;
          }
          throw error;
        }
        if (
          current.reviewedBy !== KNOWLEDGE_AUTOMATION_REVIEWER ||
          decision.decision !== 'approve'
        ) {
          continue;
        }
        decisions.push({
          candidate: current,
          decision,
          publication: await ensurePublication(current),
        });
        continue;
      }
      if (decision.decision === 'approve') {
        decisions.push({
          candidate: reviewed,
          decision,
          publication: await ensurePublication(reviewed),
        });
      } else {
        decisions.push({ candidate: reviewed, decision });
      }
    }
    return summarizeAutomation(decisions);
  }

  return {
    process,

    async reconcile(input = {}): Promise<KnowledgeAutomationRunResult> {
      const limit = normalizeAutomationLimit(input.limit);
      const pending = await options.candidateStore.list({ limit, status: 'pending' });
      const processed = await process(pending);
      const approved = await options.candidateStore.list({ limit, status: 'approved' });
      const alreadyQueued = new Set(
        processed.decisions
          .map((outcome) => outcome.publication?.candidateId)
          .filter((value): value is string => value !== undefined),
      );
      const repaired: KnowledgeAutomationOutcome[] = [];
      for (const candidate of approved) {
        const decision = evaluateKnowledgeCandidateAutomation(candidate);
        if (
          alreadyQueued.has(candidate.id) ||
          candidate.reviewedBy !== KNOWLEDGE_AUTOMATION_REVIEWER ||
          decision.decision !== 'approve'
        ) {
          continue;
        }
        repaired.push({
          candidate,
          decision,
          publication: await ensurePublication(candidate),
        });
      }
      return summarizeAutomation([...processed.decisions, ...repaired]);
    },
  };
}

function isAutomationAuthorVerified(candidate: KnowledgeCandidate): boolean {
  const author = candidate.authorVerification;
  if (author === undefined) {
    return false;
  }
  if (
    author.status === 'trusted_author' &&
    author.role !== undefined &&
    TRUSTED_AUTHOR_ROLES.has(author.role)
  ) {
    return true;
  }
  if (
    author.status !== 'telegram_api_current' ||
    author.verifiedAt === undefined ||
    candidate.effectiveAt === undefined
  ) {
    return false;
  }
  const verificationAge = Math.abs(
    Date.parse(author.verifiedAt) - Date.parse(candidate.effectiveAt),
  );
  return (
    Number.isFinite(verificationAge) &&
    verificationAge <= MAX_CONTEMPORARY_ADMIN_VERIFICATION_AGE_MS
  );
}

function isAuthorValidityClosed(candidate: KnowledgeCandidate): boolean {
  const author = candidate.authorVerification;
  if (
    author?.status !== 'trusted_author' ||
    candidate.effectiveAt === undefined ||
    author.validFrom === undefined
  ) {
    return author?.status === 'telegram_api_current';
  }
  const effectiveAt = Date.parse(candidate.effectiveAt);
  const validFrom = Date.parse(author.validFrom);
  const validTo = author.validTo === undefined ? undefined : Date.parse(author.validTo);
  return (
    Number.isFinite(effectiveAt) &&
    Number.isFinite(validFrom) &&
    effectiveAt >= validFrom &&
    (validTo === undefined || (Number.isFinite(validTo) && effectiveAt < validTo))
  );
}

function automationReviewNote(decision: KnowledgeAutomationDecision): string {
  return [decision.policyVersion, decision.decision, ...decision.reasonCodes].join(':');
}

function summarizeAutomation(
  decisions: KnowledgeAutomationOutcome[],
): KnowledgeAutomationRunResult {
  return {
    approvedCount: decisions.filter((outcome) => outcome.decision.decision === 'approve').length,
    decisions,
    policyVersion: KNOWLEDGE_AUTOMATION_POLICY_VERSION,
    publicationQueuedCount: decisions.filter(
      (outcome) =>
        outcome.publication?.status === 'queued' || outcome.publication?.status === 'running',
    ).length,
    rejectedCount: decisions.filter((outcome) => outcome.decision.decision === 'reject').length,
  };
}

function normalizeAutomationLimit(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error('Knowledge automation limit must be an integer between 1 and 500.');
  }
  return value;
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
