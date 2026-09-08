/**
 * End-to-end MFA enrollment integration against real PostgreSQL.
 *
 * This is the security-boundary proof the milestone is about: the DB-backed
 * enrollment path (PgUserRepo) rather than the in-memory fakes. It spins a
 * disposable database per run, applies migrations, wires the real user/session
 * repositories into the app, and walks the full flow:
 *
 *   enroll → secret encrypted at rest (never plaintext) → confirm → login
 *   requires TOTP → recovery codes are hashed + single-use.
 *
 * Skipped unless DATABASE_URL is provided (CRE_ENFORCE_INTEGRATION=1, which
 * CI sets, fails the run instead). Run via `npm run test:integration`, e.g.:
 *   DATABASE_URL=postgres://cre:cre@localhost:55432/cre_command npm run test:integration
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import { users } from '@cre/db';
import type { Database } from '@cre/db';

import { totp } from '../src/auth/totp';
import { createApiRepositories } from '../src/postgres/repositories';
import { buildTestHarness, createUser, fixedNow, login } from './fakes';
import { requireServiceEnv } from '../../../test-support/integration';

const url = requireServiceEnv('PostgreSQL', 'DATABASE_URL');
const migrationsDir = fileURLToPath(new URL('../../db/src/postgres/migrations', import.meta.url));
const TEST_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

describe.skipIf(!url)('postgres MFA enrollment integration', () => {
  let pool: Pool;
  let db: Database;
  let app: Awaited<ReturnType<typeof buildTestHarness>>['app'];
  let usersRepo: ReturnType<typeof createApiRepositories>['users'];
  let auditRepo: ReturnType<typeof createApiRepositories>['audit'];
  const testDbName = `cre_api_mfa_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    if (!url) return;
    process.env.MFA_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    const admin = new Pool({ connectionString: url });
    await admin.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await admin.query(`CREATE DATABASE "${testDbName}"`);
    await admin.end();

    const testUrl = new URL(url);
    testUrl.pathname = `/${testDbName}`;
    pool = new Pool({ connectionString: testUrl.toString() });
    db = drizzle(pool) as Database;
    await migrate(db, { migrationsFolder: migrationsDir });

    const repos = createApiRepositories(db);
    usersRepo = repos.users;

    // Build the full app with the real user + session + audit repos; the
    // query-side repos and crawl trigger stay in-memory (not under test here).
    auditRepo = repos.audit;
    const harness = await buildTestHarness({
      deps: { users: repos.users, sessions: repos.sessions, audit: repos.audit },
    });
    app = harness.app;
  });

  it('walks the full DB-backed enrollment and login flow', async () => {
    const user = await createUser(usersRepo, { email: 'mfa@cre.test', password: 'secret123' });
    const headers = { authorization: `Bearer ${await login(app, 'mfa@cre.test', 'secret123')}` };

    // 1. Enroll → secret returned once; pending state persisted encrypted.
    const enroll = await app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers });
    expect(enroll.statusCode).toBe(200);
    const { secret } = enroll.json() as { secret: string };
    const pendingRow = (await db.select().from(users).where(eq(users.id, user.id)))[0];
    expect(pendingRow.mfaEnabled).toBe(false);
    expect(pendingRow.mfaSecretEncrypted).not.toBeNull();
    // At rest, never plaintext.
    expect(pendingRow.mfaSecretEncrypted).not.toContain(secret.slice(0, 8));
    expect(pendingRow.mfaSecretIv).not.toBeNull();

    // 2. Confirm with a real TOTP code → activated + 10 hashed recovery codes.
    //    The pending secret round-trips through Postgres via decryption.
    const pending = await usersRepo.findMfaConfig(user.id);
    const code = totp(pending.mfaSecret!, Math.floor(fixedNow().getTime() / 30_000));
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/confirm',
      headers,
      payload: { code },
    });
    expect(confirm.statusCode).toBe(200);
    const recoveryCodes = (confirm.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    const activeRow = (await db.select().from(users).where(eq(users.id, user.id)))[0];
    expect(activeRow.mfaEnabled).toBe(true);
    expect(activeRow.mfaVerifiedAt).not.toBeNull();
    const storedCodes = JSON.parse(activeRow.mfaRecoveryCodes!) as string[];
    expect(storedCodes).toHaveLength(10);
    // Recovery codes are bcrypt-hashed, never stored raw.
    expect(storedCodes).not.toContain(recoveryCodes[0]);

    // 3. Next login requires the second factor.
    const challenge = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'mfa@cre.test', password: 'secret123' },
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json().mfaRequired).toBe(true);
    const mfaChallengeId = challenge.json().mfaChallengeId as string;

    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/login/mfa-verify',
      payload: {
        email: 'mfa@cre.test',
        password: 'secret123',
        mfaCode: totp(secret, Math.floor(fixedNow().getTime() / 30_000)),
        mfaChallengeId,
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().token).toBeDefined();
  });

  it('persists recovery-code consumption and rejects reuse against Postgres', async () => {
    const user = await createUser(usersRepo, { email: 'recovery@cre.test', password: 'secret123' });
    const headers = { authorization: `Bearer ${await login(app, 'recovery@cre.test', 'secret123')}` };

    await app.inject({ method: 'POST', url: '/api/auth/mfa/enroll', headers });
    const pending = await usersRepo.findMfaConfig(user.id);
    const code = totp(pending.mfaSecret!, Math.floor(fixedNow().getTime() / 30_000));
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/auth/mfa/confirm',
      headers,
      payload: { code },
    });
    const recoveryCode = (confirm.json() as { recoveryCodes: string[] }).recoveryCodes[0];

    const challenge1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'recovery@cre.test', password: 'secret123' },
    });
    const verify1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login/mfa-verify',
      payload: {
        email: 'recovery@cre.test',
        password: 'secret123',
        mfaRecoveryCode: recoveryCode,
        mfaChallengeId: challenge1.json().mfaChallengeId,
      },
    });
    expect(verify1.statusCode).toBe(200);

    const rowAfter = (await db.select().from(users).where(eq(users.id, user.id)))[0];
    expect(JSON.parse(rowAfter.mfaRecoveryCodes!) as string[]).toHaveLength(9);

    const challenge2 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'recovery@cre.test', password: 'secret123' },
    });
    const verify2 = await app.inject({
      method: 'POST',
      url: '/api/auth/login/mfa-verify',
      payload: {
        email: 'recovery@cre.test',
        password: 'secret123',
        mfaRecoveryCode: recoveryCode,
        mfaChallengeId: challenge2.json().mfaChallengeId,
      },
    });
    expect(verify2.statusCode).toBe(401);
    expect(verify2.json().error.code).toBe('INVALID_MFA_CODE');
  });

  it('persists the audit trail through PgAuditRepo', async () => {
    // The flows above recorded login/enroll/confirm/recovery events for both
    // users; query them back through the real repo.
    const mfaUser = await usersRepo.findByEmail('mfa@cre.test');

    const enabled = await auditRepo.list({ action: 'auth.mfa.enabled' }, 1, 10);
    expect(enabled.total).toBe(2);
    expect(enabled.items.map((e) => e.actorEmail).sort()).toEqual([
      'mfa@cre.test',
      'recovery@cre.test',
    ]);
    expect(enabled.items[0].targetType).toBe('user');

    const byActor = await auditRepo.list({ actorUserId: mfaUser!.id }, 1, 10);
    expect(byActor.total).toBeGreaterThanOrEqual(3); // login + enroll + enabled
    expect(byActor.items.every((e) => e.actorUserId === mfaUser!.id)).toBe(true);

    const all = await auditRepo.list({}, 1, 100);
    expect(all.total).toBeGreaterThanOrEqual(7);
    // AuditLogEntry.at is an ISO wire string; compare as instants.
    const newest = new Date(all.items[0].at).getTime();
    const oldest = new Date(all.items[all.items.length - 1].at).getTime();
    expect(newest >= oldest).toBe(true);
  });

  afterAll(async () => {
    delete process.env.MFA_ENCRYPTION_KEY;
    await app?.close().catch(() => {});
    await pool?.end().catch(() => {});
    const admin = new Pool({ connectionString: url! });
    await admin.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  });
});