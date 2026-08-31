import type { ListingType, PropertyType } from '@cre/shared';

/**
 * Vivanuncios-specific selectors and vocabulary maps, isolated from the
 * normalization/parsing logic so HTML changes stay cheap to maintain.
 */

export const selectors = {
  /** Listing card container. */
  card: '.posting',
  link: 'a.posting-link',
  title: '.posting-title',
  description: '.posting-description',
  price: '.posting-price',
  locationCity: '.posting-location-city',
  locationState: '.posting-location-state',
  size: '.posting-detail-size',
  date: '.posting-date',
  image: 'img.posting-image',
  /** Attribute holding the source listing id. */
  externalIdAttr: 'data-id',
  /** Attribute holding the publication timestamp. */
  dateAttr: 'datetime',
  imageAttr: 'src',
  baseUrl: 'https://www.vivanuncios.com.mx',
} as const;

/** URL path segment → listing operation type. */
export const listingTypeByPath: Record<string, ListingType> = {
  'en-venta': 'sale',
  venta: 'sale',
  'en-renta': 'lease',
  renta: 'lease',
  arriendo: 'lease',
};

/** URL path segment → property type. Unknown kinds default to `other`. */
export const propertyTypeByPath: Record<string, PropertyType> = {
  oficinas: 'office',
  'oficina-en-renta': 'office',
  'oficina-en-venta': 'office',
  locales: 'retail',
  local: 'retail',
  bodegas: 'industrial',
  'naves-industriales': 'industrial',
  terrenos: 'land',
  terreno: 'land',
  departamentos: 'multifamily',
  'departamento-en-renta': 'multifamily',
  'departamento-en-venta': 'multifamily',
  casas: 'multifamily',
  'casa-en-venta': 'multifamily',
  'casa-en-renta': 'multifamily',
};