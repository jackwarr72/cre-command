/**
 * Transport-contract tests for the API client (jsdom).
 *
 * Regression guard for a real production failure: `apiRequest` used to send
 * `Content-Type: application/json` on *every* request, including body-less ones
 * such as `POST /auth/logout`. Fastify rejects that with 400
 * `FST_ERR_CTP_EMPTY_JSON_BODY` ("Body cannot be empty when content-type is set
 * to 'application/json'"), which surfaced in the UI as a thrown `ApiError` from
 * `logout()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiRequest } from '../lib/api/client';

/** Minimal stand-in for the `Response` members `apiRequest` touches. */
function mockResponse(init: {
  status: number;
  statusText?: string;
  body?: unknown;
  contentLength?: string | null;
}): Response {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    statusText: init.statusText ?? '',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? (init.contentLength ?? null) : null,
    },
    json: async () => init.body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

/** The URL and init of the most recent `fetch` call. */
function lastFetch(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest transport', () => {
  it('sends no body and no JSON content-type for a body-less POST (logout)', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 204, contentLength: '0' }));

    await expect(apiRequest('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();

    const { url, init } = lastFetch();
    expect(url).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('sends a JSON content-type and serialised body when a body is given', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ status: 200, body: { token: 'abc', user: {}, expiresAt: 'x' } }),
    );

    await apiRequest('/auth/login', {
      method: 'POST',
      body: { email: 'operator@cre.test', password: 'secret' },
    });

    const { init } = lastFetch();
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ email: 'operator@cre.test', password: 'secret' }));
  });

  it('attaches the stored bearer token without inventing a content-type', async () => {
    localStorage.setItem('cre_auth_token', 'tok-123');
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: { id: 'usr-6' } }));

    await apiRequest('/auth/me');

    const { init } = lastFetch();
    expect(init.headers).toEqual({ Authorization: 'Bearer tok-123' });
  });

  it('serialises query parameters as CSV for arrays', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 200, body: { items: [] } }));

    await apiRequest('/listings', { query: { states: ['CDMX', 'Jalisco'], page: 2, empty: '' } });

    expect(lastFetch().url).toBe('/api/listings?states=CDMX%2CJalisco&page=2');
  });

  it('surfaces the API error envelope as an ApiError', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        status: 400,
        statusText: 'Bad Request',
        body: {
          error: {
            code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
            message: "Body cannot be empty when content-type is set to 'application/json'",
          },
        },
      }),
    );

    const failure = apiRequest('/auth/logout', { method: 'POST' });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({
      status: 400,
      code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
    });
  });
});
