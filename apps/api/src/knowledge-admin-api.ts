import { z } from 'zod';

import {
  classifyQuestion,
  createProductQueryPlan,
  createProductRetrievalPolicy,
  extractKnowledgeGraphRelations,
  InvalidKnowledgeCandidateStateError,
  InvalidKnowledgePublicationJobStateError,
  KnowledgePublicationJobNotFoundError,
  SupportConversationNotFoundError,
  SupportTicketNotFoundError,
  UnverifiedTelegramKnowledgeAuthorError,
  understandProductQuestion,
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
  renderPrometheusApiMetrics,
} from '@xxyy/rag-core';
import type {
  ImportTelegramKnowledgeResult,
  FeedbackRecord,
  KnowledgeCandidateImprovementSuggestion,
  KnowledgeCurationMode,
  KnowledgeGovernanceService,
  KnowledgeAdminRole,
  KnowledgeAdminUserStatus,
  KnowledgePublicationJobStatus,
  PgFeedbackStore,
  PgKnowledgePublicationJobStore,
  PgQualityEvaluationJobStore,
  PgKnowledgeAdminUserStore,
  PgKnowledgeGraphStore,
  PgSupportOperationsStore,
  PgApiObservabilityStore,
  PgTelegramGroupMessageStore,
  PgTelegramGroupRegistryStore,
  PgTelegramCurationJobStore,
  SupportTicketPriority,
  SupportTicketStatus,
} from '@xxyy/rag-core';

import type { ApiRequestLike, ApiResponseLike } from './index.js';
import {
  hasKnowledgeAdminPermission,
  readKnowledgeAdminBearerToken,
  type KnowledgeAdminPermission,
  type KnowledgeAdminPrincipal,
} from './knowledge-admin-auth.js';

export interface KnowledgeAdminServices {
  adminUsers: PgKnowledgeAdminUserStore;
  feedback: PgFeedbackStore;
  governance: KnowledgeGovernanceService;
  knowledgeGraph: PgKnowledgeGraphStore;
  publicationJobs: PgKnowledgePublicationJobStore;
  qualityEvaluations: PgQualityEvaluationJobStore;
  supportOperations: PgSupportOperationsStore;
  apiObservability: PgApiObservabilityStore;
  observabilityThresholds: {
    costUsd: number;
    rateLimitedRatio: number;
    serverErrorRatio: number;
  };
  telegramGroups: PgTelegramGroupRegistryStore;
  telegramCurationJobs: PgTelegramCurationJobStore;
  telegramMessages: PgTelegramGroupMessageStore;
  importTelegram(input: {
    curationMode: KnowledgeCurationMode;
    rawExport: unknown;
  }): Promise<ImportTelegramKnowledgeResult>;
  processTelegramInbox(input: { chatId: string; reprocess?: boolean }): Promise<{
    agentFailedThreadCount: number;
    candidateCount: number;
    createdCount: number;
    duplicateCount: number;
    processedMessageCount: number;
    requeuedMessageCount: number;
    retainedMessageCount: number;
    skippedBoundaryCount: number;
    skippedMissingReplyCount: number;
    unverifiedAuthorMessageCount: number;
  }>;
  suggestCandidate(input: {
    canonicalAnswer: string;
    id: string;
    question: string;
  }): Promise<KnowledgeCandidateImprovementSuggestion | undefined>;
}

export interface HandleKnowledgeAdminApiOptions {
  getServices: () => Promise<KnowledgeAdminServices>;
  maxBodyBytes: number;
  request: ApiRequestLike;
  requestUrl: URL;
  response: ApiResponseLike;
}

const candidateStatusSchema = z.enum(['approved', 'pending', 'published', 'rejected']);
const candidateSuggestionSchema = z
  .object({
    canonicalAnswer: z.string().trim().min(1).max(4_000),
    question: z.string().trim().min(1).max(2_000),
  })
  .strict();
const adminRoleSchema = z.enum(['admin', 'publisher', 'reviewer', 'viewer']);
const adminUserStatusSchema = z.enum(['active', 'disabled']);
const adminLoginSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    password: z.string().min(12).max(256),
  })
  .strict();
const changeOwnPasswordSchema = z
  .object({
    currentPassword: z.string().min(12).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'The new password must differ from the current password.',
    path: ['newPassword'],
  });
const initialAdminSetupSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    id: z.string().trim().min(1).max(160),
    password: z.string().min(12).max(256),
  })
  .strict();
const createAdminUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    id: z.string().trim().min(1).max(160),
    password: z.string().min(12).max(256),
    role: adminRoleSchema,
  })
  .strict();
const updateAdminUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    password: z.string().min(12).max(256).optional(),
    role: adminRoleSchema.optional(),
    status: adminUserStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one user field is required.');
const publicationStatusSchema = z.enum(['failed', 'queued', 'running', 'succeeded']);
const qualityEvaluationModeSchema = z.enum(['deterministic', 'provider_retrieval', 'provider']);
const qualityEvaluationJobStatusSchema = z.enum(['failed', 'queued', 'running', 'succeeded']);
const requestQualityEvaluationSchema = z
  .object({
    mode: qualityEvaluationModeSchema,
    withJudge: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.withJudge === true && value.mode !== 'provider') {
      context.addIssue({
        code: 'custom',
        message: 'Judge evaluation is available only for full Agent evaluation.',
        path: ['withJudge'],
      });
    }
  });
const telegramGroupStatusSchema = z.enum(['active', 'kicked', 'left', 'unknown']);
const telegramMessageProcessingStatusSchema = z.enum(['all', 'processed', 'unprocessed']);
const graphEntityTypeSchema = z.enum(['chain', 'feature', 'launchpad', 'plan', 'product']);
const graphRelationStatusSchema = z.enum(['approved', 'rejected']);
const supportTicketStatusSchema = z.enum([
  'open',
  'in_progress',
  'waiting_user',
  'resolved',
  'closed',
]);
const supportTicketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const updateSupportTicketSchema = z
  .object({
    assignedTo: z.string().trim().min(1).max(200).nullable().optional(),
    priority: supportTicketPrioritySchema.optional(),
    resolution: z.string().trim().min(1).max(8_000).optional(),
    status: supportTicketStatusSchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one support ticket field must be provided.',
  });
const supportReplySchema = z
  .object({
    content: z.string().trim().min(1).max(16_000),
  })
  .strict();
const telegramSourceRetractionSchema = z
  .object({
    messageId: z.string().trim().min(1).max(160),
    sourceChatId: z.string().trim().min(1).max(160),
  })
  .strict();

const reviseCandidateSchema = z
  .object({
    canonicalAnswer: z.string().trim().min(1).max(20_000).optional(),
    evidence: z.string().trim().min(1).max(20_000).optional(),
    proposedModule: z.string().trim().min(1).max(120).optional(),
    proposedTitle: z.string().trim().min(1).max(160).optional(),
    question: z.string().trim().min(1).max(2_000).optional(),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one revision field is required.');

const approveCandidateSchema = z
  .object({
    effectiveAt: z.iso.datetime({ offset: true }),
    note: z.string().trim().max(2_000).optional(),
    sourceUrl: z.url().startsWith('https://').optional(),
    supersedes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(500)
          .regex(/^[A-Za-z0-9_.:/-]+$/u),
      )
      .max(100)
      .optional(),
  })
  .strict();

const rejectCandidateSchema = z
  .object({
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

const trustAuthorSchema = z
  .object({
    chatId: z.string().trim().min(1).max(160),
    role: z.enum(['administrator', 'knowledge_editor', 'owner']),
    userId: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9_:@.-]+$/u),
    validFrom: z.iso.datetime({ offset: true }),
    validTo: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.validTo === undefined || Date.parse(value.validTo) > Date.parse(value.validFrom),
    { message: 'validTo must be later than validFrom.', path: ['validTo'] },
  );

const importTelegramSchema = z
  .object({
    curationMode: z.enum(['auto', 'deterministic', 'required']).optional(),
    rawExport: z.unknown().refine((value) => value !== undefined, 'rawExport is required.'),
    useAgent: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.curationMode === undefined || value.useAgent === undefined,
    'Specify curationMode or legacy useAgent, not both.',
  )
  .transform((value) => ({
    curationMode:
      value.curationMode ??
      (value.useAgent === undefined ? 'auto' : value.useAgent ? 'required' : 'deterministic'),
    rawExport: value.rawExport,
  }));

export function isKnowledgeAdminApiPath(pathname: string): boolean {
  return pathname === '/admin/api' || pathname.startsWith('/admin/api/');
}

export async function handleKnowledgeAdminApi(
  options: HandleKnowledgeAdminApiOptions,
): Promise<void> {
  setAdminSecurityHeaders(options.response);
  try {
    const services = await options.getServices();
    const segments = parseAdminPathSegments(options.requestUrl.pathname);
    const method = options.request.method ?? 'GET';
    if (segments[0] === 'auth' && segments[1] === 'setup-status' && segments.length === 2) {
      requireMethod(method, 'GET');
      sendJson(options.response, 200, {
        setupRequired: !(await services.adminUsers.hasUsers()),
      });
      return;
    }
    if (segments[0] === 'auth' && segments[1] === 'setup' && segments.length === 2) {
      requireMethod(method, 'POST');
      if (await services.adminUsers.hasUsers()) {
        sendJson(options.response, 409, {
          error: 'knowledge_admin_setup_complete',
          message: 'Initial administrator setup is already complete.',
        });
        return;
      }
      const payload = initialAdminSetupSchema.parse(
        await readJsonBody(options.request, options.maxBodyBytes),
      );
      try {
        await services.adminUsers.createInitialAdmin(payload);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Initial administrator setup is already complete.'
        ) {
          sendJson(options.response, 409, {
            error: 'knowledge_admin_setup_complete',
            message: error.message,
          });
          return;
        }
        throw error;
      }
      const session = await services.adminUsers.login({
        id: payload.id,
        password: payload.password,
      });
      if (session === undefined) {
        throw new Error('Initial administrator was created but login failed.');
      }
      sendAdminSession(options.response, session);
      return;
    }
    if (segments[0] === 'auth' && segments[1] === 'login' && segments.length === 2) {
      requireMethod(method, 'POST');
      if (!(await services.adminUsers.hasUsers())) {
        sendJson(options.response, 503, {
          error: 'knowledge_admin_setup_required',
          message: 'Create the first database administrator from the administration page.',
        });
        return;
      }
      const payload = adminLoginSchema.parse(
        await readJsonBody(options.request, options.maxBodyBytes),
      );
      const session = await services.adminUsers.login(payload);
      if (session === undefined) {
        sendJson(options.response, 401, {
          error: 'invalid_credentials',
          message: 'Administrator id or password is incorrect.',
        });
        return;
      }
      sendAdminSession(options.response, session);
      return;
    }

    const sessionToken = readKnowledgeAdminBearerToken(
      headerValue(options.request.headers.authorization),
    );
    const principal =
      sessionToken === undefined
        ? undefined
        : await services.adminUsers.authenticateSession(sessionToken);
    if (principal === undefined || sessionToken === undefined) {
      options.response.setHeader('WWW-Authenticate', 'Bearer realm="xxyy-knowledge-admin"');
      sendJson(options.response, 401, {
        error: 'unauthorized',
        message: 'A valid database administrator session is required.',
      });
      return;
    }
    if (segments[0] === 'auth' && segments[1] === 'logout' && segments.length === 2) {
      requireMethod(method, 'POST');
      await services.adminUsers.logout(sessionToken);
      sendJson(options.response, 200, { loggedOut: true });
      return;
    }
    if (segments[0] === 'auth' && segments[1] === 'change-password' && segments.length === 2) {
      requireMethod(method, 'POST');
      const payload = changeOwnPasswordSchema.parse(
        await readJsonBody(options.request, options.maxBodyBytes),
      );
      const changed = await services.adminUsers.changeOwnPassword({
        currentPassword: payload.currentPassword,
        currentSessionToken: sessionToken,
        id: principal.id,
        newPassword: payload.newPassword,
      });
      if (!changed) {
        sendJson(options.response, 401, {
          error: 'invalid_current_password',
          message: 'The current administrator password is incorrect.',
        });
        return;
      }
      sendJson(options.response, 200, {
        changed: true,
        message: 'Password changed. Other sessions for this account were revoked.',
      });
      return;
    }
    await routeKnowledgeAdminRequest(options, services, principal);
  } catch (error) {
    sendKnowledgeAdminError(options.response, error);
  }
}

function sendAdminSession(
  response: ApiResponseLike,
  session: {
    expiresAt: string;
    principal: KnowledgeAdminPrincipal;
    token: string;
  },
): void {
  sendJson(response, 200, {
    expiresAt: session.expiresAt,
    permissions: knowledgeAdminPermissions(session.principal),
    principal: session.principal,
    sessionToken: session.token,
  });
}

async function routeKnowledgeAdminRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
): Promise<void> {
  const segments = parseAdminPathSegments(options.requestUrl.pathname);
  const method = options.request.method ?? 'GET';

  if (method === 'GET' && segments.length === 1 && segments[0] === 'me') {
    sendJson(options.response, 200, {
      principal,
      permissions: knowledgeAdminPermissions(principal),
    });
    return;
  }

  if (segments[0] === 'candidates') {
    await routeCandidateRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'publications') {
    await routePublicationRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'knowledge-graph') {
    await routeKnowledgeGraphRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'quality') {
    await routeQualityEvaluationRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'support') {
    await routeSupportRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'observability') {
    await routeObservabilityRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'trusted-authors') {
    await routeTrustedAuthorRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'telegram-groups') {
    requirePermission(principal, 'telegram_group:read');
    if (segments.length === 1) {
      requireMethod(method, 'GET');
      const statusValue = options.requestUrl.searchParams.get('status') ?? undefined;
      const membershipStatus =
        statusValue === undefined ? undefined : telegramGroupStatusSchema.parse(statusValue);
      const groups = await services.telegramGroups.list({
        limit: parseLimit(options.requestUrl.searchParams.get('limit')),
        ...(membershipStatus === undefined ? {} : { membershipStatus }),
      });
      const withCurationStatus = await Promise.all(
        groups.map(async (group) => {
          const [curationJob, unprocessedMessageCount] = await Promise.all([
            services.telegramCurationJobs.get(group.chatId),
            services.telegramMessages.countUnprocessed(group.chatId),
          ]);
          return {
            ...group,
            ...(curationJob === undefined ? {} : { curationJob }),
            unprocessedMessageCount,
          };
        }),
      );
      sendJson(options.response, 200, { groups: withCurationStatus });
      return;
    }
    const chatId = requiredPathSegment(segments[1], 'Telegram chat id');
    if (segments.length === 3 && segments[2] === 'messages') {
      requireMethod(method, 'GET');
      const status = telegramMessageProcessingStatusSchema.parse(
        options.requestUrl.searchParams.get('status') ?? 'unprocessed',
      );
      const messages = await services.telegramMessages.list({
        chatId,
        limit: parseLimit(options.requestUrl.searchParams.get('limit')),
        processingStatus: status,
      });
      sendJson(options.response, 200, { messages });
      return;
    }
    if (segments.length === 3 && (segments[2] === 'process' || segments[2] === 'reprocess')) {
      requirePermission(principal, 'import:telegram');
      requireMethod(method, 'POST');
      sendJson(
        options.response,
        200,
        await services.processTelegramInbox({
          chatId,
          ...(segments[2] === 'reprocess' ? { reprocess: true } : {}),
        }),
      );
      return;
    }
    sendNotFound(options.response);
    return;
  }

  if (segments[0] === 'users') {
    await routeAdminUserRequest(options, services, principal, method, segments.slice(1));
    return;
  }

  if (segments[0] === 'imports' && segments[1] === 'telegram' && segments.length === 2) {
    requirePermission(principal, 'import:telegram');
    requireMethod(method, 'POST');
    const payload = importTelegramSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const result = await services.importTelegram(payload);
    sendJson(options.response, 201, result);
    return;
  }

  sendNotFound(options.response);
}

async function routeAdminUserRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'user:manage');
  if (segments.length === 0 && method === 'GET') {
    sendJson(options.response, 200, { users: await services.adminUsers.listUsers() });
    return;
  }
  if (segments.length === 0 && method === 'POST') {
    const payload = createAdminUserSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const user = await services.adminUsers.createUser({
      actor: adminActor(principal),
      displayName: payload.displayName,
      id: payload.id,
      password: payload.password,
      role: payload.role as KnowledgeAdminRole,
    });
    sendJson(options.response, 201, { user });
    return;
  }
  if (segments.length === 1 && method === 'PATCH') {
    const payload = updateAdminUserSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const targetId = requiredPathSegment(segments[0], 'administrator user id');
    if (
      targetId === principal.id &&
      (payload.password !== undefined || payload.role !== undefined || payload.status !== undefined)
    ) {
      sendJson(options.response, 400, {
        error: 'self_account_protection',
        message:
          'Use My Account to change your password. Your own role or status must be changed by another administrator.',
      });
      return;
    }
    const user = await services.adminUsers.updateUser({
      actor: adminActor(principal),
      id: targetId,
      ...(payload.displayName === undefined ? {} : { displayName: payload.displayName }),
      ...(payload.password === undefined ? {} : { password: payload.password }),
      ...(payload.role === undefined ? {} : { role: payload.role as KnowledgeAdminRole }),
      ...(payload.status === undefined
        ? {}
        : { status: payload.status as KnowledgeAdminUserStatus }),
    });
    sendJson(options.response, 200, { user });
    return;
  }

  sendNotFound(options.response);
}

async function routeCandidateRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'candidate:read');
  if (segments.length === 0) {
    requireMethod(method, 'GET');
    const statusValue = options.requestUrl.searchParams.get('status') ?? undefined;
    const status = statusValue === undefined ? undefined : candidateStatusSchema.parse(statusValue);
    const candidates = await services.governance.listCandidates({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(status === undefined ? {} : { status }),
    });
    sendJson(options.response, 200, { candidates });
    return;
  }

  const candidateId = requiredPathSegment(segments[0], 'candidate id');
  if (segments.length === 1 && method === 'GET') {
    const detail = await services.governance.getCandidateDetail(candidateId);
    if (detail === undefined) {
      sendNotFound(options.response, 'Knowledge candidate was not found.');
      return;
    }
    const publications = await services.publicationJobs.list({ candidateId, limit: 20 });
    const graphPreview = extractKnowledgeGraphRelations({
      text: [detail.candidate.canonicalAnswer, detail.candidate.evidence ?? ''].join('\n'),
      ...(detail.candidate.proposedTitle === undefined
        ? {}
        : { title: detail.candidate.proposedTitle }),
    });
    sendJson(options.response, 200, { ...detail, graphPreview, publications });
    return;
  }

  if (segments.length === 1 && method === 'PATCH') {
    requirePermission(principal, 'candidate:review');
    const payload = reviseCandidateSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const candidate = await services.governance.revise({
      editedBy: adminActor(principal),
      id: candidateId,
      ...(payload.canonicalAnswer === undefined
        ? {}
        : { canonicalAnswer: payload.canonicalAnswer }),
      ...(payload.evidence === undefined ? {} : { evidence: payload.evidence }),
      ...(payload.proposedModule === undefined ? {} : { proposedModule: payload.proposedModule }),
      ...(payload.proposedTitle === undefined ? {} : { proposedTitle: payload.proposedTitle }),
      ...(payload.question === undefined ? {} : { question: payload.question }),
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    });
    sendJson(options.response, 200, { candidate });
    return;
  }

  if (segments.length === 2 && segments[1] === 'suggestion') {
    requirePermission(principal, 'candidate:review');
    requireMethod(method, 'POST');
    const payload = candidateSuggestionSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const suggestion = await services.suggestCandidate({
      canonicalAnswer: payload.canonicalAnswer,
      id: candidateId,
      question: payload.question,
    });
    if (suggestion === undefined) {
      sendNotFound(options.response, 'Knowledge candidate was not found.');
      return;
    }
    sendJson(options.response, 200, { suggestion });
    return;
  }

  if (segments.length === 2 && segments[1] === 'approve') {
    requirePermission(principal, 'candidate:review');
    requireMethod(method, 'POST');
    const payload = approveCandidateSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const candidate = await services.governance.approve({
      effectiveAt: payload.effectiveAt,
      id: candidateId,
      reviewedBy: adminActor(principal),
      ...(payload.note === undefined ? {} : { note: payload.note }),
      ...(payload.sourceUrl === undefined ? {} : { sourceUrl: payload.sourceUrl }),
      ...(payload.supersedes === undefined ? {} : { supersedes: payload.supersedes }),
    });
    const publication = await services.publicationJobs.request({
      candidateId: candidate.id,
      requestedBy: adminActor(principal),
    });
    sendJson(options.response, 200, { candidate, publication });
    return;
  }

  if (segments.length === 2 && segments[1] === 'reject') {
    requirePermission(principal, 'candidate:review');
    requireMethod(method, 'POST');
    const payload = rejectCandidateSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const candidate = await services.governance.reject({
      id: candidateId,
      reviewedBy: adminActor(principal),
      ...(payload.note === undefined ? {} : { note: payload.note }),
    });
    sendJson(options.response, 200, { candidate });
    return;
  }

  if (segments.length === 2 && segments[1] === 'publication') {
    requirePermission(principal, 'publication:request');
    requireMethod(method, 'POST');
    const publication = await services.publicationJobs.request({
      candidateId,
      requestedBy: adminActor(principal),
    });
    sendJson(options.response, 202, { publication });
    return;
  }

  sendNotFound(options.response);
}

async function routeKnowledgeGraphRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'candidate:read');
  if (segments.length === 1 && segments[0] === 'entities') {
    requireMethod(method, 'GET');
    const typeValue = options.requestUrl.searchParams.get('type') ?? undefined;
    const type = typeValue === undefined ? undefined : graphEntityTypeSchema.parse(typeValue);
    const query = options.requestUrl.searchParams.get('query')?.trim();
    const entities = await services.knowledgeGraph.listEntities({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(type === undefined ? {} : { type }),
      ...(query === undefined || query.length === 0 ? {} : { query }),
    });
    sendJson(options.response, 200, { entities });
    return;
  }
  if (segments.length === 1 && segments[0] === 'relations') {
    requireMethod(method, 'GET');
    const statusValue = options.requestUrl.searchParams.get('status') ?? undefined;
    const status =
      statusValue === undefined ? undefined : graphRelationStatusSchema.parse(statusValue);
    const relations = await services.knowledgeGraph.listRelations({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(status === undefined ? {} : { status }),
    });
    sendJson(options.response, 200, { relations });
    return;
  }
  if (segments.length === 1 && segments[0] === 'conflicts') {
    requireMethod(method, 'GET');
    const conflicts = await services.knowledgeGraph.listConflicts({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
    });
    sendJson(options.response, 200, { conflicts });
    return;
  }
  if (segments.length === 2 && segments[0] === 'relations') {
    requirePermission(principal, 'candidate:review');
    requireMethod(method, 'PATCH');
    const payload = z
      .object({ status: graphRelationStatusSchema })
      .strict()
      .parse(await readJsonBody(options.request, options.maxBodyBytes));
    const relation = await services.knowledgeGraph.setRelationStatus({
      id: requiredPathSegment(segments[1], 'knowledge graph relation id'),
      status: payload.status,
    });
    sendJson(options.response, 200, { relation });
    return;
  }
  sendNotFound(options.response);
}

async function routePublicationRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'candidate:read');
  if (segments.length === 0) {
    requireMethod(method, 'GET');
    const statusValue = options.requestUrl.searchParams.get('status') ?? undefined;
    const status: KnowledgePublicationJobStatus | undefined =
      statusValue === undefined ? undefined : publicationStatusSchema.parse(statusValue);
    const publications = await services.publicationJobs.list({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(status === undefined ? {} : { status }),
    });
    sendJson(options.response, 200, { publications });
    return;
  }

  if (segments.length === 2 && segments[1] === 'retry') {
    requirePermission(principal, 'publication:request');
    requireMethod(method, 'POST');
    const publication = await services.publicationJobs.retry({
      id: requiredPathSegment(segments[0], 'publication job id'),
      requestedBy: adminActor(principal),
    });
    sendJson(options.response, 202, { publication });
    return;
  }

  sendNotFound(options.response);
}

async function routeQualityEvaluationRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'quality:read');
  if (segments.length === 1 && segments[0] === 'overview') {
    requireMethod(method, 'GET');
    const [jobs, reports] = await Promise.all([
      services.qualityEvaluations.listJobs({ limit: 50 }),
      services.qualityEvaluations.listReports({ limit: 50 }),
    ]);
    sendJson(options.response, 200, { jobs, reports });
    return;
  }
  if (segments.length === 1 && segments[0] === 'jobs') {
    if (method === 'GET') {
      const statusValue = options.requestUrl.searchParams.get('status') ?? undefined;
      const status =
        statusValue === undefined ? undefined : qualityEvaluationJobStatusSchema.parse(statusValue);
      const jobs = await services.qualityEvaluations.listJobs({
        limit: parseLimit(options.requestUrl.searchParams.get('limit')),
        ...(status === undefined ? {} : { status }),
      });
      sendJson(options.response, 200, { jobs });
      return;
    }
    requirePermission(principal, 'quality:run');
    requireMethod(method, 'POST');
    const payload = requestQualityEvaluationSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const job = await services.qualityEvaluations.request({
      mode: payload.mode,
      requestedBy: adminActor(principal),
      ...(payload.withJudge === undefined ? {} : { withJudge: payload.withJudge }),
    });
    sendJson(options.response, 202, { job });
    return;
  }
  if (segments.length === 1 && segments[0] === 'reports') {
    requireMethod(method, 'GET');
    const modeValue = options.requestUrl.searchParams.get('mode') ?? undefined;
    const mode = modeValue === undefined ? undefined : qualityEvaluationModeSchema.parse(modeValue);
    const reports = await services.qualityEvaluations.listReports({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(mode === undefined ? {} : { mode }),
    });
    sendJson(options.response, 200, { reports });
    return;
  }
  if (segments.length === 2 && segments[0] === 'reports') {
    requireMethod(method, 'GET');
    const report = await services.qualityEvaluations.getReport(
      requiredPathSegment(segments[1], 'quality evaluation report id'),
    );
    if (report === undefined) {
      sendNotFound(options.response, 'Quality evaluation report was not found.');
      return;
    }
    sendJson(options.response, 200, { report });
    return;
  }
  if (segments.length === 3 && segments[0] === 'reports' && segments[2] === 'baseline') {
    requirePermission(principal, 'quality:baseline');
    requireMethod(method, 'POST');
    const report = await services.qualityEvaluations.approveBaseline({
      actor: adminActor(principal),
      reportId: requiredPathSegment(segments[1], 'quality evaluation report id'),
    });
    sendJson(options.response, 200, { report });
    return;
  }
  sendNotFound(options.response);
}

async function routeTrustedAuthorRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  if (segments.length !== 0) {
    sendNotFound(options.response);
    return;
  }
  requirePermission(principal, 'candidate:read');
  if (method === 'GET') {
    const chatId = options.requestUrl.searchParams.get('chatId')?.trim();
    const activeAt = options.requestUrl.searchParams.get('activeAt')?.trim();
    const authors = await services.governance.listTrustedAuthors({
      limit: parseLimit(options.requestUrl.searchParams.get('limit')),
      ...(chatId === undefined || chatId.length === 0 ? {} : { chatId }),
      ...(activeAt === undefined || activeAt.length === 0 ? {} : { activeAt }),
    });
    sendJson(options.response, 200, { authors });
    return;
  }
  requirePermission(principal, 'trusted_author:manage');
  requireMethod(method, 'POST');
  const payload = trustAuthorSchema.parse(
    await readJsonBody(options.request, options.maxBodyBytes),
  );
  const author = await services.governance.trustAuthor({
    chatId: payload.chatId,
    role: payload.role,
    userId: payload.userId,
    validFrom: payload.validFrom,
    verificationSource: 'manual',
    verifiedBy: adminActor(principal),
    ...(payload.validTo === undefined ? {} : { validTo: payload.validTo }),
  });
  sendJson(options.response, 201, { author });
}

function knowledgeAdminPermissions(principal: KnowledgeAdminPrincipal): KnowledgeAdminPermission[] {
  const permissions: KnowledgeAdminPermission[] = [
    'candidate:read',
    'candidate:review',
    'import:telegram',
    'publication:request',
    'quality:baseline',
    'quality:read',
    'quality:run',
    'observability:read',
    'support:manage',
    'support:read',
    'telegram_group:read',
    'trusted_author:manage',
    'user:manage',
  ];
  return permissions.filter((permission) => hasKnowledgeAdminPermission(principal, permission));
}

async function routeSupportRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'support:read');
  if (method === 'GET' && segments.length === 1 && segments[0] === 'metrics') {
    sendJson(options.response, 200, {
      metrics: await services.supportOperations.getMetrics(),
    });
    return;
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'knowledge-gaps') {
    const feedback = await services.feedback.getFeedbackStats({ limit: 100 });
    const gaps = feedback.latest
      .filter((record) => record.rating === 'negative' || record.citationCount === 0)
      .map((record) => ({
        ...record,
        diagnosis: diagnoseQualityIssue(record),
        quality: createQualityDiagnosticSnapshot(record),
      }));
    sendJson(options.response, 200, {
      gaps,
      metrics: {
        negativeCount: feedback.negativeCount,
        positiveCount: feedback.positiveCount,
        totalCount: feedback.totalCount,
      },
      trend: summarizeQualityTrend(gaps),
    });
    return;
  }
  if (segments[0] === 'tickets') {
    if (segments.length === 1) {
      requireMethod(method, 'GET');
      const rawStatus = options.requestUrl.searchParams.get('status');
      const status =
        rawStatus === null
          ? undefined
          : (supportTicketStatusSchema.parse(rawStatus) as SupportTicketStatus);
      const assignee = options.requestUrl.searchParams.get('assignee') ?? undefined;
      const tickets = await services.supportOperations.listTickets({
        limit: parseLimit(options.requestUrl.searchParams.get('limit')),
        ...(status === undefined ? {} : { status }),
        ...(assignee === undefined ? {} : { assignee }),
      });
      sendJson(options.response, 200, { tickets });
      return;
    }
    const ticketId = requiredPathSegment(segments[1], 'support ticket id');
    if (segments.length === 2 && method === 'GET') {
      const ticket = await services.supportOperations.getTicket(ticketId);
      if (ticket === undefined) {
        sendNotFound(options.response, 'Support ticket was not found.');
        return;
      }
      sendJson(options.response, 200, { ticket });
      return;
    }
    if (segments.length === 2 && method === 'PATCH') {
      requirePermission(principal, 'support:manage');
      const payload = updateSupportTicketSchema.parse(
        await readJsonBody(options.request, options.maxBodyBytes),
      );
      const ticket = await services.supportOperations.updateTicket({
        actor: adminActor(principal),
        id: ticketId,
        ...(payload.assignedTo === undefined ? {} : { assignedTo: payload.assignedTo }),
        ...(payload.priority === undefined
          ? {}
          : { priority: payload.priority as SupportTicketPriority }),
        ...(payload.resolution === undefined ? {} : { resolution: payload.resolution }),
        ...(payload.status === undefined ? {} : { status: payload.status as SupportTicketStatus }),
      });
      sendJson(options.response, 200, { ticket });
      return;
    }
  }
  if (segments[0] === 'telegram-sources' && segments[1] === 'retract' && segments.length === 2) {
    requirePermission(principal, 'candidate:review');
    requireMethod(method, 'POST');
    const payload = telegramSourceRetractionSchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const result = await services.governance.retractTelegramSource({
      actor: adminActor(principal),
      messageId: payload.messageId,
      reason: 'source_deleted',
      sourceChatId: payload.sourceChatId,
    });
    sendJson(options.response, 200, result);
    return;
  }
  if (segments[0] === 'conversations' && segments.length === 3 && segments[2] === 'messages') {
    const conversationId = requiredPathSegment(segments[1], 'support conversation id');
    const conversation = await services.supportOperations.getConversation(conversationId);
    if (conversation === undefined) {
      sendNotFound(options.response, 'Support conversation was not found.');
      return;
    }
    if (method === 'GET') {
      const messages = await services.supportOperations.getRecentMessages(conversationId, {
        limit: Math.min(parseLimit(options.requestUrl.searchParams.get('limit')), 50),
      });
      sendJson(options.response, 200, { conversation, messages });
      return;
    }
    requirePermission(principal, 'support:manage');
    requireMethod(method, 'POST');
    const payload = supportReplySchema.parse(
      await readJsonBody(options.request, options.maxBodyBytes),
    );
    const message = await services.supportOperations.appendMessage({
      content: payload.content,
      conversationId,
      role: 'support_agent',
      requestId: `admin:${principal.id}`,
    });
    sendJson(options.response, 201, { message });
    return;
  }
  sendNotFound(options.response);
}

async function routeObservabilityRequest(
  options: HandleKnowledgeAdminApiOptions,
  services: KnowledgeAdminServices,
  principal: KnowledgeAdminPrincipal,
  method: string,
  segments: string[],
): Promise<void> {
  requirePermission(principal, 'observability:read');
  requireMethod(method, 'GET');
  const from = parseOptionalObservedDate(options.requestUrl.searchParams.get('from'));
  const to = parseOptionalObservedDate(options.requestUrl.searchParams.get('to'));
  if (segments.length === 1 && segments[0] === 'summary') {
    const summary = await services.apiObservability.getSummary({
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
    const denominator = Math.max(1, summary.requestCount);
    sendJson(options.response, 200, {
      alerts: [
        {
          active:
            summary.rateLimitedCount / denominator >=
            services.observabilityThresholds.rateLimitedRatio,
          code: 'rate_limited_ratio',
          threshold: services.observabilityThresholds.rateLimitedRatio,
          value: summary.rateLimitedCount / denominator,
        },
        {
          active:
            summary.serverErrorCount / denominator >=
            services.observabilityThresholds.serverErrorRatio,
          code: 'server_error_ratio',
          threshold: services.observabilityThresholds.serverErrorRatio,
          value: summary.serverErrorCount / denominator,
        },
        {
          active: summary.estimatedCostUsd >= services.observabilityThresholds.costUsd,
          code: 'estimated_cost_usd',
          threshold: services.observabilityThresholds.costUsd,
          value: summary.estimatedCostUsd,
        },
      ],
      summary,
    });
    return;
  }
  if (segments.length === 1 && segments[0] === 'requests') {
    const apiKeyId = parseOptionalObservedText(
      options.requestUrl.searchParams.get('apiKeyId'),
      160,
    );
    const channel = parseOptionalObservedChannel(options.requestUrl.searchParams.get('channel'));
    const path = parseOptionalObservedText(options.requestUrl.searchParams.get('path'), 512);
    const statusCode = parseOptionalObservedStatus(
      options.requestUrl.searchParams.get('statusCode'),
    );
    sendJson(options.response, 200, {
      requests: await services.apiObservability.list({
        ...(apiKeyId === undefined ? {} : { apiKeyId }),
        ...(channel === undefined ? {} : { channel }),
        ...(from === undefined ? {} : { from }),
        limit: parseLimit(options.requestUrl.searchParams.get('limit')),
        ...(path === undefined ? {} : { path }),
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(to === undefined ? {} : { to }),
      }),
    });
    return;
  }
  if (segments.length === 1 && segments[0] === 'prometheus') {
    const body = renderPrometheusApiMetrics(
      await services.apiObservability.getSummary({
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      }),
    );
    options.response.statusCode = 200;
    options.response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    options.response.end(body);
    return;
  }
  sendNotFound(options.response);
}

function parseOptionalObservedChannel(
  value: string | null,
): 'cli' | 'telegram' | 'web' | undefined {
  return value === null ? undefined : z.enum(['cli', 'telegram', 'web']).parse(value);
}

function parseOptionalObservedDate(value: string | null): string | undefined {
  return value === null ? undefined : z.iso.datetime({ offset: true }).parse(value);
}

function parseOptionalObservedStatus(value: string | null): number | undefined {
  return value === null ? undefined : z.coerce.number().int().min(100).max(599).parse(value);
}

function parseOptionalObservedText(value: string | null, max: number): string | undefined {
  return value === null ? undefined : z.string().trim().min(1).max(max).parse(value);
}

function createQualityDiagnosticSnapshot(record: FeedbackRecord) {
  const classification = classifyQuestion(record.question);
  const understanding = understandProductQuestion(record.question, classification);
  const queryPlan = createProductQueryPlan(record.question, record.question, understanding);
  const retrievalPolicy = createProductRetrievalPolicy(understanding);
  return {
    evidence: {
      answerStatus: record.answerStatus ?? answerStatusFromFeedback(record),
      citationCount: record.citationCount,
      conflictCount: record.comment === 'automatic_evidence_conflict' ? 1 : 0,
      coverageState:
        record.comment === 'automatic_partial_answer'
          ? 'partial'
          : record.comment === 'automatic_low_evidence' || record.citationCount === 0
            ? 'none'
            : 'unknown',
      observedSourceTypes: record.sourceTypes ?? [],
      sourceObservation: record.sourceTypes === undefined ? 'unavailable' : 'available',
      stopReason:
        record.comment === 'automatic_evidence_conflict'
          ? 'evidence_conflict'
          : record.comment === 'automatic_partial_answer'
            ? 'partial_answer'
            : record.comment === 'automatic_low_evidence' || record.citationCount === 0
              ? 'insufficient_evidence'
              : 'answer_completed',
    },
    queryPlan: {
      maxSearches: queryPlan.maxSearches,
      queries: queryPlan.queries,
      requiredFacets: queryPlan.requiredFacets,
      strategy: queryPlan.strategy,
      subquestions: queryPlan.subquestions,
      version: queryPlan.version,
    },
    retrievalPolicy,
    understanding: {
      ambiguity: understanding.ambiguity,
      confidence: understanding.confidence,
      kind: understanding.kind,
      subject: understanding.subject,
      temporalScope: understanding.temporalScope,
      version: understanding.version,
    },
    version: '1' as const,
  };
}

function answerStatusFromFeedback(
  record: FeedbackRecord,
): 'complete' | 'conflict' | 'insufficient' | 'partial' {
  if (record.comment === 'automatic_evidence_conflict') {
    return 'conflict';
  }
  if (record.comment === 'automatic_partial_answer') {
    return 'partial';
  }
  if (record.comment === 'automatic_low_evidence' || record.citationCount === 0) {
    return 'insufficient';
  }
  return 'complete';
}

function summarizeQualityTrend(
  gaps: Array<{
    createdAt: string;
    diagnosis: ReturnType<typeof diagnoseQualityIssue>;
    quality: ReturnType<typeof createQualityDiagnosticSnapshot>;
  }>,
) {
  const categoryCounts = {
    boundary: 0,
    classification: 0,
    generation: 0,
    knowledge: 0,
    retrieval: 0,
  };
  const answerStatusCounts = {
    complete: 0,
    conflict: 0,
    insufficient: 0,
    partial: 0,
  };
  for (const gap of gaps) {
    categoryCounts[gap.diagnosis.category] += 1;
    answerStatusCounts[gap.quality.evidence.answerStatus] += 1;
  }
  const timestamps = gaps
    .map((gap) => Date.parse(gap.createdAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    answerStatusCounts,
    categoryCounts,
    ...(timestamps.length === 0
      ? {}
      : {
          newestAt: new Date(timestamps.at(-1) as number).toISOString(),
          oldestAt: new Date(timestamps[0] as number).toISOString(),
        }),
    sampleSize: gaps.length,
    version: '1' as const,
  };
}

function diagnoseQualityIssue(record: FeedbackRecord): {
  category: 'boundary' | 'classification' | 'generation' | 'knowledge' | 'retrieval';
  knowledgeCandidateEligible: false;
  reason: string;
  recommendedAction: string;
} {
  if (record.failureReason === 'context_misunderstood' || record.failureReason === 'off_topic') {
    return {
      category: 'classification',
      knowledgeCandidateEligible: false,
      reason: '用户反馈指出回答误解上下文或偏离问题',
      recommendedAction: '检查多轮改写、意图识别与子问题拆解，并加入脱敏评测样本',
    };
  }
  if (record.failureReason === 'knowledge_missing' || record.failureReason === 'outdated') {
    return {
      category: 'knowledge',
      knowledgeCandidateEligible: false,
      reason:
        record.failureReason === 'outdated' ? '用户反馈指出知识可能过时' : '用户反馈指出知识缺失',
      recommendedAction: '核对正式来源和有效时间；确认后创建或修订知识候选并运行回归评测',
    };
  }
  if (record.failureReason === 'knowledge_conflict') {
    return {
      category: 'knowledge',
      knowledgeCandidateEligible: false,
      reason: '同范围当前证据存在冲突',
      recommendedAction: '先核对正式来源、有效时间和 supersedes，再决定是否修订知识',
    };
  }
  if (record.failureReason === 'incomplete') {
    return {
      category: 'retrieval',
      knowledgeCandidateEligible: false,
      reason: '用户反馈指出回答未完整覆盖问题',
      recommendedAction: '检查子问题证据矩阵、缺失 facet 的召回和逐项回答校验',
    };
  }
  if (
    record.failureReason === 'incorrect' ||
    record.failureReason === 'incorrect_steps' ||
    record.failureReason === 'unsupported_citation'
  ) {
    return {
      category: 'generation',
      knowledgeCandidateEligible: false,
      reason: '用户反馈指出事实、步骤或引用支撑存在问题',
      recommendedAction: '检查事实选择、操作顺序和逐结论引用，再补充对应回归样本',
    };
  }
  if (record.comment === 'automatic_evidence_conflict') {
    return {
      category: 'knowledge',
      knowledgeCandidateEligible: false,
      reason: '同范围当前证据存在冲突',
      recommendedAction: '先核对正式来源、有效时间和 supersedes，再决定是否修订知识',
    };
  }
  if (record.comment === 'automatic_partial_answer') {
    return {
      category: 'retrieval',
      knowledgeCandidateEligible: false,
      reason: '检索达到停止条件但只覆盖部分条件',
      recommendedAction: '检查缺失 facet 的 Query、召回和来源覆盖，再判断是否为知识缺口',
    };
  }
  if (record.comment === 'automatic_low_evidence' || record.citationCount === 0) {
    return {
      category: 'retrieval',
      knowledgeCandidateEligible: false,
      reason: '产品回答没有可引用证据',
      recommendedAction: '先检查分类与检索；确认正式来源确实缺失后才能创建知识候选',
    };
  }
  if (
    record.intent === 'investment_advice' ||
    record.intent === 'realtime_account_query' ||
    record.intent === 'unknown'
  ) {
    return {
      category: 'boundary',
      knowledgeCandidateEligible: false,
      reason: '边界或澄清回答收到负反馈',
      recommendedAction: '检查安全边界是否正确，不要通过补知识绕过边界',
    };
  }
  if (record.comment?.includes('classification') === true) {
    return {
      category: 'classification',
      knowledgeCandidateEligible: false,
      reason: '反馈明确指向意图或主体识别',
      recommendedAction: '加入脱敏评测样本并修正分类或问题理解',
    };
  }
  return {
    category: 'generation',
    knowledgeCandidateEligible: false,
    reason: '已有引用的回答仍收到负反馈',
    recommendedAction: '检查事实选择、结构、范围和 claim grounding',
  };
}

function requirePermission(
  principal: KnowledgeAdminPrincipal,
  permission: KnowledgeAdminPermission,
): void {
  if (!hasKnowledgeAdminPermission(principal, permission)) {
    throw new KnowledgeAdminForbiddenError(permission);
  }
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new KnowledgeAdminMethodNotAllowedError(expected);
  }
}

class KnowledgeAdminForbiddenError extends Error {
  constructor(readonly permission: KnowledgeAdminPermission) {
    super(`Administrator role does not grant ${permission}.`);
    this.name = 'KnowledgeAdminForbiddenError';
  }
}

class KnowledgeAdminMethodNotAllowedError extends Error {
  constructor(readonly allowedMethod: string) {
    super(`This route only supports ${allowedMethod}.`);
    this.name = 'KnowledgeAdminMethodNotAllowedError';
  }
}

class KnowledgeAdminBodyTooLargeError extends Error {
  constructor() {
    super('Knowledge administration request body is too large.');
    this.name = 'KnowledgeAdminBodyTooLargeError';
  }
}

function parseAdminPathSegments(pathname: string): string[] {
  const suffix = pathname.slice('/admin/api'.length);
  return suffix
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function requiredPathSegment(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0 || value.length > 500) {
    throw new Error(`${field} is invalid.`);
  }
  return value.trim();
}

function parseLimit(rawValue: string | null): number {
  if (rawValue === null || rawValue.trim().length === 0) {
    return 50;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error('limit must be an integer between 1 and 500.');
  }
  return value;
}

function adminActor(principal: KnowledgeAdminPrincipal): string {
  return `admin:${principal.id}`;
}

async function readJsonBody(request: ApiRequestLike, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const rawChunk of request) {
    const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : rawChunk;
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new KnowledgeAdminBodyTooLargeError();
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('Request body must be valid JSON.', { cause: error });
  }
}

function setAdminSecurityHeaders(response: ApiResponseLike): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

function sendKnowledgeAdminError(response: ApiResponseLike, error: unknown): void {
  if (error instanceof z.ZodError) {
    sendJson(response, 400, {
      error: 'invalid_request',
      message: 'Knowledge administration request validation failed.',
      issues: error.issues.map((issue) => ({ message: issue.message, path: issue.path })),
    });
    return;
  }
  if (error instanceof KnowledgeAdminBodyTooLargeError) {
    sendJson(response, 413, { error: 'payload_too_large', message: error.message });
    return;
  }
  if (error instanceof KnowledgeAdminForbiddenError) {
    sendJson(response, 403, { error: 'forbidden', message: error.message });
    return;
  }
  if (error instanceof KnowledgeAdminMethodNotAllowedError) {
    response.setHeader('Allow', error.allowedMethod);
    sendJson(response, 405, { error: 'method_not_allowed', message: error.message });
    return;
  }
  if (
    error instanceof InvalidKnowledgeCandidateStateError ||
    error instanceof InvalidKnowledgePublicationJobStateError
  ) {
    sendJson(response, 409, { error: 'invalid_state', message: error.message });
    return;
  }
  if (error instanceof KnowledgePublicationJobNotFoundError) {
    sendJson(response, 404, { error: 'not_found', message: error.message });
    return;
  }
  if (
    error instanceof SupportConversationNotFoundError ||
    error instanceof SupportTicketNotFoundError
  ) {
    sendJson(response, 404, { error: 'not_found', message: error.message });
    return;
  }
  if (error instanceof UnverifiedTelegramKnowledgeAuthorError) {
    sendJson(response, 422, { error: 'unverified_knowledge_author', message: error.message });
    return;
  }
  if (
    error instanceof VectorStoreConfigurationError ||
    error instanceof VectorStoreUnavailableError
  ) {
    sendJson(response, 503, {
      error: 'knowledge_store_unavailable',
      message: error.message,
    });
    return;
  }
  if (isKnowledgeStoreUnavailableError(error)) {
    sendJson(response, 503, {
      error: 'knowledge_store_unavailable',
      message: 'Knowledge governance database is unavailable.',
    });
    return;
  }
  if (error instanceof URIError) {
    sendJson(response, 400, { error: 'invalid_path', message: 'Request path is invalid.' });
    return;
  }
  if (error instanceof Error && isSafeAdminInputError(error.message)) {
    sendJson(response, 400, { error: 'invalid_request', message: error.message });
    return;
  }
  sendJson(response, 500, {
    error: 'knowledge_admin_internal_error',
    message: 'Knowledge administration operation failed.',
  });
}

function isSafeAdminInputError(message: string): boolean {
  return /^(?:Request body|limit |candidate id |publication job id |Knowledge Curator Agent|Telegram export|Invalid Telegram export)/u.test(
    message,
  );
}

function isKnowledgeStoreUnavailableError(error: unknown, seen = new Set<unknown>()): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (
    code !== undefined &&
    (/^08/u.test(code) ||
      [
        '57P01',
        '57P02',
        '57P03',
        'ECONNREFUSED',
        'ECONNRESET',
        'ENOTFOUND',
        'EPIPE',
        'ETIMEDOUT',
      ].includes(code))
  ) {
    return true;
  }
  return 'cause' in error && isKnowledgeStoreUnavailableError(error.cause, seen);
}

function sendNotFound(response: ApiResponseLike, message = 'Admin route not found.'): void {
  sendJson(response, 404, { error: 'not_found', message });
}

function sendJson(response: ApiResponseLike, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
