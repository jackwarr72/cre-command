'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function DuplicatesPage() {
  return (
    <ModulePlaceholder
      title="Duplicate Review"
      description="Confidence-based duplicate detection across sources and repeated crawls."
      badge="Phase 3"
    >
      <p className="text-sm text-noir-400">
        The crawler already fingerprints every listing and avoids inserting unchanged
        records. This workspace will surface suspected cross-source duplicates for
        human review, powered by a deterministic matching pipeline (source ID, canonical
        URL, address, price, characteristics, seller/agency, content similarity) —
        never by URL matching alone..
      </p>
    </ModulePlaceholder>
  );
}