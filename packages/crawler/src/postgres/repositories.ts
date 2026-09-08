/**
 * @cre/crawler — production repository implementations (Drizzle/Postgres).
 *
 * These are the only places where the crawler core touches Postgres. Row ↔
 * candidate mapping and fingerprint computation live here so the orchestration
 * core stays persistence-agnostic.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { crawlRuns, listingObservations, listings, sources } from '@cre/db';
import type { CrawlRunRow, Database, ListingRow, SourceRow } from '@cre/db';
import type { ListingCandidate } from '@cre/shared';
import { fingerprintListing, materializedFromRow } from '../fingerprint';
import type {
  CrawlRunAccounting,
  CrawlRunRepository,
  CrawlerRepositories,
  ExistingListing,
  ListingRepository,
  ObservationRepository,
  SourceRepository,
} from '../ports';

export class PgSourceRepository implements SourceRepository {
  constructor(private readonly db: Database) {}

  async findByKey(key: string): Promise<SourceRow | null> {
    const rows = await this.db.select().from(sources).where(eq(sources.key, key)).limit(1);
    return rows[0] ?? null;
  }
}

/** Candidate → materialized listing columns (shared by insert and update). */
function candidateColumns(candidate: ListingCandidate) {
  return {
    sourceUrl: candidate.sourceUrl,
    title: candidate.title,
    description: candidate.description ?? null,
    propertyType: candidate.propertyType,
    listingType: candidate.listingType,
    streetAddress: candidate.address?.streetAddress ?? null,
    city: candidate.address?.city ?? null,
    state: candidate.address?.state ?? null,
    postalCode: candidate.address?.postalCode ?? null,
    country: candidate.address?.country ?? 'MX',
    formattedAddress: candidate.address?.formatted ?? null,
    lat: candidate.geo ? String(candidate.geo.lat) : null,
    lng: candidate.geo ? String(candidate.geo.lng) : null,
    priceAmount: candidate.price ? String(candidate.price.amount) : null,
    priceCurrency: candidate.price?.currency ?? null,
    priceUnit: candidate.priceUnit ?? null,
    sizeValue: candidate.size ? String(candidate.size.value) : null,
    sizeUnit: candidate.size?.unit ?? null,
    lotSizeValue: candidate.lotSize ? String(candidate.lotSize.value) : null,
    lotSizeUnit: candidate.lotSize?.unit ?? null,
    yearBuilt: candidate.yearBuilt ?? null,
    unitCount: candidate.unitCount ?? null,
    listedAt: candidate.listedAt ? new Date(candidate.listedAt) : null,
    raw: { ...candidate } as Record<string, unknown>,
  };
}

export class PgListingRepository implements ListingRepository {
  constructor(private readonly db: Database) {}

  async findByExternalIds(
    sourceId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, ExistingListing>> {
    const map = new Map<string, ExistingListing>();
    if (externalIds.length === 0) return map;
    const rows = await this.db
      .select()
      .from(listings)
      .where(and(eq(listings.sourceId, sourceId), inArray(listings.externalId, [...externalIds])));
    for (const row of rows) {
      map.set(row.externalId, {
        id: row.id,
        externalId: row.externalId,
        fingerprint: fingerprintListing(materializedFromRow(row)),
      });
    }
    return map;
  }

  async insert(sourceId: string, candidate: ListingCandidate, now: Date): Promise<string> {
    const rows = await this.db
      .insert(listings)
      .values({
        sourceId,
        externalId: candidate.externalId,
        ...candidateColumns(candidate),
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: listings.id });
    const row = rows[0];
    if (!row) throw new Error('listing insert returned no id');
    return row.id;
  }

  async update(listingId: string, candidate: ListingCandidate, now: Date): Promise<void> {
    await this.db
      .update(listings)
      .set({
        ...candidateColumns(candidate),
        lastSeenAt: now,
        updatedAt: now,
        version: sql`${listings.version} + 1`,
      })
      .where(eq(listings.id, listingId));
  }
}

export class PgObservationRepository implements ObservationRepository {
  constructor(private readonly db: Database) {}

  async record(listingId: string, candidate: ListingCandidate, observedAt: Date): Promise<void> {
    await this.db.insert(listingObservations).values({
      listingId,
      observedAt,
      sourceUrl: candidate.sourceUrl,
      raw: { ...candidate } as Record<string, unknown>,
    });
  }
}

export class PgCrawlRunRepository implements CrawlRunRepository {
  constructor(private readonly db: Database) {}

  async create(sourceId: string, startedAt: Date): Promise<string> {
    const rows = await this.db
      .insert(crawlRuns)
      .values({ sourceId, status: 'running', startedAt })
      .returning({ id: crawlRuns.id });
    const row = rows[0];
    if (!row) throw new Error('crawl run insert returned no id');
    return row.id;
  }

  async createQueued(input: {
    sourceId: string;
    requestedAt: Date;
    requestedByUserId: string | null;
    urls: readonly string[];
  }): Promise<string> {
    const rows = await this.db
      .insert(crawlRuns)
      .values({
        sourceId: input.sourceId,
        status: 'queued',
        startedAt: input.requestedAt,
        requestedByUserId: input.requestedByUserId,
        urls: [...input.urls],
      })
      .returning({ id: crawlRuns.id });
    const row = rows[0];
    if (!row) throw new Error('crawl run insert returned no id');
    return row.id;
  }

  async claimForExecution(
    runId: string,
    workerId: string,
    startedAt: Date,
  ): Promise<
    | { status: 'claimed' }
    | { status: 'already_running' }
    | { status: 'already_terminal' }
    | { status: 'not_found' }
  > {
    const rows = await this.db
      .update(crawlRuns)
      .set({
        status: 'running',
        startedAt,
        workerId,
      })
      .where(
        and(eq(crawlRuns.id, runId), eq(crawlRuns.status, 'queued')),
      )
      .returning({ id: crawlRuns.id });

    if (rows.length === 0) {
      // Check if it exists but is already terminal or running
      const existing = await this.db
        .select({ id: crawlRuns.id, status: crawlRuns.status })
        .from(crawlRuns)
        .where(eq(crawlRuns.id, runId))
        .limit(1);
      if (existing.length === 0) return { status: 'not_found' };
      return existing[0]!.status === 'running'
        ? { status: 'already_running' }
        : { status: 'already_terminal' };
    }
    return { status: 'claimed' };
  }

  async finish(runId: string, accounting: CrawlRunAccounting): Promise<void> {
    await this.db
      .update(crawlRuns)
      .set({
        status: accounting.status,
        finishedAt: accounting.finishedAt,
        listingsFound: accounting.listingsFound,
        listingsAdded: accounting.listingsAdded,
        listingsUpdated: accounting.listingsUpdated,
        errors: accounting.errors,
        metrics: accounting.metrics,
      })
      .where(eq(crawlRuns.id, runId));
  }
}

/** Wiring helper for production composition roots (API, workers, CLI). */
export function createPostgresRepositories(db: Database): CrawlerRepositories {
  return {
    sources: new PgSourceRepository(db),
    listings: new PgListingRepository(db),
    observations: new PgObservationRepository(db),
    crawlRuns: new PgCrawlRunRepository(db),
  };
}

export type { CrawlRunRow, ListingRow, SourceRow };
