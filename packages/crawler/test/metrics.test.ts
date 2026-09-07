import { describe, expect, it } from 'vitest';

import type { CrawlRunMetrics, ListingCandidate } from '@cre/shared';

import { summarizeBatch, summarizeMetrics } from '../src/metrics';

function baseMetrics(overrides: Partial<CrawlRunMetrics> = {}): CrawlRunMetrics {
  return {
    runId: 'run-1',
    status: 'completed',
    startedAt: '2025-06-01T12:00:00.000Z',
    finishedAt: '2025-06-01T12:01:00.000Z',
    pagesAttempted: 10,
    pagesSucceeded: 8,
    pagesFailed: 2,
    listingsDiscovered: 100,
    listingsAccepted: 95,
    listingsRejected: 5,
    duplicateCandidates: 5,
    listingsCreated: 90,
    listingsUpdated: 5,
    listingsUnchanged: 0,
    parseErrors: 1,
    httpErrors: 3,
    robotsDenials: 0,
    retryCount: 2,
    httpStatusCounts: { '200': 8, '503': 2 },
    requestCount: 10,
    totalLatencyMs: 5000,
    maxLatencyMs: 800,
    latencySamplesMs: [100, 200, 300, 400, 500, 600, 700, 800],
    bytesDownloaded: 1024 * 1024,
    cardsSeen: 100,
    cardsParsed: 95,
    cardsRejected: 5,
    candidatesWithTitle: 95,
    candidatesWithPrice: 90,
    candidatesWithAddress: 85,
    candidatesWithSize: 80,
    candidatesWithPropertyType: 95,
    observationsInserted: 95,
    errors: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<ListingCandidate> = {}): ListingCandidate {
  return {
    sourceKey: 'test',
    externalId: 'ext-1',
    sourceUrl: 'https://example.test/l/1',
    title: 'Test listing',
    propertyType: 'office',
    listingType: 'lease',
    price: { amount: 1000, currency: 'USD' },
    size: { value: 100, unit: 'sqft' },
    address: { country: 'US', formatted: 'Test City' },
    images: [],
    contacts: [],
    ...overrides,
  };
}

describe('summarizeMetrics — latency calculations', () => {
  it('requestCount = 0 → average, median, p95, max all null', () => {
    const m = summarizeMetrics(baseMetrics({ requestCount: 0, totalLatencyMs: 0, maxLatencyMs: 0, latencySamplesMs: [] }));
    expect(m.averageLatencyMs).toBeNull();
    expect(m.maxLatencyMs).toBeNull();
    expect(m.medianLatencyMs).toBeNull();
    expect(m.p95LatencyMs).toBeNull();
  });

  it('requestCount = 1 → average equals totalLatencyMs, max equals that value', () => {
    const m = summarizeMetrics(
      baseMetrics({ requestCount: 1, totalLatencyMs: 500, maxLatencyMs: 500, latencySamplesMs: [500] }),
    );
    expect(m.averageLatencyMs).toBe(500);
    expect(m.maxLatencyMs).toBe(500);
    expect(m.medianLatencyMs).toBe(500);
    expect(m.p95LatencyMs).toBe(500);
  });

  it('requestCount > 0 → average = totalLatencyMs / requestCount', () => {
    const m = summarizeMetrics(baseMetrics({ requestCount: 10, totalLatencyMs: 5000, maxLatencyMs: 800 }));
    expect(m.averageLatencyMs).toBe(500);
    expect(m.maxLatencyMs).toBe(800);
  });

  it('latency samples are used for median and p95 percentile', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const m = summarizeMetrics(baseMetrics({ latencySamplesMs: samples }));
    expect(m.medianLatencyMs).toBe(55); // (50+60)/2
  });

  it('zero-valued latency: average is 0, not null', () => {
    const m = summarizeMetrics(baseMetrics({ requestCount: 3, totalLatencyMs: 0, maxLatencyMs: 0, latencySamplesMs: [0, 0, 0] }));
    expect(m.averageLatencyMs).toBe(0);
    expect(m.maxLatencyMs).toBe(0);
    expect(m.medianLatencyMs).toBe(0);
    expect(m.p95LatencyMs).toBe(0);
  });
});

describe('summarizeMetrics — field completeness', () => {
  it('zero parsed candidates → fieldCompletenessRate is null', () => {
    const m = summarizeMetrics(baseMetrics({ cardsParsed: 0 }));
    expect(m.fieldCompletenessRate).toBeNull();
  });

  it('all five fields present on every parsed candidate → completeness = 1', () => {
    const m = summarizeMetrics(
      baseMetrics({
        cardsParsed: 20,
        candidatesWithTitle: 20,
        candidatesWithPrice: 20,
        candidatesWithAddress: 20,
        candidatesWithSize: 20,
        candidatesWithPropertyType: 20,
      }),
    );
    expect(m.fieldCompletenessRate).toBeCloseTo(1);
  });

  it('none of the five fields present → completeness = 0', () => {
    const m = summarizeMetrics(
      baseMetrics({
        cardsParsed: 20,
        candidatesWithTitle: 0,
        candidatesWithPrice: 0,
        candidatesWithAddress: 0,
        candidatesWithSize: 0,
        candidatesWithPropertyType: 0,
      }),
    );
    expect(m.fieldCompletenessRate).toBe(0);
  });

  it('partial field completeness computed as fieldsPresent / (cardsParsed * 5)', () => {
    const m = summarizeMetrics(
      baseMetrics({
        cardsParsed: 20,
        candidatesWithTitle: 18,
        candidatesWithPrice: 19,
        candidatesWithAddress: 15,
        candidatesWithSize: 17,
        candidatesWithPropertyType: 20,
      }),
    );
    expect(m.fieldCompletenessRate).toBeCloseTo(89 / 100);
  });

  it('rejected cards do not count against field completeness', () => {
    const m = summarizeMetrics(
      baseMetrics({
        cardsSeen: 25,
        cardsParsed: 20,
        cardsRejected: 5,
        candidatesWithTitle: 20,
        candidatesWithPrice: 20,
        candidatesWithAddress: 20,
        candidatesWithSize: 20,
        candidatesWithPropertyType: 20,
      }),
    );
    expect(m.fieldCompletenessRate).toBe(1);
  });
});

describe('summarizeMetrics — other rates', () => {
  it('fetchSuccessRate, parseSuccessRate, deduplicationRate, errorRate, listingsPerPage', () => {
    const m = summarizeMetrics(baseMetrics());
    expect(m.fetchSuccessRate).toBe(0.8); // 8/10
    expect(m.parseSuccessRate).toBeCloseTo(0.95); // 95/100
    expect(m.deduplicationRate).toBe(0.05); // 5/100
    expect(m.errorRate).toBeCloseTo(0.4); // (1+3)/10
    expect(m.listingsPerPage).toBeCloseTo(11.25); // 90/8
  });

  it('zero pagesAttempted → fetch and error rates are null', () => {
    const m = summarizeMetrics(baseMetrics({ pagesAttempted: 0, pagesSucceeded: 0, httpErrors: 0, parseErrors: 0 }));
    expect(m.fetchSuccessRate).toBeNull();
    expect(m.errorRate).toBeNull();
  });

  it('zero pagesSucceeded → listingsPerPage is null', () => {
    const m = summarizeMetrics(baseMetrics({ pagesSucceeded: 0, listingsCreated: 0 }));
    expect(m.listingsPerPage).toBeNull();
  });
});

describe('summarizeBatch', () => {
  it('empty array returns zeroed results', () => {
    const result = summarizeBatch([]);
    expect(result.totalRuns).toBe(0);
    expect(result.completedRuns).toBe(0);
    expect(result.failedRuns).toBe(0);
    expect(result.avgFetchSuccessRate).toBeNull();
    expect(result.avgParseSuccessRate).toBeNull();
    expect(result.totalListingsCreated).toBe(0);
    expect(result.totalBytesDownloaded).toBe(0);
    expect(result.avgMedianLatencyMs).toBeNull();
  });

  it('aggregates multiple runs correctly', () => {
    const runs = [
      baseMetrics({ runId: 'run-1', status: 'completed', pagesSucceeded: 10, pagesAttempted: 10, listingsCreated: 90, bytesDownloaded: 1000, latencySamplesMs: [100, 200, 300] }),
      baseMetrics({ runId: 'run-2', status: 'failed', pagesSucceeded: 5, pagesAttempted: 10, listingsCreated: 30, bytesDownloaded: 500, latencySamplesMs: [50, 150] }),
    ];
    const result = summarizeBatch(runs);
    expect(result.totalRuns).toBe(2);
    expect(result.completedRuns).toBe(1);
    expect(result.failedRuns).toBe(1);
    expect(result.totalListingsCreated).toBe(120);
    expect(result.totalBytesDownloaded).toBe(1500);
    expect(result.avgFetchSuccessRate).toBeCloseTo(0.75);
    expect(result.avgMedianLatencyMs).not.toBeNull();
  });
});
