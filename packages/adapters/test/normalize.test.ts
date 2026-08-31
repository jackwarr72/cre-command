import { describe, expect, it } from 'vitest';

import {
  canonicalizeUrl,
  collapseWhitespace,
  normalizeText,
  parseDate,
  parsePrice,
  parseSize,
} from '../src/normalize';

describe('normalize', () => {
  describe('parsePrice', () => {
    it('parses metro-square monthly leases', () => {
      expect(parsePrice('MXN $ 18,500 /m²/mes')).toEqual({
        amount: 18500,
        currency: 'MXN',
        unit: 'sqm-month',
      });
    });

    it('parses total sale prices', () => {
      expect(parsePrice('$6,500,000')).toEqual({
        amount: 6500000,
        currency: 'MXN',
        unit: 'total',
      });
    });

    it('parses flat monthly rents', () => {
      expect(parsePrice('MXN $ 42,000 /mes')).toEqual({
        amount: 42000,
        currency: 'MXN',
        unit: 'month',
      });
    });

    it('detects USD', () => {
      expect(parsePrice('USD $ 10,000 /m²/año')).toEqual({
        amount: 10000,
        currency: 'USD',
        unit: 'sqm-year',
      });
    });

    it('parses per-square-foot variants', () => {
      expect(parsePrice('$ 20 /ft²/mes')).toEqual({
        amount: 20,
        currency: 'MXN',
        unit: 'sqft-month',
      });
      expect(parsePrice('$ 250 /ft²')).toEqual({
        amount: 250,
        currency: 'MXN',
        unit: 'sqft',
      });
    });

    it('returns null for empty / unparseable input', () => {
      expect(parsePrice('')).toBeNull();
      expect(parsePrice('@#$%')).toBeNull();
      expect(parsePrice(null)).toBeNull();
    });
  });

  describe('parseSize', () => {
    it('parses square metres', () => {
      expect(parseSize('2,300 m²')).toEqual({ value: 2300, unit: 'sqm' });
      expect(parseSize('280 m2')).toEqual({ value: 280, unit: 'sqm' });
    });

    it('converts hectares to square metres', () => {
      expect(parseSize('2.5 ha')).toEqual({ value: 25000, unit: 'sqm' });
    });

    it('parses acres', () => {
      expect(parseSize('25 acres')).toEqual({ value: 25, unit: 'acre' });
    });

    it('returns null for unparseable sizes', () => {
      expect(parseSize('13 estacionamientos')).toBeNull();
      expect(parseSize(undefined)).toBeNull();
    });
  });

  describe('URL / text / date helpers', () => {
    it('canonicalizes relative URLs against a base', () => {
      expect(canonicalizeUrl('/img/oficina.jpg', 'https://www.vivanuncios.com.mx')).toBe(
        'https://www.vivanuncios.com.mx/img/oficina.jpg',
      );
      expect(canonicalizeUrl(undefined, 'https://x.com')).toBeUndefined();
    });

    it('collapses whitespace', () => {
      expect(collapseWhitespace('  Oficina   en  renta \n Polanco ')).toBe(
        'Oficina en renta Polanco',
      );
      expect(normalizeText('   ')).toBeUndefined();
      expect(normalizeText(null)).toBeUndefined();
    });

    it('parses ISO dates and rejects garbage', () => {
      expect(parseDate('2026-08-28T10:00:00Z')).toBe('2026-08-28T10:00:00.000Z');
      expect(parseDate('Hace 2 días')).toBeUndefined();
      expect(parseDate('not-a-date')).toBeUndefined();
    });
  });
});