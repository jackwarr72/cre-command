/**
 * @cre/crawler — robots.txt handling (RFC 9309, pragmatic subset).
 *
 * Policy semantics (deliberately explicit, fail closed):
 *
 * - `allow`  — crawling pre-authorized by the operator; robots.txt is not
 *              consulted (first-party APIs/feeds).
 * - `honor`  — fetch robots.txt and obey it. A missing file (4xx except
 *              401/403/429) means "no restrictions" per RFC 9309 and is
 *              allowed. Anything indeterminate (network error, 5xx, 401,
 *              403, 429, HTML error page) is DENIED — ambiguity never
 *              silently becomes permission.
 * - `strict` — like `honor`, but a retrievable, parseable robots.txt that
 *              permits the path is REQUIRED: even a missing robots.txt
 *              fails closed.
 */

import type { RobotsPolicy } from '@cre/shared';
import { HttpFetchError } from './http';
import { systemClock, type Clock } from './ports';
import type { HttpClient, RobotsChecker, RobotsDecision, RobotsDecisionReason } from './ports';

/** Product token used for robots.txt group selection (RFC 9309). */
export const CRAWLER_PRODUCT_TOKEN = 'cre-command';

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export type RobotsInfo =
  | { kind: 'parsed'; groups: RobotsGroup[] }
  /** 4xx (except 401/403/429): RFC 9309 — no restrictions available. */
  | { kind: 'missing' }
  /** Unreachable, unauthorized, server error, or HTML error page. */
  | { kind: 'indeterminate' };

/**
 * Parse robots.txt: consecutive `User-agent` lines share a group; rules
 * attach to the most recent group; comments are stripped; `Crawl-delay`,
 * `Sitemap`, and unknown fields are ignored.
 */
export function parseRobots(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) continue; // rule before any user-agent — malformed, ignore
      current.rules.push({ type: field === 'allow' ? 'allow' : 'disallow', path: value });
      lastWasAgent = false;
    }
  }
  return groups;
}

/** RFC 9309 pattern matching: `*` wildcard, `$` end anchor. */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/**
 * Select the most specific group for our product token (longest matching
 * agent string wins), falling back to the `*` group.
 */
export function selectRobotsGroup(groups: RobotsGroup[]): RobotsGroup | null {
  const token = CRAWLER_PRODUCT_TOKEN.toLowerCase();
  const matches = groups
    .map((group) => ({
      group,
      agent: group.agents
        .filter((a) => a.includes(token))
        .sort((a, b) => b.length - a.length)[0],
    }))
    .filter((m): m is { group: RobotsGroup; agent: string } => m.agent !== undefined);
  if (matches.length > 0) {
    return matches.reduce((best, m) => (m.agent.length > best.agent.length ? m : best)).group;
  }
  return groups.find((group) => group.agents.includes('*')) ?? null;
}

/**
 * Decide whether `url` is permitted by the parsed rules: longest matching
 * pattern wins; ties are broken toward the more restrictive (Disallow);
 * an empty `Disallow:` value restricts nothing.
 */
export function isPathAllowed(groups: RobotsGroup[], url: string): boolean {
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return false; // unparseable URL — fail closed
  }
  const group = selectRobotsGroup(groups);
  if (!group) return true;
  const matching = group.rules.filter(
    (rule) => rule.path !== '' && robotsPatternMatches(rule.path, path),
  );
  if (matching.length === 0) return true;
  const best = matching.reduce((a, b) => {
    if (b.path.length !== a.path.length) return b.path.length > a.path.length ? b : a;
    return b.type === 'disallow' && a.type !== 'disallow' ? b : a;
  });
  return best.type === 'allow';
}

/** Heuristic: an HTML document where robots.txt should be — an error page. */
function looksLikeHtml(body: string): boolean {
  return /^\s*(?:\ufeff)?</.test(body);
}

export interface HttpRobotsCheckerOptions {
  /** Cache TTL per origin. Default 1h. */
  ttlMs?: number;
  clock?: Clock;
}

export class HttpRobotsChecker implements RobotsChecker {
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly cache = new Map<string, { at: number; info: RobotsInfo }>();

  constructor(
    private readonly http: HttpClient,
    options: HttpRobotsCheckerOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.clock = options.clock ?? systemClock;
  }

  async isAllowed(url: string, policy: RobotsPolicy): Promise<RobotsDecision> {
    if (policy === 'allow') {
      return { allowed: true, reason: 'policy_allow' };
    }
    const info = await this.robotsInfoFor(url);
    if (policy === 'honor') {
      if (info.kind === 'parsed') {
        return isPathAllowed(info.groups, url)
          ? { allowed: true, reason: 'rules_allow' }
          : { allowed: false, reason: 'rules_disallow' };
      }
      if (info.kind === 'missing') {
        // RFC 9309: absent robots.txt ⇒ no restrictions. Definitive, not ambiguous.
        return { allowed: true, reason: 'rules_allow' };
      }
      return { allowed: false, reason: 'robots_unavailable' };
    }
    // strict: a retrievable, parseable robots.txt permitting the path is required
    if (info.kind === 'missing') {
      return { allowed: false, reason: 'robots_missing_strict' };
    }
    if (info.kind === 'indeterminate') {
      return { allowed: false, reason: 'robots_unavailable' };
    }
    return isPathAllowed(info.groups, url)
      ? { allowed: true, reason: 'rules_allow' }
      : { allowed: false, reason: 'rules_disallow' };
  }

  private async robotsInfoFor(url: string): Promise<RobotsInfo> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { kind: 'indeterminate' };
    }
    const cached = this.cache.get(origin);
    const now = this.clock.now().getTime();
    if (cached && now - cached.at < this.ttlMs) return cached.info;
    const info = await this.fetchRobots(origin);
    this.cache.set(origin, { at: now, info });
    return info;
  }

  private async fetchRobots(origin: string): Promise<RobotsInfo> {
    const robotsUrl = new URL('/robots.txt', origin).toString();
    try {
      const response = await this.http.get(robotsUrl);
      if (looksLikeHtml(response.body)) return { kind: 'indeterminate' };
      return { kind: 'parsed', groups: parseRobots(response.body) };
    } catch (error) {
      if (error instanceof HttpFetchError && error.status !== undefined) {
        const { status } = error;
        const unavailable = status === 401 || status === 403 || status === 429 || status >= 500;
        if (!unavailable) return { kind: 'missing' };
      }
      return { kind: 'indeterminate' };
    }
  }
}

export type { RobotsDecisionReason };

