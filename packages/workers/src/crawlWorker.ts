import type { AdapterRegistry } from '@cre/crawler';
import type { Database } from '@cre/db';

import { CrawlJobHandler, type CrawlJobPayload } from './crawlJob';
import type { JobQueue } from './queue';

export interface CrawlWorkerOptions {
  db: Database;
  adapterRegistry: AdapterRegistry;
  queue: JobQueue<CrawlJobPayload>;
  /** Max jobs popped per poll tick. */
  batchSize?: number;
  /** Delay between polls when no jobs were found (ms). Default 2000. */
  pollIntervalMs?: number;
  /** Test seam / alternative job handling: override the built-in handler. */
  handler?: { handle(job: CrawlJobPayload): Promise<void> };
  log?: (message: string, context?: Record<string, unknown>) => void;
  logError?: (message: string, error: unknown) => void;
}

/**
 * The crawl worker's poll loop. Composes the existing pieces — it never touches
 * listings, robots, or HTTP itself: `CrawlJobHandler` → the crawler engine →
 * its Postgres repositories do the work, and the outbox record is the
 * single bookkeeping entry.
 */
export class CrawlWorker {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly handler: { handle(job: CrawlJobPayload): Promise<void> };
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly options: CrawlWorkerOptions) {
    this.batchSize = options.batchSize ?? 5;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.handler =
      options.handler ??
      new CrawlJobHandler(options.db, options.adapterRegistry);
  }

  /** One poll tick: pop → mark → handle → complete/fail. Returns jobs handled. */
  async runOnce(): Promise<number> {
    const jobs = await this.options.queue.popBatch(this.batchSize);
    if (jobs.length === 0) return 0;

    await this.options.queue.markProcessing(jobs.map((job) => job.jobId));

    for (const job of jobs) {
      try {
        await this.handler.handle(job);
        await this.options.queue.complete([job.jobId]);
        this.options.log?.('crawl job completed', { jobId: job.jobId, crawlRunId: job.crawlRunId });
      } catch (error) {
        // One bad job must never stall the queue: record the failure on the
        // right outbox id and move on to the rest of the batch.
        const message = error instanceof Error ? error.message : String(error);
        await this.options.queue.fail([job.jobId], message).catch(() => undefined);
        this.options.logError?.(`crawl job failed (${job.jobId})`, error);
      }
    }
    return jobs.length;
  }

  /** Poll until `stop()` is called. Resolves after the final tick completes. */
  async start(): Promise<void> {
    if (this.running) return this.loopPromise ?? Promise.resolve();
    this.running = true;
    this.loopPromise = this.loop();
    return this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let handled = 0;
      try {
        handled = await this.runOnce();
      } catch (error) {
        // Pop/mark errors are infra hiccups (DB restart, deadlock) — back off
        // and keep the worker alive instead of crashing the process.
        this.options.logError?.('crawl worker poll failed', error);
      }
      if (handled === 0 && this.running) {
        await sleep(this.pollIntervalMs);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}