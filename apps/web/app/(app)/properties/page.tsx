'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function PropertiesPage() {
  return (
    <ModulePlaceholder
      title="Properties"
      description="Canonical property records merged from listings across sources."
      badge="Phase 3"
    >
      <p className="text-sm text-noir-400">
        Properties are the normalized, deduplicated view of discovered listings.
        This workspace will add manual property capture sothat authorized users can
        create or edit property records while maintaining the same normalized schema.

        For now, browse the listing database: <a href="/listings" className="text-gold hover:text-gold-400">Listings</a
        >.
      </p>
    </ModulePlaceholder>
  );
}