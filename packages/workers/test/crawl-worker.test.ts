import { describe, expect, it, vi } from 'vitest';

import { AdapterRegistry, Crawler, type Clock, type CrawlerRepositories, type HttpClient, type RobotsChecker, type SourceRepository } from '@cre/crawler';
import type { HttpResponse } from '@cre/crawler';
import type { SourceRow } from '@cre/db';
import type { ListingCandidate } from '@cre/shared';

import { CrawlJobHandler, type CrawlJobPayload } from '../src/crawlJob';
import { CrawlWorker } from '../src/crawlWorker';
import { InMemoryJobQueue } from '../src/inMemoryQueue';

/**
 * Unit tests for the worker mechanics:
 * - the poll loop contract (pop -> mark -> handle -> complete/fail),
 * - CrawlJobHandler orchestration end-to-end through the real crawler engine,
 *   wired to in-memory fake repositories (no DB, no network).
 */

function makeJob(overrides: Partial<CrawlJobPayload> = {}): CrawlJobPayload {
  return {
    jobId: `outbox-${Math.random().toString(36).slice(2)}`,
    crawlRunId: `run-${Math.random().toString(36).slice(2)}`,
    sourceId: 'src-1',
    ...overrides,
  };
}

const db = {} as import('@cre/db').Database;
const emptyRegistry = { get: () => undefined } as unknown as AdapterRegistry;

/** Test seam: CrawlWorker builds its own handler; tests inject a spy. */
function makeLoopWorker(opts: {
  queue: InMemoryJobQueue<CrawlJobPayload>;
  handler: (job: CrawlJobPayload) => Promise<void>;
}): CrawlWorker { return new CrawlWorker({ db, adapterRegistry: emptyRegistry, queue: opts.queue, handler: { handle: opts.handler } }); }

describe('CrawlWorker loop', () => {
  it('pops, marks, handles, and completes pending jobs', async () => {
    const queue = new InMemoryJobQueue<CrawlJobPayload>();
    const jobA = makeJob();
    const jobB = makeJob();
    queue.push(jobA);
    queue.push(jobB);

    const handled: CrawlJobPayload[] = [];
    const handler = vi.fn(async (job: CrawlJobPayload) => {
      handled.push(job);
    });

    const worker = makeLoopWorker({ queue, handler });
    await worker.runOnce();

    expect(handled).toEqual([jobA, jobB]);
    const statusOf = (jobId: string) =>
      queue.getAll().find((entry) => (entry.payload as CrawlJobPayload).jobId === jobId)?.status;
    expect(statusOf(jobA.jobId)).toBe('completed');
    expect(statusOf(jobB.jobId)).toBe('completed');
  });

  it('fails the failed job and keeps processing the rest of the batch', async () => {
    const queue = new InMemoryJobQueue<CrawlJobPayload>();
    const bad = makeJob();
    const good = makeJob();
    queue.push(bad);
    queue.push(good);

    const handler = vi.fn(async (job: CrawlJobPayload) => {
      if (job.jobId === bad.jobId) throw new Error('boom');
    });

    const worker = makeLoopWorker({ queue, handler });
    await worker.runOnce();

    const statusOf = (jobId: string) =>
      queue.getAll().find((entry) => (entry.payload as CrawlJobPayload).jobId === jobId)?.status;
    expect(statusOf(bad.jobId)).toBe('failed');
    expect(statusOf(good.jobId)).toBe('completed');
  });

  it('returns 0 without touching the handler when the queue is empty', async () => {
    const queue = new InMemoryJobQueue<CrawlJobPayload>();
    const handler = vi.fn(async () => undefined);
    const worker = makeLoopWorker({ queue, handler });

    await expect(worker.runOnce()).resolves.toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---- Handler orchestration through the real engine (fakes, no I/O) ----

const SOURCE: SourceRow = {
  id: 'src-1',
  key: 'vivanuncios_metepec',
  name: 'Vivanuncios Metepec',
  baseUrl: 'https://www.vivanuncios.com.mx',
  enabled: true,
  schedule: '0 3 * * *',
  config: {},
  crawlAllowed: true,
  robotsPolicy: 'allow',
  rateLimitMs: 0,
  maxWorkers: 1,
  authenticationRequired: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as SourceRow;

const CANDIDATE: ListingCandidate = {
  sourceKey: 'vivanuncios_metepec',
  externalId: 'ext-1',
  sourceUrl: 'https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/metepec/1',
  title: 'Oficina en renta Metepec',
  propertyType: 'office',
  listingType: 'lease',
  images: [],
  contacts: [],
};

class FakeSources implements SourceRepository {
  constructor(private readonly row: SourceRow | null) {}
  async findByKey(key: string): Promise<SourceRow | null> {
    return this.row && this.row.key === key ? this.row : null;
  }
  async findById(id: string): Promise<SourceRow | null> {
    return this.row && this.row.id === id ? this.row : null;
  }
}

class MissingSources implements SourceRepository {
  async findByKey(): Promise<SourceRow | null> {
    return null;
  }
  async findById(): Promise<SourceRow | null> {
    return null;
  }
}

class MissingCrawlRuns {
  async findById() {
    return null;
  }
}

class MissingListings {
  async findByExternalIds() {
    return new Map();
  }
}

class MissingObservations {
  async record() {}
}

class FakeCrawlRuns {
  claimedWith: string | null = null;
  finished: Array<{ runId: string; status: string; listingsAdded: number }> = [];
  constructor(
    private readonly run: { id: string; status: 'queued'; urls: string[] },
  ) {}
  async findById(runId: string) {
    return this.run.id === runId ? { ...this.run } : null;
  }
  async claimForExecution(runId: string, workerId: string) {
    if (this.run.id !== runId) return { status: 'not_found' as const };
    if (this.run.status !== 'queued') return { status: 'already_terminal' as const };
    this.run.status = 'running' as never;
    this.claimedWith = workerId;
    return { status: 'claimed' as const };
  }
  async finish(runId: string, accounting: { status: string; listingsAdded: number }) {
    this.finished.push({ runId, status: accounting.status, listingsAdded: accounting.listingsAdded });
  }
}

class FakeListings {
  inserts: string[] = [];
  async findByExternalIds() {
    return new Map();
  }
  async insert(_sourceId: string, candidate: ListingCandidate) {
    this.inserts.push(candidate.externalId);
    return 'lst-1';
  }
  async update() {}
}

class FakeObservations {
  recorded = 0;
  async record() {
    this.recorded += 1;
  }
}

describe('CrawlJobHandler orchestration', () => {
  it('resolves the source by id, claims the run, and executes the engine (outbox close is the worker loop\u2019s job)', async () => {
    const run = { id: 'run-1', status: 'queued' as const, urls: ['https://www.vivanuncios.com.mx/s-oficinas-en-renta/metepec-toluca/v1c9l2p1'] };
    const sources = new FakeSources(SOURCE);
    const crawlRuns = new FakeCrawlRuns(run);
    const listings = new FakeListings();
    const observations = new FakeObservations();

    const repositories: CrawlerRepositories = {
      sources,
      crawlRuns: crawlRuns as unknown as CrawlerRepositories['crawlRuns'],
      listings: listings as unknown as CrawlerRepositories['listings'],
      observations: observations as unknown as CrawlerRepositories['observations'],
    };

    const http: HttpClient = {
      async get(url: string): Promise<HttpResponse> {
        return { status: 200, url, body: '<html></html>', headers: {} };
      },
    };
    const robots: RobotsChecker = {
      async isAllowed() {
        return { allowed: true, reason: 'policy_allow' as const };
      },
    };
    const crawler = new Crawler({
      repositories,
      http,
      robots,
      clock: { now: () => new Date(0) } as Clock,
    });

    const adapter = {
      sourceKey: 'vivanuncios_metepec',
      canHandle: () => true,
      parse: () => ({ candidates: [CANDIDATE], errors: [] }),
    };
    const registry = { get: () => adapter } as unknown as AdapterRegistry;

    const handler = new CrawlJobHandler(db, registry, crawler);
    const job = makeJob({ crawlRunId: 'run-1', sourceId: 'src-1' });

    await expect(handler.handle(job)).resolves.toBeUndefined();

    // The run was claimed and finished as completed with the listing persisted.
    expect(crawlRuns.claimedWith).toMatch(/^worker-/);
    expect(crawlRuns.finished).toEqual([{ runId: 'run-1', status: 'completed', listingsAdded: 1 }]);
    expect(listings.inserts).toEqual(['ext-1']);
    expect(observations.recorded).toBe(1);
  });

  it('throws for an unknown source so the worker loop fails the right outbox record', async () => {
    const missingRepositories = {
      sources: new MissingSources(),
      crawlRuns: new MissingCrawlRuns(),
      listings: new MissingListings(),
      observations: new MissingObservations(),
    } as unknown as CrawlerRepositories;
    // Repositories-only injection: no engine construction, no network clients —
    // the lookup throws Source … not found before any crawl work starts.
    const handler = new CrawlJobHandler(db, emptyRegistry, undefined, missingRepositories);
    const job = makeJob({ crawlRunId: 'run-x', sourceId: 'missing-source' });

    await expect(handler.handle(job)).rejects.toThrow('Source missing-source not found');
  });

  it('worker loop fails the outbox record by jobId when the handler throws', async () => {
    const failQueue = new InMemoryJobQueue<CrawlJobPayload>();
    const failJob = makeJob({ crawlRunId: 'run-x', sourceId: 'missing-source' });
    failQueue.push(failJob);

    const missingRepositories = {
      sources: new MissingSources(),
      crawlRuns: new MissingCrawlRuns(),
      listings: new MissingListings(),
      observations: new MissingObservations(),
    } as unknown as CrawlerRepositories;
    const failHandler = new CrawlJobHandler(db, emptyRegistry, undefined, missingRepositories);
    const failWorker = makeLoopWorker({ queue: failQueue, handler: (j) => failHandler.handle(j) });

    await expect(failWorker.runOnce()).resolves.toBe(1);
    const entry = failQueue.getAll().find((e) => (e.payload as CrawlJobPayload).jobId === failJob.jobId);
    expect(entry?.status).toBe('failed');
    expect(entry?.lastError).toContain('Source missing-source not found');
  });
});