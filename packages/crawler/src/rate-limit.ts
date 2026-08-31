/**
 * @cre/crawler — rate limiting.
 *
 * A tiny fixed-interval limiter. One instance per source guarantees at least
 * `intervalMs` between successive requests, honoring the source's
 * `rate_limit_ms` configuration. Injectable clock/sleep keep it testable
 * without real waiting.
 */

import type { RateLimiter } from './ports';
import { systemClock, type Clock } from './ports';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type SleepFn = (ms: number) => Promise<void>;

export class IntervalRateLimiter implements RateLimiter {
  private nextAllowedAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly clock: Clock = systemClock,
    private readonly sleepFn: SleepFn = sleep,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error(`invalid rate limit interval: ${intervalMs}`);
    }
  }

  async acquire(): Promise<void> {
    if (this.intervalMs === 0) return;
    const now = this.clock.now().getTime();
    const waitMs = this.nextAllowedAt - now;
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.intervalMs;
    if (waitMs > 0) await this.sleepFn(waitMs);
  }
}

export class NoopRateLimiter implements RateLimiter {
  async acquire(): Promise<void> {}
}
