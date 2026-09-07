'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function TasksPage() {
  return (
    <ModulePlaceholder
      title="Tasks"
      description="Follow-up tasks, assignments,and SLA-driven work items for the team."
      badge="Phase 4"
    >
      <p className="text-sm text-noir-400">
        Tasks track assignments and follow-ups on listings. The SLA monitor component
        will flag leads requiring action within &lt;24 hours,with countdowns, due/overdue
        states,, escalation rules, and notifications..
      </p>
    </ModulePlaceholder>
  );
}