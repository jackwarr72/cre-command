'use client';

import {
  forwardRef,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
} from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className, ...props }, ref) => (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label
          className="text-xs font-medium uppercase tracking-wide text-noir-300"
          htmlFor={props.id}
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        className={
          'w-full rounded-lg border border-noir-600 bg-noir-800 px-3 py-2 text-sm text-noir-100 placeholder:text-noir-500 transition-colors focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/30 disabled:cursor-not-allowed disabled:opacity-50' +
          (error ? ' border-accent-danger/60' : '') +
          (className ? ` ${className}` : '')
        }
        {...props}
      />
      {error && <span className="text-xs text-accent-danger">{error}</span>}
    </div>
  ),
);
Input.displayName = 'Input';

export { Input };
