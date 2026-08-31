/**
 * @cre/crawler — ports.
 *
 * Every external effect (time, HTTP, robots, persistence) is expressed as an
 * interface here. The crawler core depends only on these ports; production
 * implementations (Drizzle/Postgres, global fetch, live robots.txt) and test
 * fakes plug in from the outside. This keeps the compliance, networking,
 * deduplication, and persistence rules testable without a framework.
 */

import type { CrawlError, CrawlRunStatus, ListingCandidate, RobotsPolicy } from '@cre/shared';
import type { SourceRow } from '@cre/db';

/** Injectable clock — deterministic time in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Minimal response surface the crawler hands to adapters. */
export interface HttpResponse {
  status: number;
  /** Final URL after redirects. */
  url: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * Transport port. Implementations own timeouts, response size caps, bounded
 * retries, and rate limiting — parsing never happens here, and no fetch is
 * ever attempted before the policy and robots gates allow it.
 */
export interface HttpClient {
  get(url: string): Promise<HttpResponse>;
}

/** Why a robots decision was reached (recorded for audit). */
export type RobotsDecisionReason =
  /** policy=allow: the operator pre-authorized crawling; robots is not consulted. */
  | 'policy_allow'
  /** robots.txt (or its absence, per RFC 9309) permits the path. */
  | 'rules_allow'
  /** robots.txt disallows the path. */
  | 'rules_disallow'
  /** strict policy + no robots.txt → fail closed. */
  | 'robots_missing_strict'
  /** robots.txt unreachable/malformed → fail closed. */
  | 'robots_unavailable';

export interface RobotsDecision {
  allowed: boolean;
  reason: RobotsDecisionReason;
}

export interface RobotsChecker {
  isAllowed(url: string, policy: RobotsPolicy): Promise<RobotsDecision>;
}

/** Politeness port; create one instance per source. */
export interface RateLimiter {
  /**
   * Resolves when the caller may proceed. Successive resolutions are
   * separated by at least the configured interval.
   */
  acquire(): Promise<void>;
}

/** Canonical listing as currently persisted (identity + change-detection state). */
export interface ExistingListing {
  id: string;
  externalId: string;
  /** Stable fingerprint of the materialized columns. */
  fingerprint: string;
}

export interface ListingRepository {
  findByExternalIds(
    sourceId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, ExistingListing>>;
  /** Inserts a canonical listing; returns its id. */
  insert(sourceId: string, candidate: ListingCandidate, now: Date): Promise<string>;
  /** Materializes candidate fields onto an existing listing. */
  update(listingId: string, candidate: ListingCandidate, now: Date): Promise<void>;
}

export interface ObservationRepository {
  /**
   * Appends one raw observation. The provenance audit trail is append-only:
   * historical observations are never overwritten when a listing changes.
   */
  record(listingId: string, candidate: ListingCandidate, observedAt: Date): Promise<void>;
}

export interface CrawlRunAccounting {
  status: CrawlRunStatus;
  finishedAt: Date;
  listingsFound: number;
  listingsAdded: number;
  listingsUpdated: number;
  errors: CrawlError[];
}

export interface CrawlRunRepository {
  /** Opens a run (status `running`, `startedAt` stamped) and returns its id. */
  create(sourceId: string, startedAt: Date): Promise<string>;
  /** Closes a run with terminal accounting. */
  finish(runId: string, accounting: CrawlRunAccounting): Promise<void>;
}

export interface SourceRepository {
  findByKey(key: string): Promise<SourceRow | null>;
}

export interface CrawlerRepositories {
  sources: SourceRepository;
  listings: ListingRepository;
  observations: ObservationRepository;
  crawlRuns: CrawlRunRepository;
}
