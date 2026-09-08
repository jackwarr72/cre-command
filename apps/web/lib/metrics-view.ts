/**
 * Metrics view-model for the /metrics page.
 *
 * Pure layer between the wire data (`CrawlRunWithMetrics[]`) and the UI:
 * - aggregation reuses `@cre/crawler/metrics`' `summarizeBatch` so the page
 *   shows the same per-run KPI math as the API serializer, and pools the
 *   window's raw counters for run-weighted rates (mean-of-rates would let a
 *   tiny run outweigh a large one);
 * - windowed latency percentiles pool each run's `latencySamplesMs` (the
 *   per-run p95s of the engine cannot be combined across runs);
 * - formatters keep "no data" as an explicit `—`, never 0 or NaN.
 */
import type { CrawlRunMetrics, CrawlRunWithMetrics } from '@cre/shared';
import { summarizeBatch } from '@cre/crawler/metrics';

/** The API's page-size cap — the metrics window can never look past this. */
export const METRICS_PAGE_SIZE = 100;

/** Client-side "last N runs" window choices (API has no time-window param). */
export const METRICS_WINDOWS = [2, 10, 25, 50, 100] as const;
export type MetricsWindowSize = (typeof METRICS_WINDOWS)[number];

/** Windowed aggregate over crawl-run metrics, ready for the stat cards. */
export interface MetricsAggregate {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  listingsCreated: number;
  listingsUpdated: number;
  /** runs with at least one page attempt; null when nothing was attempted. */
  fetchSuccessRate: number | null;
  /** cards parsed / cards seen; null when no cards were seen. */
  parseSuccessRate: number | null;
  /** duplicates / discovered; null when nothing was discovered. */
  deduplicationRate: number | null;
  /** (http + parse errors) / attempted pages; null when nothing attempted. */
  errorRate: number | null;
  /** presence of title/price/address/size/type; null when nothing parsed. */
  fieldCompletenessRate: number | null;
  /** created / successful pages; null when no page succeeded. */
  listingsPerPage: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Max single-request latency across runs; null when no requests. */
  latencyMaxMs: number | null;
  bytesDownloaded: number;
}

export function buildMetricsAggregate(runs: CrawlRunWithMetrics[]): MetricsAggregate {
  // The serializer populates `metrics` on every run, but stay guarded: a run
  // without a metrics block simply cannot contribute.
  const metrics = runs.flatMap((run) => (run.metrics ? [run.metrics] : []));
  const sum = (pick: (m: CrawlRunMetrics) => number): number =>
    metrics.reduce((total, m) => total + pick(m), 0);

  const pagesAttempted = sum((m) => m.pagesAttempted);
  const pagesSucceeded = sum((m) => m.pagesSucceeded);
  const listingsDiscovered = sum((m) => m.listingsDiscovered);
  const duplicateCandidates = sum((m) => m.duplicateCandidates);
  const cardsSeen = sum((m) => m.cardsSeen);
  const cardsParsed = sum((m) => m.cardsParsed);
  const listingsCreated = sum((m) => m.listingsCreated);

  const fieldChecks =
    sum((m) => m.candidatesWithTitle) +
    sum((m) => m.candidatesWithPrice) +
    sum((m) => m.candidatesWithAddress) +
    sum((m) => m.candidatesWithSize) +
    sum((m) => m.candidatesWithPropertyType);

  const samples = metrics.flatMap((m) => m.latencySamplesMs);
  const sorted = [...samples].sort((a, b) => a - b);
  const maxLatencies = metrics
    .filter((m) => m.requestCount > 0)
    .map((m) => m.maxLatencyMs);

  return {
    // Engine parity with the API serializer for the headline counters.
    totalRuns: summarizeBatch(metrics).totalRuns,
    completedRuns: metrics.filter((m) => m.status === 'completed').length,
    failedRuns: metrics.filter((m) => m.status === 'failed').length,
    listingsCreated,
    listingsUpdated: sum((m) => m.listingsUpdated),
    fetchSuccessRate: pagesAttempted > 0 ? pagesSucceeded / pagesAttempted : null,
    parseSuccessRate: cardsSeen > 0 ? cardsParsed / cardsSeen : null,
    deduplicationRate: listingsDiscovered > 0 ? duplicateCandidates / listingsDiscovered : null,
    errorRate:
      pagesAttempted > 0 ? (sum((m) => m.httpErrors) + sum((m) => m.parseErrors)) / pagesAttempted : null,
    fieldCompletenessRate: cardsParsed > 0 ? fieldChecks / (cardsParsed * 5) : null,
    listingsPerPage: pagesSucceeded > 0 ? listingsCreated / pagesSucceeded : null,
    latencyP50Ms: percentile(sorted, 50),
    latencyP95Ms: percentile(sorted, 95),
    latencyMaxMs: maxLatencies.length > 0 ? Math.max(...maxLatencies) : null,
    bytesDownloaded: sum((m) => m.bytesDownloaded),
  };
}

// Percentile helpers mirror `@cre/crawler`'s engine exactly (not exported
// there) so the windowed numbers stay consistent with per-run reporting.
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}
/** Per-run latency percentile over a single run's samples (engine parity). */
export function runLatencyPercentile(samples: number[], p: number): number | null {
  return percentile([...samples].sort((a, b) => a - b), p);
}

/** 0.942 → "94.2%"; null (no data) → "—". */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

/** 850 → "850 ms"; 1250 → "1.25 s"; 125000 → "125.0 s"; null → "—". */
export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds.toFixed(seconds < 100 ? 2 : 1)} s`;
}

export { formatNumber } from './utils';