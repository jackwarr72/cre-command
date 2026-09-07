/**
 * @cre/crawler — Vivanuncios ingestion contract & pipeline validation.
 *
 * Fixture-based validation using 25 representative Vivanuncios HTML cards that
 * exercise diverse source shapes: currency variants (MXN, USD, EUR), size units
 * (m², sqft, ha→sqm, acres), missing/optional fields, Unicode characters,
 * duplicate externalIds and canonical URLs, malformed price text, multiple
 * property types.
 *
 * Validates three layers independently:
 *   1. Parser correctness — adapter.parse produces expected ListingCandidate values
 *   2. Pipeline correctness — dedup, insert/update/unchanged, observations, accounting
 *   3. Field quality metrics — presence and correctness rates for each field
 *
 * Note: This tests ingestion of real Vivanuncios-shaped HTML, but does NOT prove
 * the live Vivanuncios endpoint is currently crawlable (see Phase 5 for live
 * production-source accessibility validation).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ListingCandidate } from '@cre/shared';
import { vivanunciosAdapter } from '@cre/adapters';
import { Crawler } from '../src/crawl';
import { fingerprintListing, materializedFromCandidate } from '../src/fingerprint';
import { summarizeMetrics } from '../src/metrics';
import type {
  Clock,
  CrawlRunRepository,
  CrawlerRepositories,
  HttpClient,
  HttpResponse,
  ListingRepository,
  ObservationRepository,
  RobotsChecker,
  RobotsPolicy,
  SourceRepository,
} from '../src/ports';

// ── Fixture ────────────────────────────────────────────────────────

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/vivanuncios-e2e.html', import.meta.url),
);
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf8');

const FIXED_NOW = new Date('2025-06-01T12:00:00.000Z');
const clock: Clock = { now: () => FIXED_NOW };

// ── Fake repositories ────────────────────────────────────────────────

interface StoredListing {
  id: string;
  sourceId: string;
  externalId: string;
  sourceUrl: string;
  fingerprint: string;
  version: number;
  title: string;
  description: string | null;
  propertyType: string;
  listingType: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  priceUnit: string | null;
  sizeValue: string | null;
  sizeUnit: string | null;
  city: string | null;
  state: string | null;
  country: string;
  formattedAddress: string | null;
}

class FakeListingRepo implements ListingRepository {
  readonly rows: StoredListing[] = [];
  inserts = 0;
  updates = 0;

  async findByExternalIds(
    sourceId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, { id: string; externalId: string; fingerprint: string }>> {
    const map = new Map<string, { id: string; externalId: string; fingerprint: string }>();
    for (const row of this.rows) {
      if (row.sourceId === sourceId && externalIds.includes(row.externalId)) {
        map.set(row.externalId, { id: row.id, externalId: row.externalId, fingerprint: row.fingerprint });
      }
    }
    return map;
  }

  async insert(sourceId: string, candidate: ListingCandidate, _now: Date): Promise<string> {
    this.inserts += 1;
    const id = `lst-${this.rows.length + 1}`;
    const materialized = materializedFromCandidate(candidate);
    const fingerprint = fingerprintListing(materialized);
    this.rows.push({
      id,
      sourceId,
      externalId: candidate.externalId,
      sourceUrl: candidate.sourceUrl,
      fingerprint,
      version: 1,
      title: candidate.title,
      description: materialized.description,
      propertyType: materialized.propertyType,
      listingType: materialized.listingType,
      priceAmount: materialized.priceAmount,
      priceCurrency: materialized.priceCurrency,
      priceUnit: materialized.priceUnit,
      sizeValue: materialized.sizeValue,
      sizeUnit: materialized.sizeUnit,
      city: materialized.city,
      state: materialized.state,
      country: materialized.country,
      formattedAddress: materialized.formattedAddress,
    });
    return id;
  }

  async update(listingId: string, candidate: ListingCandidate, _now: Date): Promise<void> {
    this.updates += 1;
    const row = this.rows.find((r) => r.id === listingId);
    if (!row) throw new Error(`update: unknown listing ${listingId}`);
    const materialized = materializedFromCandidate(candidate);
    row.fingerprint = fingerprintListing(materialized);
    row.version += 1;
    row.title = candidate.title;
    row.description = materialized.description;
    row.priceAmount = materialized.priceAmount;
    row.priceCurrency = materialized.priceCurrency;
    row.priceUnit = materialized.priceUnit;
    row.sizeValue = materialized.sizeValue;
    row.sizeUnit = materialized.sizeUnit;
    row.city = materialized.city;
    row.state = materialized.state;
    row.formattedAddress = materialized.formattedAddress;
  }
}

class FakeObservationRepo implements ObservationRepository {
  readonly recorded: Array<{ listingId: string; sourceUrl: string; observedAt: Date; candidate: ListingCandidate }> = [];
  async record(listingId: string, candidate: ListingCandidate, observedAt: Date): Promise<void> {
    this.recorded.push({ listingId, sourceUrl: candidate.sourceUrl, observedAt, candidate });
  }
}

class FakeCrawlRunRepo implements CrawlRunRepository {
  readonly created: Array<{ sourceId: string; startedAt: Date }> = [];
  readonly finished: Array<{ runId: string; accounting: any }> = [];
  private seq = 0;

  async create(sourceId: string, startedAt: Date): Promise<string> {
    const runId = `run-${++this.seq}`;
    this.created.push({ sourceId, startedAt });
    return runId;
  }

  async finish(runId: string, accounting: any): Promise<void> {
    this.finished.push({ runId, accounting });
  }
}

class FakeSourceRepo implements SourceRepository {
  constructor(private readonly row: any) {}
  async findByKey(_key: string): Promise<any> {
    return this.row;
  }
}

const DUPLICATE_URL =
  'https://www.vivanuncios.com.mx/s/ofertas/locales-en-renta/ciudad-de-mexico/condesa/418002991';

function makeSource(overrides: Record<string, any> = {}): any {
  return {
    id: 'src-1',
    key: 'vivanuncios',
    name: 'Vivanuncios',
    baseUrl: 'https://www.vivanuncios.com.mx',
    enabled: true,
    schedule: '0 3 * * *',
    config: {},
    crawlAllowed: true,
    robotsPolicy: 'honor' as const,
    rateLimitMs: 0,
    maxWorkers: 1,
    authenticationRequired: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

class FakeHttp implements HttpClient {
  readonly requested: string[] = [];
  constructor(private readonly body: string) {}
  async get(url: string): Promise<HttpResponse> {
    this.requested.push(url);
    return { status: 200, url, body: this.body, headers: {} };
  }
}

class FakeRobots implements RobotsChecker {
  async isAllowed(_url: string, _policy: RobotsPolicy): Promise<{ allowed: boolean; reason: string }> {
    return { allowed: true, reason: 'rules_allow' };
  }
}

function buildHarness(html = FIXTURE_HTML, sourceOverrides: Record<string, any> = {}) {
  const source = makeSource(sourceOverrides);
  const listings = new FakeListingRepo();
  const observations = new FakeObservationRepo();
  const crawlRuns = new FakeCrawlRunRepo();
  const http = { body: html, requested: [] as string[] };
  const httpClient: HttpClient = {
    async get(url: string): Promise<HttpResponse> {
      http.requested.push(url);
      return { status: 200, url, body: http.body, headers: {} };
    },
  };
  const robots = new FakeRobots();

  const crawler = new Crawler({
    repositories: {
      sources: new FakeSourceRepo(source),
      listings,
      observations,
      crawlRuns,
    } as CrawlerRepositories,
    http: httpClient,
    robots,
    clock,
  });

  return {
    source,
    listings,
    observations,
    crawlRuns,
    http,
    crawler,
    crawl(urls: readonly string[]) {
      return crawler.crawl({ adapter: vivanunciosAdapter, urls });
    },
  };
}

// ── Tests: Parser correctness ───────────────────────────────────────

describe('Vivanuncios ingestion contract: parser', () => {
  it('extracts exactly 24 valid candidates from 25 HTML cards (1 rejected: missing title)', () => {
    const { candidates, errors } = vivanunciosAdapter.parse(FIXTURE_HTML);

    expect(candidates).toHaveLength(24);
    expect(errors).toHaveLength(1);
    expect(errors[0].context?.externalId).toBe('700000018');
    expect(errors[0].message).toContain('invalid listing candidate');
  });

  it('every extracted card has a valid URL, externalId, title, and property type', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);

    for (const c of candidates) {
      expect(c.sourceUrl).toMatch(/^https:\/\/www\.vivanuncios\.com\.mx\//);
      expect(c.externalId).toMatch(/^\d+$/);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.propertyType).toBeTruthy();
      expect(c.listingType).toBeTruthy();
    }
  });

  it('card 422131234 (full office lease) matches expected normalized values', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '422131234');
    expect(card).toBeDefined();
    expect(card!.sourceUrl).toBe(
      'https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/ciudad-de-mexico/polanco/422131234',
    );
    expect(card!.title).toBe('Oficina en renta de 2,300 m² en Polanco');
    expect(card!.propertyType).toBe('office');
    expect(card!.listingType).toBe('lease');
    expect(card!.price).toEqual({ amount: 18500, currency: 'MXN' });
    expect(card!.priceUnit).toBe('sqm-month');
    expect(card!.size).toEqual({ value: 2300, unit: 'sqm' });
    expect(card!.address?.city).toBe('Polanco');
    expect(card!.address?.state).toBe('Ciudad de México');
    expect(card!.address?.country).toBe('MX');
    expect(card!.images.length).toBe(2);
  });

  it('card 700000001 (USD land sale with hectares) normalizes correctly', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000001');
    expect(card).toBeDefined();
    expect(card!.price).toEqual({ amount: 2500000, currency: 'USD' });
    expect(card!.size).toEqual({ value: 100000, unit: 'sqm' }); // 10 ha → 100000 m²
    expect(card!.listingType).toBe('sale');
    expect(card!.propertyType).toBe('land');
  });

  it('card 700000002 (missing price) has undefined price and priceUnit', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000002');
    expect(card).toBeDefined();
    expect(card!.price).toBeUndefined();
    expect(card!.priceUnit).toBeUndefined();
    expect(card!.size).toEqual({ value: 120, unit: 'sqm' });
  });

  it('card 700000003 (sqft size) parses size as sqft', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000003');
    expect(card).toBeDefined();
    expect(card!.size).toEqual({ value: 5000, unit: 'sqft' });
  });

  it('card 700000004 (5.5 ha) converts to sqm', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000004');
    expect(card).toBeDefined();
    expect(card!.size).toEqual({ value: 55000, unit: 'sqm' });
  });

  it('card 700000005 (missing size) has undefined size', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000005');
    expect(card).toBeDefined();
    expect(card!.size).toBeUndefined();
    expect(card!.priceUnit).toBe('total');
  });

  it('card 700000006 (incomplete address — city only) has city but no state', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000006');
    expect(card).toBeDefined();
    expect(card!.address?.city).toBe('Guadalajara');
    expect(card!.address?.state).toBeFalsy();
    expect(card!.address?.country).toBe('MX');
  });

  it('card 700000007 (Unicode characters) preserves special characters in title', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000007');
    expect(card).toBeDefined();
    expect(card!.title).toContain('®');
    expect(card!.title).toContain('ñ');
  });

  it('card 700000008 (malformed price) has undefined price', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000008');
    expect(card).toBeDefined();
    expect(card!.price).toBeUndefined();
    expect(card!.priceUnit).toBeUndefined();
  });

  it('card 700000009 (missing description, no image) has no description', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000009');
    expect(card).toBeDefined();
    expect(card!.description).toBeUndefined();
    expect(card!.images).toEqual([]);
  });

  it('card 700000011 (naves-industriales) maps to industrial property type', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000011');
    expect(card).toBeDefined();
    expect(card!.propertyType).toBe('industrial');
  });

  it('card 700000012 (15 acres) parses as acre', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000012');
    expect(card).toBeDefined();
    expect(card!.size).toEqual({ value: 15, unit: 'acre' });
  });

  it('card 700000013 (USD sqm-year) parses currency and unit correctly', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000013');
    expect(card).toBeDefined();
    expect(card!.price).toEqual({ amount: 150000, currency: 'USD' });
    expect(card!.priceUnit).toBe('sqm-year');
  });

  it('card 700000014 (empty address) has falsy city and state', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000014');
    expect(card).toBeDefined();
    expect(card!.address?.city).toBeFalsy();
    expect(card!.address?.state).toBeFalsy();
    expect(card!.address?.country).toBe('MX');
  });

  it('card 700000015 (USD sqft-month) parses currency and unit correctly', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000015');
    expect(card).toBeDefined();
    expect(card!.price).toEqual({ amount: 15, currency: 'USD' });
    expect(card!.priceUnit).toBe('sqft-month');
    expect(card!.size).toEqual({ value: 2500, unit: 'sqft' });
  });

  it('card 700000017 (EUR listing) parses EUR currency', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000017');
    expect(card).toBeDefined();
    expect(card!.price).toEqual({ amount: 500000, currency: 'EUR' });
  });

  it('card 700000020 (missing price and size) has both undefined', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000020');
    expect(card).toBeDefined();
    expect(card!.price).toBeUndefined();
    expect(card!.size).toBeUndefined();
  });

  it('card 700000021 (multiple images) extracts all image URLs', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const card = candidates.find((c) => c.externalId === '700000021');
    expect(card).toBeDefined();
    expect(card!.images.length).toBe(3);
    for (const img of card!.images) {
      expect(img).toMatch(/^https:\/\/www\.vivanuncios\.com\.mx\/img\//);
    }
  });

  it('duplicate externalId (422131234) produces 2 candidates in parse output', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const dupes = candidates.filter((c) => c.externalId === '422131234');
    expect(dupes.length).toBe(2);
  });

  it('duplicate URL with different externalIds (418002991 path) produces 2 candidates', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const sameUrl = candidates.filter((c) => c.sourceUrl === DUPLICATE_URL);
    expect(sameUrl.length).toBe(2);
    expect(sameUrl.map((c) => c.externalId).sort()).toEqual(['700000010', '700000019']);
  });
});

// ── Tests: Field quality metrics ────────────────────────────────────

describe('Vivanuncios ingestion contract: field quality metrics', () => {
  it('measures field presence rates across parsed candidates', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);

    const withPrice = candidates.filter((c) => c.price !== undefined).length;
    const withSize = candidates.filter((c) => c.size !== undefined).length;
    const withAddress = candidates.filter((c) => c.address !== undefined).length;
    const withImages = candidates.filter((c) => c.images.length > 0).length;
    const withDescription = candidates.filter((c) => c.description !== undefined).length;

    expect(withPrice).toBe(21); // 3 cards have no price
    expect(withSize).toBe(22); // 2 cards have no size
    expect(withAddress).toBe(24); // all have address (even with empty city/state)
    expect(withImages).toBe(2); // card 1 (2 imgs) and card 21 (3 imgs)
    expect(withDescription).toBe(1); // only card 1 has description
  });

  it('currency correctness: all prices have valid 3-letter ISO codes', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    for (const c of candidates) {
      if (c.price) {
        expect(c.price.currency).toMatch(/^[A-Z]{3}$/);
      }
    }
  });

  it('1 duplicate externalId reduces 24 candidates to 23 unique', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const ids = candidates.map((c) => c.externalId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length - 1);
  });
});

// ── Tests: Pipeline correctness ──────────────────────────────────────

describe('Vivanuncios ingestion contract: pipeline', () => {
  it('first crawl: extracts 24 candidates, dedups to 23, persists 23', async () => {
    const h = buildHarness();
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    // 1 adapter error (missing title) → status is completed_with_errors
    expect(outcome.status).toBe('completed_with_errors');
    expect(outcome.errors).toHaveLength(1);

    // 24 candidates found, 1 deduped (duplicate externalId 422131234)
    expect(outcome.candidatesFound).toBe(24);
    expect(outcome.candidatesDeduped).toBe(1);

    // Persistence: 23 inserts, 23 observations
    expect(h.listings.inserts).toBe(23);
    expect(h.listings.updates).toBe(0);
    expect(h.listings.rows).toHaveLength(23);
    expect(h.observations.recorded).toHaveLength(23);

    // Run accounting
    expect(h.crawlRuns.created).toHaveLength(1);
    expect(h.crawlRuns.finished).toHaveLength(1);
    const accounting = h.crawlRuns.finished[0].accounting;
    expect(accounting.status).toBe('completed_with_errors');
    expect(accounting.listingsFound).toBe(24);
    expect(accounting.listingsAdded).toBe(23);
  });

  it('repeat identical crawl: 0 new listings, 0 updates, 23 unchanged, no uniqueness violations', async () => {
    const h = buildHarness();

    const first = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);
    expect(first.listingsAdded).toBe(23);

    h.listings.inserts = 0;
    h.listings.updates = 0;
    h.observations.recorded = [];

    const second = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    // Idempotency: no new listings, no updates
    expect(second.listingsAdded).toBe(0);
    expect(second.listingsUpdated).toBe(0);
    expect(second.listingsUnchanged).toBe(23);
    expect(second.candidatesDeduped).toBe(1);

    // No canonical mutation
    expect(h.listings.inserts).toBe(0);
    expect(h.listings.updates).toBe(0);

    // No duplicates created
    const externalIds = h.listings.rows.map((r) => r.externalId);
    expect(new Set(externalIds).size).toBe(externalIds.length);

    // Observations still recorded (append-only provenance)
    expect(h.observations.recorded).toHaveLength(23);

    // Metrics reflect the idempotent crawl
    expect(second.metrics).toBeDefined();
    expect(second.metrics!.listingsCreated).toBe(0);
    expect(second.metrics!.listingsUpdated).toBe(0);
    expect(second.metrics!.listingsUnchanged).toBe(23);
  });

  it('crawl-run metrics contain all bounded latency and field-completeness fields', async () => {
    const h = buildHarness();
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    const m = outcome.metrics!;
    expect(m.requestCount).toBe(1); // one URL fetched
    expect(m.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(m.maxLatencyMs).toBeGreaterThanOrEqual(0);
    expect(m.latencySamplesMs.length).toBeLessThanOrEqual(1000);
    expect(m.latencySamplesMs.length).toBe(1);

    expect(m.cardsSeen).toBe(25);
    expect(m.cardsParsed).toBe(24);
    expect(m.cardsRejected).toBe(1);

    expect(m.candidatesWithTitle).toBe(24);
    expect(m.candidatesWithPrice).toBe(21);
    expect(m.candidatesWithSize).toBe(22);
    expect(m.candidatesWithAddress).toBe(24); // all 24 parsed candidates have address
    expect(m.candidatesWithPropertyType).toBe(24);
  });

  it('field completeness rate is computed correctly from crawled candidates', async () => {
    const h = buildHarness();
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    const summary = summarizeMetrics(outcome.metrics!);

    // 24 parsed candidates, 5 fields checked per candidate = 120 total field checks
    // candidatesWithTitle=24, candidatesWithPrice=21, candidatesWithAddress=24, candidatesWithSize=22, candidatesWithPropertyType=24
    // fieldCompletenessRate = (24 + 21 + 24 + 22 + 24) / (24 * 5) = 115/120 = 0.9583
    expect(summary.fieldCompletenessRate).toBeCloseTo(115 / 120, 2);
    expect(summary.medianLatencyMs).toBeTypeOf('number');
    expect(summary.p95LatencyMs).toBeTypeOf('number');
    expect(summary.averageLatencyMs).toBeTypeOf('number');
    expect(summary.maxLatencyMs).toBeTypeOf('number');
  });

  it('duplicate URL with different externalIds both persisted', async () => {
    const h = buildHarness();
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    // Cards 700000010 and 700000019 share URL but have different externalIds
    const dupUrlRows = h.listings.rows.filter((r) => r.sourceUrl === DUPLICATE_URL);
    expect(dupUrlRows).toHaveLength(2);
    expect(new Set(dupUrlRows.map((r) => r.externalId)).size).toBe(2);
  });
});

// ── Tests: Compliance & failure scenarios ──────────────────────────

describe('Vivanuncios ingestion contract: compliance & failures', () => {
  it('disabled source → zero HTTP requests, cancelled', async () => {
    const h = buildHarness('', { enabled: false });
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    expect(outcome.status).toBe('cancelled');
    expect(h.http.requested).toHaveLength(0);
    expect(h.crawlRuns.created).toHaveLength(1);
    expect(h.crawlRuns.finished).toHaveLength(1);
    expect(h.crawlRuns.finished[0].accounting.status).toBe('cancelled');
  });

  it('crawlAllowed=false → zero HTTP requests, cancelled', async () => {
    const h = buildHarness('', { crawlAllowed: false });
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    expect(outcome.status).toBe('cancelled');
    expect(h.http.requested).toHaveLength(0);
  });

  it('authenticationRequired=true → zero HTTP requests, cancelled', async () => {
    const h = buildHarness('', { authenticationRequired: true });
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    expect(outcome.status).toBe('cancelled');
    expect(h.http.requested).toHaveLength(0);
  });

  it('robots denied → URL not fetched', async () => {
    const h = buildHarness();
    const blockingRobots: RobotsChecker = {
      async isAllowed(_url: string, _policy: RobotsPolicy) {
        return { allowed: false, reason: 'rules_disallow' as const };
      },
    };

    const crawler = new Crawler({
      repositories: {
        sources: new FakeSourceRepo(h.source),
        listings: h.listings,
        observations: h.observations,
        crawlRuns: h.crawlRuns,
      } as CrawlerRepositories,
      http: h.crawler['options'].http,
      robots: blockingRobots,
      clock,
    });

    const outcome = await crawler.crawl({
      adapter: vivanunciosAdapter,
      urls: ['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/'],
    });

    expect(h.http.requested).toHaveLength(0);
    expect(outcome.pagesFetched).toBe(0);
    expect(outcome.status).toBe('failed');
    expect(outcome.errors[0].message).toContain('robots policy');
  });

  it('HTTP error on all URLs → run fails with accurate error count', async () => {
    const h = buildHarness();
    const failingHttp: HttpClient = {
      async get(_url: string): Promise<HttpResponse> {
        throw new Error('HTTP 503 Service Unavailable');
      },
    };

    const crawler = new Crawler({
      repositories: {
        sources: new FakeSourceRepo(h.source),
        listings: h.listings,
        observations: h.observations,
        crawlRuns: h.crawlRuns,
      } as CrawlerRepositories,
      http: failingHttp,
      robots: new FakeRobots(),
      clock,
    });

    const outcome = await crawler.crawl({
      adapter: vivanunciosAdapter,
      urls: ['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/'],
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.pagesFetched).toBe(0);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].message).toContain('fetch failed');
    expect(outcome.metrics!.httpErrors).toBe(1);
    expect(outcome.metrics!.httpStatusCounts).toEqual({});
  });

  it('malformed HTML → adapter produces no candidates, run fails', async () => {
    const h = buildHarness('<html><body><p>no listings here</p></body></html>');
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    expect(outcome.status).toBe('failed');
    expect(outcome.candidatesFound).toBe(0);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].message).toContain('no listing cards found');
  });

  it('mixed good/bad pages → partial success with completed_with_errors', async () => {
    const goodHtml = FIXTURE_HTML;
    const brokenHtml = '<html><body><p>error page</p></body></html>';

    const source = makeSource();
    const listings = new FakeListingRepo();
    const observations = new FakeObservationRepo();
    const crawlRuns = new FakeCrawlRunRepo();

    class PerUrlHttp implements HttpClient {
      readonly requested: string[] = [];
      constructor(private readonly bodies: Map<string, string>) {}
      async get(url: string): Promise<HttpResponse> {
        this.requested.push(url);
        const body = this.bodies.get(url);
        if (!body) throw new Error(`HTTP 503 for ${url}`);
        return { status: 200, url, body, headers: {} };
      }
    }

    const bodies = new Map([
      ['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/', goodHtml],
      ['https://www.vivanuncios.com.mx/s/ofertas/broken-page/', brokenHtml],
    ]);

    const downloader = new PerUrlHttp(bodies);
    const crawler = new Crawler({
      repositories: {
        sources: new FakeSourceRepo(source),
        listings,
        observations,
        crawlRuns,
      } as CrawlerRepositories,
      http: downloader,
      robots: new FakeRobots(),
      clock,
    });

    const outcome = await crawler.crawl({
      adapter: vivanunciosAdapter,
      urls: [
        'https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/',
        'https://www.vivanuncios.com.mx/s/ofertas/broken-page/',
      ],
    });

    expect(outcome.pagesFetched).toBe(2);
    expect(outcome.pagesFailed).toBe(0);
    expect(outcome.candidatesFound).toBe(24); // only from good page
    expect(outcome.listingsAdded).toBe(23); // after dedup
  });
});
