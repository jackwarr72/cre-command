'use client';

import { type ButtonHTMLAttributes, forwardRef } from 'react';

export type ButtonVariant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const baseClasses =
  'inline-flex items-center justify-center rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 focus-visible:ring-offset-2 focus-visible:ring-offset-noir-900 disabled:pointer-events-none disabled:opacity-50';

const variantClasses: Record<ButtonVariant, string> = {
  default: 'bg-gold text-noir-950 hover:bg-gold-400 shadow-glow',
  secondary: 'bg-noir-700 text-noir-100 hover:bg-noir-600 border border-noir-600',
  outline: 'border border-noir-500 bg-transparent text-noir-200 hover:bg-noir-750 hover:text-noir-50',
  ghost: 'text-noir-300 hover:bg-noir-750 hover:text-noir-50',
  destructive: 'bg-accent-danger/90 text-noir-950 hover:bg-accent-danger',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 py-2',
  lg: 'h-12 px-6 text-base',
  icon: 'h-9 w-9',
};

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => (
    <button
      className={[
        baseClasses,
        variantClasses[variant],
        sizeClasses[size],
        className,
      ].filter(Boolean).join(' ')}
      ref={ref}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button };

