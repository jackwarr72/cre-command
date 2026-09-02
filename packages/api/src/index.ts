/**
 * @cre/api — entry point (composition root).
 *
 * Wires drizzle repositories and the crawler trigger into the Fastify app,
 * bootstraps the initial admin when CRE_ADMIN_EMAIL/CRE_ADMIN_PASSWORD are
 * configured and the users table is empty, then starts listening.
 *
 * Operational concerns handled here (not in app.ts, which stays testable):
 * - hardened security options resolved from the environment
 * - periodic pruning of expired sessions
 * - graceful shutdown on SIGTERM/SIGINT (drain in-flight requests, close the
 *   pool, clear timers) so container orchestration can retire the process
 *   without dropping requests or leaking connections.
 *
 * Nothing exports from here — import `buildApp` (or the individual modules)
 * for tests and embedding.
 */
import { createDatabase, createPool, type Database } from '@cre/db';

import { buildApp } from './app';
import { ensureBootstrapAdmin } from './auth/bootstrap';
import { loadConfig } from './config';
import { createCrawlTrigger } from './postgres/crawler';
import { createApiRepositories } from './postgres/repositories';

const config = loadConfig();
// The pool is kept as a direct reference so graceful shutdown can close it —
// NodePgDatabase does not expose the underlying client through its type.
const pool = createPool();
const db: Database = createDatabase(pool);
const repos = createApiRepositories(db);

const app = await buildApp({
  ...repos,
  crawl: createCrawlTrigger(db),
  sessionTtlHours: config.sessionTtlHours,
  security: {
    corsOrigins: config.corsOrigins,
    rateLimitMax: config.rateLimitMax,
    rateLimitWindowMs: config.rateLimitWindowMs,
    loginRateLimitMax: config.loginRateLimitMax,
    bodyLimitBytes: config.bodyLimitBytes,
    trustProxy: config.trustProxy,
  },
  logLevel: config.logLevel,
  logger: true,
});

const bootstrap = await ensureBootstrapAdmin(repos.users, {
  email: config.adminEmail,
  password: config.adminPassword,
});
if (bootstrap.created) {
  app.log.info({ email: bootstrap.email }, 'bootstrapped initial admin user');
}

// ── Session pruning ──────────────────────────────────────────────
// Expired sessions are invisible to `findActive` but still occupy rows;
// prune them on a fixed interval so the table cannot grow without bound.
// SESSION_PRUNE_INTERVAL_MS=0 disables the timer (e.g. an external cron).
let pruneTimer: NodeJS.Timeout | null = null;
if (config.sessionPruneIntervalMs > 0) {
  pruneTimer = setInterval(() => {
    repos.sessions
      .deleteExpired(new Date())
      .then((pruned) => {
        if (pruned > 0) app.log.info({ pruned }, 'pruned expired sessions');
      })
      .catch((error: unknown) => {
        app.log.error({ error }, 'session pruning failed');
      });
  }, config.sessionPruneIntervalMs);
  // Never keep the process alive just for the timer.
  pruneTimer.unref();
}

// ── Graceful shutdown ────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  if (pruneTimer) clearInterval(pruneTimer);
  // Stop accepting new connections and await in-flight requests (bounded by
  // fastify's closeTimeout); then close the pool so the process can exit.
  try {
    await app.close();
  } finally {
    await pool.end().catch(() => undefined);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
app.log.info(
  { port: config.port, host: config.host, env: config.nodeEnv },
  'api listening',
);