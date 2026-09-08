/**
 * RedisMfaChallengeRepo unit tests backed by a fake Redis client.
 *
 * These pin the wire contract (key layout, TTL seconds, single-use consume,
 * expiry handling) without requiring a live Redis server; the live suite
 * (redis.integration.test.ts) repeats the same assertions against a real
 * server when REDIS_URL is configured..
 */
import { describe, expect, it } from 'vitest';

import {
  RedisMfaChallengeRepo,
  type RedisClient,
} from '../src/auth/redis-mfa-challenges';

const FIXED_NOW = new Date('2026-09-07T12:00:00.000Z');

class FakeRedis implements RedisClient {
  /** key → value (TTL is trustworthy for assertions; expiry is not enforced). */
  readonly store = new Map<string, { value: string; ex?: number }>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
    this.store.set(key, { value, ex: options?.ex });
  }

  async del(key: string): Promise<number> {
    const had = this.store.delete(key);
    return had ? 1 : 0;
  }
}

describe('RedisMfaChallengeRepo', () => {
  it('stores challenges under the mfa:challenge: prefix with a TTL matching expiry', async () => {
    const redis = new FakeRedis();
    const repo = new RedisMfaChallengeRepo(redis, () => FIXED_NOW);

    const expiresAt = new Date(FIXED_NOW.getTime() + 5 * 60_000);
    const challengeId = await repo.create({ userId: 'usr-1', expiresAt });
    expect(challengeId).toMatch(/^[0-9a-f]{48}$/);

    const [key] = [...redis.store.keys()];
    expect(key.startsWith('mfa:challenge:')).toBe(true);
    const record = redis.store.get(key)!;
    expect(record.ex).toBe(300);
    expect(JSON.parse(record.value)).toEqual({
      userId: 'usr-1',
      expiresAt: expiresAt.toISOString(),
    });
  });

  it('consumes a valid challenge exactly once and returns its userId', async () => {
    const redis = new FakeRedis();
    const repo = new RedisMfaChallengeRepo(redis, () => FIXED_NOW);

    const challengeId = await repo.create({
      userId: 'usr-7',
      expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
    });

    expect(await repo.consume(challengeId)).toEqual({ userId: 'usr-7' });
    expect(redis.store.size).toBe(0);
    // Single-use: the same id is gone.
    expect(await repo.consume(challengeId)).toBeNull();
  });

  it('returns null for unknown challenge ids', async () => {
    const repo = new RedisMfaChallengeRepo(new FakeRedis(), () => FIXED_NOW);
    expect(await repo.consume('mfa:challenge:nope')).toBeNull();
  });

  it('does not validate a challenge that has already expired', async () => {
    const redis = new FakeRedis();
    const repo = new RedisMfaChallengeRepo(redis, () => FIXED_NOW);

    const challengeId = await repo.create({
      userId: 'usr-9',
      expiresAt: new Date(FIXED_NOW.getTime() - 1),
    });

    expect(await repo.consume(challengeId)).toBeNull();
    // Consume deletes the key regardless of its validity (single-use cleanup).
    expect(redis.store.size).toBe(0);
  });

  it('treats corrupt payloads as missing challenges', async () => {
    const redis = new FakeRedis();
    const repo = new RedisMfaChallengeRepo(redis, () => FIXED_NOW);
    await redis.set('mfa:challenge:junk', 'not-json');
    expect(await repo.consume('junk')).toBeNull();
  });

  it('deleteExpired is a no-op for Redis (TTL handles expiry)', async () => {
    const redis = new FakeRedis();
    const repo = new RedisMfaChallengeRepo(redis, () => FIXED_NOW);
    await repo.create({ userId: 'u', expiresAt: new Date(FIXED_NOW.getTime() + 1) });
    expect(await repo.deleteExpired(FIXED_NOW)).toBe(0);
    expect(redis.store.size).toBe(1);
  });
});