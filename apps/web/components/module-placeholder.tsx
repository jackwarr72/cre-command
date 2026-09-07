'use client';

/**
 * ModulePlaceholder — consistent "coming soon" block for modules that are
 * intentionally scaffolded as clean extension points (see DESIGN.md §9).
 *
 * Each future module gets its own route + nav entry now so the information
 * architecture is stable; the placeholder documents what the module will do
 * once its subsystem is implemented, without shipping half-built features.
 */
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

export interface ModulePlaceholderProps {
  title: string;
  description: string;
  badge?: string;
  children?: ReactNode;
}

export function ModulePlaceholder({
  title,
  description,
  badge = 'Scaffolded',
  children,
}: ModulePlaceholderProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-noir-50">{title}</h1>
          <p className="text-sm text-noir-400">{description}</p>
        </div>
        <Badge variant="neutral">{badge}</Badge>
      </div>

      <div className="card space-y-3 p-6">
        <h2 className="text-sm font-semibold text-gold">Module extension point</h2>
        <p className="text-sm text-noir-300">
          This module is scaffolded as part of the platform's information architecture.
          The crawler, source management, listing database, filtering and CSV export
          are functional now; this module will be powered as its subsystem is added,
          reusing the same normalized property, contact, activity and opportunity
          data model — no crawler rewrite required.
        </p>
        {children}
      </div>
    </div>
  );
}