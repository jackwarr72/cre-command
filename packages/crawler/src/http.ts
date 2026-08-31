/**
 * @cre/crawler — HTTP transport.
 *
 * The first (and only) place HTTP belongs in the pipeline. The transport is
 * deliberately boring and strictly bounded:
 *
 * - explicit, honest user agent on every request
 * - per-attempt timeout (abort)
 * - bounded response size (content-length precheck + streamed read)
 * - bounded retries with exponential backoff, only for retryable failures
 *   (timeouts, 429, 5xx); `retry-after` on 429 is honored (capped)
 * - rate limiting applied once per logical request
 * - no authentication, no cookies, no CAPTCHA/anti-bot/paywall bypass
 *
 * Fetching stays separate from parsing: callers receive plain `HttpResponse`s.
 */

import type { HttpClient, HttpResponse, RateLimiter } from './ports';
import { NoopRateLimiter, sleep, type SleepFn } from './rate-limit';

/** Explicit, honest user agent identifying the crawler. */
export const DEFAULT_USER_AGENT =
  'cre-command/0.1 (+respectful, robots-aware crawler; contact: operator)';

export interface HttpClientOptions {
  /** Explicit user agent sent with every request. */
  userAgent: string;
  /** Per-attempt timeout. Default 15s. */
  timeoutMs?: number;
  /** Response size cap. Default 2 MiB. */
  maxBytes?: number;
  /** Bounded retries for retryable failures. Default 2. */
  retries?: number;
  /** Base backoff between retries (exponential). Default 500ms. */
  retryBaseDelayMs?: number;
  /** Politeness delay applied once per logical request. */
  rateLimiter?: RateLimiter;
  /** Injectable transport (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests). */
  sleepFn?: SleepFn;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

/** Any HTTP-level failure the crawler must report, with retry semantics. */
export class HttpFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpFetchError';
  }
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpFetchError(
      `response for ${url} exceeds ${maxBytes} bytes (content-length ${declared})`,
      response.status,
      false,
    );
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpFetchError(
        `response for ${url} exceeds ${maxBytes} bytes`,
        response.status,
        false,
      );
    }
    chunks.push(value);
  }
  const parts = chunks.map((chunk) => decoder.decode(chunk, { stream: true }));
  parts.push(decoder.decode());
  return parts.join('');
}

export class FetchHttpClient implements HttpClient {
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly rateLimiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepFn: SleepFn;

  constructor(options: HttpClientOptions) {
    this.userAgent = options.userAgent;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.rateLimiter = options.rateLimiter ?? new NoopRateLimiter();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepFn = options.sleepFn ?? sleep;
  }

  async get(url: string): Promise<HttpResponse> {
    await this.rateLimiter.acquire();
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.attemptOnce(url);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof HttpFetchError && error.retryable;
        if (!retryable || attempt === this.retries) break;
        const retryAfter = error instanceof HttpFetchError ? error.retryAfterMs : undefined;
        await this.sleepFn(retryAfter ?? this.retryBaseDelayMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  private async attemptOnce(url: string): Promise<HttpResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new HttpFetchError(
          `HTTP ${response.status} for ${url}`,
          response.status,
          retryable,
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      const body = await readBounded(response, this.maxBytes, url);
      return {
        status: response.status,
        url: response.url || url,
        body,
        headers: Object.fromEntries(response.headers),
      };
    } catch (error) {
      if (error instanceof HttpFetchError) throw error;
      if (timedOut) {
        throw new HttpFetchError(`timeout after ${this.timeoutMs}ms for ${url}`, undefined, true);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HttpFetchError(`request aborted for ${url}`, undefined, true);
      }
      throw new HttpFetchError(
        `fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        false,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

