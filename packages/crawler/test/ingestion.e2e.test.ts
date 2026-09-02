/**
 * @cre/crawler — real-source ingestion validation.
 *
 * End-to-end test using the real Vivanuncios adapter against a static HTML
 * fixture that mimics a real search-results page. Verifies the full pipeline:
 *
 *   adapter.parse → dedup → insert/update/unchanged → observations → crawl-run accounting
 *
 * Metrics measured:
 *   - candidate extraction accuracy (expected count vs actual)
 *   - missing-field rate (optional fields absent in parsed candidates)
 *   - price / size / location normalization accuracy
 *   - duplicate rate (within-crawl dedup by externalId)
 *   - update detection (repeat crawl with changed data)
 *   - observation append-only history
 *   - crawl-run accounting (pages, errors, status)
 *
 * This test is the operational gate: if the domain model does not match
 * real-world CRE data, we discover it here, not in production.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { vivanunciosAdapter } from '@cre/adapters';
import { Crawler } from '../src/crawl';
import { fingerprintListing, materializedFromCandidate } from '../src/fingerprint';
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

/**
 * Six cards, including:
 *   - full office lease (all fields)
 *   - sparse land sale (no description, no size)
 *   - retail lease (flat monthly)
 *   - industrial warehouse (lot size present)
 *   - duplicate externalId (422131234 repeated)
 *   - house with missing price and size
 */
const EXPECTED_CANDIDATES = [
  {
    sourceKey: 'vivanuncios',
    externalId: '422131234',
    sourceUrl: 'https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/ciudad-de-mexico/polanco/422131234',
    title: 'Oficina en renta de 2,300 m² en Polanco',
    description: 'Oficina clase A, recepción y estacionamiento. Dos niveles en torre corporativa.',
    propertyType: 'office',
    listingType: 'lease',
    price: { amount: 18500, currency: 'MXN' },
    priceUnit: 'sqm-month',
    size: { value: 2300, unit: 'sqm' },
    address: { city: 'Polanco', state: 'Ciudad de México', country: 'MX', formatted: 'Polanco, Ciudad de México' },
    images: ['https://www.vivanuncios.com.mx/img/oficina-polanco-01.jpg'],
    contacts: [],
    listedAt: '2026-08-28T10:00:00.000Z',
  },
  {
    sourceKey: 'vivanuncios',
    externalId: '419874123',
    sourceUrl: 'https://www.vivanuncios.com.mx/s/ofertas/terrenos-en-venta/estado-de-mexico/atlacomulco/419874123',
    title: 'Terreno en venta de 2.5 ha en Atlacomulco',
    description: undefined,
    propertyType: 'land',
    listingType: 'sale',
    price: { amount: 6500000, currency: 'MXN' },
    priceUnit: 'total',
    size: undefined,
    address: { city: 'Atlacomulco', state: 'Estado de México', country: 'MX', formatted: 'Atlacomulco, Estado de México' },
    images: [],
    contacts: [],
    listedAt: undefined,
  },
  {
    sourceKey: 'vivanuncios',
    externalId: '418002991',
    sourceUrl: 'https://www.vivanuncios.com.mx/s/ofertas/locales-en-renta/ciudad-de-mexico/condesa/418002991',
    title: 'Local en renta en La Condesa',
    description: undefined,
    propertyType: 'retail',
    listingType: 'lease',
    price: { amount: 42000, currency: 'MXN' },
    priceUnit: 'month',
    size: { value: 280, unit: 'sqm' },
    address: { city: 'La Condesa', state: 'Ciudad de México', country: 'MX', formatted: 'La Condesa, Ciudad de México' },
    images: [],
    contacts: [],
    listedAt: undefined,
  },
  {
    sourceKey: 'vivanuncios',
    externalId: '500000001',
    sourceUrl: 'https://www.vivanuncios.com.mx/s/ofertas/bodegas-en-renta/nuevo-leon/monterrey/500000001',
    title: 'Bodega industrial en renta — 5,000 m²',
    description: undefined,
    propertyType: 'industrial',
    listingType: 'lease',
    price: { amount: 120000, currency: 'MXN' },
    priceUnit: 'month',
    size: { value: 5000, unit: 'sqm' },
    address: { city: 'Monterrey', state: 'Nuevo León', country: 'MX', formatted: 'Monterrey, Nuevo León' },
    images: [],
    contacts: [],
    listedAt: undefined,
  },
  {
    sourceKey: 'vivanuncios',
    externalId: '600000001',
    sourceUrl: 'https://www.vivanuncios.com.mx/s/ofertas/casas-en-venta/jalisco/guadalajara/600000001',
    title: 'Casa en venta — sin datos completos',
    description: undefined,
    propertyType: 'multifamily',
    listingType: 'sale',
    price: undefined,
    priceUnit: undefined,
    size: undefined,
    address: { city: 'Guadalajara', state: 'Jalisco', country: 'MX', formatted: 'Guadalajara, Jalisco' },
    images: [],
    contacts: [],
    listedAt: undefined,
  },
] as const;

// After dedup: 5 unique (422131234 duplicated, so dropped one copy)
const UNIQUE_EXTERNAL_IDS = [...new Set(EXPECTED_CANDIDATES.map((c) => c.externalId))];
const DUPLICATE_EXTERNAL_ID = '422131234';

// ── Clock ──────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2025-06-01T12:00:00.000Z');
const clock: Clock = { now: () => FIXED_NOW };

// ── Faithful fake repositories ──────────────────────────────────────

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

  async insert(sourceId: string, candidate: import('@cre/shared').ListingCandidate, _now: Date): Promise<string> {
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

  async update(listingId: string, candidate: import('@cre/shared').ListingCandidate, _now: Date): Promise<void> {
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
  readonly recorded: Array<{ listingId: string; sourceUrl: string; observedAt: Date; candidate: import('@cre/shared').ListingCandidate }> = [];
  async record(listingId: string, candidate: import('@cre/shared').ListingCandidate, observedAt: Date): Promise<void> {
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

// ── Harness ────────────────────────────────────────────────────────

function buildHarness(html = FIXTURE_HTML) {
  const source = {
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
  };

  const sources = new FakeSourceRepo(source);
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
    repositories: { sources, listings, observations, crawlRuns } as CrawlerRepositories,
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
    crawl(urls: readonly string[]) {
      return crawler.crawl({ adapter: vivanunciosAdapter, urls });
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Real-source ingestion: Vivanuncios end-to-end', () => {
  it('extracts the expected candidates from the fixture', () => {
    const { candidates, errors } = vivanunciosAdapter.parse(FIXTURE_HTML);

    expect(errors).toEqual([]);
    expect(candidates).toHaveLength(6);

    // Verify each expected candidate exists in the parsed output.
    // For duplicates (same externalId), at least one copy must match.
    for (const expected of EXPECTED_CANDIDATES) {
      const matches = candidates.filter((c) => c.externalId === expected.externalId);
      expect(matches.length).toBeGreaterThanOrEqual(1);

      const hasMatch = matches.some((actual) => {
        if (actual.sourceKey !== expected.sourceKey) return false;
        if (actual.sourceUrl !== expected.sourceUrl) return false;
        if (actual.title !== expected.title) return false;
        if (actual.propertyType !== expected.propertyType) return false;
        if (actual.listingType !== expected.listingType) return false;
        if (expected.price ? actual.price?.amount !== expected.price.amount : actual.price !== undefined) return false;
        if (actual.priceUnit !== expected.priceUnit) return false;
        if (expected.size ? actual.size?.value !== expected.size.value : actual.size !== undefined) return false;
        if (expected.address?.city && actual.address?.city !== expected.address.city) return false;
        if (expected.address?.state && actual.address?.state !== expected.address.state) return false;
        if (expected.description ? actual.description !== expected.description : actual.description !== undefined) return false;
        if (expected.listedAt ? actual.listedAt !== expected.listedAt : actual.listedAt !== undefined) return false;
        return true;
      });

      expect(hasMatch).toBe(true);
    }
  });

  it('measures missing-field rate across parsed candidates', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);

    const withDescription = candidates.filter((c) => c.description !== undefined).length;
    const withPrice = candidates.filter((c) => c.price !== undefined).length;
    const withSize = candidates.filter((c) => c.size !== undefined).length;
    const withListedAt = candidates.filter((c) => c.listedAt !== undefined).length;

    expect(withDescription).toBe(1);
    expect(withPrice).toBe(5);
    expect(withSize).toBe(4);
    expect(withListedAt).toBe(1);

    const total = candidates.length;
    expect(total).toBe(6);

    const missingRate = {
      description: (1 - withDescription / total) * 100,
      price: (1 - withPrice / total) * 100,
      size: (1 - withSize / total) * 100,
      listedAt: (1 - withListedAt / total) * 100,
    };

    expect(missingRate.description).toBeCloseTo(83.3, 0);
    expect(missingRate.price).toBeCloseTo(16.7, 0);
    expect(missingRate.size).toBeCloseTo(33.3, 0);
    expect(missingRate.listedAt).toBeCloseTo(83.3, 0);
  });

  it('inserts new listings, records observations, and completes the run on first crawl', async () => {
    const h = buildHarness();
    const outcome = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    // ── Crawl-run accounting ─────────────────────────────────────
    expect(outcome.status).toBe('completed');
    expect(outcome.pagesFetched).toBe(1);
    expect(outcome.pagesFailed).toBe(0);
    expect(outcome.errors).toEqual([]);

    expect(h.crawlRuns.created).toHaveLength(1);
    expect(h.crawlRuns.finished).toHaveLength(1);
    const accounting = h.crawlRuns.finished[0].accounting;
    expect(accounting.status).toBe('completed');
    expect(accounting.listingsFound).toBe(6);
    expect(accounting.listingsAdded).toBe(5);
    expect(accounting.listingsUpdated).toBe(0);
    expect(accounting.errors).toEqual([]);

    // ── Deduplication: 6 candidates → 5 unique (422131234 appears twice) ──
    expect(outcome.candidatesFound).toBe(6);
    expect(outcome.candidatesDeduped).toBe(1);

    // ── Persistence: 5 inserts, 5 observations ───────────────────
    expect(h.listings.inserts).toBe(5);
    expect(h.listings.updates).toBe(0);
    expect(h.listings.rows).toHaveLength(5);
    expect(h.observations.recorded).toHaveLength(5);

    // ── Normalization spot-checks via observations (candidates round-trip) ──
    const landObs = h.observations.recorded.find((o) => o.candidate.externalId === '419874123')!;
    expect(landObs.candidate.price).toEqual({ amount: 6500000, currency: 'MXN' });
    expect(landObs.candidate.priceUnit).toBe('total');
    expect(landObs.candidate.size).toBeUndefined();
    expect(landObs.candidate.description).toBeUndefined();

    const retailObs = h.observations.recorded.find((o) => o.candidate.externalId === '418002991')!;
    expect(retailObs.candidate.price).toEqual({ amount: 42000, currency: 'MXN' });
    expect(retailObs.candidate.priceUnit).toBe('month');
    expect(retailObs.candidate.size).toEqual({ value: 280, unit: 'sqm' });

    const industrialObs = h.observations.recorded.find((o) => o.candidate.externalId === '500000001')!;
    expect(industrialObs.candidate.price).toEqual({ amount: 120000, currency: 'MXN' });
    expect(industrialObs.candidate.size).toEqual({ value: 5000, unit: 'sqm' });

    const sparseObs = h.observations.recorded.find((o) => o.candidate.externalId === '600000001')!;
    expect(sparseObs.candidate.price).toBeUndefined();
    expect(sparseObs.candidate.size).toBeUndefined();
    expect(sparseObs.candidate.description).toBeUndefined();

    // ── Persisted rows have materialized normalization ────────────
    const landRow = h.listings.rows.find((r) => r.externalId === '419874123')!;
    expect(landRow.priceAmount).toBe('6500000');
    expect(landRow.priceCurrency).toBe('MXN');
    expect(landRow.priceUnit).toBe('total');
    expect(landRow.sizeValue).toBeNull();
    expect(landRow.description).toBeNull();

    const officeRow = h.listings.rows.find((r) => r.externalId === '422131234')!;
    expect(officeRow.fingerprint).toBeTruthy();
    expect(officeRow.title).toBe('Oficina en renta de 2,300 m² en Polanco');
    expect(officeRow.city).toBe('Polanco');
    expect(officeRow.state).toBe('Ciudad de México');
    expect(officeRow.sourceUrl).toBe('https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/ciudad-de-mexico/polanco/422131234');

    // ── Observation provenance ───────────────────────────────────
    const firstObs = h.observations.recorded[0];
    expect(firstObs.listingId).toBe(officeRow.id);
    expect(firstObs.sourceUrl).toBe(officeRow.sourceUrl);
    expect(firstObs.observedAt).toBe(FIXED_NOW);
  });

  it('detects no changes on an identical repeat crawl', async () => {
    const h = buildHarness();

    // First crawl: populate the store.
    const first = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);
    expect(first.status).toBe('completed');
    expect(first.listingsAdded).toBe(5);

    // Reset per-call counters on the fake repo (inserts/updates are cumulative).
    h.listings.inserts = 0;
    h.listings.updates = 0;
    h.observations.recorded = [];

    // Second crawl: identical fixture → all unchanged.
    const second = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/']);

    expect(second.status).toBe('completed');
    expect(second.listingsAdded).toBe(0);
    expect(second.listingsUpdated).toBe(0);
    expect(second.listingsUnchanged).toBe(5);
    expect(second.candidatesDeduped).toBe(1);

    // No canonical mutation.
    expect(h.listings.inserts).toBe(0);
    expect(h.listings.updates).toBe(0);

    // But observations are still recorded (append-only provenance).
    expect(h.observations.recorded).toHaveLength(5);
    expect(h.observations.recorded.map((o) => o.listingId).sort()).toEqual(
      h.listings.rows.map((r) => r.id).sort(),
    );
  });

  it('detects price changes and updates the canonical listing', async () => {
    const h = buildHarness();

    // First crawl: populate the store with original fixture.
    const first = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/bodegas-en-renta/']);
    expect(first.listingsAdded).toBe(5);
    const industrialBefore = h.listings.rows.find((r) => r.externalId === '500000001')!;
    expect(industrialBefore.priceAmount).toBe('120000');
    expect(industrialBefore.version).toBe(1);
    const fingerprintBefore = industrialBefore.fingerprint;

    // Reset per-call counters.
    h.listings.inserts = 0;
    h.listings.updates = 0;
    h.observations.recorded = [];

    // Second crawl with modified fixture: industrial price changed to 150,000.
    const modifiedHtml = FIXTURE_HTML.replace(
      'MXN $ 120,000 /mes',
      'MXN $ 150,000 /mes',
    );
    h.http.body = modifiedHtml;

    const second = await h.crawl(['https://www.vivanuncios.com.mx/s/ofertas/bodegas-en-renta/']);

    expect(second.listingsUpdated).toBe(1);
    expect(second.listingsUnchanged).toBe(4);
    expect(second.listingsAdded).toBe(0);
    expect(h.listings.updates).toBe(1);

    const industrialAfter = h.listings.rows.find((r) => r.externalId === '500000001')!;
    expect(industrialAfter.priceAmount).toBe('150000');
    expect(industrialAfter.version).toBe(2);
    expect(industrialAfter.fingerprint).not.toBe(fingerprintBefore);

    // Observation recorded for the updated listing too.
    expect(h.observations.recorded).toHaveLength(5);
    const updatedObs = h.observations.recorded.find((o) => o.listingId === industrialAfter.id);
    expect(updatedObs).toBeDefined();
  });

  it('records mixed-page failures but still completes with what it captured', async () => {
    const goodHtml = FIXTURE_HTML;
    const brokenHtml = '<html><body><p>error</p></body></html>';

    const bodies = new Map([
      ['https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/', goodHtml],
      ['https://www.vivanuncios.com.mx/s/ofertas/broken-page/', brokenHtml],
    ]);

    const source = {
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
    };

    class PerUrlHttp implements HttpClient {
      readonly requested: string[] = [];
      async get(url: string): Promise<HttpResponse> {
        this.requested.push(url);
        const body = bodies.get(url);
        if (!body) throw new Error(`HTTP 503 for ${url}`);
        return { status: 200, url, body, headers: {} };
      }
    }

    class BlockingRobots implements RobotsChecker {
      async isAllowed(url: string): Promise<{ allowed: boolean; reason: string }> {
        if (url.includes('blocked')) return { allowed: false, reason: 'rules_disallow' };
        return { allowed: true, reason: 'rules_allow' };
      }
    }

    const listings = new FakeListingRepo();
    const observations = new FakeObservationRepo();
    const crawlRuns = new FakeCrawlRunRepo();
    const http = new PerUrlHttp();
    const robots = new BlockingRobots();

    const crawler = new Crawler({
      repositories: { sources: new FakeSourceRepo(source), listings, observations, crawlRuns } as CrawlerRepositories,
      http,
      robots,
      clock,
    });

    const outcome = await crawler.crawl({
      adapter: vivanunciosAdapter,
      urls: [
        'https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/',
        'https://www.vivanuncios.com.mx/s/ofertas/broken-page/',
        'https://www.vivanuncios.com.mx/s/ofertas/blocked-page/',
        'https://inmuebles24.com.mx/s/ofertas/x',
      ],
    });

    // First URL succeeds (good HTML with 6 cards).
    // Second URL succeeds (broken HTML → 0 candidates, but still fetched).
    // Third URL blocked by robots.
    // Fourth URL adapter rejects.
    expect(outcome.pagesFetched).toBe(2);
    expect(outcome.pagesFailed).toBe(2);
    expect(outcome.status).toBe('completed_with_errors');
    expect(outcome.listingsAdded).toBe(5);
    expect(outcome.errors).toHaveLength(3);
    expect(outcome.candidatesFound).toBe(6);
  });

  it('produces stable fingerprints for identical candidates', () => {
    const { candidates } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const first = candidates.find((c) => c.externalId === '422131234')!;

    const fp1 = fingerprintListing(materializedFromCandidate(first));

    // Re-parse to get a fresh candidate with the same data.
    const { candidates: candidates2 } = vivanunciosAdapter.parse(FIXTURE_HTML);
    const first2 = candidates2.find((c) => c.externalId === '422131234')!;
    const fp2 = fingerprintListing(materializedFromCandidate(first2));

    expect(fp1).toBe(fp2);
    expect(fp1).toBeTruthy();
    expect(fp1).toHaveLength(64);
  });
});
