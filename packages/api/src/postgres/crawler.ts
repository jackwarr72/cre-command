import { vivanunciosAdapter } from '@cre/adapters';
import {
  AdapterRegistry,
  Crawler,
  createPostgresRepositories,
  DEFAULT_USER_AGENT,
  FetchHttpClient,
  HttpRobotsChecker,
} from '@cre/crawler';
import type { Database } from '@cre/db';

import type { CrawlTrigger } from '../ports';

/**
 * Production crawl trigger: the real bounded transport, robots compliance,
 * and postgres repositories — composed exactly as documented in @cre/crawler.
 * The crawler re-validates source policy and robots.txt at run time.
 */
export function createCrawlTrigger(db: Database): CrawlTrigger {
  const registry = new AdapterRegistry().register(vivanunciosAdapter);
  const http = new FetchHttpClient({ userAgent: DEFAULT_USER_AGENT });
  const crawler = new Crawler({
    repositories: createPostgresRepositories(db),
    http,
    robots: new HttpRobotsChecker(http),
  });

  return {
    hasAdapter: (sourceKey) => registry.get(sourceKey) !== undefined,
    async trigger(source, urls) {
      return crawler.crawl({ adapter: registry.require(source.key), urls: [...urls] });
    },
  };
}