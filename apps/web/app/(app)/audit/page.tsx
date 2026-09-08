'use client';

/**
 * Audit trail viewer.
 *
 * Streams the append-only audit log (GET /api/audit-log, operator+ only):
 * security events such as logins, MFA enrollment, source policy changes and
 * manual crawl triggers. Filterable by action and actor; newest first.
 */
import { useState } from 'react';
import { AUDIT_ACTIONS, type AuditAction } from '@cre/shared';
import { useAuditLog } from '@/lib/swr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/utils';

const ACTION_OPTIONS = AUDIT_ACTIONS.map((action) => ({ value: action, label: action }));

/** Color-codes events by family: failures, successes, MFA, policy, crawls. */
function actionVariant(action: string): 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'neutral' {
  if (action.endsWith('.failed')) return 'danger';
  if (action === 'auth.login.success') return 'success';
  if (action.startsWith('auth.mfa.')) return 'primary';
  if (action.endsWith('.policy_updated')) return 'warning';
  if (action.startsWith('crawl.')) return 'default';
  return 'neutral';
}

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data, isLoading, error } = useAuditLog(
    { action: (action || undefined) as AuditAction | undefined, actorUserId: actor || undefined },
    page,
    pageSize,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-noir-50">Audit</h1>
        <p className="text-sm text-noir-400">
          Immutable record of security and policy actions across the platform.
        </p>
      </div>

      <div className="card space-y-4 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Select
            label="Action"
            options={ACTION_OPTIONS}
            onValueChange={(v) => {
              setAction(v);
              setPage(1);
            }}
            placeholder="Any action"
          />
          <Input
            label="Actor user ID"
            value={actor}
            onChange={(e) => {
              setActor(e.target.value);
              setPage(1);
            }}
            placeholder="e.g. usr-1"
          />
          <div className="flex items-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAction('');
                setActor('');
                setPage(1);
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 text-noir-400">
          <Spinner className="size-4" /> <span>Loading audit trail…</span>
        </div>
      ) : error ? (
        <p className="text-sm text-accent-danger">Error: {error.message}</p>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-noir-700 text-[11px] uppercase tracking-wider text-noir-400">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">Actor</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Target</th>
                <th className="px-4 py-3 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-noir-750">
              {(data?.items ?? []).map((entry) => (
                <tr key={entry.id} className="transition-colors hover:bg-noir-850">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-noir-400">
                    {formatDate(entry.at)}
                  </td>
                  <td className="px-4 py-3 text-xs text-noir-300">
                    {entry.actorEmail ?? <span className="text-noir-500">anonymous</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={actionVariant(entry.action)}>{entry.action}</Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-noir-300">
                    {entry.targetType ? `${entry.targetType}:${entry.targetId}` : '—'}
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 font-mono text-[11px] text-noir-400">
                    {Object.keys(entry.metadata ?? {}).length > 0
                      ? JSON.stringify(entry.metadata)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data?.items ?? []).length === 0 && (
            <p className="py-12 text-center text-sm text-noir-500">No audit events found.</p>
          )}
          <div className="border-t border-noir-700 px-4 py-3">
            <Pagination page={page} pageSize={pageSize} total={data?.total ?? 0} onPageChange={setPage} />
          </div>
        </div>
      )}
    </div>
  );
}