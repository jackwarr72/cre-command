'use client';

import Link from 'next/link';
import { Building2, Database, FileSearch, Plus, TrendingUp } from 'lucide-react';
import { useDashboardSummary, useListings } from '@/lib/swr';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatNumber } from '@/lib/utils';
import type { SourceHealth } from '@cre/shared';
import { IngestionOverview } from './_components/ingestion-overview';
import { SourceHealthList } from './_components/source-health-list';
import { RecentRunsList } from './_components/recent-runs-list';
import { QuickActions } from './_components/quick-actions';

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  icon: React.ElementType;
  accent?: boolean;
  indicator?: 'critical' | 'warning' | 'success' | null;
}

function StatCard({ label, value, hint, icon: Icon, accent, indicator }: StatCardProps) {
  const indicatorClasses = indicator === 'critical'
    ? 'bg-accent-danger/10'
    : indicator === 'warning'
    ? 'bg-accent-warning/10'
    : indicator === 'success'
    ? 'bg-accent-success/10'
    : accent ? 'bg-gold/10' : 'bg-noir-700';

  const iconClasses = indicator === 'critical'
    ? 'text-accent-danger'
    : indicator === 'warning'
    ? 'text-accent-warning'
    : indicator === 'success'
    ? 'text-accent-success'
    : accent ? 'text-gold' : 'text-noir-300';

  const valueClasses = indicator === 'critical'
    ? 'text-accent-danger'
    : indicator === 'warning'
    ? 'text-accent-warning'
    : indicator === 'success'
    ? 'text-accent-success'
    : accent ? 'text-gold' : 'text-noir-50';

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-noir-400">
            {label}
          </p>
          <p className={`mt-1 text-2xl font-bold ${valueClasses}`}>
            {typeof value === 'number' ? formatNumber(value) : value}
          </p>
          {hint && <p className="mt-1 text-xs text-noir-500">{hint}</p>}
        </div>
        <div className={`rounded-lg p-2 ${indicatorClasses}`}>
          <Icon className={`h-4 w-4 ${iconClasses}`} />
        </div>
      </div>
    </div>
  );
}

/** Sort source health by severity: critical → warning → unknown → healthy. */
function sortSourceHealth(health: SourceHealth[]): SourceHealth[] {
  const order: Record<SourceHealth['status'], number> = {
    critical: 0,
    warning: 1,
    unknown: 2,
    healthy: 3,
  };
  return [...health].sort((a, b) => order[a.status] - order[b.status]);
}

export default function DashboardPage() {
  const { data: summary, isLoading, error } = useDashboardSummary();
  const { data: listings } = useListings({ filter: { statuses: ['active'] }, page: 1, pageSize: 10 });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-6 text-center">
        <p className="text-sm text-accent-danger">Failed to load dashboard</p>
        <p className="mt-1 text-xs text-noir-500">{error.message}</p>
      </div>
    );
  }

  const { sources, listings: counts, runs, recentRuns, sourceHealth } = summary!;
  const recentListings = listings?.items ?? [];
  const successRatePct = Math.round(runs.successRate * 100);

  const sourcesNeedingAttention = sources.withErrors;
  const hasFailures = runs.failed > 0;
  const sortedHealth = sortSourceHealth(sourceHealth);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-noir-50">Dashboard</h1>
          <p className="text-sm text-noir-400">
            Real-time real estate intelligence overview
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/crawler">
            <Button variant="outline" size="sm">
              <TrendingUp className="h-3.5 w-3.5" />
              Start Crawl
            </Button>
          </Link>
          <Link href="/listings">
            <Button size="sm">
              <Plus className="h-3.5 w-3.5" />
              View Listings
            </Button>
          </Link>
        </div>
      </div>

      {/* KPI cards — ordered by operational priority: failures → growth → activity → config */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Sources Needing Attention"
          value={sourcesNeedingAttention}
          hint={`${sources.active} of ${sources.total} active`}
          icon={Database}
          indicator={sourcesNeedingAttention > 0 ? 'critical' : 'success'}
        />
        <StatCard
          label="Crawl Success Rate"
          value={`${successRatePct}%`}
          hint={`last ${runs.total} runs · ${runs.completed} ok · ${runs.failed} failed`}
          icon={FileSearch}
          indicator={hasFailures ? 'warning' : 'success'}
        />
        <StatCard
          label="Active Listings"
          value={counts.active}
          hint={`${formatNumber(counts.total)} total tracked`}
          icon={Building2}
          accent
        />
        <StatCard
          label="Runs (24h)"
          value={runs.last24hCount}
          hint={`${runs.running} active · ${runs.total} all-time`}
          icon={TrendingUp}
        />
      </div>

      {/* Ingestion overview — most recent run with delta vs previous */}
      <IngestionOverview recentRuns={recentRuns} />

      {/* Crawl health + Source health (sorted by severity) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RecentRunsList runs={recentRuns.slice(0, 5)} />
        <SourceHealthList health={sortedHealth} />
      </div>

      {/* Operational quick actions */}
      <QuickActions
        failedRuns={runs.failed}
        sourcesNeedingAttention={sourcesNeedingAttention}
      />

      {/* Latest listings */}
      {recentListings.length > 0 && (
        <div className="card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-noir-100">Latest Listings</h2>
            <Link href="/listings" className="text-xs font-medium text-gold hover:text-gold-400">
              View all
            </Link>
          </div>
          <div className="space-y-2">
            {recentListings.map((listing) => (
              <Link
                key={listing.id}
                href={`/listings/${listing.id}`}
                className="block rounded-lg border border-noir-700 bg-noir-850 px-3 py-2 transition-colors hover:border-noir-500"
              >
                <p className="text-sm font-medium text-noir-100">{listing.title}</p>
                <p className="text-xs text-noir-500">
                  {listing.address?.city ?? 'Unknown'} · {listing.propertyType} · {listing.listingType}
                </p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
