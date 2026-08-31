import { ApiError } from './errors';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageQuery {
  page: number;
  pageSize: number;
}

function parsePositiveInt(raw: unknown, fallback: number, field: string, max?: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    const range = max === undefined ? '1 and above' : `1 and ${max}`;
    throw ApiError.badRequest('VALIDATION_ERROR', `${field} must be an integer between ${range}`);
  }
  return value;
}

/** Parses `page`/`pageSize` query params with validated, clamped defaults. */
export function parsePageQuery(query: Record<string, unknown>): PageQuery {
  return {
    page: parsePositiveInt(query['page'], 1, 'page'),
    pageSize: parsePositiveInt(
      query['pageSize'],
      DEFAULT_PAGE_SIZE,
      'pageSize',
      MAX_PAGE_SIZE,
    ),
  };
}