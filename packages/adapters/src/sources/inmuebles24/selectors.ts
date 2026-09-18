import type { ListingType, PropertyType } from '@cre/shared';

/**
 * Inmuebles24-specific selectors and vocabulary maps, isolated from the
 * normalization/parsing logic so HTML changes stay cheap to maintain.
 */

export const selectors = {
  /** Listing card container. */
  card: '.listing-card, .item-container, .posting',
  link: '.listing-link, .item-link, a[href*="/inmueble/"], a[href*="/propiedad/"]',
  title: '.listing-title, .item-title, h2, h3',
  price: '.listing-price, .item-price, .price',
  locationCity: '.listing-location-city, .item-location-city, .city',
  locationState: '.listing-location-state, .item-location-state, .state',
  size: '.listing-size, .item-size, .area, .meters',
  date: '.listing-date, .item-date',
  image: '.listing-image, .item-image, img',
  /** Attribute holding the source listing id. */
  externalIdAttr: 'data-id, data-listing-id, data-item-id',
  /** Attribute holding the publication timestamp. */
  dateAttr: 'datetime, data-date',
  imageAttr: 'src, data-src',
  baseUrl: 'https://www.inmuebles24.com.mx',
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
  'oficinas': 'office',
  'oficina': 'office',
  'locales': 'retail',
  'local': 'retail',
  'bodegas': 'industrial',
  'naves': 'industrial',
  'terrenos': 'land',
  'terreno': 'land',
  'departamentos': 'multifamily',
  'departamento': 'multifamily',
  'casas': 'multifamily',
  'casa': 'multifamily',
  'casas-en-venta': 'multifamily',
  'casas-en-renta': 'multifamily',
};
