import type { CrawlRunRow, ListingRow, SourceRow, UserRow } from '@cre/db';
import type { CrawlRun, CrawlRunWithMetrics, CrawlRunMetrics, Listing, User } from '@cre/shared';

import type { SourceDto } from './ports';

const iso = (value: Date): string => value.toISOString();

/** Credentials (passwordHash) never leave the persistence layer. */
export function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName ?? undefined,
    role: row.role,
    active: row.active,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toSourceDto(row: SourceRow): SourceDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    schedule: row.schedule,
    config: row.config,
    crawlAllowed: row.crawlAllowed,
    robotsPolicy: row.robotsPolicy,
    rateLimitMs: row.rateLimitMs,
    maxWorkers: row.maxWorkers,
    authenticationRequired: row.authenticationRequired,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toCrawlRunDto(row: CrawlRunRow, sourceKey: string): CrawlRunWithMetrics {
  const metrics: CrawlRunMetrics = row.metrics ?? {
    runId: row.id,
    status: row.status,
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : undefined,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    listingsDiscovered: row.listingsFound,
    listingsAccepted: row.listingsFound,
    listingsRejected: 0,
    duplicateCandidates: 0,
    listingsCreated: row.listingsAdded,
    listingsUpdated: row.listingsUpdated,
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
    errors: row.errors,
  };
  return {
    id: row.id,
    sourceKey,
    status: row.status,
    startedAt: row.startedAt ? iso(row.startedAt) : undefined,
    finishedAt: row.finishedAt ? iso(row.finishedAt) : undefined,
    listingsFound: row.listingsFound,
    listingsAdded: row.listingsAdded,
    listingsUpdated: row.listingsUpdated,
    errors: row.errors,
    createdAt: iso(row.createdAt),
    metrics,
  };
}

/**
 * Canonical row (+ resolved source key) → shared `Listing`. Structured columns
 * carry the materialized fields; `images`/`contacts` round-trip through `raw`
 * exactly as the adapter produced them.
 */
export function toListingDto(row: ListingRow, sourceKey: string): Listing {
  const raw = (row.raw ?? {}) as Record<string, unknown>;
  const images = Array.isArray(raw['images']) ? (raw['images'] as string[]) : [];
  const contacts = Array.isArray(raw['contacts']) ? (raw['contacts'] as Listing['contacts']) : [];
  const hasAddress =
    row.streetAddress !== null ||
    row.city !== null ||
    row.state !== null ||
    row.postalCode !== null ||
    row.formattedAddress !== null;

  return {
    id: row.id,
    sourceKey,
    externalId: row.externalId,
    sourceUrl: row.sourceUrl,
    title: row.title,
    description: row.description ?? undefined,
    propertyType: row.propertyType,
    listingType: row.listingType,
    status: row.status,
    address: hasAddress
      ? {
          streetAddress: row.streetAddress ?? undefined,
          city: row.city ?? undefined,
          state: row.state ?? undefined,
          postalCode: row.postalCode ?? undefined,
          country: row.country,
          formatted: row.formattedAddress ?? undefined,
        }
      : undefined,
    geo:
      row.lat !== null && row.lng !== null
        ? { lat: Number(row.lat), lng: Number(row.lng) }
        : undefined,
    price:
      row.priceAmount !== null
        ? { amount: Number(row.priceAmount), currency: row.priceCurrency ?? 'MXN' }
        : undefined,
    priceUnit: row.priceUnit ?? undefined,
    size:
      row.sizeValue !== null && row.sizeUnit !== null
        ? { value: Number(row.sizeValue), unit: row.sizeUnit }
        : undefined,
    lotSize:
      row.lotSizeValue !== null && row.lotSizeUnit !== null
        ? { value: Number(row.lotSizeValue), unit: row.lotSizeUnit }
        : undefined,
    yearBuilt: row.yearBuilt ?? undefined,
    unitCount: row.unitCount ?? undefined,
    images,
    contacts,
    listedAt: row.listedAt ? iso(row.listedAt) : undefined,
    updatedAt: iso(row.updatedAt),
    scrapedAt: iso(row.lastSeenAt),
    raw,
  };
}