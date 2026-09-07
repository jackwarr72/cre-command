import type { FastifyInstance } from 'fastify';

import { createAuthGuards } from '../auth/hooks';
import { ApiError } from '../errors';
import { evaluateHealth } from '../health/evaluate';
import type { AppDeps } from '../ports';

export function registerSourceHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(deps.sessions, deps.now);

  app.get('/sources/:key/health', { preHandler: guards.requireAuth }, async (request) => {
    const { key } = request.params as { key: string };
    const source = await deps.sources.findByKey(key);
    if (!source) {
      throw ApiError.notFound('NOT_FOUND', `no source with key '${key}'`);
    }

    const runs = await deps.health.recentRuns(source.key, 10);
    const health = evaluateHealth(key, runs);
    return health;
  });
}
