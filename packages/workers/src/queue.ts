export interface JobQueue<TJob> {
  /** Pop up to N ready jobs, removing them from the ready pool. */
  popBatch(limit: number): Promise<readonly TJob[]>;
  /** Mark jobs as claimed for processing. */
  markProcessing(ids: readonly string[]): Promise<void>;
  /** Record successful completion of jobs. */
  complete(ids: readonly string[]): Promise<void>;
  /** Record job failure (increment attempt count, keep for retry). */
  fail(ids: readonly string[], error: string): Promise<void>;
  /** Delete fully processed or expired jobs. */
  cleanup(): Promise<number>;
}