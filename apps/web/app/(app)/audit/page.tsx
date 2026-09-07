'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function AuditPage() {
  return (
    <ModulePlaceholder
      title="Audit"
      description="Immutable record of business and system actions across the platform."
      badge="Phase 4"
    >
      <p className="text-sm text-noir-400">
        The audit log will record user,, action,, entity,, entity id,, timestamp,, previous/new
        value,, and context for every meaningful business and system action — compatible with
        the crawler's existing provenance trail (observations, crawl runs, fingerprints)..
      </p>
    </ModulePlaceholder>
  );
}