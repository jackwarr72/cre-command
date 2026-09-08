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

import { Redis } from 'ioredis';

import { buildApp } from './app';
import { ensureBootstrapAdmin } from './auth/bootstrap';
import { InMemoryMfaChallengeRepo } from './auth/mfa-challenges';
import { RedisMfaChallengeRepo, type RedisClient } from './auth/redis-mfa-challenges';
import { loadConfig } from './config';
import type { MfaChallengeRepo } from './ports';
import { createCrawlTrigger } from './postgres/crawler';
import { createApiRepositories } from './postgres/repositories';

const config = loadConfig();
// The pool is kept as a direct reference so graceful shutdown can close it —
// NodePgDatabase does not expose the underlying client through its type.
const pool = createPool();
const db: Database = createDatabase(pool);
const repos = createApiRepositories(db);

// ── MFA challenge store ──────────────────────────────────────────
// `REDIS_URL` opts into the Redis-backed store (shared across API instances
// behind a load balancer, survives restarts via key TTLs). Without it the
// in-process store is used, which matches the existing single-instance
// deployment. Redis is dialed after the app builds so connection errors are
// logged through pino and fail startup fast (fail-closed configuration).
let redis: Redis | null = null;
let redisClient: RedisClient | null = null;
let inMemoryMfaChallenges: InMemoryMfaChallengeRepo | null = null;
let mfaChallenges: MfaChallengeRepo;
if (config.redisUrl) {
  redis = new Redis(config.redisUrl, {
    lazyConnect: true,
  });
  // Adapter: ioredis's `set` is heavily overloaded; the MFA store needs only
  // the minimal (key, value, { ex }) contract.
  redisClient = {
    get: (key) => redis!.get(key),
    set: (key, value, options) =>
      options?.ex
        ? redis!.set(key, value, 'EX', options.ex).then(() => undefined)
        : redis!.set(key, value).then(() => undefined),
    del: (key) => redis!.del(key),
  };
  mfaChallenges = new RedisMfaChallengeRepo(redisClient, () => new Date());
} else {
  inMemoryMfaChallenges = new InMemoryMfaChallengeRepo();
  mfaChallenges = inMemoryMfaChallenges;
}

const app = await buildApp({
  ...repos,
  mfaChallenges,
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
  authBypass: config.authBypass,
  nodeEnv: config.nodeEnv,
});

// ── Redis connection (opt-in via REDIS_URL) ─────────────────────────
if (redis) {
  redis.on('error', (error: unknown) => {
    app.log.error({ error }, 'redis connection error');
  });
  try {
    await redis.connect();
  } catch (error) {
    app.log.error({ error }, 'failed to connect to redis — aborting startup');
    await pool.end().catch(() => undefined);
    throw error;
  }
  app.log.info({ enabled: true }, 'using redis-backed MFA challenge store');
}

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
  if (redis) {
    redis.disconnect();
  } else {
    inMemoryMfaChallenges?.stop();
  }
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