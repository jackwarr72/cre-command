'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Play } from 'lucide-react';
import { useSources, useCrawlRuns } from '@/lib/swr';
import { triggerCrawl } from '@/lib/swr';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatDate, formatNumber } from '@/lib/utils';

export default function CrawlerPage() {
  const { data: sources } = useSources();
  const { data: runs, mutate: mutateRuns } = useCrawlRuns({}, 1, 25);
  const [selectedSource, setSelectedSource] = useState('');
  const [keywords, setKeywords] = useState('');
  const [city, setCity] = useState('');
  const [propertyType, setPropertyType] = useState('');
  const [listingType, setListingType] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const activeSources = (sources ?? []).filter((s) => s.enabled);

  const handleRun = async () => {
    if (!selectedSource) {
      setError('Select a source to crawl.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await triggerCrawl({ sourceKey: selectedSource });
      setSuccess(`Crawl started — ${result.candidatesFound} candidates found so far.`);
      await mutateRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start crawl');
    } finally {
      setSubmitting(false);
    }
  };

  const recentRuns = runs?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-noir-50">Crawler Console</h1>
          <p className="text-sm text-noir-400">Configure and launch crawl operations across your sources.</p>
        </div>
      </div>

      <div className="card space-y-5 p-5">
        <h2 className="text-sm font-semibold text-noir-100">New Crawl</h2>
        {error && (
          <div className="rounded-lg border border-accent-danger/30 bg-accent-danger/10 p-3 text-sm text-accent-danger">{error}</div>
        )}
        {success && (
          <div className="rounded-lg border border-accent-success/30 bg-accent-success/10 p-3 text-sm text-accent-success">{success}</div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            label="Source"
            options={activeSources.map((s) => ({ value: s.key, label: s.name }))}
            onValueChange={setSelectedSource}
            placeholder="Select a source..."
          />
          <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Mexico City" />
          <Input label="Keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="office, warehouse..." />
          <Select
            label="Property Type"
            options={[
              { value: 'office', label: 'Office' },
              { value: 'retail', label: 'Retail' },
              { value: 'industrial', label: 'Industrial' },
              { value: 'multifamily', label: 'Multifamily' },
              { value: 'land', label: 'Land' },
              { value: 'mixed-use', label: 'Mixed Use' },
            ]}
            onValueChange={setPropertyType}
            placeholder="Any"
          />
          <Select
            label="Operation"
            options={[
              { value: 'sale', label: 'Sale' },
              { value: 'lease', label: 'Lease' },
              { value: 'sale-or-lease', label: 'Sale or Lease' },
            ]}
            onValueChange={setListingType}
            placeholder="Any"
          />
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleRun} disabled={submitting}>
            <Play className="h-3.5 w-3.5" />
            {submitting ? 'Running...' : 'RUN SEARCH'}
          </Button>
          <Button variant="outline" onClick={() => { setKeywords(''); setCity(''); }}>
            Reset
          </Button>
        </div>
      </div>
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-noir-700 px-4 py-3">
          <h2 className="text-sm font-semibold text-noir-100">Recent Runs</h2>
          <Link href="/jobs" className="text-xs font-medium text-gold hover:text-gold-400">View all</Link>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-noir-700 text-[11px] uppercase tracking-wider text-noir-400">
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Found</th>
              <th className="px-4 py-3 font-medium">Added</th>
              <th className="px-4 py-3 font-medium">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-noir-750">
            {recentRuns.map((run) => (
              <tr key={run.id} className="transition-colors hover:bg-noir-850">
                <td className="px-4 py-3 font-medium text-noir-100">{run.sourceKey}</td>
                <td className="px-4 py-3">
                  <Badge variant={
                    run.status === 'completed' ? 'success' :
                    run.status === 'failed' ? 'danger' :
                    run.status === 'running' ? 'primary' : 'default'
                  }>
                    {run.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-xs text-noir-300">{formatNumber(run.listingsFound)}</td>
                <td className="px-4 py-3 text-xs text-noir-300">{formatNumber(run.listingsAdded)}</td>
                <td className="px-4 py-3 text-xs text-noir-400">{run.createdAt ? formatDate(run.createdAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {recentRuns.length === 0 && (
          <p className="py-12 text-center text-sm text-noir-500">No crawl runs yet.</p>
        )}
      </div>
    </div>
  );
}