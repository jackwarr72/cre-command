import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { decorateRequestUser } from './auth/hooks';
import { registerErrorHandler } from './errors';
import type { AppDeps } from './ports';
import { registerAuthRoutes } from './routes/auth';
import { registerCrawlRunRoutes } from './routes/crawlRuns';
import { registerHealthRoutes } from './routes/health';
import { registerListingRoutes } from './routes/listings';
import { registerSourceRoutes } from './routes/sources';

/**
 * Builds the Fastify application with injectable dependencies (production:
 * drizzle-backed repositories; tests: in-memory fakes driven via `inject`).
 *
 * Every route lives under `/api` — the web app proxies that prefix
 * (API_ORIGIN, default http://localhost:4000).
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });

  await app.register(cors, { origin: true });
  registerErrorHandler(app);
  decorateRequestUser(app);

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