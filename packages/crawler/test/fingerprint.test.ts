import { describe, expect, it } from 'vitest';

import type { ListingRow } from '@cre/db';
import type { ListingCandidate } from '@cre/shared';

import {
  fingerprintListing,
  materializedFromCandidate,
  materializedFromRow,
} from '../src/fingerprint';

const candidate: ListingCandidate = {
  sourceKey: 'vivanuncios',
  externalId: 'viv-1',
  sourceUrl: 'https://www.vivanuncios.com.mx/s/ofertas/oficina/1',
  title: 'Oficina en renta',
  description: 'Oficina clase A',
  propertyType: 'office',
  listingType: 'lease',
  address: {
    streetAddress: 'Av. Palmas 405',
    city: 'Polanco',
    state: 'CDMX',
    postalCode: '06600',
    country: 'MX',
    formatted: 'Av. Palmas 405, Polanco',
  },
  geo: { lat: 19.4317646, lng: -99.1911 },
  price: { amount: 18500, currency: 'MXN' },
  priceUnit: 'sqm-month',
  size: { value: 2300, unit: 'sqm' },
  yearBuilt: 2015,
  unitCount: 3,
  listedAt: '2025-01-15T00:00:00.000Z',
  images: [],
  contacts: [],
};

/**
 * Simulates the persisted row as drizzle/postgres return it: numerics as
 * strings (scaled to the column), timestamps as Dates.
 */
function rowFromCandidate(input: ListingCandidate): ListingRow {
  const m = materializedFromCandidate(input);
  const now = new Date('2025-06-01T12:00:00.000Z');
  return {
    id: 'row-1',
    sourceId: 'src-1',
    externalId: input.externalId,
    sourceUrl: m.sourceUrl,
    title: m.title,
    description: m.description,
    propertyType: m.propertyType,
    listingType: m.listingType,
    status: 'active',
    streetAddress: m.streetAddress,
    city: m.city,
    state: m.state,
    postalCode: m.postalCode,
    country: m.country,
    formattedAddress: m.formattedAddress,
    lat: m.lat,
    lng: m.lng,
    priceAmount: m.priceAmount === null ? null : `${m.priceAmount}.00`,
    priceCurrency: m.priceCurrency,
    priceUnit: m.priceUnit,
    sizeValue: m.sizeValue === null ? null : `${m.sizeValue}.00`,
    sizeUnit: m.sizeUnit,
    lotSizeValue: m.lotSizeValue,
    lotSizeUnit: m.lotSizeUnit,
    yearBuilt: m.yearBuilt,
    unitCount: m.unitCount,
    listedAt: m.listedAt === null ? null : new Date(m.listedAt),
    firstSeenAt: now,
    lastSeenAt: now,
    updatedAt: now,
    raw: {},
    version: 1,
  } as ListingRow;
}

describe('materializedFromCandidate', () => {
  it('maps the candidate onto the materialized listing columns', () => {
    expect(materializedFromCandidate(candidate)).toMatchObject({
      sourceUrl: candidate.sourceUrl,
      title: 'Oficina en renta',
      description: 'Oficina clase A',
      propertyType: 'office',
      listingType: 'lease',
      streetAddress: 'Av. Palmas 405',
      city: 'Polanco',
      state: 'CDMX',
      postalCode: '06600',
      country: 'MX',
      formattedAddress: 'Av. Palmas 405, Polanco',
      lat: '19.4317646',
      lng: '-99.1911',
      priceAmount: '18500',
      priceCurrency: 'MXN',
      priceUnit: 'sqm-month',
      sizeValue: '2300',
      sizeUnit: 'sqm',
      yearBuilt: 2015,
      unitCount: 3,
      listedAt: '2025-01-15T00:00:00.000Z',
    });
  });

  it('defaults country to MX and leaves absent optionals as null', () => {
    const minimal = materializedFromCandidate({
      sourceKey: 's',
      externalId: 'e',
      sourceUrl: 'https://x.test/1',
      title: 'T',
      propertyType: 'office',
      listingType: 'sale',
      images: [],
      contacts: [],
    });

    expect(minimal.country).toBe('MX');
    expect(minimal.description).toBeNull();
    expect(minimal.priceAmount).toBeNull();
    expect(minimal.listedAt).toBeNull();
  });
});

describe('fingerprintListing — stability across the DB round-trip', () => {
  it('fingerprints identically from candidate and persisted-row representations', () => {
    const fromCandidate = fingerprintListing(materializedFromCandidate(candidate));
    const fromRow = fingerprintListing(materializedFromRow(rowFromCandidate(candidate)));

    expect(fromRow).toBe(fromCandidate);
  });

  it('canonicalizes numerics: 18500, "18500.00" and "18500.0" fingerprint alike', () => {
    const expected = fingerprintListing(materializedFromCandidate(candidate));

    const row = rowFromCandidate(candidate);
    row.priceAmount = '18500.00';
    row.sizeValue = '2300.0';
    expect(fingerprintListing(materializedFromRow(row))).toBe(expected);
  });

  it('normalizes date-only listedAt to midnight UTC', () => {
    const dateOnly = fingerprintListing(
      materializedFromCandidate({ ...candidate, listedAt: '2025-01-15' }),
    );
    const fromRow = fingerprintListing(materializedFromRow(rowFromCandidate(candidate)));

    expect(dateOnly).toBe(fromRow);
  });

  it('changes when materialized content changes', () => {
    const base = fingerprintListing(materializedFromCandidate(candidate));

    const repriced = fingerprintListing(
      materializedFromCandidate({ ...candidate, price: { amount: 19999, currency: 'MXN' } }),
    );
    const retitled = fingerprintListing(
      materializedFromCandidate({ ...candidate, title: 'Otro título' }),
    );

    expect(repriced).not.toBe(base);
    expect(retitled).not.toBe(base);
    expect(retitled).not.toBe(repriced);
  });

  it('treats absent and null optional fields alike', () => {
    const withoutDescription = materializedFromCandidate({
      ...candidate,
      description: undefined,
    });

    expect(withoutDescription.description).toBeNull();
  });
});