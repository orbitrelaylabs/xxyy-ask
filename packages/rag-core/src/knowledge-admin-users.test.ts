import { describe, expect, it } from 'vitest';

import {
  createPgKnowledgeAdminUserStore,
  migrateKnowledgeAdminUsers,
} from './knowledge-admin-users.js';
import type { PgClientLike } from './pgvector-store.js';

describe('database knowledge administrators', () => {
  it('migrates users, sessions, and authentication audit tables', async () => {
    const statements: string[] = [];
    await migrateKnowledgeAdminUsers({
      query<T>(sql: string) {
        statements.push(sql);
        return Promise.resolve({ rows: [] as T[] });
      },
    });

    const sql = statements.join('\n');
    expect(sql).toContain('create table if not exists knowledge_admin_users');
    expect(sql).toContain('create table if not exists knowledge_admin_sessions');
    expect(sql).toContain('create table if not exists knowledge_admin_auth_events');
    expect(sql).not.toContain('plaintext_password');
  });

  it('creates a password-hashed user and issues an expiring database session', async () => {
    let storedUser: Record<string, unknown> | undefined;
    const client: PgClientLike = {
      query<T>(sql: string, values: readonly unknown[] = []) {
        if (sql.includes('with created as')) {
          storedUser = {
            created_at: '2026-07-31T01:00:00.000Z',
            display_name: values[1],
            id: values[0],
            last_login_at: null,
            password_hash: values[4],
            password_salt: values[3],
            role: values[2],
            status: 'active',
            updated_at: '2026-07-31T01:00:00.000Z',
          };
          return Promise.resolve({ rows: [storedUser as T] });
        }
        if (sql.includes('from knowledge_admin_users') && sql.includes("status = 'active'")) {
          return Promise.resolve({ rows: storedUser === undefined ? [] : [storedUser as T] });
        }
        if (sql.includes('with user_updated as')) {
          if (storedUser !== undefined) {
            storedUser.password_salt = values[1];
            storedUser.password_hash = values[2];
          }
          return Promise.resolve({ rows: [{ id: values[0] } as T] });
        }
        return Promise.resolve({ rows: [] as T[] });
      },
    };
    const store = createPgKnowledgeAdminUserStore({ client });

    const user = await store.createUser({
      actor: 'system:test',
      displayName: 'Local Admin',
      id: 'local-admin',
      password: 'correct-horse-battery-staple',
      role: 'admin',
    });
    const session = await store.login({
      id: 'local-admin',
      password: 'correct-horse-battery-staple',
      sessionTtlMs: 60_000,
    });
    const rejected = await store.login({
      id: 'local-admin',
      password: 'incorrect-password-value',
    });
    const passwordChanged = await store.changeOwnPassword({
      currentPassword: 'correct-horse-battery-staple',
      currentSessionToken: session?.token ?? '',
      id: 'local-admin',
      newPassword: 'new-correct-horse-battery-staple',
    });
    const oldPasswordRejected = await store.login({
      id: 'local-admin',
      password: 'correct-horse-battery-staple',
    });
    const newPasswordAccepted = await store.login({
      id: 'local-admin',
      password: 'new-correct-horse-battery-staple',
    });

    expect(user).toMatchObject({ id: 'local-admin', role: 'admin', status: 'active' });
    expect(storedUser?.password_hash).toBeInstanceOf(Buffer);
    expect(storedUser?.password_hash).not.toBe('correct-horse-battery-staple');
    expect(session?.principal).toMatchObject({ id: 'local-admin', role: 'admin' });
    expect(session?.token).toMatch(/^[A-Za-z0-9_-]{40,128}$/u);
    expect(rejected).toBeUndefined();
    expect(passwordChanged).toBe(true);
    expect(oldPasswordRejected).toBeUndefined();
    expect(newPasswordAccepted?.principal.id).toBe('local-admin');
  });

  it('serializes first-run administrator creation and fixes its role to admin', async () => {
    let observedSql = '';
    let observedValues: readonly unknown[] = [];
    const store = createPgKnowledgeAdminUserStore({
      client: {
        query<T>(sql: string, values: readonly unknown[] = []) {
          observedSql = sql;
          observedValues = values;
          return Promise.resolve({
            rows: [
              {
                created_at: '2026-07-31T01:00:00.000Z',
                display_name: values[1],
                id: values[0],
                last_login_at: null,
                password_hash: values[3],
                password_salt: values[2],
                role: 'admin',
                status: 'active',
                updated_at: '2026-07-31T01:00:00.000Z',
              } as T,
            ],
          });
        },
      },
    });

    const user = await store.createInitialAdmin({
      displayName: 'Owner',
      id: 'owner',
      password: 'correct-horse-battery-staple',
    });

    expect(user.role).toBe('admin');
    expect(observedSql).toContain('pg_advisory_xact_lock');
    expect(observedSql).toContain('where not exists (select 1 from knowledge_admin_users)');
    expect(observedValues).toHaveLength(4);
  });

  it('rejects weak passwords before accessing the database', async () => {
    const store = createPgKnowledgeAdminUserStore({
      client: {
        query<T>() {
          return Promise.resolve({ rows: [] as T[] });
        },
      },
    });

    await expect(
      store.createUser({
        actor: 'system:test',
        displayName: 'Admin',
        id: 'admin',
        password: 'short',
        role: 'admin',
      }),
    ).rejects.toThrow('between 12 and 256');
  });
});
