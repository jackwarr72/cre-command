'use client';

import Link from 'next/link';
import { AlertCircle, AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import type { SourceHealth } from '@cre/shared';
import { formatDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

interface SourceHealthListProps {
  health: SourceHealth[];
}

const STATUS_CONFIG: Record<
  SourceHealth['status'],
  { icon: typeof CheckCircle2; variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }
> = {
  healthy: { icon: CheckCircle2, variant: 'success', label: 'Healthy' },
  warning: { icon: AlertTriangle, variant: 'warning', label: 'Warning' },
  critical: { icon: AlertCircle, variant: 'danger', label: 'Critical' },
  unknown: { icon: HelpCircle, variant: 'neutral', label: 'Unknown' },
};

export function SourceHealthList({ health }: SourceHealthListProps) {
  if (health.length === 0) {
    return (
      <div className="card p-4">
        <h2 className="mb-3 text-sm font-semibold text-noir-100">Source Health</h2>
        <p className="py-8 text-center text-sm text-noir-500">No sources configured.</p>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-noir-100">Source Health</h2>
        <Link href="/sources" className="text-xs font-medium text-gold hover:text-gold-400">
          Manage
        </Link>
      </div>
      <div className="space-y-2">
        {health.map((h) => {
          const config = STATUS_CONFIG[h.status];
          const Icon = config.icon;
          const topAnomaly = h.anomalies[0];
          return (
            <Link
              key={h.sourceKey}
              href={`/sources`}
              className="flex items-center justify-between rounded-lg border border-noir-700 bg-noir-850 px-3 py-2 transition-colors hover:border-noir-500"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    config.variant === 'success'
                      ? 'text-accent-success'
                      : config.variant === 'warning'
                      ? 'text-accent-warning'
                      : config.variant === 'danger'
                      ? 'text-accent-danger'
                      : 'text-noir-500'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-noir-100">{h.sourceKey}</p>
                    <Badge variant={config.variant}>{config.label}</Badge>
                  </div>
                  {topAnomaly ? (
                    <p className="mt-0.5 truncate text-xs text-noir-400">
                      {topAnomaly.message}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-xs text-noir-500">
                      {h.lastSuccess
                        ? `Last success ${formatDate(h.lastSuccess)}`
                        : 'No successful runs yet'}
                    </p>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
