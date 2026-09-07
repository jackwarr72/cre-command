'use client';

/**
 * Search Jobs / Crawl Runs history.
 *
 * Lists crawl run records (per-source execution records of the queue/worker
 * pipeline) with status, listings found/added, and timing. Filterable by
 * source and status.
 */
import { useState } from 'react';
import Link from 'next/link';
import type { CrawlRunStatus } from '@cre/shared';
import { useCrawlRuns } from '@/lib/swr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { formatDate, formatNumber } from '@/lib/utils';

const STATUS_OPTIONS = [
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'completed_with_errors', label: 'Completed (errors)' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function statusVariant(status: string): 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'completed': return 'success';
    case 'running': return 'primary';
    case 'failed': return 'danger';
    case 'completed_with_errors': return 'warning';
    case 'cancelled': return 'neutral';
    default: return 'default';
  }
}

export default function JobsPage() {
  const [sourceKey, setSourceKey] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data, isLoading, error } = useCrawlRuns(
    { sourceKey: sourceKey || undefined, statuses: status ? [status as CrawlRunStatus] : undefined },
    page,
    pageSize,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-noir-50">Search Jobs</h1>
        <p className="text-sm text-noir-400">Execution history of crawl searches across your sources.</p>
      </div>

      <div className="card space-y-4 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Source" value={sourceKey} onChange={(e) => { setSourceKey(e.target.value); setPage(1); }} placeholder="e.g. vivanuncios" />
          <Select label="Status" options={STATUS_OPTIONS} onValueChange={(v) => { setStatus(v); setPage(1); }} placeholder="Any status" />
          <div className="flex items-end">
            <Button variant="outline" size="sm" onClick={() => { setSourceKey(''); setStatus(''); setPage(1); }}>
              Reset
            </Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-noir-400">
          <Spinner className="size-4" /> <span>Loading jobs…</span>
        </div>
      ) : error ? (
        <p className="text-sm text-accent-danger">Error: {error.message}</p>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-noir-700 text-[11px] uppercase tracking-wider text-noir-400">
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Found</th>
                <th className="px-4 py-3 font-medium">Added</th>
                <th className="px-4 py-3 font-medium">Started</th>
                <th className="px-4 py-3 font-medium">Finished</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-noir-750">
              {(data?.items ?? []).map((run) => (
                <tr key={run.id} className="transition-colors hover:bg-noir-850">
                  <td className="px-4 py-3">
                    <Link href={`/jobs/${run.id}`} className="font-medium text-gold hover:text-gold-400">
                      {run.sourceKey}
                    </Link>
                  </td>
                  <td className="px-4 py-3"><Badge variant={statusVariant(run.status)}>{run.status}</Badge></td>
                  <td className="px-4 py-3 text-xs text-noir-300">{formatNumber(run.listingsFound)}</td>
                  <td className="px-4 py-3 text-xs text-noir-300">{formatNumber(run.listingsAdded)}</td>
                  <td className="px-4 py-3 text-xs text-noir-400">{run.startedAt ? formatDate(run.startedAt) : '—'}</td>
                  <td className="px-4 py-3 text-xs text-noir-400">{run.finishedAt ? formatDate(run.finishedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data?.items ?? []).length === 0 && (
            <p className="py-12 text-center text-sm text-noir-500">No crawl jobs found.</p>
          )}
          <div className="border-t border-noir-700 px-4 py-3">
            <Pagination page={page} pageSize={pageSize} total={data?.total ?? 0} onPageChange={setPage} />
          </div>
        </div>
      )}
    </div>
  );
}