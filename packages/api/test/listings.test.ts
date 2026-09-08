import { describe, expect, it } from 'vitest';

import { buildTestHarness, createUser, login, makeListingRow } from './fakes';

/** Three listings across two sources; A/B observed last (newest first). */
function listingFixtures() {
  const listingA = makeListingRow({
    sourceId: 'src-1',
    title: 'Oficina en renta — Polanco',
    description: 'Clase A con estacionamiento',
    city: 'Ciudad de México',
    state: 'CDMX',
    priceAmount: '18500.00',
    priceCurrency: 'MXN',
    priceUnit: 'sqm-month',
    sizeValue: '2300.00',
    sizeUnit: 'sqm',
    lat: '19.4317646',
    lng: '-99.1911000',
    streetAddress: 'Av. Palmas 405',
    formattedAddress: 'Av. Palmas 405, Polanco',
    updatedAt: new Date('2025-06-03T00:00:00.000Z'),
    lastSeenAt: new Date('2025-06-03T00:00:00.000Z'),
    raw: { images: ['https://img.example.test/1.jpg'], contacts: [{ kind: 'broker', name: 'Ana' }] },
  });
  const listingB = makeListingRow({
    sourceId: 'src-2',
    title: 'Local comercial en venta — Monterrey',
    propertyType: 'retail',
    listingType: 'sale',
    city: 'Monterrey',
    state: 'NL',
    priceAmount: '5200000.00',
    priceCurrency: 'MXN',
    updatedAt: new Date('2025-06-02T00:00:00.000Z'),
    lastSeenAt: new Date('2025-06-02T00:00:00.000Z'),
  });
  const listingC = makeListingRow({
    sourceId: 'src-1',
    title: 'Bodega industrial en renta',
    propertyType: 'industrial',
    listingType: 'lease',
    state: 'Jalisco',
    updatedAt: new Date('2025-07-01T00:00:00.000Z'),
    lastSeenAt: new Date('2025-07-01T00:00:00.000Z'),
  });
  return { listingA, listingB, listingC };
}

async function harnessWithListings() {
  const { listingA, listingB, listingC } = listingFixtures();
  const h = await buildTestHarness({
    listings: [listingA, listingB, listingC],
    sourceKeysById: { 'src-1': 'vivanuncios', 'src-2': 'inmuebles24' },
  });
  await createUser(h.users);
  const token = await login(h.app);
  const headers = { authorization: `Bearer ${token}` };
  return { h, headers, listingA, listingB, listingC };
}

describe('GET /api/listings', () => {
  it('requires authentication', async () => {
    const { h } = await harnessWithListings();
    const response = await h.app.inject({ method: 'GET', url: '/api/listings' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('returns a Paged<Listing> shape, newest first, with source keys resolved', async () => {
    const { h, headers, listingC, listingB, listingA } = await harnessWithListings();
    const response = await h.app.inject({ method: 'GET', url: '/api/listings', headers });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      page: number;
      pageSize: number;
      total: number;
      items: Array<{ id: string; sourceKey: string }>;
    };
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
    expect(body.total).toBe(3);
    // Newest first: C (07-01) → A (06-03) → B (06-02).
    expect(body.items.map((item) => item.id)).toEqual([
      listingC.id,
      listingA.id,
      listingB.id,
    ]);
    const byId = new Map(body.items.map((item) => [item.id, item] as const));
    expect(byId.get(listingA.id)!.sourceKey).toBe('vivanuncios');
    expect(byId.get(listingB.id)!.sourceKey).toBe('inmuebles24');
  });

  it('free-text searches q across title/description/address', async () => {
    const { h, headers } = await harnessWithListings();
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { q: 'bodega' },
    });
    expect(response.json().total).toBe(1);
    expect(response.json().items[0].title).toContain('Bodega');
  });

  it('validates enum params — unknown values are a 400, not a silent drop', async () => {
    const { h, headers } = await harnessWithListings();
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { propertyTypes: 'office,castle' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.json().error.message).toContain('propertyTypes');
  });

  it('filters by price range and enum csv lists', async () => {
    const { h, headers } = await harnessWithListings();

    const priced = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { minPrice: '1000', maxPrice: '20000' },
    });
    expect(priced.json().total).toBe(1);
    expect(priced.json().items[0].title).toContain('Oficina');

    const types = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { listingTypes: 'sale' },
    });
    expect(types.json().total).toBe(1);
    expect(types.json().items[0].title).toContain('Local comercial');
  });

  it('filters by states and sourceKeys', async () => {
    const { h, headers } = await harnessWithListings();

    const byState = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { states: 'CDMX,NL' },
    });
    expect(byState.json().total).toBe(2);

    const bySource = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { sourceKeys: 'inmuebles24' },
    });
    expect(bySource.json().total).toBe(1);
    expect(bySource.json().items[0].title).toContain('Local comercial');
  });

  it('pages results and validates paging bounds', async () => {
    const { h, headers, listingB } = await harnessWithListings();

    const page2 = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { pageSize: '2', page: '2' },
    });
    expect(page2.json()).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page2.json().items).toHaveLength(1);
    // Page 1 held [C, A]; the only remaining item is B.
    expect(page2.json().items[0].id).toBe(listingB.id);

    const badPage = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { page: '0' },
    });
    expect(badPage.statusCode).toBe(400);

    const tooBig = await h.app.inject({
      method: 'GET',
      url: '/api/listings',
      headers,
      query: { pageSize: '1000' },
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it('returns a single listing mapped to the shared Listing DTO', async () => {
    const { h, headers, listingA } = await harnessWithListings();
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/listings/${listingA.id}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: listingA.id,
      sourceKey: 'vivanuncios',
      externalId: listingA.externalId,
      title: 'Oficina en renta — Polanco',
      propertyType: 'office',
      listingType: 'lease',
      status: 'active',
    });
    // Materialized columns → structured DTO fields.
    expect(body.price).toEqual({ amount: 18500, currency: 'MXN' });
    expect(body.geo).toEqual({ lat: 19.4317646, lng: -99.1911 });
    expect(body.address).toMatchObject({ city: 'Ciudad de México', country: 'MX' });
    // images/contacts round-trip through raw; scrapedAt comes from lastSeenAt.
    expect(body.images).toEqual(['https://img.example.test/1.jpg']);
    expect(body.contacts).toEqual([{ kind: 'broker', name: 'Ana' }]);
    expect(body.scrapedAt).toBe(new Date(listingA.lastSeenAt).toISOString());
    // Credentials-shaped fields never leak; this is a listing anyway.
    expect(body.passwordHash).toBeUndefined();
  });

  it('404s for an unknown listing id', async () => {
    const { h, headers } = await harnessWithListings();
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/listings/lst-does-not-exist',
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: "no listing with id 'lst-does-not-exist'", code: 'NOT_FOUND' },
    });
  });
});