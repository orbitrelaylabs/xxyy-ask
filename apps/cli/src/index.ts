import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCustomerAgentChatService } from '@xxyy/agent-core';
import {
  EmbeddingConfigurationError,
  createLocalHashEmbedding,
  createOpenAiEmbeddingProvider,
  loadProductDocuments,
  prepareKnowledgeChunks,
  type PreparedKnowledgeChunk,
} from '@xxyy/knowledge';
import {
  VectorStoreConfigurationError,
  VectorStoreUnavailableError,
  AnswerJudgeConfigurationError,
  aggregateRetrievalResults,
  classifyQuestion,
  createInMemoryQualityTracer,
  createKnowledgeAutomationController,
  createKnowledgeGovernanceService,
  createLazyRetriever,
  createLocalRetriever,
  createOpenAiAnswerQualityJudge,
  createOpenAiAnswerProvider,
  createOpenAiKnowledgeCuratorModel,
  createPgFeedbackStore,
  createPgKnowledgeCandidateStore,
  createPgPool,
  createPgKnowledgeMatchInspector,
  createPgKnowledgePublicationJobStore,
  createPgTrustedAuthorStore,
  createPgVectorStore,
  createChatService,
  createGroundedAnswer,
  createMetadataReranker,
  createRerankingRetriever,
  evaluateRetrievalRanking,
  evaluateCases,
  fetchTelegramCurrentAdministratorIds,
  formatEvaluationFailureJsonl,
  formatRetrievedChunksDebug,
  LlmConfigurationError,
  loadRagConfig,
  loadWorkspaceEnv,
  noopQualityTracer,
  readTelegramKnowledgeExport,
  resolveWorkspaceCwd,
} from '@xxyy/rag-core';
import type {
  AnswerProvider,
  AnswerQualityJudge,
  ChatService,
  EmbeddedKnowledgeChunk,
  EvaluationCase,
  EvaluationReport,
  EvaluationResult,
  FeedbackRecord,
  KnowledgeCandidate,
  KnowledgeCandidateHistory,
  KnowledgeCandidateStatus,
  KnowledgeAutomationRunResult,
  KnowledgeCurationMode,
  KnowledgeCuratorAgentRunStats,
  KnowledgePublicationJob,
  KnowledgeStats,
  RagEnv,
  QualityTracer,
  QualityTraceRecord,
  PgClientLike,
  ReplaceChunksOptions,
  Retriever,
  TrustedAuthor,
  TrustedAuthorRole,
  TrustedAuthorVerificationSource,
} from '@xxyy/rag-core';
import {
  knowledgeSourceCatalog,
  type ChatRequest,
  type ChatResponse,
  type RagIndex,
} from '@xxyy/shared';

export { resolveWorkspaceCwd } from '@xxyy/rag-core';

type CliEnv = RagEnv &
  Partial<
    Record<'EVAL_JUDGE_MODEL' | 'INIT_CWD' | 'TELEGRAM_API_BASE_URL' | 'TELEGRAM_BOT_TOKEN', string>
  >;

type CliCommand =
  | { command: 'ask'; debugRetrieve: boolean; question: string }
  | {
      command: 'evaluate';
      failuresOut?: string;
      judge: boolean;
      providerBacked: boolean;
      retrievalOnly: boolean;
    }
  | { command: 'feedback:backlog' }
  | { command: 'ingest'; rebuildEmbeddingSchema: boolean }
  | {
      adminUserIds: string[];
      command: 'knowledge:import:telegram';
      curationMode: KnowledgeCurationMode;
      file: string;
    }
  | {
      command: 'knowledge:list';
      limit: number;
      status?: KnowledgeCandidateStatus;
    }
  | {
      activeAt?: string;
      chatId?: string;
      command: 'knowledge:author:list';
      limit: number;
    }
  | {
      chatId: string;
      command: 'knowledge:author:trust';
      role: TrustedAuthorRole;
      userId: string;
      validFrom: string;
      verificationSource: TrustedAuthorVerificationSource;
      verifiedBy: string;
      validTo?: string;
    }
  | { command: 'knowledge:history'; id: string }
  | {
      command: 'knowledge:revise';
      editedBy: string;
      id: string;
      canonicalAnswer?: string;
      evidence?: string;
      proposedModule?: string;
      proposedTitle?: string;
      question?: string;
      reason?: string;
    }
  | {
      command: 'knowledge:approve';
      effectiveAt?: string;
      id: string;
      note?: string;
      reviewedBy: string;
      sourceUrl?: string;
      supersedes?: string[];
    }
  | {
      command: 'knowledge:reject';
      id: string;
      note?: string;
      reviewedBy: string;
    }
  | { command: 'knowledge:publish'; id: string }
  | { command: 'knowledge:automation:work'; limit: number; workerId?: string }
  | { command: 'knowledge:publication:work'; workerId?: string }
  | { command: 'migrate' }
  | { command: 'stats' }
  | { command: 'sync:x' }
  | { command: 'help'; error?: string };

interface IngestSummary {
  documentCount: number;
  chunkCount: number;
  indexPath: string;
  runId?: string;
}

interface SyncXUpdatesSummary {
  changedChunkCount: number;
  chunkCount: number;
  documentCount: number;
  indexPath: string;
  skippedChunkCount: number;
  runId?: string;
}

interface TelegramKnowledgeImportSummary {
  agentCandidateCount: number;
  agentRunStats: KnowledgeCuratorAgentRunStats;
  adminReplyCount: number;
  candidateCount: number;
  createdCount: number;
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

interface KnowledgePublicationSummary {
  alreadyPublished: boolean;
  candidateId: string;
  documentId: string;
  file: string;
  jobId: string;
  runId?: string;
}

interface KnowledgeAutomationWorkerSummary {
  automation: KnowledgeAutomationRunResult;
  publications: KnowledgePublicationSummary[];
}

interface CliIo {
  cwd: string;
  env: CliEnv;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
}

interface DefaultCliIoOptions {
  cwd?: string;
  env?: CliEnv;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
}

interface CliChatRuntime {
  service: ChatService;
  retriever: Retriever;
  close(): Promise<void>;
}

const HELP_TEXT = [
  'Usage:',
  '  pnpm rag:ingest [--rebuild-embedding-schema]',
  '  pnpm rag:sync:x',
  '  pnpm rag:migrate',
  '  pnpm rag:stats',
  '  pnpm rag:evaluate [--provider] [--retrieval-only] [--judge] [--failures-out .rag/failures.jsonl]',
  '  pnpm rag:feedback:backlog',
  '  pnpm rag:knowledge:import:telegram -- export.json [--admin-id 123456789] [--curation-mode auto|deterministic|required]',
  '  pnpm rag:knowledge:author:trust -- --chat-id <id> --user-id <id> --role <role> --valid-from <date> --reviewer <id>',
  '  pnpm rag:knowledge:author:list -- [--chat-id <id>] [--active-at <date>] [--limit 100]',
  '  pnpm rag:knowledge:list -- --status pending --limit 20',
  '  pnpm rag:knowledge:history -- <id>',
  '  pnpm rag:knowledge:revise -- <id> --editor <id> [--question <text>] [--answer <text>]',
  '  pnpm rag:knowledge:approve -- <id> --reviewer <id> [--effective-at <date>] [--source-url <url>]',
  '  pnpm rag:knowledge:reject -- <id> --reviewer <id> [--note <reason>]',
  '  pnpm rag:knowledge:publish -- <id>',
  '  pnpm rag:knowledge:automation:work -- [--limit 20] [--worker-id <id>]',
  '  pnpm rag:knowledge:publication:work -- [--worker-id <id>]',
  '  pnpm rag:ask -- "question"',
  '  pnpm rag:ask -- --debug-retrieve "question"',
].join('\n');

const EMBEDDING_BATCH_SIZE = 64;

export function parseCliArgs(args: readonly string[]): CliCommand {
  const [command, ...rawRest] = args;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }

  if (
    command === 'evaluate' ||
    command === 'feedback:backlog' ||
    command === 'migrate' ||
    command === 'stats' ||
    command === 'sync:x'
  ) {
    if (command === 'evaluate') {
      return parseEvaluateArgs(rawRest);
    }
    return { command };
  }

  if (command === 'ingest') {
    return parseIngestArgs(rawRest);
  }

  if (command === 'knowledge:import:telegram') {
    return parseKnowledgeImportTelegramArgs(rawRest);
  }

  if (command === 'knowledge:list') {
    return parseKnowledgeListArgs(rawRest);
  }

  if (command === 'knowledge:author:list') {
    return parseKnowledgeAuthorListArgs(rawRest);
  }

  if (command === 'knowledge:author:trust') {
    return parseKnowledgeAuthorTrustArgs(rawRest);
  }

  if (command === 'knowledge:history') {
    return parseKnowledgeHistoryArgs(rawRest);
  }

  if (command === 'knowledge:revise') {
    return parseKnowledgeReviseArgs(rawRest);
  }

  if (command === 'knowledge:approve' || command === 'knowledge:reject') {
    return parseKnowledgeReviewArgs(command, rawRest);
  }

  if (command === 'knowledge:publish') {
    return parseKnowledgePublishArgs(rawRest);
  }

  if (command === 'knowledge:automation:work') {
    return parseKnowledgeAutomationWorkArgs(rawRest);
  }

  if (command === 'knowledge:publication:work') {
    return parseKnowledgePublicationWorkArgs(rawRest);
  }

  if (command === 'ask') {
    return parseAskArgs(rawRest);
  }

  return { command: 'help', error: `Unknown command: ${command}` };
}

function parseKnowledgeImportTelegramArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  const file = args[0];
  const adminUserIds: string[] = [];
  let curationMode: KnowledgeCurationMode = 'auto';
  let curationModeWasExplicit = false;
  if (file === undefined || file.startsWith('--')) {
    return { command: 'help', error: 'Missing Telegram export JSON path.' };
  }

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--agent' || arg === '--no-agent') {
      if (curationModeWasExplicit) {
        return { command: 'help', error: 'Specify only one knowledge curation mode.' };
      }
      curationMode = arg === '--agent' ? 'required' : 'deterministic';
      curationModeWasExplicit = true;
      continue;
    }
    if (arg === '--curation-mode') {
      if (curationModeWasExplicit) {
        return { command: 'help', error: 'Specify only one knowledge curation mode.' };
      }
      const value = args[index + 1];
      if (value !== 'auto' && value !== 'deterministic' && value !== 'required') {
        return {
          command: 'help',
          error: '--curation-mode must be auto, deterministic, or required.',
        };
      }
      curationMode = value;
      curationModeWasExplicit = true;
      index += 1;
      continue;
    }
    if (arg !== '--admin-id') {
      return { command: 'help', error: `Unknown Telegram import option: ${arg}` };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { command: 'help', error: 'Missing value for --admin-id.' };
    }
    adminUserIds.push(value);
    index += 1;
  }

  return {
    adminUserIds,
    command: 'knowledge:import:telegram',
    curationMode,
    file,
  };
}

function parseKnowledgeListArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  let limit = 20;
  let status: KnowledgeCandidateStatus | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--limit') {
      if (value === undefined || !/^\d+$/u.test(value) || Number(value) <= 0) {
        return { command: 'help', error: '--limit must be a positive integer.' };
      }
      limit = Math.min(Number(value), 100);
      index += 1;
      continue;
    }
    if (arg === '--status') {
      if (!isKnowledgeCandidateStatus(value)) {
        return { command: 'help', error: 'Invalid knowledge candidate status.' };
      }
      status = value;
      index += 1;
      continue;
    }
    return { command: 'help', error: `Unknown knowledge:list option: ${arg}` };
  }

  return {
    command: 'knowledge:list',
    limit,
    ...(status === undefined ? {} : { status }),
  };
}

function parseKnowledgeAuthorListArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  let activeAt: string | undefined;
  let chatId: string | undefined;
  let limit = 100;

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { command: 'help', error: `Missing value for ${option ?? 'knowledge:author:list'}.` };
    }
    if (option === '--active-at') {
      activeAt = value;
    } else if (option === '--chat-id') {
      chatId = value;
    } else if (option === '--limit') {
      if (!/^\d+$/u.test(value) || Number(value) <= 0) {
        return { command: 'help', error: '--limit must be a positive integer.' };
      }
      limit = Math.min(Number(value), 500);
    } else {
      return { command: 'help', error: `Unknown knowledge:author:list option: ${option}` };
    }
  }

  return {
    command: 'knowledge:author:list',
    limit,
    ...(activeAt === undefined ? {} : { activeAt }),
    ...(chatId === undefined ? {} : { chatId }),
  };
}

function parseKnowledgeAuthorTrustArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  const options = parseNamedValueOptions(
    args,
    new Set([
      '--chat-id',
      '--reviewer',
      '--role',
      '--source',
      '--user-id',
      '--valid-from',
      '--valid-to',
    ]),
    'knowledge:author:trust',
  );
  if ('error' in options) {
    return { command: 'help', error: options.error };
  }
  const chatId = options.values.get('--chat-id');
  const role = options.values.get('--role');
  const userId = options.values.get('--user-id');
  const validFrom = options.values.get('--valid-from');
  const verifiedBy = options.values.get('--reviewer');
  if (
    chatId === undefined ||
    role === undefined ||
    userId === undefined ||
    validFrom === undefined ||
    verifiedBy === undefined
  ) {
    return {
      command: 'help',
      error:
        'knowledge:author:trust requires --chat-id, --user-id, --role, --valid-from, and --reviewer.',
    };
  }
  if (!isTrustedAuthorRole(role)) {
    return { command: 'help', error: 'Invalid trusted author role.' };
  }
  const source = options.values.get('--source') ?? 'manual';
  if (!isTrustedAuthorVerificationSource(source)) {
    return { command: 'help', error: 'Invalid trusted author verification source.' };
  }
  const validTo = options.values.get('--valid-to');
  return {
    chatId,
    command: 'knowledge:author:trust',
    role,
    userId,
    validFrom,
    verificationSource: source,
    verifiedBy,
    ...(validTo === undefined ? {} : { validTo }),
  };
}

function parseKnowledgeHistoryArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith('--')) {
    return { command: 'help', error: 'knowledge:history requires exactly one candidate id.' };
  }
  return { command: 'knowledge:history', id: args[0] };
}

function parseKnowledgeReviseArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  const id = args[0];
  if (id === undefined || id.startsWith('--')) {
    return { command: 'help', error: 'Missing candidate id for knowledge:revise.' };
  }
  const options = parseNamedValueOptions(
    args.slice(1),
    new Set([
      '--answer',
      '--editor',
      '--evidence',
      '--module',
      '--question',
      '--reason',
      '--title',
    ]),
    'knowledge:revise',
  );
  if ('error' in options) {
    return { command: 'help', error: options.error };
  }
  const editedBy = options.values.get('--editor');
  if (editedBy === undefined) {
    return { command: 'help', error: '--editor is required.' };
  }
  const canonicalAnswer = options.values.get('--answer');
  const evidence = options.values.get('--evidence');
  const proposedModule = options.values.get('--module');
  const proposedTitle = options.values.get('--title');
  const question = options.values.get('--question');
  if (
    canonicalAnswer === undefined &&
    evidence === undefined &&
    proposedModule === undefined &&
    proposedTitle === undefined &&
    question === undefined
  ) {
    return { command: 'help', error: 'knowledge:revise requires at least one editable field.' };
  }
  const reason = options.values.get('--reason');
  return {
    command: 'knowledge:revise',
    editedBy,
    id,
    ...(canonicalAnswer === undefined ? {} : { canonicalAnswer }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(proposedModule === undefined ? {} : { proposedModule }),
    ...(proposedTitle === undefined ? {} : { proposedTitle }),
    ...(question === undefined ? {} : { question }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function parseNamedValueOptions(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  command: string,
): { values: Map<string, string> } | { error: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option === undefined || !allowed.has(option)) {
      return { error: `Unknown ${command} option: ${option ?? ''}` };
    }
    if (value === undefined || value.startsWith('--')) {
      return { error: `Missing value for ${option}.` };
    }
    values.set(option, value);
  }
  return { values };
}

function isTrustedAuthorRole(value: string): value is TrustedAuthorRole {
  return ['administrator', 'knowledge_editor', 'owner'].includes(value);
}

function isTrustedAuthorVerificationSource(
  value: string,
): value is TrustedAuthorVerificationSource {
  return ['import', 'manual', 'telegram_api'].includes(value);
}

function parseKnowledgeReviewArgs(
  command: 'knowledge:approve' | 'knowledge:reject',
  rawArgs: readonly string[],
): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  const id = args[0];
  if (id === undefined || id.startsWith('--')) {
    return { command: 'help', error: `Missing candidate id for ${command}.` };
  }

  const options = new Map<string, string>();
  const allowed =
    command === 'knowledge:approve'
      ? new Set(['--effective-at', '--note', '--reviewer', '--source-url', '--supersedes'])
      : new Set(['--note', '--reviewer']);
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (option === undefined || !allowed.has(option)) {
      return { command: 'help', error: `Unknown ${command} option: ${option ?? ''}` };
    }
    if (value === undefined || value.startsWith('--')) {
      return { command: 'help', error: `Missing value for ${option}.` };
    }
    options.set(option, value);
  }

  const reviewedBy = options.get('--reviewer');
  if (reviewedBy === undefined) {
    return { command: 'help', error: '--reviewer is required.' };
  }
  const note = options.get('--note');
  if (command === 'knowledge:reject') {
    return {
      command,
      id,
      reviewedBy,
      ...(note === undefined ? {} : { note }),
    };
  }

  const effectiveAt = options.get('--effective-at');
  const sourceUrl = options.get('--source-url');
  const supersedesValue = options.get('--supersedes');
  const supersedes = supersedesValue
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return {
    command,
    id,
    reviewedBy,
    ...(effectiveAt === undefined ? {} : { effectiveAt }),
    ...(note === undefined ? {} : { note }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

function parseKnowledgePublishArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith('--')) {
    return { command: 'help', error: 'knowledge:publish requires exactly one candidate id.' };
  }
  return { command: 'knowledge:publish', id: args[0] };
}

function parseKnowledgePublicationWorkArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  if (args.length === 0) {
    return { command: 'knowledge:publication:work' };
  }
  if (
    args.length !== 2 ||
    args[0] !== '--worker-id' ||
    args[1] === undefined ||
    args[1].startsWith('--')
  ) {
    return {
      command: 'help',
      error: 'knowledge:publication:work accepts only an optional --worker-id <id>.',
    };
  }
  return { command: 'knowledge:publication:work', workerId: args[1] };
}

function parseKnowledgeAutomationWorkArgs(rawArgs: readonly string[]): CliCommand {
  const args = stripPnpmSeparator(rawArgs);
  let limit = 20;
  let workerId: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !option.startsWith('--') ||
      value.startsWith('--') ||
      seen.has(option)
    ) {
      return {
        command: 'help',
        error:
          'knowledge:automation:work accepts optional unique --limit <1..100> and --worker-id <id> flags.',
      };
    }
    seen.add(option);
    if (option === '--limit') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return { command: 'help', error: '--limit must be an integer between 1 and 100.' };
      }
      limit = parsed;
    } else if (option === '--worker-id') {
      workerId = value;
    } else {
      return { command: 'help', error: `Unknown knowledge automation option: ${option}` };
    }
  }
  return {
    command: 'knowledge:automation:work',
    limit,
    ...(workerId === undefined ? {} : { workerId }),
  };
}

function stripPnpmSeparator(args: readonly string[]): readonly string[] {
  return args[0] === '--' ? args.slice(1) : args;
}

function isKnowledgeCandidateStatus(value: string | undefined): value is KnowledgeCandidateStatus {
  return ['approved', 'pending', 'published', 'rejected'].includes(value ?? '');
}

function parseEvaluateArgs(rawArgs: readonly string[]): CliCommand {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  let failuresOut: string | undefined;
  let judge = false;
  let providerBacked = false;
  let retrievalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--provider') {
      providerBacked = true;
      continue;
    }
    if (arg === '--judge') {
      judge = true;
      continue;
    }
    if (arg === '--retrieval-only') {
      retrievalOnly = true;
      continue;
    }
    if (arg === '--failures-out') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { command: 'help', error: 'Missing path for --failures-out.' };
      }
      if (!isSafeEvaluationOutputPath(value)) {
        return { command: 'help', error: '--failures-out must be a file under .rag/.' };
      }
      failuresOut = value;
      index += 1;
      continue;
    }
    return { command: 'help', error: `Unknown rag:evaluate option: ${arg}` };
  }

  if (judge && !providerBacked) {
    return { command: 'help', error: '--judge requires --provider.' };
  }
  if (retrievalOnly && !providerBacked) {
    return { command: 'help', error: '--retrieval-only requires --provider.' };
  }
  if (retrievalOnly && judge) {
    return { command: 'help', error: '--judge cannot be used with --retrieval-only.' };
  }

  return {
    command: 'evaluate',
    ...(failuresOut === undefined ? {} : { failuresOut }),
    judge,
    providerBacked,
    retrievalOnly,
  };
}

function isSafeEvaluationOutputPath(value: string): boolean {
  if (path.isAbsolute(value)) {
    return false;
  }
  const normalized = path.normalize(value);
  return normalized.startsWith(`.rag${path.sep}`) && path.basename(normalized).length > 0;
}

function parseIngestArgs(rawArgs: readonly string[]): CliCommand {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (args.length === 0) {
    return { command: 'ingest', rebuildEmbeddingSchema: false };
  }
  if (args.length === 1 && args[0] === '--rebuild-embedding-schema') {
    return { command: 'ingest', rebuildEmbeddingSchema: true };
  }

  return { command: 'help', error: `Unknown rag:ingest option: ${args.join(' ')}` };
}

function parseAskArgs(rawArgs: readonly string[]): CliCommand {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const debugRetrieve = args.includes('--debug-retrieve');
  const question = args
    .filter((arg) => arg !== '--debug-retrieve')
    .join(' ')
    .trim();
  if (question.length === 0) {
    return { command: 'help', error: 'Missing question for rag:ask.' };
  }

  return {
    command: 'ask',
    debugRetrieve,
    question,
  };
}

export function formatIngestSummary(summary: IngestSummary): string {
  const lines = [
    `Indexed ${summary.documentCount} documents into ${summary.chunkCount} chunks.`,
    `Saved index: ${summary.indexPath}`,
  ];

  if (summary.runId !== undefined) {
    lines.push(`Run ID: ${summary.runId}`);
  }

  return lines.join('\n');
}

export function formatSyncXUpdatesSummary(summary: SyncXUpdatesSummary): string {
  const lines = [
    `Synced ${summary.changedChunkCount} changed X chunks (${summary.skippedChunkCount} skipped).`,
    `Scanned ${summary.documentCount} X documents into ${summary.chunkCount} chunks.`,
    `Saved index: ${summary.indexPath}`,
  ];

  if (summary.runId !== undefined) {
    lines.push(`Run ID: ${summary.runId}`);
  }

  return lines.join('\n');
}

export function formatMigrationSummary(): string {
  return 'Database migrations applied.';
}

export function formatTelegramKnowledgeImportSummary(
  summary: TelegramKnowledgeImportSummary,
): string {
  return [
    `Scanned ${summary.messageCount} Telegram messages and ${summary.adminReplyCount} administrator messages.`,
    `Extracted ${summary.candidateCount} candidates: ${summary.createdCount} created, ${summary.duplicateCount} duplicates.`,
    `Curator ${summary.runId} (${summary.curationMode}): ${summary.deterministicCandidateCount} deterministic, ${summary.agentCandidateCount} agent-assisted, ${summary.rejectedAgentProposalCount} rejected agent proposals across ${summary.threadCount} threads.`,
    `Agent routing: ${summary.agentRunStats.eligibleThreadCount} eligible, ${summary.agentRunStats.attemptedThreadCount} attempted, ${summary.agentRunStats.succeededThreadCount} succeeded, ${summary.agentRunStats.failedThreadCount} failed; ${summary.agentRunStats.skippedUnavailableThreadCount} unavailable, ${summary.agentRunStats.skippedByModeThreadCount} mode-skipped, ${summary.agentRunStats.skippedBudgetThreadCount} budget-skipped.`,
    `Agent failure categories: ${summary.agentRunStats.failureCounts.timeout} timeout, ${summary.agentRunStats.failureCounts.provider_error} provider, ${summary.agentRunStats.failureCounts.invalid_output} invalid-output, ${summary.agentRunStats.failureCounts.unknown} unknown (no raw error text).`,
    `Verified ${summary.verifiedAuthorMessageCount} author messages; ${summary.unverifiedAuthorMessageCount} other messages were not treated as authoritative.`,
    `Skipped ${summary.skippedBoundaryCount} boundary replies and ${summary.skippedMissingReplyCount} messages without a direct user reply.`,
    ...(summary.automation === undefined
      ? []
      : [
          `Automation ${summary.automation.policyVersion}: ${summary.automation.approvedCount} approved, ${summary.automation.rejectedCount} rejected, ${summary.automation.publicationQueuedCount} publication jobs queued.`,
        ]),
  ].join('\n');
}

export function formatKnowledgeCandidateList(candidates: KnowledgeCandidate[]): string {
  return formatJsonLines(candidates, 'No knowledge candidates.');
}

function formatJsonLines(values: readonly unknown[], emptyMessage: string): string {
  return values.length === 0
    ? emptyMessage
    : values.map((value) => JSON.stringify(value)).join('\n');
}

export function formatKnowledgePublicationSummary(summary: KnowledgePublicationSummary): string {
  if (summary.alreadyPublished) {
    return `Knowledge candidate ${summary.candidateId} is already published as ${summary.documentId} (job ${summary.jobId}).`;
  }
  return [
    `Published ${summary.candidateId} as ${summary.documentId}.`,
    `Publication job: ${summary.jobId}`,
    `Document: ${summary.file}`,
    ...(summary.runId === undefined ? [] : [`Ingestion run: ${summary.runId}`]),
  ].join('\n');
}

export function formatKnowledgeAutomationWorkerSummary(
  summary: KnowledgeAutomationWorkerSummary,
): string {
  return [
    `Automation ${summary.automation.policyVersion}: ${summary.automation.approvedCount} approved, ${summary.automation.rejectedCount} rejected, ${summary.automation.publicationQueuedCount} queued or running.`,
    `Published ${summary.publications.length} knowledge candidates in this run.`,
  ].join('\n');
}

export function formatAdminVerifiedKnowledgeDocument(candidate: KnowledgeCandidate): string {
  if (candidate.status !== 'approved') {
    throw new Error(`Knowledge candidate ${candidate.id} must be approved before publication.`);
  }
  if (candidate.effectiveAt === undefined) {
    throw new Error(`Knowledge candidate ${candidate.id} requires effectiveAt before publication.`);
  }

  const title = (candidate.proposedTitle ?? candidate.question)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'section: "XXYY 客服群审核知识"',
    ...(candidate.proposedModule === undefined
      ? []
      : [`category: ${JSON.stringify(candidate.proposedModule)}`]),
    `effective_at: ${JSON.stringify(candidate.effectiveAt)}`,
    ...(candidate.sourceUrl === undefined
      ? []
      : [`source_url: ${JSON.stringify(candidate.sourceUrl)}`]),
    'status: current',
    ...(candidate.supersedes === undefined || candidate.supersedes.length === 0
      ? []
      : [`supersedes: ${JSON.stringify(candidate.supersedes)}`]),
    '---',
  ];

  return [
    ...frontmatter,
    `# ${title}`,
    '',
    '## 用户问题',
    '',
    candidate.question,
    '',
    '## 标准答案',
    '',
    candidate.canonicalAnswer,
    '',
  ].join('\n');
}

export function formatChatResponse(response: ChatResponse): string {
  const lines = [
    response.answer,
    '',
    `Intent: ${response.intent} (confidence ${response.confidence.toFixed(2)})`,
    '',
  ];

  if (response.citations.length === 0) {
    return appendAttachments([...lines, 'Citations: none'], response).join('\n');
  }

  lines.push('Citations:');
  response.citations.forEach((citation, index) => {
    lines.push(`[${index + 1}] ${citation.title}`);
    lines.push(`    ${citation.file}`);
    if (citation.sourceUrl !== undefined) {
      lines.push(`    ${citation.sourceUrl}`);
    }
    lines.push(`    ${citation.excerpt}`);
  });

  return appendAttachments(lines, response).join('\n');
}

function appendAttachments(lines: string[], response: ChatResponse): string[] {
  if (response.attachments === undefined || response.attachments.length === 0) {
    return lines;
  }

  lines.push('', 'Attachments:');
  response.attachments.forEach((attachment, index) => {
    lines.push(`[${index + 1}] ${attachment.title}`);
    lines.push(`    ${attachment.url}`);
  });
  return lines;
}

export function formatKnowledgeStats(stats: KnowledgeStats): string {
  const lines = [
    'Knowledge stats:',
    `Documents: ${stats.documentCount}`,
    `Chunks: ${stats.chunkCount}`,
    `Source URLs: ${stats.sourceUrlCount}`,
    `Latest chunk update: ${stats.latestChunkUpdatedAt ?? 'none'}`,
    '',
    'Latest ingest run:',
  ];

  if (stats.latestIngestionRun === undefined) {
    lines.push('none');
  } else {
    lines.push(
      `Run ID: ${stats.latestIngestionRun.runId}`,
      `Source: ${stats.latestIngestionRun.source}`,
      `Created at: ${stats.latestIngestionRun.createdAt}`,
      `Documents: ${stats.latestIngestionRun.documentCount}`,
      `Chunks: ${stats.latestIngestionRun.chunkCount}`,
      `Content hash: ${stats.latestIngestionRun.contentHash}`,
    );
  }

  lines.push('', 'Sources:');
  if (stats.sourceStats.length === 0) {
    lines.push('none');
  } else {
    for (const sourceStat of stats.sourceStats) {
      lines.push(
        `${knowledgeSourceCatalog[sourceStat.sourceType].label} (${sourceStat.sourceType}): ${sourceStat.chunkCount} chunks, ${sourceStat.documentCount} documents`,
      );
    }
  }

  return lines.join('\n');
}

export interface FormatEvaluationReportOptions {
  providerBacked?: boolean;
}

type EvaluationReportView = Pick<
  EvaluationReport,
  'judgeSummary' | 'passed' | 'retrievalSummary' | 'total'
> & {
  results: ReadonlyArray<
    Pick<
      EvaluationResult,
      | 'actualIntent'
      | 'citationCount'
      | 'expectedIntent'
      | 'failureReasons'
      | 'minCitations'
      | 'name'
      | 'passed'
    >
  >;
};

export function formatEvaluationReport(
  report: EvaluationReportView,
  options: FormatEvaluationReportOptions = {},
): string {
  const lines = [
    `Evaluation${options.providerBacked === true ? ' (provider-backed)' : ''}: ${report.passed}/${report.total} passed`,
  ];

  if (report.retrievalSummary !== undefined) {
    const summary = report.retrievalSummary;
    lines.push(
      `Retrieval (${summary.annotatedCaseCount} annotated): Recall@K ${formatMetric(summary.averageRecallAtK)}, Precision@K ${formatMetric(summary.averagePrecisionAtK)}, MRR ${formatMetric(summary.meanReciprocalRank)}, nDCG@K ${formatMetric(summary.averageNdcgAtK)}, forbidden hits ${summary.totalForbiddenHits}`,
    );
  }

  if (report.judgeSummary !== undefined) {
    const summary = report.judgeSummary;
    lines.push(
      `Judge (${summary.judgedCaseCount} cases): correctness ${formatMetric(summary.averageCorrectness)}, groundedness ${formatMetric(summary.averageGroundedness)}, completeness ${formatMetric(summary.averageCompleteness)}, relevance ${formatMetric(summary.averageRelevance)}, safe refusal ${formatMetric(summary.averageSafeRefusal)}`,
    );
  }

  for (const result of report.results) {
    const status = `[${result.passed ? 'PASS' : 'FAIL'}] ${result.name}`;
    lines.push(
      options.providerBacked === true
        ? `${status} (expected ${result.expectedIntent}, actual ${result.actualIntent}, citations ${result.citationCount}/${result.minCitations})`
        : status,
    );
    for (const reason of result.failureReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  return lines.join('\n');
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? 'n/a' : value.toFixed(6);
}

export function formatFeedbackEvalBacklog(feedbackRecords: FeedbackRecord[]): string {
  const records = uniqueFeedbackRecords(feedbackRecords).filter(shouldCreateEvalBacklogCandidate);
  if (records.length === 0) {
    return 'No feedback eval backlog candidates.';
  }

  return records.map((record) => JSON.stringify(toFeedbackEvalBacklogRecord(record))).join('\n');
}

function uniqueFeedbackRecords(feedbackRecords: FeedbackRecord[]): FeedbackRecord[] {
  const byKey = new Map<string, FeedbackRecord>();
  for (const record of feedbackRecords) {
    byKey.set(
      [record.createdAt, record.sessionId ?? '', record.question, record.rating].join('\0'),
      record,
    );
  }
  return [...byKey.values()];
}

function shouldCreateEvalBacklogCandidate(record: FeedbackRecord): boolean {
  return record.rating === 'negative' || record.citationCount === 0;
}

function toFeedbackEvalBacklogRecord(record: FeedbackRecord): Record<string, unknown> {
  return {
    _review: {
      channel: record.channel,
      citationCount: record.citationCount,
      ...(record.comment === undefined ? {} : { comment: record.comment }),
      createdAt: record.createdAt,
      observedAnswer: record.answer,
      rating: record.rating,
      reason: record.rating === 'negative' ? 'negative_feedback' : 'no_citation_feedback',
      reviewRequired: true,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      source: 'rag_feedback',
    },
    boundaryExpected: !['agent_capabilities', 'product_qa', 'how_to'].includes(record.intent),
    expectedIntent: record.intent,
    name: createFeedbackEvalCaseName(record),
    question: record.question,
  };
}

function createFeedbackEvalCaseName(record: FeedbackRecord): string {
  const date = record.createdAt.slice(0, 10).replaceAll('-', '') || 'undated';
  const hash = createHash('sha256')
    .update([record.createdAt, record.sessionId ?? '', record.question].join('\n'))
    .digest('hex')
    .slice(0, 8);
  return `feedback-${date}-${hash}`;
}

export function createDefaultCliIo(options: DefaultCliIoOptions = {}): CliIo {
  const cwd = options.cwd ?? process.cwd();
  const shellEnv = options.env ?? process.env;
  const workspaceCwd = resolveWorkspaceCwd(cwd, shellEnv);

  return {
    cwd,
    env: loadWorkspaceEnv({ cwd: workspaceCwd, env: shellEnv }),
    stderr: options.stderr ?? process.stderr,
    stdout: options.stdout ?? process.stdout,
  };
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  io: CliIo = createDefaultCliIo(),
): Promise<number> {
  const parsed = parseCliArgs(args);
  const workspaceCwd = resolveWorkspaceCwd(io.cwd, io.env);

  if (parsed.command === 'help') {
    writeLine(io.stderr, [parsed.error, HELP_TEXT].filter(Boolean).join('\n\n'));
    return parsed.error === undefined ? 0 : 1;
  }

  if (parsed.command === 'ingest') {
    try {
      const summary = await ingest({ ...io, cwd: workspaceCwd }, parsed.rebuildEmbeddingSchema);
      writeLine(io.stdout, formatIngestSummary(summary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'sync:x') {
    try {
      const summary = await syncXUpdates({ ...io, cwd: workspaceCwd });
      writeLine(io.stdout, formatSyncXUpdatesSummary(summary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'evaluate') {
    try {
      if (parsed.retrievalOnly) {
        const report = await evaluateProviderRetrieval(
          { ...io, cwd: workspaceCwd },
          parsed.failuresOut,
        );
        writeLine(io.stdout, formatProviderRetrievalReport(report));
        return report.passed === report.total ? 0 : 1;
      }
      const report = await evaluate({ ...io, cwd: workspaceCwd }, parsed);
      writeLine(
        io.stdout,
        formatEvaluationReport(report, { providerBacked: parsed.providerBacked }),
      );
      return report.passed === report.total ? 0 : 1;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  const config = loadRagConfig(io.env);

  if (parsed.command === 'migrate') {
    try {
      await migrateDatabase(config);
      writeLine(io.stdout, formatMigrationSummary());
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'stats') {
    try {
      const statsSummary = await stats(config);
      writeLine(io.stdout, formatKnowledgeStats(statsSummary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'feedback:backlog') {
    try {
      const backlog = await feedbackBacklog(config);
      writeLine(io.stdout, backlog);
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:import:telegram') {
    try {
      const summary = await importTelegramKnowledgeCandidates(
        { ...io, cwd: workspaceCwd },
        config,
        parsed,
      );
      writeLine(io.stdout, formatTelegramKnowledgeImportSummary(summary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:list') {
    try {
      const candidates = await listKnowledgeCandidates(config, parsed);
      writeLine(io.stdout, formatKnowledgeCandidateList(candidates));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:author:list') {
    try {
      const authors = await listKnowledgeTrustedAuthors(config, parsed);
      writeLine(io.stdout, formatJsonLines(authors, 'No trusted authors.'));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:author:trust') {
    try {
      const author = await trustKnowledgeAuthor(config, parsed);
      writeLine(io.stdout, JSON.stringify(author));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:history') {
    try {
      const history = await getKnowledgeCandidateHistory(config, parsed.id);
      writeLine(io.stdout, JSON.stringify(history));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:revise') {
    try {
      const candidate = await reviseKnowledgeCandidate(config, parsed);
      writeLine(io.stdout, JSON.stringify(candidate));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:approve' || parsed.command === 'knowledge:reject') {
    try {
      const candidate = await reviewKnowledgeCandidate(config, parsed);
      writeLine(io.stdout, JSON.stringify(candidate));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:publish') {
    try {
      const summary = await publishKnowledgeCandidate({ ...io, cwd: workspaceCwd }, config, parsed);
      writeLine(io.stdout, formatKnowledgePublicationSummary(summary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:automation:work') {
    try {
      const summary = await workKnowledgeAutomation({ ...io, cwd: workspaceCwd }, config, parsed);
      writeLine(io.stdout, formatKnowledgeAutomationWorkerSummary(summary));
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  if (parsed.command === 'knowledge:publication:work') {
    try {
      const summary = await workKnowledgePublicationQueue(
        { ...io, cwd: workspaceCwd },
        config,
        parsed,
      );
      writeLine(
        io.stdout,
        summary === undefined
          ? 'No queued or expired knowledge publication jobs.'
          : formatKnowledgePublicationSummary(summary),
      );
      return 0;
    } catch (error) {
      if (writeConfigurationError(io, error)) {
        return 1;
      }
      throw error;
    }
  }

  try {
    const tracer = noopQualityTracer;
    const runtime = createCliChatRuntime(config, tracer);
    try {
      if (parsed.debugRetrieve) {
        const chunks = await runtime.retriever.retrieve(parsed.question, {
          topK: config.topK,
        });
        writeLine(
          io.stdout,
          formatRetrievedChunksDebug(chunks, {
            question: parsed.question,
          }),
        );
        writeLine(io.stdout, '');
      }

      const request: ChatRequest = {
        channel: 'cli',
        message: parsed.question,
      };
      const response = await runtime.service.ask(request);
      writeLine(io.stdout, formatChatResponse(response));
      return 0;
    } finally {
      await runtime.close();
    }
  } catch (error) {
    if (writeConfigurationError(io, error)) {
      return 1;
    }
    throw error;
  }
}

interface ProviderRetrievalCaseResult {
  forbiddenChunkIds: string[];
  name: string;
  passed: boolean;
  question: string;
  relevantChunkIds: string[];
  result: ReturnType<typeof evaluateRetrievalRanking>;
}

interface ProviderRetrievalReport {
  passed: number;
  results: ProviderRetrievalCaseResult[];
  summary: ReturnType<typeof aggregateRetrievalResults>;
  total: number;
}

async function evaluateProviderRetrieval(
  io: CliIo,
  failuresOut: string | undefined,
): Promise<ProviderRetrievalReport> {
  const config = loadRagConfig(io.env);
  const cases = (await loadEvaluationCases(io.cwd)).filter(
    (testCase) => (testCase.relevantChunkIds?.length ?? 0) > 0,
  );
  const tracer = noopQualityTracer;
  const runtime = createCliChatRuntime(config, tracer);

  try {
    const retriever = createRerankingRetriever(runtime.retriever, createMetadataReranker(), {
      candidateMultiplier: 8,
      tracer,
    });
    const results: ProviderRetrievalCaseResult[] = [];
    for (const testCase of cases) {
      const chunks = await retriever.retrieve(testCase.request.message, { topK: config.topK });
      const result = evaluateRetrievalRanking({
        forbiddenChunkIds: testCase.forbiddenChunkIds ?? [],
        relevantChunkIds: testCase.relevantChunkIds ?? [],
        retrievedChunkIds: chunks.map((chunk) => chunk.id),
        topK: config.topK,
      });
      results.push({
        forbiddenChunkIds: [...(testCase.forbiddenChunkIds ?? [])],
        name: testCase.name,
        passed: result.recallAtK === 1 && result.forbiddenHitCount === 0,
        question: testCase.request.message,
        relevantChunkIds: [...(testCase.relevantChunkIds ?? [])],
        result,
      });
    }

    const report: ProviderRetrievalReport = {
      passed: results.filter((result) => result.passed).length,
      results,
      summary: aggregateRetrievalResults(results.map((result) => result.result)),
      total: results.length,
    };
    if (failuresOut !== undefined) {
      const outputPath = path.resolve(io.cwd, failuresOut);
      await mkdir(path.dirname(outputPath), { recursive: true });
      const failures = report.results
        .filter((result) => !result.passed)
        .map((result) => JSON.stringify(result))
        .join('\n');
      await writeFile(outputPath, failures.length === 0 ? '' : `${failures}\n`, 'utf8');
    }
    return report;
  } finally {
    await runtime.close();
  }
}

export function formatProviderRetrievalReport(report: ProviderRetrievalReport): string {
  const summary = report.summary;
  const lines = [
    `Retrieval evaluation (provider-backed): ${report.passed}/${report.total} cases fully recalled`,
    `Recall@K ${formatMetric(summary.averageRecallAtK)}, Precision@K ${formatMetric(summary.averagePrecisionAtK)}, MRR ${formatMetric(summary.meanReciprocalRank)}, nDCG@K ${formatMetric(summary.averageNdcgAtK)}, forbidden hits ${summary.totalForbiddenHits}`,
  ];

  for (const result of report.results.filter((item) => !item.passed)) {
    lines.push(
      `[FAIL] ${result.name} (recall ${formatMetric(result.result.recallAtK)}, forbidden ${result.result.forbiddenHitCount ?? 0})`,
      `  expected: ${result.relevantChunkIds.join(', ')}`,
      `  retrieved: ${result.result.retrievedChunkIds.join(', ') || '(none)'}`,
    );
  }

  return lines.join('\n');
}

async function ingest(
  io: CliIo,
  rebuildEmbeddingSchema: boolean,
  afterReplace?: (client: PgClientLike, runId: string) => Promise<void>,
): Promise<IngestSummary> {
  const config = loadRagConfig(io.env);
  const documents = await loadProductDocuments({ cwd: io.cwd });
  const chunks = prepareKnowledgeChunks(documents);
  const pool = createPgPool(config.databaseUrl);

  try {
    const embeddingProvider = createOpenAiEmbeddingProvider({
      apiKey: config.embeddingApiKey,
      baseUrl: config.embeddingBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiEmbeddingModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    const store = createPgVectorStore({
      client: pool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider,
    });
    if (rebuildEmbeddingSchema) {
      await store.migrate({ allowEmbeddingDimensionMismatch: true });
    } else {
      await store.migrate();
    }
    const embeddedChunks = await embedPreparedChunks(chunks, embeddingProvider);
    const ingestionRun = createIngestionRun({
      chunks: embeddedChunks,
      documentCount: documents.length,
    });
    if (afterReplace === undefined && !rebuildEmbeddingSchema) {
      await store.replaceChunks(embeddedChunks, ingestionRun);
    } else {
      const replaceOptions: ReplaceChunksOptions = {
        ...(afterReplace === undefined
          ? {}
          : {
              afterReplace: (client: PgClientLike) => afterReplace(client, ingestionRun.runId),
            }),
        ...(rebuildEmbeddingSchema ? { rebuildEmbeddingSchema: true } : {}),
      };
      await store.replaceChunks(embeddedChunks, ingestionRun, replaceOptions);
    }
    return {
      documentCount: documents.length,
      chunkCount: chunks.length,
      indexPath: 'pgvector',
      runId: ingestionRun.runId,
    };
  } finally {
    await pool.end();
  }
}

async function syncXUpdates(io: CliIo): Promise<SyncXUpdatesSummary> {
  const config = loadRagConfig(io.env);
  const documents = await loadProductDocuments({ cwd: io.cwd });
  const xDocuments = documents.filter((document) => document.sourceType === 'x_updates');
  const chunks = prepareKnowledgeChunks(xDocuments);
  const pool = createPgPool(config.databaseUrl);

  try {
    const embeddingProvider = createOpenAiEmbeddingProvider({
      apiKey: config.embeddingApiKey,
      baseUrl: config.embeddingBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiEmbeddingModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
    });
    const store = createPgVectorStore({
      client: pool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider,
    });
    await store.migrate();
    const existingHashes = await store.getChunkContentHashes(chunks.map((chunk) => chunk.id));
    const changedChunks = chunks.filter(
      (chunk) => existingHashes.get(chunk.id) !== chunk.contentHash,
    );
    const embeddedChunks = await embedPreparedChunks(changedChunks, embeddingProvider);
    let ingestionRun: ReturnType<typeof createIngestionRun> | undefined;

    if (embeddedChunks.length > 0) {
      ingestionRun = createIngestionRun({
        chunks: embeddedChunks,
        documentCount: xDocuments.length,
        source: 'cli:x_incremental',
      });
      await store.upsertChunks(embeddedChunks);
      await store.recordIngestionRun(ingestionRun);
    }

    return {
      changedChunkCount: changedChunks.length,
      chunkCount: chunks.length,
      documentCount: xDocuments.length,
      indexPath: 'pgvector',
      skippedChunkCount: chunks.length - changedChunks.length,
      ...(ingestionRun === undefined ? {} : { runId: ingestionRun.runId }),
    };
  } finally {
    await pool.end();
  }
}

async function evaluate(
  io: CliIo,
  options: Extract<CliCommand, { command: 'evaluate' }>,
): Promise<EvaluationReport> {
  const config = loadRagConfig(io.env);
  const cases = await loadEvaluationCases(io.cwd);
  const inMemoryTrace = options.providerBacked ? createInMemoryQualityTracer() : undefined;
  const tracer = inMemoryTrace?.tracer ?? noopQualityTracer;
  let report: EvaluationReport;

  if (options.providerBacked) {
    const runtime = createCliChatRuntime(config, tracer);
    try {
      report = await evaluateCases(cases, runtime.service, {
        observe: (testCase) =>
          collectEvaluationTraceObservation(
            inMemoryTrace?.records ?? [],
            testCase.request.requestId ?? `eval:${testCase.name}`,
          ),
      });
    } finally {
      await runtime.close();
    }
  } else {
    const documents = await loadProductDocuments({ cwd: io.cwd });
    const chunks = prepareKnowledgeChunks(documents);
    const index: RagIndex = {
      builtAt: new Date(0).toISOString(),
      entries: chunks.map((chunk) => ({
        ...chunk,
        embedding: createLocalHashEmbedding(chunk.searchableText),
      })),
      version: 1,
    };
    const evaluationRetriever = createRerankingRetriever(
      createLocalRetriever(index),
      createMetadataReranker(),
      { candidateMultiplier: 4, tracer },
    );
    const service = createChatService({
      answerProvider: {
        answer(input) {
          return Promise.resolve(
            createGroundedAnswer(input.question, input.classification, input.retrievedChunks),
          );
        },
      },
      config,
      index,
      reranker: createMetadataReranker(),
    });

    report = await evaluateCases(cases, service, {
      observe: createRetrievalObserver(evaluationRetriever, config.topK),
    });
  }

  attachRetrievalEvaluation(report, config.topK);
  if (options.judge) {
    await attachJudgeEvaluation(
      report,
      createOpenAiAnswerQualityJudge({
        apiKey: config.openAiApiKey,
        baseUrl: config.openAiBaseUrl,
        model: io.env.EVAL_JUDGE_MODEL,
        requestTimeoutMs: config.openAiRequestTimeoutMs,
      }),
    );
  }
  if (options.failuresOut !== undefined) {
    const outputPath = path.resolve(io.cwd, options.failuresOut);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, formatEvaluationFailureJsonl(report), 'utf8');
  }

  return report;
}

export function collectEvaluationTraceObservation(
  records: readonly QualityTraceRecord[],
  requestId: string,
): { retrievedChunkIds: string[]; toolNames: string[] } {
  const root = records.find(
    (record) => record.name === 'chat.request' && record.metadata?.requestId === requestId,
  );
  if (root === undefined) {
    return { retrievedChunkIds: [], toolNames: [] };
  }

  const descendantIds = new Set([root.id]);
  const descendants: QualityTraceRecord[] = [];
  for (const record of records) {
    if (record.parentId !== undefined && descendantIds.has(record.parentId)) {
      descendantIds.add(record.id);
      descendants.push(record);
    }
  }
  const toolNames = descendants.flatMap((record) => {
    const toolName = record.name === 'agent.tool' ? record.metadata?.toolName : undefined;
    return typeof toolName === 'string' ? [toolName] : [];
  });
  const retrieval = descendants
    .filter((record) => ['rag.metadata_rerank', 'rag.pgvector_candidates'].includes(record.name))
    .at(-1);

  return {
    retrievedChunkIds: readTraceChunkIds(retrieval?.outputs?.chunks),
    toolNames,
  };
}

function readTraceChunkIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((chunk) => {
    if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) {
      return [];
    }
    const id = (chunk as Record<string, unknown>).id;
    return typeof id === 'string' ? [id] : [];
  });
}

function createRetrievalObserver(retriever: Retriever, topK: number) {
  return async (testCase: EvaluationCase): Promise<{ retrievedChunkIds?: string[] }> => {
    if ((testCase.relevantChunkIds?.length ?? 0) === 0) {
      return {};
    }
    const chunks = await retriever.retrieve(testCase.request.message, { topK });
    return { retrievedChunkIds: chunks.map((chunk) => chunk.id) };
  };
}

function attachRetrievalEvaluation(report: EvaluationReport, topK: number): void {
  const evaluations = report.results.map((result) => {
    const evaluation = evaluateRetrievalRanking({
      forbiddenChunkIds: result.forbiddenChunkIds ?? [],
      relevantChunkIds: result.relevantChunkIds ?? [],
      retrievedChunkIds: result.retrievedChunkIds ?? [],
      topK,
    });
    result.retrievalEvaluation = evaluation;
    return evaluation;
  });
  report.retrievalSummary = aggregateRetrievalResults(evaluations);
}

async function attachJudgeEvaluation(
  report: EvaluationReport,
  judge: AnswerQualityJudge,
): Promise<void> {
  for (const result of report.results) {
    result.judgeScores = await judge.judge({
      actualIntent: result.actualIntent,
      answer: result.response.answer,
      boundaryExpected: !['agent_capabilities', 'product_qa', 'how_to'].includes(
        result.expectedIntent,
      ),
      citations: result.response.citations,
      expectedIntent: result.expectedIntent,
      question: result.question,
      referenceFacts: result.referenceFacts ?? [],
    });
  }

  const scores = report.results.flatMap((result) =>
    result.judgeScores === undefined ? [] : [result.judgeScores],
  );
  if (scores.length === 0) {
    return;
  }
  const average = (select: (score: (typeof scores)[number]) => number): number =>
    Math.round(
      (scores.reduce((total, score) => total + select(score), 0) / scores.length) * 1_000_000,
    ) / 1_000_000;
  report.judgeSummary = {
    averageCompleteness: average((score) => score.completeness),
    averageCorrectness: average((score) => score.correctness),
    averageGroundedness: average((score) => score.groundedness),
    averageRelevance: average((score) => score.relevance),
    averageSafeRefusal: average((score) => score.safeRefusal),
    judgedCaseCount: scores.length,
  };
}

interface GoldenQaRecord {
  boundaryExpected?: boolean;
  expectedCitationFiles?: string[];
  expectedCitationTitles?: string[];
  expectedSourceUrls?: string[];
  expectedIntent: EvaluationCase['expectedIntent'];
  expectedAgentRoute?: EvaluationCase['expectedAgentRoute'];
  expectedToolNames?: string[];
  forbiddenChunkIds?: string[];
  forbiddenCitationFiles?: string[];
  forbiddenSourceUrls?: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  name?: string;
  question: string;
  referenceFacts?: string[];
  relevantChunkIds?: string[];
  requireCitationSupport?: boolean;
}

async function loadEvaluationCases(cwd: string): Promise<EvaluationCase[]> {
  const filePath = path.join(cwd, 'docs', 'eval', 'golden-qa.jsonl');
  const content = await readFile(filePath, 'utf8');
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => toEvaluationCase(JSON.parse(line) as GoldenQaRecord, index));
}

function toEvaluationCase(record: GoldenQaRecord, index: number): EvaluationCase {
  const name = record.name ?? `golden-${index + 1}`;
  return {
    ...(record.expectedAgentRoute === undefined
      ? {}
      : { expectedAgentRoute: record.expectedAgentRoute }),
    expectedIntent: record.expectedIntent,
    ...(record.expectedToolNames === undefined
      ? {}
      : { expectedToolNames: record.expectedToolNames }),
    ...(record.forbiddenChunkIds === undefined
      ? {}
      : { forbiddenChunkIds: record.forbiddenChunkIds }),
    ...(record.mustNotContain === undefined
      ? {}
      : { forbiddenAnswerIncludes: record.mustNotContain }),
    ...(record.boundaryExpected === true ? { minCitations: 0 } : {}),
    name,
    request: {
      channel: 'cli',
      message: record.question,
      requestId: `eval:${name}`,
    },
    ...(record.referenceFacts === undefined ? {} : { referenceFacts: record.referenceFacts }),
    ...(record.relevantChunkIds === undefined ? {} : { relevantChunkIds: record.relevantChunkIds }),
    ...(record.mustContain === undefined ? {} : { requiredAnswerIncludes: record.mustContain }),
    ...(record.expectedCitationFiles === undefined
      ? {}
      : { requiredCitationFiles: record.expectedCitationFiles }),
    ...(record.expectedCitationTitles === undefined
      ? {}
      : { requiredCitationTitles: record.expectedCitationTitles }),
    ...(record.expectedSourceUrls === undefined
      ? {}
      : { requiredSourceUrls: record.expectedSourceUrls }),
    ...(record.forbiddenCitationFiles === undefined
      ? {}
      : { forbiddenCitationFiles: record.forbiddenCitationFiles }),
    ...(record.forbiddenSourceUrls === undefined
      ? {}
      : { forbiddenSourceUrls: record.forbiddenSourceUrls }),
    ...(record.requireCitationSupport === undefined
      ? {}
      : { requireCitationSupport: record.requireCitationSupport }),
  };
}

async function migrateDatabase(config: ReturnType<typeof loadRagConfig>): Promise<void> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgVectorStore({
      client: pool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider: {
        embedTexts: () => Promise.reject(new Error('rag:migrate does not generate embeddings.')),
      },
    });
    await store.migrate();
  } finally {
    await pool.end();
  }
}

async function stats(config: ReturnType<typeof loadRagConfig>): Promise<KnowledgeStats> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgVectorStore({
      client: pool,
      embeddingDimension: config.embeddingDimension,
      embeddingProvider: {
        embedTexts: () => Promise.reject(new Error('rag:stats does not generate embeddings.')),
      },
    });
    return await store.getStats();
  } finally {
    await pool.end();
  }
}

async function feedbackBacklog(config: ReturnType<typeof loadRagConfig>): Promise<string> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgFeedbackStore({ client: pool });
    const [negativeFeedback, recentFeedback] = await Promise.all([
      store.getFeedbackStats({ limit: 50, rating: 'negative' }),
      store.getFeedbackStats({ limit: 50 }),
    ]);
    return formatFeedbackEvalBacklog([...negativeFeedback.latest, ...recentFeedback.latest]);
  } finally {
    await pool.end();
  }
}

async function importTelegramKnowledgeCandidates(
  io: CliIo,
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:import:telegram' }>,
): Promise<TelegramKnowledgeImportSummary> {
  const filePath = path.resolve(io.cwd, command.file);
  if (path.extname(filePath).toLowerCase() !== '.json') {
    throw new Error('Telegram export must be a .json file.');
  }
  const rawExport = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  const normalizedExport = readTelegramKnowledgeExport(rawExport);
  const pool = createPgPool(config.databaseUrl);

  try {
    const store = createPgKnowledgeCandidateStore({ client: pool });
    const publicationStore = createPgKnowledgePublicationJobStore({ client: pool });
    const trustedAuthorStore = createPgTrustedAuthorStore({ client: pool });
    await publicationStore.migrate();
    const trustedAuthors =
      normalizedExport.chatId === undefined
        ? []
        : await trustedAuthorStore.list({ chatId: normalizedExport.chatId, limit: 500 });
    let currentAdministratorUserIds = new Set<string>();
    let currentAdministratorVerifiedAt: string | undefined;
    if (
      command.adminUserIds.length === 0 &&
      normalizedExport.chatId !== undefined &&
      io.env.TELEGRAM_BOT_TOKEN !== undefined
    ) {
      try {
        currentAdministratorUserIds = await fetchTelegramCurrentAdministratorIds({
          botToken: io.env.TELEGRAM_BOT_TOKEN,
          chatId: normalizedExport.chatId,
          ...(io.env.TELEGRAM_API_BASE_URL === undefined
            ? {}
            : { apiBaseUrl: io.env.TELEGRAM_API_BASE_URL }),
        });
        currentAdministratorVerifiedAt = new Date().toISOString();
      } catch (error) {
        if (trustedAuthors.length === 0) {
          throw error;
        }
      }
    }
    const curatorModel =
      command.curationMode !== 'deterministic' &&
      config.openAiApiKey !== undefined &&
      config.openAiModel !== undefined
        ? createOpenAiKnowledgeCuratorModel({
            apiKey: config.openAiApiKey,
            baseUrl: config.openAiBaseUrl,
            model: config.openAiModel,
            requestTimeoutMs: config.openAiRequestTimeoutMs,
          })
        : undefined;
    const governance = createKnowledgeGovernanceService({
      automation: createKnowledgeAutomationController({
        candidateStore: store,
        publicationJobStore: publicationStore,
      }),
      candidateStore: store,
      inspector: createPgKnowledgeMatchInspector({ candidateStore: store, client: pool }),
      trustedAuthorStore,
      ...(curatorModel === undefined ? {} : { curatorModel }),
    });
    const result = await governance.importTelegram({
      curationMode: command.curationMode,
      currentAdministratorUserIds,
      ...(currentAdministratorVerifiedAt === undefined ? {} : { currentAdministratorVerifiedAt }),
      explicitAdminUserIds: new Set(command.adminUserIds),
      rawExport,
    });
    return {
      adminReplyCount: result.adminReplyCount,
      agentCandidateCount: result.agentCandidateCount,
      agentRunStats: result.agentRunStats,
      candidateCount: result.candidateCount,
      createdCount: result.created.length,
      curationMode: result.curationMode,
      deterministicCandidateCount: result.deterministicCandidateCount,
      duplicateCount: result.duplicateCount,
      messageCount: result.messageCount,
      rejectedAgentProposalCount: result.rejectedAgentProposalCount,
      runId: result.runId,
      skippedBoundaryCount: result.skippedBoundaryCount,
      skippedMissingReplyCount: result.skippedMissingReplyCount,
      threadCount: result.threadCount,
      unverifiedAuthorMessageCount: result.unverifiedAuthorMessageCount,
      verifiedAuthorMessageCount: result.verifiedAuthorMessageCount,
      ...(result.automation === undefined ? {} : { automation: result.automation }),
    };
  } finally {
    await pool.end();
  }
}

async function listKnowledgeCandidates(
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:list' }>,
): Promise<KnowledgeCandidate[]> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgKnowledgeCandidateStore({ client: pool });
    await store.migrate();
    return await store.list({
      limit: command.limit,
      ...(command.status === undefined ? {} : { status: command.status }),
    });
  } finally {
    await pool.end();
  }
}

async function listKnowledgeTrustedAuthors(
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:author:list' }>,
): Promise<TrustedAuthor[]> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgTrustedAuthorStore({ client: pool });
    await store.migrate();
    return await store.list({
      limit: command.limit,
      ...(command.activeAt === undefined ? {} : { activeAt: command.activeAt }),
      ...(command.chatId === undefined ? {} : { chatId: command.chatId }),
    });
  } finally {
    await pool.end();
  }
}

async function trustKnowledgeAuthor(
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:author:trust' }>,
): Promise<TrustedAuthor> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgTrustedAuthorStore({ client: pool });
    await store.migrate();
    return await store.trust({
      chatId: command.chatId,
      role: command.role,
      userId: command.userId,
      validFrom: command.validFrom,
      verificationSource: command.verificationSource,
      verifiedBy: command.verifiedBy,
      ...(command.validTo === undefined ? {} : { validTo: command.validTo }),
    });
  } finally {
    await pool.end();
  }
}

async function getKnowledgeCandidateHistory(
  config: ReturnType<typeof loadRagConfig>,
  id: string,
): Promise<KnowledgeCandidateHistory> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgKnowledgeCandidateStore({ client: pool });
    await store.migrate();
    return await store.getHistory(id);
  } finally {
    await pool.end();
  }
}

async function reviseKnowledgeCandidate(
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:revise' }>,
): Promise<KnowledgeCandidate> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgKnowledgeCandidateStore({ client: pool });
    await store.migrate();
    return await store.revise({
      editedBy: command.editedBy,
      id: command.id,
      ...(command.canonicalAnswer === undefined
        ? {}
        : { canonicalAnswer: command.canonicalAnswer }),
      ...(command.evidence === undefined ? {} : { evidence: command.evidence }),
      ...(command.proposedModule === undefined ? {} : { proposedModule: command.proposedModule }),
      ...(command.proposedTitle === undefined ? {} : { proposedTitle: command.proposedTitle }),
      ...(command.question === undefined ? {} : { question: command.question }),
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    });
  } finally {
    await pool.end();
  }
}

async function reviewKnowledgeCandidate(
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:approve' | 'knowledge:reject' }>,
): Promise<KnowledgeCandidate> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const store = createPgKnowledgeCandidateStore({ client: pool });
    await store.migrate();
    if (command.command === 'knowledge:reject') {
      return await store.review({
        decision: 'reject',
        id: command.id,
        reviewedBy: command.reviewedBy,
        ...(command.note === undefined ? {} : { note: command.note }),
      });
    }
    return await store.review({
      decision: 'approve',
      id: command.id,
      reviewedBy: command.reviewedBy,
      ...(command.effectiveAt === undefined ? {} : { effectiveAt: command.effectiveAt }),
      ...(command.note === undefined ? {} : { note: command.note }),
      ...(command.sourceUrl === undefined ? {} : { sourceUrl: command.sourceUrl }),
      ...(command.supersedes === undefined ? {} : { supersedes: command.supersedes }),
    });
  } finally {
    await pool.end();
  }
}

async function publishKnowledgeCandidate(
  io: CliIo,
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:publish' }>,
): Promise<KnowledgePublicationSummary> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const candidateStore = createPgKnowledgeCandidateStore({ client: pool });
    const publicationStore = createPgKnowledgePublicationJobStore({ client: pool });
    await publicationStore.migrate();
    let publication = await publicationStore.request({
      candidateId: command.id,
      requestedBy: 'system:cli',
    });
    const candidate = await candidateStore.get(command.id);
    if (candidate === undefined) {
      throw new Error(`Knowledge candidate ${command.id} was not found.`);
    }
    const documentId = adminVerifiedDocumentId(candidate.id);
    const file = knowledgePublicationFile(io.cwd, candidate.id);
    if (publication.status === 'succeeded' || candidate.status === 'published') {
      return {
        alreadyPublished: true,
        candidateId: candidate.id,
        documentId: candidate.publishedDocumentId ?? documentId,
        file,
        jobId: publication.id,
      };
    }
    if (publication.status === 'failed') {
      publication = await publicationStore.retry({
        id: publication.id,
        requestedBy: 'system:cli',
      });
    }
    const claimed = await publicationStore.claim({
      id: publication.id,
      workerId: defaultPublicationWorkerId(),
    });
    return executeKnowledgePublicationJob(io, candidate, claimed, publicationStore);
  } finally {
    await pool.end();
  }
}

async function workKnowledgePublicationQueue(
  io: CliIo,
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:publication:work' }>,
): Promise<KnowledgePublicationSummary | undefined> {
  const pool = createPgPool(config.databaseUrl);
  try {
    const candidateStore = createPgKnowledgeCandidateStore({ client: pool });
    const publicationStore = createPgKnowledgePublicationJobStore({ client: pool });
    await publicationStore.migrate();
    const publication = await publicationStore.claimNext({
      workerId: command.workerId ?? defaultPublicationWorkerId(),
    });
    if (publication === undefined) {
      return undefined;
    }
    const candidate = await candidateStore.get(publication.candidateId);
    if (candidate === undefined) {
      await publicationStore.fail({
        attemptCount: publication.attemptCount,
        error: `Knowledge candidate ${publication.candidateId} was not found.`,
        id: publication.id,
        workerId: requirePublicationWorkerId(publication),
      });
      throw new Error(`Knowledge candidate ${publication.candidateId} was not found.`);
    }
    return executeKnowledgePublicationJob(io, candidate, publication, publicationStore);
  } finally {
    await pool.end();
  }
}

async function workKnowledgeAutomation(
  io: CliIo,
  config: ReturnType<typeof loadRagConfig>,
  command: Extract<CliCommand, { command: 'knowledge:automation:work' }>,
): Promise<KnowledgeAutomationWorkerSummary> {
  const pool = createPgPool(config.databaseUrl);
  let automation: KnowledgeAutomationRunResult;
  try {
    const candidateStore = createPgKnowledgeCandidateStore({ client: pool });
    const publicationStore = createPgKnowledgePublicationJobStore({ client: pool });
    await publicationStore.migrate();
    automation = await createKnowledgeAutomationController({
      candidateStore,
      publicationJobStore: publicationStore,
    }).reconcile({ limit: command.limit });
  } finally {
    await pool.end();
  }

  const publications: KnowledgePublicationSummary[] = [];
  for (let index = 0; index < command.limit; index += 1) {
    const publication = await workKnowledgePublicationQueue(io, config, {
      command: 'knowledge:publication:work',
      ...(command.workerId === undefined ? {} : { workerId: command.workerId }),
    });
    if (publication === undefined) {
      break;
    }
    publications.push(publication);
  }
  return { automation, publications };
}

async function executeKnowledgePublicationJob(
  io: CliIo,
  candidate: KnowledgeCandidate,
  publication: KnowledgePublicationJob,
  publicationStore: ReturnType<typeof createPgKnowledgePublicationJobStore>,
): Promise<KnowledgePublicationSummary> {
  const documentId = adminVerifiedDocumentId(candidate.id);
  const file = knowledgePublicationFile(io.cwd, candidate.id);
  const workerId = requirePublicationWorkerId(publication);
  let content: string | undefined;
  try {
    content = formatAdminVerifiedKnowledgeDocument(candidate);
    await writeKnowledgeDocumentIfAbsent(file, content);
    await runKnowledgePublicationGate(io, candidate, documentId);
    const ingestSummary = await ingest(io, false, async (client: PgClientLike, runId: string) => {
      const transactionalPublicationStore = createPgKnowledgePublicationJobStore({ client });
      await transactionalPublicationStore.complete({
        attemptCount: publication.attemptCount,
        documentId,
        id: publication.id,
        runId,
        workerId,
      });
    });
    return {
      alreadyPublished: false,
      candidateId: candidate.id,
      documentId,
      file,
      jobId: publication.id,
      ...(ingestSummary.runId === undefined ? {} : { runId: ingestSummary.runId }),
    };
  } catch (error) {
    const failed = await publicationStore
      .fail({
        attemptCount: publication.attemptCount,
        error: error instanceof Error ? error.message : String(error),
        id: publication.id,
        workerId,
      })
      .then(() => true)
      .catch(() => false);
    if (failed && content !== undefined) {
      await removeKnowledgeDocumentIfMatching(file, content);
    }
    throw error;
  }
}

function knowledgePublicationFile(cwd: string, candidateId: string): string {
  return path.resolve(cwd, 'docs', 'product-features', 'admin-verified', `${candidateId}.md`);
}

function defaultPublicationWorkerId(): string {
  return `cli:${hostname()}:${process.pid}`;
}

function requirePublicationWorkerId(publication: KnowledgePublicationJob): string {
  if (publication.status !== 'running' || publication.workerId === undefined) {
    throw new Error(`Knowledge publication job ${publication.id} has no active worker lease.`);
  }
  return publication.workerId;
}

async function writeKnowledgeDocumentIfAbsent(file: string, content: string): Promise<boolean> {
  try {
    const existing = await readFile(file, 'utf8');
    if (existing !== content) {
      throw new Error(`Knowledge document already exists with different content: ${file}`);
    }
    return false;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  return true;
}

async function removeKnowledgeDocumentIfMatching(file: string, content: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) {
      await unlink(file);
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

async function runKnowledgePublicationGate(
  io: CliIo,
  candidate: KnowledgeCandidate,
  documentId: string,
): Promise<void> {
  const classification = classifyQuestion(candidate.question);
  if (classification.intent !== 'product_qa' && classification.intent !== 'how_to') {
    throw new Error(
      `Knowledge candidate ${candidate.id} is outside product support boundaries (${classification.intent}).`,
    );
  }

  const config = loadRagConfig(io.env);
  const documents = await loadProductDocuments({ cwd: io.cwd });
  const chunks = prepareKnowledgeChunks(documents);
  const index: RagIndex = {
    builtAt: new Date(0).toISOString(),
    entries: chunks.map((chunk) => ({
      ...chunk,
      embedding: createLocalHashEmbedding(chunk.searchableText),
    })),
    version: 1,
  };
  const retriever = createRerankingRetriever(
    createLocalRetriever(index),
    createMetadataReranker(),
    { candidateMultiplier: 4 },
  );
  const retrieved = await retriever.retrieve(candidate.question, { topK: config.topK });
  if (!retrieved.some((chunk) => chunk.documentId === documentId)) {
    throw new Error(
      `Knowledge candidate ${candidate.id} failed retrieval gate: published document was not retrieved.`,
    );
  }

  const report = await evaluate(io, {
    command: 'evaluate',
    judge: false,
    providerBacked: false,
    retrievalOnly: false,
  });
  if (report.passed !== report.total) {
    const failures = report.results
      .filter((result) => !result.passed)
      .map((result) => result.name)
      .join(', ');
    throw new Error(`Knowledge candidate ${candidate.id} failed golden QA: ${failures}.`);
  }
}

function adminVerifiedDocumentId(candidateId: string): string {
  return `admin_verified:admin-verified/${candidateId}`;
}

async function embedPreparedChunks(
  chunks: PreparedKnowledgeChunk[],
  embeddingProvider: { embedTexts(texts: string[]): Promise<number[][]> },
): Promise<EmbeddedKnowledgeChunk[]> {
  const embeddedChunks: EmbeddedKnowledgeChunk[] = [];

  for (let index = 0; index < chunks.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(index, index + EMBEDDING_BATCH_SIZE);
    const embeddings = await embeddingProvider.embedTexts(
      batch.map((chunk) => chunk.searchableText),
    );
    batch.forEach((chunk, batchIndex) => {
      const embedding = embeddings[batchIndex];
      if (embedding === undefined) {
        throw new Error(`Missing embedding for chunk ${chunk.id}.`);
      }
      embeddedChunks.push({ ...chunk, embedding });
    });
  }

  return embeddedChunks;
}

function createCliChatRuntime(
  config: ReturnType<typeof loadRagConfig>,
  tracer: QualityTracer,
): CliChatRuntime {
  let pool: ReturnType<typeof createPgPool> | undefined;
  const retriever = createLazyRetriever(async () => {
    const nextPool = createPgPool(config.databaseUrl);

    try {
      const embeddingProvider = createOpenAiEmbeddingProvider({
        apiKey: config.embeddingApiKey,
        baseUrl: config.embeddingBaseUrl,
        maxRetries: config.openAiMaxRetries,
        model: config.openAiEmbeddingModel,
        requestTimeoutMs: config.openAiRequestTimeoutMs,
      });
      pool = nextPool;
      return createPgVectorStore({
        client: nextPool,
        embeddingDimension: config.embeddingDimension,
        embeddingProvider,
        tracer,
      });
    } catch (error) {
      await nextPool.end();
      throw error;
    }
  });

  return {
    retriever,
    service: createCustomerAgentChatService({
      answerProvider: createLazyAnswerProvider(config, tracer),
      config,
      productCapabilityCaller: {
        channel: 'cli',
        principal: 'user',
      },
      retriever,
      tracer,
    }),
    close: async () => {
      const currentPool = pool;
      pool = undefined;
      await currentPool?.end();
    },
  };
}

function createLazyAnswerProvider(
  config: ReturnType<typeof loadRagConfig>,
  tracer: QualityTracer,
): AnswerProvider {
  let cachedProvider: AnswerProvider | undefined;

  function getProvider(): AnswerProvider {
    cachedProvider ??= createOpenAiAnswerProvider({
      apiKey: config.openAiApiKey,
      baseUrl: config.openAiBaseUrl,
      maxRetries: config.openAiMaxRetries,
      model: config.openAiModel,
      requestTimeoutMs: config.openAiRequestTimeoutMs,
      tracer,
    });
    return cachedProvider;
  }

  return {
    answer(input) {
      return getProvider().answer(input);
    },
    stream(input) {
      const provider = getProvider();
      if (provider.stream === undefined) {
        throw new Error('Answer provider does not support streaming.');
      }
      return provider.stream(input);
    },
  };
}

function createIngestionRun(input: {
  chunks: EmbeddedKnowledgeChunk[];
  documentCount: number;
  source?: string;
}): {
  chunkCount: number;
  contentHash: string;
  documentCount: number;
  runId: string;
  source: string;
  sourceCounts: Partial<Record<EmbeddedKnowledgeChunk['metadata']['sourceType'], number>>;
} {
  const contentHash = createKnowledgeContentHash(input.chunks);

  return {
    chunkCount: input.chunks.length,
    contentHash,
    documentCount: input.documentCount,
    runId: createIngestionRunId(contentHash),
    source: input.source ?? 'cli',
    sourceCounts: countChunksBySource(input.chunks),
  };
}

function createKnowledgeContentHash(chunks: EmbeddedKnowledgeChunk[]): string {
  const hash = createHash('sha256');
  for (const chunk of [...chunks].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(chunk.id);
    hash.update('\0');
    hash.update(chunk.contentHash);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function createIngestionRunId(contentHash: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}/u, '');
  return `ingest_${timestamp}_${contentHash.slice(0, 8)}`;
}

function countChunksBySource(
  chunks: EmbeddedKnowledgeChunk[],
): Partial<Record<EmbeddedKnowledgeChunk['metadata']['sourceType'], number>> {
  const counts: Partial<Record<EmbeddedKnowledgeChunk['metadata']['sourceType'], number>> = {};

  for (const chunk of chunks) {
    counts[chunk.metadata.sourceType] = (counts[chunk.metadata.sourceType] ?? 0) + 1;
  }

  return counts;
}

function writeLine(stream: Pick<NodeJS.WriteStream, 'write'>, message: string): void {
  stream.write(`${message}\n`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function writeConfigurationError(io: CliIo, error: unknown): boolean {
  if (error instanceof AnswerJudgeConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  if (error instanceof LlmConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  if (error instanceof EmbeddingConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  if (error instanceof VectorStoreConfigurationError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  if (error instanceof VectorStoreUnavailableError) {
    writeLine(io.stderr, error.message);
    return true;
  }

  return false;
}

function isDirectRun(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }

  return path.resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    const exitCode = await runCli();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
