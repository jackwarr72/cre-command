import { describe, expect, it, vi } from 'vitest';

import { FetchHttpClient, HttpFetchError } from '../src/http';
import type { RateLimiter } from '../src/ports';
import { IntervalRateLimiter, NoopRateLimiter } from '../src/rate-limit';

const okResponse = (body = 'ok'): Response => new Response(body, { status: 200 });

/** Resolves with the rejection (or null when the promise resolves). */
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error) => error,
  );

describe('FetchHttpClient', () => {
  it('sends an honest user agent with GET and follows redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse('body'));
    const client = new FetchHttpClient({ userAgent: 'cre-test/1.0', fetchImpl });

    const response = await client.get('https://x.test/page');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://x.test/page');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('follow');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['user-agent']).toBe('cre-test/1.0');
    expect(headers.accept).toContain('text/html');
    expect(response).toMatchObject({ status: 200, url: 'https://x.test/page', body: 'body' });
  });

  it('does not retry non-retryable HTTP errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const client = new FetchHttpClient({ userAgent: 'ua', fetchImpl });

    const error = await errorOf(client.get('https://x.test/missing'));

    expect(error).toBeInstanceOf(HttpFetchError);
    expect(error).toMatchObject({ status: 404, retryable: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('retries 5xx with exponential backoff and eventually succeeds', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      attempts += 1;
      return attempts <= 2 ? new Response(null, { status: 503 }) : okResponse('recovered');
    });
    const client = new FetchHttpClient({
      userAgent: 'ua',
      retries: 2,
      retryBaseDelayMs: 500,
      fetchImpl,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.get('https://x.test/flaky')).resolves.toMatchObject({
      body: 'recovered',
    });
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('honors retry-after (capped) on 429', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(null, { status: 429, headers: { 'retry-after': '2' } });
      }
      return okResponse();
    });
    const client = new FetchHttpClient({
      userAgent: 'ua',
      retries: 1,
      fetchImpl,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(client.get('https://x.test/rate-limited')).resolves.toMatchObject({
      status: 200,
    });
    expect(sleeps).toEqual([2000]);
  });

  it('aborts attempts that exceed the timeout and reports retryable timeouts', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('This operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      });
    const client = new FetchHttpClient({ userAgent: 'ua', timeoutMs: 50, retries: 0, fetchImpl });

    await expect(client.get('https://x.test/slow')).rejects.toThrow(/timeout after 50ms/);
  }, 2000);

  it('rejects oversized responses via content-length before reading the body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response('x', { status: 200, headers: { 'content-length': String(2 * 1024 + 1) } }),
    );
    const client = new FetchHttpClient({ userAgent: 'ua', maxBytes: 1024, fetchImpl });

    const error = await errorOf(client.get('https://x.test/huge'));

    expect(error).toBeInstanceOf(HttpFetchError);
    expect(error).toMatchObject({ retryable: false });
    expect((error as Error).message).toContain('exceeds 1024 bytes');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('aborts reading when the streamed body exceeds the cap without content-length', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse('a'.repeat(10 * 1024)));
    const client = new FetchHttpClient({ userAgent: 'ua', maxBytes: 1024, fetchImpl });

    const error = await errorOf(client.get('https://x.test/streamed'));

    expect(error).toBeInstanceOf(HttpFetchError);
    expect(error).toMatchObject({ retryable: false });
  });

  it('applies the rate limiter once per logical request, not per attempt', async () => {
    let acquisitions = 0;
    const rateLimiter: RateLimiter = {
      acquire: async () => {
        acquisitions += 1;
      },
    };
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      attempts += 1;
      return attempts === 1 ? new Response(null, { status: 500 }) : okResponse();
    });
    const client = new FetchHttpClient({
      userAgent: 'ua',
      retries: 1,
      rateLimiter,
      fetchImpl,
      sleepFn: async () => {},
    });

    await expect(client.get('https://x.test/a')).resolves.toMatchObject({ status: 200 });
    expect(acquisitions).toBe(1);
    expect(attempts).toBe(2);
  });
});

describe('IntervalRateLimiter', () => {
  it('separates successive acquisitions by at least the interval', async () => {
    let t = 1_000;
    const clock = { now: () => new Date(t) };
    const sleeps: number[] = [];
    const limiter = new IntervalRateLimiter(500, clock, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });

    await limiter.acquire(); // first caller proceeds immediately
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([500, 500]);

    t += 10_000; // long idle period → the next request proceeds immediately
    await limiter.acquire();
    expect(sleeps).toEqual([500, 500]);
  });

  it('rejects invalid intervals; NoopRateLimiter never waits', async () => {
    expect(() => new IntervalRateLimiter(-1)).toThrow(/invalid rate limit interval/);
    await expect(new NoopRateLimiter().acquire()).resolves.toBeUndefined();
  });
});