/**
 * Dashboard API endpoint.
 *
 * GET /api/dashboard → DashboardSummary
 *
 * Aggregates sources, listings counts, recent crawl runs, and source health
 * evaluations into a single payload the control panel can render in one pass.
 */
import type { CrawlRunWithMetrics, SourceHealth } from '@cre/shared';

import { apiRequest } from './client';

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

export const dashboardApi = {
  summary: (): Promise<DashboardSummary> => apiRequest('/dashboard'),
};
