'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function OpportunitiesPage() {
  return (
    <ModulePlaceholder
      title="Opportunities"
      description="Sales funnel, stages, negotiation history,and expected close tracking."
      badge="Phase 5"
    >
      <p className="text-sm text-noir-400">
        Opportunities track the configurable funnel (New → Contacted → Qualified →
        Opportunity → Negotiation → Won/Lost), value, probability, responsible agent,and
        negotiation history — layered over the same normalized property, contact, and
        activity data model..
      </p>
    </ModulePlaceholder>
  );
}