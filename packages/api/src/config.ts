function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ApiConfig {
  port: number;
  host: string;
  /** Bootstrap credentials — only honored while the users table is empty. */
  adminEmail?: string;
  adminPassword?: string;
  /** Bearer session lifetime in hours. */
  sessionTtlHours: number;
}

/**
 * Environment-driven configuration with safe defaults:
 * port 4000 (the web app's API_ORIGIN target), 7-day sessions.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: positiveInt(env['PORT'], 4000),
    host: env['HOST'] ?? '0.0.0.0',
    adminEmail: env['CRE_ADMIN_EMAIL'],
    adminPassword: env['CRE_ADMIN_PASSWORD'],
    sessionTtlHours: positiveInt(env['CRE_SESSION_TTL_HOURS'], 168),
  };
}