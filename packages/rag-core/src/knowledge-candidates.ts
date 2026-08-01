import { createHash } from 'node:crypto';

import type { PgClientLike } from './pgvector-store.js';
import { redactSensitiveSupportText } from './redaction.js';
import {
  migrateKnowledgeGovernanceAudit,
  migrateTrustedAuthors,
  normalizeTelegramUserId,
  type TrustedAuthorRole,
  type TrustedAuthorVerificationSource,
} from './trusted-authors.js';
import { migrateTelegramKnowledgeLearningSettings } from './telegram-learning-settings.js';
import { migrateTelegramGroupRegistry } from './telegram-group-registry.js';
import { migrateTelegramGroupMessages } from './telegram-group-messages.js';
import { migrateKnowledgeAdminUsers } from './knowledge-admin-users.js';

export type KnowledgeCandidateStatus = 'approved' | 'pending' | 'published' | 'rejected';
export type KnowledgeCandidateSourceChannel = 'telegram' | 'telegram_export' | 'web';
export type KnowledgeCandidateExtractionMethod =
  | 'agent_assisted'
  | 'deterministic_adjacent_admin_message'
  | 'deterministic_direct_reply'
  | 'manual';
export type KnowledgeAuthorVerificationStatus =
  | 'anonymous'
  | 'explicit_admin_id'
  | 'telegram_api_current'
  | 'trusted_author'
  | 'unverified';

export interface KnowledgeAuthorVerification {
  source: TrustedAuthorVerificationSource | 'explicit_admin_id' | 'unknown';
  status: KnowledgeAuthorVerificationStatus;
  userId?: string;
  role?: TrustedAuthorRole;
  validFrom?: string;
  validTo?: string;
  verifiedAt?: string;
}

export interface CreateKnowledgeCandidateInput {
  canonicalAnswer: string;
  question: string;
  sourceChannel: KnowledgeCandidateSourceChannel;
  authorVerification?: KnowledgeAuthorVerification;
  conflictChunkIds?: string[];
  contextMessageIds?: string[];
  curatorModel?: string;
  curatorPromptVersion?: string;
  curatorRunId?: string;
  duplicateCandidateIds?: string[];
  effectiveAt?: string;
  evidence?: string;
  extractionMethod?: KnowledgeCandidateExtractionMethod;
  proposedModule?: string;
  proposedTitle?: string;
  qualityScore?: number;
  riskFlags?: string[];
  sourceAnswerMessageId?: string;
  sourceAnswerText?: string;
  sourceChatId?: string;
  sourceQuestionMessageId?: string;
  sourceQuestionText?: string;
  sourceUrl?: string;
  submittedBy?: string;
  supersedes?: string[];
}

export interface KnowledgeCandidate {
  canonicalAnswer: string;
  contentHash: string;
  createdAt: string;
  id: string;
  question: string;
  sourceChannel: KnowledgeCandidateSourceChannel;
  status: KnowledgeCandidateStatus;
  updatedAt: string;
  authorVerification?: KnowledgeAuthorVerification;
  conflictChunkIds?: string[];
  contextMessageIds?: string[];
  curatorModel?: string;
  curatorPromptVersion?: string;
  curatorRunId?: string;
  currentRevision?: number;
  duplicateCandidateIds?: string[];
  effectiveAt?: string;
  evidence?: string;
  extractionMethod?: KnowledgeCandidateExtractionMethod;
  publishedAt?: string;
  publishedDocumentId?: string;
  proposedModule?: string;
  proposedTitle?: string;
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
  submittedBy?: string;
  supersedes?: string[];
}

interface CreateKnowledgeCandidatesResult {
  created: KnowledgeCandidate[];
  duplicateCount: number;
}

interface ListKnowledgeCandidatesOptions {
  limit?: number;
  status?: KnowledgeCandidateStatus;
}

interface ReviewKnowledgeCandidateInput {
  decision: 'approve' | 'reject';
  id: string;
  reviewedBy: string;
  effectiveAt?: string;
  note?: string;
  sourceUrl?: string;
  supersedes?: string[];
}

interface MarkKnowledgeCandidatePublishedInput {
  id: string;
  publishedDocumentId: string;
}

export interface ReviseKnowledgeCandidateInput {
  editedBy: string;
  id: string;
  canonicalAnswer?: string;
  evidence?: string;
  proposedModule?: string;
  proposedTitle?: string;
  question?: string;
  reason?: string;
}

export interface KnowledgeCandidateRevision {
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

export interface KnowledgeCandidateReviewRecord {
  candidateId: string;
  createdAt: string;
  decision: 'approve' | 'reject';
  id: number;
  reviewedBy: string;
  revision: number;
  note?: string;
}

export interface KnowledgeGovernanceAuditEvent {
  actor: string;
  createdAt: string;
  details: Record<string, unknown>;
  entityId: string;
  entityType: 'candidate' | 'publication' | 'trusted_author';
  eventType: string;
  id: string;
}

export interface KnowledgeCandidateHistory {
  auditEvents: KnowledgeGovernanceAuditEvent[];
  reviews: KnowledgeCandidateReviewRecord[];
  revisions: KnowledgeCandidateRevision[];
}

export interface PgKnowledgeCandidateStore {
  createMany(inputs: CreateKnowledgeCandidateInput[]): Promise<CreateKnowledgeCandidatesResult>;
  get(id: string): Promise<KnowledgeCandidate | undefined>;
  list(options?: ListKnowledgeCandidatesOptions): Promise<KnowledgeCandidate[]>;
  getHistory(id: string): Promise<KnowledgeCandidateHistory>;
  markPublished(input: MarkKnowledgeCandidatePublishedInput): Promise<KnowledgeCandidate>;
  migrate(): Promise<void>;
  revise(input: ReviseKnowledgeCandidateInput): Promise<KnowledgeCandidate>;
  review(input: ReviewKnowledgeCandidateInput): Promise<KnowledgeCandidate>;
  retractTelegramSource?(input: {
    actor: string;
    messageId: string;
    sourceChatId: string;
    reason?: 'source_deleted' | 'source_edited';
  }): Promise<{ publishedCandidateIds: string[]; retractedCandidateIds: string[] }>;
}

export interface PgKnowledgeCandidateStoreOptions {
  client: PgClientLike;
}

interface KnowledgeCandidateRow {
  canonical_answer: string;
  author_verification: KnowledgeAuthorVerification | null;
  conflict_chunk_ids: string[] | null;
  content_hash: string;
  context_message_ids: string[] | null;
  created_at: string;
  curator_model: string | null;
  curator_prompt_version: string | null;
  curator_run_id: string | null;
  current_revision: number;
  duplicate_candidate_ids: string[] | null;
  effective_at: string | null;
  evidence: string | null;
  extraction_method: KnowledgeCandidateExtractionMethod | null;
  id: string;
  published_at: string | null;
  published_document_id: string | null;
  proposed_module: string | null;
  proposed_title: string | null;
  quality_score: number | null;
  question: string;
  risk_flags: string[] | null;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  source_answer_message_id: string | null;
  source_answer_text: string | null;
  source_channel: KnowledgeCandidateSourceChannel;
  source_chat_id: string | null;
  source_question_message_id: string | null;
  source_question_text: string | null;
  source_url: string | null;
  status: KnowledgeCandidateStatus;
  submitted_by: string | null;
  supersedes: string[] | null;
  updated_at: string;
}

interface KnowledgeCandidateRevisionRow {
  canonical_answer: string;
  candidate_id: string;
  created_at: string;
  edited_by: string;
  evidence: string | null;
  id: number;
  proposed_module: string | null;
  proposed_title: string | null;
  question: string;
  reason: string | null;
  revision: number;
}

interface KnowledgeCandidateReviewRow {
  candidate_id: string;
  created_at: string;
  decision: 'approve' | 'reject';
  id: number;
  note: string | null;
  reviewed_by: string;
  revision: number;
}

interface KnowledgeGovernanceAuditEventRow {
  actor: string;
  created_at: string;
  details: Record<string, unknown>;
  entity_id: string;
  entity_type: 'candidate' | 'publication' | 'trusted_author';
  event_type: string;
  id: string;
}

export class InvalidKnowledgeCandidateStateError extends Error {
  constructor(id: string, expectedState: string) {
    super(`Knowledge candidate ${id} must be ${expectedState}.`);
    this.name = 'InvalidKnowledgeCandidateStateError';
  }
}

const KNOWLEDGE_CANDIDATE_COLUMNS = `
  id,
  content_hash,
  question,
  canonical_answer,
  source_channel,
  context_message_ids,
  author_verification,
  extraction_method,
  curator_run_id,
  curator_model,
  curator_prompt_version,
  quality_score,
  risk_flags,
  duplicate_candidate_ids,
  conflict_chunk_ids,
  proposed_title,
  proposed_module,
  current_revision,
  source_chat_id,
  source_question_message_id,
  source_answer_message_id,
  source_question_text,
  source_answer_text,
  source_url,
  submitted_by,
  evidence,
  effective_at::text as effective_at,
  supersedes,
  status,
  review_note,
  reviewed_by,
  reviewed_at::text as reviewed_at,
  published_document_id,
  published_at::text as published_at,
  created_at::text as created_at,
  updated_at::text as updated_at
`;

export function createPgKnowledgeCandidateStore(
  options: PgKnowledgeCandidateStoreOptions,
): PgKnowledgeCandidateStore {
  return {
    async createMany(
      inputs: CreateKnowledgeCandidateInput[],
    ): Promise<CreateKnowledgeCandidatesResult> {
      if (inputs.length === 0) {
        return { created: [], duplicateCount: 0 };
      }
      if (options.client.connect !== undefined && options.client.release === undefined) {
        const client = await options.client.connect();
        try {
          await client.query('begin');
          const result = await createPgKnowledgeCandidateStore({ client }).createMany(inputs);
          await client.query('commit');
          return result;
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
      const created: KnowledgeCandidate[] = [];
      let duplicateCount = 0;

      for (const input of inputs) {
        const normalized = normalizeCreateInput(input);
        const contentHash = createCandidateContentHash(
          normalized.question,
          normalized.canonicalAnswer,
        );
        const id = `knowledge_candidate_${contentHash.slice(0, 16)}`;
        const response = await queryDatabase<KnowledgeCandidateRow>(
          options.client,
          `
          with inserted as (
            insert into knowledge_candidates (
              id, content_hash, question, canonical_answer, source_channel,
              context_message_ids, author_verification, extraction_method,
              curator_run_id, curator_model, curator_prompt_version, quality_score,
              risk_flags, duplicate_candidate_ids, conflict_chunk_ids,
              proposed_title, proposed_module,
              source_chat_id, source_question_message_id, source_answer_message_id,
              source_question_text, source_answer_text,
              source_url, submitted_by, evidence, effective_at, supersedes
            )
            values (
              $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12,
              $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20,
              $21, $22, $23, $24, $25, $26, $27::jsonb
            )
            on conflict (content_hash) do nothing
            returning ${KNOWLEDGE_CANDIDATE_COLUMNS}
          ), revision as (
            insert into knowledge_candidate_revisions (
              candidate_id, revision, question, canonical_answer, evidence,
              proposed_title, proposed_module, edited_by, reason
            )
            select id, 1, question, canonical_answer, evidence,
              proposed_title, proposed_module, coalesce(submitted_by, 'system:curator'),
              'initial candidate'
            from inserted
          ), audited as (
            insert into knowledge_governance_audit_events (
              entity_type, entity_id, event_type, actor, details
            )
            select
              'candidate', id, 'candidate_created',
              coalesce(submitted_by, 'system:curator'),
              jsonb_build_object(
                'extractionMethod', extraction_method,
                'curatorRunId', curator_run_id,
                'qualityScore', quality_score,
                'riskFlags', risk_flags
              )
            from inserted
          )
          select ${KNOWLEDGE_CANDIDATE_COLUMNS}
          from inserted
          `,
          [
            id,
            contentHash,
            normalized.question,
            normalized.canonicalAnswer,
            normalized.sourceChannel,
            JSON.stringify(normalized.contextMessageIds ?? []),
            normalized.authorVerification === undefined
              ? null
              : JSON.stringify(normalized.authorVerification),
            normalized.extractionMethod ?? 'manual',
            normalized.curatorRunId ?? null,
            normalized.curatorModel ?? null,
            normalized.curatorPromptVersion ?? null,
            normalized.qualityScore ?? null,
            JSON.stringify(normalized.riskFlags ?? []),
            JSON.stringify(normalized.duplicateCandidateIds ?? []),
            JSON.stringify(normalized.conflictChunkIds ?? []),
            normalized.proposedTitle ?? null,
            normalized.proposedModule ?? null,
            normalized.sourceChatId ?? null,
            normalized.sourceQuestionMessageId ?? null,
            normalized.sourceAnswerMessageId ?? null,
            normalized.sourceQuestionText ?? null,
            normalized.sourceAnswerText ?? null,
            normalized.sourceUrl ?? null,
            normalized.submittedBy ?? null,
            normalized.evidence ?? null,
            normalized.effectiveAt ?? null,
            JSON.stringify(normalized.supersedes ?? []),
          ],
        );
        const row = response.rows[0];
        if (row === undefined) {
          duplicateCount += 1;
        } else {
          created.push(mapKnowledgeCandidateRow(row));
        }
      }

      return { created, duplicateCount };
    },

    async retractTelegramSource(input) {
      const sourceChatId = normalizeRequiredText(input.sourceChatId, 'sourceChatId');
      const messageId = normalizeRequiredText(input.messageId, 'messageId');
      const actor = normalizeRequiredText(input.actor, 'actor');
      const reason = input.reason ?? 'source_edited';
      const response = await queryDatabase<{
        id: string;
        published_document_id: string | null;
        previous_status: KnowledgeCandidateStatus;
      }>(
        options.client,
        `
        with matched as (
          select id, status, published_document_id
          from knowledge_candidates
          where
            source_channel = 'telegram'
            and source_chat_id = $1
            and source_answer_message_id = $2
          for update
        ), retracted as (
          update knowledge_candidates candidates
          set
            status = 'rejected',
            review_note = case
              when $4 = 'source_deleted'
                then 'Telegram source message was deleted; candidate retracted.'
              else 'Telegram source message was edited; candidate retracted before re-evaluation.'
            end,
            reviewed_at = now(),
            reviewed_by = $3,
            updated_at = now()
          from matched
          where
            candidates.id = matched.id
            and matched.status in ('pending', 'approved', 'published')
          returning
            candidates.id,
            matched.status as previous_status,
            matched.published_document_id
        ), tombstoned as (
          insert into knowledge_source_tombstones (
            document_id, source_channel, source_chat_id, source_message_id, reason, actor
          )
          select
            published_document_id, 'telegram', $1, $2, $4, $3
          from retracted
          where previous_status = 'published' and published_document_id is not null
          on conflict (document_id) do update
          set reason = excluded.reason, actor = excluded.actor, created_at = now()
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'candidate', id, 'telegram_source_retracted', $3,
            jsonb_build_object(
              'sourceChatId', $1,
              'sourceAnswerMessageId', $2,
              'reason', $4,
              'previousStatus', previous_status
            )
          from retracted
        )
        select id, previous_status, published_document_id
        from retracted
        `,
        [sourceChatId, messageId, actor, reason],
      );
      return {
        publishedCandidateIds: response.rows
          .filter((row) => row.previous_status === 'published')
          .map((row) => row.id),
        retractedCandidateIds: response.rows.map((row) => row.id),
      };
    },

    async get(id: string): Promise<KnowledgeCandidate | undefined> {
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        select ${KNOWLEDGE_CANDIDATE_COLUMNS}
        from knowledge_candidates
        where id = $1
        `,
        [normalizeRequiredText(id, 'id')],
      );
      const row = response.rows[0];
      return row === undefined ? undefined : mapKnowledgeCandidateRow(row);
    },

    async getHistory(id: string): Promise<KnowledgeCandidateHistory> {
      const normalizedId = normalizeRequiredText(id, 'id');
      const revisionResponse = await queryDatabase<KnowledgeCandidateRevisionRow>(
        options.client,
        `
          select
            id, candidate_id, revision, question, canonical_answer, evidence,
            proposed_title, proposed_module, edited_by, reason,
            created_at::text as created_at
          from knowledge_candidate_revisions
          where candidate_id = $1
          order by revision
          `,
        [normalizedId],
      );
      const reviewResponse = await queryDatabase<KnowledgeCandidateReviewRow>(
        options.client,
        `
          select
            id, candidate_id, revision, decision, reviewed_by, note,
            created_at::text as created_at
          from knowledge_candidate_reviews
          where candidate_id = $1
          order by created_at, id
          `,
        [normalizedId],
      );
      const auditResponse = await queryDatabase<KnowledgeGovernanceAuditEventRow>(
        options.client,
        `
          select
            id::text as id, entity_type, entity_id, event_type, actor, details,
            created_at::text as created_at
          from knowledge_governance_audit_events
          where entity_id = $1 and entity_type in ('candidate', 'publication')
          order by created_at, id
          `,
        [normalizedId],
      );
      return {
        auditEvents: auditResponse.rows.map(mapKnowledgeGovernanceAuditEventRow),
        reviews: reviewResponse.rows.map(mapKnowledgeCandidateReviewRow),
        revisions: revisionResponse.rows.map(mapKnowledgeCandidateRevisionRow),
      };
    },

    async list(input: ListKnowledgeCandidatesOptions = {}): Promise<KnowledgeCandidate[]> {
      const limit = normalizeListLimit(input.limit);
      const values = input.status === undefined ? [limit] : [input.status, limit];
      const whereClause = input.status === undefined ? '' : 'where status = $1';
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        select ${KNOWLEDGE_CANDIDATE_COLUMNS}
        from knowledge_candidates
        ${whereClause}
        order by created_at desc, id
        limit $${values.length}
        `,
        values,
      );
      return response.rows.map(mapKnowledgeCandidateRow);
    },

    async markPublished(input: MarkKnowledgeCandidatePublishedInput): Promise<KnowledgeCandidate> {
      const id = normalizeRequiredText(input.id, 'id');
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        with updated as (
          update knowledge_candidates
          set
            status = 'published',
            published_document_id = $2,
            published_at = now(),
            updated_at = now()
          where id = $1 and status = 'approved'
          returning ${KNOWLEDGE_CANDIDATE_COLUMNS}
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'publication', id, 'candidate_published', 'system:publisher',
            jsonb_build_object(
              'candidateId', id,
              'documentId', published_document_id,
              'revision', current_revision
            )
          from updated
        )
        select ${KNOWLEDGE_CANDIDATE_COLUMNS}
        from updated
        `,
        [id, normalizeRequiredText(input.publishedDocumentId, 'publishedDocumentId')],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new InvalidKnowledgeCandidateStateError(id, 'approved before publication');
      }
      return mapKnowledgeCandidateRow(row);
    },

    migrate(): Promise<void> {
      return migrateKnowledgeCandidates(options.client);
    },

    async revise(input: ReviseKnowledgeCandidateInput): Promise<KnowledgeCandidate> {
      const id = normalizeRequiredText(input.id, 'id');
      const currentResponse = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        select ${KNOWLEDGE_CANDIDATE_COLUMNS}
        from knowledge_candidates
        where id = $1 and status = 'pending'
        `,
        [id],
      );
      const currentRow = currentResponse.rows[0];
      if (currentRow === undefined) {
        throw new InvalidKnowledgeCandidateStateError(id, 'pending before revision');
      }
      const current = mapKnowledgeCandidateRow(currentRow);
      const question =
        input.question === undefined
          ? current.question
          : sanitizeKnowledgeCandidateText(input.question, 'question');
      const canonicalAnswer =
        input.canonicalAnswer === undefined
          ? current.canonicalAnswer
          : sanitizeKnowledgeCandidateText(input.canonicalAnswer, 'canonicalAnswer');
      const evidence =
        input.evidence === undefined
          ? (current.evidence ?? null)
          : sanitizeKnowledgeCandidateText(input.evidence, 'evidence');
      const proposedTitle =
        input.proposedTitle === undefined
          ? (current.proposedTitle ?? null)
          : normalizeOptionalText(input.proposedTitle);
      const proposedModule =
        input.proposedModule === undefined
          ? (current.proposedModule ?? null)
          : normalizeOptionalText(input.proposedModule);
      const editedBy = normalizeRequiredText(input.editedBy, 'editedBy');
      const reason = normalizeOptionalText(input.reason) ?? null;
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        with updated as (
          update knowledge_candidates
          set
            content_hash = $2,
            question = $3,
            canonical_answer = $4,
            evidence = $5,
            proposed_title = $6,
            proposed_module = $7,
            current_revision = current_revision + 1,
            updated_at = now()
          where id = $1 and status = 'pending'
          returning ${KNOWLEDGE_CANDIDATE_COLUMNS}
        ), revision as (
          insert into knowledge_candidate_revisions (
            candidate_id, revision, question, canonical_answer, evidence,
            proposed_title, proposed_module, edited_by, reason
          )
          select id, current_revision, question, canonical_answer, evidence,
            proposed_title, proposed_module, $8, $9
          from updated
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'candidate', id, 'candidate_revised', $8,
            jsonb_build_object('revision', current_revision, 'reason', $9)
          from updated
        )
        select ${KNOWLEDGE_CANDIDATE_COLUMNS}
        from updated
        `,
        [
          id,
          createCandidateContentHash(question, canonicalAnswer),
          question,
          canonicalAnswer,
          evidence,
          proposedTitle,
          proposedModule,
          editedBy,
          reason,
        ],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new InvalidKnowledgeCandidateStateError(id, 'pending before revision');
      }
      return mapKnowledgeCandidateRow(row);
    },

    async review(input: ReviewKnowledgeCandidateInput): Promise<KnowledgeCandidate> {
      const id = normalizeRequiredText(input.id, 'id');
      const nextStatus: KnowledgeCandidateStatus =
        input.decision === 'approve' ? 'approved' : 'rejected';
      const sourceUrl =
        input.sourceUrl === undefined ? undefined : normalizeSourceUrl(input.sourceUrl);
      const response = await queryDatabase<KnowledgeCandidateRow>(
        options.client,
        `
        with updated as (
          update knowledge_candidates
          set
            status = $2,
            reviewed_by = $3,
            review_note = $4,
            effective_at = coalesce($5::timestamptz, effective_at),
            source_url = coalesce($6, source_url),
            supersedes = coalesce($7::jsonb, supersedes),
            reviewed_at = now(),
            updated_at = now()
          where id = $1 and status = 'pending'
          returning ${KNOWLEDGE_CANDIDATE_COLUMNS}
        ), review_record as (
          insert into knowledge_candidate_reviews (
            candidate_id, revision, decision, reviewed_by, note
          )
          select
            id, current_revision,
            case when status = 'approved' then 'approve' else 'reject' end,
            $3, $4
          from updated
        ), audited as (
          insert into knowledge_governance_audit_events (
            entity_type, entity_id, event_type, actor, details
          )
          select
            'candidate', id, 'candidate_reviewed', $3,
            jsonb_build_object(
              'decision', case when status = 'approved' then 'approve' else 'reject' end,
              'revision', current_revision,
              'note', $4
            )
          from updated
        )
        select ${KNOWLEDGE_CANDIDATE_COLUMNS}
        from updated
        `,
        [
          id,
          nextStatus,
          normalizeRequiredText(input.reviewedBy, 'reviewedBy'),
          normalizeOptionalText(input.note) ?? null,
          normalizeOptionalTimestamp(input.effectiveAt) ?? null,
          sourceUrl ?? null,
          input.supersedes === undefined
            ? null
            : JSON.stringify(normalizeSupersedes(input.supersedes)),
        ],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new InvalidKnowledgeCandidateStateError(id, 'pending before review');
      }
      return mapKnowledgeCandidateRow(row);
    },
  };
}

export async function migrateKnowledgeCandidates(client: PgClientLike): Promise<void> {
  await queryDatabase(
    client,
    `
    do $$
    begin
      if to_regclass('public.knowledge_candidates') is not null
        and not exists (
          select 1
          from information_schema.columns
          where
            table_schema = 'public'
            and table_name = 'knowledge_candidates'
            and column_name = 'content_hash'
        )
      then
        if to_regclass('public.knowledge_candidates_legacy') is not null then
          raise exception 'Cannot preserve legacy knowledge_candidates: knowledge_candidates_legacy already exists.';
        end if;

        alter table knowledge_candidates rename to knowledge_candidates_legacy;

        if exists (
          select 1
          from pg_constraint
          where
            conrelid = 'public.knowledge_candidates_legacy'::regclass
            and conname = 'knowledge_candidates_pkey'
        )
        then
          alter table knowledge_candidates_legacy
            rename constraint knowledge_candidates_pkey to knowledge_candidates_legacy_pkey;
        end if;
      end if;
    end
    $$
    `,
  );
  await queryDatabase(
    client,
    `
    create table if not exists knowledge_candidates (
      id text primary key,
      content_hash text not null unique,
      question text not null,
      canonical_answer text not null,
      source_channel text not null check (
        source_channel in ('telegram', 'telegram_export', 'web')
      ),
      context_message_ids jsonb not null default '[]'::jsonb,
      author_verification jsonb,
      extraction_method text not null default 'manual' check (
        extraction_method in (
          'agent_assisted',
          'deterministic_adjacent_admin_message',
          'deterministic_direct_reply',
          'manual'
        )
      ),
      curator_run_id text,
      curator_model text,
      curator_prompt_version text,
      quality_score double precision check (
        quality_score is null or (quality_score >= 0 and quality_score <= 1)
      ),
      risk_flags jsonb not null default '[]'::jsonb,
      duplicate_candidate_ids jsonb not null default '[]'::jsonb,
      conflict_chunk_ids jsonb not null default '[]'::jsonb,
      proposed_title text,
      proposed_module text,
      current_revision integer not null default 1 check (current_revision > 0),
      source_chat_id text,
      source_question_message_id text,
      source_answer_message_id text,
      source_question_text text,
      source_answer_text text,
      source_url text,
      submitted_by text,
      evidence text,
      effective_at timestamptz,
      supersedes jsonb not null default '[]'::jsonb,
      status text not null default 'pending' check (
        status in ('pending', 'approved', 'rejected', 'published')
      ),
      review_note text,
      reviewed_by text,
      reviewed_at timestamptz,
      published_document_id text,
      published_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create table if not exists knowledge_source_tombstones (
      document_id text primary key,
      source_channel text not null check (source_channel in ('telegram', 'telegram_export')),
      source_chat_id text not null,
      source_message_id text not null,
      reason text not null check (reason in ('source_deleted', 'source_edited')),
      actor text not null,
      created_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_source_tombstones_source_idx
      on knowledge_source_tombstones (source_channel, source_chat_id, source_message_id)
    `,
  );
  await queryDatabase(
    client,
    `
    alter table knowledge_candidates
      add column if not exists context_message_ids jsonb not null default '[]'::jsonb,
      add column if not exists author_verification jsonb,
      add column if not exists extraction_method text not null default 'manual',
      add column if not exists curator_run_id text,
      add column if not exists curator_model text,
      add column if not exists curator_prompt_version text,
      add column if not exists quality_score double precision,
      add column if not exists risk_flags jsonb not null default '[]'::jsonb,
      add column if not exists duplicate_candidate_ids jsonb not null default '[]'::jsonb,
      add column if not exists conflict_chunk_ids jsonb not null default '[]'::jsonb,
      add column if not exists proposed_title text,
      add column if not exists proposed_module text,
      add column if not exists current_revision integer not null default 1,
      add column if not exists source_question_text text,
      add column if not exists source_answer_text text
    `,
  );
  await queryDatabase(
    client,
    `
    alter table knowledge_candidates
      drop constraint if exists knowledge_candidates_extraction_method_check,
      drop constraint if exists knowledge_candidates_quality_score_check,
      drop constraint if exists knowledge_candidates_current_revision_check
    `,
  );
  await queryDatabase(
    client,
    `
    alter table knowledge_candidates
      add constraint knowledge_candidates_extraction_method_check check (
        extraction_method in (
          'agent_assisted',
          'deterministic_adjacent_admin_message',
          'deterministic_direct_reply',
          'manual'
        )
      ),
      add constraint knowledge_candidates_quality_score_check check (
        quality_score is null or (quality_score >= 0 and quality_score <= 1)
      ),
      add constraint knowledge_candidates_current_revision_check check (current_revision > 0)
    `,
  );
  await migrateKnowledgeGovernanceAudit(client);
  await queryDatabase(
    client,
    `
    create table if not exists knowledge_candidate_revisions (
      id bigserial primary key,
      candidate_id text not null references knowledge_candidates(id) on delete cascade,
      revision integer not null check (revision > 0),
      question text not null,
      canonical_answer text not null,
      evidence text,
      proposed_title text,
      proposed_module text,
      edited_by text not null,
      reason text,
      created_at timestamptz not null default now(),
      unique (candidate_id, revision)
    )
    `,
  );
  await queryDatabase(
    client,
    `
    insert into knowledge_candidate_revisions (
      candidate_id, revision, question, canonical_answer, evidence,
      proposed_title, proposed_module, edited_by, reason, created_at
    )
    select
      id, current_revision, question, canonical_answer, evidence,
      proposed_title, proposed_module, coalesce(submitted_by, 'system:migration'),
      'migration backfill', created_at
    from knowledge_candidates
    on conflict (candidate_id, revision) do nothing
    `,
  );
  await queryDatabase(
    client,
    `
    create table if not exists knowledge_candidate_reviews (
      id bigserial primary key,
      candidate_id text not null references knowledge_candidates(id) on delete cascade,
      revision integer not null check (revision > 0),
      decision text not null check (decision in ('approve', 'reject')),
      reviewed_by text not null,
      note text,
      created_at timestamptz not null default now()
    )
    `,
  );
  await queryDatabase(
    client,
    `
    insert into knowledge_candidate_reviews (
      candidate_id, revision, decision, reviewed_by, note, created_at
    )
    select
      id, current_revision,
      case when status in ('approved', 'published') then 'approve' else 'reject' end,
      reviewed_by, review_note, reviewed_at
    from knowledge_candidates
    where
      reviewed_at is not null
      and reviewed_by is not null
      and not exists (
        select 1
        from knowledge_candidate_reviews reviews
        where reviews.candidate_id = knowledge_candidates.id
      )
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_candidate_revisions_candidate_idx
      on knowledge_candidate_revisions (candidate_id, revision desc)
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_candidate_reviews_candidate_idx
      on knowledge_candidate_reviews (candidate_id, created_at desc)
    `,
  );
  await migrateTrustedAuthors(client);
  await migrateTelegramKnowledgeLearningSettings(client);
  await migrateTelegramGroupRegistry(client);
  await migrateTelegramGroupMessages(client);
  await migrateKnowledgeAdminUsers(client);
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_candidates_review_status_created_at_idx
      on knowledge_candidates (status, created_at desc)
    `,
  );
  await queryDatabase(
    client,
    `
    create index if not exists knowledge_candidates_review_source_message_idx
      on knowledge_candidates (
        source_channel, source_chat_id, source_answer_message_id
      )
    `,
  );
}

function normalizeCreateInput(input: CreateKnowledgeCandidateInput): CreateKnowledgeCandidateInput {
  const normalized: CreateKnowledgeCandidateInput = {
    canonicalAnswer: sanitizeKnowledgeCandidateText(input.canonicalAnswer, 'canonicalAnswer'),
    question: sanitizeKnowledgeCandidateText(input.question, 'question'),
    sourceChannel: input.sourceChannel,
  };

  if (input.authorVerification !== undefined) {
    normalized.authorVerification = normalizeAuthorVerification(input.authorVerification);
  }
  if (input.conflictChunkIds !== undefined) {
    normalized.conflictChunkIds = normalizeIdentifierList(
      input.conflictChunkIds,
      'conflictChunkIds',
    );
  }
  if (input.contextMessageIds !== undefined) {
    normalized.contextMessageIds = normalizeIdentifierList(
      input.contextMessageIds,
      'contextMessageIds',
    );
  }
  if (input.curatorModel !== undefined) {
    normalized.curatorModel = normalizeRequiredText(input.curatorModel, 'curatorModel');
  }
  if (input.curatorPromptVersion !== undefined) {
    normalized.curatorPromptVersion = normalizeRequiredText(
      input.curatorPromptVersion,
      'curatorPromptVersion',
    );
  }
  if (input.curatorRunId !== undefined) {
    normalized.curatorRunId = normalizeRequiredText(input.curatorRunId, 'curatorRunId');
  }
  if (input.duplicateCandidateIds !== undefined) {
    normalized.duplicateCandidateIds = normalizeIdentifierList(
      input.duplicateCandidateIds,
      'duplicateCandidateIds',
    );
  }
  const effectiveAt = normalizeOptionalTimestamp(input.effectiveAt);
  if (effectiveAt !== undefined) {
    normalized.effectiveAt = effectiveAt;
  }
  if (input.evidence !== undefined) {
    normalized.evidence = sanitizeKnowledgeCandidateText(input.evidence, 'evidence');
  }
  if (input.extractionMethod !== undefined) {
    normalized.extractionMethod = input.extractionMethod;
  }
  if (input.proposedModule !== undefined) {
    normalized.proposedModule = sanitizeKnowledgeCandidateText(
      input.proposedModule,
      'proposedModule',
    );
  }
  if (input.proposedTitle !== undefined) {
    normalized.proposedTitle = sanitizeKnowledgeCandidateText(input.proposedTitle, 'proposedTitle');
  }
  if (input.qualityScore !== undefined) {
    normalized.qualityScore = normalizeQualityScore(input.qualityScore);
  }
  if (input.riskFlags !== undefined) {
    normalized.riskFlags = normalizeRiskFlags(input.riskFlags);
  }
  if (input.sourceAnswerMessageId !== undefined) {
    normalized.sourceAnswerMessageId = normalizeRequiredText(
      input.sourceAnswerMessageId,
      'sourceAnswerMessageId',
    );
  }
  if (input.sourceAnswerText !== undefined) {
    normalized.sourceAnswerText = sanitizeKnowledgeCandidateText(
      input.sourceAnswerText,
      'sourceAnswerText',
    );
  }
  if (input.sourceChatId !== undefined) {
    normalized.sourceChatId = normalizeRequiredText(input.sourceChatId, 'sourceChatId');
  }
  if (input.sourceQuestionMessageId !== undefined) {
    normalized.sourceQuestionMessageId = normalizeRequiredText(
      input.sourceQuestionMessageId,
      'sourceQuestionMessageId',
    );
  }
  if (input.sourceQuestionText !== undefined) {
    normalized.sourceQuestionText = sanitizeKnowledgeCandidateText(
      input.sourceQuestionText,
      'sourceQuestionText',
    );
  }
  if (input.sourceUrl !== undefined) {
    normalized.sourceUrl = normalizeSourceUrl(input.sourceUrl);
  }
  if (input.submittedBy !== undefined) {
    normalized.submittedBy = normalizeRequiredText(input.submittedBy, 'submittedBy');
  }
  if (input.supersedes !== undefined) {
    normalized.supersedes = normalizeSupersedes(input.supersedes);
  }

  return normalized;
}

export function sanitizeKnowledgeCandidateText(text: string, field = 'text'): string {
  const sanitized = redactSensitiveSupportText(text)
    .replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/gu, '[solana_signature]')
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[phone]')
    .replace(/(?<![\w/])@[A-Za-z0-9_]{5,32}\b/gu, '[telegram_user]')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (sanitized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return sanitized;
}

function createCandidateContentHash(question: string, canonicalAnswer: string): string {
  return createHash('sha256')
    .update(question.normalize('NFKC').toLowerCase())
    .update('\0')
    .update(canonicalAnswer.normalize('NFKC').toLowerCase())
    .digest('hex');
}

function normalizeRequiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeOptionalTimestamp(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (normalized === undefined) {
    return undefined;
  }
  return normalizeRequiredTimestamp(normalized, 'effectiveAt');
}

function normalizeRequiredTimestamp(value: string, field: string): string {
  const normalized = normalizeRequiredText(value, field);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${field} must be a valid date or timestamp.`);
  }
  return new Date(normalized).toISOString();
}

function normalizeSupersedes(values: string[]): string[] {
  const normalized = [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ];
  if (normalized.some((value) => !/^[A-Za-z0-9_.:/-]+$/u.test(value))) {
    throw new Error('supersedes values must be knowledge document or chunk ids.');
  }
  return normalized;
}

function normalizeIdentifierList(values: string[], field: string): string[] {
  const normalized = [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ];
  if (normalized.some((value) => !/^[A-Za-z0-9_.:@/-]+$/u.test(value))) {
    throw new Error(`${field} contains an invalid identifier.`);
  }
  return normalized;
}

function normalizeRiskFlags(values: string[]): string[] {
  const normalized = normalizeIdentifierList(values, 'riskFlags');
  if (normalized.some((value) => value.length > 80)) {
    throw new Error('riskFlags values must be at most 80 characters.');
  }
  return normalized;
}

function normalizeQualityScore(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('qualityScore must be a finite number between 0 and 1.');
  }
  return Math.round(value * 10_000) / 10_000;
}

function normalizeAuthorVerification(
  input: KnowledgeAuthorVerification,
): KnowledgeAuthorVerification {
  const normalized: KnowledgeAuthorVerification = {
    source: input.source,
    status: input.status,
    ...(input.userId === undefined ? {} : { userId: normalizeTelegramUserId(input.userId) }),
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.validFrom === undefined
      ? {}
      : {
          validFrom: normalizeRequiredTimestamp(input.validFrom, 'authorVerification.validFrom'),
        }),
    ...(input.validTo === undefined
      ? {}
      : { validTo: normalizeRequiredTimestamp(input.validTo, 'authorVerification.validTo') }),
    ...(input.verifiedAt === undefined
      ? {}
      : {
          verifiedAt: normalizeRequiredTimestamp(input.verifiedAt, 'authorVerification.verifiedAt'),
        }),
  };
  if (
    normalized.validFrom !== undefined &&
    normalized.validTo !== undefined &&
    Date.parse(normalized.validTo) <= Date.parse(normalized.validFrom)
  ) {
    throw new Error('authorVerification.validTo must be later than validFrom.');
  }
  if (
    normalized.status === 'trusted_author' &&
    (normalized.source === 'explicit_admin_id' ||
      normalized.source === 'unknown' ||
      normalized.userId === undefined ||
      normalized.role === undefined ||
      normalized.validFrom === undefined ||
      normalized.verifiedAt === undefined)
  ) {
    throw new Error('trusted_author verification requires a verified role validity record.');
  }
  if (
    normalized.status === 'explicit_admin_id' &&
    (normalized.source !== 'explicit_admin_id' || normalized.userId === undefined)
  ) {
    throw new Error('explicit_admin_id verification requires its explicit user id source.');
  }
  if (
    normalized.status === 'telegram_api_current' &&
    (normalized.source !== 'telegram_api' || normalized.userId === undefined)
  ) {
    throw new Error('telegram_api_current verification requires a Telegram API user id.');
  }
  if (normalized.status === 'anonymous' && normalized.source !== 'unknown') {
    throw new Error('anonymous verification must use the unknown source.');
  }
  return normalized;
}

function normalizeSourceUrl(value: string): string {
  const normalized = normalizeRequiredText(value, 'sourceUrl');
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('sourceUrl must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    throw new Error('sourceUrl must be a valid HTTPS URL.');
  }
  return url.toString();
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return 20;
  }
  return Math.min(limit, 100);
}

function mapKnowledgeCandidateRow(row: KnowledgeCandidateRow): KnowledgeCandidate {
  return {
    canonicalAnswer: row.canonical_answer,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    id: row.id,
    question: row.question,
    sourceChannel: row.source_channel,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.author_verification === null ? {} : { authorVerification: row.author_verification }),
    ...(row.conflict_chunk_ids === null || row.conflict_chunk_ids.length === 0
      ? {}
      : { conflictChunkIds: row.conflict_chunk_ids }),
    ...(row.context_message_ids === null || row.context_message_ids.length === 0
      ? {}
      : { contextMessageIds: row.context_message_ids }),
    ...(row.curator_model === null ? {} : { curatorModel: row.curator_model }),
    ...(row.curator_prompt_version === null
      ? {}
      : { curatorPromptVersion: row.curator_prompt_version }),
    ...(row.curator_run_id === null ? {} : { curatorRunId: row.curator_run_id }),
    currentRevision: row.current_revision,
    ...(row.duplicate_candidate_ids === null || row.duplicate_candidate_ids.length === 0
      ? {}
      : { duplicateCandidateIds: row.duplicate_candidate_ids }),
    ...(row.effective_at === null ? {} : { effectiveAt: row.effective_at }),
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    ...(row.extraction_method === null ? {} : { extractionMethod: row.extraction_method }),
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
    ...(row.published_document_id === null
      ? {}
      : { publishedDocumentId: row.published_document_id }),
    ...(row.proposed_module === null ? {} : { proposedModule: row.proposed_module }),
    ...(row.proposed_title === null ? {} : { proposedTitle: row.proposed_title }),
    ...(row.quality_score === null ? {} : { qualityScore: row.quality_score }),
    ...(row.risk_flags === null || row.risk_flags.length === 0
      ? {}
      : { riskFlags: row.risk_flags }),
    ...(row.review_note === null ? {} : { reviewNote: row.review_note }),
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
    ...(row.reviewed_by === null ? {} : { reviewedBy: row.reviewed_by }),
    ...(row.source_answer_message_id === null
      ? {}
      : { sourceAnswerMessageId: row.source_answer_message_id }),
    ...(row.source_answer_text === null ? {} : { sourceAnswerText: row.source_answer_text }),
    ...(row.source_chat_id === null ? {} : { sourceChatId: row.source_chat_id }),
    ...(row.source_question_message_id === null
      ? {}
      : { sourceQuestionMessageId: row.source_question_message_id }),
    ...(row.source_question_text === null ? {} : { sourceQuestionText: row.source_question_text }),
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    ...(row.submitted_by === null ? {} : { submittedBy: row.submitted_by }),
    ...(row.supersedes === null || row.supersedes.length === 0
      ? {}
      : { supersedes: row.supersedes }),
  };
}

function mapKnowledgeCandidateRevisionRow(
  row: KnowledgeCandidateRevisionRow,
): KnowledgeCandidateRevision {
  return {
    canonicalAnswer: row.canonical_answer,
    candidateId: row.candidate_id,
    createdAt: row.created_at,
    editedBy: row.edited_by,
    id: row.id,
    question: row.question,
    revision: row.revision,
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    ...(row.proposed_module === null ? {} : { proposedModule: row.proposed_module }),
    ...(row.proposed_title === null ? {} : { proposedTitle: row.proposed_title }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  };
}

function mapKnowledgeCandidateReviewRow(
  row: KnowledgeCandidateReviewRow,
): KnowledgeCandidateReviewRecord {
  return {
    candidateId: row.candidate_id,
    createdAt: row.created_at,
    decision: row.decision,
    id: row.id,
    reviewedBy: row.reviewed_by,
    revision: row.revision,
    ...(row.note === null ? {} : { note: row.note }),
  };
}

function mapKnowledgeGovernanceAuditEventRow(
  row: KnowledgeGovernanceAuditEventRow,
): KnowledgeGovernanceAuditEvent {
  return {
    actor: row.actor,
    createdAt: row.created_at,
    details: row.details,
    entityId: row.entity_id,
    entityType: row.entity_type,
    eventType: row.event_type,
    id: row.id,
  };
}

async function queryDatabase<T>(
  client: PgClientLike,
  sql: string,
  values: readonly unknown[] = [],
): Promise<{ rows: T[] }> {
  return client.query<T>(sql, values);
}
