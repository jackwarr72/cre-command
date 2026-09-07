'use client';

import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  Copy,
  Database,
  FileX2,
  ListChecks,
} from 'lucide-react';

interface QuickActionsProps {
  failedRuns: number;
  sourcesNeedingAttention: number;
}

interface Action {
  href: string;
  label: string;
  icon: React.ElementType;
  count?: number;
  countVariant?: 'critical' | 'warning' | 'neutral';
}

export function QuickActions({ failedRuns, sourcesNeedingAttention }: QuickActionsProps) {
  const actions: Action[] = [
    {
      href: '/crawler',
      label: 'Start Crawl',
      icon: Activity,
    },
    {
      href: '/jobs?status=failed',
      label: 'Review Failed Jobs',
      icon: FileX2,
      count: failedRuns > 0 ? failedRuns : undefined,
      countVariant: failedRuns > 0 ? 'critical' : 'neutral',
    },
    {
      href: '/duplicates',
      label: 'Review Duplicates',
      icon: Copy,
    },
    {
      href: '/listings',
      label: 'Review New Listings',
      icon: ListChecks,
    },
    {
      href: '/sources',
      label: sourcesNeedingAttention > 0
        ? `Fix ${sourcesNeedingAttention} Source${sourcesNeedingAttention === 1 ? '' : 's'}`
        : 'Manage Sources',
      icon: sourcesNeedingAttention > 0 ? AlertTriangle : Database,
      count: sourcesNeedingAttention > 0 ? sourcesNeedingAttention : undefined,
      countVariant: 'warning',
    },
  ];

  return (
    <div className="card p-4">
      <h2 className="mb-3 text-sm font-semibold text-noir-100">Quick Actions</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {actions.map(({ href, label, icon: Icon, count, countVariant }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center justify-between rounded-lg border border-noir-700 bg-noir-850 px-3 py-2 text-sm text-noir-200 transition-colors hover:border-noir-500"
          >
            <span className="flex items-center gap-2 truncate">
              <Icon className="h-3.5 w-3.5 shrink-0 text-noir-500" />
              <span className="truncate">{label}</span>
            </span>
            {count !== undefined && (
              <span
                className={`ml-2 shrink-0 rounded-full px-1.5 text-[10px] font-semibold ${
                  countVariant === 'critical'
                    ? 'bg-accent-danger/20 text-accent-danger'
                    : countVariant === 'warning'
                    ? 'bg-accent-warning/20 text-accent-warning'
                    : 'bg-noir-700 text-noir-300'
                }`}
              >
                {count}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
