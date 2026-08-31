/**
 * @cre/api — entry point (composition root).
 *
 * Wires drizzle repositories and the crawler trigger into the Fastify app,
 * bootstraps the initial admin when CRE_ADMIN_EMAIL/CRE_ADMIN_PASSWORD are
 * configured and the users table is empty, then starts listening.
 *
 * Nothing exports from here — import `buildApp` (or the individual modules)
 * for tests and embedding.
 */
import { createDatabase } from '@cre/db';

import { buildApp } from './app';
import { ensureBootstrapAdmin } from './auth/bootstrap';
import { loadConfig } from './config';
import { createCrawlTrigger } from './postgres/crawler';
import { createApiRepositories } from './postgres/repositories';

const config = loadConfig();
const db = createDatabase();
const repos = createApiRepositories(db);

const app = await buildApp({
  ...repos,
  crawl: createCrawlTrigger(db),
  sessionTtlHours: config.sessionTtlHours,
  logger: true,
});

const bootstrap = await ensureBootstrapAdmin(repos.users, {
  email: config.adminEmail,
  password: config.adminPassword,
});
if (bootstrap.created) {
  app.log.info({ email: bootstrap.email }, 'bootstrapped initial admin user');
}

await app.listen({ port: config.port, host: config.host });