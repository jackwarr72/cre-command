'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function MetricsPage() {
  return (
    <ModulePlaceholder
      title="Metrics"
      description="KPIs:listings discovered, source performance, crawl success rate,, price
      distribution,, conversion,and contact rates.."
      badge="Phase 4"
    >
      <p className="text-sm text-noir-400">
        Metrics will surface KPIs from the existing operational data — listings by
        source/city/type, price distribution, average size,, new listings per day, crawl
        success rate,, duplicate rate,, and later conversion/opportunity rates..
      </p>
    </ModulePlaceholder>
  );
}