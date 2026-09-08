/**
 * Shared guard for live-service integration suites.
 *
 * Contract:
 * - Locally, integration suites skip themselves when the service env var is
 *   unset (developer-friendly, mirrors `describe.skipIf`).
 * - In CI, `CRE_ENFORCE_INTEGRATION=1` turns a missing/unreachable service
 *   into a hard failure at suite collection — a skipped integration suite
 *   must never look green in the pipeline.
 */
export function requireServiceEnv(service: string, envVar: string): string | undefined {
  const value = process.env[envVar]?.trim() || undefined;
  if (!value && process.env.CRE_ENFORCE_INTEGRATION === '1') {
    throw new Error(
      `CRE_ENFORCE_INTEGRATION=1 but ${envVar} is not set: the ${service} integration ` +
        `suite cannot run and must not be silently skipped. Start ${service} and export ` +
        `${envVar} (the CI workflow does this via service containers), or unset ` +
        `CRE_ENFORCE_INTEGRATION for local runs that skip instead.`,
    );
  }
  return value;
}