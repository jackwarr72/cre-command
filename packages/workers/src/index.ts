/**
 * @cre/workers — composition root.
 *
 * Consumes `crawl.run` outbox events written by the API inside the same
 * transaction as the queued crawl run, and executes them through the existing
 * crawler engine:
 *
 *   outbox (pending) → PgOutboxJobQueue.popBatch → markProcessing
 *     → CrawlJobHandler (load source → resolve adapter → claim run)
 *       → Crawler.executeExistingRun (robots gate → fetch → parse → persist)
 *     → outbox complete/fail
 *
 * No second crawler path is created: listings, robots policy, retries, and
 * crawl-run accounting all live in @cre/crawler and its Postgres repositories.
 *
 * Configuration: DATABASE_URL (required), optional CRAWL_WORKER_POLL_MS and
 * CRAWL_WORKER_BATCH_SIZE. Values from the shell win over `packages/api/.env`
 * (loaded for host-run parity with the API's dotenv convention).
 */
import { config as loadEnv } from 'dotenv';
loadEnv(); // root .env (POSTGRES_PASSWORD etc.)
loadEnv({ path: new URL('../../api/.env', import.meta.url) }); // packages/api/.env (DATABASE_URL)

import pino from 'pino';

import { vivanunciosAdapter, vivanunciosMetepecAdapter } from '@cre/adapters';
import { AdapterRegistry } from '@cre/crawler';
import { createDatabase, createPool, type Database } from '@cre/db';

import { CrawlWorker } from './crawlWorker';
import { PgOutboxJobQueue } from './outboxQueue';

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required — set it in the environment or packages/api/.env`);
  }
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got '${raw}')`);
  }
  return parsed;
}

const databaseUrl = requiredEnv('DATABASE_URL');
const pollIntervalMs = positiveIntEnv('CRAWL_WORKER_POLL_MS', 2_000);
const batchSize = positiveIntEnv('CRAWL_WORKER_BATCH_SIZE', 5);

const pool = createPool(databaseUrl);
const db: Database = createDatabase(pool);

// Same composition as the API's crawl trigger: one registry, both sources.
const registry = new AdapterRegistry()
  .register(vivanunciosAdapter)
  .register(vivanunciosMetepecAdapter);

const worker = new CrawlWorker({
  db,
  adapterRegistry: registry,
  queue: new PgOutboxJobQueue(db),
  batchSize,
  pollIntervalMs,
  log: (message, context) => logger.info(context ?? {}, message),
  logError: (message, error) =>
    logger.error({ err: error instanceof Error ? { message: error.message, stack: error.stack } : error }, message),
});

let workerLoop: Promise<void> | null = null;
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'crawl worker shutting down');
  worker.stop(); // finish the in-flight tick, then exit the loop
  if (workerLoop) await workerLoop;
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info({ pollIntervalMs, batchSize, adapters: registry.list() }, 'crawl worker started');
workerLoop = worker.start();
