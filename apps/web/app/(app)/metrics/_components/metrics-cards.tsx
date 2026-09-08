'use client';

/**
 * Metric stat cards for the /metrics page (Kinetic Noir).
 * Pure presentation: rates/null handling come pre-formatted via helpers.
 */
import type { MetricsAggregate } from '@/lib/metrics-view';
import { formatMs, formatNumber, formatRate } from '@/lib/metrics-view';

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'success' | 'danger';
}) {
  return (
    <div className="card p-4">
      <p className="text-[11px] uppercase tracking-wider text-noir-400">{label}</p>
      <p
        className={[
          'mt-1 text-lg font-semibold',
          accent === 'success' ? 'text-accent-success' : accent === 'danger' ? 'text-accent-danger' : 'text-noir-50',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-noir-500">{sub}</p>}
    </div>
  );
}

export function MetricsCards({ agg }: { agg: MetricsAggregate }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label="Listings created"
        value={formatNumber(agg.listingsCreated)}
        sub={`${formatNumber(agg.listingsUpdated)} updated · ${agg.totalRuns} runs`}
      />
      <Stat
        label="Fetch success"
        value={formatRate(agg.fetchSuccessRate)}
        sub={`${agg.completedRuns} completed · ${agg.failedRuns} failed`}
        accent={agg.fetchSuccessRate !== null && agg.fetchSuccessRate < 0.9 ? 'danger' : undefined}
      />
      <Stat
        label="Error rate"
        value={formatRate(agg.errorRate)}
        sub="HTTP + parse errors / requests"
        accent={agg.errorRate !== null && agg.errorRate > 0.1 ? 'danger' : undefined}
      />
      <Stat
        label="Parse success"
        value={formatRate(agg.parseSuccessRate)}
        sub="cards parsed / cards seen"
      />
      <Stat label="Deduplication" value={formatRate(agg.deduplicationRate)} sub="duplicates / discovered" />
      <Stat
        label="Field completeness"
        value={formatRate(agg.fieldCompletenessRate)}
        sub="title · price · address · size · type"
      />
      <Stat
        label="Listings / page"
        value={agg.listingsPerPage === null ? '—' : agg.listingsPerPage.toFixed(2)}
        sub="created / successful pages"
      />
      <Stat
        label="Latency p50 / p95"
        value={`${formatMs(agg.latencyP50Ms)} / ${formatMs(agg.latencyP95Ms)}`}
        sub={`max ${formatMs(agg.latencyMaxMs)} · ${formatNumber(agg.bytesDownloaded)} bytes fetched`}
      />
    </div>
  );
}