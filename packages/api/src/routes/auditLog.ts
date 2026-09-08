import { AUDIT_ACTIONS } from '@cre/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createAuthGuards } from '../auth/hooks';
import { parsePageQuery } from '../pagination';
import type { AppDeps } from '../ports';

/**
 * Audit-trail query params. `from`/`to` are ISO 8601 instants; unknown params
 * are rejected (strict) so typos fail loudly instead of silently no-op'ing.
 */
const auditQuerySchema = z
  .object({
    action: z.enum(AUDIT_ACTIONS).optional(),
    actorUserId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/**
 * GET /audit-log — the append-only security/policy trail.
 * Operator+ only: audit visibility is a privileged read (viewers cannot see
 * who did what, including their own login history metadata).
 */
export function registerAuditLogRoute(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(deps.sessions, deps.now);

  app.get('/audit-log', { preHandler: guards.requireRole('operator', 'admin') }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = parsePageQuery(query);
    const parsed = auditQuerySchema.parse(query);

    return deps.audit.list(
      {
        action: parsed.action,
        actorUserId: parsed.actorUserId,
        from: parsed.from ? new Date(parsed.from) : undefined,
        to: parsed.to ? new Date(parsed.to) : undefined,
      },
      page,
      pageSize,
    );
  });
}