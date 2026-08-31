import { describe, expect, it } from 'vitest';

import { ensureBootstrapAdmin } from '../src/auth/bootstrap';
import { buildTestHarness, createUser, fixedNow, login } from './fakes';

describe('auth bootstrap', () => {
  it('creates the initial admin only once, when credentials are given and no users exist', async () => {
    const { users } = await buildTestHarness();

    const first = await ensureBootstrapAdmin(
      users,
      { email: 'Admin@Cre.test', password: 'bootstrap-pass' },
      fixedNow(),
    );
    expect(first).toEqual({ created: true, email: 'admin@cre.test' });
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0]).toMatchObject({ email: 'admin@cre.test', role: 'admin' });

    // Second call is a no-op — an operator already exists.
    const second = await ensureBootstrapAdmin(
      users,
      { email: 'other@cre.test', password: 'x' },
      fixedNow(),
    );
    expect(second.created).toBe(false);
    expect(users.rows).toHaveLength(1);
  });

  it('is a no-op without configured credentials', async () => {
    const { users } = await buildTestHarness();
    const result = await ensureBootstrapAdmin(users, {}, fixedNow());
    expect(result.created).toBe(false);
    expect(users.rows).toHaveLength(0);
  });
});

describe('POST /api/auth/login', () => {
  it('returns the shared LoginResponse shape for valid credentials', async () => {
    const h = await buildTestHarness();
    await createUser(h.users, { email: 'operator@cre.test', password: 'secret123' });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'operator@cre.test', password: 'secret123' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user).toMatchObject({
      email: 'operator@cre.test',
      role: 'operator',
      active: true,
    });
    // Credentials never leave the persistence layer.
    expect(body.user.passwordHash).toBeUndefined();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(16);
    expect(typeof body.expiresAt).toBe('string');
    // The session is stored as a hash — the raw token is never persisted.
    expect(h.sessions.rows).toHaveLength(1);
    expect(h.sessions.rows[0].tokenHash).not.toBe(body.token);
  });

  it('logs in case-insensitively by email', async () => {
    const h = await buildTestHarness();
    await createUser(h.users, { email: 'operator@cre.test', password: 'secret123' });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'OPERATOR@CRE.TEST', password: 'secret123' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a wrong password with 401 and creates no session', async () => {
    const h = await buildTestHarness();
    await createUser(h.users, { email: 'operator@cre.test', password: 'secret123' });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'operator@cre.test', password: 'wrong-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { message: 'invalid email or password', code: 'INVALID_CREDENTIALS' },
    });
    expect(h.sessions.rows).toHaveLength(0);
  });

  it('rejects unknown emails with the same 401 (no account enumeration)', async () => {
    const h = await buildTestHarness();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@cre.test', password: 'whatever' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { message: 'invalid email or password', code: 'INVALID_CREDENTIALS' },
    });
  });

  it('rejects deactivated accounts with 401', async () => {
    const h = await buildTestHarness();
    await createUser(h.users, { email: 'operator@cre.test', active: false });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'operator@cre.test', password: 'secret123' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects malformed payloads with 400 VALIDATION_ERROR', async () => {
    const h = await buildTestHarness();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the session user for a valid bearer token', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users, { email: 'operator@cre.test' });
    const token = await login(h.app);

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id, email: 'operator@cre.test' });
  });

  it('401s without a token and with a bogus token', async () => {
    const h = await buildTestHarness();

    const noToken = await h.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json().error.code).toBe('UNAUTHENTICATED');

    const bogus = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(bogus.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('invalidates the session so /me stops working', async () => {
    const h = await buildTestHarness();
    await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };

    const before = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(before.statusCode).toBe(200);

    const logout = await h.app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(logout.statusCode).toBe(204);
    expect(h.sessions.rows).toHaveLength(0);

    const after = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(after.statusCode).toBe(401);
  });
});