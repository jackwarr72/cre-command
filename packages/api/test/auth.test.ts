import { describe, expect, it } from 'vitest';

import { ensureBootstrapAdmin } from '../src/auth/bootstrap';
import { totp } from '../src/auth/totp';
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
  // Use the same development user that the auth bypass uses
  const user = await createUser(h.users, { email: 'operator@cre.test', role: 'admin' });
  const token = await login(h.app);
  
  const response = await h.app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
  
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ id: user.id, email: user.email });
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

describe('POST /api/auth/login MFA flow', () => {
  const TEST_SECRET = 'JBSWY3DPEHPK3PXP';

  it('returns mfaRequired=true when user has MFA enabled but no code submitted', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users, { email: 'mfa@cre.test', password: 'secret123' });
    h.users.setMfa(user.id, { mfaEnabled: true, mfaSecret: TEST_SECRET });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mfaRequired).toBe(true);
    expect(body.mfaChallengeId).toBeDefined();
    expect(body.mfaChallengeTtlSeconds).toBe(300);
    expect(body.token).toBe('');
    expect(body.user).toBeDefined();
    expect(h.sessions.rows).toHaveLength(0);
  });

  it('rejects mfaCode without mfaChallengeId with 400 MFA_CHALLENGE_REQUIRED', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users, { email: 'mfa@cre.test', password: 'secret123' });
    h.users.setMfa(user.id, { mfaEnabled: true, mfaSecret: TEST_SECRET });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123', mfaCode: '123456' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { message: 'mfaCode or mfaRecoveryCode supplied without a corresponding mfaChallengeId', code: 'MFA_CHALLENGE_REQUIRED' },
    });
  });

  it('rejects an invalid mfaChallengeId with 401 INVALID_MFA_CHALLENGE', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users, { email: 'mfa@cre.test', password: 'secret123' });
    h.users.setMfa(user.id, { mfaEnabled: true, mfaSecret: TEST_SECRET });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123', mfaCode: '123456', mfaChallengeId: 'invalid-challenge' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { message: 'MFA challenge is invalid or expired', code: 'INVALID_MFA_CHALLENGE' },
    });
  });

  it('rejects an invalid MFA code with 401 INVALID_MFA_CODE', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users, { email: 'mfa@cre.test', password: 'secret123' });
    h.users.setMfa(user.id, { mfaEnabled: true, mfaSecret: TEST_SECRET });

    const challengeResponse = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123' },
    });
    expect(challengeResponse.statusCode).toBe(200);
    const { mfaChallengeId } = challengeResponse.json();

    const verifyResponse = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123', mfaCode: '000000', mfaChallengeId },
    });

    expect(verifyResponse.statusCode).toBe(401);
    expect(verifyResponse.json()).toEqual({
      error: { message: 'invalid MFA code or recovery code', code: 'INVALID_MFA_CODE' },
    });
    expect(h.sessions.rows).toHaveLength(0);
  });

  it('completes login with valid MFA code and returns token', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users, { email: 'mfa@cre.test', password: 'secret123' });
    h.users.setMfa(user.id, { mfaEnabled: true, mfaSecret: TEST_SECRET });

    const challengeResponse = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123' },
    });
    expect(challengeResponse.statusCode).toBe(200);
    const { mfaChallengeId } = challengeResponse.json();

    const step = Math.floor(fixedNow().getTime() / 30_000);
    const validCode = totp(TEST_SECRET, step);

    const verifyResponse = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123', mfaCode: validCode, mfaChallengeId },
    });

    expect(verifyResponse.statusCode).toBe(200);
    const body = verifyResponse.json();
    expect(body.mfaRequired).toBeUndefined();
    expect(body.mfaChallengeId).toBeUndefined();
    expect(body.token).toBeDefined();
    expect(body.token.length).toBeGreaterThan(16);
    expect(body.user.email).toBe('mfa@cre.test');
    expect(h.sessions.rows).toHaveLength(1);
  });

  it('rejects a challenge that was already consumed (single-use)', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users, { email: 'mfa@cre.test', password: 'secret123' });
    h.users.setMfa(user.id, { mfaEnabled: true, mfaSecret: TEST_SECRET });

    const challengeResponse = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123' },
    });
    expect(challengeResponse.statusCode).toBe(200);
    const { mfaChallengeId } = challengeResponse.json();

    const step = Math.floor(fixedNow().getTime() / 30_000);
    const validCode = totp(TEST_SECRET, step);

    const verifyResponse = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123', mfaCode: validCode, mfaChallengeId },
    });
    expect(verifyResponse.statusCode).toBe(200);

    const reuseResponse = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123', mfaCode: validCode, mfaChallengeId },
    });
    expect(reuseResponse.statusCode).toBe(401);
    expect(reuseResponse.json().error.code).toBe('INVALID_MFA_CHALLENGE');
  });

  it('allows login without MFA when user has MFA disabled', async () => {
    const h = await buildTestHarness();
    await createUser(h.users, { email: 'nomfa@cre.test', password: 'secret123' });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nomfa@cre.test', password: 'secret123' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mfaRequired).toBeUndefined();
    expect(body.token).toBeDefined();
    expect(h.sessions.rows).toHaveLength(1);
  });
});