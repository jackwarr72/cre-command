import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { decorateRequestUser } from './auth/hooks';
import { registerErrorHandler } from './errors';
import type { AppDeps, SecurityOptions } from './ports';
import { registerAuthRoutes } from './routes/auth';
import { registerCrawlRunRoutes } from './routes/crawlRuns';
import { registerHealthRoutes } from './routes/health';
import { registerListingRoutes } from './routes/listings';
import { registerSourceRoutes } from './routes/sources';

/** Secure defaults — an explicit allowlist of zero origins (same-origin only). */
export const DEFAULT_SECURITY: SecurityOptions = {
  corsOrigins: [],
  rateLimitMax: 300,
  rateLimitWindowMs: 60_000,
  loginRateLimitMax: 10,
  bodyLimitBytes: 1_048_576,
  trustProxy: false,
};

/**
 * Creates a FastifyError-compatible object for rate-limit rejections.
 * In @fastify/rate-limit v11, `errorResponseBuilder` must return an Error
 * with `statusCode` and `code` properties; the returned error then flows
 * through the standard error handler (registered via `registerErrorHandler`)
 * which wraps it in the shared `ApiErrorBody` envelope:
 * `{ error: { message: "...", code: "RATE_LIMITED" } }` with HTTP 429.
 */
function rateLimitError(retryAfter: string): Error & { statusCode: number; code: string } {
  const err = new Error(`too many requests — retry in ${retryAfter}`) as Error & {
    statusCode: number;
    code: string;
  };
  err.statusCode = 429;
  err.code = 'RATE_LIMITED';
  return err;
}

/** Conservative hardening headers on every response (API serves JSON only). */
function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-site');
  });
}

/**
 * Builds the Fastify application with injectable dependencies (production:
 * drizzle-backed repositories; tests: in-memory fakes driven via `inject`).
 *
 * Hardening applied here, independent of repositories:
 * - CORS restricted to an explicit origin allowlist (no credentials/cookies —
 *   the API is bearer-token only).
 * - Global sliding-window rate limit; a stricter per-IP cap on login.
 * - Bounded request bodies; proxy-aware IPs only when explicitly enabled.
 * - Security headers and log redaction of credentials.
 *
 * Every route lives under `/api` — the web app proxies that prefix
 * (API_ORIGIN, default http://localhost:4000).
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const security: SecurityOptions = { ...DEFAULT_SECURITY, ...deps.security };

  const app = Fastify({
    logger: deps.logger
      ? {
          level: deps.logLevel ?? 'info',
          redact: {
            paths: [
              'http.headers.authorization',
              'http.headers.cookie',
              'http.body.password',
              'http.body.email',
              'http.body.adminPassword',
            ],
            censor: '[REDACTED]',
          },
          // Injectable destination (tests): capture serialized lines to assert
          // redaction without touching stdout.
          stream: deps.loggerStream,
        }
      : false,
    bodyLimit: security.bodyLimitBytes,
    trustProxy: security.trustProxy,
  });

  await app.register(cors, {
    // Bearer-token API: no cookies ⇒ credentials stay off. Non-allowlisted
    // browser origins simply get no CORS headers (same-origin and
    // server-to-server clients are unaffected).
    origin: (origin, cb) => {
      if (!origin || security.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: security.rateLimitMax,
    timeWindow: security.rateLimitWindowMs,
    // Rate limit per client IP; with trustProxy enabled Fastify resolves the
    // real client IP from X-Forwarded-For set by the trusted proxy.
    keyGenerator: (request) => request.ip,
        errorResponseBuilder: (_request, context) => rateLimitError(context.after),
  });

  registerErrorHandler(app);
  registerSecurityHeaders(app);
  decorateRequestUser(app);

    // Opt-in structured request logging (emitted at debug level, so default
  // `info` production logs stay lean). When enabled, this hook is what makes
  // the logger's redact paths above (`http.headers.*`, `http.body.*`) actually
  // observable — and testable. `preHandler` is used rather than `onResponse`
  // because Fastify consumes/parses the body by the time `onResponse` fires;
  // at `preHandler` the deserialized `request.body` is available for capture.
  if (deps.logger) {
    app.addHook('preHandler', async (request, reply) => {
      request.log.debug(
        {
          http: {
            method: request.method,
            url: request.url,
            status: reply.statusCode,
            headers: request.headers,
            body: request.body,
          },
        },
        'request completed',
      );
    });
  }

  await app.register(
    async (api) => {
      registerHealthRoutes(api);
      registerAuthRoutes(api, deps);
      registerListingRoutes(api, deps);
      registerSourceRoutes(api, deps);
      registerCrawlRunRoutes(api, deps);
    },
    { prefix: '/api' },
  );

  await app.ready();
  return app;
}