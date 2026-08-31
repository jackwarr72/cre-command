/**
 * @cre/crawler — public surface.
 *
 * Composition root example (production):
 *
 *   const db = createDatabase(process.env.DATABASE_URL);
 *   const http = new FetchHttpClient({ userAgent: DEFAULT_USER_AGENT });
 *   const crawler = new Crawler({
 *     repositories: createPostgresRepositories(db),
 *     http,
 *     robots: new HttpRobotsChecker(http),
 *   });
 *   await crawler.crawl({ adapter: new VivanunciosAdapter(), urls: [...] });
 */

export * from './ports';
export * from './policy';
export * from './rate-limit';
export * from './http';
export * from './robots';
export * from './registry';
export * from './crawl';
export * from './fingerprint';
export * from './postgres/repositories';
