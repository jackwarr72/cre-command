import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

import type { Database } from '../src/postgres/client';
import * as schema from '../src/postgres/schema';
import {
  contacts,
  crawlRuns,
  listingObservations,
  listings,
  sources,
} from '../src/postgres/schema';

/**
 * Integration suite against a real PostgreSQL.
 * Skipped unless DATABASE_URL is provided, e.g.:
 *   DATABASE_URL=postgres://cre:cre@localhost:55432/cre_command npm test
 */
const url = process.env.DATABASE_URL;
const migrationsDir = fileURLToPath(new URL('../src/postgres/migrations', import.meta.url));

describe.skipIf(!url)('postgres integration', () => {
  let pool: Pool;
  let client: PoolClient;
  let db: Database;

  const testDbName = `cre_test_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    // Fresh, disposable database per run → every run starts empty and is
    // idempotent. (The docker `cre` user is superuser.)
    const admin = new Pool({ connectionString: url });
    await admin.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await admin.query(`CREATE DATABASE "${testDbName}"`);
    await admin.end();

    const testUrl = new URL(url);
    testUrl.pathname = `/${testDbName}`;
    pool = new Pool({ connectionString: testUrl.toString() });
    client = await pool.connect();

    db = drizzle(pool, { schema });

    // Migrate from an empty database.
    await migrate(db, { migrationsFolder: migrationsDir });
  });

  afterAll(async () => {
    client?.release();
    await pool?.end().catch(() => {});
    const admin = new Pool({ connectionString: url });
    await admin.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  });

  it('migrates an empty database to the full schema', async () => {
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = CURRENT_SCHEMA()
      ORDER BY table_name
    `);
    const names = tables.rows.map((r) => r.table_name);
    for (const expected of [
      'sources',
      'listings',
      'listing_observations',
      'contacts',
      'crawl_runs',
    ]) {
      expect(names).toContain(expected);
    }

    const enums = await client.query<{ typname: string }>(`
      SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = CURRENT_SCHEMA() AND t.typtype = 'e'
      ORDER BY t.typname
    `);
    const enumNames = enums.rows.map((r) => r.typname);
    expect(enumNames).toEqual(
      expect.arrayContaining([
        'crawl_run_status',
        'listing_status',
        'listing_type',
        'price_unit',
        'property_type',
        'robots_policy',
        'size_unit',
      ]),
    );
  });
it('round-trips a realistic listing with enums, JSONB, and timestamps', async () => {
    // source
    const [src] = await db
      .insert(sources)
      .values({
        key: 'vivanuncios',
        name: 'Vivanuncios',
        baseUrl: 'https://www.vivanuncios.com.mx',
        config: { region: 'CDMX', pages: 3 },
        robotsPolicy: 'honor',
        rateLimitMs: 800,
        maxWorkers: 2,
      })
      .returning();
    expect(src).toMatchObject({
      key: 'vivanuncios',
      enabled: true,
      crawlAllowed: true,
      robotsPolicy: 'honor',
      authenticationRequired: false,
    });
    expect(src.id).toBeDefined();
    expect(src.updatedAt).toBeDefined();

    // listing (realistic office listing)
    const [listing] = await db
      .insert(listings)
      .values({
        sourceId: src.id,
        externalId: 'viv-12345',
        sourceUrl: 'https://www.vivanuncios.com.mx/oficinas-en-renta/12345',
        title: 'Oficina en renta — Polanco, CDMX',
        description: '2,300 sqft de oficina clase A en Polanco.',
        propertyType: 'office',
        listingType: 'lease',
        status: 'active',
        streetAddress: 'Av. Palmas 405',
        city: 'Ciudad de México',
        state: 'CDMX',
        postalCode: '06600',
        country: 'MX',
        lat: '19.4317646',
        lng: '-99.1911000',
        priceAmount: '18.50',
        priceCurrency: 'MXN',
        priceUnit: 'sqft-month',
        sizeValue: '2300.00',
        sizeUnit: 'sqft',
        yearBuilt: 2015,
        unitCount: 3,
        raw: { parseVersion: 1, extraAgentCode: 'AG-7' },
      })
      .returning();
    expect(listing).toMatchObject({
      externalId: 'viv-12345',
      propertyType: 'office',
      listingType: 'lease',
      status: 'active',
      city: 'Ciudad de México',
      priceCurrency: 'MXN',
      priceUnit: 'sqft-month',
      version: 1,
    });
    expect(listing.lat).not.toBeNull();
    expect(listing.lng).not.toBeNull();
    expect(listing.raw).toMatchObject({ parseVersion: 1 });
    expect(listing.firstSeenAt).toBeDefined();
    expect(listing.lastSeenAt).toBeDefined();

    // observation on the listing
    const [obs] = await db
      .insert(listingObservations)
      .values({
        listingId: listing.id,
        sourceUrl: listing.sourceUrl,
        raw: { title: listing.title, priceAmount: 18.5 },
      })
      .returning();
    expect(obs.listingId).toBe(listing.id);
    expect(obs.raw).toMatchObject({ priceAmount: 18.5 });

    // crawl run
    const [run] = await db
      .insert(crawlRuns)
      .values({
        sourceId: src.id,
        status: 'completed',
        startedAt: new Date(),
        finishedAt: new Date(),
        listingsFound: 1,
        listingsAdded: 1,
        listingsUpdated: 0,
      })
      .returning();
    expect(run).toMatchObject({ status: 'completed', listingsFound: 1, listingsAdded: 1 });

    // query canonical listing with relations
    const queried = await db.query.listings.findFirst({
      where: eq(listings.externalId, 'viv-12345'),
      with: { source: true, observations: true },
    });
    expect(queried?.source?.key).toBe('vivanuncios');
    expect(queried?.observations).toHaveLength(1);
    expect(queried?.observations[0].raw).toMatchObject({ priceAmount: 18.5 });

    // source → listings + crawlRuns relations
    const srcWith = await db.query.sources.findFirst({
      where: eq(sources.key, 'vivanuncios'),
      with: { listings: true, crawlRuns: true },
    });
    expect(srcWith?.listings).toHaveLength(1);
    expect(srcWith?.crawlRuns).toHaveLength(1);
  });
it('enforces sources.key uniqueness', async () => {
    await db.insert(sources).values({ key: 'dup-src', name: 'A' });
    await expect(db.insert(sources).values({ key: 'dup-src', name: 'B' })).rejects.toThrow(
      /duplicate key value violates unique constraint "sources_key_uidx"/,
    );
  });

  it('enforces (source_id, external_id) uniqueness', async () => {
    const [src] = await db.insert(sources).values({ key: 'uniq-src', name: 'Uniq' }).returning();
    await db.insert(listings).values({
      sourceId: src.id,
      externalId: 'dup-listing',
      sourceUrl: 'u1',
      title: 'T1',
      propertyType: 'office',
      listingType: 'sale',
    });
    await expect(
      db.insert(listings).values({
        sourceId: src.id,
        externalId: 'dup-listing',
        sourceUrl: 'u2',
        title: 'T2',
        propertyType: 'office',
        listingType: 'sale',
      }),
    ).rejects.toThrow(/duplicate key value violates unique constraint "listings_source_external_uidx"/);
  });

  it('cascades deletes from source → listings → observations', async () => {
    const [src] = await db.insert(sources).values({ key: 'cascade-src', name: 'C' }).returning();
    const [listing] = await db
      .insert(listings)
      .values({
        sourceId: src.id,
        externalId: 'c1',
        sourceUrl: 'u',
        title: 'T',
        propertyType: 'office',
        listingType: 'sale',
      })
      .returning();
    await db.insert(listingObservations).values({ listingId: listing.id, raw: { a: 1 } });

    await db.delete(sources).where(eq(sources.id, src.id));

    const found = await db.select().from(listings).where(eq(listings.id, listing.id));
    expect(found).toHaveLength(0);
    const obs = await db
      .select()
      .from(listingObservations)
      .where(eq(listingObservations.listingId, listing.id));
    expect(obs).toHaveLength(0);
  });

  it('rejects invalid enum values', async () => {
    await expect(
      db
        .insert(sources)
        .values({ key: 'bad-enum', name: 'X', robotsPolicy: 'definitely-not-real' as never }),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it('persists a minimal contact without a CRM', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Ana Broker', company: 'CBRE', email: 'ana@cbre.mx', sourceKey: 'vivanuncios' })
      .returning();
    expect(contact).toMatchObject({ name: 'Ana Broker', email: 'ana@cbre.mx' });
    expect(contact.firstSeenAt).toBeDefined();
  });

  it('fails predictably on a duplicate listing rather than creating another canonical row', async () => {
    const [src] = await db.insert(sources).values({ key: 'fail-src', name: 'F' }).returning();
    await db.insert(listings).values({
      sourceId: src.id,
      externalId: 'same-id',
      sourceUrl: 'https://x/1',
      title: 'First',
      propertyType: 'retail',
      listingType: 'sale',
    });
    await expect(
      db.insert(listings).values({
        sourceId: src.id,
        externalId: 'same-id',
        sourceUrl: 'https://x/1',
        title: 'Second',
        propertyType: 'retail',
        listingType: 'sale',
      }),
    ).rejects.toThrow(/duplicate key value violates unique constraint "listings_source_external_uidx"/);

    const count = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.externalId, 'same-id'));
    expect(count).toHaveLength(1);
  });
});