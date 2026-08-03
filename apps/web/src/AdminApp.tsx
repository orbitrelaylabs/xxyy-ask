import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactElement } from 'react';

import {
  KnowledgeAdminApiError,
  knowledgeAdminLogin,
  knowledgeAdminRequest,
  knowledgeAdminSetup,
  knowledgeAdminSetupStatus,
} from './admin-api.js';
import type {
  AdminPermission,
  AdminSession,
  AdminUser,
  CandidateDetail,
  CandidateStatus,
  KnowledgeCandidate,
  KnowledgeCandidateImprovementSuggestion,
  KnowledgeCurationMode,
  KnowledgeGapRecord,
  KnowledgeGraphEntity,
  KnowledgeGraphConflict,
  KnowledgeGraphRelation,
  KnowledgeGraphRelationStatus,
  PublicationJob,
  PublicationStatus,
  QualityEvaluationJob,
  QualityEvaluationMode,
  QualityEvaluationReport,
  QualityTrend,
  SupportConversation,
  SupportConversationMessage,
  SupportOperationsMetrics,
  SupportTicket,
  SupportTicketPriority,
  SupportTicketStatus,
  TelegramImportResult,
  TelegramGroupRegistryEntry,
  TrustedAuthor,
} from './admin-types.js';

const ADMIN_TOKEN_STORAGE_KEY = 'xxyy.knowledgeAdmin.token';
type AdminTab =
  | 'account'
  | 'authors'
  | 'candidates'
  | 'groups'
  | 'graph'
  | 'imports'
  | 'publications'
  | 'quality'
  | 'support'
  | 'users';

export function AdminApp(): ReactElement {
  const [token, setToken] = useState(readStoredToken);
  const [session, setSession] = useState<AdminSession | undefined>();
  const [authBusy, setAuthBusy] = useState(true);
  const [authError, setAuthError] = useState<string | undefined>();
  const [setupRequired, setSetupRequired] = useState<boolean>();
  const [activeTab, setActiveTab] = useState<AdminTab>('candidates');

  const authenticate = useCallback(async (id: string, password: string): Promise<void> => {
    if (id.trim().length === 0 || password.length === 0) {
      setAuthError('请输入管理员账号和密码。');
      return;
    }
    setAuthBusy(true);
    setAuthError(undefined);
    try {
      const login = await knowledgeAdminLogin(id.trim(), password);
      const nextSession: AdminSession = {
        permissions: login.permissions as AdminPermission[],
        principal: login.principal as AdminSession['principal'],
      };
      setToken(login.sessionToken);
      setSession(nextSession);
      setSetupRequired(false);
      storeToken(login.sessionToken);
    } catch (error) {
      clearStoredToken();
      setSession(undefined);
      setToken('');
      setAuthError(errorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const setup = useCallback(
    async (id: string, displayName: string, password: string): Promise<void> => {
      setAuthBusy(true);
      setAuthError(undefined);
      try {
        const result = await knowledgeAdminSetup({ displayName, id, password });
        const nextSession: AdminSession = {
          permissions: result.permissions as AdminPermission[],
          principal: result.principal as AdminSession['principal'],
        };
        setToken(result.sessionToken);
        setSession(nextSession);
        setSetupRequired(false);
        storeToken(result.sessionToken);
      } catch (error) {
        setAuthError(errorMessage(error));
        if (
          error instanceof KnowledgeAdminApiError &&
          error.code === 'knowledge_admin_setup_complete'
        ) {
          setSetupRequired(false);
        }
      } finally {
        setAuthBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    const storedToken = readStoredToken();
    if (storedToken.length > 0) {
      void knowledgeAdminRequest<AdminSession>(storedToken, '/me')
        .then(setSession)
        .catch((error: unknown) => {
          clearStoredToken();
          setToken('');
          setAuthError(errorMessage(error));
          return knowledgeAdminSetupStatus().then((status) =>
            setSetupRequired(status.setupRequired),
          );
        })
        .finally(() => setAuthBusy(false));
    } else {
      void knowledgeAdminSetupStatus()
        .then((status) => setSetupRequired(status.setupRequired))
        .catch((error: unknown) => setAuthError(errorMessage(error)))
        .finally(() => setAuthBusy(false));
    }
  }, []);

  const logout = (): void => {
    if (token.length > 0) {
      void knowledgeAdminRequest(token, '/auth/logout', { method: 'POST' }).catch(() => undefined);
    }
    clearStoredToken();
    setSession(undefined);
    setToken('');
    setAuthError(undefined);
  };

  if (session === undefined) {
    if (setupRequired === true) {
      return <AdminSetup busy={authBusy} error={authError} onSetup={setup} />;
    }
    return <AdminLogin busy={authBusy} error={authError} onLogin={authenticate} />;
  }

  const permissions = new Set(session.permissions);
  return (
    <main className="admin-shell">
      <AdminSidebar
        activeTab={activeTab}
        onLogout={logout}
        onSelectTab={setActiveTab}
        session={session}
      />
      <section className="admin-workbench">
        <header className="admin-header">
          <div>
            <div className="admin-eyebrow">Knowledge Governance</div>
            <h1>{tabTitle(activeTab)}</h1>
          </div>
          <div className="admin-boundary-badge">受保护管理面 · 严格策略自动治理</div>
        </header>
        <div className="admin-content">
          {activeTab === 'candidates' ? (
            <CandidatesPanel permissions={permissions} token={token} />
          ) : undefined}
          {activeTab === 'publications' ? (
            <PublicationsPanel permissions={permissions} token={token} />
          ) : undefined}
          {activeTab === 'quality' ? (
            <QualityEvaluationPanel permissions={permissions} token={token} />
          ) : undefined}
          {activeTab === 'authors' ? (
            <TrustedAuthorsPanel permissions={permissions} token={token} />
          ) : undefined}
          {activeTab === 'imports' ? (
            <TelegramImportPanel permissions={permissions} token={token} />
          ) : undefined}
          {activeTab === 'groups' ? <TelegramGroupsPanel token={token} /> : undefined}
          {activeTab === 'graph' ? (
            <KnowledgeGraphPanel permissions={permissions} token={token} />
          ) : undefined}
          {activeTab === 'users' ? (
            <AdminUsersPanel
              currentUserId={session.principal.id}
              permissions={permissions}
              token={token}
            />
          ) : undefined}
          {activeTab === 'account' ? <MyAccountPanel token={token} /> : undefined}
          {activeTab === 'support' ? (
            <SupportPanel permissions={permissions} token={token} />
          ) : undefined}
        </div>
      </section>
    </main>
  );
}

function SupportPanel({
  permissions,
  token,
}: {
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [metrics, setMetrics] = useState<SupportOperationsMetrics>();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [knowledgeGaps, setKnowledgeGaps] = useState<KnowledgeGapRecord[]>([]);
  const [qualityTrend, setQualityTrend] = useState<QualityTrend>();
  const [selectedId, setSelectedId] = useState<string>();
  const [conversation, setConversation] = useState<SupportConversation>();
  const [messages, setMessages] = useState<SupportConversationMessage[]>([]);
  const [statusFilter, setStatusFilter] = useState<SupportTicketStatus | ''>('');
  const [assignedTo, setAssignedTo] = useState('');
  const [priority, setPriority] = useState<SupportTicketPriority>('normal');
  const [ticketStatus, setTicketStatus] = useState<SupportTicketStatus>('open');
  const [resolution, setResolution] = useState('');
  const [reply, setReply] = useState('');
  const [deletedSourceChatId, setDeletedSourceChatId] = useState('');
  const [deletedSourceMessageId, setDeletedSourceMessageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string }>();
  const selected = tickets.find((ticket) => ticket.id === selectedId);

  const loadQueue = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const query = statusFilter === '' ? '' : `?status=${statusFilter}`;
      const [metricsResult, ticketResult, gapResult] = await Promise.all([
        knowledgeAdminRequest<{ metrics: SupportOperationsMetrics }>(token, '/support/metrics'),
        knowledgeAdminRequest<{ tickets: SupportTicket[] }>(token, `/support/tickets${query}`),
        knowledgeAdminRequest<{ gaps: KnowledgeGapRecord[]; trend: QualityTrend }>(
          token,
          '/support/knowledge-gaps',
        ),
      ]);
      setMetrics(metricsResult.metrics);
      setTickets(ticketResult.tickets);
      setKnowledgeGaps(gapResult.gaps);
      setQualityTrend(gapResult.trend);
      setSelectedId((current) =>
        current !== undefined && ticketResult.tickets.some((ticket) => ticket.id === current)
          ? current
          : ticketResult.tickets[0]?.id,
      );
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [statusFilter, token]);

  const loadConversation = useCallback(async (): Promise<void> => {
    if (selected === undefined) {
      setConversation(undefined);
      setMessages([]);
      return;
    }
    try {
      const result = await knowledgeAdminRequest<{
        conversation: SupportConversation;
        messages: SupportConversationMessage[];
      }>(
        token,
        `/support/conversations/${encodeURIComponent(selected.conversationId)}/messages?limit=50`,
      );
      setConversation(result.conversation);
      setMessages(result.messages);
      setAssignedTo(selected.assignedTo ?? '');
      setPriority(selected.priority);
      setTicketStatus(selected.status);
      setResolution(selected.resolution ?? '');
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    }
  }, [selected, token]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);
  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  const save = async (): Promise<void> => {
    if (selected === undefined || !permissions.has('support:manage')) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await knowledgeAdminRequest<{ ticket: SupportTicket }>(
        token,
        `/support/tickets/${encodeURIComponent(selected.id)}`,
        {
          body: {
            assignedTo: assignedTo.trim() === '' ? null : assignedTo.trim(),
            priority,
            resolution: resolution.trim(),
            status: ticketStatus,
          },
          method: 'PATCH',
        },
      );
      await loadQueue();
      setNotice({ kind: 'success', text: '工单已更新，并写入审计记录。' });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async (): Promise<void> => {
    if (selected === undefined || reply.trim().length === 0 || !permissions.has('support:manage')) {
      return;
    }
    setBusy(true);
    try {
      await knowledgeAdminRequest<{ message: SupportConversationMessage }>(
        token,
        `/support/conversations/${encodeURIComponent(selected.conversationId)}/messages`,
        { body: { content: reply.trim() }, method: 'POST' },
      );
      setReply('');
      await loadConversation();
      setNotice({ kind: 'success', text: '人工回复已写入会话，Web 用户将自动收到。' });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const retractDeletedTelegramSource = async (): Promise<void> => {
    if (
      !permissions.has('candidate:review') ||
      deletedSourceChatId.trim().length === 0 ||
      deletedSourceMessageId.trim().length === 0
    ) {
      return;
    }
    setBusy(true);
    try {
      const result = await knowledgeAdminRequest<{
        publishedCandidateIds: string[];
        retractedCandidateIds: string[];
      }>(token, '/support/telegram-sources/retract', {
        body: {
          messageId: deletedSourceMessageId.trim(),
          sourceChatId: deletedSourceChatId.trim(),
        },
        method: 'POST',
      });
      setDeletedSourceMessageId('');
      setNotice({
        kind: 'success',
        text: `已撤回 ${result.retractedCandidateIds.length} 个候选；其中 ${result.publishedCandidateIds.length} 个已发布文档已写 tombstone。`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-stack">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h2>客服运营概览</h2>
            <span>仅展示已脱敏的持久化会话与工单</span>
          </div>
          <button
            className="admin-secondary-button"
            disabled={busy}
            onClick={() => void loadQueue()}
            type="button"
          >
            刷新
          </button>
        </div>
        <div className="metric-grid support-metrics">
          <Metric label="活跃会话" value={metrics?.activeConversationCount ?? 0} />
          <Metric label="待处理工单" value={metrics?.openTicketCount ?? 0} />
          <Metric label="未分配" value={metrics?.unassignedTicketCount ?? 0} />
          <Metric label="等待用户" value={metrics?.waitingUserTicketCount ?? 0} />
        </div>
      </section>
      {notice === undefined ? undefined : (
        <div className={`admin-alert ${notice.kind}`}>{notice.text}</div>
      )}

      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h2>知识缺口信号</h2>
            <span>差评或无引用回答，仅进入检查队列，不会直接写入正式知识库</span>
          </div>
          <span>{knowledgeGaps.length} 条</span>
        </div>
        <div className="knowledge-gap-list">
          <div className="metric-grid support-metrics">
            <Metric label="诊断样本" value={qualityTrend?.sampleSize ?? 0} />
            <Metric label="检索问题" value={qualityTrend?.categoryCounts.retrieval ?? 0} />
            <Metric label="知识冲突" value={qualityTrend?.answerStatusCounts.conflict ?? 0} />
            <Metric label="证据不足" value={qualityTrend?.answerStatusCounts.insufficient ?? 0} />
          </div>
          {knowledgeGaps.slice(0, 12).map((gap) => (
            <article key={`${gap.createdAt}:${gap.sessionId ?? ''}:${gap.question}`}>
              <div>
                <StatusBadge status={gap.rating} />
                <span>
                  {qualityCategoryLabel(gap.diagnosis.category)} · {gap.citationCount} 个引用 ·{' '}
                  {gap.failureReason === undefined
                    ? ''
                    : `${feedbackFailureReasonLabel(gap.failureReason)} · `}
                  {formatDate(gap.createdAt)}
                </span>
              </div>
              <strong>{gap.question}</strong>
              <p>{gap.answer}</p>
              <small>
                {gap.diagnosis.reason}；建议：{gap.diagnosis.recommendedAction}
              </small>
              <details>
                <summary>查看诊断路径</summary>
                <dl>
                  <dt>问题理解</dt>
                  <dd>
                    {gap.quality.understanding.kind} · {gap.quality.understanding.subject} ·{' '}
                    {gap.quality.understanding.temporalScope}
                  </dd>
                  <dt>证据状态</dt>
                  <dd>
                    {gap.quality.evidence.answerStatus} · 覆盖 {gap.quality.evidence.coverageState}{' '}
                    · 停止原因 {gap.quality.evidence.stopReason}
                  </dd>
                  <dt>来源策略</dt>
                  <dd>{gap.quality.retrievalPolicy.preferredSourceTypes.join(' → ')}</dd>
                  <dt>Query Plan</dt>
                  <dd>
                    <ol>
                      {gap.quality.queryPlan.queries.map((query) => (
                        <li key={`${query.facet ?? 'query'}:${query.query}`}>
                          {query.facet === undefined ? '' : `${query.facet}：`}
                          {query.query}
                        </li>
                      ))}
                    </ol>
                  </dd>
                  <dt>子问题</dt>
                  <dd>
                    {(gap.quality.queryPlan.subquestions ?? [])
                      .map((subquestion) => subquestion.question)
                      .join('；') || '单一问题'}
                  </dd>
                  <dt>实际来源</dt>
                  <dd>
                    {gap.quality.evidence.sourceObservation === 'unavailable'
                      ? '旧反馈未持久化来源明细'
                      : gap.quality.evidence.observedSourceTypes.join('、')}
                  </dd>
                </dl>
              </details>
            </article>
          ))}
          {knowledgeGaps.length === 0 ? <p>当前没有待检查的知识缺口信号。</p> : undefined}
        </div>
      </section>

      <section className="admin-panel">
        <SectionHeading
          description="Telegram Bot API 不提供普通群消息删除事件；管理员确认来源已删除后，可按群 ID 和消息 ID 安全撤回。"
          title="Telegram 删除对账"
        />
        <div className="admin-form-grid">
          <label>
            群 ID
            <input
              disabled={!permissions.has('candidate:review')}
              onChange={(event) => setDeletedSourceChatId(event.target.value)}
              placeholder="-1001234567890"
              value={deletedSourceChatId}
            />
          </label>
          <label>
            被删除的答案消息 ID
            <input
              disabled={!permissions.has('candidate:review')}
              onChange={(event) => setDeletedSourceMessageId(event.target.value)}
              placeholder="12345"
              value={deletedSourceMessageId}
            />
          </label>
        </div>
        <div className="admin-actions">
          <button
            className="admin-danger-button"
            disabled={
              busy ||
              !permissions.has('candidate:review') ||
              deletedSourceChatId.trim().length === 0 ||
              deletedSourceMessageId.trim().length === 0
            }
            onClick={() => void retractDeletedTelegramSource()}
            type="button"
          >
            确认来源已删除并撤回
          </button>
        </div>
      </section>

      <div className="candidate-layout support-layout">
        <section className="admin-panel candidate-list-panel">
          <div className="admin-panel-header">
            <div>
              <h2>工单队列</h2>
              <span>{tickets.length} 条</span>
            </div>
            <select
              aria-label="工单状态"
              onChange={(event) => setStatusFilter(event.target.value as SupportTicketStatus | '')}
              value={statusFilter}
            >
              <option value="">全部状态</option>
              <option value="open">待处理</option>
              <option value="in_progress">处理中</option>
              <option value="waiting_user">等待用户</option>
              <option value="resolved">已解决</option>
              <option value="closed">已关闭</option>
            </select>
          </div>
          <div className="candidate-list">
            {tickets.map((ticket) => (
              <button
                className={ticket.id === selectedId ? 'candidate-card selected' : 'candidate-card'}
                key={ticket.id}
                onClick={() => setSelectedId(ticket.id)}
                type="button"
              >
                <div className="candidate-card-topline">
                  <StatusBadge status={ticket.status} />
                  <span>{ticket.priority}</span>
                </div>
                <strong>{ticket.subject}</strong>
                <div className="candidate-card-meta">
                  <span>{ticket.assignedTo ?? '未分配'}</span>
                  <span>{formatDate(ticket.createdAt)}</span>
                </div>
              </button>
            ))}
            {!busy && tickets.length === 0 ? (
              <p className="admin-empty">当前筛选条件下没有工单。</p>
            ) : undefined}
          </div>
        </section>

        <div className="admin-stack">
          {selected === undefined ? (
            <section className="admin-panel">
              <p>选择一条工单查看对话并进行处理。</p>
            </section>
          ) : (
            <>
              <section className="admin-panel">
                <SectionHeading
                  description={`${selected.reason} · ${conversation?.channel ?? 'unknown'} · ${selected.id}`}
                  title={selected.subject}
                />
                <div className="support-transcript">
                  {messages.map((message) => (
                    <article className={`support-message role-${message.role}`} key={message.id}>
                      <div>
                        <strong>{supportRoleLabel(message.role)}</strong>
                        <span>{formatDate(message.createdAt)}</span>
                      </div>
                      <p>{message.content}</p>
                    </article>
                  ))}
                  {messages.length === 0 ? <p>暂无可展示的会话消息。</p> : undefined}
                </div>
                <div className="support-reply-composer">
                  <textarea
                    disabled={!permissions.has('support:manage')}
                    onChange={(event) => setReply(event.target.value)}
                    placeholder="输入给用户的人工回复"
                    value={reply}
                  />
                  <button
                    className="admin-primary-button"
                    disabled={
                      busy || reply.trim().length === 0 || !permissions.has('support:manage')
                    }
                    onClick={() => void sendReply()}
                    type="button"
                  >
                    发送人工回复
                  </button>
                </div>
              </section>
              <section className="admin-panel">
                <SectionHeading
                  description="状态变更、指派与处理结论会写入工单审计日志"
                  title="处理工单"
                />
                <div className="admin-form-grid">
                  <label>
                    指派给
                    <input
                      disabled={!permissions.has('support:manage')}
                      onChange={(event) => setAssignedTo(event.target.value)}
                      placeholder="客服账号或团队"
                      value={assignedTo}
                    />
                  </label>
                  <label>
                    优先级
                    <select
                      disabled={!permissions.has('support:manage')}
                      onChange={(event) => setPriority(event.target.value as SupportTicketPriority)}
                      value={priority}
                    >
                      <option value="low">低</option>
                      <option value="normal">普通</option>
                      <option value="high">高</option>
                      <option value="urgent">紧急</option>
                    </select>
                  </label>
                  <label>
                    状态
                    <select
                      disabled={!permissions.has('support:manage')}
                      onChange={(event) =>
                        setTicketStatus(event.target.value as SupportTicketStatus)
                      }
                      value={ticketStatus}
                    >
                      <option value="open">待处理</option>
                      <option value="in_progress">处理中</option>
                      <option value="waiting_user">等待用户</option>
                      <option value="resolved">已解决</option>
                      <option value="closed">已关闭</option>
                    </select>
                  </label>
                  <label className="span-2">
                    处理结论
                    <textarea
                      disabled={!permissions.has('support:manage')}
                      onChange={(event) => setResolution(event.target.value)}
                      value={resolution}
                    />
                  </label>
                </div>
                <div className="admin-actions">
                  <button
                    className="admin-primary-button"
                    disabled={busy || !permissions.has('support:manage')}
                    onClick={() => void save()}
                    type="button"
                  >
                    保存处理结果
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function qualityCategoryLabel(category: KnowledgeGapRecord['diagnosis']['category']): string {
  switch (category) {
    case 'boundary':
      return '边界';
    case 'classification':
      return '分类';
    case 'generation':
      return '生成';
    case 'knowledge':
      return '知识';
    case 'retrieval':
      return '检索';
  }
}

function feedbackFailureReasonLabel(
  reason: NonNullable<KnowledgeGapRecord['failureReason']>,
): string {
  const labels: Record<NonNullable<KnowledgeGapRecord['failureReason']>, string> = {
    context_misunderstood: '误解上下文',
    incorrect: '事实错误',
    incorrect_steps: '步骤错误',
    incomplete: '回答不完整',
    knowledge_conflict: '知识冲突',
    knowledge_missing: '知识缺失',
    off_topic: '答非所问',
    other: '其他问题',
    outdated: '内容过时',
    too_verbose: '回答啰嗦',
    unsupported_citation: '引用不支持结论',
  };
  return labels[reason] ?? reason;
}

function supportRoleLabel(role: SupportConversationMessage['role']): string {
  switch (role) {
    case 'assistant':
      return 'Agent';
    case 'support_agent':
      return '人工客服';
    case 'system':
      return '系统';
    case 'user':
      return '用户';
  }
}

function AdminSetup({
  busy,
  error,
  onSetup,
}: {
  busy: boolean;
  error: string | undefined;
  onSetup: (id: string, displayName: string, password: string) => Promise<void>;
}): ReactElement {
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validationError, setValidationError] = useState<string>();

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (password !== confirmation) {
      setValidationError('两次输入的密码不一致。');
      return;
    }
    setValidationError(undefined);
    void onSetup(id.trim(), displayName.trim(), password);
  };

  return (
    <main className="admin-login-page">
      <section className="admin-login-card" aria-labelledby="admin-setup-title">
        <div className="admin-login-mark">XY</div>
        <div className="admin-eyebrow">First-run setup</div>
        <h1 id="admin-setup-title">创建首个管理员</h1>
        <p>数据库当前没有管理员。该页面只在首次初始化时开放，创建成功后自动关闭。</p>
        <form onSubmit={submit}>
          <label htmlFor="setup-admin-id">管理员账号</label>
          <input
            autoComplete="username"
            id="setup-admin-id"
            onChange={(event) => setId(event.target.value)}
            required
            value={id}
          />
          <label htmlFor="setup-display-name">显示名称</label>
          <input
            id="setup-display-name"
            onChange={(event) => setDisplayName(event.target.value)}
            required
            value={displayName}
          />
          <label htmlFor="setup-password">密码</label>
          <input
            autoComplete="new-password"
            id="setup-password"
            minLength={12}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <label htmlFor="setup-password-confirmation">确认密码</label>
          <input
            autoComplete="new-password"
            id="setup-password-confirmation"
            minLength={12}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            type="password"
            value={confirmation}
          />
          {validationError === undefined ? undefined : (
            <div className="admin-alert error">{validationError}</div>
          )}
          {error === undefined ? undefined : <div className="admin-alert error">{error}</div>}
          <button className="admin-primary-button" disabled={busy} type="submit">
            {busy ? '正在创建…' : '创建并登录'}
          </button>
        </form>
        <div className="admin-security-note">密码只以 scrypt 哈希写入 PostgreSQL，不保存明文。</div>
      </section>
    </main>
  );
}

function AdminLogin({
  busy,
  error,
  onLogin,
}: {
  busy: boolean;
  error: string | undefined;
  onLogin: (id: string, password: string) => Promise<void>;
}): ReactElement {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void onLogin(id, password);
  };

  return (
    <main className="admin-login-page">
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <div className="admin-login-mark">XY</div>
        <div className="admin-eyebrow">XXYY Knowledge Governance</div>
        <h1 id="admin-login-title">知识库管理后台</h1>
        <p>使用数据库管理员账号登录。密码只用于本次认证，登录会话可以随时撤销。</p>
        <form onSubmit={submit}>
          <label htmlFor="admin-id">管理员账号</label>
          <input
            autoComplete="username"
            id="admin-id"
            onChange={(event) => setId(event.target.value)}
            placeholder="例如 local-admin"
            value={id}
          />
          <label htmlFor="admin-password">密码</label>
          <input
            autoComplete="current-password"
            id="admin-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入管理员密码"
            type="password"
            value={password}
          />
          {error === undefined ? undefined : <div className="admin-alert error">{error}</div>}
          <button className="admin-primary-button" disabled={busy} type="submit">
            {busy ? '正在验证…' : '进入管理后台'}
          </button>
        </form>
        <div className="admin-security-note">
          新管理员、角色和密码均由登录后的管理员用户页面维护。
        </div>
      </section>
    </main>
  );
}

function AdminSidebar({
  activeTab,
  onLogout,
  onSelectTab,
  session,
}: {
  activeTab: AdminTab;
  onLogout: () => void;
  onSelectTab: (tab: AdminTab) => void;
  session: AdminSession;
}): ReactElement {
  const tabs: Array<{ id: AdminTab; label: string; meta: string }> = [
    { id: 'account', label: '我的账号', meta: '修改本人登录密码' },
    { id: 'support', label: '客服工作台', meta: '会话、工单与人工接管' },
    { id: 'groups', label: 'Telegram 群聊', meta: 'Bot 加群状态与活跃时间' },
    ...(session.permissions.includes('user:manage')
      ? ([{ id: 'users', label: '管理员用户', meta: '账号、角色与启停状态' }] as const)
      : []),
    { id: 'candidates', label: '知识候选', meta: '群聊审核与冲突检查' },
    { id: 'graph', label: '知识图谱', meta: '实体关系、证据与启停治理' },
    { id: 'publications', label: '发布任务', meta: '自动队列与故障观察' },
    { id: 'quality', label: '回答质量', meta: '评测指标、失败案例与基线' },
    { id: 'authors', label: '可信作者', meta: 'Telegram 角色有效期' },
    { id: 'imports', label: 'Telegram 导入', meta: '自动清洗、决策与入队' },
  ];
  return (
    <aside className="admin-sidebar">
      <div className="admin-brand">
        <div className="admin-brand-mark">XY</div>
        <div>
          <strong>XXYY Admin</strong>
          <span>Knowledge Control Plane</span>
        </div>
      </div>
      <nav aria-label="知识库管理导航">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab.id ? 'admin-nav-item active' : 'admin-nav-item'}
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            type="button"
          >
            <strong>{tab.label}</strong>
            <span>{tab.meta}</span>
          </button>
        ))}
      </nav>
      <div className="admin-profile">
        <div>
          <strong>{session.principal.displayName}</strong>
          <span>
            {session.principal.id} · {session.principal.role}
          </span>
        </div>
        <button onClick={onLogout} type="button">
          退出
        </button>
      </div>
    </aside>
  );
}

function QualityEvaluationPanel({
  permissions,
  token,
}: {
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [jobs, setJobs] = useState<QualityEvaluationJob[]>([]);
  const [reports, setReports] = useState<QualityEvaluationReport[]>([]);
  const [selectedReportId, setSelectedReportId] = useState<string>();
  const [withJudge, setWithJudge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string }>();
  const selectedReport = reports.find((report) => report.id === selectedReportId) ?? reports[0];

  const load = useCallback(async (): Promise<void> => {
    if (!permissions.has('quality:read')) return;
    try {
      const result = await knowledgeAdminRequest<{
        jobs: QualityEvaluationJob[];
        reports: QualityEvaluationReport[];
      }>(token, '/quality/overview');
      setJobs(result.jobs);
      setReports(result.reports);
      setSelectedReportId((current) =>
        current !== undefined && result.reports.some((report) => report.id === current)
          ? current
          : result.reports[0]?.id,
      );
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    }
  }, [permissions, token]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!jobs.some((job) => job.status === 'queued' || job.status === 'running')) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [jobs, load]);

  const run = async (mode: QualityEvaluationMode): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await knowledgeAdminRequest<{ job: QualityEvaluationJob }>(
        token,
        '/quality/jobs',
        {
          body: { mode, ...(mode === 'provider' ? { withJudge } : {}) },
          method: 'POST',
        },
      );
      await load();
      setNotice({
        kind: 'success',
        text:
          result.job.status === 'queued'
            ? '评测任务已进入隔离 Worker 队列。'
            : '同类型评测已在队列中，未重复创建。',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const approveBaseline = async (): Promise<void> => {
    if (selectedReport === undefined) return;
    setBusy(true);
    try {
      await knowledgeAdminRequest(
        token,
        `/quality/reports/${encodeURIComponent(selectedReport.id)}/baseline`,
        { method: 'POST' },
      );
      await load();
      setNotice({ kind: 'success', text: '该报告已批准为同模式的新质量基线。' });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const latest = reports[0];
  return (
    <div className="admin-stack">
      {notice === undefined ? undefined : (
        <div className={`admin-alert ${notice.kind}`}>{notice.text}</div>
      )}
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h2>回答质量中心</h2>
            <span>评测由独立本地 Worker 执行；页面不会执行任意命令</span>
          </div>
          <button className="admin-secondary-button" disabled={busy} onClick={() => void load()}>
            刷新
          </button>
        </div>
        <div className="metric-grid">
          <Metric
            label="用例通过率"
            value={latest === undefined ? 0 : Math.round(latest.metrics.casePassRate * 100)}
          />
          <Metric label="Recall ×100" value={Math.round((latest?.metrics.recallAtK ?? 0) * 100)} />
          <Metric
            label="MRR ×100"
            value={Math.round((latest?.metrics.meanReciprocalRank ?? 0) * 100)}
          />
          <Metric label="错误知识命中" value={latest?.metrics.forbiddenHitCount ?? 0} />
          <Metric
            label="Judge 正确性 ×100"
            value={Math.round((latest?.metrics.averageCorrectness ?? 0) * 100)}
          />
          <Metric label="失败案例" value={latest?.failures.length ?? 0} />
          <Metric label="P95 延迟 ms" value={Math.round(latest?.metrics.p95LatencyMs ?? 0)} />
        </div>
      </section>

      <section className="admin-panel">
        <SectionHeading
          description="快速评测不调用外部模型；正式召回会调用 Embedding；完整 Agent 会调用正式回答模型并产生费用。"
          title="运行评测"
        />
        <div className="admin-actions">
          <button
            className="admin-primary-button"
            disabled={busy || !permissions.has('quality:run')}
            onClick={() => void run('deterministic')}
            type="button"
          >
            运行快速评测
          </button>
          <button
            className="admin-secondary-button"
            disabled={busy || !permissions.has('quality:run')}
            onClick={() => void run('provider_retrieval')}
            type="button"
          >
            运行正式召回评测
          </button>
          <button
            className="admin-secondary-button"
            disabled={busy || !permissions.has('quality:run')}
            onClick={() => void run('provider')}
            type="button"
          >
            运行完整 Agent 评测
          </button>
          <label>
            <input
              checked={withJudge}
              disabled={!permissions.has('quality:run')}
              onChange={(event) => setWithJudge(event.target.checked)}
              type="checkbox"
            />{' '}
            完整评测增加独立 Judge（额外费用）
          </label>
        </div>
      </section>

      <section className="admin-panel">
        <SectionHeading description="任务自动刷新；失败只展示脱敏错误码。" title="评测任务" />
        <div className="publication-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>模式</th>
                <th>状态</th>
                <th>请求人</th>
                <th>时间</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>{qualityModeLabel(job.mode, job.withJudge)}</td>
                  <td>
                    <StatusBadge status={job.status} />
                  </td>
                  <td>{job.requestedBy}</td>
                  <td>{formatDate(job.createdAt)}</td>
                  <td>{job.errorCode ?? (job.reportId === undefined ? '—' : '报告已生成')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {jobs.length === 0 ? <p>暂无评测任务。</p> : undefined}
        </div>
      </section>

      <div className="candidate-layout">
        <section className="admin-panel candidate-list-panel">
          <SectionHeading description="点击报告查看指标、门禁和失败案例。" title="历史报告" />
          <div className="candidate-list">
            {reports.map((report) => (
              <button
                className={selectedReport?.id === report.id ? 'active' : undefined}
                key={report.id}
                onClick={() => setSelectedReportId(report.id)}
                type="button"
              >
                <strong>{qualityModeLabel(report.mode, report.withJudge)}</strong>
                <span>
                  {report.passedCases}/{report.totalCases} · {report.gatesPassed ? 'PASS' : 'FAIL'}
                </span>
                <small>
                  {formatDate(report.generatedAt)}
                  {report.isBaseline ? ' · 当前基线' : ''}
                </small>
              </button>
            ))}
          </div>
        </section>
        <section className="admin-panel">
          {selectedReport === undefined ? (
            <p>暂无评测报告。</p>
          ) : (
            <QualityReportDetail
              busy={busy}
              canApproveBaseline={permissions.has('quality:baseline')}
              onApproveBaseline={approveBaseline}
              report={selectedReport}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function QualityReportDetail({
  busy,
  canApproveBaseline,
  onApproveBaseline,
  report,
}: {
  busy: boolean;
  canApproveBaseline: boolean;
  onApproveBaseline: () => Promise<void>;
  report: QualityEvaluationReport;
}): ReactElement {
  return (
    <div className="admin-stack">
      <div className="admin-panel-header">
        <div>
          <h2>{qualityModeLabel(report.mode, report.withJudge)}</h2>
          <span>{formatDate(report.generatedAt)}</span>
        </div>
        <StatusBadge status={report.gatesPassed ? 'passed' : 'failed'} />
      </div>
      <div className="metric-grid">
        <Metric label="通过" value={report.passedCases} />
        <Metric label="总数" value={report.totalCases} />
        <Metric label="Recall ×100" value={Math.round((report.metrics.recallAtK ?? 0) * 100)} />
        <Metric
          label="Precision ×100"
          value={Math.round((report.metrics.precisionAtK ?? 0) * 100)}
        />
        <Metric
          label="MRR ×100"
          value={Math.round((report.metrics.meanReciprocalRank ?? 0) * 100)}
        />
        <Metric label="nDCG ×100" value={Math.round((report.metrics.ndcgAtK ?? 0) * 100)} />
        <Metric label="P50 ms" value={Math.round(report.metrics.p50LatencyMs ?? 0)} />
        <Metric label="Token" value={report.metrics.totalTokens ?? 0} />
        <Metric
          label="Judge 正确性 ×100"
          value={Math.round((report.metrics.averageCorrectness ?? 0) * 100)}
        />
        <Metric
          label="Judge 依据性 ×100"
          value={Math.round((report.metrics.averageGroundedness ?? 0) * 100)}
        />
      </div>
      {report.gateReasons.length === 0 ? (
        <div className="admin-alert success">全部质量门禁通过。</div>
      ) : (
        <div className="admin-alert error">{report.gateReasons.join('；')}</div>
      )}
      {canApproveBaseline && !report.isBaseline ? (
        <button
          className="admin-primary-button"
          disabled={busy || !report.gatesPassed || report.passedCases !== report.totalCases}
          onClick={() => void onApproveBaseline()}
          type="button"
        >
          批准为新基线
        </button>
      ) : undefined}
      {report.isBaseline ? (
        <p>
          当前基线 · {report.approvedAsBaselineBy ?? '管理员'} ·{' '}
          {report.approvedAsBaselineAt === undefined
            ? '时间未知'
            : formatDate(report.approvedAsBaselineAt)}
        </p>
      ) : undefined}
      <div className="history-list">
        {report.failures.map((failure) => (
          <article key={failure.name}>
            <strong>{failure.name}</strong>
            <span>{failure.failures.join('；')}</span>
            <small>
              {failure.expectedIntent === undefined ? '' : `预期 ${failure.expectedIntent}`}
              {failure.actualIntent === undefined ? '' : ` · 实际 ${failure.actualIntent}`}
              {failure.retrieval?.recallAtK === undefined
                ? ''
                : ` · Recall ${failure.retrieval.recallAtK.toFixed(3)}`}
            </small>
          </article>
        ))}
        {report.failures.length === 0 ? <p>没有失败案例。</p> : undefined}
      </div>
    </div>
  );
}

function qualityModeLabel(mode: QualityEvaluationMode, withJudge: boolean): string {
  if (mode === 'deterministic') return '快速确定性评测';
  if (mode === 'provider_retrieval') return '正式召回评测';
  return withJudge ? '完整 Agent + Judge' : '完整 Agent 评测';
}

function AdminUsersPanel({
  currentUserId,
  permissions,
  token,
}: {
  currentUserId: string;
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string }>();
  const [createForm, setCreateForm] = useState({
    displayName: '',
    id: '',
    password: '',
    passwordConfirmation: '',
    role: 'viewer' as AdminUser['role'],
  });
  const selected = users.find((user) => user.id === selectedId);
  const [editForm, setEditForm] = useState({
    displayName: '',
    password: '',
    passwordConfirmation: '',
    role: 'viewer' as AdminUser['role'],
    status: 'active' as AdminUser['status'],
  });

  const load = useCallback(async (): Promise<void> => {
    if (!permissions.has('user:manage')) return;
    setBusy(true);
    try {
      const result = await knowledgeAdminRequest<{ users: AdminUser[] }>(token, '/users');
      setUsers(result.users);
      setSelectedId((current) =>
        result.users.some((user) => user.id === current) ? current : (result.users[0]?.id ?? ''),
      );
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [permissions, token]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (selected !== undefined) {
      setEditForm({
        displayName: selected.displayName,
        password: '',
        passwordConfirmation: '',
        role: selected.role,
        status: selected.status,
      });
    }
  }, [selected]);

  const create = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (createForm.password !== createForm.passwordConfirmation) {
      setNotice({ kind: 'error', text: '两次输入的新账号密码不一致。' });
      return;
    }
    setBusy(true);
    try {
      await knowledgeAdminRequest(token, '/users', {
        body: {
          displayName: createForm.displayName,
          id: createForm.id,
          password: createForm.password,
          role: createForm.role,
        },
        method: 'POST',
      });
      setCreateForm({
        displayName: '',
        id: '',
        password: '',
        passwordConfirmation: '',
        role: 'viewer',
      });
      await load();
      setNotice({ kind: 'success', text: '管理员账号已创建。' });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const update = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selected === undefined) return;
    if (editForm.password !== editForm.passwordConfirmation) {
      setNotice({ kind: 'error', text: '两次输入的重置密码不一致。' });
      return;
    }
    setBusy(true);
    try {
      await knowledgeAdminRequest(token, `/users/${encodeURIComponent(selected.id)}`, {
        body: {
          displayName: editForm.displayName,
          ...(selected.id === currentUserId
            ? {}
            : {
                role: editForm.role,
                status: editForm.status,
                ...(editForm.password.length === 0 ? {} : { password: editForm.password }),
              }),
        },
        method: 'PATCH',
      });
      await load();
      setNotice({ kind: 'success', text: '账号、角色和登录会话已更新。' });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-stack">
      {notice === undefined ? undefined : (
        <div className={`admin-alert ${notice.kind}`}>{notice.text}</div>
      )}
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h2>数据库管理员</h2>
            <span>{users.length} 个</span>
          </div>
          <button className="admin-secondary-button" onClick={() => void load()} type="button">
            刷新
          </button>
        </div>
        <div className="publication-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>账号</th>
                <th>角色</th>
                <th>状态</th>
                <th>最后登录</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr
                  className={user.id === selectedId ? 'admin-table-selected' : undefined}
                  key={user.id}
                  onClick={() => setSelectedId(user.id)}
                >
                  <td>
                    <strong>{user.displayName}</strong>
                    <small>{user.id}</small>
                  </td>
                  <td>{user.role}</td>
                  <td>{user.status}</td>
                  <td>
                    {user.lastLoginAt === undefined ? '从未登录' : formatDate(user.lastLoginAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="admin-stack two-column-admin">
        <section className="admin-panel">
          <SectionHeading
            description="密码至少 12 个字符，数据库只保存 scrypt 哈希。"
            title="新建账号"
          />
          <form className="admin-form-grid single" onSubmit={(event) => void create(event)}>
            <label>
              账号 ID
              <input
                required
                onChange={(event) => setCreateForm({ ...createForm, id: event.target.value })}
                value={createForm.id}
              />
            </label>
            <label>
              显示名称
              <input
                required
                onChange={(event) =>
                  setCreateForm({ ...createForm, displayName: event.target.value })
                }
                value={createForm.displayName}
              />
            </label>
            <AdminRoleSelect
              onChange={(role) => setCreateForm({ ...createForm, role })}
              value={createForm.role}
            />
            <label>
              初始密码
              <input
                minLength={12}
                required
                type="password"
                onChange={(event) => setCreateForm({ ...createForm, password: event.target.value })}
                value={createForm.password}
              />
            </label>
            <label>
              确认初始密码
              <input
                minLength={12}
                required
                type="password"
                onChange={(event) =>
                  setCreateForm({
                    ...createForm,
                    passwordConfirmation: event.target.value,
                  })
                }
                value={createForm.passwordConfirmation}
              />
            </label>
            <button className="admin-primary-button" disabled={busy} type="submit">
              创建管理员
            </button>
          </form>
        </section>
        <section className="admin-panel">
          <SectionHeading
            description="禁用账号或修改密码会撤销该账号的现有会话。"
            title="编辑账号"
          />
          {selected === undefined ? (
            <div className="admin-empty">选择一个管理员账号。</div>
          ) : (
            <form className="admin-form-grid single" onSubmit={(event) => void update(event)}>
              <label>
                显示名称
                <input
                  required
                  onChange={(event) =>
                    setEditForm({ ...editForm, displayName: event.target.value })
                  }
                  value={editForm.displayName}
                />
              </label>
              <AdminRoleSelect
                disabled={selected.id === currentUserId}
                onChange={(role) => setEditForm({ ...editForm, role })}
                value={editForm.role}
              />
              <label>
                状态
                <select
                  disabled={selected.id === currentUserId}
                  onChange={(event) =>
                    setEditForm({
                      ...editForm,
                      status: event.target.value as AdminUser['status'],
                    })
                  }
                  value={editForm.status}
                >
                  <option value="active">启用</option>
                  <option value="disabled">禁用</option>
                </select>
              </label>
              <label>
                重置密码（可选）
                <input
                  disabled={selected.id === currentUserId}
                  minLength={12}
                  type="password"
                  onChange={(event) => setEditForm({ ...editForm, password: event.target.value })}
                  value={editForm.password}
                />
              </label>
              <label>
                确认重置密码
                <input
                  disabled={selected.id === currentUserId}
                  minLength={12}
                  type="password"
                  onChange={(event) =>
                    setEditForm({
                      ...editForm,
                      passwordConfirmation: event.target.value,
                    })
                  }
                  value={editForm.passwordConfirmation}
                />
              </label>
              {selected.id === currentUserId ? (
                <div className="admin-security-note">
                  为避免误锁定当前账号，请在“我的账号”修改本人密码；本人角色和状态需由另一名管理员调整。
                </div>
              ) : undefined}
              <button className="admin-primary-button" disabled={busy} type="submit">
                保存修改
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

function AdminRoleSelect({
  disabled = false,
  onChange,
  value,
}: {
  disabled?: boolean;
  onChange: (role: AdminUser['role']) => void;
  value: AdminUser['role'];
}): ReactElement {
  return (
    <label>
      角色
      <select
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as AdminUser['role'])}
        value={value}
      >
        <option value="viewer">Viewer</option>
        <option value="reviewer">Reviewer</option>
        <option value="publisher">Publisher</option>
        <option value="admin">Admin</option>
      </select>
    </label>
  );
}

function MyAccountPanel({ token }: { token: string }): ReactElement {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string }>();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setNotice({ kind: 'error', text: '两次输入的新密码不一致。' });
      return;
    }
    if (currentPassword === newPassword) {
      setNotice({ kind: 'error', text: '新密码不能与当前密码相同。' });
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      await knowledgeAdminRequest(token, '/auth/change-password', {
        body: { currentPassword, newPassword },
        method: 'POST',
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setNotice({
        kind: 'success',
        text: '密码已修改，当前登录保持有效，该账号的其他登录会话已撤销。',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-stack">
      <section className="admin-panel">
        <SectionHeading
          description="修改密码需要验证当前密码。成功后保留本次登录，并撤销该账号的其他登录会话。"
          title="修改我的密码"
        />
        {notice === undefined ? undefined : (
          <div className={`admin-alert ${notice.kind}`}>{notice.text}</div>
        )}
        <form className="admin-form-grid single" onSubmit={(event) => void submit(event)}>
          <label>
            当前密码
            <input
              autoComplete="current-password"
              minLength={12}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              type="password"
              value={currentPassword}
            />
          </label>
          <label>
            新密码
            <input
              autoComplete="new-password"
              minLength={12}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              type="password"
              value={newPassword}
            />
          </label>
          <label>
            确认新密码
            <input
              autoComplete="new-password"
              minLength={12}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              type="password"
              value={confirmation}
            />
          </label>
          <button className="admin-primary-button" disabled={busy} type="submit">
            {busy ? '正在修改…' : '修改密码'}
          </button>
        </form>
      </section>
    </div>
  );
}

function TelegramGroupsPanel({ token }: { token: string }): ReactElement {
  const [status, setStatus] = useState<TelegramGroupRegistryEntry['membershipStatus'] | ''>(
    'active',
  );
  const [groups, setGroups] = useState<TelegramGroupRegistryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string }>();
  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const query = status === '' ? '' : `?status=${status}`;
      const result = await knowledgeAdminRequest<{ groups: TelegramGroupRegistryEntry[] }>(
        token,
        `/telegram-groups${query}`,
      );
      setGroups(result.groups);
    } catch (loadError) {
      setNotice({ kind: 'error', text: errorMessage(loadError) });
    } finally {
      setBusy(false);
    }
  }, [status, token]);

  useEffect(() => void load(), [load]);

  return (
    <div className="admin-stack">
      <section className="admin-panel publication-guide">
        <div>
          <h2>Bot 群聊注册表</h2>
          <p>
            Telegram Update 会实时写入本地审计缓冲，并由独立 Worker 自动清洗和识别知识候选；Bot
            在群内保持静默。管理员只需前往“知识候选”审批或拒绝，候选不会自动发布。
          </p>
        </div>
        <button
          className="admin-secondary-button"
          disabled={busy}
          onClick={() => void load()}
          type="button"
        >
          刷新
        </button>
      </section>
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h2>已识别群聊</h2>
            <span>{groups.length} 个</span>
          </div>
          <select
            aria-label="群聊状态"
            onChange={(event) =>
              setStatus(event.target.value as TelegramGroupRegistryEntry['membershipStatus'] | '')
            }
            value={status}
          >
            <option value="">全部</option>
            <option value="active">当前加入</option>
            <option value="left">已退出</option>
            <option value="kicked">已移除</option>
            <option value="unknown">未知</option>
          </select>
        </div>
        {notice === undefined ? undefined : (
          <div className={`admin-alert ${notice.kind}`}>{notice.text}</div>
        )}
        {busy && groups.length === 0 ? <div className="admin-empty">正在加载群聊…</div> : undefined}
        {!busy && groups.length === 0 ? (
          <div className="admin-empty">
            尚未识别群聊。将 Bot 加入群或在现有群发送一条新消息后会自动登记。
          </div>
        ) : undefined}
        {groups.length > 0 ? (
          <div className="publication-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>群聊</th>
                  <th>类型</th>
                  <th>首次发现</th>
                  <th>最近消息</th>
                  <th>自动识别</th>
                  <th>待识别消息</th>
                  <th>依据</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.chatId}>
                    <td>
                      <StatusBadge status={group.membershipStatus} />
                    </td>
                    <td>
                      <strong>{group.title ?? '未提供群名称'}</strong>
                      <small>{group.chatId}</small>
                    </td>
                    <td>{group.chatType}</td>
                    <td>{formatDate(group.firstSeenAt)}</td>
                    <td>
                      {group.lastMessageAt === undefined
                        ? '尚无消息'
                        : formatDate(group.lastMessageAt)}
                    </td>
                    <td>
                      {group.curationJob === undefined ? (
                        '等待消息'
                      ) : (
                        <>
                          <StatusBadge status={group.curationJob.status} />
                          {group.curationJob.errorCode === undefined ? undefined : (
                            <small>{group.curationJob.errorCode}</small>
                          )}
                        </>
                      )}
                    </td>
                    <td>{group.unprocessedMessageCount ?? 0}</td>
                    <td>{group.observationSource}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : undefined}
      </section>
    </div>
  );
}

function KnowledgeGraphPanel({
  permissions,
  token,
}: {
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [entities, setEntities] = useState<KnowledgeGraphEntity[]>([]);
  const [conflicts, setConflicts] = useState<KnowledgeGraphConflict[]>([]);
  const [relations, setRelations] = useState<KnowledgeGraphRelation[]>([]);
  const [status, setStatus] = useState<KnowledgeGraphRelationStatus>('approved');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadGraph = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const [entityResult, relationResult, conflictResult] = await Promise.all([
        knowledgeAdminRequest<{ entities: KnowledgeGraphEntity[] }>(
          token,
          '/knowledge-graph/entities?limit=200',
        ),
        knowledgeAdminRequest<{ relations: KnowledgeGraphRelation[] }>(
          token,
          `/knowledge-graph/relations?status=${status}&limit=300`,
        ),
        knowledgeAdminRequest<{ conflicts: KnowledgeGraphConflict[] }>(
          token,
          '/knowledge-graph/conflicts?limit=100',
        ),
      ]);
      setEntities(entityResult.entities);
      setRelations(relationResult.relations);
      setConflicts(conflictResult.conflicts);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setBusy(false);
    }
  }, [status, token]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  const changeStatus = async (
    relation: KnowledgeGraphRelation,
    nextStatus: KnowledgeGraphRelationStatus,
  ): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await knowledgeAdminRequest(token, `/knowledge-graph/relations/${relation.id}`, {
        body: { status: nextStatus },
        method: 'PATCH',
      });
      await loadGraph();
    } catch (updateError) {
      setError(errorMessage(updateError));
      setBusy(false);
    }
  };

  return (
    <div className="admin-stack">
      <section className="admin-panel">
        <div className="section-heading">
          <div>
            <h2>实体与别名</h2>
            <p>实体来自已发布知识；别名用于 Query 归一化，不作为独立事实。</p>
          </div>
          <button disabled={busy} onClick={() => void loadGraph()} type="button">
            刷新
          </button>
        </div>
        <div className="metric-grid">
          <Metric label="实体" value={entities.length} />
          <Metric label="关系" value={relations.length} />
          <Metric label="冲突" value={conflicts.length} />
          <Metric
            label="链实体"
            value={entities.filter((entity) => entity.type === 'chain').length}
          />
        </div>
        <div className="publication-table-wrap">
          <table>
            <thead>
              <tr>
                <th>类型</th>
                <th>规范名称</th>
                <th>别名</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((entity) => (
                <tr key={entity.id}>
                  <td>{entity.type}</td>
                  <td>{entity.canonicalName}</td>
                  <td>{entity.aliases.join('、') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel">
        <SectionHeading
          description="同一功能与链同时存在“支持”和“不支持”的当前证据时会列在这里；审核人应检查来源后停用错误关系。"
          title="关系冲突"
        />
        {conflicts.length === 0 ? (
          <div className="admin-empty compact">当前没有生效中的正反关系冲突。</div>
        ) : (
          <div className="comparison-grid">
            {conflicts.map((conflict) => (
              <article
                className="comparison-card conflict"
                key={`${conflict.subject.id}:${conflict.object.id}`}
              >
                <strong>
                  {conflict.subject.canonicalName} ↔ {conflict.object.canonicalName}
                </strong>
                <p>
                  支持证据 {conflict.positiveRelationIds.length} 条；不支持证据{' '}
                  {conflict.negativeRelationIds.length} 条。
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="admin-panel">
        <div className="section-heading">
          <div>
            <h2>证据关系治理</h2>
            <p>拒绝关系会立即退出图谱召回，但不会删除原始知识文档。</p>
          </div>
          <select
            aria-label="关系状态"
            onChange={(event) => setStatus(event.target.value as KnowledgeGraphRelationStatus)}
            value={status}
          >
            <option value="approved">生效中</option>
            <option value="rejected">已停用</option>
          </select>
        </div>
        {error === undefined ? undefined : <div className="admin-alert error">{error}</div>}
        <div className="publication-table-wrap">
          <table>
            <thead>
              <tr>
                <th>关系</th>
                <th>来源</th>
                <th>证据</th>
                <th>治理</th>
              </tr>
            </thead>
            <tbody>
              {relations.map((relation) => (
                <tr key={relation.id}>
                  <td>
                    {relation.subject.canonicalName} → {relation.predicate} →{' '}
                    {relation.object.canonicalName}
                  </td>
                  <td>{relation.sourceType}</td>
                  <td>{relation.evidence.slice(0, 180)}</td>
                  <td>
                    {permissions.has('candidate:review') ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void changeStatus(
                            relation,
                            relation.status === 'approved' ? 'rejected' : 'approved',
                          )
                        }
                        type="button"
                      >
                        {relation.status === 'approved' ? '停用' : '恢复'}
                      </button>
                    ) : (
                      relation.status
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function CandidatesPanel({
  permissions,
  token,
}: {
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [status, setStatus] = useState<CandidateStatus | ''>('pending');
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detail, setDetail] = useState<CandidateDetail | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string }>();

  const loadCandidates = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const query = status === '' ? '' : `?status=${status}`;
      const result = await knowledgeAdminRequest<{ candidates: KnowledgeCandidate[] }>(
        token,
        `/candidates${query}`,
      );
      setCandidates(result.candidates);
      setSelectedId((current) =>
        current !== undefined && result.candidates.some((candidate) => candidate.id === current)
          ? current
          : result.candidates[0]?.id,
      );
      if (result.candidates.length === 0) {
        setDetail(undefined);
      }
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [status, token]);

  const loadDetail = useCallback(async (): Promise<void> => {
    if (selectedId === undefined) {
      setDetail(undefined);
      return;
    }
    try {
      const result = await knowledgeAdminRequest<CandidateDetail>(
        token,
        `/candidates/${encodeURIComponent(selectedId)}`,
      );
      setDetail(result);
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    }
  }, [selectedId, token]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const refresh = async (successMessage: string): Promise<void> => {
    await loadCandidates();
    await loadDetail();
    setMessage({ kind: 'success', text: successMessage });
  };

  return (
    <div className="candidate-layout">
      <section className="admin-panel candidate-list-panel">
        <div className="admin-panel-header">
          <div>
            <h2>候选队列</h2>
            <span>{candidates.length} 条</span>
          </div>
          <select
            aria-label="候选状态"
            onChange={(event) => setStatus(event.target.value as CandidateStatus | '')}
            value={status}
          >
            <option value="">全部</option>
            <option value="pending">自动处理中</option>
            <option value="approved">已批准</option>
            <option value="rejected">已拒绝</option>
            <option value="published">已发布</option>
          </select>
        </div>
        <div className="candidate-list">
          {busy ? <div className="admin-empty">正在加载候选…</div> : undefined}
          {!busy && candidates.length === 0 ? (
            <div className="admin-empty">当前筛选条件下没有候选。</div>
          ) : undefined}
          {candidates.map((candidate) => (
            <button
              className={candidate.id === selectedId ? 'candidate-card selected' : 'candidate-card'}
              key={candidate.id}
              onClick={() => setSelectedId(candidate.id)}
              type="button"
            >
              <div className="candidate-card-topline">
                <StatusBadge status={candidate.status} />
                <span>{formatDate(candidate.createdAt)}</span>
              </div>
              <strong>{candidate.proposedTitle ?? candidate.question}</strong>
              <p>{candidate.canonicalAnswer}</p>
              <div className="candidate-card-meta">
                <span>{candidate.proposedModule ?? '未分类'}</span>
                <span>{formatScore(candidate.qualityScore)}</span>
              </div>
            </button>
          ))}
        </div>
      </section>
      <section className="candidate-detail-column">
        {message === undefined ? undefined : (
          <div className={`admin-alert ${message.kind}`}>{message.text}</div>
        )}
        {detail === undefined ? (
          <div className="admin-panel admin-empty detail-empty">选择一个候选查看治理详情。</div>
        ) : (
          <CandidateDetailPanel
            detail={detail}
            key={`${detail.candidate.id}:${detail.candidate.currentRevision ?? 1}`}
            onError={(text) => setMessage({ kind: 'error', text })}
            onRefresh={refresh}
            permissions={permissions}
            token={token}
          />
        )}
      </section>
    </div>
  );
}

function CandidateDetailPanel({
  detail,
  onError,
  onRefresh,
  permissions,
  token,
}: {
  detail: CandidateDetail;
  onError: (message: string) => void;
  onRefresh: (message: string) => Promise<void>;
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const candidate = detail.candidate;
  const existingPublication = detail.publications[0];
  const canReview = permissions.has('candidate:review') && candidate.status === 'pending';
  const canPublish =
    permissions.has('publication:request') &&
    candidate.status === 'approved' &&
    existingPublication === undefined;
  const [question, setQuestion] = useState(candidate.question);
  const [answer, setAnswer] = useState(candidate.canonicalAnswer);
  const [title, setTitle] = useState(candidate.proposedTitle ?? '');
  const [module, setModule] = useState(candidate.proposedModule ?? '');
  const [evidence, setEvidence] = useState(candidate.evidence ?? '');
  const [reason, setReason] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [sourceUrl, setSourceUrl] = useState(candidate.sourceUrl ?? '');
  const [effectiveAt, setEffectiveAt] = useState(toDateTimeLocal(candidate.effectiveAt));
  const [supersedes, setSupersedes] = useState((candidate.supersedes ?? []).join(', '));
  const [actionBusy, setActionBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<KnowledgeCandidateImprovementSuggestion>();

  const runAction = async (
    operation: () => Promise<void>,
    successMessage: string,
  ): Promise<void> => {
    setActionBusy(true);
    try {
      await operation();
      await onRefresh(successMessage);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  };

  const revise = (): Promise<void> =>
    runAction(async () => {
      await knowledgeAdminRequest(token, `/candidates/${encodeURIComponent(candidate.id)}`, {
        body: {
          canonicalAnswer: answer,
          question,
          reason: reason.length === 0 ? '管理后台修订' : reason,
          ...(evidence.trim().length === 0 ? {} : { evidence }),
          ...(module.trim().length === 0 ? {} : { proposedModule: module }),
          ...(title.trim().length === 0 ? {} : { proposedTitle: title }),
        },
        method: 'PATCH',
      });
    }, '候选修订已保存，并生成新的不可变 revision。');

  const generateSuggestion = async (): Promise<void> => {
    setActionBusy(true);
    try {
      const result = await knowledgeAdminRequest<{
        suggestion: KnowledgeCandidateImprovementSuggestion;
      }>(token, `/candidates/${encodeURIComponent(candidate.id)}/suggestion`, {
        body: { canonicalAnswer: answer, question },
        method: 'POST',
      });
      setSuggestion(result.suggestion);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  };

  const applySuggestion = (): void => {
    if (suggestion === undefined) return;
    setAnswer(suggestion.canonicalAnswer);
    setReason(`应用 AI 优化建议（${suggestion.promptVersion} / ${suggestion.model}）`);
  };

  const review = (decision: 'approve' | 'reject'): Promise<void> =>
    runAction(
      async () => {
        if (decision === 'approve' && effectiveAt.length === 0) {
          throw new Error('批准候选前必须设置生效时间。');
        }
        const body =
          decision === 'approve'
            ? {
                ...(effectiveAt.length === 0
                  ? {}
                  : { effectiveAt: new Date(effectiveAt).toISOString() }),
                ...(reviewNote.length === 0 ? {} : { note: reviewNote }),
                ...(sourceUrl.length === 0 ? {} : { sourceUrl }),
                supersedes: splitCommaList(supersedes),
              }
            : { ...(reviewNote.length === 0 ? {} : { note: reviewNote }) };
        await knowledgeAdminRequest(
          token,
          `/candidates/${encodeURIComponent(candidate.id)}/${decision}`,
          { body, method: 'POST' },
        );
      },
      decision === 'approve' ? '候选已批准并进入发布队列。' : '候选已拒绝并记录审核意见。',
    );

  const requestPublication = (): Promise<void> =>
    runAction(async () => {
      await knowledgeAdminRequest(
        token,
        `/candidates/${encodeURIComponent(candidate.id)}/publication`,
        { method: 'POST' },
      );
    }, '缺失的发布任务已修复。自动 Worker 会继续执行门禁与索引。');

  return (
    <div className="detail-stack">
      <section className="admin-panel candidate-summary">
        <div className="candidate-summary-heading">
          <div>
            <div className="admin-eyebrow">{candidate.id}</div>
            <h2>{candidate.proposedTitle ?? candidate.question}</h2>
          </div>
          <StatusBadge status={candidate.status} />
        </div>
        <div className="candidate-facts">
          <Fact label="质量分" value={formatScore(candidate.qualityScore)} />
          <Fact label="提取方式" value={candidate.extractionMethod ?? 'manual'} />
          <Fact label="当前 Revision" value={String(candidate.currentRevision ?? 1)} />
          <Fact label="来源" value={candidate.sourceChannel} />
        </div>
        <TagList emptyLabel="无风险标签" items={candidate.riskFlags ?? []} tone="risk" />
      </section>

      <section className="admin-panel">
        <SectionHeading
          description="Curator 标准化结果。Telegram 收件箱候选必须由管理员审核，可在批准前编辑并保留 revision。"
          title="候选知识"
        />
        <div className="admin-form-grid">
          <label className="span-2">
            标准问题
            <textarea
              disabled={!canReview}
              onChange={(event) => setQuestion(event.target.value)}
              value={question}
            />
          </label>
          <div className="span-2 candidate-answer-editor">
            <label>
              标准答案
              <textarea
                disabled={!canReview}
                onChange={(event) => {
                  setAnswer(event.target.value);
                  setSuggestion(undefined);
                }}
                rows={6}
                value={answer}
              />
            </label>
            {canReview ? (
              <div className="candidate-answer-ai">
                <div className="admin-actions">
                  <button
                    className="admin-secondary-button"
                    disabled={actionBusy || answer.trim().length === 0}
                    onClick={() => void generateSuggestion()}
                    type="button"
                  >
                    {actionBusy ? '正在优化…' : 'AI 优化答案'}
                  </button>
                </div>
                {suggestion === undefined ? undefined : (
                  <div className="candidate-answer-suggestion">
                    <div className="comparison-label">
                      AI 建议 · {suggestionStatusLabel(suggestion.status)}
                    </div>
                    <p>{suggestion.canonicalAnswer}</p>
                    <div className="admin-security-note">{suggestion.rationale}</div>
                    {suggestion.missingInformation.length === 0 ? undefined : (
                      <div className="admin-security-note">
                        仍需补充：{suggestion.missingInformation.join('；')}
                      </div>
                    )}
                    <button
                      className="admin-primary-button"
                      disabled={actionBusy || suggestion.status === 'no_change'}
                      onClick={applySuggestion}
                      type="button"
                    >
                      应用到标准答案
                    </button>
                  </div>
                )}
              </div>
            ) : undefined}
          </div>
          <label>
            标题
            <input
              disabled={!canReview}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </label>
          <label>
            模块
            <input
              disabled={!canReview}
              onChange={(event) => setModule(event.target.value)}
              value={module}
            />
          </label>
          <label className="span-2">
            证据说明
            <textarea
              disabled={!canReview}
              onChange={(event) => setEvidence(event.target.value)}
              value={evidence}
            />
          </label>
          {canReview ? (
            <label className="span-2">
              修订原因
              <input
                onChange={(event) => setReason(event.target.value)}
                placeholder="说明为什么修改"
                value={reason}
              />
            </label>
          ) : undefined}
        </div>
        {canReview ? (
          <div className="admin-actions">
            <button
              className="admin-secondary-button"
              disabled={actionBusy}
              onClick={() => void revise()}
              type="button"
            >
              保存 Revision
            </button>
          </div>
        ) : undefined}
      </section>

      <section className="admin-panel">
        <SectionHeading
          description="这里只预览候选可能形成的实体关系；候选批准并由发布 Worker 写入正式知识后，关系才会参与客服检索。"
          title="知识图谱关系预览"
        />
        {(detail.graphPreview ?? []).length === 0 ? (
          <div className="admin-empty compact">当前候选未提取到受支持的实体关系。</div>
        ) : (
          <div className="comparison-grid">
            {(detail.graphPreview ?? []).map((relation, index) => (
              <article
                className="comparison-card duplicate"
                key={`${relation.subject.canonicalName}:${relation.predicate}:${relation.object.canonicalName}:${index}`}
              >
                <div className="comparison-label">待发布关系 · {relation.confidence}</div>
                <strong>
                  {relation.subject.canonicalName} → {relation.predicate} →{' '}
                  {relation.object.canonicalName}
                </strong>
                <p>{relation.evidence.slice(0, 240)}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="admin-panel">
        <SectionHeading
          description="原消息已在候选生成前脱敏；这里只展示审计所需上下文。"
          title="Telegram 原始上下文"
        />
        <div className="context-compare">
          <ContextCard
            id={candidate.sourceQuestionMessageId}
            label="用户问题"
            text={candidate.sourceQuestionText}
          />
          <ContextCard
            id={candidate.sourceAnswerMessageId}
            label="可信作者回复"
            text={candidate.sourceAnswerText}
          />
        </div>
        <div className="context-meta">
          <span>Chat: {candidate.sourceChatId ?? 'unknown'}</span>
          <span>Context IDs: {(candidate.contextMessageIds ?? []).join(', ') || 'none'}</span>
          <span>
            Author: {candidate.authorVerification?.userId ?? 'unknown'} ·{' '}
            {candidate.authorVerification?.status ?? 'unverified'}
          </span>
        </div>
      </section>

      <section className="admin-panel">
        <SectionHeading
          description="自动策略检测到重复或正式知识冲突时会失败关闭并拒绝候选。"
          title="重复与冲突对比"
        />
        {detail.duplicates.length === 0 && detail.conflicts.length === 0 ? (
          <div className="admin-empty compact">未发现重复候选或正式知识冲突。</div>
        ) : undefined}
        <div className="comparison-grid">
          {detail.duplicates.map((duplicate) => (
            <article className="comparison-card duplicate" key={duplicate.id}>
              <div className="comparison-label">相似候选 · {duplicate.status}</div>
              <strong>{duplicate.question}</strong>
              <p>{duplicate.canonicalAnswer}</p>
              <code>{duplicate.id}</code>
            </article>
          ))}
          {detail.conflicts.map((conflict) => (
            <article className="comparison-card conflict" key={conflict.id}>
              <div className="comparison-label">
                正式知识冲突 · {conflict.sourceType} · {conflict.status}
              </div>
              <strong>{conflict.title}</strong>
              <p>{conflict.content}</p>
              <code>{conflict.id}</code>
            </article>
          ))}
        </div>
      </section>

      {canReview ? (
        <section className="admin-panel review-panel">
          <SectionHeading
            description="确认原始上下文、清洗结果、重复和冲突后再批准。批准会自动创建发布任务，发布 Worker 仍需通过完整门禁。"
            title="人工审批"
          />
          <div className="admin-form-grid">
            <label>
              生效时间
              <input
                onChange={(event) => setEffectiveAt(event.target.value)}
                type="datetime-local"
                value={effectiveAt}
              />
            </label>
            <label>
              正式来源 URL
              <input
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder="https://…"
                value={sourceUrl}
              />
            </label>
            <label className="span-2">
              替代的 document/chunk ID（逗号分隔）
              <input onChange={(event) => setSupersedes(event.target.value)} value={supersedes} />
            </label>
            <label className="span-2">
              审核备注
              <textarea
                onChange={(event) => setReviewNote(event.target.value)}
                value={reviewNote}
              />
            </label>
          </div>
          <div className="admin-actions">
            <button
              className="admin-danger-button"
              disabled={actionBusy}
              onClick={() => void review('reject')}
              type="button"
            >
              拒绝候选
            </button>
            <button
              className="admin-primary-button"
              disabled={actionBusy}
              onClick={() => void review('approve')}
              type="button"
            >
              批准候选
            </button>
          </div>
        </section>
      ) : undefined}

      {canPublish ? (
        <section className="admin-panel publication-request-panel">
          <div>
            <h3>修复缺失的发布任务</h3>
            <p>
              正常情况下自动策略已经创建任务。这里只修复异常遗留；Worker
              仍会执行边界、检索命中、Golden QA 和事务性 ingest。
            </p>
          </div>
          <button
            className="admin-primary-button"
            disabled={actionBusy}
            onClick={() => void requestPublication()}
            type="button"
          >
            创建 PublicationJob
          </button>
        </section>
      ) : undefined}

      {candidate.status === 'approved' && existingPublication !== undefined ? (
        <section className="admin-panel publication-request-panel">
          <div>
            <h3>发布任务已存在</h3>
            <p>
              Job {existingPublication.id} · attempt {existingPublication.attemptCount}
              。失败任务请到“发布任务”页执行安全重试。
            </p>
          </div>
          <StatusBadge status={existingPublication.status} />
        </section>
      ) : undefined}

      <section className="admin-panel">
        <SectionHeading
          description="自动决策、紧急覆盖、发布请求和执行结果均保留不可变记录。"
          title="版本与审计"
        />
        <div className="history-grid">
          <div>
            <h4>Revisions · {detail.history.revisions.length}</h4>
            <div className="history-list">
              {detail.history.revisions.length === 0 ? (
                <div className="admin-empty compact">暂无 revision。</div>
              ) : undefined}
              {detail.history.revisions.map((revision) => (
                <article key={revision.id}>
                  <strong>Revision {revision.revision}</strong>
                  <span>
                    {revision.editedBy} · {formatDate(revision.createdAt)}
                  </span>
                  <p>{revision.reason ?? '未填写修订原因'}</p>
                  <small>{revision.question}</small>
                </article>
              ))}
            </div>
          </div>
          <div>
            <h4>Reviews · {detail.history.reviews.length}</h4>
            <div className="history-list">
              {detail.history.reviews.length === 0 ? (
                <div className="admin-empty compact">暂无审核记录。</div>
              ) : undefined}
              {detail.history.reviews.map((review) => (
                <article key={review.id}>
                  <strong>
                    {review.decision} · Revision {review.revision}
                  </strong>
                  <span>
                    {review.reviewedBy} · {formatDate(review.createdAt)}
                  </span>
                  <p>{review.note ?? '未填写审核备注'}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
        <h4 className="audit-heading">Audit events · {detail.history.auditEvents.length}</h4>
        <div className="audit-timeline">
          {detail.history.auditEvents.length === 0 ? (
            <div className="admin-empty compact">暂无审计事件。</div>
          ) : undefined}
          {detail.history.auditEvents.map((event) => (
            <article key={event.id}>
              <span className="audit-dot" />
              <div>
                <strong>{event.eventType}</strong>
                <p>
                  {event.actor} · {formatDate(event.createdAt)}
                </p>
                <code>{JSON.stringify(event.details)}</code>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function PublicationsPanel({
  permissions,
  token,
}: {
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [status, setStatus] = useState<PublicationStatus | ''>('');
  const [jobs, setJobs] = useState<PublicationJob[]>([]);
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const query = status === '' ? '' : `?status=${status}`;
      const result = await knowledgeAdminRequest<{ publications: PublicationJob[] }>(
        token,
        `/publications${query}`,
      );
      setJobs(result.publications);
      setMessage(undefined);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [status, token]);
  useEffect(() => void load(), [load]);

  const retry = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await knowledgeAdminRequest(token, `/publications/${encodeURIComponent(id)}/retry`, {
        method: 'POST',
      });
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-stack">
      <section className="admin-panel publication-guide">
        <div>
          <h2>自动发布队列</h2>
          <p>
            自动治理负责批准、入队和最多三次失败重试。队列使用租约和幂等候选键，执行器崩溃后由下一个
            Worker 接管。
          </p>
        </div>
        <code>pnpm rag:knowledge:automation:work</code>
      </section>
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h2>PublicationJob</h2>
            <span>{jobs.length} 条</span>
          </div>
          <select
            aria-label="发布状态"
            onChange={(event) => setStatus(event.target.value as PublicationStatus | '')}
            value={status}
          >
            <option value="">全部</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="failed">Failed</option>
            <option value="succeeded">Succeeded</option>
          </select>
        </div>
        {message === undefined ? undefined : <div className="admin-alert error">{message}</div>}
        {busy && jobs.length === 0 ? <div className="admin-empty">正在加载任务…</div> : undefined}
        <div className="publication-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>状态</th>
                <th>候选</th>
                <th>尝试</th>
                <th>申请人</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <StatusBadge status={job.status} />
                  </td>
                  <td>
                    <strong>{job.candidateId}</strong>
                    <small>{job.lastError ?? job.documentId ?? job.id}</small>
                  </td>
                  <td>{job.attemptCount}</td>
                  <td>{job.requestedBy}</td>
                  <td>{formatDate(job.updatedAt)}</td>
                  <td>
                    {job.status === 'failed' && permissions.has('publication:request') ? (
                      <button
                        className="admin-link-button"
                        disabled={busy}
                        onClick={() => void retry(job.id)}
                        type="button"
                      >
                        紧急重试
                      </button>
                    ) : (
                      <span>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TrustedAuthorsPanel({
  permissions,
  token,
}: {
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [authors, setAuthors] = useState<TrustedAuthor[]>([]);
  const [chatIdFilter, setChatIdFilter] = useState('');
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string }>();
  const [form, setForm] = useState({
    chatId: '',
    role: 'administrator' as TrustedAuthor['role'],
    userId: '',
    validFrom: '',
    validTo: '',
  });

  const load = useCallback(async (): Promise<void> => {
    try {
      const query =
        chatIdFilter.trim().length === 0
          ? ''
          : `?chatId=${encodeURIComponent(chatIdFilter.trim())}`;
      const result = await knowledgeAdminRequest<{ authors: TrustedAuthor[] }>(
        token,
        `/trusted-authors${query}`,
      );
      setAuthors(result.authors);
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    }
  }, [chatIdFilter, token]);
  useEffect(() => void load(), [load]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    try {
      await knowledgeAdminRequest(token, '/trusted-authors', {
        body: {
          chatId: form.chatId,
          role: form.role,
          userId: form.userId,
          validFrom: new Date(form.validFrom).toISOString(),
          ...(form.validTo.length === 0 ? {} : { validTo: new Date(form.validTo).toISOString() }),
          verificationSource: 'manual',
        },
        method: 'POST',
      });
      setMessage({
        kind: 'success',
        text: '可信作者记录已保存。角色只在配置的时间窗口内生效。',
      });
      await load();
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    }
  };

  return (
    <div className="admin-stack two-column-admin">
      <section className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h2>可信作者名册</h2>
            <span>{authors.length} 条</span>
          </div>
          <input
            aria-label="按 Chat ID 筛选可信作者"
            onChange={(event) => setChatIdFilter(event.target.value)}
            placeholder="按 Chat ID 筛选"
            value={chatIdFilter}
          />
        </div>
        <div className="author-list">
          {authors.length === 0 ? (
            <div className="admin-empty">没有匹配的可信作者。</div>
          ) : undefined}
          {authors.map((author) => (
            <article key={author.id}>
              <div>
                <strong>{author.userId}</strong>
                <StatusBadge status={author.role} />
              </div>
              <p>Chat {author.chatId}</p>
              <p>
                {formatDate(author.validFrom)} →{' '}
                {author.validTo === undefined ? '持续有效' : formatDate(author.validTo)}
              </p>
              <small>
                {author.verificationSource} · {author.verifiedBy}
              </small>
            </article>
          ))}
        </div>
      </section>
      <section className="admin-panel">
        <SectionHeading
          description="禁止根据昵称、写作风格或发言频率推断管理员。"
          title="新增或调整角色窗口"
        />
        {message === undefined ? undefined : (
          <div className={`admin-alert ${message.kind}`}>{message.text}</div>
        )}
        {permissions.has('trusted_author:manage') ? (
          <form className="admin-form-grid single" onSubmit={(event) => void submit(event)}>
            <label>
              Chat ID
              <input
                required
                onChange={(event) => setForm({ ...form, chatId: event.target.value })}
                value={form.chatId}
              />
            </label>
            <label>
              User ID
              <input
                required
                onChange={(event) => setForm({ ...form, userId: event.target.value })}
                value={form.userId}
              />
            </label>
            <label>
              角色
              <select
                onChange={(event) =>
                  setForm({ ...form, role: event.target.value as TrustedAuthor['role'] })
                }
                value={form.role}
              >
                <option value="owner">Owner</option>
                <option value="administrator">Administrator</option>
                <option value="knowledge_editor">Knowledge Editor</option>
              </select>
            </label>
            <label>
              有效期开始
              <input
                required
                type="datetime-local"
                onChange={(event) => setForm({ ...form, validFrom: event.target.value })}
                value={form.validFrom}
              />
            </label>
            <label>
              有效期结束（可选）
              <input
                type="datetime-local"
                onChange={(event) => setForm({ ...form, validTo: event.target.value })}
                value={form.validTo}
              />
            </label>
            <button className="admin-primary-button" type="submit">
              保存可信作者
            </button>
          </form>
        ) : (
          <div className="admin-empty compact">当前角色只有查看权限。</div>
        )}
      </section>
    </div>
  );
}

function TelegramImportPanel({
  permissions,
  token,
}: {
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [rawExport, setRawExport] = useState<unknown>();
  const [fileName, setFileName] = useState<string>();
  const [curationMode, setCurationMode] = useState<KnowledgeCurationMode>('auto');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TelegramImportResult>();
  const [error, setError] = useState<string>();

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    try {
      setRawExport(JSON.parse(await file.text()) as unknown);
      setFileName(file.name);
      setError(undefined);
    } catch {
      setRawExport(undefined);
      setError('所选文件不是有效的 Telegram JSON 导出。');
    }
  };

  const submit = async (): Promise<void> => {
    if (rawExport === undefined) {
      setError('请先选择 Telegram JSON 导出文件。');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const nextResult = await knowledgeAdminRequest<TelegramImportResult>(
        token,
        '/imports/telegram',
        {
          body: { curationMode, rawExport },
          method: 'POST',
        },
      );
      setResult(nextResult);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };
  const agentRunNotice =
    result === undefined ? undefined : formatKnowledgeCuratorAgentNotice(result.agentRunStats);

  return (
    <div className="admin-stack import-layout">
      <section className="admin-panel import-dropzone">
        <div className="import-icon">JSON</div>
        <h2>导入 Telegram Desktop JSON</h2>
        <p>
          系统会自动执行身份验证、脱敏、边界、重复与冲突检查；符合严格策略的候选自动批准并进入发布队列，其余候选自动拒绝。
        </p>
        <label className="admin-file-button">
          选择 JSON 文件
          <input
            accept="application/json,.json"
            onChange={(event) => void chooseFile(event)}
            type="file"
          />
        </label>
        <strong>{fileName ?? '尚未选择文件'}</strong>
        <label>
          知识清洗模式
          <select
            onChange={(event) => setCurationMode(event.target.value as KnowledgeCurationMode)}
            value={curationMode}
          >
            <option value="auto">自动（推荐）</option>
            <option value="deterministic">仅确定性规则</option>
            <option value="required">强制使用 Agent</option>
          </select>
        </label>
        <small>
          自动模式只把尚未被规则覆盖的复杂线程交给已配置模型；模型不可用或单线程失败时安全保留确定性结果。强制模式遇到模型或预算错误会终止整批导入。
        </small>
        <small>
          管理员身份优先使用时间有效的可信作者名册；配置 Bot Token 时可查询当前 Telegram
          管理员。不能验证时失败关闭。
        </small>
        {error === undefined ? undefined : <div className="admin-alert error">{error}</div>}
        <button
          className="admin-primary-button"
          disabled={busy || !permissions.has('import:telegram')}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? '正在执行自动治理…' : '导入并自动治理'}
        </button>
      </section>
      {result === undefined ? undefined : (
        <section className="admin-panel">
          <SectionHeading description={`Curator Run ${result.runId}`} title="导入结果" />
          <div className="metric-grid">
            <Metric label="消息" value={result.messageCount} />
            <Metric label="线程" value={result.threadCount} />
            <Metric label="候选" value={result.candidateCount} />
            <Metric label="新建" value={result.created.length} />
            <Metric label="重复" value={result.duplicateCount} />
            <Metric label="未验证作者消息" value={result.unverifiedAuthorMessageCount} />
            <Metric label="Agent 可处理线程" value={result.agentRunStats.eligibleThreadCount} />
            <Metric label="Agent 已尝试" value={result.agentRunStats.attemptedThreadCount} />
            <Metric label="Agent 失败" value={result.agentRunStats.failedThreadCount} />
            <Metric label="自动批准" value={result.automation?.approvedCount ?? 0} />
            <Metric label="自动拒绝" value={result.automation?.rejectedCount ?? 0} />
            <Metric label="发布入队" value={result.automation?.publicationQueuedCount ?? 0} />
          </div>
          <div className="admin-alert success">
            自动治理完成。通过项将由隔离 Worker 执行检索、Golden QA、Embedding
            和事务发布；没有人工审核前置步骤。
          </div>
          {agentRunNotice === undefined ? undefined : (
            <div className="admin-alert">{agentRunNotice}</div>
          )}
        </section>
      )}
    </div>
  );
}

function formatKnowledgeCuratorAgentNotice(
  stats: TelegramImportResult['agentRunStats'],
): string | undefined {
  const skippedCount =
    stats.skippedBudgetThreadCount +
    stats.skippedByModeThreadCount +
    stats.skippedUnavailableThreadCount;
  if (stats.failedThreadCount === 0 && skippedCount === 0) {
    return undefined;
  }
  return [
    `Agent 失败 ${stats.failedThreadCount} 条（超时 ${stats.failureCounts.timeout}、Provider ${stats.failureCounts.provider_error}、输出无效 ${stats.failureCounts.invalid_output}、其他 ${stats.failureCounts.unknown}）。`,
    `跳过 ${skippedCount} 条（模型不可用 ${stats.skippedUnavailableThreadCount}、模式关闭 ${stats.skippedByModeThreadCount}、预算上限 ${stats.skippedBudgetThreadCount}）。`,
    '这些统计不包含消息原文；未生成候选的复杂线程会保持失败关闭，不进入正式知识库。',
  ].join(' ');
}

function StatusBadge({ status }: { status: string }): ReactElement {
  return <span className={`status-badge status-${status.replaceAll('_', '-')}`}>{status}</span>;
}

function SectionHeading({
  description,
  title,
}: {
  description: string;
  title: string;
}): ReactElement {
  return (
    <div className="section-heading">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="candidate-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TagList({
  emptyLabel,
  items,
  tone,
}: {
  emptyLabel: string;
  items: string[];
  tone: 'risk';
}): ReactElement {
  return (
    <div className="tag-list">
      {items.length === 0 ? (
        <span className="tag neutral">{emptyLabel}</span>
      ) : (
        items.map((item) => (
          <span className={`tag ${tone}`} key={item}>
            {item}
          </span>
        ))
      )}
    </div>
  );
}

function ContextCard({
  id,
  label,
  text,
}: {
  id: string | undefined;
  label: string;
  text: string | undefined;
}): ReactElement {
  return (
    <article className="context-card">
      <div>
        <strong>{label}</strong>
        <span>Message {id ?? 'unknown'}</span>
      </div>
      <p>{text ?? '未保存可展示的脱敏文本。'}</p>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false });
}

function formatScore(value: number | undefined): string {
  return value === undefined ? '未评分' : `${Math.round(value * 100)}%`;
}

function suggestionStatusLabel(status: KnowledgeCandidateImprovementSuggestion['status']): string {
  switch (status) {
    case 'needs_clarification':
      return '需要补充信息';
    case 'no_change':
      return '无需修改';
    case 'suggestion':
      return '可供应用';
  }
}

function toDateTimeLocal(value: string | undefined): string {
  if (value === undefined) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const offset = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
}

function splitCommaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
}

function errorMessage(error: unknown): string {
  if (error instanceof KnowledgeAdminApiError) {
    if (error.status === 401) clearStoredToken();
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function tabTitle(tab: AdminTab): string {
  switch (tab) {
    case 'account':
      return '我的账号与登录安全';
    case 'authors':
      return '可信作者与角色有效期';
    case 'candidates':
      return '知识候选审核与治理';
    case 'groups':
      return 'Telegram 群聊与读取状态';
    case 'graph':
      return '知识图谱与证据关系治理';
    case 'imports':
      return 'Telegram 知识导入';
    case 'publications':
      return '发布任务与恢复';
    case 'quality':
      return '回答质量评测与基线';
    case 'support':
      return '客服会话与工单';
    case 'users':
      return '管理员用户与权限';
  }
}

function readStoredToken(): string {
  if (typeof window === 'undefined') return '';
  return window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';
}

function storeToken(token: string): void {
  if (typeof window !== 'undefined') window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
}

function clearStoredToken(): void {
  if (typeof window !== 'undefined') window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}
