'use client';

/**
 * Crawl run / search job detail.
 *
 * Shows the run's accounting (found/added/updated), timing, and any errors so
 * operators can inspect and recover from failures. Errors are the actionable
 * failure view required by the operational spec.
 */
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import type { CrawlError } from '@cre/shared';

import { useCrawlRun } from '@/lib/swr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatDate, formatNumber } from '@/lib/utils';

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

function ErrorRow({ error, index }: { error: CrawlError; index: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-accent-danger/30 bg-accent-danger/10 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-noir-100">
          {index + 1}. {error.message}
        </p>
        <span className="shrink-0 text-xs text-noir-400">
          {error.fatal ? 'fatal' : `retries: ${error.retries}`}
        </span>
      </div>
      {error.url && (
        <a
          href={error.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-gold hover:text-gold-400"
        >
          {error.url}
        </a>
      )}
      <p className="text-xs text-noir-400">{formatDate(error.at)}</p>
    </div>
  );
}

export default function JobDetailPage() {
  const { id } = useParams() as { id: string };
  const { data: run, isLoading, error } = useCrawlRun(id);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-noir-400">
        <Spinner className="size-4" />
        <span>Loading job…</span>
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-accent-danger">Error: {error.message}</p>;
  }

  if (!run) {
    return <p className="text-sm text-noir-400">Job not found.</p>;
  }

  const stats = [
    { label: 'Listings Found', value: formatNumber(run.listingsFound) },
    { label: 'Added', value: formatNumber(run.listingsAdded) },
    { label: 'Updated', value: formatNumber(run.listingsUpdated) },
    { label: 'Errors', value: formatNumber(run.errors.length) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-noir-50">{run.sourceKey}</h1>
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          </div>
          <p className="mt-1 text-sm text-noir-400">
            Created {formatDate(run.createdAt)}
          </p>
        </div>
        <Link href="/jobs">
          <Button variant="outline" size="sm">
            <ArrowLeft className="size-3.5" /> All Jobs
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="card p-4">
            <p className="text-xs font-medium text-noir-400">{stat.label}</p>
            <p className="mt-1 text-2xl font-bold text-noir-50">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold text-noir-100">Timing</h2>
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-noir-400">Started</p>
            <p className="text-noir-100">{run.startedAt ? formatDate(run.startedAt) : '—'}</p>
          </div>
          <div>
            <p className="text-xs text-noir-400">Finished</p>
            <p className="text-noir-100">{run.finishedAt ? formatDate(run.finishedAt) : '—'}</p>
          </div>
          <div>
            <p className="text-xs text-noir-400">Duration</p>
            <p className="text-noir-100">
              {run.startedAt && run.finishedAt
                ? `${Math.max(0, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))}s`
                : '—'}
            </p>
          </div>
        </div>
      </div>

      <div className="card space-y-3 p-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-accent-warning" />
          <h2 className="text-sm font-semibold text-noir-100">Errors</h2>
        </div>
        {run.errors.length === 0 ? (
          <p className="text-sm text-noir-400">No errors recorded for this run.</p>
        ) : (
          <div className="space-y-2">
            {run.errors.map((err, i) => (
              <ErrorRow key={i} error={err} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}