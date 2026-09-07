/**
 * @cre/shared
 *
 * Shared domain types for cre-command — a Commercial Real Estate (CRE)
 * intelligence, crawling & lead-generation control panel.
 *
 * This module is the single source of truth for cross-layer types:
 *
 *   packages/db       — schema & row mapping
 *   packages/adapters — source capture & normalization
 *   packages/crawler  — crawl pipeline
 *   packages/api      — request/response contracts
 *   packages/workers  — background jobs
 *   apps/web          — UI & API client
 *
 * Conventions:
 * - Plain `interface`/`type` declarations (no `enum`, no classes).
 * - IDs are opaque strings (`ID`); UUIDs are strongly recommended.
 * - Times are ISO 8601 UTC strings (`ISODateTime`).
 * - Money is an amount plus an ISO 4217 currency code.
 */

import { z } from 'zod';

// ── Primitives ───────────────────────────────────────────────────

/** Opaque entity identifier (UUID recommended). */
export type ID = string;

/** ISO 8601 UTC timestamp, e.g. `2026-08-30T20:45:00.000Z`. */
export type ISODateTime = string;

/** ISO 3166-1 alpha-2 country code. */
export type CountryCode = string;

/** ISO 4217 currency code. */
export type CurrencyCode = string;

/** Entity audit timestamps. */
export interface Timestamps {
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ── Money & measurements ─────────────────────────────────────────

export interface Money {
  amount: number;
  currency: CurrencyCode;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export const SIZE_UNITS = ["sqft", "sqm", "acre"] as const;
export type SizeUnit = (typeof SIZE_UNITS)[number];

export interface Size {
  value: number;
  unit: SizeUnit;
}

// ── Address ──────────────────────────────────────────────────────

export interface Address {
  streetAddress?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country: CountryCode;
  /** Human-readable address exactly as captured from the source. */
  formatted?: string;
}

// ── Property domain vocabulary ───────────────────────────────────

export const PROPERTY_TYPES = [
  "office",
  "retail",
  "industrial",
  "multifamily",
  "land",
  "mixed-use",
  "special-purpose",
  "healthcare",
  "hospitality",
  "agriculture",
  "other",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const LISTING_TYPES = ["sale", "lease", "sale-or-lease"] as const;
export type ListingType = (typeof LISTING_TYPES)[number];

export const LISTING_STATUSES = [
  "active",
  "pending",
  "sold",
  "leased",
  "off-market",
  "removed",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/**
 * How `Listing.price` is interpreted:
 * - `total`      — asking price for the whole property (sale)
 * - `sqft`       — per-square-foot asking price (sale)
 * - `sqft-month` — per-square-foot per month (lease)
 * - `sqft-year`  — per-square-foot per year (lease)
 * - `sqm`        — per-square-metre asking price (sale)
 * - `sqm-month`  — per-square-metre per month (lease)
 * - `sqm-year`   — per-square-metre per year (lease)
 * - `month`      — flat monthly rent (lease)
 */
export const PRICE_UNITS = [
  "total",
  "sqft",
  "sqft-month",
  "sqft-year",
  "sqm",
  "sqm-month",
  "sqm-year",
  "month",
] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const CONTACT_KINDS = [
  "broker",
  "agent",
  "owner",
  "listing-center",
] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

// ── Listings ─────────────────────────────────────────────────────

export interface ListingContact {
  kind: ContactKind;
  name?: string;
  company?: string;
  phone?: string;
  email?: string;
}

export interface Listing {
  id: ID;
  /** Adapter key that produced this listing (e.g. `loopnet`). */
  sourceKey: string;
  /** ID of the listing within its source. */
  externalId: string;
  /** Canonical URL of the listing on the source site. */
  sourceUrl: string;
  title: string;
  description?: string;
  propertyType: PropertyType;
  listingType: ListingType;
  status: ListingStatus;
  address?: Address;
  geo?: GeoPoint;
  price?: Money;
  priceUnit?: PriceUnit;
  /** Rentable / building size. */
  size?: Size;
  /** Lot size, when known. */
  lotSize?: Size;
  yearBuilt?: number;
  /** Unit count (multifamily, multi-tenant buildings). */
  unitCount?: number;
  images: string[];
  contacts: ListingContact[];
  listedAt?: ISODateTime;
  updatedAt?: ISODateTime;
  scrapedAt: ISODateTime;
  /** Arbitrary extra fields preserved from the source. */
  raw?: Record<string, unknown>;
}

/**
 * A listing as captured and normalized by a source adapter, before any
 * database persistence. Represents the *source of truth as observed* —
 * it deliberately contains no database-specific fields (id, version,
 * created_at, …). Provenance is carried by sourceKey/externalId/sourceUrl.
 */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const listingContactSchema = z.object({
  kind: z.enum(CONTACT_KINDS),
  name: z.string().optional(),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

export const listingCandidateSchema = z.object({
  /** Adapter/source key, e.g. `vivanuncios`. */
  sourceKey: z.string().min(1),
  /** Listing ID within its source. */
  externalId: z.string().min(1),
  /** Canonical URL of the listing on the source site. */
  sourceUrl: z.string().url(),
  title: z.string().min(1),
  description: z.string().optional(),
  propertyType: z.enum(PROPERTY_TYPES),
  listingType: z.enum(LISTING_TYPES),
  address: z
    .object({
      streetAddress: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().length(2),
      formatted: z.string().optional(),
    })
    .optional(),
  geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
  price: z
    .object({
      amount: z.number().nonnegative(),
      currency: z.string().length(3),
    })
    .optional(),
  priceUnit: z.enum(PRICE_UNITS).optional(),
  size: z
    .object({
      value: z.number().nonnegative(),
      unit: z.enum(SIZE_UNITS),
    })
    .optional(),
  lotSize: z
    .object({
      value: z.number().nonnegative(),
      unit: z.enum(SIZE_UNITS),
    })
    .optional(),
  yearBuilt: z.number().int().optional(),
  unitCount: z.number().int().nonnegative().optional(),
  images: z.array(z.string().url()).default([]),
  contacts: z.array(listingContactSchema).default([]),
  /** Publication date on the source, when available. */
  listedAt: isoDateTimeSchema.optional(),
  /** Source-specific metadata preserved verbatim. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ListingCandidate = z.infer<typeof listingCandidateSchema>;
// ── Contacts & leads ─────────────────────────────────────────────

export const LEAD_STATUSES = [
  "new",
  "qualified",
  "contacted",
  "meeting-scheduled",
  "proposal",
  "closed-won",
  "closed-lost",
  "dismissed",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface Contact {
  id: ID;
  name?: string;
  company?: string;
  title?: string;
  email?: string;
  phone?: string;
  website?: string;
  /** Adapter key that first surfaced this contact. */
  sourceKey?: string;
  firstSeenAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Lead {
  id: ID;
  contactId: ID;
  listingId?: ID;
  status: LeadStatus;
  assignedToUserId?: ID;
  notes?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ── Users & auth ─────────────────────────────────────────────────

export const USER_ROLES = ["admin", "operator", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** User record as exposed to API clients (credentials never included). */
export interface User {
  id: ID;
  email: string;
  displayName?: string;
  role: UserRole;
  active: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

/** Server-side session record. */
export interface Session {
  id: ID;
  userId: ID;
  /** Hash of the session token — never the raw token itself. */
  tokenHash: string;
  expiresAt: ISODateTime;
  createdAt: ISODateTime;
}

// ── Crawler sources & runs ───────────────────────────────────────

export const CRAWL_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  /** The crawl produced records but also reported errors (partial success). */
  "completed_with_errors",
  "failed",
  "cancelled",
] as const;
export type CrawlRunStatus = (typeof CRAWL_RUN_STATUSES)[number];

/**
 * Source crawling policy, enforced at runtime by the crawler:
 * - `strict`  — fail closed: skip unless crawling is explicitly permitted.
 * - `honor`   — respect robots.txt / robots meta tags.
 * - `allow`   — operator explicitly authorizes full crawl (first-party APIs/feeds).
 */
export const ROBOTS_POLICIES = ["strict", "honor", "allow"] as const;
export type RobotsPolicy = (typeof ROBOTS_POLICIES)[number];

export interface CrawlerSource {
  id: ID;
  /** Unique adapter key. */
  key: string;
  name: string;
  baseUrl?: string;
  enabled: boolean;
  /** Cron expression, e.g. `0 3 * * *`. */
  schedule: string;
  config: Record<string, unknown>;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface CrawlError {
  message: string;
  url?: string;
  retries: number;
  /** When true the run is not retried. */
  fatal?: boolean;
  at: ISODateTime;
}

export interface CrawlRun {
  id: ID;
  sourceKey: string;
  status: CrawlRunStatus;
  requestedByUserId?: ID;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  listingsFound: number;
  listingsAdded: number;
  listingsUpdated: number;
  errors: CrawlError[];
  createdAt: ISODateTime;
}

export interface CrawlRunWithMetrics extends CrawlRun {
  metrics?: CrawlRunMetrics;
}

// ── Source health & observability ────────────────────────────────

export const SOURCE_HEALTH_STATUS = ["healthy", "warning", "critical", "unknown"] as const;
export type SourceHealthStatus = (typeof SOURCE_HEALTH_STATUS)[number];

export const ANOMALY_SEVERITY = ["critical", "warning"] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITY)[number];

export const ANOMALY_TYPE = [
  "extraction_anomaly",
  "listing_volume_drop",
  "parse_degradation",
  "transport_degradation",
] as const;
export type AnomalyType = (typeof ANOMALY_TYPE)[number];

export interface SourceAnomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  message: string;
  /** ISO timestamp when the anomaly was detected. */
  detectedAt: ISODateTime;
}

export interface SourceHealth {
  sourceKey: string;
  status: SourceHealthStatus;
  lastAttempt?: ISODateTime;
  lastSuccess?: ISODateTime;
  latestRun?: CrawlRunMetrics;
  /** How listingsDiscovered compares to the previous successful run. */
  listingVolumeChange?: number;
  anomalies: SourceAnomaly[];
}

export interface CrawlRunMetrics {
  runId: ID;
  status: CrawlRunStatus;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  durationMs?: number;
  pagesAttempted: number;
  pagesSucceeded: number;
  pagesFailed: number;
  listingsDiscovered: number;
  listingsAccepted: number;
  listingsRejected: number;
  duplicateCandidates: number;
  listingsCreated: number;
  listingsUpdated: number;
  listingsUnchanged: number;
  parseErrors: number;
  httpErrors: number;
  robotsDenials: number;
  /** Number of HTTP requests that were retried before success or final failure. */
  retryCount: number;
  /** HTTP status code → count, e.g. { "200": 42, "503": 3 }. */
  httpStatusCounts: Record<string, number>;
  /** Total number of HTTP requests attempted (including retries). */
  requestCount: number;
  /** Sum of all per-request latencies in ms (for computing average). */
  totalLatencyMs: number;
  /** Maximum single-request latency in ms. */
  maxLatencyMs: number;
  /** Bounded latency samples (capped at 1000) for percentile estimation. */
  latencySamplesMs: number[];
  /** Total bytes downloaded across all successful page fetches. */
  bytesDownloaded: number;
  /** Listing cards seen in the raw HTML across all pages. */
  cardsSeen: number;
  /** Cards that produced a validated ListingCandidate. */
  cardsParsed: number;
  /** Cards rejected (missing ID, URL, or failed schema validation). */
  cardsRejected: number;
  /** Candidates with a title field. */
  candidatesWithTitle: number;
  /** Candidates with a price field. */
  candidatesWithPrice: number;
  /** Candidates with an address field. */
  candidatesWithAddress: number;
  /** Candidates with a size field. */
  candidatesWithSize: number;
  /** Candidates with a propertyType field. */
  candidatesWithPropertyType: number;
  /** Observations appended (one per candidate, including unchanged). */
  observationsInserted: number;
  errors: CrawlError[];
}

// ── Filters, exports & API shapes ────────────────────────────────

export interface ListingFilter {
  /** Free-text search across title/description/address. */
  q?: string;
  propertyTypes?: PropertyType[];
  listingTypes?: ListingType[];
  statuses?: ListingStatus[];
  sourceKeys?: string[];
  states?: string[];
  cities?: string[];
  minPrice?: number;
  maxPrice?: number;
  /** Only listings updated after this time. */
  updatedSince?: ISODateTime;
}

export const EXPORT_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export interface ExportJob {
  id: ID;
  format: "csv";
  filters: ListingFilter;
  status: ExportStatus;
  rowCount?: number;
  filePath?: string;
  requestedByUserId?: ID;
  createdAt: ISODateTime;
  completedAt?: ISODateTime;
}

export interface PageQuery {
  /** 1-based page number. */
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiErrorBody {
  error: {
    message: string;
    code?: string;
  };
}

export interface LoginRequest {
  email: string;
  password: string;
  /** Optional MFA/TOTP code presented to satisfy the second factor. */
  mfaCode?: string;
  /**
   * One-time backup recovery code when TOTP is unavailable.
   * Each code can only be used once; new codes must be provisioned.
   */
  mfaRecoveryCode?: string;
  /**
   * Identifier of the in-progress MFA challenge. Required when submitting
   * `mfaCode` or `mfaRecoveryCode` to associate the code with a specific challenge.
   */
  mfaChallengeId?: string;
  /** Stable per-device token used to remember trusted devices. */
  deviceFingerprint?: string;
}

export interface LoginResponse {
  user: User;
  token: string;
  expiresAt: ISODateTime;
  /**
   * Opaque refresh token used to obtain a new access token without re-entering
   * credentials. Only present when MFA is satisfied and the session is long-lived.
   */
  refreshToken?: string;
  /**
   * When the server requires a second factor, the login returns 200 with
   * `mfaRequired: true` and no token. The client must resubmit the login
   * request with the same credentials plus `mfaCode`.
   */
  mfaRequired?: boolean;
  /**
   * Identifier of the in-progress MFA challenge. The client should echo this
   * back when submitting the MFA code so the server can match the challenge
   * to the pending login attempt.
   */
  mfaChallengeId?: string;
  /** Seconds until the MFA challenge expires. */
  mfaChallengeTtlSeconds?: number;
}