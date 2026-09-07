'use client';

import { ModulePlaceholder } from '@/components/module-placeholder';

export default function ContactsPage() {
  return (
    <ModulePlaceholder
      title="Contacts"
      description="CRM-ready contact and organization records linked to properties and opportunities."
      badge="Phase 4"
    >
      <p className="text-sm text-noir-400">
        Contacts surface from seller/agency data captured by source adapters.
 This
        module will add a full contact system (owners, agencies, brokers) linked to
        listings, assignments, and future opportunities..
      </p>
    </ModulePlaceholder>
  );
}