import { describe, expect, it } from 'vitest';

import type { ApiErrorBody } from '@cre/shared';

import { buildTestHarness, type FakeUserRepo } from './fakes';

/**
 * Makes the users repo explode — models an unexpected dependency failure
 * (a bug, a lost database connection) surfacing from a real route handler.
 * `POST /api/auth/login` is public and calls `findByEmail` right after body
 * validation, so a patched fake turns any login attempt into an unhandled
 * 500 that reaches the global error handler.
 */
function failUserLookup(users: FakeUserRepo, message: string): void {
  users.findByEmail = async () => {
    throw new Error(message);
  };
}

describe('error handler — unexpected 5xx diagnostics', () => {
  it('keeps production 500s opaque (default when nodeEnv is omitted)', async () => {
    const h = await buildTestHarness();
    failUserLookup(h.users, 'database password should not leak');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'someone@cre.test', password: 'whatever' },
    });

    expect(res.statusCode).toBe(500);
    // Exact envelope: no message leak, no stack, no extra fields.
    expect(res.json()).toEqual({
      error: { message: 'Internal server error', code: 'INTERNAL' },
    });
    expect(res.body).not.toContain('database password should not leak');
    expect(res.body).not.toContain('stack');
  });

  it('keeps production 500s opaque when nodeEnv is explicitly "production"', async () => {
    const h = await buildTestHarness({ deps: { nodeEnv: 'production' } });
    failUserLookup(h.users, 'sql statement: select * from users');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'someone@cre.test', password: 'whatever' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { message: 'Internal server error', code: 'INTERNAL' },
    });
    expect(res.body).not.toContain('select * from users');
  });

  it('returns the real error message and stack for 500s in development', async () => {
    const h = await buildTestHarness({ deps: { nodeEnv: 'development' } });
    failUserLookup(h.users, 'database connection failed');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'someone@cre.test', password: 'whatever' },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json() as ApiErrorBody;
    expect(body.error.message).toBe('database connection failed');
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.stack).toBeDefined();
    expect(body.error.stack).toContain('database connection failed');
    // Only the diagnostic fields — never the entire Error object.
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'stack']);
  });

  it('returns diagnostics for 500s in the test environment too', async () => {
    const h = await buildTestHarness({ deps: { nodeEnv: 'test' } });
    failUserLookup(h.users, 'redis connection refused');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'someone@cre.test', password: 'whatever' },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json() as ApiErrorBody;
    expect(body.error.message).toBe('redis connection refused');
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.stack).toBeDefined();
    expect(body.error.stack).toContain('redis connection refused');
  });

  it('leaves existing 4xx responses unchanged even in development', async () => {
    const h = await buildTestHarness({ deps: { nodeEnv: 'development' } });

    // 400 validation (ZodError path) — already descriptive; no diagnostics added.
    const badPayload = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email' },
    });
    expect(badPayload.statusCode).toBe(400);
    const badBody = badPayload.json() as ApiErrorBody;
    expect(badBody.error.code).toBe('VALIDATION_ERROR');
    expect(badBody.error.message).toContain('invalid request');
    expect(badBody.error.stack).toBeUndefined();

    // 404 for unknown routes under /api — envelope unchanged.
    const missing = await h.app.inject({ method: 'GET', url: '/api/definitely-not-a-route' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { message: 'route not found', code: 'NOT_FOUND' },
    });
  });

  it('still logs unhandled errors in every environment', async () => {
    for (const nodeEnv of ['production', 'development'] as const) {
      const lines: string[] = [];
      const h = await buildTestHarness({
        deps: {
          logger: true,
          logLevel: 'debug',
          loggerStream: { write: (msg: string) => void lines.push(msg) },
          nodeEnv,
        },
      });
      failUserLookup(h.users, 'log-only detail');
      await h.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'someone@cre.test', password: 'whatever' },
      });
      expect(lines.some((line) => line.includes('unhandled request error'))).toBe(true);
    }
  });
});