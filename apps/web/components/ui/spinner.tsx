'use client';

import { type HTMLAttributes } from 'react';

export function Spinner({ className }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={[
        'inline-block size-5 animate-spin rounded-full border-2 border-current border-t-transparent text-gold',
        className,
      ].filter(Boolean).join(' ')}
      role="status"
      aria-label="Loading"
    />
  );
}
