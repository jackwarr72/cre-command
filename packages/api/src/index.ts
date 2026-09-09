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
import 'dotenv/config';

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