'use client';

/**
 * Metrics dashboard for crawl-run KPIs.
 *
 * Aggregates the most recent crawl runs (newest-first from
 * GET /api/crawl-runs, which always carries the serializer's metrics block)
 * through the pure view-model in `lib/metrics-view.ts`, which itself reuses
 * the crawler engine's summarizer. The API has no time-window param, so the
 * window ("last N runs") is applied client-side over one page fetch.
 */
import { useState } from 'react';

import { MetricsCards } from '@/app/(app)/metrics/_components/metrics-cards';
import type { CrawlRunFilter } from '@/lib/api';
import { useCrawlRuns, useSources } from '@/lib/swr';
import {
  buildMetricsAggregate,
  METRICS_PAGE_SIZE,
  METRICS_WINDOWS,
  type MetricsWindowSize,
} from '@/lib/metrics-view';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

const WINDOW_OPTIONS = METRICS_WINDOWS.map((n) => ({ value: String(n), label: `Last ${n} runs` }));

export default function MetricsPage() {
  const [sourceKey, setSourceKey] = useState('');
  const [windowSize, setWindowSize] = useState<MetricsWindowSize>(25);

  const { data: sources } = useSources();
  const filter: CrawlRunFilter = { sourceKey: sourceKey || undefined };
  const { data, isLoading, error } = useCrawlRuns(filter, 1, METRICS_PAGE_SIZE);

  const runs = (data?.items ?? []).slice(0, windowSize);
  const hasRuns = runs.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-noir-50">Metrics</h1>
        <p className="text-sm text-noir-400">
          Ingestion volume, fetch/parse/dedup quality, field completeness, and request
          latency — aggregated over the most recent crawl runs.
        </p>
      </div>

      <div className="card space-y-4 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Select
            id="metrics-source"
            label="Source"
            placeholder="All sources"
            options={(sources ?? []).map((s) => ({ value: s.key, label: s.name }))}
            onValueChange={setSourceKey}
          />
          <Select
            id="metrics-window"
            label="Window"
            options={WINDOW_OPTIONS}
            value={String(windowSize)}
            onValueChange={(v) => setWindowSize(Number(v) as MetricsWindowSize)}
          />
          <div className="flex items-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSourceKey('');
                setWindowSize(25);
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-noir-400">
          <Spinner className="size-4" /> <span>Loading metrics…</span>
        </div>
      ) : error ? (
        <p className="text-sm text-accent-danger">Error: {error.message}</p>
      ) : !hasRuns ? (
        <p className="py-12 text-center text-sm text-noir-500">
          No crawl runs match these filters.
        </p>
      ) : (
        <>
          <p className="text-xs text-noir-500">
            Aggregating the newest {runs.length} run{runs.length === 1 ? '' : 's'}
            {sourceKey ? ` for ${sourceKey}` : ''}.
          </p>
          <MetricsCards agg={buildMetricsAggregate(runs)} />
        </>
      )}
    </div>
  );
}