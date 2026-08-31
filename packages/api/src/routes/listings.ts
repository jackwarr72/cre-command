import {
  LISTING_STATUSES,
  LISTING_TYPES,
  PROPERTY_TYPES,
  type ListingFilter,
} from '@cre/shared';
import type { FastifyInstance } from 'fastify';

import { createAuthGuards } from '../auth/hooks';
import { ApiError } from '../errors';
import { parsePageQuery } from '../pagination';
import type { AppDeps } from '../ports';
import { csvList, enumCsv, numberParam } from '../params';

/** Maps flat query params (arrays comma-separated) onto a `ListingFilter`. */
export function parseListingFilter(query: Record<string, unknown>): ListingFilter {
  const filter: ListingFilter = {};
  const q = query['q'];
  if (typeof q === 'string' && q.trim() !== '') filter.q = q.trim();

  filter.propertyTypes = enumCsv(query['propertyTypes'], PROPERTY_TYPES, 'propertyTypes');
  filter.listingTypes = enumCsv(query['listingTypes'], LISTING_TYPES, 'listingTypes');
  filter.statuses = enumCsv(query['statuses'], LISTING_STATUSES, 'statuses');
  filter.sourceKeys = csvList(query['sourceKeys']);
  filter.states = csvList(query['states']);
  filter.cities = csvList(query['cities']);

  const minPrice = numberParam(query['minPrice'], 'minPrice');
  if (minPrice !== undefined) filter.minPrice = minPrice;
  const maxPrice = numberParam(query['maxPrice'], 'maxPrice');
  if (maxPrice !== undefined) filter.maxPrice = maxPrice;

  const updatedSince = query['updatedSince'];
  if (typeof updatedSince === 'string' && updatedSince.trim() !== '') {
    const parsed = new Date(updatedSince);
    if (Number.isNaN(parsed.getTime())) {
      throw ApiError.badRequest('VALIDATION_ERROR', 'updatedSince must be an ISO datetime');
    }
    filter.updatedSince = parsed.toISOString();
  }
  return filter;
}

export function registerListingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(deps.sessions, deps.now);

  app.get('/listings', { preHandler: guards.requireAuth }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const { page, pageSize } = parsePageQuery(query);
    return deps.listings.search(parseListingFilter(query), page, pageSize);
  });

  app.get('/listings/:id', { preHandler: guards.requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const listing = await deps.listings.findById(id);
    if (!listing) {
      throw ApiError.notFound('NOT_FOUND', `no listing with id '${id}'`);
    }
    return listing;
  });
}