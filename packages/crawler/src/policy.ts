/**
 * @cre/crawler — source policy gate.
 *
 * The single place where a source's *configuration* decides whether crawling
 * may happen at all. Adapters never make security/compliance decisions; the
 * transport never waives them. Fail closed: any prohibited configuration
 * results in a rejection with a machine-readable reason.
 */

import type { SourceRow } from '@cre/db';

export type CrawlRejectionReason =
  | 'source_not_found'
  | 'source_disabled'
  | 'crawl_not_allowed'
  | 'authentication_required';

export interface CrawlDecision {
  allowed: boolean;
  /** `allowed` when permitted; otherwise a machine-readable rejection reason. */
  reason: CrawlRejectionReason | 'allowed';
  message: string;
}

/**
 * Central decision of whether a source may be crawled.
 *
 * This is the configuration gate (`enabled` / `crawlAllowed` /
 * `authenticationRequired`); robots.txt and rate limiting are enforced
 * separately (RobotsChecker, HTTP transport) so no single component can
 * silently waive policy.
 *
 * Checks, in order (first rejection wins):
 *  1. unknown source         → `source_not_found`
 *  2. enabled = false        → `source_disabled`
 *  3. crawlAllowed = false   → `crawl_not_allowed`
 *  4. authenticationRequired → `authentication_required`
 *
 * The crawler never authenticates implicitly. A source marked
 * `authenticationRequired` is only ever crawlable through a dedicated,
 * explicitly authorized integration — never by attempting to bypass
 * authentication, CAPTCHAs, anti-bot controls, or paywalls.
 */
export function canCrawl(
  source: Pick<
    SourceRow,
    'key' | 'enabled' | 'crawlAllowed' | 'authenticationRequired'
  > | null,
): CrawlDecision {
  if (!source) {
    return {
      allowed: false,
      reason: 'source_not_found',
      message: 'source is not configured',
    };
  }
  if (!source.enabled) {
    return {
      allowed: false,
      reason: 'source_disabled',
      message: `source ${source.key} is disabled`,
    };
  }
  if (!source.crawlAllowed) {
    return {
      allowed: false,
      reason: 'crawl_not_allowed',
      message: `crawling is not permitted for ${source.key}`,
    };
  }
  if (source.authenticationRequired) {
    return {
      allowed: false,
      reason: 'authentication_required',
      message: `${source.key} requires authentication; implicit authenticated crawling is not permitted`,
    };
  }
  return { allowed: true, reason: 'allowed', message: 'source policy permits crawling' };
}
