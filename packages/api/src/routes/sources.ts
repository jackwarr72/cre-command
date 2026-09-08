import { ROBOTS_POLICIES } from '@cre/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createAuthGuards } from '../auth/hooks';
import { ApiError } from '../errors';
import type { AppDeps } from '../ports';
import { toSourceDto } from '../serializers';

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    crawlAllowed: z.boolean().optional(),
    robotsPolicy: z.enum(ROBOTS_POLICIES).optional(),
    rateLimitMs: z.number().int().min(0).max(60_000).optional(),
    maxWorkers: z.number().int().min(1).max(64).optional(),
  })
  .strict();

export function registerSourceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(deps.sessions, deps.now);

  app.get('/sources', { preHandler: guards.requireAuth }, async () => {
    const rows = await deps.sources.list();
    return rows.map(toSourceDto);
  });

  // Policy changes are operator actions: only admin/operator may flip crawl
  // permissions — the crawler re-checks everything at run time (fail closed).
  app.patch(
    '/sources/:key',
    { preHandler: guards.requireRole('operator', 'admin') },
    async (request) => {
      const { key } = request.params as { key: string };
      const patch = patchSchema.parse(request.body);
      const now = (deps.now ?? ((): Date => new Date()))();
      const updated = await deps.sources.updatePolicy(key, patch, now);
      if (!updated) {
        throw ApiError.notFound('NOT_FOUND', `no source with key '${key}'`);
      }

      await deps.audit
        .append({
          action: 'source.policy_updated',
          at: now,
          actorUserId: request.user!.id,
          actorEmail: request.user!.email,
          targetType: 'source',
          targetId: updated.key,
          metadata: { fields: Object.keys(patch) },
        })
        .catch((error: unknown) => request.log.error({ error }, 'audit append failed'));

      return toSourceDto(updated);
    },
  );
}