import type { CrawlOutcome } from '@cre/crawler';
import type { CrawlRunRow, SourceRow, UserRow } from '@cre/db';
import type {
  CrawlRun,
  CrawlRunWithMetrics,
  CrawlRunStatus,
  Listing,
  ListingFilter,
  Paged,
  RobotsPolicy,
  User,
  UserRole,
} from '@cre/shared';

/**
 * Operator-visible source view: the shared `CrawlerSource` identity fields
 * plus the crawl-policy fields the control panel manages.
 */
export interface SourceDto {
  id: string;
  key: string;
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  schedule: string;
  config: Record<string, unknown>;
  crawlAllowed: boolean;
  robotsPolicy: RobotsPolicy;
  rateLimitMs: number;
  maxWorkers: number;
  authenticationRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export type UserDto = User;
export type ListingDto = Listing;
export type CrawlRunDto = CrawlRun;

/** Fields an operator may change on a source's crawl policy. */
export interface SourcePolicyPatch {
  enabled?: boolean;
  crawlAllowed?: boolean;
  robotsPolicy?: RobotsPolicy;
  rateLimitMs?: number;
  maxWorkers?: number;
}

export interface UserRepo {
  count(): Promise<number>;
  findByEmail(email: string): Promise<UserRow | null>;
  /** Returns the user's MFA configuration. Opaque to callers — secrets never leave the port. */
  findMfaConfig(userId: string): Promise<UserMfaConfig>;
  create(
    input: { email: string; displayName?: string; role: UserRole; passwordHash: string },
    now: Date,
  ): Promise<UserRow>;
  /**
   * Updates the user's remaining MFA recovery codes after one has been consumed.
   * Called by the auth flow when a recovery code is successfully used.
   */
  updateMfaRecoveryCodes(userId: string, remainingCodes: string[]): Promise<void>;
}

export interface SessionRepo {
  create(input: { userId: string; tokenHash: string; expiresAt: Date }, now: Date): Promise<void>;
  /** Resolves the session's user when the hash matches an unexpired session. */
  findActive(tokenHash: string, now: Date): Promise<{ user: UserRow; expiresAt: Date } | null>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  /** Deletes sessions whose `expiresAt` has passed; returns rows removed. */
  deleteExpired(now: Date): Promise<number>;
}

/**
 * In-memory challenge store for the MFA second step of `/auth/login`.
 *
 * A challenge is created on the first password-valid request when the user
 * requires MFA, and consumed when the client submits the TOTP code. Challenges
 * are short-lived (default 5 minutes) and single-use. They are not persisted
 * to the database — a process restart invalidates all outstanding challenges,
 * which is acceptable for an internal control panel.
 */
export interface MfaChallengeRepo {
  create(input: { userId: string; expiresAt: Date }, now: Date): Promise<string>;
  consume(challengeId: string, now: Date): Promise<{ userId: string } | null>;
  deleteExpired(now: Date): Promise<number>;
}

export interface UserMfaConfig {
  /** When true the user must present a valid `mfaCode` to complete login. */
  mfaEnabled: boolean;
  /**
   * The TOTP secret used to validate the submitted code. The implementation
   * compares a TOTP derived from this secret against the user-supplied code.
   * Stored alongside the user row in production; the fake returns a constant.
   */
  mfaSecret?: string;
  /**
   * bcrypt-hashed one-time recovery codes. Each code can only be used once.
   * An empty array means no recovery codes are available.
   */
  mfaRecoveryCodes?: string[];
}

export interface ListingQueryRepo {
  search(filter: ListingFilter, page: number, pageSize: number): Promise<Paged<Listing>>;
  findById(id: string): Promise<Listing | null>;
}

export interface SourceAdminRepo {
  list(): Promise<SourceRow[]>;
  findByKey(key: string): Promise<SourceRow | null>;
  updatePolicy(key: string, patch: SourcePolicyPatch, now: Date): Promise<SourceRow | null>;
}

export interface CrawlRunQueryRepo {
  list(
    filter: { sourceKey?: string; statuses?: CrawlRunStatus[] },
    page: number,
    pageSize: number,
  ): Promise<Paged<CrawlRunWithMetrics>>;
  findById(id: string): Promise<CrawlRunWithMetrics | null>;
  /** Returns the most recent N crawl runs for a source (newest first). */
  recentForSource(sourceKey: string, limit: number): Promise<CrawlRunWithMetrics[]>;
}

export interface SourceHealthRepo {
  /** Recent crawl runs for a source, newest first (max N from configured default). */
  recentRuns(sourceKey: string, limit: number): Promise<CrawlRunWithMetrics[]>;
}

/** Triggers a crawl against a configured source (production: @cre/crawler). */
export interface CrawlTrigger {
  hasAdapter(sourceKey: string): boolean;
  trigger(source: SourceRow, urls: readonly string[]): Promise<CrawlOutcome>;
}

/**
 * Server hardening options. Defaults are the secure ones (see
 * `DEFAULT_SECURITY` in app.ts); production configuration only ever widens
 * them deliberately (e.g. a CORS allowlist, higher rate caps).
 */
export interface SecurityOptions {
  /** Exact browser origins allowed cross-origin. Empty = same-origin only. */
  corsOrigins: string[];
  /** Global sliding-window cap: max requests per window per client IP. */
  rateLimitMax: number;
  /** Global sliding-window duration in milliseconds. */
  rateLimitWindowMs: number;
  /** Stricter per-IP cap for credential endpoints (login). */
  loginRateLimitMax: number;
  /** Maximum accepted JSON request body size in bytes. */
  bodyLimitBytes: number;
  /** Trust X-Forwarded-For from the reverse proxy when resolving client IPs. */
  trustProxy: boolean;
  /** Per-IP rate limit for MFA verification endpoint. */
  mfaVerifyRateLimitMax: number;
  /** Rate limit window for MFA verification in milliseconds. */
  mfaVerifyRateLimitWindowMs: number;
}

/** Everything the route handlers need; fakes or drizzle-backed implementations. */
export interface AppDeps {
  users: UserRepo;
  sessions: SessionRepo;
  mfaChallenges: MfaChallengeRepo;
  listings: ListingQueryRepo;
  sources: SourceAdminRepo;
  crawlRuns: CrawlRunQueryRepo;
  health: SourceHealthRepo;
  crawl: CrawlTrigger;
  /** Bearer session lifetime in hours. Default 168 (7 days). */
  sessionTtlHours?: number;
  /** MFA challenge TTL in milliseconds. Default 300000 (5 minutes). */
  mfaChallengeTtlMs?: number;
  /** Server hardening options; omitted fields fall back to secure defaults. */
  security?: Partial<SecurityOptions>;
  /** Pino log level when logging is enabled. Default 'info'. */
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** Injectable clock (tests). Default wall clock. */
  now?: () => Date;
  /** Pino logging config. Default off (tests); on in production. */
  logger?: boolean;
  /**
   * Injectable log destination (tests): a pino-compatible stream capturing
   * the serialized log lines so redaction can be asserted without writing
   * to stdout.
   */
  loggerStream?: { write(msg: string): void };
}