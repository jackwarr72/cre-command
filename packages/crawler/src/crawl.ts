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
import type { CrawlError, CrawlRunStatus, ListingCandidate } from '@cre/shared';
import { fingerprintListing, materializedFromCandidate } from './fingerprint';
import { canCrawl, type CrawlDecision } from './policy';
import {
  systemClock,
  type Clock,
  type CrawlerRepositories,
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

export class Crawler {
  constructor(private readonly options: CrawlerOptions) {}

  async crawl(request: CrawlRequest): Promise<CrawlOutcome> {
    const clock = this.options.clock ?? systemClock;
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
        return {
          runId: null,
          status: 'failed',
          rejected: decision,
          ...ZEROED_COUNTS,
          errors: [
            {
              message: decision.message,
              retries: 0,
              fatal: true,
              at: clock.now().toISOString(),
            },
          ],
        };
      }
      const runId = await repos.crawlRuns.create(source.id, clock.now());
      recordError(`${decision.reason}: ${decision.message}`, undefined, true);
      await repos.crawlRuns.finish(runId, {
        status: 'cancelled',
        finishedAt: clock.now(),
        listingsFound: 0,
        listingsAdded: 0,
        listingsUpdated: 0,
        errors,
      });
      return { runId, status: 'cancelled', rejected: decision, ...ZEROED_COUNTS, errors };
    }

    const runId = await repos.crawlRuns.create(source.id, clock.now());
    return this.runPipeline(request, source, runId, clock, recordError, errors);
  }

  /** Fetch → parse → dedup → persist → account. Runs only after the policy gate. */
  private async runPipeline(
    request: CrawlRequest,
    source: SourceRow,
    runId: string,
    clock: Clock,
    recordError: (message: string, url?: string, fatal?: boolean) => void,
    errors: CrawlError[],
  ): Promise<CrawlOutcome> {
    // ── Fetch phase: adapter guard + robots gate + bounded transport ──
    const candidates: ListingCandidate[] = [];
    let pagesFetched = 0;
    let pagesFailed = 0;

    for (const url of request.urls) {
      if (!request.adapter.canHandle(url)) {
        recordError(`adapter ${request.adapter.sourceKey} cannot handle ${url}`, url);
        pagesFailed++;
        continue;
      }
      const robotsDecision = await this.options.robots.isAllowed(url, source.robotsPolicy);
      if (!robotsDecision.allowed) {
        recordError(
          `robots policy (${source.robotsPolicy}) disallows fetch: ${robotsDecision.reason}`,
          url,
        );
        pagesFailed++;
        continue;
      }
      let body: string;
      try {
        body = (await this.options.http.get(url)).body;
      } catch (error) {
        recordError(
          `fetch failed: ${error instanceof Error ? error.message : String(error)}`,
          url,
        );
        pagesFailed++;
        continue;
      }
      pagesFetched++;
      const parsed = request.adapter.parse(body);
      candidates.push(...parsed.candidates);
      for (const adapterError of parsed.errors) {
        const suffix = adapterError.context ? ` (${JSON.stringify(adapterError.context)})` : '';
        recordError(`adapter: ${adapterError.message}${suffix}`, url);
      }
    }

    // ── Deduplication within the crawl: same source identity groups together ──
    const byExternalId = new Map<string, ListingCandidate>();
    let deduped = 0;
    for (const candidate of candidates) {
      if (byExternalId.has(candidate.externalId)) {
        deduped++;
        continue;
      }
      byExternalId.set(candidate.externalId, candidate);
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
            continue;
          }
          const fingerprint = fingerprintListing(materializedFromCandidate(candidate));
          if (fingerprint !== prior.fingerprint) {
            await this.options.repositories.listings.update(prior.id, candidate, now);
            await this.options.repositories.observations.record(prior.id, candidate, now);
            updated++;
          } else {
            // Unchanged: no canonical mutation — but still observed, because
            // provenance is an append-only log.
            await this.options.repositories.observations.record(prior.id, candidate, now);
            unchanged++;
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
    await this.options.repositories.crawlRuns.finish(runId, {
      status,
      finishedAt: clock.now(),
      listingsFound,
      listingsAdded: added,
      listingsUpdated: updated,
      errors,
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
    };
  }
}
