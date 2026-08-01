import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { PgClientLike } from './pgvector-store.js';

export type KnowledgeAdminRole = 'admin' | 'publisher' | 'reviewer' | 'viewer';
export type KnowledgeAdminUserStatus = 'active' | 'disabled';

export interface KnowledgeAdminPrincipal {
  displayName: string;
  id: string;
  role: KnowledgeAdminRole;
}

export interface KnowledgeAdminUser extends KnowledgeAdminPrincipal {
  createdAt: string;
  status: KnowledgeAdminUserStatus;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface KnowledgeAdminSession {
  expiresAt: string;
  principal: KnowledgeAdminPrincipal;
  token: string;
}

export interface PgKnowledgeAdminUserStore {
  authenticateSession(token: string): Promise<KnowledgeAdminPrincipal | undefined>;
  changeOwnPassword(input: {
    currentPassword: string;
    currentSessionToken: string;
    id: string;
    newPassword: string;
  }): Promise<boolean>;
  createInitialAdmin(input: {
    displayName: string;
    id: string;
    password: string;
  }): Promise<KnowledgeAdminUser>;
  createUser(input: {
    actor: string;
    displayName: string;
    id: string;
    password: string;
    role: KnowledgeAdminRole;
  }): Promise<KnowledgeAdminUser>;
  hasUsers(): Promise<boolean>;
  listUsers(): Promise<KnowledgeAdminUser[]>;
  login(input: {
    id: string;
    password: string;
    sessionTtlMs?: number;
  }): Promise<KnowledgeAdminSession | undefined>;
  logout(token: string): Promise<void>;
  migrate(): Promise<void>;
  updateUser(input: {
    actor: string;
    id: string;
    displayName?: string;
    password?: string;
    role?: KnowledgeAdminRole;
    status?: KnowledgeAdminUserStatus;
  }): Promise<KnowledgeAdminUser>;
}

interface KnowledgeAdminUserRow {
  created_at: string;
  display_name: string;
  id: string;
  last_login_at: string | null;
  password_hash: Buffer;
  password_salt: Buffer;
  role: KnowledgeAdminRole;
  status: KnowledgeAdminUserStatus;
  updated_at: string;
}

interface KnowledgeAdminSessionRow {
  display_name: string;
  expires_at: string;
  id: string;
  role: KnowledgeAdminRole;
}

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const SCRYPT_KEY_LENGTH = 64;
const USER_COLUMNS = `
  id,
  display_name,
  role,
  status,
  password_salt,
  password_hash,
  last_login_at::text as last_login_at,
  created_at::text as created_at,
  updated_at::text as updated_at
`;

export function createPgKnowledgeAdminUserStore(options: {
  client: PgClientLike;
}): PgKnowledgeAdminUserStore {
  return {
    async authenticateSession(rawToken): Promise<KnowledgeAdminPrincipal | undefined> {
      const token = normalizeSessionToken(rawToken);
      if (token === undefined) {
        return undefined;
      }
      const response = await options.client.query<KnowledgeAdminSessionRow>(
        `
        select
          users.id,
          users.display_name,
          users.role,
          sessions.expires_at::text as expires_at
        from knowledge_admin_sessions sessions
        join knowledge_admin_users users on users.id = sessions.user_id
        where
          sessions.token_hash = $1
          and sessions.revoked_at is null
          and sessions.expires_at > now()
          and users.status = 'active'
        limit 1
        `,
        [hashSessionToken(token)],
      );
      const row = response.rows[0];
      return row === undefined ? undefined : mapPrincipal(row);
    },

    async changeOwnPassword(input): Promise<boolean> {
      const id = normalizeUserId(input.id);
      const currentPassword = normalizePassword(input.currentPassword);
      const newPassword = normalizePassword(input.newPassword);
      const currentSessionToken = normalizeSessionToken(input.currentSessionToken);
      if (currentSessionToken === undefined) {
        return false;
      }
      const response = await options.client.query<KnowledgeAdminUserRow>(
        `
        select ${USER_COLUMNS}
        from knowledge_admin_users
        where id = $1 and status = 'active'
        limit 1
        `,
        [id],
      );
      const user = response.rows[0];
      const currentHash = await derivePasswordHash(
        currentPassword,
        user?.password_salt ?? Buffer.alloc(16),
      );
      const passwordValid = timingSafeEqual(
        currentHash,
        user?.password_hash ?? Buffer.alloc(SCRYPT_KEY_LENGTH),
      );
      if (!passwordValid || user === undefined) {
        return false;
      }
      if (timingSafeEqual(currentHash, await derivePasswordHash(newPassword, user.password_salt))) {
        throw new Error('The new administrator password must differ from the current password.');
      }

      const passwordSalt = randomBytes(16);
      const passwordHash = await derivePasswordHash(newPassword, passwordSalt);
      const updated = await options.client.query<{ id: string }>(
        `
        with user_updated as (
          update knowledge_admin_users
          set password_salt = $2, password_hash = $3, updated_at = now()
          where id = $1 and status = 'active'
          returning id
        ), sessions_revoked as (
          update knowledge_admin_sessions
          set revoked_at = now()
          where
            user_id = $1
            and token_hash <> $4
            and revoked_at is null
        ), audited as (
          insert into knowledge_admin_auth_events (user_id, event_type, actor, detail)
          select
            id,
            'user_updated',
            id,
            jsonb_build_object('passwordChanged', true, 'selfService', true)
          from user_updated
        )
        select id from user_updated
        `,
        [id, passwordSalt, passwordHash, hashSessionToken(currentSessionToken)],
      );
      return updated.rows[0]?.id === id;
    },

    async createInitialAdmin(input): Promise<KnowledgeAdminUser> {
      const id = normalizeUserId(input.id);
      const displayName = normalizeDisplayName(input.displayName);
      const password = normalizePassword(input.password);
      const passwordSalt = randomBytes(16);
      const passwordHash = await derivePasswordHash(password, passwordSalt);
      const response = await options.client.query<KnowledgeAdminUserRow>(
        `
        with locked as (
          select pg_advisory_xact_lock(hashtext('xxyy-knowledge-admin-initial-setup'))
        ), created as (
          insert into knowledge_admin_users (
            id, display_name, role, status, password_salt, password_hash
          )
          select $1, $2, 'admin', 'active', $3, $4
          from locked
          where not exists (select 1 from knowledge_admin_users)
          returning ${USER_COLUMNS}
        ), audited as (
          insert into knowledge_admin_auth_events (user_id, event_type, actor, detail)
          select
            id,
            'user_created',
            'system:first-run-setup',
            jsonb_build_object('role', role, 'initialAdmin', true)
          from created
        )
        select ${USER_COLUMNS}
        from created
        `,
        [id, displayName, passwordSalt, passwordHash],
      );
      const row = response.rows[0];
      if (row === undefined) {
        throw new Error('Initial administrator setup is already complete.');
      }
      return mapUser(row);
    },

    async createUser(input): Promise<KnowledgeAdminUser> {
      const id = normalizeUserId(input.id);
      const displayName = normalizeDisplayName(input.displayName);
      const role = normalizeRole(input.role);
      const actor = normalizeActor(input.actor);
      const password = normalizePassword(input.password);
      const passwordSalt = randomBytes(16);
      const passwordHash = await derivePasswordHash(password, passwordSalt);
      const response = await options.client.query<KnowledgeAdminUserRow>(
        `
        with created as (
          insert into knowledge_admin_users (
            id, display_name, role, status, password_salt, password_hash
          )
          values ($1, $2, $3, 'active', $4, $5)
          returning ${USER_COLUMNS}
        ), audited as (
          insert into knowledge_admin_auth_events (user_id, event_type, actor, detail)
          select id, 'user_created', $6, jsonb_build_object('role', role)
          from created
        )
        select ${USER_COLUMNS}
        from created
        `,
        [id, displayName, role, passwordSalt, passwordHash, actor],
      );
      return requireUser(response.rows[0], id);
    },

    async hasUsers(): Promise<boolean> {
      const response = await options.client.query<{ exists: boolean }>(
        `select exists (select 1 from knowledge_admin_users) as exists`,
      );
      return response.rows[0]?.exists === true;
    },

    async listUsers(): Promise<KnowledgeAdminUser[]> {
      const response = await options.client.query<KnowledgeAdminUserRow>(
        `
        select ${USER_COLUMNS}
        from knowledge_admin_users
        order by status, role, id
        `,
      );
      return response.rows.map(mapUser);
    },

    async login(input): Promise<KnowledgeAdminSession | undefined> {
      const id = normalizeUserId(input.id);
      const password = normalizePassword(input.password);
      const response = await options.client.query<KnowledgeAdminUserRow>(
        `
        select ${USER_COLUMNS}
        from knowledge_admin_users
        where id = $1 and status = 'active'
        limit 1
        `,
        [id],
      );
      const user = response.rows[0];
      const candidateHash = await derivePasswordHash(
        password,
        user?.password_salt ?? Buffer.alloc(16),
      );
      const passwordValid = timingSafeEqual(
        candidateHash,
        user?.password_hash ?? Buffer.alloc(SCRYPT_KEY_LENGTH),
      );
      if (!passwordValid || user === undefined) {
        await options.client.query(
          `
          insert into knowledge_admin_auth_events (user_id, event_type, actor)
          values (null, 'login_failed', $1)
          `,
          [id],
        );
        return undefined;
      }

      const ttlMs = normalizeSessionTtl(input.sessionTtlMs);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      await options.client.query(
        `
        with session_created as (
          insert into knowledge_admin_sessions (token_hash, user_id, expires_at)
          values ($1, $2, $3::timestamptz)
        ), user_updated as (
          update knowledge_admin_users
          set last_login_at = now(), updated_at = now()
          where id = $2
        )
        insert into knowledge_admin_auth_events (user_id, event_type, actor)
        values ($2, 'login_succeeded', $2)
        `,
        [hashSessionToken(token), id, expiresAt],
      );
      return {
        expiresAt,
        principal: mapPrincipal(user),
        token,
      };
    },

    async logout(rawToken): Promise<void> {
      const token = normalizeSessionToken(rawToken);
      if (token === undefined) {
        return;
      }
      await options.client.query(
        `
        with revoked as (
          update knowledge_admin_sessions
          set revoked_at = now()
          where token_hash = $1 and revoked_at is null
          returning user_id
        )
        insert into knowledge_admin_auth_events (user_id, event_type, actor)
        select user_id, 'logout', user_id
        from revoked
        `,
        [hashSessionToken(token)],
      );
    },

    migrate() {
      return migrateKnowledgeAdminUsers(options.client);
    },

    async updateUser(input): Promise<KnowledgeAdminUser> {
      const id = normalizeUserId(input.id);
      const actor = normalizeActor(input.actor);
      const displayName =
        input.displayName === undefined ? undefined : normalizeDisplayName(input.displayName);
      const role = input.role === undefined ? undefined : normalizeRole(input.role);
      const status = input.status === undefined ? undefined : normalizeStatus(input.status);
      const password = input.password === undefined ? undefined : normalizePassword(input.password);
      const passwordSalt = password === undefined ? undefined : randomBytes(16);
      const passwordHash =
        password === undefined || passwordSalt === undefined
          ? undefined
          : await derivePasswordHash(password, passwordSalt);
      if (
        displayName === undefined &&
        role === undefined &&
        status === undefined &&
        passwordHash === undefined
      ) {
        throw new Error('At least one administrator user field must be updated.');
      }

      const response = await options.client.query<KnowledgeAdminUserRow>(
        `
        with target as (
          select id, role, status
          from knowledge_admin_users
          where id = $1
        ), guard as (
          select case
            when exists (
              select 1 from target
              where role = 'admin' and status = 'active'
            )
            and ($3::text is not null and $3::text <> 'admin'
              or $4::text is not null and $4::text <> 'active')
            and (
              select count(*) from knowledge_admin_users
              where role = 'admin' and status = 'active'
            ) <= 1
            then false
            else true
          end as allowed
        ), updated as (
          update knowledge_admin_users
          set
            display_name = coalesce($2, display_name),
            role = coalesce($3, role),
            status = coalesce($4, status),
            password_salt = coalesce($5, password_salt),
            password_hash = coalesce($6, password_hash),
            updated_at = now()
          where id = $1 and (select allowed from guard)
          returning ${USER_COLUMNS}
        ), sessions_revoked as (
          update knowledge_admin_sessions
          set revoked_at = now()
          where
            user_id = $1
            and revoked_at is null
            and ($4::text = 'disabled' or $6::bytea is not null)
        ), audited as (
          insert into knowledge_admin_auth_events (user_id, event_type, actor, detail)
          select
            id,
            'user_updated',
            $7,
            jsonb_build_object(
              'displayNameChanged', $2::text is not null,
              'role', $3::text,
              'status', $4::text,
              'passwordChanged', $6::bytea is not null
            )
          from updated
        )
        select ${USER_COLUMNS}
        from updated
        `,
        [
          id,
          displayName ?? null,
          role ?? null,
          status ?? null,
          passwordSalt ?? null,
          passwordHash ?? null,
          actor,
        ],
      );
      return requireUser(response.rows[0], id);
    },
  };
}

export async function migrateKnowledgeAdminUsers(client: PgClientLike): Promise<void> {
  await client.query(
    `
    create table if not exists knowledge_admin_users (
      id text primary key,
      display_name text not null,
      role text not null check (role in ('viewer', 'reviewer', 'publisher', 'admin')),
      status text not null default 'active' check (status in ('active', 'disabled')),
      password_salt bytea not null,
      password_hash bytea not null,
      last_login_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
    `,
  );
  await client.query(
    `
    create table if not exists knowledge_admin_sessions (
      token_hash text primary key,
      user_id text not null references knowledge_admin_users(id) on delete cascade,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    )
    `,
  );
  await client.query(
    `
    create table if not exists knowledge_admin_auth_events (
      id bigserial primary key,
      user_id text,
      event_type text not null check (
        event_type in (
          'login_failed', 'login_succeeded', 'logout', 'user_created', 'user_updated'
        )
      ),
      actor text not null,
      detail jsonb,
      created_at timestamptz not null default now()
    )
    `,
  );
  await client.query(
    `
    create index if not exists knowledge_admin_sessions_user_expiry_idx
      on knowledge_admin_sessions (user_id, expires_at desc)
    `,
  );
  await client.query(
    `
    create index if not exists knowledge_admin_auth_events_created_idx
      on knowledge_admin_auth_events (created_at desc)
    `,
  );
}

function mapUser(row: KnowledgeAdminUserRow): KnowledgeAdminUser {
  return {
    ...mapPrincipal(row),
    createdAt: row.created_at,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.last_login_at === null ? {} : { lastLoginAt: row.last_login_at }),
  };
}

function mapPrincipal(row: {
  display_name: string;
  id: string;
  role: KnowledgeAdminRole;
}): KnowledgeAdminPrincipal {
  return { displayName: row.display_name, id: row.id, role: row.role };
}

function requireUser(row: KnowledgeAdminUserRow | undefined, id: string): KnowledgeAdminUser {
  if (row === undefined) {
    throw new Error(`Administrator user ${id} was not found or is the last active administrator.`);
  }
  return mapUser(row);
}

function derivePasswordHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, derivedKey) => {
      if (error === null) {
        resolve(derivedKey);
      } else {
        reject(error);
      }
    });
  });
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeSessionToken(value: string): string | undefined {
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{40,128}$/u.test(normalized) ? normalized : undefined;
}

function normalizePassword(value: string): string {
  if (value.length < 12 || value.length > 256) {
    throw new Error('Administrator passwords must contain between 12 and 256 characters.');
  }
  return value;
}

function normalizeUserId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/u.test(normalized)) {
    throw new Error('Administrator user id contains unsupported characters.');
  }
  return normalized;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0 || normalized.length > 160) {
    throw new Error('Administrator display name must contain between 1 and 160 characters.');
  }
  return normalized;
}

function normalizeRole(value: KnowledgeAdminRole): KnowledgeAdminRole {
  if (!['admin', 'publisher', 'reviewer', 'viewer'].includes(value)) {
    throw new Error('Unsupported administrator role.');
  }
  return value;
}

function normalizeStatus(value: KnowledgeAdminUserStatus): KnowledgeAdminUserStatus {
  if (value !== 'active' && value !== 'disabled') {
    throw new Error('Unsupported administrator status.');
  }
  return value;
}

function normalizeActor(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.:@/-]{1,200}$/u.test(normalized)) {
    throw new Error('Administrator actor contains unsupported characters.');
  }
  return normalized;
}

function normalizeSessionTtl(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SESSION_TTL_MS;
  }
  if (!Number.isSafeInteger(value) || value < 60_000 || value > MAX_SESSION_TTL_MS) {
    throw new Error('Administrator session TTL is out of range.');
  }
  return value;
}
