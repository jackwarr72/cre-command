/**
 * @cre/api — production repository implementations (Drizzle/Postgres).
 *
 * Query-side repositories for the API. Read paths never mutate data; the
 * source PATCH is the single intentional write outside the crawler, and it
 * only touches crawl-policy columns.
 */

import { and, asc, count, desc, eq, gte, ilike, inArray, lt, lte, or, type SQL } from 'drizzle-orm';

import { crawlRuns, listings, sessions, sources, users } from '@cre/db';
import type { Database, SourceRow, UserRow } from '@cre/db';
import type { CrawlRun, CrawlRunStatus, Listing, ListingFilter, Paged } from '@cre/shared';

import { toCrawlRunDto, toListingDto } from '../serializers';
import type {
  CrawlRunQueryRepo,
  ListingQueryRepo,
  SessionRepo,
  SourceAdminRepo,
  SourcePolicyPatch,
  UserRepo,
} from '../ports';

export class PgSourceAdminRepo implements SourceAdminRepo {
  constructor(private readonly db: Database) {}

  async list(): Promise<SourceRow[]> {
    return this.db.select().from(sources).orderBy(asc(sources.key));
  }

  async findByKey(key: string): Promise<SourceRow | null> {
    const rows = await this.db.select().from(sources).where(eq(sources.key, key)).limit(1);
    return rows[0] ?? null;
  }

  async updatePolicy(key: string, patch: SourcePolicyPatch, now: Date): Promise<SourceRow | null> {
    const values: Partial<typeof sources.$inferInsert> = { updatedAt: now };
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.crawlAllowed !== undefined) values.crawlAllowed = patch.crawlAllowed;
    if (patch.robotsPolicy !== undefined) values.robotsPolicy = patch.robotsPolicy;
    if (patch.rateLimitMs !== undefined) values.rateLimitMs = patch.rateLimitMs;
    if (patch.maxWorkers !== undefined) values.maxWorkers = patch.maxWorkers;

    const rows = await this.db
      .update(sources)
      .set(values)
      .where(eq(sources.key, key))
      .returning();
    return rows[0] ?? null;
  }
}

export class PgCrawlRunQueryRepo implements CrawlRunQueryRepo {
  constructor(private readonly db: Database) {}

  async list(
    filter: { sourceKey?: string; statuses?: CrawlRunStatus[] },
    page: number,
    pageSize: number,
  ): Promise<Paged<CrawlRun>> {
    const conditions: SQL[] = [];
    if (filter.sourceKey) conditions.push(eq(sources.key, filter.sourceKey));
    if (filter.statuses?.length) conditions.push(inArray(crawlRuns.status, filter.statuses));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows = await this.db
      .select({ value: count() })
      .from(crawlRuns)
      .innerJoin(sources, eq(sources.id, crawlRuns.sourceId))
      .where(where);
    const total = Number(totalRows[0]?.value ?? 0);

    const rows = await this.db
      .select({ run: crawlRuns, sourceKey: sources.key })
      .from(crawlRuns)
      .innerJoin(sources, eq(sources.id, crawlRuns.sourceId))
      .where(where)
      .orderBy(desc(crawlRuns.createdAt), desc(crawlRuns.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row) => toCrawlRunDto(row.run, row.sourceKey)),
      page,
      pageSize,
      total,
    };
  }

  async findById(id: string): Promise<CrawlRun | null> {
    const rows = await this.db
      .select({ run: crawlRuns, sourceKey: sources.key })
      .from(crawlRuns)
      .innerJoin(sources, eq(sources.id, crawlRuns.sourceId))
      .where(eq(crawlRuns.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toCrawlRunDto(row.run, row.sourceKey) : null;
  }
}

// ── Users & sessions (auth) ──────────────────────────────────────

export class PgUserRepo implements UserRepo {
  constructor(private readonly db: Database) {}

  async count(): Promise<number> {
    const rows = await this.db.select({ value: count() }).from(users);
    return Number(rows[0]?.value ?? 0);
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(
    input: { email: string; displayName?: string; role: UserRow['role']; passwordHash: string },
    now: Date,
  ): Promise<UserRow> {
    const rows = await this.db
      .insert(users)
      .values({
        email: input.email.toLowerCase(),
        displayName: input.displayName ?? null,
        role: input.role,
        passwordHash: input.passwordHash,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('user insert returned no row');
    return row;
  }
}

export class PgSessionRepo implements SessionRepo {
  constructor(private readonly db: Database) {}

  async create(
    input: { userId: string; tokenHash: string; expiresAt: Date },
    _now: Date,
  ): Promise<void> {
    await this.db.insert(sessions).values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  }

  async findActive(
    tokenHash: string,
    now: Date,
  ): Promise<{ user: UserRow; expiresAt: Date } | null> {
    const rows = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, tokenHash), gte(sessions.expiresAt, now)))
      .limit(1);
    const row = rows[0];
    return row ? { user: row.user, expiresAt: row.session.expiresAt } : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }

  async deleteExpired(now: Date): Promise<number> {
    const removed = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning({ id: sessions.id });
    return removed.length;
  }
}

// ── Listings (search/read) ───────────────────────────────────────

function listingConditions(db: Database, filter: ListingFilter): SQL[] {
  const conditions: SQL[] = [];
  if (filter.q) {
    const needle = `%${filter.q}%`;
    conditions.push(
      or(
        ilike(listings.title, needle),
        ilike(listings.description, needle),
        ilike(listings.formattedAddress, needle),
      )!,
    );
  }
  if (filter.propertyTypes?.length) {
    conditions.push(inArray(listings.propertyType, filter.propertyTypes));
  }
  if (filter.listingTypes?.length) {
    conditions.push(inArray(listings.listingType, filter.listingTypes));
  }
  if (filter.statuses?.length) {
    conditions.push(inArray(listings.status, filter.statuses));
  }
  if (filter.states?.length) {
    conditions.push(inArray(listings.state, filter.states));
  }
  if (filter.cities?.length) {
    conditions.push(inArray(listings.city, filter.cities));
  }
  if (filter.sourceKeys?.length) {
    conditions.push(
      inArray(
        listings.sourceId,
        db
          .select({ id: sources.id })
          .from(sources)
          .where(inArray(sources.key, filter.sourceKeys)),
      ),
    );
  }
  if (filter.minPrice !== undefined) {
    conditions.push(gte(listings.priceAmount, String(filter.minPrice)));
  }
  if (filter.maxPrice !== undefined) {
    conditions.push(lte(listings.priceAmount, String(filter.maxPrice)));
  }
  if (filter.updatedSince) {
    conditions.push(gte(listings.updatedAt, new Date(filter.updatedSince)));
  }
  return conditions;
}

export class PgListingQueryRepo implements ListingQueryRepo {
  constructor(private readonly db: Database) {}

  async search(filter: ListingFilter, page: number, pageSize: number): Promise<Paged<Listing>> {
    const conditions = listingConditions(this.db, filter);
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows = await this.db.select({ value: count() }).from(listings).where(where);
    const total = Number(totalRows[0]?.value ?? 0);

    const rows = await this.db
      .select({ listing: listings, sourceKey: sources.key })
      .from(listings)
      .innerJoin(sources, eq(sources.id, listings.sourceId))
      .where(where)
      .orderBy(desc(listings.lastSeenAt), asc(listings.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row) => toListingDto(row.listing, row.sourceKey)),
      page,
      pageSize,
      total,
    };
  }

  async findById(id: string): Promise<Listing | null> {
    const rows = await this.db
      .select({ listing: listings, sourceKey: sources.key })
      .from(listings)
      .innerJoin(sources, eq(sources.id, listings.sourceId))
      .where(eq(listings.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toListingDto(row.listing, row.sourceKey) : null;
  }
}

export interface ApiRepositories {
  users: UserRepo;
  sessions: SessionRepo;
  listings: ListingQueryRepo;
  sources: SourceAdminRepo;
  crawlRuns: CrawlRunQueryRepo;
}

export function createApiRepositories(db: Database): ApiRepositories {
  return {
    users: new PgUserRepo(db),
    sessions: new PgSessionRepo(db),
    listings: new PgListingQueryRepo(db),
    sources: new PgSourceAdminRepo(db),
    crawlRuns: new PgCrawlRunQueryRepo(db),
  };
}