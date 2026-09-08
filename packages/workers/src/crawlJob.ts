import type { AdapterRegistry } from '@cre/crawler';
import type { Database } from '@cre/db';
import type { OutboxRepo } from '@cre/api';
import { Crawler } from '@cre/crawler';
import { createPostgresRepositories } from '@cre/crawler';

export interface CrawlJobPayload {
  /** Outbox event id. */
  jobId: string;
  /** The crawl run to execute. */
  crawlRunId: string;
  /** The source that triggered this run. */
  sourceId: string;
  /** User who requested the crawl. */
  requestedByUserId: string | null;
  /** ISO timestamp when the crawl was requested. */
  requestedAt: string;
}

/**
 * Handles a single crawl job: claims the run, executes the crawler pipeline,
 * and publishes the result via the outbox.
 */
export class CrawlJobHandler {
  constructor(
    private readonly db: Database,
    private readonly adapterRegistry: AdapterRegistry,
    private readonly outbox: OutboxRepo,
  ) {}

  /** Build a Crawler instance with postgres-backed repositories. */
  private buildCrawler(): Crawler {
    return new Crawler({
      repositories: createPostgresRepositories(this.db),
      http: new (await import('@cre/crawler')).FetchHttpClient({
        userAgent: 'cre-crawler/1.0',
      }),
      robots: new (await import('@cre/crawler')).HttpRobotsChecker({
        httpClient: new (await import('@cre/crawler')).FetchHttpClient({
          userAgent: 'cre-crawler/1.0',
        }),
    });
  }

  async handle(job: CrawlJobPayload): Promise<void> {
    const { jobId, crawlRunId, sourceId, requestedByUserId, requestedAt } = job;

    const clock = { now: () => new Date() };

    const crawler = this.buildCrawler();

    const requestedAtDate = new Date(requestedAt);

    // Look up the crawl run and source from DB via the crawler's repositories
    const sourceRepo = crawler.options.repositories.sources;
    const source = await sourceRepo.findByKey(sourceId);

    if (!source) {
      throw new Error(`Source ${sourceId} not found`);
    }

    // Look up the URLs from the crawl run
    const runRepo = crawler.options.repositories.crawlRuns;
    const run = await runRepo.findById(crawlRunId);

    if (!run) {
      throw new Error(`Crawl run ${crawlRunId} not found`);
    }

    if (run.status !== 'queued') {
      throw new Error(`Crawl run ${crawlRunId} is not in 'queued' status (current: ${run.status})`);
    }

    const urls = run.urls || [];

    if (urls.length === 0) {
      throw new Error(`Crawl run ${crawlRunId} has no URLs configured`);
    }

    const adapter = crawler.adapterRegistry.get(source.key);
    if (!adapter) {
      throw new Error(`No adapter registered for source ${source.key}`);
    }

    // Claim the crawl run for execution (atomic)
    const claimResult = await runRepo.claimForExecution(
      crawlRunId,
      'worker-1',
      requestedAtDate,
    );

    if (claimResult.status !== 'claimed') {
      if (claimResult.status === 'already_running') {
        throw new Error(`Crawl run ${crawlRunId} already claimed by another worker`);
      }
      if (claimResult.status === 'already_terminal') {
        throw new Error(`Crawl run ${crawlRunId} is in terminal state, cannot execute`);
      }
      if (claimResult.status === 'not_found') {
        throw new Error(`Crawl run ${crawlRunId} not found`);
      }
      throw new Error(`Crawl run ${crawlRunId} claim failed: unknown status ${claimResult.status}`);
    }

    // Execute the crawl
    try {
      const outcome = await crawler.executeExistingRun(
        crawlRunId,
        adapter,
        urls,
        clock as any,
      );

      // Publish completion via outbox
      await this.outbox.complete(crawlRunId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.outbox.fail(crawlRunId, message);
      throw error;
    }
  }
}