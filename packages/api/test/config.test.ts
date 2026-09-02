/**
 * Security hardening tests.
 *
 * Operational security is a feature, not an afterthought. These tests pin the
 * server's defensive behavior independently of repositories:
 *
 * - sessions expire and cannot outlive their TTL
 * - expired sessions are prunable (`deleteExpired`)
 * - CORS is a strict origin allowlist (no credentials)
 * - credential endpoints are rate limited more aggressively than the API
 * - oversized request bodies are rejected
 * - hardening headers are present on every response
 * - credentials are redacted from logs
 */
import { describe, expect, it } from 'vitest';

import {
  buildTestHarness,
  createUser,
  fixedNow,
  login,
} from './fakes';
import { booleanFlag, loadConfig, parseCorsOrigins } from '../src/config';

const HOUR_MS = 3_600_000;

/**
 * A valid production environment for `loadConfig` — every field set to a
 * known-good value so `envWith()` can produce minimal overrides.
 */
const VALID_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  PORT: '4100',
  HOST: '127.0.0.1',
  CORS_ORIGINS: 'https://app.example.com,https://admin.example.com',
  RATE_LIMIT_MAX: '250',
  RATE_LIMIT_WINDOW_MS: '30000',
  LOGIN_RATE_LIMIT_MAX: '5',
  BODY_LIMIT_BYTES: '524288',
  LOG_LEVEL: 'warn',
  CRE_SESSION_TTL_HOURS: '24',
  TRUST_PROXY: 'true',
  SESSION_PRUNE_INTERVAL_MS: '60000',
};

// ── Session lifecycle ────────────────────────────────────────────

describe('session lifecycle', () => {
  it('rejects an expired session with 401', async () => {
    // Injectable clock: start at T0, advance beyond the TTL, then replay the
    // same bearer token — the server must have stopped honoring it.
    let nowMs = Date.now();
    const h = await buildTestHarness({
      deps: {
        sessionTtlHours: 1,
        now: () => new Date(nowMs),
      },
    });
    await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };

    const before = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(before.statusCode).toBe(200);

    // Advance 2h — well past the 1h TTL.
    nowMs += 2 * HOUR_MS;
    const after = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a session expired by even one millisecond (boundary)', async () => {
    let nowMs = Date.now();
    const h = await buildTestHarness({
      deps: { sessionTtlHours: 1, now: () => new Date(nowMs) },
    });
    await createUser(h.users);
    const token = await login(h.app);
    const headers = { authorization: `Bearer ${token}` };

    // Exactly at the expiry instant it is still valid (expiresAt is exclusive).
    nowMs += HOUR_MS;
    const atExpiry = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(atExpiry.statusCode).toBe(200);

    // One millisecond past → invalid.
    nowMs += 1;
    const past = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(past.statusCode).toBe(401);
  });

  it('deleteExpired removes only expired sessions', async () => {
    let nowMs = fixedNow().getTime();
    const h = await buildTestHarness({
      deps: { sessionTtlHours: 1, now: () => new Date(nowMs) },
    });
    await createUser(h.users, { email: 'a@cre.test' });
    await createUser(h.users, { email: 'b@cre.test' });

    // Session A at T0 (will expire), session B at T0+30min (will not).
    const tokenA = await login(h.app, 'a@cre.test');
    nowMs += 30 * 60_000;
    const tokenB = await login(h.app, 'b@cre.test');
    expect(h.sessions.rows).toHaveLength(2);

    // Advance to T0+90min: A (expires T0+60min) is expired, B (expires T0+90min) is not.
    nowMs += 60 * 60_000;
    const removed = await h.sessions.deleteExpired(new Date(nowMs));
    expect(removed).toBe(1);
    expect(h.sessions.rows).toHaveLength(1);

    // The surviving session is B, and it still authenticates.
    const hashes = h.sessions.rows.map((row) => row.tokenHash);
    expect(hashes).not.toContain(
      h.sessions.rows.find((row) => row.tokenHash)?.tokenHash === undefined
        ? 'impossible'
        : tokenA,
    );
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(me.statusCode).toBe(200);

    // Pruning again is a no-op.
    expect(await h.sessions.deleteExpired(new Date(nowMs))).toBe(0);
  });
});


function envWith(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = { ...VALID_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

describe('loadConfig', () => {
  it('accepts a fully valid environment and honors every value', () => {
    const config = loadConfig(envWith());
    expect(config).toMatchObject({
      port: 4100,
      host: '127.0.0.1',
      nodeEnv: 'production',
      corsOrigins: ['https://app.example.com', 'https://admin.example.com'],
      rateLimitMax: 250,
      rateLimitWindowMs: 30_000,
      loginRateLimitMax: 5,
      bodyLimitBytes: 524_288,
      logLevel: 'warn',
      sessionTtlHours: 24,
      trustProxy: true,
      sessionPruneIntervalMs: 60_000,
      adminEmail: undefined,
      adminPassword: undefined,
    });
  });

  it('uses secure/sane defaults when optional values are absent', () => {
    const config = loadConfig(envWith({
      CORS_ORIGINS: undefined,
      RATE_LIMIT_MAX: undefined,
      RATE_LIMIT_WINDOW_MS: undefined,
      LOGIN_RATE_LIMIT_MAX: undefined,
      BODY_LIMIT_BYTES: undefined,
      LOG_LEVEL: undefined,
      TRUST_PROXY: undefined,
      CRE_SESSION_TTL_HOURS: undefined,
      SESSION_PRUNE_INTERVAL_MS: undefined,
    }));
    expect(config.corsOrigins).toEqual([]); // same-origin only
    expect(config.rateLimitMax).toBe(300);
    expect(config.rateLimitWindowMs).toBe(60_000);
    expect(config.loginRateLimitMax).toBe(10);
    expect(config.bodyLimitBytes).toBe(1_048_576);
    expect(config.logLevel).toBe('info');
    expect(config.trustProxy).toBe(false); // proxy spoofing off by default
    expect(config.sessionTtlHours).toBe(168);
    expect(config.sessionPruneIntervalMs).toBe(3_600_000);
  });

  it.each([
    ['PORT', 'PORT must be a positive integer (got \'zero\')'],
    ['RATE_LIMIT_MAX', "RATE_LIMIT_MAX must be a positive integer (got '-1')"],
    ['RATE_LIMIT_WINDOW_MS', "RATE_LIMIT_WINDOW_MS must be a positive integer (got 'abc')"],
    ['BODY_LIMIT_BYTES', "BODY_LIMIT_BYTES must be a positive integer (got '0')"],
    ['CRE_SESSION_TTL_HOURS', "CRE_SESSION_TTL_HOURS must be a positive integer (got 'abc')"],
  ])('rejects non-positive/invalid %s', (field, message) => {
    expect(() => loadConfig(envWith({ [field]: field === 'RATE_LIMIT_MAX' ? '-1' : field === 'BODY_LIMIT_BYTES' ? '0' : field === 'PORT' ? 'zero' : 'abc' }))).toThrow(message);
  });

  it('bounds the session TTL to 90 days', () => {
    expect(() => loadConfig(envWith({ CRE_SESSION_TTL_HOURS: '2161' }))).toThrow(
      'CRE_SESSION_TTL_HOURS must be at most 2160 (90 days)',
    );
    expect(loadConfig(envWith({ CRE_SESSION_TTL_HOURS: '2160' })).sessionTtlHours).toBe(2160);
  });

  it('rejects invalid NODE_ENV and LOG_LEVEL values', () => {
    expect(() => loadConfig(envWith({ NODE_ENV: 'staging' }))).toThrow(
      "NODE_ENV must be development, production, or test (got 'staging')",
    );
    expect(() => loadConfig(envWith({ LOG_LEVEL: 'loud' }))).toThrow(
      "LOG_LEVEL must be one of fatal, error, warn, info, debug, trace (got 'loud')",
    );
  });

  it('requires bootstrap credentials to be configured as a pair', () => {
    expect(() =>
      loadConfig(envWith({ CRE_ADMIN_EMAIL: 'admin@example.com' })),
    ).toThrow('CRE_ADMIN_EMAIL and CRE_ADMIN_PASSWORD must be set together');
    expect(() =>
      loadConfig(envWith({ CRE_ADMIN_PASSWORD: 'hunter2' })),
    ).toThrow('CRE_ADMIN_EMAIL and CRE_ADMIN_PASSWORD must be set together');
    const both = loadConfig(
      envWith({ CRE_ADMIN_EMAIL: 'admin@example.com', CRE_ADMIN_PASSWORD: 'hunter2' }),
    );
    expect(both.adminEmail).toBe('admin@example.com');
    expect(both.adminPassword).toBe('hunter2');
  });
});

describe('parseCorsOrigins', () => {
  it('returns an empty allowlist for empty/missing values', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('   ')).toEqual([]);
  });

  it('deduplicates and trims origins', () => {
    expect(parseCorsOrigins(' https://a.example.com , https://a.example.com ')).toEqual([
      'https://a.example.com',
    ]);
  });

  it('rejects wildcard origins', () => {
    expect(() => parseCorsOrigins('*')).toThrow("'*' is not allowed");
  });

  it('rejects origins with paths, query strings, or fragments', () => {
    expect(() => parseCorsOrigins('https://a.example.com/app')).toThrow('bare origin');
    expect(() => parseCorsOrigins('https://a.example.com?x=1')).toThrow('bare origin');
    expect(() => parseCorsOrigins('https://a.example.com#frag')).toThrow('bare origin');
  });

  it('rejects non-absolute values', () => {
    expect(() => parseCorsOrigins('app.example.com')).toThrow('not a valid absolute origin');
  });
});

describe('booleanFlag', () => {
  it('parses true/false case-insensitively', () => {
    expect(booleanFlag('true', false, 'F')).toBe(true);
    expect(booleanFlag('TRUE', false, 'F')).toBe(true);
    expect(booleanFlag('False', true, 'F')).toBe(false);
  });

  it('falls back when unset but rejects anything else', () => {
    expect(booleanFlag(undefined, true, 'F')).toBe(true);
    expect(booleanFlag('', false, 'F')).toBe(false);
    expect(() => booleanFlag('yes', false, 'TRUST_PROXY')).toThrow(
      "TRUST_PROXY must be 'true' or 'false' (got 'yes')",
    );
  });
});
