import type { AdapterRegistry, CrawlerRepositories } from '@cre/crawler';
import type { Database } from '@cre/db';
import { Crawler, FetchHttpClient, HttpRobotsChecker } from '@cre/crawler';
import { createPostgresRepositories } from '@cre/crawler';

export interface CrawlJobPayload {
  /** Outbox record id (the queue adds it; the API payload itself omits it). */
  jobId: string;
  /** The crawl run to execute. */
  crawlRunId: string;
  /** The source that triggered this run (source row id). */
  sourceId: string;
  /** User who requested the crawl. */
  requestedByUserId?: string | null;
  /** ISO timestamp when the crawl was requested. */
  requestedAt?: string;
}

/**
 * Handles a single crawl job: claims the run and executes the crawler pipeline
 * (fetch → robots gate → adapter parse → dedup → persist → accounting).
 * Outbox bookkeeping stays with the caller (`CrawlWorker` completes/fails the
 * record by `job.jobId`), so the handler never touches the queue itself and
 * stays focused on source → adapter → engine orchestration.
 */
export class CrawlJobHandler {
  constructor(
    private readonly db: Database,
    private readonly adapterRegistry: AdapterRegistry,
    /** Test seam: inject a Crawler wired to fake repositories, or inject the
     *  repositories directly (used for pre-execution lookups without an engine). */
    private readonly injectedCrawler?: Crawler,
    private readonly injectedRepositories?: CrawlerRepositories,
  ) {}

  /** Repositories for source/run resolution. Tests inject fakes; production
   *  uses the same postgres repositories the engine crawls with — so there is
   *  still exactly one repository path, shared by lookup and execution. */
  private resolveRepositories(): CrawlerRepositories {
    if (this.injectedCrawler) return this.injectedCrawler.options.repositories;
    if (this.injectedRepositories) return this.injectedRepositories;
    return createPostgresRepositories(this.db);
  }

  /** Build a Crawler instance over the resolved repositories. */
  private buildCrawler(): Crawler {
    if (this.injectedCrawler) return this.injectedCrawler;
    const http = new FetchHttpClient({ userAgent: 'cre-crawler/1.0' });
    return new Crawler({
      repositories: this.resolveRepositories(),
      http,
      robots: new HttpRobotsChecker(http),
    });
  }

  async handle(job: CrawlJobPayload): Promise<void> {
    const { crawlRunId, sourceId } = job;
    // Resolve against `resolveRepositories()` (shared lookup + engine stores)
    // *before* building any network clients, so lookup failures throw with no
    // HTTP/robots construction involved.
    const repos = this.resolveRepositories();

    // The outbox payload carries the source *id* (UUID); the registry and the
    // crawler both key off `source.key`, so resolve the row by id first.
    // Any throw propagates to CrawlWorker, which fails the outbox record by
    // `job.jobId` (the single close/fail site) and continues with the batch.
    const source = await repos.sources.findById(sourceId);
    if (!source) {
      throw new Error(`Source ${sourceId} not found`);
    }

    const run = await repos.crawlRuns.findById(crawlRunId);
    if (!run) {
      throw new Error(`Crawl run ${crawlRunId} not found`);
    }

    if (run.status !== 'queued') {
      // Idempotency: a redelivered event for an already-claimed/finished run.
      return;
    }

    const urls = run.urls ?? [];
    if (urls.length === 0) {
      throw new Error(`Crawl run ${crawlRunId} has no URLs configured`);
    }

    const adapter = this.adapterRegistry.get(source.key);
    if (!adapter) {
      throw new Error(`No adapter registered for source ${source.key}`);
    }

    // Atomically claim the run (queued → running). Losing the race means
    // another worker owns it — treat as done for this event.
    const claimResult = await repos.crawlRuns.claimForExecution(
      crawlRunId,
      `worker-${process.pid}`,
      new Date(),
    );
    if (claimResult.status !== 'claimed') {
      return;
    }

    // queued → running → completed/failed is owned by the crawler engine,
    // executed over the same repositories the lookup used.
    await this.buildCrawler().executeExistingRun(crawlRunId, adapter, urls);
  }
}