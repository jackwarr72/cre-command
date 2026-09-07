/**
 * Listings API endpoints.
 *
 * GET /api/listings       → Paged<Listing>  (paginated, filtered search)
 * GET /api/listings/:id   → Listing         (single record by id)
 *
 * The API accepts array-valued filters as comma-separated query params,
 * e.g. `?statuses=active,sold&sourceKeys=vivanuncios,idealista`.
 */
import type { Listing, ListingFilter, Paged } from '@cre/shared';

import { apiRequest } from './client';

export const listingsApi = {
  search: (
    filter: ListingFilter,
    page: number,
    pageSize: number,
  ): Promise<Paged<Listing>> =>
    apiRequest('/listings', {
      query: { page, pageSize, ...filter },
    }),

  get: (id: string): Promise<Listing> =>
    apiRequest(`/listings/${encodeURIComponent(id)}`),
};
