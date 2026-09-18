import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { outbox } from '@cre/db';
import type { Database } from '@cre/db';

import type { CrawlJobPayload } from './crawlJob';
import type { JobQueue } from './queue';

/**
 * Postgres-backed job queue over the transactional outbox table.
 *
 * The API writes `crawl.run` records inside the same transaction as the queued
 * crawl run; this queue is the consuming side. Payloads are persisted without
 * `jobId` (the API's write path) — it is stamped here from the record id so
 * callers can complete/fail the right event.
 *
 * Concurrency: `popBatch` selects with `FOR UPDATE SKIP LOCKED` so multiple
 * worker processes never grab the same record; a record claimed by one worker
 * is invisible to the others until it moves out of `pending`.
 */
export class PgOutboxJobQueue implements JobQueue<CrawlJobPayload> {
  constructor(
    private readonly db: Database,
    private readonly type = 'crawl.run',
  ) {}

  /** Peek pending records (without claiming — the loop marks them). */
  async popBatch(limit: number): Promise<readonly CrawlJobPayload[]> {
    const rows = await this.db
      .select({ id: outbox.id, payload: outbox.payload })
      .from(outbox)
      .where(and(eq(outbox.type, this.type), eq(outbox.status, 'pending')))
      .orderBy(asc(outbox.createdAt))
      .for('update', { skipLocked: true })
      .limit(limit);

    return rows.map((row) => {
      const payload = (row.payload ?? {}) as Partial<CrawlJobPayload>;
      if (!payload.crawlRunId || !payload.sourceId) {
        // Malformed producer payload — surface it as a job that will fail
        // loudly in the handler rather than being silently dropped.
        return {
          jobId: row.id,
          crawlRunId: payload.crawlRunId ?? '',
          sourceId: payload.sourceId ?? '',
        };
      }
      return {
        jobId: row.id,
        crawlRunId: payload.crawlRunId,
        sourceId: payload.sourceId,
        requestedByUserId: payload.requestedByUserId ?? null,
        requestedAt: payload.requestedAt,
      };
    });
  }

  async markProcessing(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(outbox)
      .set({ status: 'processing', startedAt: new Date(), attempts: sql`${outbox.attempts} + 1` })
      .where(inArray(outbox.id, [...ids]));
  }

  async complete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(outbox)
      .set({ status: 'completed', completedAt: new Date() })
      .where(inArray(outbox.id, [...ids]));
  }

  async fail(ids: readonly string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(outbox)
      .set({ status: 'failed', lastError: error, completedAt: new Date() })
      .where(inArray(outbox.id, [...ids]));
  }

  /** Delete terminal records older than 7 days. Returns rows removed. */
  async cleanup(): Promise<number> {
    const removed = await this.db
      .delete(outbox)
      .where(
        and(
          eq(outbox.type, this.type),
          inArray(outbox.status, ['completed', 'failed']),
          sql`${outbox.completedAt} < now() - interval '7 days'`,
        ),
      )
      .returning({ id: outbox.id });
    return removed.length;
  }
}