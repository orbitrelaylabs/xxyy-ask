import { useCallback, useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactElement } from 'react';

import { KnowledgeAdminApiError, knowledgeAdminRequest } from './admin-api.js';
import type {
  AdminPermission,
  AdminSession,
  CandidateDetail,
  CandidateStatus,
  KnowledgeCandidate,
  KnowledgeCurationMode,
  KnowledgeGapRecord,
  PublicationJob,
  PublicationStatus,
  QualityTrend,
  SupportConversation,
  SupportConversationMessage,
  SupportOperationsMetrics,
  SupportTicket,
  SupportTicketPriority,
  SupportTicketStatus,
  TelegramImportResult,
  TrustedAuthor,
} from './admin-types.js';

const ADMIN_TOKEN_STORAGE_KEY = 'xxyy.knowledgeAdmin.token';
type AdminTab = 'authors' | 'candidates' | 'imports' | 'publications' | 'support';

export function AdminApp(): ReactElement {
  const initialToken = readStoredToken();
  const [token, setToken] = useState(initialToken);
  const [session, setSession] = useState<AdminSession | undefined>();
  const [authBusy, setAuthBusy] = useState(initialToken.length > 0);
  const [authError, setAuthError] = useState<string | undefined>();
  const [activeTab, setActiveTab] = useState<AdminTab>('candidates');

  const authenticate = useCallback(async (candidateToken: string): Promise<void> => {
    const normalized = candidateToken.trim();
    if (normalized.length === 0) {
      setAuthError('请输入管理令牌。');
      return;
    }
    setAuthBusy(true);
    setAuthError(undefined);
    try {
      const nextSession = await knowledgeAdminRequest<AdminSession>(normalized, '/me');
      setToken(normalized);
      setSession(nextSession);
      storeToken(normalized);
    } catch (error) {
      clearStoredToken();
      setSession(undefined);
      setToken('');
      setAuthError(errorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialToken.length > 0) {
      void authenticate(initialToken);
    }
  }, [authenticate, initialToken]);

  const logout = (): void => {
    clearStoredToken();
    setSession(undefined);
    setToken('');
    setAuthError(undefined);
  };

  if (session === undefined) {
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
          {activeTab === 'authors' ? (
            <TrustedAuthorsPanel permissions={permissions} token={token} />
          ) : undefined}
          {activeTab === 'imports' ? (
            <TelegramImportPanel permissions={permissions} token={token} />
          ) : undefined}
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

function AdminLogin({
  busy,
  error,
  onLogin,
}: {
  busy: boolean;
  error: string | undefined;
  onLogin: (token: string) => Promise<void>;
}): ReactElement {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void onLogin(value);
  };

  return (
    <main className="admin-login-page">
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <div className="admin-login-mark">XY</div>
        <div className="admin-eyebrow">XXYY Knowledge Governance</div>
        <h1 id="admin-login-title">知识库管理后台</h1>
        <p>使用由运维人员签发的高熵管理令牌登录。令牌只保存在当前浏览器标签会话中。</p>
        <form onSubmit={submit}>
          <label htmlFor="admin-token">管理令牌</label>
          <input
            autoComplete="off"
            id="admin-token"
            onChange={(event) => setValue(event.target.value)}
            placeholder="粘贴管理令牌"
            type="password"
            value={value}
          />
          {error === undefined ? undefined : <div className="admin-alert error">{error}</div>}
          <button className="admin-primary-button" disabled={busy} type="submit">
            {busy ? '正在验证…' : '进入管理后台'}
          </button>
        </form>
        <div className="admin-security-note">
          未配置 <code>KNOWLEDGE_ADMIN_TOKENS_JSON</code> 时，管理 API 默认关闭。
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
    { id: 'support', label: '客服工作台', meta: '会话、工单与人工接管' },
    { id: 'candidates', label: '知识候选', meta: '自动决策与冲突观察' },
    { id: 'publications', label: '发布任务', meta: '自动队列与故障观察' },
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

function CandidatesPanel({
  permissions,
  token,
}: {
  permissions: ReadonlySet<AdminPermission>;
  token: string;
}): ReactElement {
  const [status, setStatus] = useState<CandidateStatus | ''>('');
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
      decision === 'approve' ? '紧急批准已记录，可修复发布任务。' : '紧急拒绝已记录。',
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
          description="Curator 标准化结果。自动治理会直接作出决定；编辑仅用于紧急纠错。"
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
          <label className="span-2">
            标准答案
            <textarea
              disabled={!canReview}
              onChange={(event) => setAnswer(event.target.value)}
              rows={6}
              value={answer}
            />
          </label>
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
            description="正常流程无需人工操作。这里只处理自动治理被中断后遗留的 pending 候选，并保留认证主体审计。"
            title="紧急人工覆盖"
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
    case 'authors':
      return '可信作者与角色有效期';
    case 'candidates':
      return '知识候选自动治理';
    case 'imports':
      return 'Telegram 知识导入';
    case 'publications':
      return '发布任务与恢复';
    case 'support':
      return '客服会话与工单';
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
