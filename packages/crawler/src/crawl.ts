/**
 * @cre/crawler — orchestration.
 *
 * The policy + orchestration boundary between adapters and the database:
 *
 *   source configuration → canCrawl (fail closed)
 *     → robots gate (per URL, fail closed)
 *       → HTTP fetch (bounded transport)
 *         → SourceAdapter.parse → validated ListingCandidate[]
 *           → in-crawl dedup by (source, externalId)
 *             → canonical insert/update/unchanged + observation per record
 *               → crawl_run accounting (completed | completed_with_errors | failed)
 *
 * Provenance is append-only: every observed record leaves an observation,
 * including unchanged ones; historical observations are never rewritten.
 */

import type { SourceAdapter } from '@cre/adapters';
import type { SourceRow } from '@cre/db';
import type { CrawlError, CrawlRunMetrics, CrawlRunStatus, ListingCandidate } from '@cre/shared';
import { fingerprintListing, materializedFromCandidate } from './fingerprint';
import { canCrawl, type CrawlDecision } from './policy';
import {
  systemClock,
  type Clock,
  type CrawlerRepositories,
  type HttpClient,
  type RobotsChecker,
} from './ports';

export interface CrawlerOptions {
  repositories: CrawlerRepositories;
  http: import('./ports').HttpClient;
  robots: RobotsChecker;
  clock?: Clock;
}

export interface CrawlRequest {
  adapter: SourceAdapter;
  /** Entry-point URLs to fetch and parse (typically from source config). */
  urls: readonly string[];
}

export interface CrawlOutcome {
  runId: string | null;
  status: CrawlRunStatus;
  /** Present when policy rejected the crawl before any fetch. */
  rejected?: CrawlDecision;
  pagesFetched: number;
  pagesFailed: number;
  /** Records observed at the source, including in-crawl duplicates. */
  candidatesFound: number;
  candidatesDeduped: number;
  listingsAdded: number;
  listingsUpdated: number;
  listingsUnchanged: number;
  errors: CrawlError[];
  /** Extended ingestion metrics persisted with the crawl run. */
  metrics?: CrawlRunMetrics;
}

const ZEROED_COUNTS = {
  pagesFetched: 0,
  pagesFailed: 0,
  candidatesFound: 0,
  candidatesDeduped: 0,
  listingsAdded: 0,
  listingsUpdated: 0,
  listingsUnchanged: 0,
};

function zeroedMetrics(): CrawlRunMetrics {
  return {
    runId: '',
    status: 'queued',
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    listingsDiscovered: 0,
    listingsAccepted: 0,
    listingsRejected: 0,
    duplicateCandidates: 0,
    listingsCreated: 0,
    listingsUpdated: 0,
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
    errors: [],
  };
}

export class Crawler {
  constructor(private readonly options: CrawlerOptions) {}

  async crawl(request: CrawlRequest): Promise<CrawlOutcome> {
    const clock = this.options.clock ?? systemClock;
    const startedAt = clock.now();
    const repos = this.options.repositories;
    const errors: CrawlError[] = [];
    const recordError = (message: string, url?: string, fatal = false): void => {
      const entry: CrawlError = { message, url, retries: 0, at: clock.now().toISOString() };
      if (fatal) entry.fatal = true;
      errors.push(entry);
    };

    // ── Policy gate (fail closed, before anything else) ──
    const source: SourceRow | null = await repos.sources.findByKey(request.adapter.sourceKey);
    const decision = canCrawl(source);

    if (!decision.allowed || !source) {
      if (!source) {
        // No source row → nothing to attach a run to; fail loudly, fetch nothing.
        const metrics = zeroedMetrics();
        metrics.status = 'failed';
        metrics.errors = [
          {
            message: decision.message,
            retries: 0,
            fatal: true,
            at: clock.now().toISOString(),
          },
        ];
        return {
          runId: null,
          status: 'failed',
          rejected: decision,
          ...ZEROED_COUNTS,
          errors: metrics.errors,
          metrics,
        };
      }
      const runId = await repos.crawlRuns.create(source.id, clock.now());
      recordError(`${decision.reason}: ${decision.message}`, undefined, true);
      const metrics = zeroedMetrics();
      metrics.status = 'cancelled';
      metrics.runId = runId;
      metrics.errors = errors;
      metrics.startedAt = startedAt.toISOString();
      metrics.finishedAt = clock.now().toISOString();
      await repos.crawlRuns.finish(runId, {
        status: 'cancelled',
        finishedAt: clock.now(),
        listingsFound: 0,
        listingsAdded: 0,
        listingsUpdated: 0,
        errors,
        metrics,
      });
      return { runId, status: 'cancelled', rejected: decision, ...ZEROED_COUNTS, errors, metrics };
    }

    const runId = await repos.crawlRuns.create(source.id, clock.now());
    return this.runPipeline(request, source, runId, clock, startedAt, recordError, errors);
  }

  /** Fetch → parse → dedup → persist → account. Runs only after the policy gate. */
  private async runPipeline(
    request: CrawlRequest,
    source: SourceRow,
    runId: string,
    clock: Clock,
    startedAt: Date,
    recordError: (message: string, url?: string, fatal?: boolean) => void,
    errors: CrawlError[],
  ): Promise<CrawlOutcome> {
    // ── Metrics accumulator ──
    const m = zeroedMetrics();
    m.runId = runId;
    m.startedAt = startedAt.toISOString();

    // ── Fetch phase: adapter guard + robots gate + bounded transport ──
    const candidates: ListingCandidate[] = [];
    let pagesFetched = 0;
    let pagesFailed = 0;

    for (const url of request.urls) {
      m.pagesAttempted++;
      if (!request.adapter.canHandle(url)) {
        recordError(`adapter ${request.adapter.sourceKey} cannot handle ${url}`, url);
        pagesFailed++;
        m.pagesFailed++;
        continue;
      }
      const robotsDecision = await this.options.robots.isAllowed(url, source.robotsPolicy);
      if (!robotsDecision.allowed) {
        recordError(
          `robots policy (${source.robotsPolicy}) disallows fetch: ${robotsDecision.reason}`,
          url,
        );
        pagesFailed++;
        m.pagesFailed++;
        m.robotsDenials++;
        continue;
      }
      let body: string;
      const startTs = Date.now();
      let response: Awaited<ReturnType<HttpClient['get']>>;
      try {
        response = await this.options.http.get(url);
        const latency = Date.now() - startTs;
        m.requestCount++;
        m.totalLatencyMs += latency;
        m.maxLatencyMs = Math.max(m.maxLatencyMs, latency);
        if (m.latencySamplesMs.length < 1000) {
          m.latencySamplesMs.push(latency);
        }
        m.bytesDownloaded += response.body.length;
        const statusKey = String(response.status);
        m.httpStatusCounts[statusKey] = (m.httpStatusCounts[statusKey] ?? 0) + 1;
        if (response.retries) m.retryCount += response.retries;
      } catch (error) {
        const latency = Date.now() - startTs;
        m.requestCount++;
        m.totalLatencyMs += latency;
        m.maxLatencyMs = Math.max(m.maxLatencyMs, latency);
        if (m.latencySamplesMs.length < 1000) {
          m.latencySamplesMs.push(latency);
        }
        recordError(
          `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          url,
        );
        pagesFailed++;
        m.pagesFailed++;
        m.httpErrors++;
        continue;
      }
      pagesFetched++;
      m.pagesSucceeded++;
      const parsed = request.adapter.parse(response.body);
      m.cardsSeen += parsed.candidates.length + parsed.errors.length;
      m.cardsParsed += parsed.candidates.length;
      m.cardsRejected += parsed.errors.length;
      for (const candidate of parsed.candidates) {
        candidates.push(candidate);
        m.listingsDiscovered++;
        m.listingsRejected++;
        if (candidate.title) m.candidatesWithTitle++;
        if (candidate.price) m.candidatesWithPrice++;
        if (candidate.address) m.candidatesWithAddress++;
        if (candidate.size) m.candidatesWithSize++;
        if (candidate.propertyType) m.candidatesWithPropertyType++;
      }
      for (const adapterError of parsed.errors) {
        const suffix = adapterError.context ? ` (${JSON.stringify(adapterError.context)})` : '';
        recordError(`adapter: ${adapterError.message}${suffix}`, url);
        m.parseErrors++;
      }
    }

    // ── Deduplication within the crawl: same source identity groups together ──
    const byExternalId = new Map<string, ListingCandidate>();
    let deduped = 0;
    for (const candidate of candidates) {
      if (byExternalId.has(candidate.externalId)) {
        deduped++;
        m.duplicateCandidates++;
        continue;
      }
      byExternalId.set(candidate.externalId, candidate);
      m.listingsRejected--; // this candidate was accepted (not rejected)
      m.listingsAccepted++;
    }
    const unique = [...byExternalId.values()];

    // ── Persistence: canonical listing + observation for every observed record ──
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    if (unique.length > 0) {
      const now = clock.now();
      const existing = await this.options.repositories.listings.findByExternalIds(
        source.id,
        unique.map((candidate) => candidate.externalId),
      );
      for (const candidate of unique) {
        const prior = existing.get(candidate.externalId);
        try {
          if (!prior) {
            const listingId = await this.options.repositories.listings.insert(
              source.id,
              candidate,
              now,
            );
            await this.options.repositories.observations.record(listingId, candidate, now);
            added++;
            m.listingsCreated++;
            m.observationsInserted++;
            continue;
          }
          const fingerprint = fingerprintListing(materializedFromCandidate(candidate));
          if (fingerprint !== prior.fingerprint) {
            await this.options.repositories.listings.update(prior.id, candidate, now);
            await this.options.repositories.observations.record(prior.id, candidate, now);
            updated++;
            m.listingsUpdated++;
            m.observationsInserted++;
          } else {
            await this.options.repositories.observations.record(prior.id, candidate, now);
            unchanged++;
            m.listingsUnchanged++;
            m.observationsInserted++;
          }
        } catch (error) {
          recordError(
            `persistence failed for ${candidate.externalId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            candidate.sourceUrl,
          );
        }
      }
    }

    // ── Terminal status: failures must never read as clean success ──
    const listingsFound = candidates.length;
    const status: CrawlRunStatus =
      errors.length === 0 ? 'completed' : listingsFound > 0 ? 'completed_with_errors' : 'failed';
    m.status = status;
    m.finishedAt = clock.now().toISOString();
    m.pagesSucceeded = pagesFetched;
    m.pagesFailed = pagesFailed;
    m.errors = errors;
    await this.options.repositories.crawlRuns.finish(runId, {
      status,
      finishedAt: clock.now(),
      listingsFound,
      listingsAdded: added,
      listingsUpdated: updated,
      errors,
      metrics: m,
    });

    return {
      runId,
      status,
      pagesFetched,
      pagesFailed,
      candidatesFound: listingsFound,
      candidatesDeduped: deduped,
      listingsAdded: added,
      listingsUpdated: updated,
      listingsUnchanged: unchanged,
      errors,
      metrics: m,
    };
  }
}
