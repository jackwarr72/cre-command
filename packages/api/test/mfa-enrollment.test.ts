/**
 * MFA enrollment flow tests (in-memory fakes).
 *
 * Covers the two-step DB-backed enrollment contract:
 *   POST /auth/mfa/enroll  → encrypted pending secret + otpauth provisioning URI
 *   POST /auth/mfa/confirm → TOTP verified → MFA activated + 10 recovery codes
 *
 * The in-memory user repo encrypts/decrypts through the same mfa-crypto module
 * as the Postgres repo, so the route layer runs against an honest fake. The
 * encryption key is scoped to this file and torn down after the suite runs.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { totp } from '../src/auth/totp';
import { buildTestHarness, createUser, fixedNow, login } from './fakes';

const TEST_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

describe('POST /api/auth/mfa/enroll', () => {
  beforeAll(() => {
    process.env.MFA_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });
  afterAll(() => {
    delete process.env.MFA_ENCRYPTION_KEY;
  });

  it('requires an authenticated session', async () => {
    const h = await buildTestHarness();
    await createUser(h.users);
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/mfa/enroll' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns a fresh secret plus an otpauth URI and persists a pending enrollment', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };

    const res = await h.app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { secret: string; otpauthUrl: string };
    expect(typeof body.secret).toBe('string');
    expect(body.secret.length).toBeGreaterThanOrEqual(16);
    expect(body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/cre-command%3A/);
    expect(body.otpauthUrl).toContain(`secret=${body.secret}`);

    // Pending: MFA is not yet active, but the encrypted secret round-trips.
    const pending = await h.users.findMfaConfig(user.id);
    expect(pending.mfaEnabled).toBe(false);
    expect(pending.mfaSecret).toBe(body.secret);

    // Login still works without a code (MFA not activated yet).
    await expect(login(h.app)).resolves.toBeDefined();
  });

  it('fails closed with MFA_NOT_CONFIGURED when the encryption key is missing', async () => {
    const h = await buildTestHarness();
    await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };
    const previous = process.env.MFA_ENCRYPTION_KEY;
    delete process.env.MFA_ENCRYPTION_KEY;
    try {
      const res = await h.app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('MFA_NOT_CONFIGURED');
    } finally {
      process.env.MFA_ENCRYPTION_KEY = previous;
    }
  });

  it('rejects enrollment when MFA is already active', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users);
    // Login must precede setMfa: an MFA-enabled user gets a login challenge
    // instead of a token, and this test needs an active bearer session.
    const token = await login(h.app);
    h.users.setMfa(user.id, { mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/enroll',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MFA_ALREADY_ENABLED');
  });

  it('rejects stray body fields with 400 VALIDATION_ERROR', async () => {
    const h = await buildTestHarness();
    await createUser(h.users);
    const token = await login(h.app);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/enroll',
      headers: { authorization: `Bearer ${token}` },
      payload: { unexpected: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/mfa/confirm', () => {
  beforeAll(() => {
    process.env.MFA_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });
  afterAll(() => {
    delete process.env.MFA_ENCRYPTION_KEY;
  });

  it('requires an authenticated session', async () => {
    const h = await buildTestHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/confirm',
      payload: { code: '123456' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects confirming before any enrollment with 400 MFA_NOT_ENROLLED', async () => {
    const h = await buildTestHarness();
    await createUser(h.users);
    const token = await login(h.app);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '123456' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MFA_NOT_ENROLLED');
  });

  it('rejects a wrong code with 401 and keeps MFA disabled', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };
    await h.app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/confirm',
      headers,
      payload: { code: '000000' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_MFA_CODE');
    const stillPending = await h.users.findMfaConfig(user.id);
    expect(stillPending.mfaEnabled).toBe(false);
    expect(stillPending.mfaSecret).toBeDefined();
  });

  it('activates MFA with a valid code, provisions 10 hashed recovery codes, and marks verified-at', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };

    await h.app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers });
    const pending = await h.users.findMfaConfig(user.id);
    const step = Math.floor(fixedNow().getTime() / 30_000);
    const code = totp(pending.mfaSecret!, step);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/confirm',
      headers,
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { recoveryCodes: string[] };
    expect(body.recoveryCodes).toHaveLength(10);
    for (const c of body.recoveryCodes) expect(c).toMatch(/^[A-Z0-9]{10}$/);

    const active = await h.users.findMfaConfig(user.id);
    expect(active.mfaEnabled).toBe(true);
    expect(active.mfaRecoveryCodes).toHaveLength(10);
    // Stored codes are bcrypt-hashed, never raw.
    expect(active.mfaRecoveryCodes![0]).not.toBe(body.recoveryCodes[0]);
    expect(active.mfaVerifiedAt?.getTime()).toBe(fixedNow().getTime());
  });

  it('rejects confirming when MFA is already active', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users);
    // Login must precede setMfa: an MFA-enabled user gets a login challenge
    // instead of a token, and this test needs an active bearer session.
    const token = await login(h.app);
    h.users.setMfa(user.id, { mfaEnabled: true, mfaSecret: 'JBSWY3DPEHPK3PXP' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '123456' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MFA_ALREADY_ENABLED');
  });

  it('rejects malformed codes with 400 VALIDATION_ERROR', async () => {
    const h = await buildTestHarness();
    await createUser(h.users);
    const token = await login(h.app);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: '12ab34' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('completed enrollment forces the MFA step on the next login, then verifies with TOTP', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };

    await h.app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers });
    const pending = await h.users.findMfaConfig(user.id);
    const code = totp(pending.mfaSecret!, Math.floor(fixedNow().getTime() / 30_000));
    await h.app.inject({ method: 'POST', url: '/api/auth/mfa/confirm', headers, payload: { code } });

    const loginRes = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'secret123' },
    });
    expect(loginRes.statusCode).toBe(200);
    const challenge = loginRes.json() as { mfaRequired: boolean; mfaChallengeId: string };
    expect(challenge.mfaRequired).toBe(true);
    expect(challenge.mfaChallengeId).toBeDefined();

    const verifyCode = totp(pending.mfaSecret!, Math.floor(fixedNow().getTime() / 30_000));
    const verify = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login/mfa-verify',
      payload: {
        email: user.email,
        password: 'secret123',
        mfaCode: verifyCode,
        mfaChallengeId: challenge.mfaChallengeId,
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().token).toBeDefined();
  });

  it('recovery codes are single-use through the real login flow', async () => {
    const h = await buildTestHarness();
    const user = await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };

    await h.app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers });
    const pending = await h.users.findMfaConfig(user.id);
    const code = totp(pending.mfaSecret!, Math.floor(fixedNow().getTime() / 30_000));
    const confirm = await h.app.inject({ method: 'POST', url: '/api/auth/mfa/confirm', headers, payload: { code } });
    const recoveryCode = (confirm.json() as { recoveryCodes: string[] }).recoveryCodes[0];

    const challenge1 = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'secret123' },
    });
    const verify1 = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login/mfa-verify',
      payload: {
        email: user.email,
        password: 'secret123',
        mfaRecoveryCode: recoveryCode,
        mfaChallengeId: challenge1.json().mfaChallengeId,
      },
    });
    expect(verify1.statusCode).toBe(200);

    const challenge2 = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: user.email, password: 'secret123' },
    });
    const verify2 = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login/mfa-verify',
      payload: {
        email: user.email,
        password: 'secret123',
        mfaRecoveryCode: recoveryCode,
        mfaChallengeId: challenge2.json().mfaChallengeId,
      },
    });
    expect(verify2.statusCode).toBe(401);
    expect(verify2.json().error.code).toBe('INVALID_MFA_CODE');
  }, 30_000);
});