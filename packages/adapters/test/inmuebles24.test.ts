import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { inmuebles24Adapter } from '../src/sources/inmuebles24/adapter';

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/inmuebles24.html', import.meta.url)),
  'utf8',
);

describe('inmuebles24Adapter', () => {
  it('can handle inmuebles24.com.mx URLs', () => {
    expect(inmuebles24Adapter.canHandle('https://www.inmuebles24.com.mx/inmueble/123')).toBe(true);
    expect(inmuebles24Adapter.canHandle('https://inmuebles24.com.mx/inmueble/456')).toBe(true);
    expect(inmuebles24Adapter.canHandle('https://www.inmuebles24.com.mx/')).toBe(false);
    expect(inmuebles24Adapter.canHandle('https://example.com/')).toBe(false);
  });

  it('parses listings from fixture', () => {
    const result = inmuebles24Adapter.parse(fixture);
    expect(result.errors).toHaveLength(0);
    expect(result.candidates).toHaveLength(2);
    
    // Check first candidate (casa en venta)
    const candidate1 = result.candidates[0];
    expect(candidate1.sourceKey).toBe('inmuebles24');
    expect(candidate1.externalId).toBe('504321987');
    expect(candidate1.title).toBe('Casa en venta de 3 recámaras en La Condesa');
    expect(candidate1.listingType).toBe('sale');
    expect(candidate1.propertyType).toBe('multifamily');
    expect(candidate1.address.city).toBe('Ciudad de México');
    expect(candidate1.address.state).toBe('CDMX');
    expect(candidate1.price?.amount).toBe(8500000);
    expect(candidate1.price?.currency).toBe('MXN');
    expect(candidate1.size).toBe(200);
    
    // Check second candidate (departamento en renta)
    const candidate2 = result.candidates[1];
    expect(candidate2.sourceKey).toBe('inmuebles24');
    expect(candidate2.externalId).toBe('503112456');
    expect(candidate2.title).toBe('Departamento en renta en Roma Norte');
    expect(candidate2.listingType).toBe('lease');
    expect(candidate2.propertyType).toBe('multifamily');
    expect(candidate2.address.city).toBe('Ciudad de México');
    expect(candidate2.address.state).toBe('CDMX');
    expect(candidate2.price?.amount).toBe(18000);
    expect(candidate2.price?.currency).toBe('MXN');
    expect(candidate2.price?.unit).toBe('month');
    expect(candidate2.size).toBe(65);
  });
});
