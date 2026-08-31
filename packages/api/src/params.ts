import { ApiError } from './errors';

/** Parses a comma-separated query param into non-empty strings. */
export function csvList(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts : undefined;
}

/** Comma-separated enum param; unknown values are a 400, not a silent drop. */
export function enumCsv<A extends readonly string[]>(
  value: unknown,
  allowed: A,
  field: string,
): A[number][] | undefined {
  const parts = csvList(value);
  if (!parts) return undefined;
  for (const part of parts) {
    if (!(allowed as readonly string[]).includes(part)) {
      throw ApiError.badRequest('VALIDATION_ERROR', `${field}: unknown value '${part}'`);
    }
  }
  return parts as A[number][];
}

export function numberParam(value: unknown, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw ApiError.badRequest('VALIDATION_ERROR', `${field} must be a number`);
  }
  return parsed;
}