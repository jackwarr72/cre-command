/**
 * SWR-based data-fetching hooks for the control panel.
 *
 * Each hook wraps an endpoint function from `lib/api/`. SWR handles caching,
 * background revalidation, and deduping automatically.
 *
 * The auth token is read from localStorage inside `apiRequest`, so no extra
 * wiring is needed — SWR re-fetches on key change and the client attaches the
 * token on every call.
 */
import useSWR from 'swr';

import { authApi, dashboardApi, listingsApi, sourcesApi, crawlRunsApi } from '@/lib/api';
import type { CrawlRun, Listing, ListingFilter, Paged, User } from '@cre/shared';
import type {
  CrawlOutcome,
  CrawlRunFilter,
  DashboardSummary,
  SourceDto,
  TriggerCrawlRequest,
} from '@/lib/api';

// ── Dashboard ─────────────────────────────────────────────────

/** Aggregated dashboard data: sources, runs, listings, source health. */
export function useDashboardSummary() {
  return useSWR<DashboardSummary>(['/api/dashboard'], () => dashboardApi.summary(), {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
}

// ── Auth ───────────────────────────────────────────────────────

/** Current user session. Re-validates the bearer token server-side. */
export function useCurrentUser() {
  return useSWR<User>(['/api/auth/me'], () => authApi.getCurrentUser(), {
    dedupingInterval: 60_000,
    revalidateOnFocus: false,
  });
}

// ── Listings ───────────────────────────────────────────────────

export interface UseListingsParams {
  filter: ListingFilter;
  page: number;
  pageSize: number;
}

export function useListings({ filter, page, pageSize }: UseListingsParams) {
  const key = ['listings', filter, page, pageSize] as const;
  return useSWR<Paged<Listing>>(key, () => listingsApi.search(filter, page, pageSize));
}

export function useListing(id: string | null) {
  const enabled = !!id;
  return useSWR<Listing>(
    enabled ? ['listing', id] : null,
    ([, listingId]: [string, string]) => listingsApi.get(listingId),
  );
}

// ── Sources ────────────────────────────────────────────────────

export function useSources() {
  return useSWR<SourceDto[]>(['/api/sources'], () => sourcesApi.list());
}

// ── Crawl runs ────────────────────────────────────────────────

export function useCrawlRuns(filter: CrawlRunFilter, page: number, pageSize: number) {
  const key = ['crawl-runs', filter, page, pageSize] as const;
  return useSWR(key, () => crawlRunsApi.list(filter, page, pageSize));
}

export function useCrawlRun(id: string | null) {
  const enabled = !!id;
  return useSWR<CrawlRun>(
    enabled ? ['crawl-run', id] : null,
    ([, runId]: [string, string]) => crawlRunsApi.get(runId),
  );
}

export interface TriggerCrawlOptions {
  onSuccess?: (result: CrawlOutcome) => void;
  onError?: (error: Error) => void;
}

/**
 * Triggers a crawl. Not a SWR hook — this is a one-shot mutation.
 * Returns a promise that resolves with the CrawlOutcome.
 */
export async function triggerCrawl(request: TriggerCrawlRequest): Promise<CrawlOutcome> {
  return crawlRunsApi.trigger(request.sourceKey, request.urls);
}
