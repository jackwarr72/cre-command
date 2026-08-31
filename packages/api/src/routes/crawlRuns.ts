import { CRAWL_RUN_STATUSES } from '@cre/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createAuthGuards } from '../auth/hooks';
import { ApiError } from '../errors';
import { enumCsv } from '../params';
import { parsePageQuery } from '../pagination';
import type { AppDeps } from '../ports';

const triggerSchema = z
  .object({
    sourceKey: z.string().min(1),
    urls: z.array(z.string().url()).min(1).max(100).optional(),
  })
  .strict();

/** Source-config fallback for entry URLs (validated to actual strings). */
function entryUrlsFromConfig(config: Record<string, unknown>): string[] {
  const raw = config['entryUrls'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
}

export function registerCrawlRunRoutes(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(deps.sessions, deps.now);

  app.get('/crawl-runs', { preHandler: guards.requireAuth }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = parsePageQuery(query);
    const sourceKeyRaw = query['sourceKey'];
    const sourceKey =
      typeof sourceKeyRaw === 'string' && sourceKeyRaw.trim() !== ''
        ? sourceKeyRaw.trim()
        : undefined;
    const statuses = enumCsv(query['status'], CRAWL_RUN_STATUSES, 'status');
    return deps.crawlRuns.list({ sourceKey, statuses }, page, pageSize);
  });

  /**
   * Operator action: run a crawl now. The crawler itself re-validates the
   * source policy and robots.txt at run time (fail closed) — this endpoint
   * only decides *whether to start one*.
   */
  app.post(
    '/crawl-runs',
    { preHandler: guards.requireRole('operator', 'admin') },
    async (request) => {
      const body = triggerSchema.parse(request.body);
      const source = await deps.sources.findByKey(body.sourceKey);
      if (!source) {
        throw ApiError.notFound('NOT_FOUND', `no source with key '${body.sourceKey}'`);
      }
      if (!deps.crawl.hasAdapter(source.key)) {
        throw ApiError.badRequest(
          'NO_ADAPTER',
          `no adapter registered for source '${source.key}'`,
        );
      }
      const urls = body.urls ?? entryUrlsFromConfig(source.config);
      if (urls.length === 0) {
        throw ApiError.badRequest(
          'NO_URLS',
          `no entry URLs: pass 'urls' in the request or configure 'entryUrls' on the source`,
        );
      }
      return deps.crawl.trigger(source, urls);
    },
  );
}