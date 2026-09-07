'use client';

import { type HTMLAttributes } from 'react';

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

const baseClasses =
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-noir-700 text-noir-200 ring-noir-600',
  primary: 'bg-gold/15 text-gold ring-gold/30',
  success: 'bg-accent-success/15 text-accent-success ring-accent-success/30',
  warning: 'bg-accent-warning/15 text-accent-warning ring-accent-warning/30',
  danger: 'bg-accent-danger/15 text-accent-danger ring-accent-danger/30',
  neutral: 'bg-noir-750 text-noir-300 ring-noir-600',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={[
        baseClasses,
        variantClasses[variant],
        className,
      ].filter(Boolean).join(' ')}
      {...props}
    />
  );
}

export { Badge };

