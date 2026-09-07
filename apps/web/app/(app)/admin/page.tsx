'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function AdminPage() {
  return (
    <ModulePlaceholder
      title="System Administration"
      description="Users, roles, permissions,, source configuration,, system settings,, feature
      flags,, API settings,and worker configuration.."
      badge="Phase 6"
    >
      <p className="text-sm text-noir-400">
        Administration will manage operator accounts and roles (viewer, operator,, admin),
        source configuration,, worker pooling,, feature flags,, and API keys. Role-based access
        control is already enforced at the API layer via the auth guards..
      </p>
    </ModulePlaceholder>
  );
}