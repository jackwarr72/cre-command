import type { JobQueue } from './queue';

export interface InMemoryJob<TPayload = unknown> {
  id: string;
  payload: TPayload;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  lastError?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export class InMemoryJobQueue<TPayload> implements JobQueue<TPayload> {
  private readonly jobs = new Map<string, InMemoryJob<TPayload>>();

  push(payload: TPayload): string {
    const id = crypto.randomUUID();
    this.jobs.set(id, {
      id,
      payload,
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    });
    return id;
  }

  async popBatch(limit: number): Promise<readonly TPayload[]> {
    const now = new Date();
    const results: TPayload[] = [];

    for (const [id, job] of this.jobs) {
      if (results.length >= limit) break;
      if (job.status === 'pending' || (job.status === 'failed' && job.attempts < 5)) {
        job.status = 'processing';
        job.startedAt = now;
        job.attempts += 1;
        results.push(job.payload);
      }
    }

    return results;
  }

  async markProcessing(ids: readonly string[]): Promise<void> {
    const now = new Date();
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job) {
        job.status = 'processing';
        job.startedAt = now;
        job.attempts += 1;
      }
    }
  }

  async complete(ids: readonly string[]): Promise<void> {
    const now = new Date();
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job) {
        job.status = 'completed';
        job.completedAt = now;
      }
    }
  }

  async fail(ids: readonly string[], error: string): Promise<void> {
    const now = new Date();
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job) {
        job.status = 'failed';
        job.lastError = error;
        job.completedAt = now;
      }
    }
  }

  async cleanup(): Promise<number> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let count = 0;

    for (const [id, job] of this.jobs) {
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        job.completedAt &&
        job.completedAt < cutoff
      ) {
        this.jobs.delete(id);
        count++;
      }
    }

    return count;
  }

  getAll(): readonly InMemoryJob<TPayload>[] {
    return Array.from(this.jobs.values());
  }

  get(id: string): InMemoryJob<TPayload> | undefined {
    return this.jobs.get(id);
  }

  clear(): void {
    this.jobs.clear();
  }
}