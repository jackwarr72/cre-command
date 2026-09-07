'use client';

import Link from 'next/link';
import type { CrawlRunStatus, CrawlRunWithMetrics } from '@cre/shared';
import { formatDate, formatNumber } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

interface RecentRunsListProps {
  runs: CrawlRunWithMetrics[];
}

const STATUS_VARIANT: Record<CrawlRunStatus, 'success' | 'danger' | 'primary' | 'default' | 'warning'> = {
  completed: 'success',
  completed_with_errors: 'warning',
  failed: 'danger',
  running: 'primary',
  queued: 'primary',
  cancelled: 'default',
};

export function RecentRunsList({ runs }: RecentRunsListProps) {
  if (runs.length === 0) {
    return (
      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold text-noir-100">Recent Crawl Runs</h2>
        <p className="py-8 text-center text-sm text-noir-500">No crawl runs yet.</p>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-noir-100">Recent Crawl Runs</h2>
        <Link href="/jobs" className="text-xs font-medium text-gold hover:text-gold-400">
          View all
        </Link>
      </div>
      <div className="space-y-2">
        {runs.map((run) => {
          const m = run.metrics;
          const listingsFound = m?.listingsDiscovered ?? 0;
          const duration = m?.durationMs ?? null;
          const errorCount = m?.errors.length ?? run.errors.length ?? 0;
          return (
            <Link
              key={run.id}
              href={`/jobs/${run.id}`}
              className="flex items-center justify-between rounded-lg border border-noir-700 bg-noir-850 px-3 py-2 transition-colors hover:border-noir-500"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-noir-100">{run.sourceKey}</p>
                  <Badge variant={STATUS_VARIANT[run.status]}>{run.status}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-noir-500">
                  {run.finishedAt ? formatDate(run.finishedAt) : '—'}
                  {duration !== null && ` · ${(duration / 1000).toFixed(1)}s`}
                  {` · ${formatNumber(listingsFound)} listings`}
                  {errorCount > 0 && ` · ${errorCount} errors`}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
