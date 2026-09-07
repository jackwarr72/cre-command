'use client';

import { TrendingDown, TrendingUp } from 'lucide-react';
import type { CrawlRunWithMetrics } from '@cre/shared';
import { formatNumber } from '@/lib/utils';
import Link from 'next/link';

interface IngestionOverviewProps {
  recentRuns: CrawlRunWithMetrics[];
}

/**
 * Ingestion KPI strip: cards for the metrics that matter on a single glance.
 *
 * - Listings Discovered (with delta vs previous run, when available)
 * - Duplicates Caught
 * - Pages Fetched (success rate)
 * - Duration of latest run
 */
export function IngestionOverview({ recentRuns }: IngestionOverviewProps) {
  if (recentRuns.length === 0) {
    return (
      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold text-noir-100">Ingestion Overview</h2>
        <p className="py-8 text-center text-sm text-noir-500">No ingestion data yet.</p>
      </div>
    );
  }

  const latest = recentRuns[0];
  const previous = recentRuns[1];
  const m = latest.metrics;

  if (!m) {
    return (
      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold text-noir-100">Ingestion Overview</h2>
        <p className="py-8 text-center text-sm text-noir-500">No metrics for latest run.</p>
      </div>
    );
  }

  // Listings delta vs previous run (when metrics are present).
  const latestFound = m.listingsDiscovered;
  const previousFound = previous?.metrics?.listingsDiscovered;
  const delta = previousFound !== undefined ? latestFound - previousFound : null;
  const deltaPct =
    previousFound && previousFound > 0
      ? Math.round((delta! / previousFound) * 100)
      : null;

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-noir-100">
          Ingestion — Latest Crawl
          <span className="ml-2 text-xs font-normal text-noir-500">
            {latest.sourceKey}
          </span>
        </h2>
        <Link
          href={`/jobs/${latest.id}`}
          className="text-xs font-medium text-gold hover:text-gold-400"
        >
          View details
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* Listings Discovered — the headline KPI */}
        <div className="rounded-lg border border-noir-700 bg-noir-850 p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-noir-500">
            Listings Discovered
          </p>
          <p className="mt-1 text-lg font-bold text-gold">
            {formatNumber(latestFound)}
          </p>
          {delta !== null && previousFound !== undefined && (
            <p
              className={`flex items-center gap-1 text-[10px] ${
                delta > 0
                  ? 'text-accent-success'
                  : delta < 0
                  ? 'text-accent-danger'
                  : 'text-noir-500'
              }`}
            >
              {delta > 0 ? <TrendingUp className="h-2.5 w-2.5" /> : delta < 0 ? <TrendingDown className="h-2.5 w-2.5" /> : null}
              <span>
                {delta > 0 ? '+' : ''}
                {formatNumber(delta)}
                {deltaPct !== null && ` (${deltaPct}%)`} vs previous
              </span>
            </p>
          )}
        </div>

        {/* Duplicates */}
        <div className="rounded-lg border border-noir-700 bg-noir-850 p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-noir-500">
            Duplicates Caught
          </p>
          <p className="mt-1 text-lg font-bold text-noir-100">
            {formatNumber(m.duplicateCandidates)}
          </p>
          <p className="text-[10px] text-noir-500">in-crawl dedup</p>
        </div>

        {/* Pages Fetched */}
        <div className="rounded-lg border border-noir-700 bg-noir-850 p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-noir-500">
            Pages Fetched
          </p>
          <p className="mt-1 text-lg font-bold text-noir-100">
            {formatNumber(m.pagesSucceeded)}
            <span className="text-xs font-normal text-noir-500"> / {formatNumber(m.pagesAttempted)}</span>
          </p>
          <p className="text-[10px] text-noir-500">
            {m.pagesAttempted > 0
              ? `${Math.round((m.pagesSucceeded / m.pagesAttempted) * 100)}% success`
              : '—'}
          </p>
        </div>

        {/* Duration */}
        <div className="rounded-lg border border-noir-700 bg-noir-850 p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-noir-500">
            Duration
          </p>
          <p className="mt-1 text-lg font-bold text-noir-100">
            {m.durationMs !== undefined ? `${(m.durationMs / 1000).toFixed(1)}s` : '—'}
          </p>
          <p className="text-[10px] text-noir-500">
            {latest.finishedAt ? new Date(latest.finishedAt).toLocaleTimeString() : '—'}
          </p>
        </div>
      </div>
    </div>
  );
}
