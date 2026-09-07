/**
 * Dashboard aggregation endpoint.
 *
 * GET /api/dashboard → DashboardSummary
 *
 * Composes real data from the existing query repositories (sources, crawl runs,
 * listings) and the `evaluateHealth` evaluator into a single payload the control
 * panel dashboard can render without making N parallel calls.
 */
import type { FastifyInstance } from 'fastify';

import type { CrawlRunWithMetrics, SourceHealth } from '@cre/shared';
import { createAuthGuards } from '../auth/hooks';
import { evaluateHealth } from '../health/evaluate';
import type { AppDeps } from '../ports';

const RECENT_RUNS_PER_SOURCE = 5;
const TOTAL_RECENT_RUNS = 20;

export interface DashboardSummary {
  sources: {
    total: number;
    active: number;
    withErrors: number;
  };
  listings: {
    active: number;
    total: number;
  };
  runs: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    successRate: number;
    last24hCount: number;
  };
  recentRuns: CrawlRunWithMetrics[];
  sourceHealth: SourceHealth[];
}

export function registerDashboardRoute(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(deps.sessions, deps.now);

  app.get('/dashboard', { preHandler: guards.requireAuth }, async () => {
    const nowFn = deps.now ?? (() => new Date());
    const now = nowFn();
    const sources = await deps.sources.list();

    const activeSources = sources.filter((s) => s.enabled && s.crawlAllowed).length;

    const health: SourceHealth[] = await Promise.all(
      sources.map(async (source) => {
        const runs = await deps.health.recentRuns(source.key, RECENT_RUNS_PER_SOURCE);
        return evaluateHealth(source.key, runs, undefined, now);
      }),
    );

    const withErrors = health.filter(
      (h) => h.anomalies.length > 0 || h.status === 'critical' || h.status === 'warning',
    ).length;

    const recentRunsPage = await deps.crawlRuns.list({}, 1, TOTAL_RECENT_RUNS);
    const recentRuns = recentRunsPage.items;
    const totalRuns = recentRunsPage.total;
    const completed = recentRuns.filter((r) => r.status === 'completed' || r.status === 'completed_with_errors').length;
    const failed = recentRuns.filter((r) => r.status === 'failed').length;
    const running = recentRuns.filter((r) => r.status === 'running' || r.status === 'queued').length;
    const successRate = recentRuns.length > 0 ? completed / recentRuns.length : 0;

    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last24hCount = recentRuns.filter((r) => {
      if (!r.finishedAt) return false;
      return new Date(r.finishedAt) >= since;
    }).length;

    // We don't have a dedicated count endpoint; estimate from paged search.
    const activeListingsPage = await deps.listings.search({ statuses: ['active'] }, 1, 1);
    const totalListingsPage = await deps.listings.search({}, 1, 1);

    return {
      sources: {
        total: sources.length,
        active: activeSources,
        withErrors,
      },
      listings: {
        active: activeListingsPage.total,
        total: totalListingsPage.total,
      },
      runs: {
        total: totalRuns,
        completed,
        failed,
        running,
        successRate,
        last24hCount,
      },
      recentRuns,
      sourceHealth: health,
    };
  });
}
