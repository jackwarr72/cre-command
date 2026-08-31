import type { PriceUnit, SizeUnit } from '@cre/shared';

/**
 * Common (source-agnostic) normalization utilities.
 * Anything source-specific (URL paths, selector quirks) belongs in the
 * source adapter, not here.
 */

/** Collapse runs of whitespace to a single space and trim. */
export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Normalized text or `undefined` when the input is empty/whitespace. */
export function normalizeText(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const collapsed = collapseWhitespace(raw);
  return collapsed || undefined;
}

export interface ParsedPrice {
  amount: number;
  currency: string; // ISO 4217
  unit: PriceUnit;
}

/**
 * Parse a price string such as
 *   "MXN $ 18,500 /m²/mes" → { amount: 18500, currency: 'MXN', unit: 'sqm-month' }
 *   "$6,500,000"           → { amount: 6500000, currency: 'MXN', unit: 'total' }
 * Returns null when no usable amount is present.
 */
export function parsePrice(raw: string | null | undefined): ParsedPrice | null {
  const text = collapseWhitespace(raw ?? '');
  if (!text) return null;

  const lower = text.toLowerCase();

  let unit: PriceUnit = 'total';
  if (/(\/m²\/mes|\/m2\/mes|\/m²\/mo|\/m2\/mo|\/m²\/month)/.test(lower)) {
    unit = 'sqm-month';
  } else if (/(\/ft²\/mes|\/ft2\/mes|\/sqft\/mes)/.test(lower)) {
    unit = 'sqft-month';
  } else if (/(\/m²\/año|\/m2\/ano|\/m²\/yr|\/m²\/year)/.test(lower)) {
    unit = 'sqm-year';
  } else if (/\/(ft²|ft2|sqft)(\/|$)/.test(lower)) {
    unit = 'sqft';
  } else if (/(\/m²|\/m2)(\/|$)/.test(lower)) {
    unit = 'sqm';
  } else if (/(\/mes|\/month|\/mensual)/.test(lower)) {
    unit = 'month';
  }

  let currency = 'MXN';
  if (/\busd\b|us\$/i.test(text)) currency = 'USD';
  else if (/\beur\b|€/.test(text)) currency = 'EUR';

  const cleaned = text.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  const amount = Number(cleaned.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  return { amount, currency, unit };
}

export interface ParsedSize {
  value: number;
  unit: SizeUnit;
}

/**
 * Parse a size string such as "2,300 m²", "280 m²", "2.5 ha" or "25 acres".
 * Hectares are converted to square metres (1 ha = 10 000 m²).
 */
export function parseSize(raw: string | null | undefined): ParsedSize | null {
  if (!raw) return null;
  const text = collapseWhitespace(raw);
  const lower = text.toLowerCase();

  let unit: SizeUnit | null = null;
  let multiplier = 1;

  if (/(m²|m2|mts2|metros cuadrados)/.test(lower)) unit = 'sqm';
  else if (/(ft²|ft2|sqft|pies cuadrados)/.test(lower)) unit = 'sqft';
  else if (/(acre|acres)/.test(lower)) unit = 'acre';
  else if (/(ha|hectar)/.test(lower)) {
    unit = 'sqm';
    multiplier = 10_000;
  }

  if (!unit) return null;

  // Extract the number that immediately precedes the unit keyword
  // (e.g. "280 m2" → 280, not 2802).
  const unitMatch = lower.match(/(m²|m2|mts2|metros cuadrados|ft²|ft2|sqft|pies cuadrados|acre|acres|ha|hectar)/);
  if (!unitMatch) return null;
  const before = text.slice(0, unitMatch.index);
  const numMatch = before.match(/(\d[\d.,]*)\s*$/);
  if (!numMatch) return null;

  const value = Number(numMatch[1].replace(/,/g, '')) * multiplier;
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit };
}

/** Resolve a (possibly relative) URL against a base. Returns undefined on failure. */
export function canonicalizeUrl(
  raw: string | null | undefined,
  base: string,
): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw.trim(), base).toString();
  } catch {
    return undefined;
  }
}

/** Parse a date to ISO 8601 UTC; returns undefined for unparseable input. */
export function parseDate(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}