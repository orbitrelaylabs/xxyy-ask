export type KnowledgeRefreshState =
  | 'disabled'
  | 'failed'
  | 'healthy'
  | 'pending'
  | 'stale'
  | 'unavailable';

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

export type KnowledgeRefreshStatusResult =
  | { kind: 'loaded'; status: KnowledgeRefreshStatus }
  | { kind: 'error' };

export async function checkKnowledgeRefreshStatus(
  fetchImpl: typeof fetch,
): Promise<KnowledgeRefreshStatusResult> {
  try {
    const response = await fetchImpl('/api/knowledge-refresh-status', {
      headers: { Accept: 'application/json' },
      method: 'GET',
    });
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok || !isKnowledgeRefreshStatus(payload)) {
      return { kind: 'error' };
    }
    return { kind: 'loaded', status: payload };
  } catch {
    return { kind: 'error' };
  }
}

function isKnowledgeRefreshStatus(value: unknown): value is KnowledgeRefreshStatus {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    !isRefreshState(value.state) ||
    !isRecord(value.schedule) ||
    typeof value.schedule.fullDailyAt !== 'string' ||
    typeof value.schedule.incrementalEveryMinutes !== 'number' ||
    typeof value.schedule.timeZone !== 'string'
  ) {
    return false;
  }
  if (value.lastRun === undefined) {
    return true;
  }
  return (
    isRecord(value.lastRun) &&
    typeof value.lastRun.finishedAt === 'string' &&
    (value.lastRun.mode === 'full' || value.lastRun.mode === 'incremental') &&
    (value.lastRun.status === 'failed' || value.lastRun.status === 'succeeded')
  );
}

function isRefreshState(value: unknown): value is KnowledgeRefreshState {
  return (
    value === 'disabled' ||
    value === 'failed' ||
    value === 'healthy' ||
    value === 'pending' ||
    value === 'stale' ||
    value === 'unavailable'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
