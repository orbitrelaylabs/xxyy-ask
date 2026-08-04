import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactElement, RefObject } from 'react';

import { readChatStream } from './chat-stream.js';
import {
  checkKnowledgeRefreshStatus,
  type KnowledgeRefreshStatus,
  type KnowledgeRefreshStatusResult,
} from './knowledge-refresh-status.js';
import { Markdown } from './Markdown.js';
import { checkModelHealth, type ModelHealthCheck, type ModelHealthResult } from './model-health.js';
import type { Attachment, ChatMessage, Citation } from './types.js';

const QUICK_PROMPTS = [
  'XXYY 有 APP 吗？',
  'XXYY Pro 有哪些权益？',
  'XXYY 支持跟单么？',
  '如何设置 Telegram 钱包监控？',
  'XXYY 怎么设置挂单交易？',
];

const SESSION_STORAGE_KEY = 'xxyy.ask.sessionId';
type FeedbackFailureReason =
  | 'context_misunderstood'
  | 'incorrect'
  | 'incorrect_steps'
  | 'incomplete'
  | 'knowledge_missing'
  | 'off_topic'
  | 'outdated'
  | 'too_verbose'
  | 'unsupported_citation'
  | 'other';

const FEEDBACK_FAILURE_OPTIONS: Array<{ label: string; value: FeedbackFailureReason }> = [
  { label: '答非所问', value: 'off_topic' },
  { label: '回答不完整', value: 'incomplete' },
  { label: '内容已过时', value: 'outdated' },
  { label: '事实不正确', value: 'incorrect' },
  { label: '操作步骤有误', value: 'incorrect_steps' },
  { label: '引用不支持结论', value: 'unsupported_citation' },
  { label: '误解了上下文', value: 'context_misunderstood' },
  { label: '知识库缺少内容', value: 'knowledge_missing' },
  { label: '回答太啰嗦', value: 'too_verbose' },
  { label: '其他', value: 'other' },
];
export function appendAssistantAnswerDelta(message: ChatMessage, delta: string): ChatMessage {
  const { meta: _meta, statusMessage: _statusMessage, ...rest } = message;
  return {
    ...rest,
    rawAnswer: message.rawAnswer + delta,
    text: message.text + delta,
  };
}

export function App(): ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([createWelcomeMessage()]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [modelTestBusy, setModelTestBusy] = useState(false);
  const [modelTestOpen, setModelTestOpen] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<ModelHealthResult | undefined>();
  const [knowledgeRefreshResult, setKnowledgeRefreshResult] = useState<
    KnowledgeRefreshStatusResult | undefined
  >();
  const [supportRequest, setSupportRequest] = useState<
    { kind: 'error' | 'success'; message: string } | undefined
  >();
  const [supportRequestBusy, setSupportRequestBusy] = useState(false);
  const [sessionId, setSessionId] = useState(() => getSessionId());
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      const result = await checkKnowledgeRefreshStatus(fetch);
      if (active) {
        setKnowledgeRefreshResult(result);
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (supportRequest?.kind !== 'success') return;
    let active = true;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/support/status?sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!response.ok) return;
        const payload = (await response.json()) as {
          conversation?: { status?: string };
          messages?: Array<{ content: string; createdAt: string; id: string }>;
        };
        if (!active) return;
        setMessages((current) => {
          const ids = new Set(current.map((message) => message.id));
          const supportMessages = (payload.messages ?? [])
            .filter((message) => !ids.has(`support:${message.id}`))
            .map(
              (message): ChatMessage => ({
                attachments: [],
                citations: [],
                id: `support:${message.id}`,
                meta: `人工客服 · ${formatSupportReplyTime(message.createdAt)}`,
                rawAnswer: message.content,
                role: 'assistant',
                text: message.content,
              }),
            );
          return supportMessages.length === 0 ? current : [...current, ...supportMessages];
        });
        if (
          payload.conversation?.status === 'resolved' ||
          payload.conversation?.status === 'closed'
        ) {
          setSupportRequest({
            kind: 'success',
            message: `人工客服工单已${payload.conversation.status === 'resolved' ? '解决' : '关闭'}。`,
          });
        }
      } catch {
        // Polling is best-effort; the existing ticket remains durable.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId, supportRequest?.kind]);

  const scrollMessagesToBottom = (): void => {
    window.requestAnimationFrame(() => {
      const messagesNode = messagesRef.current;
      if (messagesNode !== null) {
        messagesNode.scrollTop = messagesNode.scrollHeight;
      }
    });
  };

  const updateAssistantMessage = (
    id: string,
    updater: (message: ChatMessage) => ChatMessage,
  ): void => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? updater(message) : message)),
    );
    scrollMessagesToBottom();
  };

  const submitPrompt = async (rawText: string): Promise<void> => {
    const text = rawText.trim();
    if (text.length === 0 || busy) {
      return;
    }

    const assistantId = createId('assistant');
    setMessages((current) => [
      ...current.filter((message) => message.id !== 'welcome'),
      createUserMessage(text),
      createAssistantMessage(assistantId, text),
    ]);
    setInput('');
    setBusy(true);
    scrollMessagesToBottom();

    try {
      const response = await fetch('/api/chat/stream', {
        body: JSON.stringify({ channel: 'web', message: text, sessionId }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: unknown };
        throw new Error(typeof payload.message === 'string' ? payload.message : 'Request failed.');
      }
      if (response.body === null) {
        throw new Error('Streaming response is unavailable.');
      }

      await readChatStream(response.body, (streamEvent) => {
        if (streamEvent.event === 'status') {
          const statusMessage = streamEvent.payload.message ?? '处理中…';
          updateAssistantMessage(assistantId, (message) => ({
            ...message,
            statusMessage,
          }));
          return;
        }

        if (streamEvent.event === 'answer_delta') {
          const delta = streamEvent.payload.delta ?? '';
          updateAssistantMessage(assistantId, (message) =>
            appendAssistantAnswerDelta(message, delta),
          );
          return;
        }

        if (streamEvent.event === 'metadata') {
          const metadata = streamEvent.payload;
          updateAssistantMessage(assistantId, (message) => {
            const { meta: _meta, statusMessage: _statusMessage, ...rest } = message;
            return {
              ...rest,
              attachments: metadata.attachments ?? [],
              citations: metadata.citations ?? [],
              confidence: metadata.confidence,
              intent: metadata.intent,
            };
          });
          return;
        }

        if (streamEvent.event === 'error') {
          throw new Error(streamEvent.payload.message ?? 'Request failed.');
        }
      });

      updateAssistantMessage(assistantId, (message) => {
        const { meta: _meta, status: _status, statusMessage: _statusMessage, ...rest } = message;
        return rest;
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      updateAssistantMessage(assistantId, (message) => ({
        ...message,
        rawAnswer: errorMessage,
        status: 'error',
        text: errorMessage,
      }));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitPrompt(input);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt(input);
    }
  };

  const clearChat = (): void => {
    const nextSessionId = resetSessionId();
    setSessionId(nextSessionId);
    setMessages([]);
    setInput('');
    setSupportRequest(undefined);
  };

  const escalateToSupport = async (): Promise<void> => {
    if (supportRequestBusy) return;
    const lastQuestion = [...messages].reverse().find((message) => message.role === 'user')?.text;
    setSupportRequestBusy(true);
    setSupportRequest(undefined);
    try {
      const response = await fetch('/api/support/escalate', {
        body: JSON.stringify({
          channel: 'web',
          priority: 'normal',
          reason: 'explicit_human_request',
          sessionId,
          subject:
            lastQuestion === undefined
              ? '用户请求人工客服'
              : `用户请求人工客服：${lastQuestion.slice(0, 160)}`,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        ticket?: { id?: unknown };
      };
      if (!response.ok) {
        throw new Error(
          typeof payload.message === 'string' ? payload.message : '人工客服请求提交失败。',
        );
      }
      const ticketId = typeof payload.ticket?.id === 'string' ? payload.ticket.id : undefined;
      setSupportRequest({
        kind: 'success',
        message:
          ticketId === undefined
            ? '已提交人工客服请求。'
            : `已提交人工客服请求，工单号：${ticketId}`,
      });
    } catch (error) {
      setSupportRequest({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSupportRequestBusy(false);
    }
  };

  const submitFeedback = async (
    message: ChatMessage,
    rating: 'positive' | 'negative',
    failureReason?: FeedbackFailureReason,
  ): Promise<void> => {
    if (message.question === undefined || message.intent === undefined) {
      return;
    }
    updateAssistantMessage(message.id, (current) => ({
      ...current,
      feedbackStatus: 'submitting',
    }));
    try {
      const response = await fetch('/api/feedback', {
        body: JSON.stringify({
          answer: message.rawAnswer,
          channel: 'web',
          citationCount: message.citations.length,
          intent: message.intent,
          question: message.question,
          rating,
          ...(failureReason === undefined ? {} : { failureReason }),
          sessionId,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error('Feedback request failed.');
      }
      updateAssistantMessage(message.id, (current) => ({
        ...current,
        feedbackStatus: rating,
      }));
    } catch {
      updateAssistantMessage(message.id, (current) => ({
        ...current,
        feedbackStatus: 'error',
      }));
    }
  };

  const runModelTest = async (): Promise<void> => {
    if (modelTestBusy) {
      return;
    }
    setModelTestBusy(true);
    setModelTestResult(undefined);
    try {
      setModelTestResult(await checkModelHealth(fetch));
    } finally {
      setModelTestBusy(false);
    }
  };

  const openModelTest = (): void => {
    setModelTestOpen(true);
    void runModelTest();
  };

  return (
    <main className="app-shell">
      <Sidebar busy={busy} onPrompt={submitPrompt} />
      <section aria-label="chat" className="chat-workbench">
        <ChatHeader
          knowledgeRefreshResult={knowledgeRefreshResult}
          onClear={clearChat}
          onEscalate={escalateToSupport}
          onModelTest={openModelTest}
          supportRequestBusy={supportRequestBusy}
        />
        {supportRequest === undefined ? undefined : (
          <div
            className={`support-request-notice is-${supportRequest.kind}`}
            role={supportRequest.kind === 'error' ? 'alert' : 'status'}
          >
            {supportRequest.message}
          </div>
        )}
        <MessageList messages={messages} messagesRef={messagesRef} onFeedback={submitFeedback} />
        <form className="composer-wrap" id="chat-form" onSubmit={onSubmit}>
          <div className="composer">
            <label className="sr-only" htmlFor="message">
              Message
            </label>
            <textarea
              id="message"
              name="message"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="产品问题，或粘贴 Explorer 交易链接查询基础信息/被夹/池子"
              required
              value={input}
            />
            <button aria-label="发送" className="send-button" disabled={busy} type="submit">
              <SendIcon />
            </button>
          </div>
        </form>
      </section>
      {modelTestOpen ? (
        <ModelTestPanel
          busy={modelTestBusy}
          onClose={() => setModelTestOpen(false)}
          onRetry={runModelTest}
          result={modelTestResult}
        />
      ) : undefined}
    </main>
  );
}

function Sidebar({
  busy,
  onPrompt,
}: {
  busy: boolean;
  onPrompt: (prompt: string) => Promise<void>;
}): ReactElement {
  return (
    <aside aria-label="workspace" className="sidebar">
      <div className="brand">
        <div aria-hidden="true" className="brand-mark">
          XY
        </div>
        <div>
          <div className="brand-name">XXYY Ask</div>
          <div className="brand-subtitle">产品客服 Agent</div>
        </div>
      </div>

      <section aria-label="quick questions" className="sidebar-section">
        <div className="section-label">快捷问题</div>
        {QUICK_PROMPTS.map((prompt) => (
          <button
            className="quick-prompt"
            disabled={busy}
            key={prompt}
            onClick={() => {
              void onPrompt(prompt);
            }}
            type="button"
          >
            {shortPrompt(prompt)}
            <ChevronRightIcon />
          </button>
        ))}
      </section>

      <section aria-label="scope" className="sidebar-section secondary">
        <div className="section-label">回答边界</div>
        <ul className="scope-list">
          <li>
            <span className="dot" />
            产品功能与配置
          </li>
          <li>
            <span className="dot" />
            Pro 权益与更新日志
          </li>
          <li>
            <span className="dot" />
            公开交易、被夹与池子查证
          </li>
          <li>
            <span className="dot warn" />
            不查询账户或私有记录
          </li>
          <li>
            <span className="dot warn" />
            不提供投资建议
          </li>
        </ul>
      </section>
    </aside>
  );
}

function ChatHeader({
  knowledgeRefreshResult,
  onClear,
  onEscalate,
  onModelTest,
  supportRequestBusy,
}: {
  knowledgeRefreshResult: KnowledgeRefreshStatusResult | undefined;
  onClear: () => void;
  onEscalate: () => Promise<void>;
  onModelTest: () => void;
  supportRequestBusy: boolean;
}): ReactElement {
  return (
    <header className="chat-header">
      <div>
        <h1>XXYY Agent</h1>
        <div className="header-subtitle">XXYY 产品问答客服</div>
      </div>
      <div className="header-actions">
        <KnowledgeRefreshBadge result={knowledgeRefreshResult} />
        <button className="model-test-button" onClick={onModelTest} type="button">
          模型测试
        </button>
        <button
          className="support-request-button"
          disabled={supportRequestBusy}
          onClick={() => void onEscalate()}
          type="button"
        >
          {supportRequestBusy ? '提交中…' : '转人工'}
        </button>
        <button className="clear-button" onClick={onClear} type="button">
          新对话
        </button>
      </div>
    </header>
  );
}

export function KnowledgeRefreshBadge({
  result,
}: {
  result: KnowledgeRefreshStatusResult | undefined;
}): ReactElement {
  const presentation = knowledgeRefreshPresentation(result);
  return (
    <div
      aria-live="polite"
      className={`knowledge-refresh-badge is-${presentation.tone}`}
      role="status"
      title={presentation.title}
    >
      <span aria-hidden="true" className="knowledge-refresh-dot" />
      <span>
        <strong>{presentation.label}</strong>
        <small>{presentation.detail}</small>
      </span>
    </div>
  );
}

function knowledgeRefreshPresentation(result: KnowledgeRefreshStatusResult | undefined): {
  detail: string;
  label: string;
  title: string;
  tone: 'error' | 'healthy' | 'muted' | 'warn';
} {
  if (result === undefined) {
    return {
      detail: '正在检测状态',
      label: '知识库自动更新',
      title: '正在读取自动更新状态',
      tone: 'muted',
    };
  }
  if (result.kind === 'error') {
    return {
      detail: '状态暂不可用',
      label: '知识库自动更新',
      title: '无法读取自动更新状态',
      tone: 'error',
    };
  }

  const { status } = result;
  const schedule = `每日 ${status.schedule.incrementalDailyAt} 增量更新，全量更新仅手动执行（${status.schedule.timeZone}）`;
  const lastRun = formatLastKnowledgeRefresh(status);
  if (!status.enabled || status.state === 'disabled') {
    return {
      detail: '未开启',
      label: '知识库自动更新',
      title: schedule,
      tone: 'muted',
    };
  }
  if (status.state === 'healthy') {
    return {
      detail: lastRun ?? `已开启 · 每日 ${status.schedule.incrementalDailyAt}`,
      label: '知识库自动更新已开启',
      title: `${schedule}${lastRun === undefined ? '' : `；${lastRun}`}`,
      tone: 'healthy',
    };
  }
  if (status.state === 'pending') {
    return {
      detail: '已开启 · 等待首次刷新',
      label: '知识库自动更新',
      title: schedule,
      tone: 'warn',
    };
  }
  if (status.state === 'stale') {
    return {
      detail: lastRun ?? '已开启 · 刷新延迟',
      label: '知识库自动更新延迟',
      title: `${schedule}；最近回执已超过预期时间`,
      tone: 'warn',
    };
  }
  return {
    detail: status.state === 'failed' ? (lastRun ?? '最近刷新失败') : '状态文件不可用',
    label: status.state === 'failed' ? '知识库自动更新异常' : '知识库自动更新',
    title: schedule,
    tone: 'error',
  };
}

function formatLastKnowledgeRefresh(status: KnowledgeRefreshStatus): string | undefined {
  if (status.lastRun === undefined) {
    return undefined;
  }
  const finishedAt = new Date(status.lastRun.finishedAt);
  if (!Number.isFinite(finishedAt.getTime())) {
    return undefined;
  }
  try {
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      month: '2-digit',
      timeZone: status.schedule.timeZone,
    }).format(finishedAt);
    return `最近刷新 ${formatted}`;
  } catch {
    return `最近刷新 ${status.lastRun.finishedAt}`;
  }
}

function formatSupportReplyTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false });
}

function ModelTestPanel({
  busy,
  onClose,
  onRetry,
  result,
}: {
  busy: boolean;
  onClose: () => void;
  onRetry: () => Promise<void>;
  result: ModelHealthResult | undefined;
}): ReactElement {
  return (
    <div className="model-test-backdrop">
      <section
        aria-labelledby="model-test-title"
        aria-modal="true"
        className="model-test-panel"
        role="dialog"
      >
        <header className="model-test-header">
          <div>
            <h2 id="model-test-title">模型测试</h2>
            <p>检测当前 LLM 与 Embedding 是否可以正常访问。</p>
          </div>
          <button aria-label="关闭模型测试" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <div aria-live="polite" className="model-test-results">
          {busy || result === undefined ? (
            <p className="model-test-loading">正在检测…</p>
          ) : undefined}
          {!busy && result?.kind === 'error' ? (
            <p className="model-test-error" role="alert">
              {result.message}
            </p>
          ) : undefined}
          {!busy && result?.kind === 'report' ? (
            <div className="model-test-grid">
              <ModelTestCard check={result.llm} title="LLM" />
              <ModelTestCard check={result.embedding} title="Embedding" />
            </div>
          ) : undefined}
        </div>

        <footer className="model-test-footer">
          <span>{result === undefined ? '' : `耗时 ${result.durationMs} ms`}</span>
          <button
            disabled={busy}
            onClick={() => {
              void onRetry();
            }}
            type="button"
          >
            重新测试
          </button>
        </footer>
      </section>
    </div>
  );
}

function ModelTestCard({ check, title }: { check: ModelHealthCheck; title: string }): ReactElement {
  return (
    <article className={`model-test-card ${check.status === 'ok' ? 'is-ok' : 'is-error'}`}>
      <div>
        <h3>{title}</h3>
        <span>{check.status === 'ok' ? '正常' : '异常'}</span>
      </div>
      {check.model === undefined ? undefined : <p>模型：{check.model}</p>}
      {check.dimension === undefined ? undefined : <p>维度：{check.dimension}</p>}
      {check.message === undefined ? undefined : (
        <p className="model-test-message">{check.message}</p>
      )}
    </article>
  );
}

function MessageList({
  messages,
  messagesRef,
  onFeedback,
}: {
  messages: ChatMessage[];
  messagesRef: RefObject<HTMLDivElement | null>;
  onFeedback: (
    message: ChatMessage,
    rating: 'positive' | 'negative',
    failureReason?: FeedbackFailureReason,
  ) => Promise<void>;
}): ReactElement {
  return (
    <div aria-live="polite" className="messages" ref={messagesRef}>
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} onFeedback={onFeedback} />
      ))}
    </div>
  );
}

function MessageBubble({
  message,
  onFeedback,
}: {
  message: ChatMessage;
  onFeedback: (
    message: ChatMessage,
    rating: 'positive' | 'negative',
    failureReason?: FeedbackFailureReason,
  ) => Promise<void>;
}): ReactElement {
  const messageClassName = ['message', message.role, message.status === 'error' ? 'is-error' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <article
      className={messageClassName}
      data-welcome-message={message.id === 'welcome' || undefined}
    >
      <div aria-hidden="true" className="avatar">
        {message.role === 'user' ? 'You' : 'AI'}
      </div>
      <div className="bubble">
        <div className="bubble-content markdown-rendered">
          {message.status === 'streaming' && message.text.length === 0 ? (
            <span className="thinking">{message.statusMessage ?? 'Thinking'}</span>
          ) : message.role === 'assistant' ? (
            <Markdown text={message.text} />
          ) : (
            message.text
          )}
        </div>
        {message.role === 'assistant' ? (
          <>
            {message.meta === undefined ? undefined : (
              <div className="message-meta">{message.meta}</div>
            )}
            <CitationList citations={message.citations} />
            <AttachmentList attachments={message.attachments} />
            <FeedbackControls message={message} onFeedback={onFeedback} />
          </>
        ) : undefined}
      </div>
    </article>
  );
}

function FeedbackControls({
  message,
  onFeedback,
}: {
  message: ChatMessage;
  onFeedback: (
    message: ChatMessage,
    rating: 'positive' | 'negative',
    failureReason?: FeedbackFailureReason,
  ) => Promise<void>;
}): ReactElement | undefined {
  const [showNegativeReasons, setShowNegativeReasons] = useState(false);
  if (
    message.id === 'welcome' ||
    message.status !== undefined ||
    message.question === undefined ||
    message.intent === undefined ||
    message.rawAnswer.length === 0
  ) {
    return undefined;
  }

  const submitted = message.feedbackStatus === 'positive' || message.feedbackStatus === 'negative';
  const disabled = submitted || message.feedbackStatus === 'submitting';
  return (
    <div aria-label="回答反馈" className="feedback-controls">
      <span>
        {submitted
          ? '感谢反馈'
          : message.feedbackStatus === 'error'
            ? '提交失败，请重试'
            : '这个回答有帮助吗？'}
      </span>
      <button
        aria-label="回答有帮助"
        className={message.feedbackStatus === 'positive' ? 'is-selected' : ''}
        disabled={disabled}
        onClick={() => {
          void onFeedback(message, 'positive');
        }}
        type="button"
      >
        👍
      </button>
      <button
        aria-label="回答没有帮助"
        className={message.feedbackStatus === 'negative' ? 'is-selected' : ''}
        disabled={disabled}
        onClick={() => {
          setShowNegativeReasons(true);
        }}
        type="button"
      >
        👎
      </button>
      {showNegativeReasons && !disabled ? (
        <select
          aria-label="请选择回答问题"
          defaultValue=""
          onChange={(event) => {
            const failureReason = event.currentTarget.value as FeedbackFailureReason;
            if (failureReason.length > 0) void onFeedback(message, 'negative', failureReason);
          }}
        >
          <option disabled value="">
            请选择原因
          </option>
          {FEEDBACK_FAILURE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

export function CitationList({ citations }: { citations: Citation[] }): ReactElement {
  return (
    <div className="citation-list">
      {citations.map((citation, index) => (
        <article className="citation" key={`${citation.file}-${index}`}>
          <div className="citation-title">
            [{index + 1}] {citation.title}
            {citation.sourceType === undefined ? null : (
              <span className="citation-source">{citationSourceLabel(citation.sourceType)}</span>
            )}
          </div>
          {citation.sourceUrl === undefined ? null : (
            <div className="citation-meta">
              <a href={citation.sourceUrl} rel="noreferrer" target="_blank">
                {citationSourceLinkLabel(citation.sourceType)}
              </a>
            </div>
          )}
          <div className="citation-excerpt">{citation.excerpt}</div>
        </article>
      ))}
    </div>
  );
}

function citationSourceLabel(sourceType: NonNullable<Citation['sourceType']>): string {
  if (sourceType === 'official_docs') {
    return 'XXYY 官方文档';
  }
  if (sourceType === 'x_updates') {
    return 'XXYY 官方 X 更新';
  }
  return 'XXYY 客服群审核知识';
}

function citationSourceLinkLabel(sourceType: Citation['sourceType']): string {
  if (sourceType === 'official_docs') {
    return '查看官方文档';
  }
  if (sourceType === 'x_updates') {
    return '查看官方 X 更新';
  }
  return '查看原始来源';
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }): ReactElement {
  return (
    <div className="attachment-list">
      {attachments.map((attachment) => (
        <article className="attachment" key={`${attachment.kind}-${attachment.url}`}>
          <div className="attachment-title">{attachment.title}</div>
          {attachment.kind === 'video' && attachment.mediaType === 'video/mp4' ? (
            <video aria-label={attachment.title} controls preload="metadata" src={attachment.url} />
          ) : attachment.kind === 'video' ? (
            <a className="external-video" href={attachment.url} rel="noreferrer" target="_blank">
              {attachment.posterUrl === undefined ? null : (
                <img
                  alt={`${attachment.title} 封面`}
                  decoding="async"
                  loading="lazy"
                  src={attachment.posterUrl}
                />
              )}
              <span>打开原始视频</span>
            </a>
          ) : (
            <img alt={attachment.title} decoding="async" loading="lazy" src={attachment.url} />
          )}
        </article>
      ))}
    </div>
  );
}

function createWelcomeMessage(): ChatMessage {
  return {
    attachments: [],
    citations: [],
    id: 'welcome',
    rawAnswer:
      '你好，我可以回答 XXYY 产品功能、Pro 权益、交易设置、钱包监控和更新日志。你也可以发送一笔公开 Explorer 交易链接，查询基础交易信息，或检查是否被夹、买错池及小池；证据就绪时会附上真实 XXYY 标注截图。',
    role: 'assistant',
    text: '你好，我可以回答 XXYY 产品功能、Pro 权益、交易设置、钱包监控和更新日志。你也可以发送一笔公开 Explorer 交易链接，查询基础交易信息，或检查是否被夹、买错池及小池；证据就绪时会附上真实 XXYY 标注截图。',
  };
}

function createUserMessage(text: string): ChatMessage {
  return {
    attachments: [],
    citations: [],
    id: createId('user'),
    rawAnswer: text,
    role: 'user',
    text,
  };
}

function createAssistantMessage(id: string, question: string): ChatMessage {
  return {
    attachments: [],
    citations: [],
    id,
    question,
    rawAnswer: '',
    role: 'assistant',
    status: 'streaming',
    text: '',
  };
}

function shortPrompt(prompt: string): string {
  if (prompt === '如何设置 Telegram 钱包监控？') {
    return '如何设置钱包监控？';
  }
  return prompt;
}

function getSessionId(): string {
  try {
    const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing !== null && existing.length > 0) {
      return existing;
    }
    const next = createId('session');
    window.localStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return createId('session');
  }
}

function resetSessionId(): string {
  const next = createId('session');
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, next);
  } catch {
    // A fresh in-memory id still prevents stale follow-up context in this tab.
  }
  return next;
}

function createId(prefix: string): string {
  return window.crypto && typeof window.crypto.randomUUID === 'function'
    ? `${prefix}-${window.crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function SendIcon(): ReactElement {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 18 18" width="18">
      <path
        d="M9 14.5V3.5m0 0L4.5 8M9 3.5 13.5 8"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ChevronRightIcon(): ReactElement {
  return (
    <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 14 14" width="14">
      <path
        d="m5.25 3.5 3.5 3.5-3.5 3.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
