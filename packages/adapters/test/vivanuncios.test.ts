import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { listingCandidateSchema } from '@cre/shared';

import { vivanunciosAdapter } from '../src/sources/vivanuncios/adapter';

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/vivanuncios.html', import.meta.url)),
  'utf8',
);

const singleCard = (inner: string, dataId?: string) => `
<!DOCTYPE html><html><body>
  <div class="postings-container">
    <div class="posting"${dataId ? ` data-id="${dataId}"` : ''}>${inner}</div>
  </div>
</body></html>`;

const card = {
  title: (t: string) => `<div class="posting-title">${t}</div>`,
  price: (p: string) => `<div class="posting-price">${p}</div>`,
  city: (c: string, s = 'Ciudad de México') =>
    `<div class="posting-location"><span class="posting-location-city">${c}</span>, <span class="posting-location-state">${s}</span></div>`,
  size: (z: string) => `<div class="posting-details"><span class="posting-detail-size">${z}</span></div>`,
  link: (href: string) => `<a class="posting-link" href="${href}"></a>`,
};

describe('vivanunciosAdapter', () => {
  describe('canHandle', () => {
    it('accepts vivanuncios.com.mx URLs', () => {
      expect(vivanunciosAdapter.canHandle('https://www.vivanuncios.com.mx/s/oficinas-en-renta/')).toBe(true);
      expect(vivanunciosAdapter.canHandle('https://vivanuncios.com.mx/x')).toBe(true);
    });

    it('rejects other hosts and garbage', () => {
      expect(vivanunciosAdapter.canHandle('https://inmuebles24.com/')).toBe(false);
      expect(vivanunciosAdapter.canHandle('not a url')).toBe(false);
    });
  });

  it('parses the full fixture into three validated candidates', () => {
    const { candidates, errors } = vivanunciosAdapter.parse(fixture);

    expect(errors).toEqual([]);
    expect(candidates).toHaveLength(3);

    // Every candidate must independently satisfy the shared schema.
    for (const candidate of candidates) {
      expect(listingCandidateSchema.safeParse(candidate).success).toBe(true);
    }

    // Card order is preserved.
    expect(candidates.map((c) => c.externalId)).toEqual([
      '422131234',
      '419874123',
      '418002991',
    ]);
  });

  it('normalizes a full office-lease listing (card 1)', () => {
    const [first] = vivanunciosAdapter.parse(fixture).candidates;

    expect(first).toMatchObject({
      sourceKey: 'vivanuncios',
      externalId: '422131234',
      sourceUrl:
        'https://www.vivanuncios.com.mx/s/ofertas/oficinas-en-renta/ciudad-de-mexico/polanco/422131234',
      title: 'Oficina en renta de 2,300 m² en Polanco',
      description: 'Oficina clase A, recepción y estacionamiento. Dos niveles en torre corporativa.',
      propertyType: 'office',
      listingType: 'lease',
      price: { amount: 18500, currency: 'MXN' },
      priceUnit: 'sqm-month',
      size: { value: 2300, unit: 'sqm' },
      address: {
        city: 'Polanco',
        state: 'Ciudad de México',
        country: 'MX',
        formatted: 'Polanco, Ciudad de México',
      },
    });
    expect(first.listedAt).toBe('2026-08-28T10:00:00.000Z');
    expect(first.images).toEqual([
      'https://www.vivanuncios.com.mx/img/oficina-polanco-01.jpg',
    ]);
    expect(first.contacts).toEqual([]);
  });

  it('normalizes a sparse land-sale listing (card 2)', () => {
    const [, second] = vivanunciosAdapter.parse(fixture).candidates;

    expect(second).toMatchObject({
      sourceKey: 'vivanuncios',
      externalId: '419874123',
      propertyType: 'land',
      listingType: 'sale',
      price: { amount: 6500000, currency: 'MXN' },
      priceUnit: 'total',
      address: {
        city: 'Atlacomulco',
        state: 'Estado de México',
        country: 'MX',
        formatted: 'Atlacomulco, Estado de México',
      },
    });
    // Optional fields simply absent — never invented.
    expect(second.description).toBeUndefined();
    expect(second.size).toBeUndefined();
    expect(second.listedAt).toBeUndefined();
    expect(second.images).toEqual([]);
  });

  it('handles location normalization and currency defaults (card 3)', () => {
    const [, , third] = vivanunciosAdapter.parse(fixture).candidates;

    expect(third).toMatchObject({
      propertyType: 'retail',
      listingType: 'lease',
      price: { amount: 42000, currency: 'MXN' },
      priceUnit: 'month',
      size: { value: 280, unit: 'sqm' },
      address: { city: 'La Condesa', state: 'Ciudad de México' },
    });
  });
it('tolerates a malformed price without throwing', () => {
    const html = singleCard(
      card.link('/s/ofertas/oficinas-en-renta/x/999') +
        card.title('Aviso con precio mal formado') +
        card.price('@#$% NO PRICE !!!') +
        card.city('Centro'),
    );

    const { candidates, errors } = vivanunciosAdapter.parse(html);
    expect(errors).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].price).toBeUndefined();
    expect(candidates[0].priceUnit).toBeUndefined();
  });

  it('reports a card with no usable identifier instead of guessing', () => {
    const html = singleCard(
      card.link('/s/ofertas/oficinas-en-renta/') +
        card.title('Aviso sin id'),
    );

    const { candidates, errors } = vivanunciosAdapter.parse(html);
    expect(candidates).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/missing a usable identifier or URL/);
  });

  it('passes duplicate source IDs through (dedup is the crawler s job)', () => {
    const html = `
      <div class="postings-container">
        <div class="posting" data-id="dup-1">${card.link('/s/ofertas/terrenos-en-venta/a/dup-1')}${card.title('A')}${card.price('$100')}${card.city('X')}</div>
        <div class="posting" data-id="dup-1">${card.link('/s/ofertas/terrenos-en-venta/a/dup-1')}${card.title('B')}${card.price('$200')}${card.city('X')}</div>
      </div>`;

    const { candidates, errors } = vivanunciosAdapter.parse(html);
    expect(errors).toEqual([]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].externalId).toBe('dup-1');
    expect(candidates[1].externalId).toBe('dup-1');
    // The adapter must not silently merge — both are returned for crawler-level dedup.
    expect(new Set(candidates.map((c) => c.title))).toEqual(new Set(['A', 'B']));
  });

  it('recovers per-card: one bad card does not drop the rest', () => {
    const html = `
      <div class="postings-container">
        <div class="posting">${card.title('Bad card')}</div>
        <div class="posting" data-id="good-1">${card.link('/s/ofertas/locales-en-renta/x/good-1')}${card.title('Good card')}${card.price('$500')}${card.city('X')}</div>
      </div>`;

    const { candidates, errors } = vivanunciosAdapter.parse(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].externalId).toBe('good-1');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/missing a usable identifier or URL/);
  });

  it('returns no candidates and a diagnostic for unexpected HTML', () => {
    const { candidates, errors } = vivanunciosAdapter.parse(
      '<html><body><p>this is not a listings page</p></body></html>',
    );
    expect(candidates).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('no listing cards found on page');
  });

  it('uses the URL path as a fallback identifier', () => {
    const html = singleCard(
      card.link('/s/ofertas/terrenos-en-venta/estado-de-mexico/12345678') +
        card.title('Solo id en la URL'),
    );
    const { candidates } = vivanunciosAdapter.parse(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].externalId).toBe('12345678');
  });
});