/**
 * In-memory MFA challenge store.
 *
 * Challenges are short-lived (default 5 minutes) and single-use. They are
 * created on the first password-valid login attempt when the user has MFA
 * enabled, and consumed when the client submits the TOTP code.
 *
 * The store is intentionally in-memory: a process restart invalidates all
 * outstanding challenges, which is acceptable for an internal control panel
 * and avoids the complexity of persisting transient cryptographic state.
 */
import { randomBytes } from 'node:crypto';

import type { MfaChallengeRepo } from '../ports';

const CHALLENGE_TTL_MS = 5 * 60_000; // 5 minutes
const PRUNE_INTERVAL_MS = 60_000; // sweep expired entries every minute

interface ChallengeRecord {
  userId: string;
  expiresAt: Date;
}

export class InMemoryMfaChallengeRepo implements MfaChallengeRepo {
  private readonly store = new Map<string, ChallengeRecord>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.pruneTimer = setInterval(() => this.deleteExpired(this.clock()), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  /** Cleans up the background timer; call on shutdown to avoid hanging the process. */
  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  async create(input: { userId: string; expiresAt: Date }, now: Date = this.clock()): Promise<string> {
    void input;
    void now;
    const challengeId = randomBytes(24).toString('hex');
    this.store.set(challengeId, { userId: input.userId, expiresAt: input.expiresAt });
    return challengeId;
  }

  async consume(challengeId: string, now: Date = this.clock()): Promise<{ userId: string } | null> {
    const record = this.store.get(challengeId);
    if (!record) return null;
    // Single-use: delete before validation so a replay can't succeed even if
    // the verification below throws.
    this.store.delete(challengeId);
    if (record.expiresAt.getTime() <= now.getTime()) return null;
    return { userId: record.userId };
  }

  async deleteExpired(now: Date = this.clock()): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.store) {
      if (record.expiresAt.getTime() <= now.getTime()) {
        this.store.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Test/inspection helper: total live challenges. */
  size(): number {
    return this.store.size;
  }
}

export const MFA_CHALLENGE_TTL_MS = CHALLENGE_TTL_MS;
