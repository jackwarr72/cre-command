/**
 * @cre/crawler — derived metrics.
 *
 * Pure functions that compute operational KPIs from a `CrawlRunMetrics`.
 * No I/O, no side effects — safe to call from tests, API serializers, and UI.
 */
import type { CrawlRunMetrics } from '@cre/shared';

/** A crawl run enriched with derived operational KPIs. */
export interface CrawlRunSummary {
  runId: string;
  status: string;
  durationMs: number | null;
  fetchSuccessRate: number | null;
  parseSuccessRate: number | null;
  fieldCompletenessRate: number | null;
  deduplicationRate: number | null;
  errorRate: number | null;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  listingsPerPage: number | null;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export function summarizeMetrics(m: CrawlRunMetrics): CrawlRunSummary {
  const durationMs =
    m.startedAt && m.finishedAt
      ? new Date(m.finishedAt).getTime() - new Date(m.startedAt).getTime()
      : null;

  const fetchSuccessRate = m.pagesAttempted > 0 ? m.pagesSucceeded / m.pagesAttempted : null;
  const parseSuccessRate = m.cardsSeen > 0 ? m.cardsParsed / m.cardsSeen : null;
  const deduplicationRate =
    m.listingsDiscovered > 0 ? m.duplicateCandidates / m.listingsDiscovered : null;
  const errorRate =
    m.pagesAttempted > 0 ? (m.httpErrors + m.parseErrors) / m.pagesAttempted : null;

  const averageLatencyMs = m.requestCount > 0 ? m.totalLatencyMs / m.requestCount : null;
  const maxLatencyMs = m.requestCount > 0 ? m.maxLatencyMs : null;

  const sorted = [...m.latencySamplesMs].sort((a, b) => a - b);
  const medianLatencyMs = sorted.length > 0 ? median(sorted) : null;
  const p95LatencyMs = sorted.length > 0 ? percentile(sorted, 95) : null;
  const listingsPerPage = m.pagesSucceeded > 0 ? m.listingsCreated / m.pagesSucceeded : null;

  const fieldsPresent =
    m.candidatesWithTitle +
    m.candidatesWithPrice +
    m.candidatesWithAddress +
    m.candidatesWithSize +
    m.candidatesWithPropertyType;
  const totalFieldChecks = m.cardsParsed > 0 ? m.cardsParsed * 5 : 0;
  const fieldCompletenessRate = totalFieldChecks > 0 ? fieldsPresent / totalFieldChecks : null;

  return {
    runId: m.runId,
    status: m.status,
    durationMs,
    fetchSuccessRate,
    parseSuccessRate,
    fieldCompletenessRate,
    deduplicationRate,
    errorRate,
    averageLatencyMs,
    maxLatencyMs,
    medianLatencyMs,
    p95LatencyMs,
    listingsPerPage,
  };
}

/**
 * Latency is tracked as bounded aggregates rather than an unbounded per-request
 * array. The crawler maintains `totalLatencyMs` and `maxLatencyMs` for all
 * requests, and pushes individual samples to `latencySamplesMs` — capped at
 * 1,000 entries to bound storage. For crawls exceeding 1,000 requests, samples
 * are the first 1,000 observed; this preserves a representative snapshot of
 * early-run performance. A future improvement may replace this with reservoir
 * sampling for a uniform sample across the entire crawl.
 */

export function summarizeBatch(metrics: CrawlRunMetrics[]): {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  avgFetchSuccessRate: number | null;
  avgParseSuccessRate: number | null;
  totalListingsCreated: number;
  totalBytesDownloaded: number;
  avgMedianLatencyMs: number | null;
} {
  if (metrics.length === 0) {
    return {
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      avgFetchSuccessRate: null,
      avgParseSuccessRate: null,
      totalListingsCreated: 0,
      totalBytesDownloaded: 0,
      avgMedianLatencyMs: null,
    };
  }

  const summaries = metrics.map(summarizeMetrics);
  const latencies = summaries
    .map((s) => s.medianLatencyMs)
    .filter((v): v is number => v !== null);

  return {
    totalRuns: metrics.length,
    completedRuns: metrics.filter((m) => m.status === 'completed').length,
    failedRuns: metrics.filter((m) => m.status === 'failed').length,
    avgFetchSuccessRate:
      mean(summaries.map((s) => s.fetchSuccessRate).filter((v): v is number => v !== null)),
    avgParseSuccessRate:
      mean(summaries.map((s) => s.parseSuccessRate).filter((v): v is number => v !== null)),
    totalListingsCreated: metrics.reduce((sum, m) => sum + m.listingsCreated, 0),
    totalBytesDownloaded: metrics.reduce((sum, m) => sum + m.bytesDownloaded, 0),
    avgMedianLatencyMs: latencies.length > 0 ? mean(latencies) : null,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}