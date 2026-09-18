import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { listingCandidateSchema } from '@cre/shared';

import { vivanunciosMetepecAdapter } from '../src/sources/vivanuncios-metepec/adapter';

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/vivanuncios.html', import.meta.url)),
  'utf8',
);

describe('vivanunciosMetepecAdapter', () => {
  it('is registered under exactly vivanuncios_metepec', () => {
    expect(vivanunciosMetepecAdapter.sourceKey).toBe('vivanuncios_metepec');
  });

  it('implements the SourceAdapter contract (canHandle + parse)', () => {
    expect(typeof vivanunciosMetepecAdapter.canHandle).toBe('function');
    expect(typeof vivanunciosMetepecAdapter.parse).toBe('function');
    expect(
      vivanunciosMetepecAdapter.canHandle('https://www.vivanuncios.com.mx/s/oficinas-en-renta/'),
    ).toBe(true);
    expect(vivanunciosMetepecAdapter.canHandle('https://inmuebles24.com/')).toBe(false);
    expect(vivanunciosMetepecAdapter.canHandle('not a url')).toBe(false);
  });

  it('parses the shared fixture into candidates stamped with the metepec key', () => {
    const { candidates, errors } = vivanunciosMetepecAdapter.parse(fixture);

    expect(errors).toEqual([]);
    expect(candidates).toHaveLength(3);
    for (const candidate of candidates) {
      expect(candidate.sourceKey).toBe('vivanuncios_metepec');
      // Every candidate still satisfies the shared schema independently.
      expect(listingCandidateSchema.safeParse(candidate).success).toBe(true);
    }

    expect(candidates[0]).toMatchObject({
      sourceKey: 'vivanuncios_metepec',
      externalId: '422131234',
      propertyType: 'office',
      listingType: 'lease',
      price: { amount: 18500, currency: 'MXN' },
    });
  });
});

