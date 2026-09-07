import type {
  AnomalySeverity,
  AnomalyType,
  CrawlRunMetrics,
  CrawlRunWithMetrics,
  CrawlRunStatus,
  SourceAnomaly,
  SourceHealth,
  SourceHealthStatus,
} from '@cre/shared';

/** Thresholds for deterministic health evaluation. */
export interface HealthThresholds {
  /** Listings discovered below this fraction of the previous successful run → volume drop warning. */
  listingVolumeDropWarning: number;
  /** Parse errors as a fraction of pages attempted above this → parse degradation. */
  parseErrorRateWarning: number;
  /** HTTP failures as a fraction of pages attempted above this → transport degradation. */
  httpErrorRateWarning: number;
  /** HTTP failures as a fraction of pages attempted above this (higher) → transport degradation (critical). */
  httpErrorRateCritical: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  listingVolumeDropWarning: 0.3,
  parseErrorRateWarning: 0.5,
  httpErrorRateWarning: 0.5,
  httpErrorRateCritical: 0.9,
};

function rateError(message: string, type: AnomalyType, severity: AnomalySeverity): SourceAnomaly {
  return { type, severity, message, detectedAt: new Date().toISOString() };
}

/**
 * Evaluates the health of a source given its recent crawl run history.
 *
 * Deterministic rules (no ML):
 * - EXTRACTION_ANOMALY (critical): source previously returned listings but now
 *   returns 0, and HTTP succeeded.
 * - LISTING_VOLUME_DROP (warning): current listing count is below
 *   `listingVolumeDropWarning` of the previous successful run.
 * - PARSE_DEGRADATION (warning): parse error rate exceeds threshold.
 * - TRANSPORT_DEGRADATION (warning/critical): HTTP error rate exceeds threshold.
 * - UNKNOWN: insufficient history to evaluate.
 */
export function evaluateHealth(
  sourceKey: string,
  runs: CrawlRunWithMetrics[],
  thresholds: HealthThresholds = DEFAULT_THRESHOLDS,
  now: Date = new Date(),
): SourceHealth {
  const anomalies: SourceAnomaly[] = [];

  if (runs.length === 0) {
    return {
      sourceKey,
      status: 'unknown',
      anomalies,
    };
  }

  const latest = runs[0];
  const latestMetrics = latest.metrics ?? fallbackMetrics(latest);
  const lastSuccess = runs.find((r) => r.status === 'completed' || r.status === 'completed_with_errors');

  // Extract metrics arrays for comparison
  const allMetricsWithData = runs
    .filter((r) => r.status !== 'cancelled' && r.status !== 'queued')
    .map((r) => r.metrics ?? fallbackMetrics(r));

  if (allMetricsWithData.length === 0) {
    return {
      sourceKey,
      status: 'unknown',
      lastAttempt: latest.finishedAt,
      anomalies,
    };
  }

  // ── Extraction anomaly: 0 listings after previously healthy ──
  const hasSuccessfulRun = runs.some((r) => r.status === 'completed' || r.status === 'completed_with_errors');
  if (hasSuccessfulRun && latestMetrics.listingsDiscovered === 0 && latestMetrics.pagesSucceeded > 0) {
    anomalies.push(
      rateError(
        `Extraction returned 0 listings after previously successful crawls (HTTP succeeded on ${latestMetrics.pagesSucceeded} page(s))`,
        'extraction_anomaly',
        'critical',
      ),
    );
  }

  // ── Listing volume drop ──
  const prevSuccess = allMetricsWithData
    .filter((m) => m !== latestMetrics && m.listingsDiscovered > 0)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];

  if (prevSuccess && prevSuccess.listingsDiscovered > 0) {
    const ratio = latestMetrics.listingsDiscovered / prevSuccess.listingsDiscovered;
    if (ratio < thresholds.listingVolumeDropWarning && ratio > 0) {
      anomalies.push(
        rateError(
          `Listing volume dropped ${Math.round((1 - ratio) * 100)}% (from ${prevSuccess.listingsDiscovered} to ${latestMetrics.listingsDiscovered})`,
          'listing_volume_drop',
          'warning',
        ),
      );
    }
  }

  // ── Parse degradation ──
  if (latestMetrics.pagesAttempted > 0) {
    const parseErrorRate = latestMetrics.parseErrors / latestMetrics.pagesAttempted;
    if (parseErrorRate >= thresholds.parseErrorRateWarning) {
      anomalies.push(
        rateError(
          `Parse error rate ${Math.round(parseErrorRate * 100)}% exceeds threshold`,
          'parse_degradation',
          'warning',
        ),
      );
    }
  }

  // ── Transport degradation ──
  if (latestMetrics.pagesAttempted > 0) {
    const httpErrorRate = latestMetrics.httpErrors / latestMetrics.pagesAttempted;
    if (httpErrorRate >= thresholds.httpErrorRateCritical) {
      anomalies.push(
        rateError(
          `HTTP error rate ${Math.round(httpErrorRate * 100)}% exceeds critical threshold`,
          'transport_degradation',
          'critical',
        ),
      );
    } else if (httpErrorRate >= thresholds.httpErrorRateWarning) {
      anomalies.push(
        rateError(
          `HTTP error rate ${Math.round(httpErrorRate * 100)}% exceeds warning threshold`,
          'transport_degradation',
          'warning',
        ),
      );
    }
  }

  // ── Determine overall status ──
  let status: SourceHealthStatus = 'healthy';
  if (anomalies.some((a) => a.severity === 'critical')) {
    status = 'critical';
  } else if (anomalies.some((a) => a.severity === 'warning')) {
    status = 'warning';
  }

  const allSuccessful = allMetricsWithData.every((m) => {
    const run = runs.find((r) => r.id === m.runId);
    return !run || run.status === 'completed' || run.status === 'completed_with_errors';
  });
  if (!allSuccessful) {
    status = 'critical';
  }

  const listingVolumeChange = prevSuccess
    ? latestMetrics.listingsDiscovered - prevSuccess.listingsDiscovered
    : undefined;

  return {
    sourceKey,
    status,
    lastAttempt: latest.finishedAt,
    lastSuccess: lastSuccess?.finishedAt,
    latestRun: latestMetrics,
    listingVolumeChange,
    anomalies,
  };
}

/** Fallback when a run has no stored metrics (pre-existing data). */
function fallbackMetrics(run: CrawlRunWithMetrics): CrawlRunMetrics {
  return {
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    listingsDiscovered: run.listingsFound,
    listingsAccepted: run.listingsFound,
    listingsRejected: 0,
    duplicateCandidates: 0,
    listingsCreated: run.listingsAdded,
    listingsUpdated: run.listingsUpdated,
    listingsUnchanged: 0,
    parseErrors: 0,
    httpErrors: 0,
    robotsDenials: 0,
    retryCount: 0,
    httpStatusCounts: {},
    requestCount: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    latencySamplesMs: [],
    bytesDownloaded: 0,
    cardsSeen: 0,
    cardsParsed: 0,
    cardsRejected: 0,
    candidatesWithTitle: 0,
    candidatesWithPrice: 0,
    candidatesWithAddress: 0,
    candidatesWithSize: 0,
    candidatesWithPropertyType: 0,
    observationsInserted: 0,
    errors: run.errors,
  };
}