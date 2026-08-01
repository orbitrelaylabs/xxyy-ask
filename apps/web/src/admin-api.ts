export class KnowledgeAdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'KnowledgeAdminApiError';
  }
}

export async function knowledgeAdminLogin(
  id: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  expiresAt: string;
  permissions: string[];
  principal: { displayName: string; id: string; role: string };
  sessionToken: string;
}> {
  const response = await fetchImpl('/admin/api/auth/login', {
    body: JSON.stringify({ id, password }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    throw new KnowledgeAdminApiError(
      typeof payload.message === 'string' ? payload.message : 'Administrator login failed.',
      response.status,
      typeof payload.error === 'string' ? payload.error : undefined,
    );
  }
  return payload as {
    expiresAt: string;
    permissions: string[];
    principal: { displayName: string; id: string; role: string };
    sessionToken: string;
  };
}

export async function knowledgeAdminSetup(
  input: { displayName: string; id: string; password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{
  expiresAt: string;
  permissions: string[];
  principal: { displayName: string; id: string; role: string };
  sessionToken: string;
}> {
  return unauthenticatedAdminRequest('/auth/setup', input, fetchImpl);
}

export async function knowledgeAdminSetupStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<{ setupRequired: boolean }> {
  const response = await fetchImpl('/admin/api/auth/setup-status', { method: 'GET' });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    throw new KnowledgeAdminApiError(
      typeof payload.message === 'string' ? payload.message : 'Administrator setup check failed.',
      response.status,
      typeof payload.error === 'string' ? payload.error : undefined,
    );
  }
  return payload as { setupRequired: boolean };
}

export async function knowledgeAdminRequest<T>(
  token: string,
  path: string,
  options: {
    body?: unknown;
    method?: 'GET' | 'PATCH' | 'POST';
    fetchImpl?: typeof fetch;
  } = {},
): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`/admin/api${path}`, {
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    method: options.method ?? 'GET',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    throw new KnowledgeAdminApiError(
      typeof payload.message === 'string' ? payload.message : 'Knowledge administration failed.',
      response.status,
      typeof payload.error === 'string' ? payload.error : undefined,
    );
  }
  return payload as T;
}

async function unauthenticatedAdminRequest<T>(
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(`/admin/api${path}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    message?: unknown;
  };
  if (!response.ok) {
    throw new KnowledgeAdminApiError(
      typeof payload.message === 'string' ? payload.message : 'Knowledge administration failed.',
      response.status,
      typeof payload.error === 'string' ? payload.error : undefined,
    );
  }
  return payload as T;
}
