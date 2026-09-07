/**
 * Crawl-runs API endpoints.
 *
 * GET  /api/crawl-runs  → Paged<CrawlRun>   (paginated, optionally filtered)
 * POST /api/crawl-runs  → CrawlOutcome      (trigger a crawl — operator only)
 */
import type {
  CrawlError,
  CrawlRun,
  CrawlRunStatus,
  Paged,
} from '@cre/shared';

import { apiRequest } from './client';

export interface CrawlOutcome {
  runId: string | null;
  status: CrawlRunStatus;
  pagesFetched: number;
  pagesFailed: number;
  candidatesFound: number;
  candidatesDeduped: number;
  listingsAdded: number;
  listingsUpdated: number;
  listingsUnchanged: number;
  errors: CrawlError[];
}

export interface CrawlRunFilter {
  sourceKey?: string;
  statuses?: CrawlRunStatus[];
}

export interface TriggerCrawlRequest {
  sourceKey: string;
  urls?: string[];
}

export const crawlRunsApi = {
  list: (
    filter: CrawlRunFilter,
    page: number,
    pageSize: number,
  ): Promise<Paged<CrawlRun>> =>
    apiRequest('/crawl-runs', {
      query: {
        page,
        pageSize,
        sourceKey: filter.sourceKey,
        // The API reads a comma-separated `status` param (singular).
        status: filter.statuses?.join(','),
      },
    }),

  get: (id: string): Promise<CrawlRun> => apiRequest(`/crawl-runs/${id}`),

  trigger: (sourceKey: string, urls?: string[]): Promise<CrawlOutcome> =>
    apiRequest('/crawl-runs', {
      method: 'POST',
      body: urls ? { sourceKey, urls } : { sourceKey },
    }),
};
