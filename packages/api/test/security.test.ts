/**
 * HTTP-level security tests.
 *
 * Where `config.test.ts` pins configuration parsing and session lifecycle,
 * this file verifies *observable server behavior* over HTTP:
 * that CORS is enforced per-origin, that rate limits actually throttle,
 * that oversized payloads are rejected, that hardening headers appear on
 * every response, and that credentials never leak into logs.
 *
 * These are the runtime guarantees operators and compliance audits depend on
 * — not assumptions in code comments.
 */
import { describe, expect, it } from 'vitest';

import { buildTestHarness, createUser, login } from './fakes';

// ── CORS enforcement ──────────────────────────────────────────────

describe('HTTP security: CORS', () => {
  it('does not reflect origins outside the allowlist', async () => {
    const h = await buildTestHarness({
      deps: { security: { corsOrigins: ['https://app.example.com'] } },
    });

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });

    // No ACAO header ⇒ the browser blocks the response.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('reflects allowlisted origins without credentials', async () => {
    const h = await buildTestHarness({
      deps: { security: { corsOrigins: ['https://app.example.com'] } },
    });

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://app.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    // Bearer-token API: cookies are never involved.
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('omits CORS headers entirely when no Origin is sent (same-origin)', async () => {
    const h = await buildTestHarness({
      deps: { security: { corsOrigins: ['https://app.example.com'] } },
    });

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('defaults to same-origin-only when no CORS allowlist is configured', async () => {
    const h = await buildTestHarness(); // default: corsOrigins = []

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://anything.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ── Rate limiting enforcement ─────────────────────────────────────

describe('HTTP security: rate limiting', () => {
  it('returns 429 after exceeding the per-IP login cap', async () => {
    const h = await buildTestHarness({
      deps: { security: { loginRateLimitMax: 3 } },
    });
    await createUser(h.users, { email: 'operator@cre.test', password: 'secret123' });

    // Three failed logins — all 401, none 429.
    for (let i = 0; i < 3; i++) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'operator@cre.test', password: 'wrong' },
      });
      expect(response.statusCode).toBe(401);
    }

    // Fourth attempt within the window → 429.
    const capped = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'operator@cre.test', password: 'wrong' },
    });
            expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('RATE_LIMITED');
  });

  it('returns 429 after exceeding the global per-IP cap', async () => {
    const h = await buildTestHarness({
      deps: { security: { rateLimitMax: 2 } },
    });

    // Two allowed...
    const ok1 = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(ok1.statusCode).toBe(200);
    const ok2 = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(ok2.statusCode).toBe(200);

    // Third is throttled.
    const throttled = await h.app.inject({ method: 'GET', url: '/api/health' });
            expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error.code).toBe('RATE_LIMITED');
  });

  it('uses distinct counters for login and global limits', async () => {
    // Login cap is 3, global cap is 1000 — hitting login 3× should NOT
    // consume the global budget (and vice-versa).
    const h = await buildTestHarness({
      deps: { security: { loginRateLimitMax: 3, rateLimitMax: 1000 } },
    });
    await createUser(h.users, { email: 'operator@cre.test', password: 'secret123' });

    for (let i = 0; i < 3; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'operator@cre.test', password: 'wrong' },
      });
    }

    // /health should still be allowed (global budget untouched).
    const response = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
  });
});

// ── Request body size ─────────────────────────────────────────────

describe('HTTP security: request body size', () => {
  it('rejects bodies exceeding the configured limit', async () => {
    const h = await buildTestHarness({
      deps: { security: { bodyLimitBytes: 50 } },
    });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'a@b.c', password: 'x'.repeat(100) },
    });

    expect(response.statusCode).toBe(413);
  });

  it('accepts bodies within the limit', async () => {
    const h = await buildTestHarness({
      deps: { security: { bodyLimitBytes: 1024 } },
    });
    await createUser(h.users, { email: 'operator@cre.test', password: 'secret123' });

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'operator@cre.test', password: 'secret123' },
    });

    expect(response.statusCode).toBe(200);
  });
});

// ── Hardening headers ─────────────────────────────────────────────

describe('HTTP security: response headers', () => {
  it('applies hardening headers on success responses', async () => {
    const h = await buildTestHarness();

    const response = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  it('applies hardening headers on error responses too', async () => {
    const h = await buildTestHarness();

    const response = await h.app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
  });
});

// ── Credential redaction in logs ──────────────────────────────────

describe('HTTP security: credential redaction in logs', () => {
  it('redacts passwords from request bodies and Authorization headers from log output', async () => {
    const lines: string[] = [];
    const h = await buildTestHarness({
      deps: {
        logger: true,
        logLevel: 'debug',
        loggerStream: { write: (msg: string) => void lines.push(msg) },
      },
    });
    await createUser(h.users, { email: 'operator@cre.test', password: 'secret123' });

    // Login: password appears in the request body.
    const token = await login(h.app, 'operator@cre.test', 'secret123');

    // /me: Bearer token appears in the Authorization header.
    await h.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    const allOutput = lines.join('\n');

    // Neither the raw password nor the raw token may appear anywhere in logs.
    expect(allOutput).not.toContain('secret123');
    expect(allOutput).not.toContain(token);

        // The request-completed log lines must show explicit [REDACTED] markers.
    // (Fastify emits multiple log lines per request; find the one produced by
    // our preHandler hook, which carries the http payload with body/headers.)
    const loginLog = lines.find(
      (line) =>
        line.includes('"msg":"request completed"') &&
        line.includes('/api/auth/login'),
    );
    expect(loginLog).toBeDefined();
    const loginParsed = JSON.parse(loginLog!.trim());
    expect(loginParsed.http.body.password).toBe('[REDACTED]');

    const meLog = lines.find(
      (line) =>
        line.includes('"msg":"request completed"') &&
        line.includes('/api/auth/me'),
    );

    expect(meLog).toBeDefined();
    const meParsed = JSON.parse(meLog!.trim());
    expect(meParsed.http.headers.authorization).toBe('[REDACTED]');
  });
});

// ── Authorization on every protected route ────────────────────────

describe('HTTP security: authorization', () => {
  it('all protected routes require a valid bearer token', async () => {
    const h = await buildTestHarness();
    await createUser(h.users);

    const protectedRoutes = [
      { method: 'GET' as const, url: '/api/sources' },
      { method: 'GET' as const, url: '/api/listings' },
      { method: 'GET' as const, url: '/api/crawl-runs' },
      { method: 'GET' as const, url: '/api/auth/me' },
    ];

    for (const route of protectedRoutes) {
      const response = await h.app.inject({
        method: route.method,
        url: route.url,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('write routes reject viewers with 403', async () => {
    const h = await buildTestHarness();
    await createUser(h.users, { email: 'viewer@cre.test', role: 'viewer' });
    const token = await login(h.app, 'viewer@cre.test');
    const headers = { authorization: `Bearer ${token}` };

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      headers,
      payload: { sourceKey: 'ghost' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });
});

