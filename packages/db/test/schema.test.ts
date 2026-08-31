import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  contacts,
  crawlRuns,
  listingObservations,
  listings,
  sources,
} from '../src/postgres/schema';
import {
  CRAWL_RUN_STATUSES,
  LISTING_STATUSES,
  LISTING_TYPES,
  PRICE_UNITS,
  PROPERTY_TYPES,
  ROBOTS_POLICIES,
  SIZE_UNITS,
} from '@cre/shared';

const migrationsDir = fileURLToPath(
  new URL('../src/postgres/migrations', import.meta.url),
);
const migrationSql = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => readFileSync(resolve(migrationsDir, file), 'utf8'))
  .join('\n');

describe('db schema', () => {
  it('defines the five core tables', () => {
    for (const table of [sources, listings, listingObservations, contacts, crawlRuns]) {
      expect(table).toBeDefined();
    }
  });

  it('models source crawl policy explicitly', () => {
    expect(sources.enabled).toBeDefined();
    expect(sources.crawlAllowed).toBeDefined();
    expect(sources.robotsPolicy).toBeDefined();
    expect(sources.rateLimitMs).toBeDefined();
    expect(sources.authenticationRequired).toBeDefined();
  });

  it('models the canonical listing with source identity + provenance', () => {
    expect(listings.sourceId).toBeDefined();
    expect(listings.externalId).toBeDefined();
    expect(listings.sourceUrl).toBeDefined();
    expect(listings.firstSeenAt).toBeDefined();
    expect(listings.lastSeenAt).toBeDefined();
    expect(listings.updatedAt).toBeDefined();
    expect(listings.raw).toBeDefined();
    expect(listings.version).toBeDefined();
  });

  it('tracks raw observations for audit/provenance', () => {
    expect(listingObservations.listingId).toBeDefined();
    expect(listingObservations.observedAt).toBeDefined();
    expect(listingObservations.raw).toBeDefined();
  });

  it('keeps contacts deliberately minimal', () => {
    expect(contacts.name).toBeDefined();
    expect(contacts.company).toBeDefined();
    expect(contacts.email).toBeDefined();
  });
});

describe('migration SQL', () => {
  it('was generated for every enum', () => {
    // 'completed_with_errors' is added by migration 0002 (see the dedicated test below).
    const initialCrawlRunStatuses = CRAWL_RUN_STATUSES.filter(
      (status) => status !== 'completed_with_errors',
    );
    for (const value of [
      PROPERTY_TYPES,
      LISTING_TYPES,
      LISTING_STATUSES,
      SIZE_UNITS,
      initialCrawlRunStatuses,
      ROBOTS_POLICIES,
    ]) {
      expect(migrationSql).toContain(`AS ENUM(${value.map((v) => `'${v}'`).join(', ')}`);
    }
  });

  it('extends crawl_run_status with completed_with_errors (0002)', () => {
    expect(migrationSql).toContain('ALTER TYPE "public"."crawl_run_status" ADD VALUE');
    expect(migrationSql).toContain("ADD VALUE 'completed_with_errors'");
  });

  it('creates price_unit in 0000 and extends it with sqm units in 0001', () => {
    // Original set created in the initial migration.
    expect(migrationSql).toContain(
      `AS ENUM('total', 'sqft', 'sqft-month', 'sqft-year', 'month')`,
    );
    // Every current member must appear somewhere in the migration set.
    for (const v of PRICE_UNITS) {
      expect(migrationSql).toContain(`'${v}'`);
    }
    expect(migrationSql).toContain('ALTER TYPE "public"."price_unit" ADD VALUE');
    expect(migrationSql).toContain("ADD VALUE 'sqm-month'");
    expect(migrationSql).toContain("ADD VALUE 'sqm-year'");
    expect(migrationSql).toContain("ADD VALUE 'sqm'");
  });

  it('creates all tables', () => {
    for (const table of ['sources', 'listings', 'listing_observations', 'contacts', 'crawl_runs']) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
  });

  it('defines cascading foreign keys', () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_source_id_sources_id_fk"',
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "listings" ADD CONSTRAINT "listings_source_id_sources_id_fk"',
    );
    expect(migrationSql).toContain(
      'ALTER TABLE "listing_observations" ADD CONSTRAINT "listing_observations_listing_id_listings_id_fk"',
    );
    expect(migrationSql).toContain('ON DELETE cascade');
  });

  it('creates the unique constraints', () => {
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "listings_source_external_uidx"',
    );
    expect(migrationSql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "sources_key_uidx"');
  });
});