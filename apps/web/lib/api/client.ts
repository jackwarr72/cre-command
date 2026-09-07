/**
 * @cre/web — API client foundation.
 *
 * A thin, type-safe wrapper around `fetch` that:
 *   - attaches the bearer token from localStorage on every request
 *   - serialises query parameters (arrays → CSV, booleans → "true"/"false")
 *   - deserialises the shared `ApiErrorBody` shape into a thrown `ApiError`
 *
 * Every endpoint module in `lib/api/` is built on top of `apiRequest`.
 */
import type { ApiErrorBody } from '@cre/shared';

/**
 * Thrown for any non-2xx response from the API.
 * Carries the HTTP status, optional machine-readable code, and human message.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  /** Query parameters. Arrays are serialised as comma-separated values. */
  query?: Record<string, string | number | boolean | undefined | null | (string | number)[]>;
}

/** Reads the bearer token from localStorage (client-side only, SSR-safe). */
export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cre_auth_token');
}

/** Serialises a params object into a `?…` query string. */
function buildQuery(
  params: Record<string, string | number | boolean | undefined | null | (string | number)[]> | undefined,
): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.append(key, value.join(','));
    } else if (typeof value === 'boolean') {
      search.append(key, value ? 'true' : 'false');
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Core request handler. All endpoint functions delegate to this.
 *
 * The path is relative to `/api` — the Next.js proxy rewrites `/api/*`
 * to the backend API server (see next.config.mjs).
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, query } = options;
  const url = `/api${path}${buildQuery(query)}`;

  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let code: string | undefined;
    let message: string = response.statusText || 'Request failed';
    try {
      const errorBody = (await response.json()) as ApiErrorBody;
      message = errorBody.error.message;
      code = errorBody.error.code;
    } catch {
      // No JSON body — keep status text as the message.
    }
    throw new ApiError(response.status, code, message);
  }

  // 204 No Content (e.g. logout) — nothing to parse.
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
