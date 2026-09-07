/**
 * Redis-backed MFA challenge store for horizontal scaling.
 *
 * Unlike the in-memory store, this persists challenges across process restarts
 * and can be shared between multiple API instances behind a load balancer.
 *
 * Keys are structured as: mfa:challenge:{challengeId}
 * Values are JSON: { userId, expiresAt }
 *
 * TTL is set on each key to match the challenge expiry, so Redis handles
 * automatic cleanup without needing a background prune interval.
 */
import { randomBytes } from 'node:crypto';

import type { MfaChallengeRepo } from '../ports';

const CHALLENGE_KEY_PREFIX = 'mfa:challenge:';
const CHALLENGE_TTL_MS = 5 * 60_000; // 5 minutes

export class RedisMfaChallengeRepo implements MfaChallengeRepo {
  constructor(
    private readonly redis: RedisClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async create(input: { userId: string; expiresAt: Date }, now: Date = this.clock()): Promise<string> {
    const challengeId = randomBytes(24).toString('hex');
    const key = `${CHALLENGE_KEY_PREFIX}${challengeId}`;
    const record = {
      userId: input.userId,
      expiresAt: input.expiresAt.toISOString(),
    };
    const ttlSeconds = Math.max(1, Math.ceil((input.expiresAt.getTime() - now.getTime()) / 1000));
    await this.redis.set(key, JSON.stringify(record), { ex: ttlSeconds });
    return challengeId;
  }

  async consume(challengeId: string, now: Date = this.clock()): Promise<{ userId: string } | null> {
    const key = `${CHALLENGE_KEY_PREFIX}${challengeId}`;
    const data = await this.redis.get(key);
    if (!data) return null;

    let record: { userId: string; expiresAt: string };
    try {
      record = JSON.parse(data);
    } catch {
      return null;
    }

    // Delete immediately (single-use)
    await this.redis.del(key);

    const expiresAt = new Date(record.expiresAt);
    if (expiresAt.getTime() <= now.getTime()) return null;

    return { userId: record.userId };
  }

  async deleteExpired(now: Date = this.clock()): Promise<number> {
    // Redis TTL handles expiry automatically - this is a no-op for Redis-backed storage.
    // Included for interface compatibility.
    void now;
    return 0;
  }
}

/**
 * Minimal Redis client interface for the MFA challenge store.
 * Supports ioredis, node-redis, or any compatible client.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<void>;
  del(key: string): Promise<number>;
}

export const MFA_CHALLENGE_TTL_MS = CHALLENGE_TTL_MS;
