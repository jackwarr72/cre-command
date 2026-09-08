/**
 * Environment-driven configuration with strict validation.
 *
 * Principles:
 * - Fail fast: an invalid value is a startup error, never a silent fallback.
 *   (A mistyped `CRE_SESSION_TTL_HOURS=abc` must not quietly become 168h.)
 * - Secure defaults: production locks CORS down to an explicit allowlist and
 *   enables rate limiting unless the operator explicitly raises the caps.
 * - Everything the app reads at runtime comes from here — no scattered
 *   `process.env` lookups elsewhere.
 */

function positiveInt(raw: string | undefined, fallback: number, field: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer (got '${raw}')`);
  }
  return parsed;
}

/** Session lifetime in hours, bounded to a sane range (1h … 90d). */
function sessionTtlHours(raw: string | undefined): number {
  const value = positiveInt(raw, 168, 'CRE_SESSION_TTL_HOURS');
  if (value > 24 * 90) {
    throw new Error('CRE_SESSION_TTL_HOURS must be at most 2160 (90 days)');
  }
  return value;
}

/**
 * CORS origin allowlist. `CORS_ORIGINS` is a comma-separated list of exact
 * origins (e.g. `https://app.example.com`). Empty means "same-origin only" —
 * browsers on the same origin need no CORS at all, and the web app normally
 * proxies /api through Next, so this is the safe production default. `*` is
 * rejected: it exists only to be misused.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const origins = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  for (const origin of origins) {
    if (origin === '*') {
      throw new Error(
        "CORS_ORIGINS: '*' is not allowed — list exact origins instead",
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS: '${origin}' is not a valid absolute origin`);
    }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`CORS_ORIGINS: '${origin}' must be a bare origin without path`);
    }
  }
  return [...new Set(origins)];
}

/** Parses a strict boolean env flag (`true`/`false`, case-insensitive). */
export function booleanFlag(raw: string | undefined, fallback: boolean, field: string): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${field} must be 'true' or 'false' (got '${raw}')`);
}

export interface ApiConfig {
  port: number;
  host: string;
  /** `production` enables fail-closed defaults (empty CORS allowlist, etc.). */
  nodeEnv: 'development' | 'production' | 'test';
  /** Exact origins allowed to call the API from a browser. Empty = same-origin. */
  corsOrigins: string[];
  /** Global sliding-window cap: max requests per time window per IP. */
  rateLimitMax: number;
  /** Global sliding-window duration in milliseconds. */
  rateLimitWindowMs: number;
  /** Stricter cap for credential endpoints (login) per IP. */
  loginRateLimitMax: number;
  /** Maximum accepted JSON request body size in bytes. */
  bodyLimitBytes: number;
  /**
   * Trust `X-Forwarded-For` from the reverse proxy when resolving client IPs
   * (rate-limit keys). Enable ONLY when the API is behind a proxy that sets
   * the header; otherwise clients can spoof their rate-limit identity.
   */
  trustProxy: boolean;
  /** Pino log level. */
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** Bootstrap credentials — only honored while the users table is empty. */
  adminEmail?: string;
  adminPassword?: string;
  /** Bearer session lifetime in hours. */
  sessionTtlHours: number;
  /** How often expired sessions are pruned, in milliseconds. 0 disables. */
  sessionPruneIntervalMs: number;
  /** Redis connection URL for distributed MFA challenge store. Omit for in-process store. */
  redisUrl?: string;
  /** 32-byte base64-encoded key for encrypting MFA TOTP secrets at rest. */
  mfaEncryptionKey?: string;
  /** MFA challenge TTL in milliseconds (default 5 minutes). */
  mfaChallengeTtlMs: number;
  /** Per-IP rate limit for MFA verification endpoint (TOTP submit). */
  mfaVerifyRateLimitMax: number;
  /** Rate limit window for MFA verification in milliseconds. */
  mfaVerifyRateLimitWindowMs: number;
}

const DEFAULT_BODY_LIMIT_BYTES = 1_048_576; // 1 MiB — the API accepts small JSON only
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 300;
const DEFAULT_LOGIN_RATE_LIMIT_MAX = 10;
const DEFAULT_SESSION_PRUNE_INTERVAL_MS = 3_600_000;
const DEFAULT_MFA_CHALLENGE_TTL_MS = 5 * 60_000;
const DEFAULT_MFA_VERIFY_RATE_LIMIT_MAX = 5;
const DEFAULT_MFA_VERIFY_RATE_LIMIT_WINDOW_MS = 60_000;

export { DEFAULT_MFA_CHALLENGE_TTL_MS };

function parseLogLevel(raw: string | undefined): ApiConfig['logLevel'] {
  const value = (raw ?? 'info').trim().toLowerCase();
  const allowed: ApiConfig['logLevel'][] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
  if (!(allowed as string[]).includes(value)) {
    throw new Error(`LOG_LEVEL must be one of ${allowed.join(', ')} (got '${raw}')`);
  }
  return value as ApiConfig['logLevel'];
}

/**
 * Loads and validates configuration. Throws `Error` with an operator-readable
 * message on any invalid value — the process must not start misconfigured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnvRaw = (env['NODE_ENV'] ?? 'development').trim().toLowerCase();
  if (nodeEnvRaw !== 'development' && nodeEnvRaw !== 'production' && nodeEnvRaw !== 'test') {
    throw new Error(`NODE_ENV must be development, production, or test (got '${nodeEnvRaw}')`);
  }

  const bootstrapEmail = env['CRE_ADMIN_EMAIL']?.trim() || undefined;
  const bootstrapPassword = env['CRE_ADMIN_PASSWORD']?.trim() || undefined;
  if (!!bootstrapEmail !== !!bootstrapPassword) {
    throw new Error(
      'CRE_ADMIN_EMAIL and CRE_ADMIN_PASSWORD must be set together (bootstrap admin is configured as a pair)',
    );
  }

  return {
    port: positiveInt(env['PORT'], 4000, 'PORT'),
    host: env['HOST']?.trim() || '0.0.0.0',
    nodeEnv: nodeEnvRaw,
    corsOrigins: parseCorsOrigins(env['CORS_ORIGINS']),
    rateLimitMax: positiveInt(env['RATE_LIMIT_MAX'], DEFAULT_RATE_LIMIT_MAX, 'RATE_LIMIT_MAX'),
    rateLimitWindowMs: positiveInt(
      env['RATE_LIMIT_WINDOW_MS'],
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      'RATE_LIMIT_WINDOW_MS',
    ),
    loginRateLimitMax: positiveInt(
      env['LOGIN_RATE_LIMIT_MAX'],
      DEFAULT_LOGIN_RATE_LIMIT_MAX,
      'LOGIN_RATE_LIMIT_MAX',
    ),
    bodyLimitBytes: positiveInt(
      env['BODY_LIMIT_BYTES'],
      DEFAULT_BODY_LIMIT_BYTES,
      'BODY_LIMIT_BYTES',
    ),
    logLevel: parseLogLevel(env['LOG_LEVEL']),
    adminEmail: bootstrapEmail,
    adminPassword: bootstrapPassword,
    sessionTtlHours: sessionTtlHours(env['CRE_SESSION_TTL_HOURS']),
    trustProxy: booleanFlag(env['TRUST_PROXY'], false, 'TRUST_PROXY'),
    sessionPruneIntervalMs: env['SESSION_PRUNE_INTERVAL_MS']?.trim() === '0'
      ? 0
      : positiveInt(
          env['SESSION_PRUNE_INTERVAL_MS'],
          DEFAULT_SESSION_PRUNE_INTERVAL_MS,
          'SESSION_PRUNE_INTERVAL_MS',
        ),
    redisUrl: env['REDIS_URL']?.trim() || undefined,
    mfaEncryptionKey: env['MFA_ENCRYPTION_KEY']?.trim() || undefined,
    mfaChallengeTtlMs: positiveInt(env['MFA_CHALLENGE_TTL_MS'], DEFAULT_MFA_CHALLENGE_TTL_MS, 'MFA_CHALLENGE_TTL_MS'),
    mfaVerifyRateLimitMax: positiveInt(
      env['MFA_VERIFY_RATE_LIMIT_MAX'],
      DEFAULT_MFA_VERIFY_RATE_LIMIT_MAX,
      'MFA_VERIFY_RATE_LIMIT_MAX',
    ),
    mfaVerifyRateLimitWindowMs: positiveInt(
      env['MFA_VERIFY_RATE_LIMIT_WINDOW_MS'],
      DEFAULT_MFA_VERIFY_RATE_LIMIT_WINDOW_MS,
      'MFA_VERIFY_RATE_LIMIT_WINDOW_MS',
    ),
  };
}