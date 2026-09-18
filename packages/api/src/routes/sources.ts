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

/** Accepts only absolute http(s) URLs. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Accepted shape for creating a source (POST /sources). */
const createSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1, 'key is required')
      .max(64, 'key must be at most 64 characters')
      .regex(
        /^[a-z0-9][a-z0-9_-]*$/,
        'key must start with a letter or digit and use only lowercase letters, digits, "-" or "_"',
      ),
    name: z
      .string()
      .trim()
      .min(1, 'name is required')
      .max(200, 'name must be at most 200 characters'),
    baseUrl: z
      .string()
      .trim()
      .max(2048)
      .nullish()
      .transform((value) => (value == null || value === '' ? null : value))
      .refine((value) => value === null || isHttpUrl(value), {
        message: 'baseUrl must be a valid http(s) URL',
      }),
    schedule: z
      .string()
      .trim()
      .min(1, 'schedule is required')
      .max(64)
      .regex(/^\S+(\s+\S+){4,5}$/, 'schedule must be a cron expression of 5-6 space-separated fields'),
    robotsPolicy: z.enum(ROBOTS_POLICIES),
    rateLimitMs: z.number().int().min(0).max(60_000),
    maxWorkers: z.number().int().min(1).max(64),
  })
  .strict();

export function registerSourceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(
    deps.sessions,
    deps.now,
    deps.authBypass ?? false,
    deps.nodeEnv ?? 'development',
  );

  app.get('/sources', { preHandler: guards.requireAuth }, async () => {
    const rows = await deps.sources.list();
    return rows.map(toSourceDto);
  });

  // Creating a source is an operator action. Identity fields (key/name/baseUrl/
  // schedule) are frozen after creation — the PATCH endpoint only changes crawl
  // policy — so a wrong key is fixed by editing, not by re-creating.
  app.post('/sources', { preHandler: guards.requireRole('operator', 'admin') }, async (request) => {
    const input = createSchema.parse(request.body);

    const existing = await deps.sources.findByKey(input.key);
    if (existing) {
      throw new ApiError(409, 'DUPLICATE_KEY', `source key '${input.key}' already exists`);
    }

    const now = (deps.now ?? ((): Date => new Date()))();
    const created = await deps.sources.create(
      {
        key: input.key,
        name: input.name,
        baseUrl: input.baseUrl,
        schedule: input.schedule,
        robotsPolicy: input.robotsPolicy,
        rateLimitMs: input.rateLimitMs,
        maxWorkers: input.maxWorkers,
      },
      now,
    );

    await deps.audit
      .append({
        action: 'source.created',
        at: now,
        actorUserId: request.user!.id,
        actorEmail: request.user!.email,
        targetType: 'source',
        targetId: created.key,
        metadata: { fields: Object.keys(input) },
      })
      .catch((error: unknown) => request.log.error({ error }, 'audit append failed'));

    return toSourceDto(created);
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