/**
 * Unit tests for the /metrics view-model: pooled (run-weighted) aggregation
 * math, windowed latency percentiles, null-safe "no data" handling, and the
 * display formatters.
 */
import { describe, expect, it } from 'vitest';
import type { CrawlRunMetrics, CrawlRunWithMetrics } from '@cre/shared';

import { buildMetricsAggregate, formatMs, formatRate, runLatencyPercentile } from '../lib/metrics-view';

/** Full-shape metrics fixture (subset-typed via cast; aggregate reads these). */
function metrics(overrides: Partial<CrawlRunMetrics> = {}): CrawlRunMetrics {
  return {
    status: 'completed',
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    cardsSeen: 0,
    cardsParsed: 0,
    listingsDiscovered: 0,
    duplicateCandidates: 0,
    listingsCreated: 0,
    listingsUpdated: 0,
    listingsUnchanged: 0,
    candidatesWithTitle: 0,
    candidatesWithPrice: 0,
    candidatesWithAddress: 0,
    candidatesWithSize: 0,
    candidatesWithPropertyType: 0,
    parseErrors: 0,
    httpErrors: 0,
    robotsDenials: 0,
    requestCount: 0,
    maxLatencyMs: 0,
    latencySamplesMs: [],
    bytesDownloaded: 0,
    ...overrides,
  } as CrawlRunMetrics;
}

function run(
  id: string,
  m: CrawlRunMetrics,
  status: CrawlRunWithMetrics['status'] = 'completed',
): CrawlRunWithMetrics {
  return {
    id,
    sourceId: 'src-1',
    sourceKey: 'vivanuncios',
    sourceUrl: '',
    externalId: id,
    title: '',
    propertyType: 'office',
    listingType: 'lease',
    status,
    price: undefined,
    priceUnit: undefined,
    size: undefined,
    geo: undefined,
    address: undefined,
    yearBuilt: null,
    unitCount: null,
    listedAt: null,
    firstSeenAt: '2026-09-07T12:00:00.000Z',
    lastSeenAt: '2026-09-07T12:00:00.000Z',
    updatedAt: '2026-09-07T12:00:00.000Z',
    scrapedAt: '2026-09-07T12:00:00.000Z',
    images: [],
    contacts: [],
    raw: {},
    startedAt: '2026-09-07T12:00:00.000Z',
    finishedAt: '2026-09-07T12:00:00.000Z',
    listingsFound: 0,
    listingsAdded: 0,
    listingsUpdated: 0,
    errors: [],
    createdAt: '2026-09-07T12:00:00.000Z',
    metrics: m,
  } as CrawlRunWithMetrics;
}

describe('buildMetricsAggregate', () => {
  it('pools counters run-weighted, not as a mean of per-run rates', () => {
    const a = metrics({
      pagesAttempted: 100,
      pagesSucceeded: 50, // 50%
      cardsSeen: 40,
      cardsParsed: 30,
      listingsDiscovered: 30,
      duplicateCandidates: 10,
      listingsCreated: 20,
      listingsUpdated: 2,
      candidatesWithTitle: 30,
      candidatesWithPrice: 15,
      candidatesWithAddress: 30,
      candidatesWithSize: 15,
      candidatesWithPropertyType: 30,
      httpErrors: 40,
      parseErrors: 10,
      requestCount: 100,
      maxLatencyMs: 900,
      latencySamplesMs: [100, 200, 900],
      bytesDownloaded: 1000,
    });
    const b = metrics({
      pagesAttempted: 1,
      pagesSucceeded: 1, // 100% — must not outweigh run A's 50%
      latencySamplesMs: [2000],
      requestCount: 1,
      maxLatencyMs: 2000,
      bytesDownloaded: 500,
    });

    const agg = buildMetricsAggregate([run('r1', a), run('r2', b)]);

    expect(agg.totalRuns).toBe(2);
    expect(agg.completedRuns).toBe(2);
    expect(agg.failedRuns).toBe(0);
    expect(agg.listingsCreated).toBe(20);
    expect(agg.listingsUpdated).toBe(2);
    expect(agg.bytesDownloaded).toBe(1500);
    expect(agg.fetchSuccessRate).toBeCloseTo(51 / 101, 12);
    expect(agg.parseSuccessRate).toBeCloseTo(30 / 40, 12);
    expect(agg.deduplicationRate).toBeCloseTo(10 / 30, 12);
    expect(agg.errorRate).toBeCloseTo(50 / 101, 12);
    expect(agg.fieldCompletenessRate).toBeCloseTo(120 / 150, 12);
    expect(agg.listingsPerPage).toBeCloseTo(20 / 51, 12);
  });

  it('pools latency samples for windowed p50/p95 and takes the max of per-run maxima', () => {
    const a = metrics({
      latencySamplesMs: [100, 200, 900],
      requestCount: 3,
      maxLatencyMs: 900,
    });
    const b = metrics({ latencySamplesMs: [2000], requestCount: 1, maxLatencyMs: 2000 });

    const agg = buildMetricsAggregate([run('r1', a), run('r2', b)]);
    // Pooled samples: [100, 200, 900, 2000] → nearest-rank p50 = 200, p95 = 2000.
    expect(agg.latencyP50Ms).toBe(200);
    expect(agg.latencyP95Ms).toBe(2000);
    expect(agg.latencyMaxMs).toBe(2000);
  });

  it('is null-safe on an empty window (never 0 or NaN)', () => {
    const agg = buildMetricsAggregate([]);
    expect(agg.totalRuns).toBe(0);
    expect(agg.listingsCreated).toBe(0);
    expect(agg.fetchSuccessRate).toBeNull();
    expect(agg.parseSuccessRate).toBeNull();
    expect(agg.deduplicationRate).toBeNull();
    expect(agg.errorRate).toBeNull();
    expect(agg.fieldCompletenessRate).toBeNull();
    expect(agg.listingsPerPage).toBeNull();
    expect(agg.latencyP50Ms).toBeNull();
    expect(agg.latencyP95Ms).toBeNull();
    expect(agg.latencyMaxMs).toBeNull();
  });

  it('skips runs without a metrics block and counts failed runs separately', () => {
    const withMetrics = metrics({ pagesAttempted: 10, pagesSucceeded: 10 });
    const withoutMetrics = { id: 'r2', sourceKey: 'vivanuncios', status: 'failed' } as CrawlRunWithMetrics;

    const agg = buildMetricsAggregate([run('r1', withMetrics), withoutMetrics]);
    expect(agg.totalRuns).toBe(1); // only the run with metrics contributes
    expect(agg.completedRuns).toBe(1);
    expect(agg.failedRuns).toBe(0);
    expect(agg.fetchSuccessRate).toBeCloseTo(1, 12);
  });
});

describe('runLatencyPercentile', () => {
  it('returns the nearest-rank percentile of one run’s samples', () => {
    expect(runLatencyPercentile([100, 200, 300], 50)).toBe(200);
    expect(runLatencyPercentile([100, 200, 300], 95)).toBe(300);
    expect(runLatencyPercentile([], 95)).toBeNull();
  });
});

describe('formatters', () => {
  it('formatRate renders percentages and an explicit dash for no data', () => {
    expect(formatRate(0.942)).toBe('94.2%');
    expect(formatRate(0)).toBe('0.0%');
    expect(formatRate(1)).toBe('100.0%');
    expect(formatRate(null)).toBe('—');
  });

  it('formatMs scales to human units and keeps the dash for no data', () => {
    expect(formatMs(850)).toBe('850 ms');
    expect(formatMs(999)).toBe('999 ms');
    expect(formatMs(1000)).toBe('1.00 s');
    expect(formatMs(1250)).toBe('1.25 s');
    expect(formatMs(125000)).toBe('125.0 s');
    expect(formatMs(null)).toBe('—');
  });
});