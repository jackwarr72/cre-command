/**
 * Audit trail: FakeAuditRepo contract + GET /api/audit-log route + the
 * auth-flow hooks that append events (login success/failure, MFA enrollment).
 */
import { describe, expect, it, beforeEach } from 'vitest';

import type { AuditLogFilter } from '../src/ports';

import { buildTestHarness, createUser, fixedNow, login } from './fakes';

describe('FakeAuditRepo', () => {
  let h: Awaited<ReturnType<typeof buildTestHarness>>;

  beforeEach(async () => {
    h = await buildTestHarness();
  });

  it('appends with sensible defaults (null actor/target, empty metadata)', async () => {
    await h.audit.append({ action: 'auth.login.success', at: fixedNow() });
    const row = h.audit.rows[0];
    expect(row.actorUserId).toBeNull();
    expect(row.actorEmail).toBeNull();
    expect(row.targetType).toBeNull();
    expect(row.targetId).toBeNull();
    expect(row.metadata).toEqual({});
  });

  it('lists newest-first and honors action/actor/from/to filters with paging', async () => {
    const t0 = fixedNow();
    await h.audit.append({ action: 'auth.login.success', at: t0, actorUserId: 'usr-a' });
    await h.audit.append({ action: 'auth.login.failed', at: new Date(t0.getTime() + 1000) });
    await h.audit.append({
      action: 'source.policy_updated',
      at: new Date(t0.getTime() + 2000),
      actorUserId: 'usr-a',
      targetType: 'source',
      targetId: 'vivanuncios',
    });

    const all = await h.audit.list({}, 1, 10);
    expect(all.total).toBe(3);
    expect(all.items.map((e) => e.action)).toEqual([
      'source.policy_updated',
      'auth.login.failed',
      'auth.login.success',
    ]);

    const byActor: AuditLogFilter = { actorUserId: 'usr-a' };
    expect((await h.audit.list(byActor, 1, 10)).total).toBe(2);
    expect((await h.audit.list({ action: 'auth.login.failed' }, 1, 10)).total).toBe(1);
    expect((await h.audit.list({ from: new Date(t0.getTime() + 1500) }, 1, 10)).items).toHaveLength(1);
    expect((await h.audit.list({ to: new Date(t0.getTime() + 500) }, 1, 10)).items).toHaveLength(1);

    const paged = await h.audit.list({}, 2, 2);
    expect(paged.page).toBe(2);
    expect(paged.items).toHaveLength(1);
  });
});

describe('GET /api/audit-log', () => {
  let h: Awaited<ReturnType<typeof buildTestHarness>>;
  let operatorToken: string;
  let viewerToken: string;

  beforeEach(async () => {
    h = await buildTestHarness();
    await createUser(h.users); // operator@cre.test
    await createUser(h.users, { email: 'viewer@cre.test', role: 'viewer' });
    operatorToken = await login(h.app);
    viewerToken = await login(h.app, 'viewer@cre.test', 'secret123');
  });

  it('records login events with actor and pre-auth attribution', async () => {
    // Failed login: pre-auth, actor id null, attempted email snapshotted.
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'operator@cre.test', password: 'wrong-password' },
    });

    const failed = h.audit.rows.filter((r) => r.action === 'auth.login.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].actorUserId).toBeNull();
    expect(failed[0].actorEmail).toBe('operator@cre.test');
    expect(failed[0].metadata).toEqual({ reason: 'invalid_credentials' });

    // Successful logins carry the authenticated actor.
    const success = h.audit.rows.filter((r) => r.action === 'auth.login.success');
    expect(success).toHaveLength(2); // operator + viewer logins above
    expect(success[0].actorEmail).toBe('operator@cre.test');
    expect(success[0].actorUserId).toBe(h.users.rows[0].id);
  });

  it('requires authentication and operator+ role', async () => {
    const anon = await h.app.inject({ method: 'GET', url: '/api/audit-log' });
    expect(anon.statusCode).toBe(401);

    const viewer = await h.app.inject({
      method: 'GET',
      url: '/api/audit-log',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(viewer.statusCode).toBe(403);

    const operator = await h.app.inject({
      method: 'GET',
      url: '/api/audit-log',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(operator.statusCode).toBe(200);
    const body = operator.json() as { items: unknown[]; total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.items.length).toBe(body.total);
  });

  it('filters by action and rejects unknown params and bad values', async () => {
    const filtered = await h.app.inject({
      method: 'GET',
      url: '/api/audit-log?action=auth.login.success',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(filtered.statusCode).toBe(200);
    const body = filtered.json() as { items: Array<{ action: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.items.every((e) => e.action === 'auth.login.success')).toBe(true);

    const badAction = await h.app.inject({
      method: 'GET',
      url: '/api/audit-log?action=nonsense',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(badAction.statusCode).toBe(400);

    const unknownParam = await h.app.inject({
      method: 'GET',
      url: '/api/audit-log?bogus=1',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(unknownParam.statusCode).toBe(400);

    const badDate = await h.app.inject({
      method: 'GET',
      url: '/api/audit-log?from=not-a-date',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(badDate.statusCode).toBe(400);
  });

  it('persists MFA enrollment events with the user as target', async () => {
    // Enrollment encrypts the pending secret, so the key must be configured.
    process.env.MFA_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
    try {
      const user = h.users.rows[0];
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/mfa/enroll',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      const started = h.audit.rows.filter((r) => r.action === 'auth.mfa.enrollment_started');
      expect(started).toHaveLength(1);
      expect(started[0].actorUserId).toBe(user.id);
      expect(started[0].actorEmail).toBe('operator@cre.test');
      expect(started[0].targetType).toBe('user');
      expect(started[0].targetId).toBe(user.id);
    } finally {
      delete process.env.MFA_ENCRYPTION_KEY;
    }
  });
});


