import { describe, expect, it } from 'vitest';

import { HttpFetchError } from '../src/http';
import type { Clock, HttpClient, HttpResponse } from '../src/ports';
import {
  CRAWLER_PRODUCT_TOKEN,
  HttpRobotsChecker,
  isPathAllowed,
  parseRobots,
  robotsPatternMatches,
  selectRobotsGroup,
} from '../src/robots';

type RuleType = 'allow' | 'disallow';

function group(
  agents: string[],
  rules: Array<[RuleType, string]>,
): { agents: string[]; rules: Array<{ type: RuleType; path: string }> } {
  return { agents, rules: rules.map(([type, path]) => ({ type, path })) };
}

const ROBOTS_TXT = ['User-agent: *', 'Disallow: /admin', 'Allow: /admin/public'].join('\n');

describe('parseRobots', () => {
  it('attaches rules to consecutive user-agent lines as one group', () => {
    const groups = parseRobots(
      [
        'User-agent: cre-command',
        'User-agent: OtherBot',
        'Disallow: /private',
        'Allow: /public',
      ].join('\n'),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].agents).toEqual(['cre-command', 'otherbot']);
    expect(groups[0].rules).toEqual([
      { type: 'disallow', path: '/private' },
      { type: 'allow', path: '/public' },
    ]);
  });

  it('starts a new group once rules intervene; strips comments and blank lines', () => {
    const groups = parseRobots(
      [
        '# header comment',
        'User-agent: a-bot',
        'Disallow: /one  # trailing comment',
        '',
        'User-agent: *',
        'Disallow: /two',
      ].join('\n'),
    );

    expect(groups).toHaveLength(2);
    expect(groups[0].agents).toEqual(['a-bot']);
    expect(groups[0].rules).toEqual([{ type: 'disallow', path: '/one' }]);
    expect(groups[1].agents).toEqual(['*']);
    expect(groups[1].rules).toEqual([{ type: 'disallow', path: '/two' }]);
  });

  it('ignores sitemap/crawl-delay/unknown fields and rules before any group', () => {
    const groups = parseRobots(
      [
        'Disallow: /orphan',
        'Sitemap: https://x.test/sitemap.xml',
        'Crawl-delay: 5',
        'User-agent: bot',
        'Disallow: /ok',
      ].join('\n'),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].rules).toEqual([{ type: 'disallow', path: '/ok' }]);
  });

  it('preserves an empty Disallow value (it restricts nothing later)', () => {
    const groups = parseRobots('User-agent: *\nDisallow:');
    expect(groups[0].rules).toEqual([{ type: 'disallow', path: '' }]);
  });
});

describe('robotsPatternMatches', () => {
  it('matches plain prefixes', () => {
    expect(robotsPatternMatches('/private', '/private/x')).toBe(true);
    expect(robotsPatternMatches('/private', '/published')).toBe(false);
  });

  it('honors the * wildcard', () => {
    expect(robotsPatternMatches('/a*appliance', '/a/appliance')).toBe(true);
    expect(robotsPatternMatches('/a*appliance', '/abappliances')).toBe(true);
  });

  it('honors the $ anchor and escapes regex metacharacters', () => {
    expect(robotsPatternMatches('/path$', '/path')).toBe(true);
    expect(robotsPatternMatches('/path$', '/path/more')).toBe(false);
    expect(robotsPatternMatches('/a+b$', '/a+b')).toBe(true);
    expect(robotsPatternMatches('/a+b$', '/aab')).toBe(false);
  });
});

describe('selectRobotsGroup', () => {
  it('prefers a group for the crawler token over the * group', () => {
    const star = group(['*'], [['disallow', '/']]);
    const own = group(['cre-command'], [['disallow', '/admin']]);
    expect(CRAWLER_PRODUCT_TOKEN).toBe('cre-command');
    expect(selectRobotsGroup([star, own])).toBe(own);
  });

  it('picks the longest matching agent string', () => {
    const short = group(['cre-command'], [['disallow', '/short']]);
    const long = group(['cre-command-extended'], [['disallow', '/long']]);
    expect(selectRobotsGroup([short, long])?.rules[0].path).toBe('/long');
  });

  it('falls back to the * group and returns null when nothing matches', () => {
    const star = group(['*'], [['allow', '/']]);
    const other = group(['otherbot'], [['disallow', '/x']]);
    expect(selectRobotsGroup([other, star])).toBe(star);
    expect(selectRobotsGroup([other])).toBeNull();
  });
});

describe('isPathAllowed', () => {
  it('allows everything when no group applies', () => {
    expect(isPathAllowed([], 'https://x.test/a')).toBe(true);
    expect(isPathAllowed([group(['otherbot'], [['disallow', '/']])], 'https://x.test/a')).toBe(true);
  });

  it('allows paths with no matching rule and denies matching ones', () => {
    const groups = [group(['*'], [['disallow', '/admin']])];
    expect(isPathAllowed(groups, 'https://x.test/public')).toBe(true);
    expect(isPathAllowed(groups, 'https://x.test/admin/panel')).toBe(false);
  });

  it('lets the longest matching pattern win (RFC 9309)', () => {
    const groups = [group(['*'], [['disallow', '/x'], ['allow', '/x/y']])];
    expect(isPathAllowed(groups, 'https://x.test/x/y/z')).toBe(true);
    expect(isPathAllowed(groups, 'https://x.test/x/other')).toBe(false);
  });

  it('breaks equal-length ties toward Disallow', () => {
    const groups = [group(['*'], [['allow', '/tie'], ['disallow', '/tie']])];
    expect(isPathAllowed(groups, 'https://x.test/tie')).toBe(false);
  });

  it('treats an empty Disallow as restricting nothing and unparseable URLs as denied', () => {
    expect(isPathAllowed([group(['*'], [['disallow', '']])], 'https://x.test/anything')).toBe(true);
    expect(isPathAllowed([group(['*'], [['disallow', '/']])], 'not a url')).toBe(false);
  });
});

describe('HttpRobotsChecker', () => {
  class StubHttp implements HttpClient {
    readonly requested: string[] = [];
    constructor(private readonly behavior: (url: string) => HttpResponse) {}
    async get(url: string): Promise<HttpResponse> {
      this.requested.push(url);
      return this.behavior(url);
    }
  }

  const ok = (body: string): HttpResponse => ({
    status: 200,
    url: 'https://a.test/robots.txt',
    body,
    headers: {},
  });
  const failing = (error: Error): StubHttp =>
    new StubHttp(() => {
      throw error;
    });

  it('short-circuits policy=allow without any HTTP traffic', async () => {
    const http = failing(new Error('robots must not be fetched'));
    const checker = new HttpRobotsChecker(http);

    await expect(checker.isAllowed('https://a.test/listing/1', 'allow')).resolves.toEqual({
      allowed: true,
      reason: 'policy_allow',
    });
    expect(http.requested).toHaveLength(0);
  });

  it('applies parsed rules under honor and caches per origin', async () => {
    const http = new StubHttp(() => ok(ROBOTS_TXT));
    const checker = new HttpRobotsChecker(http);

    await expect(checker.isAllowed('https://a.test/public', 'honor')).resolves.toEqual({
      allowed: true,
      reason: 'rules_allow',
    });
    await expect(checker.isAllowed('https://a.test/admin/1', 'honor')).resolves.toEqual({
      allowed: false,
      reason: 'rules_disallow',
    });
    expect(http.requested).toEqual(['https://a.test/robots.txt']);
  });

  it('treats a missing robots.txt (4xx) as unrestricted under honor, denied under strict', async () => {
    const missing = () => new HttpFetchError('HTTP 404 for robots.txt', 404, false);

    const honor = new HttpRobotsChecker(failing(missing()));
    await expect(honor.isAllowed('https://a.test/x', 'honor')).resolves.toEqual({
      allowed: true,
      reason: 'rules_allow',
    });

    const strict = new HttpRobotsChecker(failing(missing()));
    await expect(strict.isAllowed('https://a.test/x', 'strict')).resolves.toEqual({
      allowed: false,
      reason: 'robots_missing_strict',
    });
  });

  it('fails closed when robots.txt is unavailable (5xx, network error, HTML page)', async () => {
    const serverError = failing(new HttpFetchError('HTTP 503 for robots.txt', 503, true));
    await expect(
      new HttpRobotsChecker(serverError).isAllowed('https://a.test/x', 'honor'),
    ).resolves.toEqual({ allowed: false, reason: 'robots_unavailable' });

    const networkError = failing(new Error('ECONNREFUSED'));
    await expect(
      new HttpRobotsChecker(networkError).isAllowed('https://a.test/x', 'honor'),
    ).resolves.toEqual({ allowed: false, reason: 'robots_unavailable' });

    const htmlPage = new StubHttp(() => ok('<html><body>error page</body></html>'));
    await expect(
      new HttpRobotsChecker(htmlPage).isAllowed('https://a.test/x', 'honor'),
    ).resolves.toEqual({ allowed: false, reason: 'robots_unavailable' });
  });

  it('under strict, applies the rules once robots.txt is retrievable', async () => {
    const checker = new HttpRobotsChecker(new StubHttp(() => ok(ROBOTS_TXT)));

    await expect(checker.isAllowed('https://a.test/admin/public', 'strict')).resolves.toEqual({
      allowed: true,
      reason: 'rules_allow',
    });
    await expect(checker.isAllowed('https://a.test/admin/1', 'strict')).resolves.toEqual({
      allowed: false,
      reason: 'rules_disallow',
    });
  });

  it('caches robots.txt per origin until the TTL expires', async () => {
    let t = 0;
    const clock: Clock = { now: () => new Date(t) };
    const http = new StubHttp(() => ok(ROBOTS_TXT));
    const checker = new HttpRobotsChecker(http, { clock, ttlMs: 3_600_000 });

    await checker.isAllowed('https://a.test/a', 'honor');
    await checker.isAllowed('https://a.test/b', 'honor');
    expect(http.requested).toHaveLength(1); // second call served from cache

    t = 3_600_000; // TTL elapsed → refetch
    await checker.isAllowed('https://a.test/c', 'honor');
    expect(http.requested).toHaveLength(2);
  });
});