/**
 * @cre/crawler — change detection.
 *
 * The materialized subset of a canonical listing, expressed as plain strings
 * so the *same* fingerprint can be computed from a `ListingCandidate`
 * (crawler, before write) and from a `ListingRow` (repository, after read).
 * An unchanged source record therefore never mutates the canonical row.
 */

import { createHash } from 'node:crypto';

import type { ListingRow } from '@cre/db';
import type { ListingCandidate } from '@cre/shared';

export interface ListingMaterialized {
  sourceUrl: string;
  title: string;
  description: string | null;
  propertyType: string;
  listingType: string;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  formattedAddress: string | null;
  lat: string | null;
  lng: string | null;
  priceAmount: string | null;
  priceCurrency: string | null;
  priceUnit: string | null;
  sizeValue: string | null;
  sizeUnit: string | null;
  lotSizeValue: string | null;
  lotSizeUnit: string | null;
  yearBuilt: number | null;
  unitCount: number | null;
  listedAt: string | null;
}

/** Canonicalize numerics so `12000`, `12000.00`, and `12000.0` fingerprint alike. */
function canonNum(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(n)) return String(n);
  return typeof value === 'string' ? value : null;
}

/** Normalize date-only ISO strings to midnight UTC so both forms compare equal. */
function canonIso(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

export function materializedFromCandidate(candidate: ListingCandidate): ListingMaterialized {
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
    lat: canonNum(candidate.geo?.lat),
    lng: canonNum(candidate.geo?.lng),
    priceAmount: canonNum(candidate.price?.amount),
    priceCurrency: candidate.price?.currency ?? null,
    priceUnit: candidate.priceUnit ?? null,
    sizeValue: canonNum(candidate.size?.value),
    sizeUnit: candidate.size?.unit ?? null,
    lotSizeValue: canonNum(candidate.lotSize?.value),
    lotSizeUnit: candidate.lotSize?.unit ?? null,
    yearBuilt: candidate.yearBuilt ?? null,
    unitCount: candidate.unitCount ?? null,
    listedAt: canonIso(candidate.listedAt),
  };
}

export function materializedFromRow(row: ListingRow): ListingMaterialized {
  return {
    sourceUrl: row.sourceUrl,
    title: row.title,
    description: row.description,
    propertyType: row.propertyType,
    listingType: row.listingType,
    streetAddress: row.streetAddress,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    formattedAddress: row.formattedAddress,
    lat: canonNum(row.lat),
    lng: canonNum(row.lng),
    priceAmount: canonNum(row.priceAmount),
    priceCurrency: row.priceCurrency,
    priceUnit: row.priceUnit,
    sizeValue: canonNum(row.sizeValue),
    sizeUnit: row.sizeUnit,
    lotSizeValue: canonNum(row.lotSizeValue),
    lotSizeUnit: row.lotSizeUnit,
    yearBuilt: row.yearBuilt,
    unitCount: row.unitCount,
    listedAt: row.listedAt ? row.listedAt.toISOString() : null,
  };
}

/** Stable SHA-256 fingerprint of the materialized listing state. */
export function fingerprintListing(materialized: ListingMaterialized): string {
  const hash = createHash('sha256');
  for (const value of Object.values(materialized)) {
    hash.update(value === null ? '\u0000' : `${JSON.stringify(value)}\u0000`);
  }
  return hash.digest('hex');
}
