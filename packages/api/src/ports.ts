import type { CrawlOutcome } from '@cre/crawler';
import type { CrawlRunRow, SourceRow, UserRow } from '@cre/db';
import type {
  AuditAction,
  AuditLogEntry,
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
  /**
   * Persists the encrypted TOTP secret for a pending (unconfirmed) enrollment.
   * MFA stays disabled until `activateMfa` is called with a verified code.
   */
  saveMfaEnrollmentSecret(
    userId: string,
    input: EncryptedMfaSecret,
    now: Date,
  ): Promise<void>;
  /**
   * Atomically activates MFA for a user: flips `mfaEnabled` on, stores the
   * encrypted secret, the bcrypt-hashed recovery codes, and the verification
   * timestamp. Called only after the TOTP code has been verified against the
   * pending enrollment secret.
   */
  activateMfa(userId: string, input: ActivateMfaInput, now: Date): Promise<void>;
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
  /** When MFA was last successfully verified (enrollment completion, wall clock. */
  mfaVerifiedAt?: Date;
}

/** Persistable result of encrypting a TOTP secret at rest. */
export interface EncryptedMfaSecret {
  mfaSecretEncrypted: string;
  mfaSecretIv: string;
}

/** Persisted fields fora completed (activated) MFA enrollment. */
export interface ActivateMfaInput extends EncryptedMfaSecret {
  /** bcrypt-hashed one-time recovery codes to store on the user row. */
  hashedRecoveryCodes: string[];
  /** Verification instant used asthe enrollment/completion timestamp. */
  mfaVerifiedAt: Date;
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
  /** Create a new crawl run with status 'running'. Returns the run ID. */
  create(sourceId: string, startedAt: Date): Promise<string>;
  /** Create a queued crawl run with URLs stored for worker execution. */
  createQueued(input: {
    sourceId: string;
    requestedAt: Date;
    requestedByUserId: string | null;
    urls: readonly string[];
  }): Promise<string>;
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

// ── Audit trail ───────────────────────────────────────────────────

/** One auditable action. Extend the shared `AuditAction` union as needed. */
export interface AuditEvent {
  action: AuditAction;
  at: Date;
  actorUserId?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditLogFilter {
  action?: AuditAction;
  actorUserId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Append-only audit trail backed by the `audit_log` table. Callers must treat
 * `append` failures as non-fatal (log them) so auditing can never break the
 * operation it is recording.
 */
export interface AuditRepo {
  append(event: AuditEvent): Promise<void>;
  list(filter: AuditLogFilter, page: number, pageSize: number): Promise<Paged<AuditLogEntry>>;
}

/** Transactional outbox for job queuing. When a crawl run is triggered, an outbox
 * record is written in the same transaction as the crawl run. A background worker
 * polls this table and publishes jobs to the queue. If the worker crashes, records
 * remain and are retried — guaranteeing: a persisted queued crawl run will
 * eventually have a corresponding queue job, or is visibly recoverable as an
 * unpublished outbox record.
 */
export interface OutboxRepo {
  /** Create an outbox record with the given type and optional correlation ID. */
  create(type: string, payload: Record<string, unknown>, correlationId?: string): Promise<string>;
  /** Fetch pending records ready for processing. */
  popBatch(limit: number): Promise<Array<{ id: string; type: string; payload: Record<string, unknown>; correlationId?: string }>>;
  /** Mark an outbox record as processing. */
  markProcessing(id: string): Promise<void>;
  /** Record successful completion of an outbox job. */
  complete(id: string): Promise<void>;
  /** Record a permanent failure, keeping the record for manual inspection. */
  fail(id: string, error: string): Promise<void>;
  /** Retry a failed outbox record (increment attempt count). */
  retry(id: string): Promise<void>;
  /** Delete fully processed or expired outbox records. */
  cleanup(): Promise<number>;
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
  /** Append-only audit trail for security/policy actions. */
  audit: AuditRepo;
  /** Transactional outbox for job queuing — crawl triggers, CSV exports,
   *  scheduled crawls, notifications, CRM sync, SLA checks. */
  outbox: OutboxRepo;
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
  /** Development auth bypass (AUTH_BYPASS env var). */
  authBypass?: boolean;
  /** Current node environment (for bypass validation). */
  nodeEnv?: 'development' | 'production' | 'test';
}