'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function CalendarPage() {
  return (
    <ModulePlaceholder
      title="Sales Calendar"
      description="Activities, meetings, follow-ups, deadlines,and appointments."
      badge="Phase 5"
    >
      <p className="text-sm text-noir-400">
        The sales calendar will power the CRM workflow:follow-up reminders, viewing
        appointments,, and meeting windows tied to opportunities and contacts..
      </p>
    </ModulePlaceholder>
  );
}