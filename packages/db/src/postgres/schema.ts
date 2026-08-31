/**
 * @cre/db — PostgreSQL schema (Drizzle ORM)
 *
 * Derived from the domain requirements:
 *
 *   sources              — crawler source/site configuration + crawl policy
 *   listings             — canonical listing + source identity + provenance window
 *   listing_observations — raw observations of a listing (audit trail)
 *   contacts             — organizations/contacts surfaced while crawling (minimal)
 *   crawl_runs           — execution record of a crawl against a source
 *   users                — operator accounts for the control panel (auth)
 *   sessions             — opaque bearer sessions (hashed tokens)
 *
 * Design principles:
 * - Stabilize the shared vocabulary via `@cre/shared` constants (enum values),
 *   so the DB enums and the rest of the system can never drift apart.
 * - Persistence-specific concerns (indexes, FKs, versioning, raw payloads) live
 *   here, not in `@cre/shared`.
 * - Source security policy is modeled explicitly (crawlAllowed / robotsPolicy /
 *   rateLimitMs / authenticationRequired). The crawler must fail closed.
 * - Raw-vs-normalized distinction via `raw` columns and `listing_observations`.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CRAWL_RUN_STATUSES,
  type CrawlError,
  LISTING_STATUSES,
  LISTING_TYPES,
  PRICE_UNITS,
  PROPERTY_TYPES,
  ROBOTS_POLICIES,
  SIZE_UNITS,
  USER_ROLES,
} from '@cre/shared';

// ── Enums (values derived from @cre/shared) ──────────────────────

export const propertyType = pgEnum('property_type', PROPERTY_TYPES);
export const listingType = pgEnum('listing_type', LISTING_TYPES);
export const listingStatus = pgEnum('listing_status', LISTING_STATUSES);
export const priceUnit = pgEnum('price_unit', PRICE_UNITS);
export const sizeUnit = pgEnum('size_unit', SIZE_UNITS);
export const crawlRunStatus = pgEnum('crawl_run_status', CRAWL_RUN_STATUSES);
export const robotsPolicy = pgEnum('robots_policy', ROBOTS_POLICIES);
export const userRole = pgEnum('user_role', USER_ROLES);

// ── Sources ───────────────────────────────────────────────────────

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Unique adapter key, e.g. `vivanuncios`, `inmuebles24`. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url'),
    enabled: boolean('enabled').notNull().default(true),
    /** Cron expression controlling scheduled crawls. */
    schedule: text('schedule').notNull().default('0 3 * * *'),
    /** Adapter-specific configuration (selectors, endpoints, …). */
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Permission to crawl at all. False ⇒ skip, never bypass. */
    crawlAllowed: boolean('crawl_allowed').notNull().default(true),
    robotsPolicy: robotsPolicy('robots_policy').notNull().default('strict'),
    /** Minimum delay between requests to this source (ms). */
    rateLimitMs: integer('rate_limit_ms').notNull().default(500),
    /** Max concurrent workers for this source. */
    maxWorkers: integer('max_workers').notNull().default(1),
    authenticationRequired: boolean('authentication_required').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [uniqueIndex('sources_key_uidx').on(t.key)],
);
// ── Listings ─────────────────────────────────────────────────────

export const listings = pgTable(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    /** Listing id within its source. */
    externalId: text('external_id').notNull(),
    /** Canonical URL of the listing on the source site. */
    sourceUrl: text('source_url').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    propertyType: propertyType('property_type').notNull(),
    listingType: listingType('listing_type').notNull(),
    status: listingStatus('status').notNull().default('active'),
    streetAddress: text('street_address'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country').notNull().default('MX'),
    /** Human-readable address exactly as captured from the source. */
    formattedAddress: text('formatted_address'),
    lat: numeric('lat', { precision: 10, scale: 7 }),
    lng: numeric('lng', { precision: 10, scale: 7 }),
    priceAmount: numeric('price_amount', { precision: 16, scale: 2 }),
    priceCurrency: text('price_currency'),
    priceUnit: priceUnit('price_unit'),
    sizeValue: numeric('size_value', { precision: 12, scale: 2 }),
    sizeUnit: sizeUnit('size_unit'),
    lotSizeValue: numeric('lot_size_value', { precision: 12, scale: 2 }),
    lotSizeUnit: sizeUnit('lot_size_unit'),
    yearBuilt: integer('year_built'),
    unitCount: integer('unit_count'),
    /** Publication date on the source. */
    listedAt: timestamp('listed_at', { mode: 'date' }),
    /** First time this listing was observed by the crawler. */
    firstSeenAt: timestamp('first_seen_at', { mode: 'date' }).notNull().defaultNow(),
    /** Last time this listing was observed. */
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
    /** Raw normalized payload as produced by the adapter (raw-vs-normalized). */
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    /** Optimistic-concurrency counter, bumped on every materialized change. */
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('listings_source_external_uidx').on(t.sourceId, t.externalId),
    index('listings_status_idx').on(t.status),
    index('listings_property_type_idx').on(t.propertyType),
    index('listings_location_idx').on(t.city, t.state),
    index('listings_last_seen_idx').on(t.lastSeenAt),
  ],
);
// ── Listing observations (audit/provenance) ──────────────────────

export const listingObservations = pgTable(
  'listing_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    observedAt: timestamp('observed_at', { mode: 'date' }).notNull().defaultNow(),
    /** URL the observation was captured from. */
    sourceUrl: text('source_url'),
    /** Raw payload exactly as captured (un-normalized). */
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('listing_observations_listing_idx').on(t.listingId, t.observedAt)],
);

// ── Contacts (deliberately minimal — no full CRM) ────────────────

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    company: text('company'),
    title: text('title'),
    email: text('email'),
    phone: text('phone'),
    website: text('website'),
    /** Adapter key that first surfaced this contact. */
    sourceKey: text('source_key'),
    firstSeenAt: timestamp('first_seen_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [
    index('contacts_source_key_idx').on(t.sourceKey),
    index('contacts_email_idx').on(t.email),
  ],
);

// ── Crawl runs ────────────────────────────────────────────────────

export const crawlRuns = pgTable(
  'crawl_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    status: crawlRunStatus('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { mode: 'date' }),
    finishedAt: timestamp('finished_at', { mode: 'date' }),
    listingsFound: integer('listings_found').notNull().default(0),
    listingsAdded: integer('listings_added').notNull().default(0),
    listingsUpdated: integer('listings_updated').notNull().default(0),
    errors: jsonb('errors')
      .$type<CrawlError[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('crawl_runs_source_idx').on(t.sourceId),
    index('crawl_runs_status_idx').on(t.status),
    index('crawl_runs_created_idx').on(t.createdAt),
  ],
);

// ── Users & sessions (operator auth) ─────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Login identifier, stored lowercase. */
    email: text('email').notNull(),
    displayName: text('display_name'),
    role: userRole('role').notNull().default('viewer'),
    /** bcrypt hash — credentials never leave this table. */
    passwordHash: text('password_hash').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [uniqueIndex('users_email_uidx').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque bearer token — the raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uidx').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

// ── Relations ─────────────────────────────────────────────────────

export const sourcesRelations = relations(sources, ({ many }) => ({
  listings: many(listings),
  crawlRuns: many(crawlRuns),
}));

export const listingsRelations = relations(listings, ({ one, many }) => ({
  source: one(sources, { fields: [listings.sourceId], references: [sources.id] }),
  observations: many(listingObservations),
}));

export const listingObservationsRelations = relations(listingObservations, ({ one }) => ({
  listing: one(listings, { fields: [listingObservations.listingId], references: [listings.id] }),
}));

export const contactsRelations = relations(contacts, () => ({}));

export const crawlRunsRelations = relations(crawlRuns, ({ one }) => ({
  source: one(sources, { fields: [crawlRuns.sourceId], references: [sources.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

// ── Row types ─────────────────────────────────────────────────────

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type ListingRow = typeof listings.$inferSelect;
export type NewListingRow = typeof listings.$inferInsert;
export type ListingObservationRow = typeof listingObservations.$inferSelect;
export type NewListingObservationRow = typeof listingObservations.$inferInsert;
export type ContactRow = typeof contacts.$inferSelect;
export type NewContactRow = typeof contacts.$inferInsert;
export type CrawlRunRow = typeof crawlRuns.$inferSelect;
export type NewCrawlRunRow = typeof crawlRuns.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;