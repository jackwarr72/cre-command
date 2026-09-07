'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Edit2,
  Pause,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { useSources } from '@/lib/swr';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, sourcesApi } from '@/lib/api';
import type { SourceDto } from '@/lib/api';
import type { RobotsPolicy } from '@cre/shared';

export default function SourcesPage() {
  const router = useRouter();
  const { data: sources, isLoading, mutate } = useSources();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SourceDto | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [schedule, setSchedule] = useState('0 3 * * *');
  const [robotsPolicy, setRobotsPolicy] = useState('strict');
  const [rateLimitMs, setRateLimitMs] = useState(500);
  const [maxWorkers, setMaxWorkers] = useState(1);

  const resetForm = () => {
    setKey('');
    setName('');
    setBaseUrl('');
    setSchedule('0 3 * * *');
    setRobotsPolicy('strict');
    setRateLimitMs(500);
    setMaxWorkers(1);
    setFormError(null);
    setEditing(null);
    setShowForm(false);
  };

  const startEdit = (source: SourceDto) => {
    setEditing(source);
    setKey(source.key);
    setName(source.name);
    setBaseUrl(source.baseUrl ?? '');
    setSchedule(source.schedule);
    setRobotsPolicy(source.robotsPolicy);
    setRateLimitMs(source.rateLimitMs);
    setMaxWorkers(source.maxWorkers);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        await sourcesApi.updatePolicy(editing.key, { robotsPolicy: robotsPolicy as RobotsPolicy, rateLimitMs, maxWorkers });
      }
      await mutate();
      resetForm();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'An unexpected error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleEnabled = async (source: SourceDto) => {
    try {
      await sourcesApi.updatePolicy(source.key, { enabled: !source.enabled });
      await mutate();
    } catch { /* silent */ }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-noir-50">Sources</h1>
          <p className="text-sm text-noir-400">Configure and manage your crawl sources.</p>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="h-3.5 w-3.5" />
          Add Source
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="card space-y-4 p-5">
          <h2 className="text-sm font-semibold text-noir-100">
            {editing ? `Edit ${editing.key}` : 'New Source'}
          </h2>
          {formError && (
            <div className="rounded-lg border border-accent-danger/30 bg-accent-danger/10 p-3 text-sm text-accent-danger">{formError}</div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Key" value={key} onChange={(e) => setKey(e.target.value)} disabled={!!editing} placeholder="vivanuncios" required />
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Vivanuncios" required />
            <Input label="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://..." />
            <Input label="Schedule" value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="0 3 * * *" />
            <Select label="Robots Policy" options={[{ value: 'strict', label: 'Strict' }, { value: 'honor', label: 'Honor' }, { value: 'allow', label: 'Allow' }]} onValueChange={setRobotsPolicy} />
            <Input label="Rate Limit (ms)" type="number" value={rateLimitMs.toString()} onChange={(e) => setRateLimitMs(Number(e.target.value))} />
            <Input label="Max Workers" type="number" value={maxWorkers.toString()} onChange={(e) => setMaxWorkers(Number(e.target.value))} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>{submitting ? 'Saving...' : 'Save'}</Button>
            <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
          </div>
        </form>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-noir-700 text-[11px] uppercase tracking-wider text-noir-400">
              <th className="px-4 py-3 font-medium">Source</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Policy</th>
              <th className="px-4 py-3 font-medium">Rate Limit</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-noir-750">
            {sources?.map((source) => (
              <tr key={source.key} className="transition-colors hover:bg-noir-850">
                <td className="px-4 py-3">
                  <p className="font-medium text-noir-100">{source.name}</p>
                  <p className="text-xs text-noir-500">{source.key}</p>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={source.enabled ? 'success' : 'neutral'}>
                    {source.enabled ? 'Active' : 'Disabled'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-xs text-noir-300">{source.robotsPolicy}</td>
                <td className="px-4 py-3 text-xs text-noir-300">{source.rateLimitMs}ms</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => toggleEnabled(source)}>
                      {source.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => startEdit(source)}>
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sources?.length === 0 && (
          <p className="py-12 text-center text-sm text-noir-500">No sources configured yet.</p>
        )}
      </div>
    </div>
  );
}
