/**
 * Live Redis integration suite for RedisMfaChallengeRepo.
 *
 * Skipped unless REDIS_URL is provided (mirrors the Postgres integration
 * suite; CRE_ENFORCE_INTEGRATION=1 turns a missing REDIS_URL into a hard
 * failure, which CI always sets). Exercises the real ioredis client wiring:
 * TTL-backed create, single-use consume, and expiry behavior over a real
 * server.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';

import { RedisMfaChallengeRepo, type RedisClient } from '../src/auth/redis-mfa-challenges';
import { requireServiceEnv } from '../../../test-support/integration';

const url = requireServiceEnv('Redis', 'REDIS_URL');
const SERVER_PREFIX = 'cre:mfa:test:';

describe.skipIf(!url)('redis MFA challenge integration', () => {
  let client: Redis;
  let repo: RedisMfaChallengeRepo;
  const now = (): Date => new Date();

  beforeAll(async () => {
    if (!url) return;
    client = new Redis(url, { lazyConnect: true });
    await client.connect();
    const redis: RedisClient = {
      get: (key) => client.get(key),
      set: (key, value, options) => {
        if (options?.ex) return client.set(key, value, 'EX', options.ex).then(() => undefined);
        return client.set(key, value).then(() => undefined);
      },
      del: (key) => client.del(key),
    };
    repo = new RedisMfaChallengeRepo(redis, now);
  });

  afterAll(async () => {
    client?.disconnect();
  });

  it('creates, consumes, and expires challenges', async () => {
    const challengeId = await repo.create({
      userId: 'usr-redis-1',
      expiresAt: new Date(now().getTime() + 60_000),
    });
    const key = `mfa:challenge:${challengeId}`;
    expect(await client.ttl(key)).toBeGreaterThan(0);
    expect(await client.get(key)).toContain('usr-redis-1');

    expect(await repo.consume(challengeId)).toEqual({ userId: 'usr-redis-1' });
    expect(await client.get(key)).toBeNull();

    // Unknown id → null.
    expect(await repo.consume('does-not-exist')).toBeNull();
  });

  it('never validates an already-expired challenge', async () => {
    const challengeId = await repo.create({
      userId: 'usr-redis-2',
      expiresAt: new Date(now().getTime() - 1000),
    });
    expect(await repo.consume(challengeId)).toBeNull();
  });

  it('cleans up all test keys created by this suite', async () => {
    const keys = await client.keys('mfa:challenge:*');
    for (const key of keys) await client.del(key);
    expect(await client.keys('mfa:challenge:*')).toEqual([]);
  });
});