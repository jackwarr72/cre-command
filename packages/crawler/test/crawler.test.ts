import { describe, expect, it } from 'vitest';

import type { AdapterError, SourceAdapter } from '@cre/adapters';
import type { SourceRow } from '@cre/db';
import type { ListingCandidate, RobotsPolicy } from '@cre/shared';

import { Crawler } from '../src/crawl';
import { fingerprintListing, materializedFromCandidate } from '../src/fingerprint';
import { HttpFetchError } from '../src/http';
import type {
  Clock,
  CrawlRunAccounting,
  CrawlRunRepository,
  CrawlerRepositories,
  ExistingListing,
  HttpClient,
  HttpResponse,
  ListingRepository,
  ObservationRepository,
  RobotsChecker,
  RobotsDecisionReason,
  SourceRepository,
} from '../src/ports';

// ── Fakes ────────────────────────────────────────────────────────
// In-memory implementations of the crawler ports, mirroring the Postgres
// semantics the orchestrator relies on: stable identity, fingerprint-based
// change detection, append-only observations, terminal run accounting.

const FIXED_NOW = new Date('2025-06-01T12:00:00.000Z');
const clock: Clock = { now: () => FIXED_NOW };

let sourceSeq = 0;
function makeSource(overrides: Partial<SourceRow> = {}): SourceRow {
  sourceSeq += 1;
  return {
    id: `src-${sourceSeq}`,
    key: 'test-source',
    name: 'Test Source',
    baseUrl: 'https://example.test',
    enabled: true,
    schedule: '0 3 * * *',
    config: {},
    crawlAllowed: true,
    robotsPolicy: 'honor',
    rateLimitMs: 0,
    maxWorkers: 1,
    authenticationRequired: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

let candidateSeq = 0;
function makeCandidate(overrides: Partial<ListingCandidate> = {}): ListingCandidate {
  candidateSeq += 1;
  return {
    sourceKey: 'test-source',
    externalId: `ext-${candidateSeq}`,
    sourceUrl: `https://example.test/l/${candidateSeq}`,
    title: 'Oficina en renta — Polanco',
    propertyType: 'office',
    listingType: 'lease',
    price: { amount: 18500, currency: 'MXN' },
    size: { value: 2300, unit: 'sqm' },
    images: [],
    contacts: [],
    ...overrides,
  };
}

class FakeSources implements SourceRepository {
  constructor(private readonly byKey: Map<string, SourceRow>) {}
  async findByKey(key: string): Promise<SourceRow | null> {
    return this.byKey.get(key) ?? null;
  }
}

interface StoredListing {
  id: string;
  sourceId: string;
  externalId: string;
  fingerprint: string;
  version: number;
}

class FakeListings implements ListingRepository {
  readonly rows: StoredListing[] = [];
  inserts = 0;
  updates = 0;
  constructor(private readonly failExternalIds: ReadonlySet<string> = new Set()) {}

  async findByExternalIds(
    sourceId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, ExistingListing>> {
    const map = new Map<string, ExistingListing>();
    for (const row of this.rows) {
      if (row.sourceId === sourceId && externalIds.includes(row.externalId)) {
        map.set(row.externalId, {
          id: row.id,
          externalId: row.externalId,
          fingerprint: row.fingerprint,
        });
      }
    }
    return map;
  }

  async insert(sourceId: string, candidate: ListingCandidate, _now: Date): Promise<string> {
    this.inserts += 1;
    if (this.failExternalIds.has(candidate.externalId)) {
      throw new Error(`simulated insert failure: ${candidate.externalId}`);
    }
    const row: StoredListing = {
      id: `lst-${this.rows.length + 1}`,
      sourceId,
      externalId: candidate.externalId,
      fingerprint: fingerprintListing(materializedFromCandidate(candidate)),
      version: 1,
    };
    this.rows.push(row);
    return row.id;
  }

  async update(listingId: string, candidate: ListingCandidate, _now: Date): Promise<void> {
    this.updates += 1;
    const row = this.rows.find((r) => r.id === listingId);
    if (!row) throw new Error(`update: unknown listing ${listingId}`);
    row.fingerprint = fingerprintListing(materializedFromCandidate(candidate));
    row.version += 1;
  }
}

class FakeObservations implements ObservationRepository {
  readonly recorded: Array<{ listingId: string; sourceUrl: string; observedAt: Date }> = [];
  async record(listingId: string, candidate: ListingCandidate, observedAt: Date): Promise<void> {
    this.recorded.push({ listingId, sourceUrl: candidate.sourceUrl, observedAt });
  }
}

class FakeCrawlRuns implements CrawlRunRepository {
  readonly created: Array<{ sourceId: string; startedAt: Date }> = [];
  readonly finished: Array<{ runId: string; accounting: CrawlRunAccounting }> = [];
  private seq = 0;
  async create(sourceId: string, startedAt: Date): Promise<string> {
    const runId = `run-${++this.seq}`;
    this.created.push({ sourceId, startedAt });
    return runId;
  }
  async finish(runId: string, accounting: CrawlRunAccounting): Promise<void> {
    this.finished.push({ runId, accounting });
  }
}

class FakeHttp implements HttpClient {
  readonly requested: string[] = [];
  constructor(
    private readonly bodies: Record<string, string> = {},
    private readonly errors: Record<string, Error> = {},
  ) {}
  async get(url: string): Promise<HttpResponse> {
    this.requested.push(url);
    const error = this.errors[url];
    if (error) throw error;
    // Default to a successful (empty) page; tests only stub what they assert on.
    return { status: 200, url, body: this.bodies[url] ?? '', headers: {} };
  }
}

type RobotsDecisionFn = (
  url: string,
  policy: RobotsPolicy,
) => { allowed: boolean; reason: RobotsDecisionReason };

class FakeRobots implements RobotsChecker {
  readonly calls: Array<{ url: string; policy: RobotsPolicy }> = [];
  constructor(private readonly decide?: RobotsDecisionFn) {}
  async isAllowed(url: string, policy: RobotsPolicy) {
    this.calls.push({ url, policy });
    return this.decide?.(url, policy) ?? { allowed: true, reason: 'rules_allow' as const };
  }
}

// ── Harness ──────────────────────────────────────────────────────

interface HarnessOptions {
  source?: SourceRow | null;
  adapter?: SourceAdapter;
  bodies?: Record<string, string>;
  httpErrors?: Record<string, Error>;
  robots?: RobotsDecisionFn;
  failExternalIds?: string[];
}

function harness(options: HarnessOptions = {}) {
  const source = options.source === undefined ? makeSource() : options.source;
  const sources = new FakeSources(
    new Map<string, SourceRow>(source ? [[source.key, source]] : []),
  );
  const listings = new FakeListings(new Set(options.failExternalIds ?? []));
  const observations = new FakeObservations();
  const crawlRuns = new FakeCrawlRuns();
  const http = new FakeHttp(options.bodies ?? {}, options.httpErrors ?? {});
  const robots = new FakeRobots(options.robots);
  // Mutable page so tests can change what the adapter parses between crawls.
  const page: { candidates: ListingCandidate[]; errors: AdapterError[] } = {
    candidates: [],
    errors: [],
  };
  const adapter: SourceAdapter =
    options.adapter ??
    {
      sourceKey: source?.key ?? 'test-source',
      canHandle: (url: string) => url.includes('example.test'),
      parse: () => ({ candidates: page.candidates, errors: page.errors }),
    };

  const crawler = new Crawler({
    repositories: { sources, listings, observations, crawlRuns } satisfies CrawlerRepositories,
    http,
    robots,
    clock,
  });

  return {
    source,
    listings,
    observations,
    crawlRuns,
    http,
    robots,
    page,
    crawl(urls: readonly string[]) {
      return crawler.crawl({ adapter, urls });
    },
  };
}

describe('Crawler — source policy gate', () => {
  it('fails closed when the source is not configured: no run, no fetch', async () => {
    const h = harness({ source: null });
    const outcome = await h.crawl(['https://example.test/l/1']);

    expect(outcome.runId).toBeNull();
    expect(outcome.status).toBe('failed');
    expect(outcome.rejected?.reason).toBe('source_not_found');
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].fatal).toBe(true);
    expect(h.crawlRuns.created).toHaveLength(0);
    expect(h.http.requested).toHaveLength(0);
  });

  it.each([
    ['source_disabled', { enabled: false }],
    ['crawl_not_allowed', { crawlAllowed: false }],
    ['authentication_required', { authenticationRequired: true }],
  ] as const)('cancels without fetching when policy rejects (%s)', async (reason, overrides) => {
    const h = harness({ source: makeSource(overrides) });
    const outcome = await h.crawl(['https://example.test/l/1']);

    expect(outcome.status).toBe('cancelled');
    expect(outcome.rejected?.reason).toBe(reason);
    expect(outcome.pagesFetched).toBe(0);
    expect(h.http.requested).toHaveLength(0);
    expect(h.crawlRuns.created).toHaveLength(1);
    expect(h.crawlRuns.finished).toHaveLength(1);
    expect(h.crawlRuns.finished[0].accounting.status).toBe('cancelled');
    expect(h.crawlRuns.finished[0].accounting.errors[0].fatal).toBe(true);
  });
});

describe('Crawler — crawl pipeline', () => {
  it('inserts new listings, records one observation per record, and completes the run', async () => {
    const h = harness();
    h.page.candidates = [makeCandidate(), makeCandidate()];
    const outcome = await h.crawl(['https://example.test/page/1']);

    expect(outcome.status).toBe('completed');
    expect(outcome.errors).toEqual([]);
    expect(outcome.pagesFetched).toBe(1);
    expect(outcome.candidatesFound).toBe(2);
    expect(outcome.candidatesDeduped).toBe(0);
    expect(outcome.listingsAdded).toBe(2);
    expect(h.listings.rows.map((r) => r.externalId)).toEqual(['ext-1', 'ext-2']);
    expect(h.observations.recorded).toHaveLength(2);
    expect(h.observations.recorded[0]).toMatchObject({
      listingId: h.listings.rows[0].id,
      observedAt: FIXED_NOW,
    });
    expect(h.crawlRuns.finished[0].accounting).toMatchObject({
      status: 'completed',
      listingsFound: 2,
      listingsAdded: 2,
      listingsUpdated: 0,
      errors: [],
    });
  });

  it('never fetches a URL the robots gate disallows', async () => {
    const h = harness({ robots: () => ({ allowed: false, reason: 'rules_disallow' }) });
    const outcome = await h.crawl(['https://example.test/l/1']);

    expect(h.robots.calls).toEqual([{ url: 'https://example.test/l/1', policy: 'honor' }]);
    expect(h.http.requested).toHaveLength(0);
    expect(outcome.pagesFailed).toBe(1);
    expect(outcome.status).toBe('failed');
    expect(outcome.errors[0].message).toContain('rules_disallow');
  });

  it('passes the source robots policy to the robots checker', async () => {
    const h = harness({ source: makeSource({ robotsPolicy: 'strict' }) });
    await h.crawl(['https://example.test/page/1']);
    expect(h.robots.calls[0].policy).toBe('strict');
  });

  it('deduplicates candidates by externalId within a single crawl (first wins)', async () => {
    const first = makeCandidate({ externalId: 'ext-1' });
    const duplicate = makeCandidate({ externalId: 'ext-1', title: 'Duplicated card' });
    const second = makeCandidate({ externalId: 'ext-2' });
    const h = harness();
    h.page.candidates = [first, duplicate, second];

    const outcome = await h.crawl(['https://example.test/page/1']);

    expect(outcome.candidatesFound).toBe(3);
    expect(outcome.candidatesDeduped).toBe(1);
    expect(outcome.listingsAdded).toBe(2);
    expect(h.listings.rows.map((r) => r.externalId)).toEqual(['ext-1', 'ext-2']);
    expect(h.observations.recorded.map((o) => o.sourceUrl)).toEqual([
      first.sourceUrl,
      second.sourceUrl,
    ]);
  });

  it('updates the canonical row only when the fingerprint changes, but observes every crawl', async () => {
    const source = makeSource();
    const pinnedUrl = 'https://example.test/l/ext-1';
    const original = makeCandidate({
      externalId: 'ext-1',
      sourceUrl: pinnedUrl,
      title: 'Original title',
    });
    const repriced = makeCandidate({
      externalId: 'ext-1',
      sourceUrl: pinnedUrl,
      price: { amount: 19999, currency: 'MXN' },
    });
    const reobserved = makeCandidate({
      externalId: 'ext-1',
      sourceUrl: pinnedUrl,
      price: { amount: 19999, currency: 'MXN' },
    });

    const h = harness({ source });
    await h.listings.insert(source.id, original, FIXED_NOW);

    h.page.candidates = [repriced];
    const repricedOutcome = await h.crawl(['https://example.test/page/1']);
    expect(repricedOutcome.listingsUpdated).toBe(1);
    expect(repricedOutcome.listingsUnchanged).toBe(0);
    expect(h.listings.updates).toBe(1);

    h.page.candidates = [reobserved]; // identical to the last persisted state
    const unchangedOutcome = await h.crawl(['https://example.test/page/1']);
    expect(unchangedOutcome.listingsUnchanged).toBe(1);
    expect(unchangedOutcome.listingsUpdated).toBe(0);
    expect(h.listings.updates).toBe(1); // no further canonical mutation

    // Provenance is append-only: every crawl observed the listing, including
    // the unchanged one.
    expect(h.observations.recorded).toHaveLength(2);
  });

  it('records mixed page failures but still completes with what it captured', async () => {
    const h = harness({
      robots: (url) =>
        url.includes('blocked')
          ? { allowed: false, reason: 'rules_disallow' as const }
          : { allowed: true, reason: 'rules_allow' as const },
      httpErrors: {
        'https://example.test/broken': new HttpFetchError('HTTP 503 for …', 503, true),
      },
    });
    h.page.candidates = [makeCandidate()];
    const outcome = await h.crawl([
      'https://example.test/page/1', // ok
      'https://example.test/blocked', // robots
      'https://example.test/broken', // fetch error
      'https://other.test/page', // adapter cannot handle
    ]);

    expect(outcome.pagesFetched).toBe(1);
    expect(outcome.pagesFailed).toBe(3);
    expect(outcome.errors.map((e) => e.url)).toEqual([
      'https://example.test/blocked',
      'https://example.test/broken',
      'https://other.test/page',
    ]);
    expect(outcome.status).toBe('completed_with_errors');
    expect(outcome.listingsAdded).toBe(1);
  });

  it('marks the run failed when nothing was captured', async () => {
    const h = harness({
      httpErrors: { 'https://example.test/page/1': new Error('ECONNRESET') },
    });
    h.page.candidates = [makeCandidate()]; // never parsed
    const outcome = await h.crawl(['https://example.test/page/1']);

    expect(outcome.status).toBe('failed');
    expect(outcome.pagesFailed).toBe(1);
    expect(outcome.candidatesFound).toBe(0);
    expect(h.crawlRuns.finished[0].accounting.status).toBe('failed');
  });

  it('records adapter diagnostics without losing the valid candidates', async () => {
    const h = harness();
    h.page.candidates = [makeCandidate()];
    h.page.errors = [{ message: 'card missing price', context: { index: 3 } }];
    const outcome = await h.crawl(['https://example.test/page/1']);

    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].message).toContain('adapter: card missing price');
    expect(outcome.errors[0].message).toContain('"index":3');
    expect(outcome.status).toBe('completed_with_errors');
    expect(outcome.listingsAdded).toBe(1);
  });

  it('records persistence failures per candidate and keeps persisting the rest', async () => {
    const h = harness({ failExternalIds: ['ext-2'] });
    h.page.candidates = [
      makeCandidate({ externalId: 'ext-1' }),
      makeCandidate({ externalId: 'ext-2' }),
      makeCandidate({ externalId: 'ext-3' }),
    ];
    const outcome = await h.crawl(['https://example.test/page/1']);

    expect(outcome.listingsAdded).toBe(2);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0].message).toContain('persistence failed for ext-2');
    expect(outcome.status).toBe('completed_with_errors');
    expect(h.listings.rows.map((r) => r.externalId)).toEqual(['ext-1', 'ext-3']);
  });
});